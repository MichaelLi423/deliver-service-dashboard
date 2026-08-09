import type { DatabaseSync } from 'node:sqlite';
import { normalizeBusinessDateStored } from './business-date';
import {
  invoiceSnapshotHash,
  logisticsFeeSnapshotHash,
  projectSnapshotHash,
  qrRequestSnapshotHash,
  serialAddressUpdateSnapshotHash,
  serviceOrderSnapshotHash,
  shipToRequestSnapshotHash,
} from './target-snapshot';

/**
 * schema v13：业务日期化（时间口径 design D30 —— 业务时间仅记录业务日期 yyyy-mm-dd）。
 *
 * 按显式业务字段白名单（BUSINESS_DATE_COLUMNS）把存量业务日期字段统一为 yyyy-mm-dd：
 * - 旧纯日期 yyyy-mm-dd → 原样保留；
 * - 带 Z/显式偏移 ISO → 先按「冻结的本机 IANA 时区」换算为本地日历日；
 * - 无偏移 datetime（yyyy-m-d[ T]HH:mm[:ss]）→ 视为本地墙钟取日期部分；
 * - 非法值 → 抛错并报告 table/id/column，依赖外层迁移事务整体回滚（零残留）。
 *
 * 审计/技术字段（created_at/updated_at/imported_at/import_source_hash 等）绝不改变。
 *
 * 目标快照基线同步：业务日期化会改变目标业务字段值，若不同步刷新
 * import_record_audit.target_snapshot_hash，forward-fix 将把「v13 自身造成的值变化」
 * 误判为人工/外部修改而假冲突。因此本迁移在转换后按现有目标快照逻辑（与迁移/校验
 * 同构，见 target-snapshot.ts）重算每条审计基线，只更新 target_snapshot_hash，
 * 保持 import_source_hash 与 imported_at 不变。
 */

export const BUSINESS_DATE_MIGRATION_VERSION = 13;

/** 业务日期化白名单：(table, column) 显式声明（design D30 全部业务时间字段）。 */
export const BUSINESS_DATE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'projects', column: 'entry_at' },
  { table: 'projects', column: 'contract_start_date' },
  { table: 'projects', column: 'contract_end_date' },
  { table: 'projects', column: 'plan_visit_at' },
  { table: 'projects', column: 'plan_transport_at' },
  { table: 'projects', column: 'actual_install_done_at' },
  { table: 'projects', column: 'acceptance_report_date' },
  { table: 'projects', column: 'cancelled_at' },
  { table: 'projects', column: 'reminder_at' },
  { table: 'batches', column: 'plan_transport_date' },
  { table: 'batches', column: 'started_at' },
  { table: 'batch_change_history', column: 'changed_at' },
  { table: 'activities', column: 'visit_at' },
  { table: 'work_facts', column: 'started_at' },
  { table: 'work_facts', column: 'completed_at' },
  { table: 'service_orders', column: 'ordered_at' },
  { table: 'invoices', column: 'invoiced_at' },
  { table: 'invoices', column: 'revoked_at' },
  { table: 'logistics_fees', column: 'applied_at' },
  { table: 'serial_address_updates', column: 'updated_at' },
  { table: 'damage_repair_items', column: 'registered_at' },
  { table: 'damage_repair_items', column: 'part_requested_at' },
  { table: 'qr_requests', column: 'requested_at' },
  { table: 'ship_to_requests', column: 'submitted_at' },
  { table: 'ship_to_requests', column: 'completed_at' },
];

/** 审计目标表 → 目标快照函数（与迁移/校验同构；v13 转换后据此刷新基线）。 */
const AUDIT_TARGET_SNAPSHOTS: Record<string, (db: DatabaseSync, id: string) => string> = {
  projects: projectSnapshotHash,
  service_orders: serviceOrderSnapshotHash,
  invoices: invoiceSnapshotHash,
  logistics_fees: logisticsFeeSnapshotHash,
  serial_address_updates: serialAddressUpdateSnapshotHash,
  qr_requests: qrRequestSnapshotHash,
  ship_to_requests: shipToRequestSnapshotHash,
};

/** 由存量值规范化业务日期；非法值抛错（外层迁移事务整体回滚）。 */
function normalizeColumnValue(
  table: string,
  column: string,
  id: string,
  value: string,
): string {
  try {
    return normalizeBusinessDateStored(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`业务日期字段 ${table}.${column} 行 ${id} ${detail}`);
  }
}

export function applyBusinessDateMigration(db: DatabaseSync): void {
  // 1) 白名单业务日期字段：存量值统一为 yyyy-mm-dd（非法值报 table/id/column 后整体回滚）。
  for (const { table, column } of BUSINESS_DATE_COLUMNS) {
    const rows = db
      .prepare(`SELECT id, "${column}" AS value FROM "${table}"`)
      .all() as { id: string; value: string | null }[];
    for (const row of rows) {
      if (row.value === null || row.value.trim() === '') continue;
      const normalized = normalizeColumnValue(table, column, row.id, row.value);
      if (normalized !== row.value) {
        db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE id = ?`).run(normalized, row.id);
      }
    }
  }

  // 2) 同步刷新 import_record_audit.target_snapshot_hash（保持 import_source_hash/imported_at 不变），
  //    避免 v13 转换后被 forward-fix 误判为目标被人工修改（假冲突）。
  const audits = db
    .prepare('SELECT source_key, target_table, target_id FROM import_record_audit')
    .all() as { source_key: string; target_table: string; target_id: string }[];
  for (const audit of audits) {
    const snapshot = AUDIT_TARGET_SNAPSHOTS[audit.target_table];
    if (snapshot === undefined) continue; // 未知目标表（防御；不猜测）
    const hash = snapshot(db, audit.target_id);
    if (hash === '') continue; // 目标行不存在 → 不触碰基线
    db.prepare('UPDATE import_record_audit SET target_snapshot_hash = ? WHERE source_key = ?').run(
      hash,
      audit.source_key,
    );
  }
}
