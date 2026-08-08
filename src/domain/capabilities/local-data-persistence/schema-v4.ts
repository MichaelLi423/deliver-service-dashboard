import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v4（tasks 5.x）：掉票记录补充账号归属快照。
 *
 * 依据 design D12 与 tasks 5.x「手工事实账号归属」：掉票记录（新增/编辑/撤销）
 * 均为负责人手工录入事实，持久化登录账号内部 ID 与录入时用户名快照，
 * 历史统计按快照归属、不因以后改名变化。列名 account_id 在此表未被业务占用，
 * 与 v2/v3 归属列约定一致；全部可空，不破坏既有约束与数据。
 */
export function applyFinancialAttributionMigration(db: DatabaseSync): void {
  db.exec(`
    -- project-financial-closure：掉票记录（手工新增/编辑/撤销）
    ALTER TABLE invoices ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE invoices ADD COLUMN username_snapshot TEXT;
  `);
}

/** schema v4 版本号。 */
export const FINANCIAL_ATTRIBUTION_MIGRATION_VERSION = 4;
