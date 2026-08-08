import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SystemClock, type Clock } from '../../core/time';
import { prepareReadBigInt } from '../local-data-persistence/connection';
import {
  buildImportPlan,
  contentHash,
  rebuildStatus,
  sourceRowsDigest,
  type DryRunReport,
  type ImportPlan,
  type ImportedInvoice,
  type ImportedLogisticsFee,
  type ImportedProject,
  type ImportedQrRequest,
  type ImportedSerialAddressUpdate,
  type ImportedServiceOrder,
  type ImportedShipToRequest,
  type ParseReport,
  type RequiredFieldError,
} from './engine';
import { MAPPING_V1, type MigrationMapping } from './mapping';
import type { SourceRow } from './source-model';
import type { MigrationAuditRecord } from './migration-audit';
import type { NormalizedRow } from './normalized-row';
import {
  planSourceKey,
  type NormalizedImportPlan,
  type PlanInvoice,
  type PlanLogisticsFee,
  type PlanProject,
  type PlanQrRequest,
  type PlanSerialAddressUpdate,
  type PlanServiceOrder,
  type PlanShipToRequest,
} from './validation-kernel';

/**
 * 迁移服务（tasks 8.1~8.10；Oracle 高风险 2/3/4 修正）。
 *
 * - dry-run（8.6）：执行导入例程但不写入任何数据；**importable 必须 errors=0 且 conflicts=0**，
 *   产出解析报告、冲突报告与必填字段缺失错误清单；源内容摘要（sourceDigest）随报告返回，
 *   作为 dry-run 与源文件的绑定。
 * - 正式导入（8.7）：**重新解析并校验 errors 与 conflicts**，两者任一非空即拒绝写入；
 *   传入 expectedSourceDigest 时校验源文件未变（源变化拒绝导入）；
 *   每个 ECC 聚合项目一个批次整批事务（任一记录失败整体回滚）；
 *   **全部已支持记录必须真正落库**：project/contract/customer、service_order、invoice、
 *   logistics_fee、serial_address_update、qr_request、ship_to_request；supplier 无目标表仅参考；
 *   若某角色被计数但未写入（静默丢弃）→ 导入失败。
 * - 迁移来源（schema v7）：每个被迁移目标记录持久化 import_source_key + source_hash；
 *   forward-fix 只更新「同 source key 产生的迁移记录」，人工记录（无 source key）永不改删；
 *   目标无法安全 upsert 时报告阻塞（不删除任何数据）。
 * - 确定性状态重建（8.8）；源业务时间保留（8.9）；迁移导入不归属本地账号（source=import）。
 */

/** dry-run 与导入的输入。 */
export interface MigrationInput {
  rows: readonly SourceRow[];
  mapping?: MigrationMapping;
  /** 导入执行人员（工作台外部署运维人员，8.1）。 */
  operator?: string | null;
  now?: Clock;
  /**
   * 与 dry-run 绑定的源内容摘要：传入时若当前源摘要不一致 → 拒绝导入
   * （源文件在 dry-run 后被修改，须重新 dry-run）。
   */
  expectedSourceDigest?: string;
  /** 测试用故障注入点（生产不传）：在该阶段抛错，验证整体回滚零业务写入。 */
  injectFault?: (phase: FaultPhase) => void;
}

/** 故障注入阶段：七个 writer + 目标快照 + 来源审计 + 写后角色对账。 */
export type FaultPhase =
  | 'writer_project'
  | 'writer_service_order'
  | 'writer_invoice'
  | 'writer_logistics_fee'
  | 'writer_serial_address_update'
  | 'writer_qr_request'
  | 'writer_ship_to_request'
  | 'target_snapshot'
  | 'audit'
  | 'reconcile';

/** 导入批次结果（整批事务）。 */
export interface ImportBatchResult {
  batchKey: string;
  status: 'success' | 'failed' | 'skipped';
  importedCount: number;
  failedCount: number;
  errorDetails: string | null;
}

/** 导入结果汇总。 */
export interface ImportResult {
  batches: ImportBatchResult[];
  /** 本轮写入审计记录数。 */
  auditCount: number;
  /** 已成功导入的项目数（ECC 聚合）。 */
  importedProjectCount: number;
  /** 各角色实际写入记录数（= 计划记录数，全角色落库验证）。 */
  writtenCounts: Record<string, number>;
}

function buildParseReport(plan: ImportPlan, rows: readonly SourceRow[]): ParseReport {
  const files: ParseReport['files'] = [];
  const fileMap = new Map<string, { sheets: Set<string>; rowCount: number }>();
  for (const row of rows) {
    let entry = fileMap.get(row.file);
    if (!entry) {
      entry = { sheets: new Set(), rowCount: 0 };
      fileMap.set(row.file, entry);
    }
    entry.sheets.add(row.sheet);
    entry.rowCount += 1;
  }
  for (const [fileName, entry] of fileMap) {
    files.push({ fileName, sheets: [...entry.sheets], rowCount: entry.rowCount });
  }
  return {
    files,
    projectCount: plan.projects.length,
    recordCounts: plan.recordCounts,
    ignoredSheets: plan.ignoredSheets,
    unmappableRowCount: plan.unmappableRows.length,
  };
}

/**
 * dry-run 只读预演（8.6）：不写入任何数据。
 * importable 必须 errors=0 且 conflicts=0（Oracle 高风险 2）。
 */
export function runDryRun(input: MigrationInput): DryRunReport {
  const rows = input.rows;
  const plan = buildImportPlan(rows, { mapping: input.mapping ?? MAPPING_V1 });
  const errors: RequiredFieldError[] = plan.errors;
  return {
    parse: buildParseReport(plan, rows),
    conflicts: plan.conflicts,
    errors,
    importable: errors.length === 0 && plan.conflicts.length === 0,
    sourceDigest: plan.sourceDigest,
  };
}

/**
 * 批次分组：一个批次 = 一个 ECC 聚合项目 + 其全部子记录（invoice/logistics 按 ECC，
 * 其余按源行归属）；无项目归属的子记录进入 standalone 批次。
 * 批次 sourceRows 必须包含项目与其子记录的全部源行（子记录变更时批次不得误判 skipped）。
 */
interface BatchGroup {
  batchKey: string;
  ecc: string | null;
  /** 该批次全部源行（项目源行 + 子记录源行）。 */
  allRows: SourceRow[];
  project: ImportedProject | null;
  serviceOrders: ImportedServiceOrder[];
  invoices: ImportedInvoice[];
  logisticsFees: ImportedLogisticsFee[];
  serialAddressUpdates: ImportedSerialAddressUpdate[];
  qrRequests: ImportedQrRequest[];
  shipToRequests: ImportedShipToRequest[];
}

/** 预检失败：任何结构/归属不匹配在写入前全局失败（零表写入）。 */
export interface PreflightIssue {
  message: string;
}

/**
 * 目标业务字段快照摘要（forward-fix 防覆盖人工修改；schema v9 import_record_audit）。
 * BigInt（金额分整数，经 prepareReadBigInt 读取）精确序列化为十进制字符串，不退化 Number。
 */
