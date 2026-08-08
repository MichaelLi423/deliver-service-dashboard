import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v2（tasks 3.x）：为手工录入事实表补充账号归属快照。
 *
 * 依据 design D12 与 tasks 3.x「所有手工事实绑定当前 account attribution」：
 * 负责人手工录入的搬迁执行侧事实（仪器登记、批次报价、上门活动、工作事实、
 * 物流费用、开单记录）持久化登录账号内部 ID 与录入时用户名快照，历史统计
 * 按快照归属、不因以后改名变化。改批历史在 v1 已含 account_id/username_snapshot。
 *
 * 全部新增列均可空（历史数据与占位/导入场景无归属），不破坏 v1 既有约束与数据。
 */
export function applyAttributionColumnsMigration(db: DatabaseSync): void {
  db.exec(`
    -- 搬迁批次（报价录入）
    ALTER TABLE batches ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE batches ADD COLUMN username_snapshot TEXT;

    -- 搬迁仪器（登记）
    ALTER TABLE instruments ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE instruments ADD COLUMN username_snapshot TEXT;

    -- 上门活动（到访事实）
    ALTER TABLE activities ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE activities ADD COLUMN username_snapshot TEXT;

    -- 活动 × 仪器 × 工作类型事实行
    ALTER TABLE work_facts ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE work_facts ADD COLUMN username_snapshot TEXT;

    -- 实际物流费用记录
    ALTER TABLE logistics_fees ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE logistics_fees ADD COLUMN username_snapshot TEXT;

    -- 四类开单记录
    ALTER TABLE service_orders ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE service_orders ADD COLUMN username_snapshot TEXT;
  `);
}

/** schema v2 版本号。 */
export const ATTRIBUTION_MIGRATION_VERSION = 2;
