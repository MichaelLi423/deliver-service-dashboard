import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v3（tasks 4.x）：为 4.x 能力的手工录入事实表补充账号归属快照。
 *
 * 依据 design D12 与 tasks 4.x「所有手工记录绑定当前账号快照」：
 * Ship-to 申请、序列号地址更新、损坏/维修事项、维修活动关联与二维码申请均
 * 持久化登录账号内部 ID 与录入时用户名快照，历史统计按快照归属、不因改名变化。
 *
 * 列名约定：ship_to_requests / serial_address_updates 已占用 account_id 表达
 * 业务字段（Ship-to 的 Account ID），故其归属列命名为 actor_account_id；
 * 其余表使用 account_id 与 username_snapshot（与 v2 归属列一致）。
 * 全部新增列可空，不破坏既有约束与数据。
 */
export function applyCapabilityAttributionMigration(db: DatabaseSync): void {
  db.exec(`
    -- ship-to-management：Ship-to 申请（手工创建与状态维护）
    ALTER TABLE ship_to_requests ADD COLUMN actor_account_id TEXT REFERENCES accounts(id);
    ALTER TABLE ship_to_requests ADD COLUMN username_snapshot TEXT;

    -- serial-address-update：序列号地址更新事实（逐台登记）
    ALTER TABLE serial_address_updates ADD COLUMN actor_account_id TEXT REFERENCES accounts(id);
    ALTER TABLE serial_address_updates ADD COLUMN username_snapshot TEXT;

    -- damage-repair-tracking：损坏/维修事项（含所属项目，便于按项目统计与合同限制）
    ALTER TABLE damage_repair_items ADD COLUMN project_id TEXT REFERENCES projects(id);
    ALTER TABLE damage_repair_items ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE damage_repair_items ADD COLUMN username_snapshot TEXT;

    -- damage-repair-tracking：维修上门活动 × 事项多对多关联
    ALTER TABLE activity_damage_links ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE activity_damage_links ADD COLUMN username_snapshot TEXT;

    -- qr-request-tracking：二维码申请
    ALTER TABLE qr_requests ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE qr_requests ADD COLUMN username_snapshot TEXT;
  `);
}

/** schema v3 版本号。 */
export const CAPABILITY_ATTRIBUTION_MIGRATION_VERSION = 3;