function targetSnapshotHash(fields: Record<string, unknown>): string {
  const canonical = JSON.stringify(fields, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value === null) return null;
    if (typeof value === 'object') return value; // 对象/数组原样序列化（含根对象）
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return undefined;
  });
  if (canonical === undefined) {
    throw new Error('目标快照序列化失败：快照字段为空');
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/** 目标行快照 SQL：以 BigInt 读取（金额分整数精确），任意 join 的多表业务字段。 */
function snapshotOfSql(
  db: DatabaseSync,
  sql: string,
  params: (string | number | bigint | null)[],
): string | null {
  const stmt = prepareReadBigInt(db, sql);
  const row = stmt.get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return targetSnapshotHash(row);
}

/**
 * forward-fix 前置校验（Oracle 复审）：
 * - 有审计基线且 hash 一致 → 放行；
 * - 有审计基线但 hash 不一致 → 目标被人工/外部修改 → 阻塞（不覆盖）；
 * - **无审计基线（v9 前已导入的迁移记录）→ 阻塞**并给出明确「需人工确认/重建基线」错误，
 *   绝不静默放行覆盖（安全兼容策略：新导入建立 audit，历史无 baseline 的 forward-fix 必须人工处理）。
 */
function assertTargetUnmodified(
  db: DatabaseSync,
  sourceKey: string,
  targetTable: string,
  targetId: string,
  currentTargetHash: string,
): void {
  const audit = db
    .prepare('SELECT target_snapshot_hash FROM import_record_audit WHERE source_key = ?')
    .get(sourceKey) as { target_snapshot_hash: string } | undefined;
  if (!audit) {
    throw new Error(
      `目标 ${targetTable}(${targetId}) 为 v9 前导入的迁移记录、缺少目标快照基线（import_record_audit），无法安全 forward-fix；请负责人确认后重建基线再处理（不覆盖）`,
    );
  }
  if (audit.target_snapshot_hash !== currentTargetHash) {
    throw new Error(
      `目标 ${targetTable}(${targetId}) 自上次迁移后被人工/外部修改（目标快照不一致），forward-fix 阻塞，不覆盖；请负责人确认`,
    );
  }
}

/** 项目快照：projects 业务字段 + contracts 金额字段（合同金额人工修改必须纳入快照）。 */
function projectSnapshotHash(db: DatabaseSync, projectId: string): string {
  return snapshotOfSql(
    db,
    `SELECT p.status AS status, p.customer_id AS customer_id, p.entry_at AS entry_at,
            p.region AS region, p.contract_start_date AS contract_start_date,
            p.contract_end_date AS contract_end_date,
            p.actual_install_done_at AS actual_install_done_at,
            p.acceptance_report AS acceptance_report,
            p.acceptance_report_date AS acceptance_report_date,
            p.cancelled_at AS cancelled_at,
            c.usd_tax_amount_cents AS usd_tax_amount_cents,
            c.entry_amount_snapshot_cents AS entry_amount_snapshot_cents,
            c.final_confirmable_amount_cents AS final_confirmable_amount_cents
       FROM projects p
       LEFT JOIN contracts c ON c.project_id = p.id
      WHERE p.id = ?`,
    [projectId],
  ) ?? '';
}

/** 物流费用快照：logistics_fees 业务字段 + 关联 batch.transport_company（batch 属迁移目标）。 */
function logisticsFeeSnapshotHash(db: DatabaseSync, feeId: string): string {
  return snapshotOfSql(
    db,
    `SELECT f.applied_at AS applied_at,
            f.budget_price_cents AS budget_price_cents,
            f.deal_price_cents AS deal_price_cents,
            f.logistics_cost_cents AS logistics_cost_cents,
            b.transport_company AS batch_transport_company,
            b.plan_transport_date AS batch_plan_transport_date
       FROM logistics_fees f
       LEFT JOIN batches b ON b.id = f.batch_id
      WHERE f.id = ?`,
    [feeId],
  ) ?? '';
}

/** 二维码申请快照：qr_requests 业务字段 + 关联 qr_request_types（类型属迁移目标）。 */
function qrRequestSnapshotHash(db: DatabaseSync, qrId: string): string {
  return snapshotOfSql(
    db,
    `SELECT q.applicant AS applicant, q.requested_at AS requested_at,
            (SELECT GROUP_CONCAT(type_code, '|' ORDER BY type_code)
               FROM qr_request_types t WHERE t.qr_request_id = q.id) AS type_codes
       FROM qr_requests q
      WHERE q.id = ?`,
    [qrId],
  ) ?? '';
}

/** 写入/刷新 import_record_audit（首次导入存目标快照；forward-fix 成功后刷新）。 */
function upsertRecordAudit(
  db: DatabaseSync,
  sourceKey: string,
  targetTable: string,
  targetId: string,
  importSourceHash: string,
  targetSnapshotHashValue: string,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO import_record_audit (
       id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at
     ) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(source_key) DO UPDATE SET
       target_id=excluded.target_id,
       import_source_hash=excluded.import_source_hash,
       target_snapshot_hash=excluded.target_snapshot_hash,
       imported_at=excluded.imported_at`,
  ).run(
    randomUUID(),
    sourceKey,
    targetTable,
    targetId,
    importSourceHash,
    targetSnapshotHashValue,
    nowIso,
  );
}

/** forward-fix 前置校验：目标自上次迁移后若被人工/外部修改则阻塞（不覆盖）。 */
/** 准备阶段：解析并构建 plan + 批次分组，做零写校验（errors/conflicts/digest/空导）。 */
export interface PreparedImport {
  plan: ImportPlan;
  batches: BatchGroup[];
  mapping: MigrationMapping;
  operator: string | null;
  nowIso: string;
  input: MigrationInput;
}

/**
 * Phase 1 — prepare/build plan：解析源行构建 ImportPlan，执行零写校验：
 * - errors/conflicts 任一非空 → 抛错（冲突未解决绝不写）；
 * - expectedSourceDigest 不一致 → 抛错（源变化）；
 * - 构建批次分组（依赖排序/统计用，不构成事务边界）。
 * 任何校验失败均在写入前抛出（零表写入）。
 */
export function prepareImport(input: MigrationInput): PreparedImport {
  const mapping = input.mapping ?? MAPPING_V1;
  const plan = buildImportPlan(input.rows, { mapping });
  if (plan.errors.length > 0 || plan.conflicts.length > 0) {
    throw new Error(
      `正式导入前 dry-run 必须无任何错误且无冲突：存在 ${plan.errors.length} 条错误、${plan.conflicts.length} 条冲突，请修正源 Excel 或解决冲突后重跑`,
    );
  }
  if (input.expectedSourceDigest !== undefined && input.expectedSourceDigest !== plan.sourceDigest) {
    throw new Error('源文件在 dry-run 后已被修改：源内容摘要不一致，拒绝导入，请重新执行 dry-run');
  }
  const batches = buildBatches(plan);
  return {
    plan,
    batches,
    mapping,
    operator: input.operator ?? null,
    nowIso: (input.now ?? new SystemClock()).nowIso(),
    input,
  };
}

// ---------------------------------------------------------------------------
// 向导流接线（tasks 8.40/8.41/8.46）：内核计划 → PreparedImport
// ---------------------------------------------------------------------------

/** 由规范化行合成 SourceRow（供 writers 的 sourceHash / 归属匹配使用）。 */
export function toSourceRow(row: NormalizedRow): SourceRow {
  return {
    file: row.sourceFile ?? (row.pasteBatch ? `paste:${row.pasteBatch}` : 'paste'),
    sheet: row.sourceSheet ?? '',
    rowNumber: row.sourceRow ?? 0,
    cells: { ...row.cells },
  };
}

/** 内核项目记录 → 迁移项目记录（复用现有 writer 写入路径）。 */
export function toImportedProject(p: PlanProject): ImportedProject {
  const sourceRows = p.rows.map(toSourceRow);
  return {
    sourceRows,
    importSourceKey: `project|${p.ecc}`,
    sourceHash: sourceRowsDigest(sourceRows),
    ecc: p.ecc,
    customerName: p.customerName,
    usdTaxAmountCents: p.usdTaxAmountCents,
    entryAt: p.entryAt,
    region: p.region,
    contractStartDate: p.contractStartDate,
    contractEndDate: p.contractEndDate,
    actualInstallDoneAt: p.actualInstallDoneAt,
    acceptanceReportDate: p.acceptanceReportDate,
    cancelledAt: p.cancelledAt,
  };
}

export function toImportedServiceOrder(o: PlanServiceOrder): ImportedServiceOrder {
  const row = toSourceRow(o.rows[0]);
  return {
    sourceRows: [row],
    importSourceKey: planSourceKey(`so|${o.serviceOrderNo}`, o.rows[0]),
    sourceHash: contentHash(row),
    serviceOrderNo: o.serviceOrderNo,
    orderType: o.orderType,
    orderedAt: o.orderedAt,
    engineer: o.engineer,
    customerName: o.customerName,
    note: o.note,
  };
}

export function toImportedInvoice(i: PlanInvoice): ImportedInvoice {
  const row = toSourceRow(i.rows[0]);
  return {
    sourceRows: [row],
    importSourceKey: planSourceKey(`invoice|${i.ecc}`, i.rows[0]),
    sourceHash: contentHash(row),
    ecc: i.ecc,
    amountCents: i.amountCents ?? 0n,
    invoicedAt: i.invoicedAt ?? '',
    region: i.region,
    customerName: i.customerName,
  };
}

export function toImportedLogisticsFee(f: PlanLogisticsFee): ImportedLogisticsFee {
  const row = toSourceRow(f.rows[0]);
  return {
    sourceRows: [row],
    importSourceKey: planSourceKey('lf', f.rows[0]),
    sourceHash: contentHash(row),
    ecc: f.ecc,
    appliedAt: f.appliedAt ?? '',
    budgetPriceCents: f.budgetPriceCents ?? 0n,
    dealPriceCents: f.dealPriceCents ?? 0n,
    logisticsCostCents: f.logisticsCostCents ?? 0n,
    transportCompany: f.transportCompany,
  };
}

export function toImportedSerialAddressUpdate(u: PlanSerialAddressUpdate): ImportedSerialAddressUpdate {
  const row = toSourceRow(u.rows[0]);
  return {
    sourceRows: [row],
    importSourceKey: planSourceKey('sau', u.rows[0]),
    sourceHash: contentHash(row),
    customerName: u.customerName,
    newSiteAddress: u.newSiteAddress,
    serialNo: u.serialNo,
    accountId: u.accountId,
    updatedAt: u.updatedAt,
  };
}

export function toImportedQrRequest(q: PlanQrRequest): ImportedQrRequest {
  const row = toSourceRow(q.rows[0]);
  return {
    sourceRows: [row],
    importSourceKey: planSourceKey('qr', q.rows[0]),
    sourceHash: contentHash(row),
    applicant: q.applicant,
    requestedAt: q.requestedAt,
    typeCodes: q.typeCode === null ? [] : [q.typeCode],
  };
}

export function toImportedShipToRequest(r: PlanShipToRequest): ImportedShipToRequest {
  const row = toSourceRow(r.rows[0]);
  return {
    sourceRows: [row],
    importSourceKey: planSourceKey('str', r.rows[0]),
    sourceHash: contentHash(row),
    customerName: r.customerName,
    newSiteAddress: r.newSiteAddress,
    accountId: r.accountId,
    requestedAt: r.requestedAt,
  };
}

/** 由内核计划构造 ImportPlan（供批次分组与对账；errors/conflicts 在封存前已清零）。 */
export function importPlanFromKernel(plan: NormalizedImportPlan): ImportPlan {
  return {
    projects: plan.projects.map(toImportedProject),
    serviceOrders: plan.serviceOrders.map(toImportedServiceOrder),
    invoices: plan.invoices.map(toImportedInvoice),
    logisticsFees: plan.logisticsFees.map(toImportedLogisticsFee),
    serialAddressUpdates: plan.serialAddressUpdates.map(toImportedSerialAddressUpdate),
    qrRequests: plan.qrRequests.map(toImportedQrRequest),
    shipToRequests: plan.shipToRequests.map(toImportedShipToRequest),
    suppliers: [],
    duplicateServiceOrders: [],
    conflicts: [],
    errors: [],
    recordCounts: { ...plan.recordCounts },
    ignoredSheets: [],
    unmappableRows: [],
    sourceDigest: plan.planDigest,
  };
}

export interface KernelImportOptions {
  operator?: string | null;
  now?: Clock;
  injectFault?: (phase: FaultPhase) => void;
}

/**
 * 向导流接线（tasks 8.40/8.41）：内核计划 → PreparedImport。
 * 复用现有 buildBatches 批次分组与 applyPlanInOpenTransaction 单事务写入路径，
 * 使七类记录、来源审计（migration_audit）与目标快照（import_record_audit）
 * 在同一正式事务内一次写入。
 */
export function prepareImportFromKernelPlan(
  plan: NormalizedImportPlan,
  options: KernelImportOptions = {},
): PreparedImport {
  const mapping = MAPPING_V1;
  const importPlan = importPlanFromKernel(plan);
  const batches = buildBatches(importPlan);
  return {
    plan: importPlan,
    batches,
    mapping,
    operator: options.operator ?? null,
    nowIso: (options.now ?? new SystemClock()).nowIso(),
    input: {
      rows: [],
      mapping,
      operator: options.operator ?? null,
      now: options.now,
      injectFault: options.injectFault,
    },
  };
}

/**
 * Phase 2 — 全局 preflight（任何写入前；结构/匹配错误零表失败）。
 * 校验每个 invoice/logistics/子记录可归属项目/外键、预计写入数与 plan 一致。
 * 返回问题列表；非空则 runImport 零表失败。
 */
export function preflightPlan(plan: ImportPlan): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const eccSet = new Set(plan.projects.map((p) => p.ecc));

  // 每个 invoice/logistics 必须归属 plan 内项目。
  for (const invoice of plan.invoices) {
    if (!eccSet.has(invoice.ecc)) {
      issues.push({ message: `掉票记录 ECC「${invoice.ecc}」无对应迁移项目，无法解析所属项目` });
    }
  }
  for (const fee of plan.logisticsFees) {
    if (fee.ecc === null || !eccSet.has(fee.ecc)) {
      issues.push({ message: `物流费用记录无有效 ECC 或无对应迁移项目，无法解析所属批次/项目` });
    }
  }

  // 预计写入数与 plan 一致（写入前校验；project 按 ECC 聚合）。
  const expected = expectedWriteCounts(plan);
  const roleKeyMap: Record<string, string> = {
    project: 'project',
    service_order: 'service_order',
    invoice: 'invoice',
    logistics_fee: 'logistics_fee',
    serial_address_update: 'serial_address_update',
    qr_request: 'qr_request',
    ship_to_request: 'ship_to_request',
  };
  for (const [role, count] of Object.entries(plan.recordCounts)) {
    if (role === 'supplier') continue;
    const key = roleKeyMap[role];
    if (key === undefined) continue;
    if (count === 0) continue;
    // project 以 ECC 聚合：plan.projects.length（多条源行聚合为一个项目）。
    if (key === 'project') {
      if (plan.projects.length === 0) {
        issues.push({ message: `角色「project」有 ${count} 条源行但无聚合项目（ECC 缺失）` });
      }
    } else {
      const exp = expected[key] ?? 0;
      if (exp !== count) {
        issues.push({ message: `角色「${role}」预计写入 ${exp} 条但 plan 记录 ${count} 条（不匹配）` });
      }
    }
  }
  return issues;
}

/** 迁移审计脱敏（Oracle 复审 #7）：完整 fileName/sheet/ECC/业务标识不落审计库，
 *  改为确定性 SHA-256 摘要；同一输入在任何运行产生同一摘要，幂等/forward-fix 不受影响。 */
export function desensitizeAuditIdentity(value: string | null): string | null {
  if (value === null || value === '') return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Phase 3 — applyPlanInOpenTransaction：**在调用方已开启的事务内**执行全部写入。
 * 接收已处于事务的 connection；任何 writer 与本函数不得 BEGIN/COMMIT/ROLLBACK。
 * 写入全部项目/standalone 七类记录、来源审计（migration_audit）、目标快照
 * （import_record_audit）；返回逐批结果与实际写入数。任一点失败直接向上抛错，
 * 由外层整体回滚（本函数不做任何事务控制）。
 */
export function applyPlanInOpenTransaction(
  db: DatabaseSync,
  prepared: PreparedImport,
): ImportResult {
  const { batches, operator, nowIso, input } = prepared;
  const batchResults: ImportBatchResult[] = [];
  let auditCount = 0;
  let importedProjectCount = 0;
  const writtenCounts: Record<string, number> = {
    project: 0,
    service_order: 0,
    invoice: 0,
    logistics_fee: 0,
    serial_address_update: 0,
    qr_request: 0,
    ship_to_request: 0,
  };

  for (const batch of batches) {
    const batchKey = batch.batchKey;
    const batchEcc = batch.ecc;
    // 审计落库/幂等查找使用脱敏摘要（不落完整 file#sheet#ECC 等业务标识）。
    const auditBatchKey = desensitizeAuditIdentity(batchKey)!;

    // 幂等：批次 sourceRows 含子记录 → 只有子记录变化时 digest 不同 → forward-fix。
    const existingAudits = db
      .prepare('SELECT id, source_hash, status FROM migration_audit WHERE batch_key = ?')
      .all(auditBatchKey) as { id: string; source_hash: string | null; status: string }[];
    const successHashes = existingAudits
      .filter((a) => a.status === 'success' && a.source_hash !== null)
      .map((a) => a.source_hash as string);

    // 同源重跑：整批全部源行（项目+子记录）hash 已存在且一致 → 幂等跳过。
    const allRowsAlreadyImported =
      batch.allRows.length > 0 &&
      batch.allRows.every((r) => successHashes.includes(sourceRowsDigest([r])));

    if (allRowsAlreadyImported) {
      batchResults.push({
        batchKey,
        status: 'skipped',
        importedCount: 0,
        failedCount: 0,
        errorDetails: '同源重跑：批次源内容未变，幂等跳过，不重复写入',
      });
      continue;
    }

    // 重写审计：删除既有批次审计后按新源重写（不删除目标数据）。
    for (const audit of existingAudits) {
      db.prepare('DELETE FROM migration_audit WHERE id = ?').run(audit.id);
    }

    // 项目记录（含客户/合同）。
    if (batch.project) {
      input.injectFault?.('writer_project');
      writeImportedProject(db, batch.project, operator, nowIso);
      writtenCounts.project += 1;
    }
    // 子记录。
    for (const order of batch.serviceOrders) {
      input.injectFault?.('writer_service_order');
      writeImportedServiceOrder(db, order, nowIso);
      writtenCounts.service_order += 1;
    }
    for (const invoice of batch.invoices) {
      input.injectFault?.('writer_invoice');
      writeImportedInvoice(db, invoice.ecc, invoice, nowIso);
      writtenCounts.invoice += 1;
    }
    for (const fee of batch.logisticsFees) {
      input.injectFault?.('writer_logistics_fee');
      writeImportedLogisticsFee(db, fee.ecc ?? '', fee, nowIso);
      writtenCounts.logistics_fee += 1;
    }
    for (const update of batch.serialAddressUpdates) {
      input.injectFault?.('writer_serial_address_update');
      writeImportedSerialAddressUpdate(db, update, nowIso);
      writtenCounts.serial_address_update += 1;
    }
    for (const qr of batch.qrRequests) {
      input.injectFault?.('writer_qr_request');
      writeImportedQrRequest(db, qr, nowIso);
      writtenCounts.qr_request += 1;
    }
    for (const req of batch.shipToRequests) {
      input.injectFault?.('writer_ship_to_request');
      writeImportedShipToRequest(db, req, nowIso);
      writtenCounts.ship_to_request += 1;
    }

    // 目标快照（import_record_audit）写入在 writers 内逐条完成；该点用于故障注入证明
    // 目标快照阶段失败时连同全部业务写入整体回滚（零部分写入）。
    input.injectFault?.('target_snapshot');

    // 来源审计记录：每源行一条（完整业务标识脱敏为确定性摘要）。
    for (const row of batch.allRows) {
      input.injectFault?.('audit');
      const auditRecord: MigrationAuditRecord = {
        id: randomUUID(),
        batchKey: auditBatchKey,
        fileName: desensitizeAuditIdentity(row.file),
        sheet: desensitizeAuditIdentity(row.sheet),
        rowNumber: row.rowNumber,
        ecc: desensitizeAuditIdentity(batchEcc),
        status: 'success',
        importedCount: 1,
        failedCount: 0,
        errorDetails: null,
        sourceHash: sourceRowsDigest([row]),
        operator,
        importedAt: nowIso,
      };
      db.prepare(
        `INSERT INTO migration_audit (
           id, batch_key, file_name, sheet, row_number, ecc, status,
           imported_count, failed_count, error_details, source_hash, operator, imported_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        auditRecord.id,
        auditRecord.batchKey,
        auditRecord.fileName,
        auditRecord.sheet,
        auditRecord.rowNumber,
        auditRecord.ecc,
        auditRecord.status,
        auditRecord.importedCount,
        auditRecord.failedCount,
        auditRecord.errorDetails,
        auditRecord.sourceHash,
        auditRecord.operator,
        auditRecord.importedAt,
      );
      auditCount += 1;
    }

    if (batch.project) importedProjectCount += 1;
    batchResults.push({
      batchKey,
      status: 'success',
      importedCount: batch.allRows.length,
      failedCount: 0,
      errorDetails: null,
    });
  }

  return { batches: batchResults, auditCount, importedProjectCount, writtenCounts };
}

