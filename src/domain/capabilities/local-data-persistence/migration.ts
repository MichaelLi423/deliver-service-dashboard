import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PersistenceError } from '../../core/errors';
import { readSchemaVersion, writeSchemaVersion } from './connection';

/**
 * schema 迁移机制（design D17 / tasks 1.10）。
 *
 * - 以 PRAGMA user_version 管理数据结构升级。
 * - 每次迁移在事务内执行（DDL 在 SQLite 中可回滚）；成功后同事务写入新版本号。
 * - 迁移前执行在线安全备份（VACUUM INTO 同步生成可恢复副本）；
 *   迁移失败时回滚事务、保留原库与迁移前备份文件，并返回明确的恢复信息。
 *
 * 本模块只供主进程 / node 环境（测试）使用；渲染层不导入 local-data-persistence。
 */

export interface Migration {
  /** 迁移目标版本号（> 当前 user_version）。 */
  version: number;
  name: string;
  /** 迁移内容（DDL/DML）。 */
  up: (db: DatabaseSync) => void;
  /**
   * 重建父表迁移（如 v19 重建 projects）：SQLite 的 PRAGMA foreign_keys 与
   * legacy_alter_table 在事务内是 no-op，而重建被其他表外键引用的父表必须
   * 在事务外关闭外键并开启 legacy_alter_table（使 RENAME 不改写子表外键指向）。
   * 置为 true 时运行器在事务前设置 foreign_keys=OFF、legacy_alter_table=ON，
   * 迁移与版本号写入在同一事务内完成，提交/回滚后恢复原始 pragma 值。
   * 其余迁移不设置本字段，行为完全不变。
   */
  disableForeignKeys?: boolean;
}

export interface MigrationRunnerOptions {
  migrations: readonly Migration[];
  /** 迁移前安全备份目录（不存在则自动创建）。 */
  backupDir: string;
  /** 文件名前缀；完整名如 `pre-migration-v2-20260807T120000.db`。 */
  backupNamePrefix?: string;
  now?: () => Date;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: Migration[];
  /** 已创建的迁移前备份文件路径（含失败迁移的备份）。 */
  preMigrationBackups: string[];
}

export interface MigrationFailure {
  error: Error;
  failedVersion: number;
  /** 迁移前原版本号（数据库已回滚到该版本）。 */
  originalVersion: number;
  /** 迁移前安全备份文件路径，用于人工恢复。 */
  preMigrationBackup: string;
}

export class MigrationError extends PersistenceError {
  constructor(readonly failure: MigrationFailure) {
    super(
      'MIGRATION_FAILED',
      `schema 迁移失败（v${failure.failedVersion}）: ${failure.error.message}；` +
        `已保留迁移前数据（版本 ${failure.originalVersion}），` +
        `迁移前安全备份位于: ${failure.preMigrationBackup}`,
    );
    this.name = 'MigrationError';
  }
}

const stamp = (date: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/** 读取布尔型 PRAGMA 当前值（foreign_keys / legacy_alter_table 等，返回 0 或 1）。 */
function readPragma(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return row[name];
}

/**
 * 执行待应用迁移。
 * 失败时整体回滚本次迁移事务、保持原库，并抛出 MigrationError（携带恢复信息）。
 */
export function runMigrations(db: DatabaseSync, options: MigrationRunnerOptions): MigrationResult {
  const now = options.now ?? (() => new Date());
  const fromVersion = readSchemaVersion(db);
  const pending = options.migrations
    .filter((m) => m.version > fromVersion)
    .slice()
    .sort((a, b) => a.version - b.version);

  const applied: Migration[] = [];
  const preMigrationBackups: string[] = [];

  for (const migration of pending) {
    if (!existsSync(options.backupDir)) {
      mkdirSync(options.backupDir, { recursive: true });
    }
    const backupFile = join(
      options.backupDir,
      `${options.backupNamePrefix ?? 'pre-migration'}-v${migration.version}-${stamp(
        now(),
      )}-${randomUUID().slice(0, 4)}.db`,
    );

    // 迁移前在线安全备份（VACUUM INTO 同步生成可恢复副本），失败即中止且不触碰原库。
    try {
      db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
    } catch (err) {
      throw new PersistenceError(
        'MIGRATION_PRE_BACKUP_FAILED',
        `迁移 v${migration.version} 前安全备份失败: ${(err as Error).message}`,
      );
    }
    preMigrationBackups.push(backupFile);

    // 重建父表迁移需在事务外切换 pragma（事务内为 no-op）；记录原始值以便恢复。
    const fkOff = migration.disableForeignKeys === true;
    const savedPragmas = fkOff
      ? {
          foreignKeys: readPragma(db, 'foreign_keys'),
          legacyAlterTable: readPragma(db, 'legacy_alter_table'),
        }
      : null;
    if (fkOff) {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('PRAGMA legacy_alter_table = ON;');
    }

    // 迁移在事务内执行；失败整体回滚，保留原库与迁移前备份。
    try {
      db.exec('BEGIN');
      migration.up(db);
      writeSchemaVersion(db, migration.version);
      db.exec('COMMIT');
      applied.push(migration);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败时原库仍未被修改；继续抛出主错误。
      }
      const failure: MigrationFailure = {
        error: err instanceof Error ? err : new Error(String(err)),
        failedVersion: migration.version,
        originalVersion: fromVersion,
        preMigrationBackup: backupFile,
      };
      throw new MigrationError(failure);
    } finally {
      if (fkOff && savedPragmas) {
        db.exec(`PRAGMA foreign_keys = ${savedPragmas.foreignKeys};`);
        db.exec(`PRAGMA legacy_alter_table = ${savedPragmas.legacyAlterTable};`);
      }
    }
  }

  return {
    fromVersion,
    toVersion: readSchemaVersion(db),
    applied,
    preMigrationBackups,
  };
}
