import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../domain/core/errors';
import { SystemClock } from '../domain/core/time';
import type { FinancialClosureService } from '../domain/capabilities/project-financial-closure';
import type { ProjectService } from '../domain/capabilities/relocation-project-lifecycle';
import type { ServiceOrderService } from '../domain/capabilities/service-order-recording';
import type { DamageRepairService } from '../domain/capabilities/damage-repair-tracking';
import type { SerialAddressUpdateService } from '../domain/capabilities/serial-address-update';
import type { QrRequestService } from '../domain/capabilities/qr-request-tracking';
import type { ShipToService } from '../domain/capabilities/ship-to-management';
import type {
  SqliteActivityRepository,
  SqliteBatchRepository,
  SqliteInstrumentRepository,
  SqliteInvoiceRepository,
  SqliteLogisticsFeeRepository,
  SqliteProjectRepository,
} from '../domain/capabilities/local-data-persistence';
import { DELETE_REJECTION_CODES } from '../shared/ipc';
import type {
  WorkbenchV2DeleteKind,
  WorkbenchV2DeleteRequest,
  WorkbenchV2InvalidateTag,
} from '../shared/ipc';

/**
 * 受保护登记记录删除策略（design D3，Tasks 5.1 阶段 A：分发与审计）。
 *
 * - 保持 v2Delete 单一命令形状（kind/id/expectedRevision）；expectedRevision 由
 *   facade 在 BEGIN IMMEDIATE 事务内核验，本模块只做类型分发与策略执行；
 * - 按 kind 分发到显式 type-specific policy，每类策略在写事务内重查状态/依赖，
 *   受领域能力拥有的记录删除委派领域 service；
 * - 成功删除与最小 tombstone（record_deletion_audit）同事务原子写入；本次操作内
 *   每删除一条业务记录写一行 tombstone（owned_child_count 记录原子清理的子记录数）；
 * - import_record_audit 不再物理删除：改为更新 target_deleted_at /
 *   target_delete_operation_id 标记指向已删除目标（operation_id 关联本次
 *   record_deletion_audit），来源审计保留可追溯；
 * - 拒绝路径（NOT_FOUND/DEPENDENCIES/INVOICE_REQUIRES_REVOKE/未知 kind）零写：
 *   业务行、tombstone、import marker 全部不变；
 * - 现有各类型行为保持不变：invoice 仍映射撤销（必填撤销日期/原因、不物理删除、
 *   不写 tombstone/不标记 import）；acceptance 仍清空验收事实并按事实确定性回退状态；
 *   project 无删除入口（项目终止用取消语义）。
 *
 * 本模块只供主进程使用（node 环境）；renderer 无 Node 访问。
 */

/** 删除策略上下文（由 facade 注入仓储/服务/解析边界，模块不自行解析 DTO）。 */
export interface WorkbenchDeleteContext {
  db: DatabaseSync;
  actor: () => { accountId: string; username: string };
  /** IPC 业务日期边界：仅校验格式后原样透传（业务日期 yyyy-mm-dd，不转 ISO）。 */
  parseBusinessDate: (v: unknown, fieldName: string) => string | undefined;
  repositories: {
    activities: SqliteActivityRepository;
    projects: SqliteProjectRepository;
    batches: SqliteBatchRepository;
    fees: SqliteLogisticsFeeRepository;
    instruments: SqliteInstrumentRepository;
    invoices: SqliteInvoiceRepository;
  };
  projectService: () => ProjectService;
  financialService: () => FinancialClosureService;
  serviceOrderService: () => ServiceOrderService;
  damageRepairService: () => DamageRepairService;
  serialAddressUpdateService: () => SerialAddressUpdateService;
  qrRequestService: () => QrRequestService;
  shipToService: () => ShipToService;
}

/** 分发结果：changed/extraTags 由 facade 组装最终信封（invalidated/businessRevision）。 */
export interface WorkbenchDeleteOutcome {
  changed: { kind: WorkbenchV2DeleteKind; id: string; projectId?: string } | null;
  extraTags: WorkbenchV2InvalidateTag[];
}

/** 主进程删除分发器：每类 kind 有显式 policy，随行原子写 tombstone 与 import marker。 */
export class WorkbenchDeletePolicies {
  constructor(private readonly ctx: WorkbenchDeleteContext) {}