/** 写后角色对账（事务内）：预计写入数与实际写入数必须一致（静默丢弃 → 抛错）。 */
function assertAllRolesWritten(
  plan: ImportPlan,
  writtenCounts: Record<string, number>,
): void {
  const roleKeyMap: Record<string, string> = {
    project: 'project',
    service_order: 'service_order',
    invoice: 'invoice',
    logistics_fee: 'logistics_fee',
    serial_address_update: 'serial_address_update',
    qr_request: 'qr_request',
    ship_to_request: 'ship_to_request',
  };
  for (const [role, count] of Object.entries(plan.recordCounts)) {
    if (role === 'supplier') continue; // 无目标表，仅参考
    const key = roleKeyMap[role];
    if (key === undefined) continue;
    if (count === 0) continue;
    // project 以 ECC 聚合：写入的项目数 = plan.projects.length（多条源行聚合为一个项目）。
    const expected = key === 'project' ? plan.projects.length : count;
    if ((writtenCounts[key] ?? 0) !== expected) {
      throw new Error(
        `角色「${role}」计划记录 ${expected} 条但实际写入 ${writtenCounts[key] ?? 0} 条：存在静默丢弃，导入失败`,
      );
    }
  }
}

/**
 * Phase 4 — 外层原子提交（runImport 唯一事务边界）：
 * 一次 BEGIN IMMEDIATE，所有项目/standalone 七类、来源审计、目标快照和写后角色
 * 对账在同一事务；任一点失败 → ROLLBACK 全部并明确零业务写入。
 */
