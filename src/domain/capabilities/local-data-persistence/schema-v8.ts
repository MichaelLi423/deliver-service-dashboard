import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v8（Oracle 高风险 5/6/9 修复）。
 *
 * 1. damage_repair_items.project_id 完整性（Oracle 高风险 5/6 SQLite 侧）：
 *    - 迁移前先按 instrument_id 关联 instruments.project_id 回填 v3 引入的 project_id；
 *    - 任何无法回填（instrument 缺失/悬空引用）的行使迁移失败（MigrationError 携带
 *      迁移前安全备份，整体回滚、保留原库可恢复），绝不静默丢弃；
 *    - 回填后重建表，把 project_id 改为 NOT NULL，完整保留既有列、外键、
 *      CHECK 约束与账号归属列（account_id/username_snapshot）。
 *
 * 2. ship_to_requests 同客户同新址唯一（Oracle 高风险 9）：
 *    - 添加 trim(customer_name)+trim(new_site_address) 唯一索引（表达式索引），
 *      在数据库层落实「同客户同新址一条申请」；
 *    - 迁移时若已有 trim 后重复数据则失败并报告（不静默删除）。
 *
 * 全部变更在迁移事务内执行，失败整体回滚并保留迁移前安全备份。
 */
export function applyIntegrityMigrations(db: DatabaseSync): void {
  // ---- 1. damage_repair_items：回填 project_id，无法回填即失败 ----

  // 回填：project_id 为空的行按 instrument_id 关联所属项目（v3 引入可空列的存量数据）。
  db.exec(`
    UPDATE damage_repair_items
    SET project_id = (
      SELECT instruments.project_id
      FROM instruments
      WHERE instruments.id = damage_repair_items.instrument_id
    )
    WHERE project_id IS NULL;
  `);

  // 回填后仍为空（instrument 缺失或悬空引用）→ 迁移失败并报告，保留可恢复状态。
  const orphans = db
    .prepare('SELECT id, instrument_id FROM damage_repair_items WHERE project_id IS NULL')
    .all() as { id: string; instrument_id: string }[];
  if (orphans.length > 0) {
    const samples = orphans
      .slice(0, 5)
      .map((o) => `事项 ${o.id}（instrument_id=${o.instrument_id}）`)
      .join('、');
    throw new Error(
      `共 ${orphans.length} 条损坏/维修事项无法回填所属项目（对应仪器缺失）: ${samples}；` +
        '迁移已中止并保留迁移前数据，请先修复源数据后重试',
    );
  }

  rebuildDamageRepairItemsNotNull(db);

  // ---- 2. ship_to_requests：trim 后唯一索引，存量重复先失败再建索引 ----

  const duplicates = db
    .prepare(
      `SELECT trim(customer_name) AS customer_name, trim(new_site_address) AS new_site_address, COUNT(*) AS n
       FROM ship_to_requests
       GROUP BY trim(customer_name), trim(new_site_address)
       HAVING COUNT(*) > 1`,
    )
    .all() as { customer_name: string; new_site_address: string; n: number }[];
  if (duplicates.length > 0) {
    const samples = duplicates
      .slice(0, 5)
      .map((d) => `客户「${d.customer_name}」新址「${d.new_site_address}」× ${d.n} 条`)
      .join('、');
    throw new Error(
      `ship_to_requests 存在 ${duplicates.length} 组 trim 后重复的「同客户同新址」申请: ${samples}；` +
        '迁移已中止并保留迁移前数据（不静默删除），请先人工去重后重试',
    );
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ship_to_requests_customer_address
      ON ship_to_requests(trim(customer_name), trim(new_site_address));
  `);
}

/**
 * 重建 damage_repair_items 使 project_id NOT NULL。
 *
 * SQLite 不支持修改列 NOT NULL，故走「建新表→拷贝→换名」流程；foreign_keys=ON 时
 * DROP 旧表会因 activity_damage_links 子表引用而失败，因此先 RENAME 旧表（子表外键
 * 自动改写为指向旧名），重建子表外键指向新表后，再 DROP 旧表。全部在迁移事务内完成。
 *
 * 完整保留：v1 既有列/CHECK/外键 + v3 账号归属列（project_id/account_id/username_snapshot），
 * activity_damage_links 的 UNIQUE(activity_id, damage_item_id) 与 account 归属列。
 */
function rebuildDamageRepairItemsNotNull(db: DatabaseSync): void {
  // 1. 旧表换名：activity_damage_links 的外键自动改写为指向 damage_repair_items_legacy。
  db.exec('ALTER TABLE damage_repair_items RENAME TO damage_repair_items_legacy;');

  // 2. 新表：project_id NOT NULL，其余列/约束/外键与 v1+v3 完全一致。
  db.exec(`
    CREATE TABLE damage_repair_items (
      id TEXT PRIMARY KEY,
      instrument_id TEXT NOT NULL REFERENCES instruments(id),
      damage_reason TEXT,
      issue_status TEXT NOT NULL CHECK (issue_status IN ('untreated','processing','repaired','closed_unrepaired')),
      close_reason TEXT,
      part_number TEXT,
      part_quantity INTEGER,
      part_amount_cents INTEGER,
      part_currency TEXT CHECK (part_currency IN ('USD','RMB')),
      part_requested_at TEXT,
      part_status TEXT CHECK (part_status IN ('pending_submit','processing','arrived','used')),
      repair_note TEXT,
      registered_at TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      account_id TEXT REFERENCES accounts(id),
      username_snapshot TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  db.exec(`
    INSERT INTO damage_repair_items (
      id, instrument_id, damage_reason, issue_status, close_reason,
      part_number, part_quantity, part_amount_cents, part_currency,
      part_requested_at, part_status, repair_note, registered_at,
      project_id, account_id, username_snapshot, created_at, updated_at
    )
    SELECT
      id, instrument_id, damage_reason, issue_status, close_reason,
      part_number, part_quantity, part_amount_cents, part_currency,
      part_requested_at, part_status, repair_note, registered_at,
      project_id, account_id, username_snapshot, created_at, updated_at
    FROM damage_repair_items_legacy;
  `);

  // 3. 重建 activity_damage_links：外键指向新表，保留 UNIQUE 与账号归属列。
  db.exec(`
    CREATE TABLE activity_damage_links_v8 (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES activities(id),
      damage_item_id TEXT NOT NULL REFERENCES damage_repair_items(id),
      account_id TEXT REFERENCES accounts(id),
      username_snapshot TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (activity_id, damage_item_id)
    ) STRICT;
  `);
  db.exec(`
    INSERT INTO activity_damage_links_v8 (id, activity_id, damage_item_id, account_id, username_snapshot, created_at)
    SELECT id, activity_id, damage_item_id, account_id, username_snapshot, created_at
    FROM activity_damage_links;
  `);
  db.exec('DROP TABLE activity_damage_links;');
  db.exec('ALTER TABLE activity_damage_links_v8 RENAME TO activity_damage_links;');

  // 4. 丢弃旧表（此时无子表外键指向它）。
  db.exec('DROP TABLE damage_repair_items_legacy;');
}

/** schema v8 版本号。 */
export const INTEGRITY_MIGRATION_VERSION = 8;