  execute(request: WorkbenchV2DeleteRequest): WorkbenchDeleteOutcome {
    const operation = new DeleteOperation(this.ctx);
    switch (request.kind) {
      case 'service_order':
        operation.deleteServiceOrder(request.id);
        break;
      case 'activity':
        operation.deleteActivity(request.id);
        break;
      case 'acceptance':
        operation.deleteAcceptance(request.projectId);
        break;
      case 'damage_repair_item':
        operation.deleteDamageItem(request.id);
        break;
      case 'serial_address':
        operation.deleteSerialAddress(request.id);
        break;
      case 'qr_request':
        operation.deleteQrRequest(request.id);
        break;
      case 'batch':
        operation.deleteBatch(request.id);
        break;
      case 'instrument':
        operation.deleteInstrument(request.id);
        break;
      case 'ship_to_request':
        operation.deleteShipToRequest(request.id);
        break;
      case 'invoice':
        operation.revokeInvoice(request.id, request.revokedAt, request.revokeReason);
        break;
      default: {
        const kind = String((request as { kind?: unknown }).kind);
        throw new ValidationError('DELETE_UNKNOWN_KIND', `未知的删除记录类型: ${kind}`);
      }
    }
    operation.commit();
    return { changed: operation.changed, extraTags: operation.extraTags };
  }
}

/**
 * 单次 v2Delete 调用内的累积状态：共享 operation_id/deleted_at（tombstone 与
 * import marker 同源），仅在全部策略成功后一次性提交——拒绝/抛错时零写。
 */
class DeleteOperation {
  changed: WorkbenchDeleteOutcome['changed'] = null;
  extraTags: WorkbenchV2InvalidateTag[] = [];
  private readonly operationId = randomUUID();
  private readonly deletedAt = new Date().toISOString();
  private readonly actor: { accountId: string; username: string };
  private readonly tombstones: Array<{ recordType: string; recordId: string; ownedChildCount: number }> = [];
  private readonly importTargets: Array<{ table: string; id: string }> = [];

  constructor(private readonly ctx: WorkbenchDeleteContext) {
    this.actor = ctx.actor();
  }

  private get db(): DatabaseSync {
    return this.ctx.db;
  }

  /** 累积一行 tombstone（record_deletion_audit 最小事实）。 */
  private tombstone(recordType: string, recordId: string, ownedChildCount: number): void {
    this.tombstones.push({ recordType, recordId, ownedChildCount });
  }

  /** 累积一个待标记的 import 目标（来源审计保留并标记而非擦除）。 */
  private importTarget(table: string, id: string): void {
    this.importTargets.push({ table, id });
  }

  /**
   * 真实状态变化写一行 project_status_transition_audit（与 tombstone/import marker
   * 同事务原子；source=user；仅状态/原因/日期/操作者，禁止任何客户值）。
   */
  private writeTransitionAudit(projectId: string, fromStatus: string, toStatus: string, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO project_status_transition_audit (
           id, project_id, from_status, to_status, reason,
           effective_business_date, source, actor_id, actor_username_snapshot, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        projectId,
        fromStatus,
        toStatus,
        reason,
        new SystemClock().today(),
        'user',
        this.actor.accountId,
        this.actor.username,
        this.deletedAt,
      );
  }

  // -------------------------------------------------------------------------
  // type-specific policies：分发/守卫/审计；领域拥有的删除由对应 service 执行。
  // -------------------------------------------------------------------------

  deleteServiceOrder(id: string): void {
    const result = this.mapDomainDelete(() => this.ctx.serviceOrderService().delete(id), ['ORDER_NOT_FOUND']);
    this.tombstone('service_order', id, result.ownedChildCount);
    this.importTarget('service_orders', id);
    this.changed = { kind: 'service_order', id, projectId: result.projectId };
  }