export function runImport(
  db: DatabaseSync,
  input: MigrationInput,
): ImportResult {
  // Phase 1：prepare/build plan（零写校验，失败即抛，零写入）。
  const prepared = prepareImport(input);

  // Phase 2：全局 preflight（零写校验，失败即抛，零写入）。
  const preflight = preflightPlan(prepared.plan);
  if (preflight.length > 0) {
    throw new Error(
      `导入 preflight 失败（零写入）：${preflight.map((p) => p.message).join('；')}`,
    );
  }

  // Phase 3+4：单事务内 apply + 对账 + 原子提交；任一点失败整体回滚零写入。
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = applyPlanInOpenTransaction(db, prepared);

    // 写后角色对账（事务内）：任何被计数但未写入 → 抛错 → 整体回滚。
    input.injectFault?.('reconcile');
    const hasFailed = result.batches.some((b) => b.status === 'failed');
    if (!hasFailed && result.batches.some((b) => b.status === 'success')) {
      assertAllRolesWritten(prepared.plan, result.writtenCounts);
    }

    // 空导保护：源文件非空且既无成功批次也无 skipped 批次（幂等重跑）时不得「成功空导」。
    if (!hasFailed && result.batches.length === 0) {
      if (input.rows.length > 0) {
        throw new Error('没有任何记录被成功写入：存在静默丢弃/空导，导入失败');
      }
    }

    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败不影响主错误上报
    }
    // 空导保护（源文件非空且无任何批次）在写入前抛出，不属于批次失败结果。
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('没有任何记录被成功写入')) {
      throw err instanceof Error ? err : new Error(message);
    }
    // 应用/对账阶段失败（有批次但写入抛错，如人工修改阻塞、writer/审计/对账故障）：
    // 整体回滚零业务写入，并返回逐批 failed 结果（保持旧 API：批次失败以结果返回，
    // 不抛错）。pre-commit（prepare/preflight）失败已在进入事务前抛出。
    const failedBatches: ImportBatchResult[] = prepared.batches.map((b) => ({
      batchKey: b.batchKey,
      status: 'failed',
      importedCount: 0,
      failedCount: 1,
      errorDetails: message,
    }));
    return {
      batches: failedBatches,
      auditCount: 0,
      importedProjectCount: 0,
      writtenCounts: {
        project: 0,
        service_order: 0,
        invoice: 0,
        logistics_fee: 0,
        serial_address_update: 0,
        qr_request: 0,
        ship_to_request: 0,
      },
    };
  }
}

