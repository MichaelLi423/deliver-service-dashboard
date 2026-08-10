import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../domain/core/errors';
import { SystemClock } from '../domain/core/time';
import type { FinancialClosureService } from '../domain/capabilities/project-financial-closure';
import type { ProjectService } from '../domain/capabilities/relocation-project-lifecycle';
import type {
  SqliteActivityRepository,
  SqliteBatchRepository,
  SqliteDamageRepairItemRepository,
  SqliteInstrumentRepository,
  SqliteInvoiceRepository,
  SqliteLogisticsFeeRepository,
  SqliteProjectRepository,
  SqliteQrRequestRepository,
  SqliteSerialAddressUpdateRepository,
  SqliteServiceOrderRepository,
  SqliteShipToRequestRepository,
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
 *   删除使用该类型显式 SQL（绝无「任意表 DELETE」通用入口）；
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
    orders: SqliteServiceOrderRepository;
    activities: SqliteActivityRepository;
    projects: SqliteProjectRepository;
    damageItems: SqliteDamageRepairItemRepository;
    serialUpdates: SqliteSerialAddressUpdateRepository;
    qrRequests: SqliteQrRequestRepository;
    batches: SqliteBatchRepository;
    fees: SqliteLogisticsFeeRepository;
    instruments: SqliteInstrumentRepository;
    shipRequests: SqliteShipToRequestRepository;
    invoices: SqliteInvoiceRepository;
  };
  projectService: () => ProjectService;
  financialService: () => FinancialClosureService;
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
  // type-specific policies：每类显式 SQL + 守卫，删除时记录 tombstone/import 目标。
  // -------------------------------------------------------------------------

  deleteServiceOrder(id: string): void {
    const order = this.ctx.repositories.orders.findById(id);
    if (!order) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `开单记录不存在: ${id}`);
    }
    this.db.prepare('DELETE FROM service_orders WHERE id = ?').run(id);
    this.tombstone('service_order', id, 0);
    this.importTarget('service_orders', id);
    this.changed = { kind: 'service_order', id, projectId: order.projectId ?? undefined };
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
    const item = this.ctx.repositories.damageItems.findById(id);
    if (!item) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `损坏/维修事项不存在: ${id}`);
    }
    // 5.2：按 TBD-24 引用关系原子清理仅指向该事项的维修上门活动关联
    // （activity_damage_links），不删除活动本身、不影响其他事项与该活动的关联、
    // 不因存在关联直接拒绝；关联仪器与搬迁项目保留、项目生命周期不变。
    // 事项自身的处理/备件状态属该记录内部事实，删除后维修报表统计由剩余事项派生，
    // 不存在真正下游不可安全删除的事实，故不做依赖拒绝。
    const linkCount = this.countWhere('activity_damage_links', 'damage_item_id', id);
    this.db.prepare('DELETE FROM activity_damage_links WHERE damage_item_id = ?').run(id);
    this.db.prepare('DELETE FROM damage_repair_items WHERE id = ?').run(id);
    this.tombstone('damage_repair_item', id, linkCount);
    this.importTarget('damage_repair_items', id);
    this.changed = { kind: 'damage_repair_item', id, projectId: item.projectId };
  }

  deleteSerialAddress(id: string): void {
    const update = this.ctx.repositories.serialUpdates.findById(id);
    if (!update) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `序列号地址更新记录不存在: ${id}`);
    }
    const projectId = update.instrumentId ? this.projectOfInstrument(update.instrumentId) : undefined;
    this.db.prepare('DELETE FROM serial_address_updates WHERE id = ?').run(id);
    this.tombstone('serial_address', id, 0);
    this.importTarget('serial_address_updates', id);
    this.changed = { kind: 'serial_address', id, projectId };
    this.extraTags.push('independent:serial_address');
  }

  deleteQrRequest(id: string): void {
    const requestRow = this.ctx.repositories.qrRequests.findById(id);
    if (!requestRow) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `二维码申请记录不存在: ${id}`);
    }
    // 多选类型属申请记录一部分，随申请删除并计入子记录数。
    const typeCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM qr_request_types WHERE qr_request_id = ?').get(id) as {
        n: number;
      }
    ).n;
    this.db.prepare('DELETE FROM qr_request_types WHERE qr_request_id = ?').run(id);
    this.db.prepare('DELETE FROM qr_requests WHERE id = ?').run(id);
    this.tombstone('qr_request', id, typeCount);
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
    const shipRequest = this.ctx.repositories.shipRequests.findById(id);
    if (!shipRequest) {
      throw new ValidationError(DELETE_REJECTION_CODES.NOT_FOUND, `Ship-to 申请记录不存在: ${id}`);
    }
    // 记录级删除，非「退回/取消」语义：不影响其他申请的状态与线性流转。
    if (shipRequest.status !== 'completed') {
      // 未完成且未补入 Account ID → 直接删除（不产生任何 Ship-to 主数据遗留）。
      if (shipRequest.accountId === null) {
        this.db.prepare('DELETE FROM ship_to_requests WHERE id = ?').run(id);
        this.tombstone('ship_to_request', id, 0);
        this.importTarget('ship_to_requests', id);
        this.changed = { kind: 'ship_to_request', id };
        this.extraTags.push('lookup:ship_to_requests');
        return;
      }
      // 异常未完成但已有 Account ID → 保守拒绝（无法安全证明未产生主数据）。
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '该申请未完成但已补入 Account ID，无法安全直接删除；请先完成该申请或由负责人人工处理',
      );
    }
    // completed：必须经 ship_tos.origin_request_id 证明该不可变 Ship-to 由本申请产生；
    // legacy null（无法证明来源）保守拒绝。
    const shipToId = this.shipToIdOfOriginRequest(id);
    if (shipToId === undefined) {
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '已完成申请对应的不可变 Ship-to 无法证明来源（legacy 记录无 origin_request_id），拒绝删除',
      );
    }
    // 被搬迁仪器（及经仪器关联的批次/项目间接引用）引用时原子拒绝并说明原因。
    if (this.existsWhere('instruments', 'destination_ship_to_id', shipToId)) {
      throw new ValidationError(
        DELETE_REJECTION_CODES.DEPENDENCIES,
        '已完成申请对应的不可变 Ship-to 仍被搬迁仪器（或经仪器关联的批次/项目）引用，无法删除',
      );
    }
    // 无任何引用且仅由该申请产生 → 同事务先删 Ship-to 主数据再删申请，不留孤立。
    this.db.prepare('DELETE FROM ship_tos WHERE id = ?').run(shipToId);
    this.db.prepare('DELETE FROM ship_to_requests WHERE id = ?').run(id);
    this.tombstone('ship_to_request', id, 1);
    this.importTarget('ship_to_requests', id);
    this.importTarget('ship_tos', shipToId);
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

  /** 匹配行计数（原子清理的关联子记录数；表名/列名来自固定白名单，无注入面）。 */
  private countWhere(table: string, column: string, value: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
      n: number;
    };
    return row.n;
  }

  /** 由申请产生（origin_request_id）的 Ship-to 主数据 ID；无（legacy null）返回 undefined。 */
  private shipToIdOfOriginRequest(requestId: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM ship_tos WHERE origin_request_id = ?').get(requestId) as
      | { id: string }
      | undefined;
    return row ? row.id : undefined;
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