  deleteActivity(id: string): void {
    const activity = this.ctx.repositories.activities.findById(id);
    if (!activity) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `上门活动不存在: ${id}`);
    }
    // 下游事实依赖拒绝（同一写事务内重查，事务回滚零写）：
    // - 工作事实（work_facts）：执行事实，不可级联删除 → 拒绝；
    // - 维修上门活动关联（activity_damage_links）：指向本活动的下游引用 → 拒绝。
    if (this.existsWhere('work_facts', 'activity_id', id)) {
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '该上门活动已产生工作事实，无法删除；请先处理工作事实',
      );
    }
    if (this.existsWhere('activity_damage_links', 'activity_id', id)) {
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '该上门活动已关联损坏/维修事项，无法删除；请先解除维修关联',
      );
    }
    // 可删除的活动（无工作事实/无维修关联）不承载任何状态相关事实：项目是否「已开始
    // 执行」只由 work_facts（或批次开始运输）决定，活动自身不计入；故删除不影响主
    // 状态，无需经 lifecycle 重算（无真实状态变化），也绝不直接赋值状态。
    // 活动自身的参与工程师属活动记录一部分（非独立事实），随活动删除并计入子记录数。
    const engineerCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM activity_engineers WHERE activity_id = ?').get(id) as {
        n: number;
      }
    ).n;
    this.db.prepare('DELETE FROM activity_engineers WHERE activity_id = ?').run(id);
    this.db.prepare('DELETE FROM activities WHERE id = ?').run(id);
    this.tombstone('activity', id, engineerCount);
    this.importTarget('activities', id);
    this.changed = { kind: 'activity', id, projectId: activity.projectId };
  }

  deleteAcceptance(projectId: string): void {
    const project = this.ctx.repositories.projects.findById(projectId);
    if (!project) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `项目不存在: ${projectId}`);
    }
    // 有 invoice 历史（含已撤销）→ 拒绝（掉票闭环事实不可逆回退）。
    if (this.projectInvoiceHistoryExists(projectId)) {
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '该项目存在掉票历史（含已撤销），验收报告不可删除；掉票闭环事实不可逆回退',
      );
    }
    const fromStatus = project.status;
    const executionStarted = this.projectExecutionStarted(projectId);
    try {
      // 删除验收事实后经 lifecycle 唯一入口重算主状态（clearAcceptance 内部同防御校验）。
      this.ctx.projectService().clearAcceptance(projectId, {
        hasAnyInvoiceHistory: false,
        executionStarted,
      });
    } catch (error) {
      // 重算不可靠（终态/金额闭环完成态等）→ 在删除任何行前映射为 STATUS_RECALC。
      if (error instanceof ValidationError && error.code === 'ACCEPTANCE_STATUS_RECALC_FAILED') {
        throw new ValidationError(
          DELETE_REJECTION_CODES.STATUS_RECALC_UNRELIABLE,
          `验收报告删除后状态重算未通过：${error.message}`,
        );
      }
      throw error;
    }
    // 真实状态变化 → 同事务写 transition audit（source=user，无客户值）；零变化不写。
    const after = this.ctx.repositories.projects.findById(projectId);
    if (after && after.status !== fromStatus) {
      this.writeTransitionAudit(projectId, fromStatus, after.status, 'acceptance_deleted');
    }
    // acceptance 无物理业务行删除：tombstone 记录「验收报告已删除」这一审计事实。
    this.tombstone('acceptance', projectId, 0);
    this.changed = { kind: 'acceptance', id: projectId, projectId };
  }

  deleteDamageItem(id: string): void {
    const result = this.mapDomainDelete(() => this.ctx.damageRepairService().deleteItem(id), ['DAMAGE_ITEM_NOT_FOUND']);
    this.tombstone('damage_repair_item', id, result.ownedChildCount);
    this.importTarget('damage_repair_items', id);
    this.changed = { kind: 'damage_repair_item', id, projectId: result.projectId };
  }

  deleteSerialAddress(id: string): void {
    const result = this.mapDomainDelete(() => this.ctx.serialAddressUpdateService().delete(id), ['SERIAL_ADDRESS_UPDATE_NOT_FOUND']);
    const projectId = result.instrumentId ? this.projectOfInstrument(result.instrumentId) : undefined;
    this.tombstone('serial_address', id, result.ownedChildCount);
    this.importTarget('serial_address_updates', id);
    this.changed = { kind: 'serial_address', id, projectId };
    this.extraTags.push('independent:serial_address');
  }

  deleteQrRequest(id: string): void {
    const result = this.mapDomainDelete(() => this.ctx.qrRequestService().delete(id), ['QR_REQUEST_NOT_FOUND']);
    this.tombstone('qr_request', id, result.ownedChildCount);
    this.importTarget('qr_requests', id);
    this.changed = { kind: 'qr_request', id };
    this.extraTags.push('independent:qr_request');
  }

  deleteBatch(id: string): void {
    const batch = this.ctx.repositories.batches.findById(id);
    if (!batch) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `搬迁批次不存在: ${id}`);
    }
    // 严格守卫：仅未开始运输、无当前仪器、无改批历史可删除。
    if (batch.startedAt !== null) {
      throw new ValidationError(DELETE_REJECTION_CODES.DEPENDENCIES, '该搬迁批次已开始运输，无法删除');
    }
    if (this.existsWhere('instruments', 'batch_id', id)) {
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '该搬迁批次仍存在当前仪器，无法删除；请先解绑仪器',
      );
    }
    if (
      this.existsWhere('batch_change_history', 'from_batch_id', id) ||
      this.existsWhere('batch_change_history', 'to_batch_id', id)
    ) {
      throw new ValidationError(DELETE_REJECTION_CODES.DEPENDENCIES, '该搬迁批次存在改批历史，无法删除');
    }
    // 批次与物流费用合并为一次记录：批次自身唯一物流费用随批次删除（子记录数计 1）。
    const fee = this.ctx.repositories.fees.findByBatchId(id);
    if (fee) {
      this.db.prepare('DELETE FROM logistics_fees WHERE id = ?').run(fee.id);
      this.importTarget('logistics_fees', fee.id);
    }
    this.db.prepare('DELETE FROM batches WHERE id = ?').run(id);
    this.tombstone('batch', id, fee ? 1 : 0);
    this.importTarget('batches', id);
    this.changed = { kind: 'batch', id, projectId: batch.projectId };
  }

  deleteInstrument(id: string): void {
    const instrument = this.ctx.repositories.instruments.findById(id);
    if (!instrument) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `搬迁仪器不存在: ${id}`);
    }
    // 所属批次已开始运输 → 禁止删除。
    if (instrument.batchId) {
      const batch = this.ctx.repositories.batches.findById(instrument.batchId);
      if (batch && batch.startedAt !== null) {
        throw new ValidationError(
          DELETE_REJECTION_CODES.DEPENDENCIES,
          '该搬迁仪器所属批次已开始运输，无法删除',
        );
      }
    }
    // 保留其他依赖检查（损坏事项/工作事实/改批历史/序列号更新）。
    this.assertInstrumentDeletable(id);
    this.db.prepare('DELETE FROM instruments WHERE id = ?').run(id);
    this.tombstone('instrument', id, 0);
    this.importTarget('instruments', id);
    this.changed = { kind: 'instrument', id, projectId: instrument.projectId };
  }

  deleteShipToRequest(id: string): void {
    const result = this.mapDomainDelete(
      () => this.ctx.shipToService().deleteRequest(id),
      ['SHIP_TO_REQUEST_NOT_FOUND'],
      ['SHIP_TO_REQUEST_DELETE_DEPENDENCIES'],
    );
    this.tombstone('ship_to_request', id, result.ownedChildCount);
    this.importTarget('ship_to_requests', id);
    if (result.shipToId) this.importTarget('ship_tos', result.shipToId);
    this.changed = { kind: 'ship_to_request', id };
    this.extraTags.push('lookup:ship_to_requests');
  }

  revokeInvoice(id: string, revokedAt: string | undefined, revokeReason: string | undefined): void {
    const invoice = this.ctx.repositories.invoices.findById(id);
    if (!invoice) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `掉票记录不存在: ${id}`);
    }
    if (revokedAt === undefined || revokedAt === '' || revokeReason === undefined || revokeReason.trim() === '') {
      throw new ValidationError(
        DELETE_REJECTION_CODES.INVOICE_REQUIRES_REVOKE,
        '掉票记录不可物理删除：删除必须携带撤销日期与撤销原因（映射为撤销）',
      );
    }
    // invoice 映射为撤销：行不删除、不写 tombstone、不标记 import 审计（记录仍存在）。
    const revoked = this.ctx.financialService().revokeInvoice(
      id,
      { revokedAt: this.ctx.parseBusinessDate(revokedAt, '撤销日期') ?? '', revokeReason },
      this.actor,
    );
    this.changed = { kind: 'invoice', id, projectId: revoked.projectId };
  }

  // -------------------------------------------------------------------------
  // 原子提交：全部策略成功后一次性写 tombstone 与 import marker（调用方事务内）。
  // -------------------------------------------------------------------------

  commit(): void {
    for (const t of this.tombstones) {
      this.db
        .prepare(
          `INSERT INTO record_deletion_audit (
             id, operation_id, record_type, record_id, owned_child_count,
             actor_id, actor_username_snapshot, deleted_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          this.operationId,
          t.recordType,
          t.recordId,
          t.ownedChildCount,
          this.actor.accountId,
          this.actor.username,
          this.deletedAt,
        );
    }
    for (const target of this.importTargets) {
      // 来源审计保留：标记指向已删除目标，而非物理擦除。
      this.db
        .prepare(
          `UPDATE import_record_audit
           SET target_deleted_at = ?, target_delete_operation_id = ?
           WHERE target_table = ? AND target_id = ?`,
        )
        .run(this.deletedAt, this.operationId, target.table, target.id);
    }
  }

  // -------------------------------------------------------------------------
  // 只读守卫（表名/列名来自固定白名单，无注入面；不写库）。
  // -------------------------------------------------------------------------

  /** 是否存在匹配行（表名/列名来自固定白名单，无注入面）。 */
  private existsWhere(table: string, column: string, value: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value) as
      | { x: number }
      | undefined;
    return row !== undefined;
  }

  /** 将领域稳定错误码映射为既有 IPC 删除拒绝码，避免 UI/信封变化。 */
  private mapDomainDelete<T>(action: () => T, notFoundCodes: string[], dependencyCodes: string[] = []): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof ValidationError) {
        if (notFoundCodes.includes(error.code)) {
          throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, error.message);
        }
        if (dependencyCodes.includes(error.code)) {
          throw new ValidationError(DELETE_REJECTION_CODES.DEPENDENCIES, error.message);
        }
      }
      throw error;
    }
  }

  /** 项目是否存在任何掉票历史（含已撤销）：有则验收报告删除被拒绝。 */
  private projectInvoiceHistoryExists(projectId: string): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?').get(projectId) as {
      n: number;
    };
    return row.n > 0;
  }

  /** 项目是否已开始执行：任一批次开始运输 或 任一工作事实已开始。 */
  private projectExecutionStarted(projectId: string): boolean {
    const batchStarted = this.db
      .prepare('SELECT 1 AS x FROM batches WHERE project_id = ? AND started_at IS NOT NULL LIMIT 1')
      .get(projectId);
    if (batchStarted) return true;
    const workFact = this.db
      .prepare(
        `SELECT 1 AS x FROM work_facts wf
         JOIN activities a ON a.id = wf.activity_id
         WHERE a.project_id = ? LIMIT 1`,
      )
      .get(projectId);
    return workFact !== undefined;
  }

  /** 仪器存在依赖记录时拒绝删除（保护依赖，避免静默级联丢失业务数据）。 */
  private assertInstrumentDeletable(instrumentId: string): void {
    const dependents = [
      ['damage_repair_items', 'instrument_id'],
      ['work_facts', 'instrument_id'],
      ['batch_change_history', 'instrument_id'],
      ['serial_address_updates', 'instrument_id'],
    ] as const;
    for (const [table, column] of dependents) {
      if (this.existsWhere(table, column, instrumentId)) {
        throw new ValidationError(
          DELETE_REJECTION_CODES.DEPENDENCIES,
          `该搬迁仪器存在依赖记录（${table}），无法安全删除；请先处理依赖记录`,
        );
      }
    }
  }

  private projectOfInstrument(instrumentId: string): string | undefined {
    const row = this.db.prepare('SELECT project_id FROM instruments WHERE id = ?').get(instrumentId) as
      | { project_id: string }
      | undefined;
    return row ? row.project_id : undefined;
  }
}
