import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { prepareReadBigInt } from '../local-data-persistence/connection';

/**
 * 目标库只读快照读取器（tasks 8.33）。
 *
 * - 只读查询正式业务表 + import_record_audit 基线，绝不写入任何业务数据；
 * - 目标业务字段快照与 migration-service 同构（BigInt 金额以十进制字符串精确
 *   序列化，不退化 Number；含项目+合同金额、物流费用+批次运输公司、二维码+类型）；
 * - 供校验阶段判断「人工目标 / 缺少可信基线 / 目标被修改」三类覆盖冲突。
 */

/** 目标快照摘要（BigInt 精确；与迁移目标快照口径一致）。 */
export function targetSnapshotHash(fields: Record<string, unknown>): string {
  const canonical = JSON.stringify(fields, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value === null) return null;
    if (typeof value === 'object') return value; // 对象/数组原样序列化
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

/** 以 BigInt 读取单行并计算快照摘要；无行返回 null。 */
function snapshotOf(db: DatabaseSync, sql: string, params: (string | number | bigint | null)[]): string | null {
  const row = prepareReadBigInt(db, sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return targetSnapshotHash(row);
}

export interface TargetContractInfo {
  id: string;
  projectId: string;
  importSourceKey: string | null;
}

export interface TargetRecordInfo {
  id: string;
  importSourceKey: string | null;
}

/** 目标库只读读取器（校验阶段使用；不提供任何写方法）。 */
export class TargetConflictReader {
  constructor(private readonly db: DatabaseSync) {}

  /** 按 import_source_key 精确匹配既有迁移记录（forward-fix 目标）。 */
  findRecordBySourceKey(table: string, sourceKey: string): TargetRecordInfo | null {
    if (!this.hasSourceKeyColumn(table)) return null;
    const row = this.db
      .prepare(`SELECT id, import_source_key FROM ${table} WHERE import_source_key = ? LIMIT 1`)
      .get(sourceKey) as { id: string; import_source_key: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, importSourceKey: row.import_source_key };
  }

  /** v9 目标快照基线（import_record_audit）；无基线返回 null（缺少可信基线）。 */
  baselineFor(sourceKey: string): string | null {
    const row = this.db
      .prepare('SELECT target_snapshot_hash FROM import_record_audit WHERE source_key = ?')
      .get(sourceKey) as { target_snapshot_hash: string } | undefined;
    return row?.target_snapshot_hash ?? null;
  }

  /** 合同按 ECC（唯一）；用于项目覆盖检查与 ECC 引用唯一性。 */
  contractByEcc(ecc: string): TargetContractInfo | null {
    const row = this.db
      .prepare('SELECT id, project_id, import_source_key FROM contracts WHERE ecc = ? LIMIT 1')
      .get(ecc) as { id: string; project_id: string; import_source_key: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, projectId: row.project_id, importSourceKey: row.import_source_key };
  }

  /** 目标库中是否存在该 ECC（唯一匹配）。 */
  hasEcc(ecc: string): boolean {
    return this.contractByEcc(ecc) !== null;
  }

  /** 服务单号在目标库中是否唯一占用。 */
  hasServiceOrderNo(no: string): boolean {
    return (
      this.db.prepare('SELECT id FROM service_orders WHERE service_order_no = ? LIMIT 1').get(no) !== undefined
    );
  }

  /** Account ID 在目标库 Ship-to 主数据 / Ship-to 申请中是否唯一占用。 */
  hasAccountId(accountId: string): boolean {
    return (
      this.db.prepare('SELECT id FROM ship_tos WHERE account_id = ? LIMIT 1').get(accountId) !== undefined ||
      this.db.prepare('SELECT id FROM ship_to_requests WHERE account_id = ? LIMIT 1').get(accountId) !== undefined
    );
  }

  /** 序列号在目标库中出现的项目 ID 集合（同项目唯一、跨项目可重复）。 */
  projectsBySerial(serialNo: string): string[] {
    const rows = this.db
      .prepare('SELECT project_id FROM instruments WHERE serial_no = ? ORDER BY project_id')
      .all(serialNo) as Array<{ project_id: string }>;
    return rows.map((r) => r.project_id);
  }

  // ---- 目标业务字段快照（与 migration-service 同构，BigInt 精确）----

  projectSnapshotHash(projectId: string): string {
    return (
      snapshotOf(
        this.db,
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
      ) ?? ''
    );
  }

  serviceOrderSnapshotHash(id: string): string {
    return (
      snapshotOf(
        this.db,
        `SELECT order_type AS order_type, service_order_no AS service_order_no,
                ordered_at AS ordered_at, engineer AS engineer,
                customer_name AS customer_name, note AS note
           FROM service_orders WHERE id = ?`,
        [id],
      ) ?? ''
    );
  }

  invoiceSnapshotHash(id: string): string {
    return (
      snapshotOf(
        this.db,
        `SELECT amount_cents AS amount_cents, invoiced_at AS invoiced_at,
                revoked_at AS revoked_at, revoke_reason AS revoke_reason
           FROM invoices WHERE id = ?`,
        [id],
      ) ?? ''
    );
  }

  /** 物流费用快照：费用业务字段 + 关联批次运输公司（覆盖检查含批次）。 */
  logisticsFeeSnapshotHash(feeId: string): string {
    return (
      snapshotOf(
        this.db,
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
      ) ?? ''
    );
  }

  /** 二维码申请快照：申请人 + 申请类型集合（覆盖检查含类型）。 */
  qrRequestSnapshotHash(qrId: string): string {
    return (
      snapshotOf(
        this.db,
        `SELECT q.applicant AS applicant, q.requested_at AS requested_at,
                (SELECT GROUP_CONCAT(type_code, '|' ORDER BY type_code)
                   FROM qr_request_types t WHERE t.qr_request_id = q.id) AS type_codes
           FROM qr_requests q
          WHERE q.id = ?`,
        [qrId],
      ) ?? ''
    );
  }

  serialAddressUpdateSnapshotHash(id: string): string {
    return (
      snapshotOf(
        this.db,
        `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
                serial_no AS serial_no, account_id AS account_id, updated_at AS updated_at
           FROM serial_address_updates WHERE id = ?`,
        [id],
      ) ?? ''
    );
  }

  shipToRequestSnapshotHash(id: string): string {
    return (
      snapshotOf(
        this.db,
        `SELECT customer_name AS customer_name, new_site_address AS new_site_address,
                account_id AS account_id, status AS status,
                submitted_at AS submitted_at, completed_at AS completed_at
           FROM ship_to_requests WHERE id = ?`,
        [id],
      ) ?? ''
    );
  }

  private hasSourceKeyColumn(table: string): boolean {
    return (
      [
        'projects',
        'contracts',
        'service_orders',
        'invoices',
        'logistics_fees',
        'batches',
        'serial_address_updates',
        'qr_requests',
        'ship_to_requests',
      ].includes(table)
    );
  }
}
