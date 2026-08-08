import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v6（tasks 8.x）：migration_audit 补充 source_hash 列。
 *
 * 依据 design D11 与 tasks 8.7「以（源文件、sheet、行号）+ 业务键为幂等键，
 * 成功批次同源重跑不重复写入；已提交错误数据仅通过修正后重跑（forward-fix）
 * 纠正」：source_hash 保存该批/该行源内容摘要，用于区分「同源未变（幂等跳过）」
 * 与「源已修正（forward-fix 重跑）」，不依赖反向回滚。
 *
 * 全部新增列可空（历史审计记录无摘要），不破坏 v1~v5 既有约束与数据。
 */
export function applyMigrationAuditSourceHashMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE migration_audit ADD COLUMN source_hash TEXT;
  `);
}

/** schema v6 版本号。 */
export const MIGRATION_AUDIT_SOURCE_HASH_MIGRATION_VERSION = 6;