/** 预计写入数：project=ECC 聚合数，其余=各角色记录数（全部将写入）。 */
function expectedWriteCounts(plan: ImportPlan): Record<string, number> {
  return {
    project: plan.projects.length,
    service_order: plan.serviceOrders.length,
    invoice: plan.invoices.length,
    logistics_fee: plan.logisticsFees.length,
    serial_address_update: plan.serialAddressUpdates.length,
    qr_request: plan.qrRequests.length,
    ship_to_request: plan.shipToRequests.length,
  };
}

/** 构建批次分组：项目批次（项目 + 其子记录）+ standalone 批次。 */
function buildBatches(plan: ImportPlan): BatchGroup[] {
  const batches: BatchGroup[] = [];

  for (const project of plan.projects) {
    const batch: BatchGroup = {
      batchKey: `project|${project.ecc}`,
      ecc: project.ecc,
      allRows: [...project.sourceRows],
      project,
      serviceOrders: [],
      invoices: [],
      logisticsFees: [],
      serialAddressUpdates: [],
      qrRequests: [],
      shipToRequests: [],
    };
    for (const order of plan.serviceOrders) {
      if (belongsToProject(order.sourceRows, project)) {
        batch.serviceOrders.push(order);
        batch.allRows.push(...order.sourceRows);
      }
    }
    for (const invoice of plan.invoices) {
      if (invoice.ecc === project.ecc) {
        batch.invoices.push(invoice);
        batch.allRows.push(...invoice.sourceRows);
      }
    }
    for (const fee of plan.logisticsFees) {
      if (fee.ecc === project.ecc) {
        batch.logisticsFees.push(fee);
        batch.allRows.push(...fee.sourceRows);
      }
    }
    for (const update of plan.serialAddressUpdates) {
      if (belongsToProject(update.sourceRows, project)) {
        batch.serialAddressUpdates.push(update);
        batch.allRows.push(...update.sourceRows);
      }
    }
    for (const qr of plan.qrRequests) {
      if (belongsToProject(qr.sourceRows, project)) {
        batch.qrRequests.push(qr);
        batch.allRows.push(...qr.sourceRows);
      }
    }
    for (const req of plan.shipToRequests) {
      if (belongsToProject(req.sourceRows, project)) {
        batch.shipToRequests.push(req);
        batch.allRows.push(...req.sourceRows);
      }
    }
    batches.push(batch);
  }

  // standalone 批次：未被任何项目批次吸收的子记录（Oracle 复审 #3：含仅引用
  // 主库既有 ECC 的 invoice/logistics，writer 按 ECC 解析目标 project，不能空批次成功）。
  const standalone: BatchGroup = {
    batchKey: 'standalone',
    ecc: null,
    allRows: [],
    project: null,
    serviceOrders: [],
    invoices: [],
    logisticsFees: [],
    serialAddressUpdates: [],
    qrRequests: [],
    shipToRequests: [],
  };
  for (const order of plan.serviceOrders) {
    if (!belongsToAnyProject(order.sourceRows, plan.projects)) {
      standalone.serviceOrders.push(order);
      standalone.allRows.push(...order.sourceRows);
    }
  }
  for (const invoice of plan.invoices) {
    if (!plan.projects.some((p) => p.ecc === invoice.ecc)) {
      standalone.invoices.push(invoice);
      standalone.allRows.push(...invoice.sourceRows);
    }
  }
  for (const fee of plan.logisticsFees) {
    if (fee.ecc !== null && !plan.projects.some((p) => p.ecc === fee.ecc)) {
      standalone.logisticsFees.push(fee);
      standalone.allRows.push(...fee.sourceRows);
    }
  }
  for (const update of plan.serialAddressUpdates) {
    if (!belongsToAnyProject(update.sourceRows, plan.projects)) {
      standalone.serialAddressUpdates.push(update);
      standalone.allRows.push(...update.sourceRows);
    }
  }
  for (const qr of plan.qrRequests) {
    if (!belongsToAnyProject(qr.sourceRows, plan.projects)) {
      standalone.qrRequests.push(qr);
      standalone.allRows.push(...qr.sourceRows);
    }
  }
  for (const req of plan.shipToRequests) {
    if (!belongsToAnyProject(req.sourceRows, plan.projects)) {
      standalone.shipToRequests.push(req);
      standalone.allRows.push(...req.sourceRows);
    }
  }
  if (standalone.allRows.length > 0) {
    batches.push(standalone);
  }
  return batches;
}

