import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { prepareReadBigInt } from './connection';

/**
 * 目标业务字段快照摘要（schema v9 import_record_audit / forward-fix 防覆盖人工修改）。
 *
 * 由 historical-data-import（migration-service、target-reader）与本地数据迁移
 * （schema v13 业务日期化）共用，保证「迁移刷新基线」「校验比对」「forward-fix 校验」
 * 三处快照口径完全一致：业务日期化迁移只改业务字段值，绝不改变本模块的取数与序列化规则。
 *
 * BigInt（金额分整数，经 prepareReadBigInt 读取）精确序列化为十进制字符串，不退化 Number。
 */

/** 目标快照摘要：BigInt 精确、null 保留、字符串/数值/布尔统一 String 化。 */
export function targetSnapshotHash(fields: Record<string, unknown>): string {
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
export function snapshotOfSql(
  db: DatabaseSync,
  sql: string,
  params: (string | number | bigint | null)[],
): string | null {
  const stmt = prepareReadBigInt(db, sql);
  const row = stmt.get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return targetSnapshotHash(row);
}

/** 项目快照：projects 业务字段 + contracts 金额字段（合同金额人工修改必须纳入快照）。 */
export function projectSnapshotHash(db: DatabaseSync, projectId: string): string {
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

/** 开单记录快照。 */
export function serviceOrderSnapshotHash(db: DatabaseSync, id: string): string {
  return snapshotOfSql(
    db,
    `SELECT order_type AS order_type, service_order_no AS service_order_no,
            ordered_at AS ordered_at, engineer AS engineer,
            customer_name AS customer_name, note AS note
       FROM service_orders WHERE id = ?`,
    [id],
  ) ?? '';
}

/** 掉票记录快照。 */
export function invoiceSnapshotHash(db: DatabaseSync, id: string): string {
  return snapshotOfSql(
    db,
    `SELECT amount_cents AS amount_cents, invoiced_at AS invoiced_at,
            revoked_at AS revoked_at, revoke_reason AS revoke_reason
       FROM invoices WHERE id = ?`,
    [id],
  ) ?? '';
}

/** 物流费用快照：logistics_fees 业务字段 + 关联 batch.transport_company（batch 属迁移目标）。 */
export function logisticsFeeSnapshotHash(db: DatabaseSync, feeId: string): string {
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

/** 序列号地址更新快照。 */
export function serialAddressUpdateSnapshotHash(db: DatabaseSync, id: string): string {
  return snapshotOfSql(
    db,
    `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
            serial_no AS serial_no, account_id AS account_id, updated_at AS updated_at
       FROM serial_address_updates WHERE id = ?`,
    [id],
  ) ?? '';
}

/** 二维码申请快照：qr_requests 业务字段 + 关联 qr_request_types（类型属迁移目标）。 */
export function qrRequestSnapshotHash(db: DatabaseSync, qrId: string): string {
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

/** Ship-to 申请快照。 */
export function shipToRequestSnapshotHash(db: DatabaseSync, id: string): string {
  return snapshotOfSql(
    db,
    `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
            account_id AS account_id, status AS status,
            submitted_at AS submitted_at, completed_at AS completed_at
       FROM ship_to_requests WHERE id = ?`,
    [id],
  ) ?? '';
}
