import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v7（tasks 8.x）：为每个迁移目标表补充导入来源列。
 *
 * 依据 Oracle 高风险 3/4 与 design D11：每个被迁移目标记录持久化
 * `import_source_key`（迁移来源键）与 `import_source_hash`（源内容摘要），
 * 用于：
 * - forward-fix 只更新「同 source key 产生的迁移记录」；
 * - 人工记录（无 source key）永不因迁移被修改或删除；
 * - 幂等重跑（同 source key + 同 hash 跳过）与源变化检测（hash 不同）。
 *
 * 全部新增列可空（人工记录无来源键），不破坏 v1~v6 既有约束与数据。
 * 为每个来源键建索引，forward-fix / 幂等查找 O(log n)。
 */
export function applyImportProvenanceMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE customers ADD COLUMN import_source_key TEXT;
    ALTER TABLE customers ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_customers_import_source_key ON customers(import_source_key);

    ALTER TABLE projects ADD COLUMN import_source_key TEXT;
    ALTER TABLE projects ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_projects_import_source_key ON projects(import_source_key);

    ALTER TABLE contracts ADD COLUMN import_source_key TEXT;
    ALTER TABLE contracts ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_contracts_import_source_key ON contracts(import_source_key);

    ALTER TABLE service_orders ADD COLUMN import_source_key TEXT;
    ALTER TABLE service_orders ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_service_orders_import_source_key ON service_orders(import_source_key);

    ALTER TABLE invoices ADD COLUMN import_source_key TEXT;
    ALTER TABLE invoices ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_invoices_import_source_key ON invoices(import_source_key);

    ALTER TABLE logistics_fees ADD COLUMN import_source_key TEXT;
    ALTER TABLE logistics_fees ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_logistics_fees_import_source_key ON logistics_fees(import_source_key);

    ALTER TABLE batches ADD COLUMN import_source_key TEXT;
    ALTER TABLE batches ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_batches_import_source_key ON batches(import_source_key);

    ALTER TABLE serial_address_updates ADD COLUMN import_source_key TEXT;
    ALTER TABLE serial_address_updates ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_serial_address_updates_import_source_key ON serial_address_updates(import_source_key);

    ALTER TABLE qr_requests ADD COLUMN import_source_key TEXT;
    ALTER TABLE qr_requests ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_qr_requests_import_source_key ON qr_requests(import_source_key);

    ALTER TABLE ship_to_requests ADD COLUMN import_source_key TEXT;
    ALTER TABLE ship_to_requests ADD COLUMN import_source_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_ship_to_requests_import_source_key ON ship_to_requests(import_source_key);
  `);
}

/** schema v7 版本号。 */
export const IMPORT_PROVENANCE_MIGRATION_VERSION = 7;