/** 源行是否归属给定 ECC 项目（按行号+sheet 精确匹配聚合源行）。 */
function belongsToProject(rows: readonly SourceRow[], project: ImportedProject): boolean {
  return rows.some((r) => project.sourceRows.some((p) => p.file === r.file && p.sheet === r.sheet && p.rowNumber === r.rowNumber));
}

/** 源行是否归属任一项目。 */
function belongsToAnyProject(rows: readonly SourceRow[], projects: readonly ImportedProject[]): boolean {
  return projects.some((p) => belongsToProject(rows, p));
}

/** 根据 import_source_key 查找既有迁移记录（schema v7）。 */
function findImportedRow(
  db: DatabaseSync,
  table: string,
  sourceKey: string,
): { id: string; import_source_hash: string | null } | undefined {
  const row = db
    .prepare(`SELECT id, import_source_hash FROM ${table} WHERE import_source_key = ? LIMIT 1`)
    .get(sourceKey) as { id: string; import_source_hash: string | null } | undefined;
  return row;
}

/** 阻塞错误：目标存在但非迁移来源（人工记录/其他来源），无法安全 upsert。 */
function throwNotSafeUpsert(table: string): never {
  throw new Error(
    `目标表 ${table} 已存在非迁移来源记录（import_source_key 不一致或无来源标记），无法安全覆盖；请负责人确认处理（不删除数据）`,
  );
}

