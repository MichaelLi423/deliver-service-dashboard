import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v9（Oracle 高风险 4 复审：forward-fix 不覆盖迁移后人工修改）。
 *
 * 首次导入为每个被迁移目标记录保存「目标业务字段快照摘要」（target_snapshot_hash）；
 * forward-fix 前比较当前目标业务字段 hash 与上次迁移后记录的 hash：
 * - 一致 → 目标自上次迁移未被改动，允许按新源更新并刷新 hash；
 * - 不一致 → 目标被人工/外部修改，视为非迁移改动 → 阻塞，不覆盖（保留数据）；
 * - 人工记录（无 import_source_key）永不触碰（由各 writer 的 source-key 条件保证）。
 *
 * 以 import_record_audit 表记录（一条迁移记录一条），含：
 * - source_key（幂等/forward-fix 键，与各目标表 import_source_key 对应）；
 * - target_table + target_id（定位被迁移目标行）；
 * - import_source_hash（源内容摘要）与 target_snapshot_hash（目标业务字段摘要）；
 * - imported_at（审计时间，独立于源业务时间）。
 *
 * 索引：source_key 唯一（forward-fix 查找 O(log n)），target_table+target_id 唯一。
 * 该表只增不改历史（审计）；forward-fix 更新时 UPDATE 同一行 hash。
 */
export function applyImportRecordAuditMigration(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_record_audit (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      target_table TEXT NOT NULL,
      target_id TEXT NOT NULL,
      import_source_hash TEXT NOT NULL,
      target_snapshot_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE (target_table, target_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_import_record_audit_target
      ON import_record_audit(target_table, target_id);
  `);
}

/** schema v9 版本号。 */
export const IMPORT_RECORD_AUDIT_MIGRATION_VERSION = 9;
