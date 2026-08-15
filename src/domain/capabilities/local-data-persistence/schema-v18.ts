import type { DatabaseSync } from 'node:sqlite';
import { businessRevisionTriggerName } from './schema-v10';

/**
 * schema v18：物流费用登记全部字段可选（部分费用/无费用批次）。
 *
 * 业务语义（用户新要求，覆盖旧「applied_at/三金额必填、日期不可改」）：
 * - 新建批次时 planTransportDate/transportCompany/appliedAt/budgetPrice/dealPrice
 *   均可缺省；全空费用字段时只建批次、不建 logistics_fees；任一费用字段存在时
 *   创建部分费用记录；
 * - 编辑支持 undefined=保持、null=清空、值=覆盖；缺 fee 时按需创建；
 * - 空金额不得转 0、空日期不得默认当天；预算有值须 > 0、成交有值须 >= 0。
 *
 * 为支持上述语义，重建 logistics_fees，使业务费用字段全部可空：
 * - applied_at / budget_price_cents / deal_price_cents / logistics_cost_cents 改 nullable；
 * - 完整保留全部既有列（v1 基础列 + v2 账号归属 + v7 导入来源列）、STRICT、
 *   batch_id NOT NULL UNIQUE REFERENCES batches(id) 外键/唯一约束；
 * - 重建 v7 索引 idx_logistics_fees_import_source_key（RENAME+DROP 旧表会带走索引）；
 * - 重建 v10 业务修订三触发器（RENAME 后旧触发器随 legacy 表 DROP 删除，
 *   必须为新 logistics_fees 重新创建，business_revision 不漏记）。
 *
 * SQLite 不支持修改列可空性，故走「旧表 RENAME → 建新表 → 拷贝 → DROP 旧表」流程；
 * 无子表引用 logistics_fees，RENAME 后可直接 DROP。全部在迁移事务内执行。
 * 存量完整数据原样保留、不归一化（不改动任何历史值）。
 */
export const OPTIONAL_LOGISTICS_FEE_MIGRATION_VERSION = 18;

/** 当前最新 schema 版本。 */
export const LATEST_SCHEMA_VERSION = OPTIONAL_LOGISTICS_FEE_MIGRATION_VERSION;

export function applyOptionalLogisticsFeeMigration(db: DatabaseSync): void {
  // 1. 旧表换名（索引与触发器跟随旧表名，后续随 DROP 一并清除）。
  db.exec('ALTER TABLE logistics_fees RENAME TO logistics_fees_legacy;');

  // 2. 新表：业务费用字段全部可空，其余列/约束/外键与 v1+v2+v7 完全一致。
  db.exec(`
    CREATE TABLE logistics_fees (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id),
      applied_at TEXT,
      budget_price_cents INTEGER,
      deal_price_cents INTEGER,
      logistics_cost_cents INTEGER,
      account_id TEXT REFERENCES accounts(id),
      username_snapshot TEXT,
      import_source_key TEXT,
      import_source_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  // 3. 拷贝存量数据（完整保留，不归一化历史值）。
  db.exec(`
    INSERT INTO logistics_fees (
      id, batch_id, applied_at, budget_price_cents, deal_price_cents,
      logistics_cost_cents, account_id, username_snapshot,
      import_source_key, import_source_hash, created_at, updated_at
    )
    SELECT
      id, batch_id, applied_at, budget_price_cents, deal_price_cents,
      logistics_cost_cents, account_id, username_snapshot,
      import_source_key, import_source_hash, created_at, updated_at
    FROM logistics_fees_legacy;
  `);

  // 4. 丢弃旧表（其索引 idx_logistics_fees_import_source_key 与 v10 触发器随之删除）。
  db.exec('DROP TABLE logistics_fees_legacy;');

  // 5. 重建 v7 导入来源索引。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_logistics_fees_import_source_key ON logistics_fees(import_source_key);',
  );

  // 6. 重建 v10 业务修订三触发器（insert/update/delete，与 schema-v10 同构）。
  for (const event of ['insert', 'update', 'delete'] as const) {
    db.exec(
      `CREATE TRIGGER ${businessRevisionTriggerName('logistics_fees', event)}
       AFTER ${event.toUpperCase()} ON logistics_fees
       BEGIN
         UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1;
       END;`,
    );
  }
}