/** 写入一个聚合项目（ECC 主键）：客户、项目、合同；forward-fix 只更新同 source key。 */
function writeImportedProject(
  db: DatabaseSync,
  project: ImportedProject,
  operator: string | null,
  nowIso: string,
): void {
  const projectKey = `project|${project.ecc}`;
  const projectHash = sourceRowsDigest(project.sourceRows);

  // 客户主数据（trim 后全局唯一；存在则复用，不产生重复客户）。
  const customerName = project.customerName?.trim();
  let customerId: string | null = null;
  if (customerName) {
    const existing = db
      .prepare('SELECT id FROM customers WHERE name = ?')
      .get(customerName) as { id: string } | undefined;
    if (existing) {
      customerId = existing.id;
    } else {
      customerId = randomUUID();
      db.prepare(
        'INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)',
      ).run(customerId, customerName, nowIso, nowIso);
    }
  }

  const existingProject = findImportedRow(db, 'projects', projectKey);
  const status = rebuildStatus({
    entryAt: project.entryAt,
    executionStarted: false,
    actualInstallDoneAt: project.actualInstallDoneAt,
    acceptanceReportDate: project.acceptanceReportDate,
    cancelledAt: project.cancelledAt,
  });

  if (existingProject) {
    // forward-fix：仅更新同 source key 产生的迁移项目（Oracle 高风险 4：不删除任何数据）。
    const existingContract = db
      .prepare('SELECT id, project_id FROM contracts WHERE import_source_key = ? LIMIT 1')
      .get(`contract|${project.ecc}`) as { id: string; project_id: string } | undefined;
    if (!existingContract) {
      throwNotSafeUpsert('contracts');
    }
    // 防覆盖人工修改：目标自上次迁移后快照不一致（含合同金额）→ 阻塞（不覆盖）。
    assertTargetUnmodified(
      db,
      projectKey,
      'projects',
      existingProject.id,
      projectSnapshotHash(db, existingProject.id),
    );
    db.prepare(
      `UPDATE projects SET
         status=?, customer_id=?, entry_at=?, region=?, contract_start_date=?, contract_end_date=?,
         actual_install_done_at=?, acceptance_report=?, acceptance_report_date=?, cancelled_at=?,
         import_source_hash=?, updated_at=?
       WHERE id=?`,
    ).run(
      status,
      customerId,
      project.entryAt,
      project.region,
      project.contractStartDate,
      project.contractEndDate,
      project.actualInstallDoneAt,
      project.acceptanceReportDate !== null ? 1 : 0,
      project.acceptanceReportDate,
      project.cancelledAt,
      projectHash,
      nowIso,
      existingProject.id,
    );
    db.prepare(
      `UPDATE contracts SET
         usd_tax_amount_cents=?, entry_amount_snapshot_cents=?, final_confirmable_amount_cents=?,
         import_source_hash=?, updated_at=?
       WHERE id=?`,
    ).run(
      project.usdTaxAmountCents === null ? null : project.usdTaxAmountCents.toString(),
      project.usdTaxAmountCents === null ? null : project.usdTaxAmountCents.toString(),
      project.usdTaxAmountCents === null ? null : project.usdTaxAmountCents.toString(),
      projectHash,
      nowIso,
      existingContract.id,
    );
    // 刷新目标快照（projects + contracts 金额）。
    upsertRecordAudit(
      db,
      projectKey,
      'projects',
      existingProject.id,
      projectHash,
      projectSnapshotHash(db, existingProject.id),
      nowIso,
    );
    return;
  }

  // 新建：若同 ECC 合同已存在但非迁移来源 → 无法安全 upsert，阻塞。
  const manualContract = db
    .prepare('SELECT id FROM contracts WHERE ecc = ? AND (import_source_key IS NULL OR import_source_key <> ?)')
    .get(project.ecc, `contract|${project.ecc}`) as { id: string } | undefined;
  if (manualContract) {
    throwNotSafeUpsert('contracts');
  }

  const projectId = randomUUID();
  const tempNo = `MIG-${project.ecc}`;
  db.prepare(
    `INSERT INTO projects (
       id, temp_no, status, pre_entry_execution, scope_confirmed,
       customer_id, contract_id, entry_at, region,
       contract_start_date, contract_end_date,
       actual_install_done_at, acceptance_report, acceptance_report_date,
       cancelled_at, cancel_reason, import_source_key, import_source_hash,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    projectId,
    tempNo,
    status,
    0,
    project.customerName !== null ? 1 : 0,
    customerId,
    null,
    project.entryAt,
    project.region,
    project.contractStartDate,
    project.contractEndDate,
    project.actualInstallDoneAt,
    project.acceptanceReportDate !== null ? 1 : 0,
    project.acceptanceReportDate,
    project.cancelledAt,
    project.cancelledAt !== null ? '存量迁移取消' : null,
    projectKey,
    projectHash,
    nowIso,
    nowIso,
  );

  const contractId = randomUUID();
  db.prepare(
    `INSERT INTO contracts (
       id, project_id, temp_number, ecc, usd_tax_amount_cents,
       entry_amount_snapshot_cents, final_confirmable_amount_cents,
       import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    contractId,
    projectId,
    tempNo,
    project.ecc,
    project.usdTaxAmountCents === null ? null : project.usdTaxAmountCents.toString(),
    project.usdTaxAmountCents === null ? null : project.usdTaxAmountCents.toString(),
    project.usdTaxAmountCents === null ? null : project.usdTaxAmountCents.toString(),
    `contract|${project.ecc}`,
    projectHash,
    nowIso,
    nowIso,
  );

  db.prepare('UPDATE projects SET contract_id = ? WHERE id = ?').run(contractId, projectId);

  // 首次导入：记录目标快照（projects + contracts 金额；防后续 forward-fix 覆盖人工修改）。
  upsertRecordAudit(
    db,
    projectKey,
    'projects',
    projectId,
    projectHash,
    projectSnapshotHash(db, projectId),
    nowIso,
  );
  void operator;
}

/** 开单记录（schema v7 import 来源列；人工记录永不改删）。 */
function writeImportedServiceOrder(
  db: DatabaseSync,
  order: ImportedServiceOrder,
  nowIso: string,
): void {
  const key = order.importSourceKey;
  const existing = findImportedRow(db, 'service_orders', key);
  if (existing) {
    assertTargetUnmodified(
      db,
      key,
      'service_orders',
      existing.id,
      snapshotOfSql(
        db,
        `SELECT order_type AS order_type, service_order_no AS service_order_no,
                ordered_at AS ordered_at, engineer AS engineer,
                customer_name AS customer_name, note AS note
           FROM service_orders WHERE id = ?`,
        [existing.id],
      ) ?? '',
    );
    db.prepare(
      `UPDATE service_orders SET
         order_type=?, service_order_no=?, ordered_at=?, engineer=?, customer_name=?,
         note=?, import_source_hash=?, updated_at=? WHERE id=?`,
    ).run(
      order.orderType,
      order.serviceOrderNo,
      order.orderedAt,
      order.engineer,
      order.customerName,
      order.note,
      order.sourceHash,
      nowIso,
      existing.id,
    );
    upsertRecordAudit(
      db,
      key,
      'service_orders',
      existing.id,
      order.sourceHash,
      snapshotOfSql(
        db,
        `SELECT order_type AS order_type, service_order_no AS service_order_no,
                ordered_at AS ordered_at, engineer AS engineer,
                customer_name AS customer_name, note AS note
           FROM service_orders WHERE id = ?`,
        [existing.id],
      ) ?? '',
      nowIso,
    );
    return;
  }
  // 服务单号全局唯一：若已有非迁移来源记录 → 阻塞。
  const manual = db
    .prepare('SELECT id FROM service_orders WHERE service_order_no = ? AND (import_source_key IS NULL OR import_source_key <> ?)')
    .get(order.serviceOrderNo, key) as { id: string } | undefined;
  if (manual) {
    throwNotSafeUpsert('service_orders');
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO service_orders (
       id, order_type, service_order_no, ordered_at, engineer, customer_name,
       project_id, note, import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    order.orderType,
    order.serviceOrderNo,
    order.orderedAt,
    order.engineer,
    order.customerName,
    null,
    order.note,
    key,
    order.sourceHash,
    nowIso,
    nowIso,
  );
  upsertRecordAudit(
    db,
    key,
    'service_orders',
    id,
    order.sourceHash,
    snapshotOfSql(
      db,
      `SELECT order_type AS order_type, service_order_no AS service_order_no,
              ordered_at AS ordered_at, engineer AS engineer,
              customer_name AS customer_name, note AS note
         FROM service_orders WHERE id = ?`,
      [id],
    ) ?? '',
    nowIso,
  );
}

/** 掉票记录（归属项目；ECC 必须对应已迁移项目）。 */
function writeImportedInvoice(
  db: DatabaseSync,
  ecc: string,
  invoice: ImportedInvoice,
  nowIso: string,
): void {
  const key = invoice.importSourceKey;
  const project = db
    .prepare('SELECT p.id FROM projects p JOIN contracts c ON c.project_id = p.id WHERE c.ecc = ?')
    .get(ecc) as { id: string } | undefined;
  if (!project) {
    throw new Error(`掉票记录关联的搬迁项目不存在（ECC 未迁移）：无法写入 invoice（不删除数据）`);
  }
  const existing = findImportedRow(db, 'invoices', key);
  if (existing) {
    // 防覆盖人工修改：目标快照不一致 → 阻塞。
    assertTargetUnmodified(
      db,
      key,
      'invoices',
      existing.id,
      snapshotOfSql(
        db,
        `SELECT amount_cents AS amount_cents, invoiced_at AS invoiced_at,
                revoked_at AS revoked_at, revoke_reason AS revoke_reason
           FROM invoices WHERE id = ?`,
        [existing.id],
      ) ?? '',
    );
    db.prepare(
      'UPDATE invoices SET amount_cents=?, invoiced_at=?, import_source_hash=?, last_modified_at=? WHERE id=?',
    ).run(invoice.amountCents.toString(), invoice.invoicedAt, invoice.sourceHash, nowIso, existing.id);
    upsertRecordAudit(
      db,
      key,
      'invoices',
      existing.id,
      invoice.sourceHash,
      snapshotOfSql(
        db,
        `SELECT amount_cents AS amount_cents, invoiced_at AS invoiced_at,
                revoked_at AS revoked_at, revoke_reason AS revoke_reason
           FROM invoices WHERE id = ?`,
        [existing.id],
      ) ?? '',
      nowIso,
    );
    return;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO invoices (
       id, project_id, amount_cents, invoiced_at, revoked_at, revoke_reason,
       last_modified_at, import_source_key, import_source_hash, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    project.id,
    invoice.amountCents.toString(),
    invoice.invoicedAt,
    null,
    null,
    nowIso,
    key,
    invoice.sourceHash,
    nowIso,
  );
  upsertRecordAudit(
    db,
    key,
    'invoices',
    id,
    invoice.sourceHash,
    snapshotOfSql(
      db,
      `SELECT amount_cents AS amount_cents, invoiced_at AS invoiced_at,
              revoked_at AS revoked_at, revoke_reason AS revoke_reason
         FROM invoices WHERE id = ?`,
      [id],
    ) ?? '',
    nowIso,
  );
}

/** 物流费用（归属批次/项目；ECC 必须对应已迁移项目，批次由迁移创建）。 */
function writeImportedLogisticsFee(
  db: DatabaseSync,
  ecc: string,
  fee: ImportedLogisticsFee,
  nowIso: string,
): void {
  const project = db
    .prepare('SELECT p.id FROM projects p JOIN contracts c ON c.project_id = p.id WHERE c.ecc = ?')
    .get(ecc) as { id: string } | undefined;
  if (!project) {
    throw new Error(`物流费用关联的搬迁项目不存在（ECC 未迁移）：无法写入 logistics_fee（不删除数据）`);
  }
  const key = fee.importSourceKey;
  const existing = findImportedRow(db, 'logistics_fees', key);
  if (existing) {
    // 防覆盖人工修改：目标快照（含关联 batch.transport_company）不一致 → 阻塞。
    assertTargetUnmodified(
      db,
      key,
      'logistics_fees',
      existing.id,
      logisticsFeeSnapshotHash(db, existing.id),
    );
    db.prepare(
      `UPDATE logistics_fees SET
         applied_at=?, budget_price_cents=?, deal_price_cents=?, logistics_cost_cents=?,
         import_source_hash=?, updated_at=? WHERE id=?`,
    ).run(
      fee.appliedAt,
      fee.budgetPriceCents.toString(),
      fee.dealPriceCents.toString(),
      fee.logisticsCostCents.toString(),
      fee.sourceHash,
      nowIso,
      existing.id,
    );
    // forward-fix 同步迁移创建的 batch.transport_company（运输公司修正）。
    db.prepare(
      `UPDATE batches SET transport_company=?, updated_at=?
        WHERE id = (SELECT batch_id FROM logistics_fees WHERE id = ?)
          AND import_source_key IS NOT NULL`,
    ).run(fee.transportCompany, nowIso, existing.id);
    upsertRecordAudit(
      db,
      key,
      'logistics_fees',
      existing.id,
      fee.sourceHash,
      logisticsFeeSnapshotHash(db, existing.id),
      nowIso,
    );
    return;
  }
  // 每批次仅一笔：创建迁移批次并挂接费用。
  const batchId = randomUUID();
  db.prepare(
    `INSERT INTO batches (
       id, project_id, transport_company, import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    batchId,
    project.id,
    fee.transportCompany,
    `batch|${key}`,
    fee.sourceHash,
    nowIso,
    nowIso,
  );
  const feeId = randomUUID();
  db.prepare(
    `INSERT INTO logistics_fees (
       id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents,
       import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    feeId,
    batchId,
    fee.appliedAt,
    fee.budgetPriceCents.toString(),
    fee.dealPriceCents.toString(),
    fee.logisticsCostCents.toString(),
    key,
    fee.sourceHash,
    nowIso,
    nowIso,
  );
  upsertRecordAudit(
    db,
    key,
    'logistics_fees',
    feeId,
    fee.sourceHash,
    logisticsFeeSnapshotHash(db, feeId),
    nowIso,
  );
}

/** 序列号地址更新（不创建/修改 Ship-to 主数据）。 */
function writeImportedSerialAddressUpdate(
  db: DatabaseSync,
  update: ImportedSerialAddressUpdate,
  nowIso: string,
): void {
  const key = update.importSourceKey;
  const existing = findImportedRow(db, 'serial_address_updates', key);
  if (existing) {
    assertTargetUnmodified(
      db,
      key,
      'serial_address_updates',
      existing.id,
      snapshotOfSql(
        db,
        `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
                serial_no AS serial_no, account_id AS account_id, updated_at AS updated_at
           FROM serial_address_updates WHERE id = ?`,
        [existing.id],
      ) ?? '',
    );
    db.prepare(
      `UPDATE serial_address_updates SET
         customer_name=?, new_site_address=?, serial_no=?, account_id=?, updated_at=?,
         import_source_hash=? WHERE id=?`,
    ).run(
      update.customerName,
      update.newSiteAddress,
      update.serialNo,
      update.accountId,
      update.updatedAt,
      update.sourceHash,
      existing.id,
    );
    upsertRecordAudit(
      db,
      key,
      'serial_address_updates',
      existing.id,
      update.sourceHash,
      snapshotOfSql(
        db,
        `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
                serial_no AS serial_no, account_id AS account_id, updated_at AS updated_at
           FROM serial_address_updates WHERE id = ?`,
        [existing.id],
      ) ?? '',
      nowIso,
    );
    return;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO serial_address_updates (
       id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at,
       import_source_key, import_source_hash, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    null,
    update.customerName,
    update.newSiteAddress,
    update.serialNo,
    update.accountId,
    update.updatedAt,
    key,
    update.sourceHash,
    nowIso,
  );
  upsertRecordAudit(
    db,
    key,
    'serial_address_updates',
    id,
    update.sourceHash,
    snapshotOfSql(
      db,
      `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
              serial_no AS serial_no, account_id AS account_id, updated_at AS updated_at
         FROM serial_address_updates WHERE id = ?`,
      [id],
    ) ?? '',
    nowIso,
  );
}

/** 二维码申请（具体类型存在时才落库；无具体类型已被 dry-run 冲突阻断）。 */
function writeImportedQrRequest(
  db: DatabaseSync,
  qr: ImportedQrRequest,
  nowIso: string,
): void {
  const key = qr.importSourceKey;
  const existing = findImportedRow(db, 'qr_requests', key);
  if (existing) {
    assertTargetUnmodified(
      db,
      key,
      'qr_requests',
      existing.id,
      qrRequestSnapshotHash(db, existing.id),
    );
    db.prepare('UPDATE qr_requests SET applicant=?, requested_at=?, import_source_hash=? WHERE id=?').run(
      qr.applicant,
      qr.requestedAt,
      qr.sourceHash,
      existing.id,
    );
    db.prepare('DELETE FROM qr_request_types WHERE qr_request_id = ?').run(existing.id);
    for (const code of qr.typeCodes) {
      db.prepare('INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)').run(
        randomUUID(),
        existing.id,
        code,
      );
    }
    upsertRecordAudit(
      db,
      key,
      'qr_requests',
      existing.id,
      qr.sourceHash,
      qrRequestSnapshotHash(db, existing.id),
      nowIso,
    );
    return;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO qr_requests (
       id, applicant, requested_at, import_source_key, import_source_hash, created_at
     ) VALUES (?,?,?,?,?,?)`,
  ).run(id, qr.applicant, qr.requestedAt, key, qr.sourceHash, nowIso);
  for (const code of qr.typeCodes) {
    db.prepare('INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)').run(
      randomUUID(),
      id,
      code,
    );
  }
  upsertRecordAudit(
    db,
    key,
    'qr_requests',
    id,
    qr.sourceHash,
    qrRequestSnapshotHash(db, id),
    nowIso,
  );
}

/** Ship-to 申请（线性状态：待提交 → 处理中 → 已完成；迁移导入仅创建待提交）。 */
function writeImportedShipToRequest(
  db: DatabaseSync,
  req: ImportedShipToRequest,
  nowIso: string,
): void {
  const key = req.importSourceKey;
  const existing = findImportedRow(db, 'ship_to_requests', key);
  if (existing) {
    assertTargetUnmodified(
      db,
      key,
      'ship_to_requests',
      existing.id,
      snapshotOfSql(
        db,
        `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
                account_id AS account_id, status AS status,
                submitted_at AS submitted_at, completed_at AS completed_at
           FROM ship_to_requests WHERE id = ?`,
        [existing.id],
      ) ?? '',
    );
    db.prepare(
      `UPDATE ship_to_requests SET
         customer_name=?, new_site_address=?, account_id=?, status=?, import_source_hash=?, updated_at=?
       WHERE id=?`,
    ).run(
      req.customerName,
      req.newSiteAddress,
      req.accountId,
      'pending_submit',
      req.sourceHash,
      nowIso,
      existing.id,
    );
    upsertRecordAudit(
      db,
      key,
      'ship_to_requests',
      existing.id,
      req.sourceHash,
      snapshotOfSql(
        db,
        `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
                account_id AS account_id, status AS status,
                submitted_at AS submitted_at, completed_at AS completed_at
           FROM ship_to_requests WHERE id = ?`,
        [existing.id],
      ) ?? '',
      nowIso,
    );
    return;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ship_to_requests (
       id, customer_name, new_site_address, account_id, status,
       submitted_at, completed_at, import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    req.customerName,
    req.newSiteAddress,
    req.accountId,
    'pending_submit',
    req.requestedAt,
    null,
    key,
    req.sourceHash,
    nowIso,
    nowIso,
  );
  upsertRecordAudit(
    db,
    key,
    'ship_to_requests',
    id,
    req.sourceHash,
    snapshotOfSql(
      db,
      `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
              account_id AS account_id, status AS status,
              submitted_at AS submitted_at, completed_at AS completed_at
         FROM ship_to_requests WHERE id = ?`,
      [id],
    ) ?? '',
    nowIso,
  );
}

/** 导入计划中项目的最小形状（供外部只读引用）。 */
export interface ImportedProjectLike {
  ecc: string;
  customerName: string | null;
  usdTaxAmountCents: bigint | null;
  entryAt: string | null;
  region: string | null;
  contractStartDate: string | null;
  contractEndDate: string | null;
  actualInstallDoneAt: string | null;
  acceptanceReportDate: string | null;
  cancelledAt: string | null;
}
