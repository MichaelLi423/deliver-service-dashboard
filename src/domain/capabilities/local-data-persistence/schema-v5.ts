import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v5（tasks 6.x）：项目提醒操作绑定登录账号归属快照。
 *
 * 依据 design D12 与 tasks 6.x「手工维护事实绑定当前账号快照」：项目提醒由
 * 负责人手工创建/编辑/清除，最近一次提醒操作持久化登录账号内部 ID 与当时
 * 用户名快照，历史统计按快照归属、不因以后改名变化。提醒字段本体
 * （reminder_at/reminder_note）自 v1 即落在项目聚合内。
 *
 * 全部新增列可空（历史数据无归属场景），不破坏既有约束与数据。
 */
export function applyReminderAttributionMigration(db: DatabaseSync): void {
  db.exec(`
    -- workbench-todos：项目提醒最近一次操作归属快照（手工维护事实归属）
    ALTER TABLE projects ADD COLUMN reminder_account_id TEXT REFERENCES accounts(id);
    ALTER TABLE projects ADD COLUMN reminder_username_snapshot TEXT;
  `);
}

/** schema v5 版本号。 */
export const REMINDER_ATTRIBUTION_MIGRATION_VERSION = 5;
