import type { DatabaseSync } from 'node:sqlite';
import {
  invoiceSnapshotHash,
  logisticsFeeSnapshotHash,
  projectSnapshotHash,
  qrRequestSnapshotHash,
  serialAddressUpdateSnapshotHash,
  serviceOrderSnapshotHash,
  shipToRequestSnapshotHash,
} from '../local-data-persistence/target-snapshot';

/**
 * 目标库只读快照读取器（tasks 8.33）。
 *
 * - 只读查询正式业务表 + import_record_audit 基线，绝不写入任何业务数据；
 * - 目标业务字段快照复用 local-data-persistence/target-snapshot（与迁移服务、
 *   schema v13 基线刷新同构：BigInt 金额以十进制字符串精确序列化，不退化
 *   Number；含项目+合同金额、物流费用+批次运输公司、二维码+类型）；
 * - 供校验阶段判断「人工目标 / 缺少可信基线 / 目标被修改」三类覆盖冲突。
 */

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

  // ---- 目标业务字段快照（复用 local-data-persistence/target-snapshot，BigInt 精确）----

  projectSnapshotHash(projectId: string): string {
    return projectSnapshotHash(this.db, projectId);
  }

  serviceOrderSnapshotHash(id: string): string {
    return serviceOrderSnapshotHash(this.db, id);
  }

  invoiceSnapshotHash(id: string): string {
    return invoiceSnapshotHash(this.db, id);
  }

  /** 物流费用快照：费用业务字段 + 关联批次运输公司（覆盖检查含批次）。 */
  logisticsFeeSnapshotHash(feeId: string): string {
    return logisticsFeeSnapshotHash(this.db, feeId);
  }

  /** 二维码申请快照：申请人 + 申请类型集合（覆盖检查含类型）。 */
  qrRequestSnapshotHash(qrId: string): string {
    return qrRequestSnapshotHash(this.db, qrId);
  }

  serialAddressUpdateSnapshotHash(id: string): string {
    return serialAddressUpdateSnapshotHash(this.db, id);
  }

  shipToRequestSnapshotHash(id: string): string {
    return shipToRequestSnapshotHash(this.db, id);
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
