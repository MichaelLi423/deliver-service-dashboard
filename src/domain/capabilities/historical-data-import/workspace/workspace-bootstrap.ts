import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../local-data-persistence/connection';
import { MigrationError, runMigrations, type Migration } from '../../local-data-persistence/migration';
import {
  WorkspaceCorruptionError,
  WorkspaceError,
  WorkspaceMigrationError,
  WorkspaceVersionError,
} from './workspace-errors';
import {
  applyWorkspaceInitialSchema,
  applyWorkspaceSealBindingMigration,
  applyWorkspaceCheckpointMigration,
  applyWorkspaceModesMigration,
  applyWorkspaceExcludedAndRedoMigration,
  applyWorkspaceSheetIdentityMigration,
  WORKSPACE_SCHEMA_VERSION,
} from './workspace-schema';

/**
 * 导入工作区 bootstrap、版本迁移与连接生命周期（design D20 / tasks 8.10）。
 *
 * - 独立 app-private 数据库文件 {workspaceDir}/import-workspace.db，与正式业务库
 *   （{dataDir}/workbench.db）物理隔离。
 * - 连接生命周期：打开 → 完整性校验（integrity_check）→ 版本兼容检查 →
 *   按 PRAGMA user_version 执行迁移（迁移失败保留原库与迁移前备份）。
 * - 错误边界：工作区损坏/版本不兼容/迁移失败均以 WorkspaceError 子类表达，
 *   只禁用导入功能，绝不打开正式业务库写通道。
 */

export const WORKSPACE_DB_FILENAME = 'import-workspace.db';

export const WORKSPACE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'workspace-initial-schema',
    up: (db) => applyWorkspaceInitialSchema(db),
  },
  {
    version: 2,
    name: 'workspace-seal-binding',
    up: (db) => applyWorkspaceSealBindingMigration(db),
  },
  {
    version: 3,
    name: 'workspace-undo-checkpoints',
    up: (db) => applyWorkspaceCheckpointMigration(db),
  },
  {
    version: 4,
    name: 'workspace-modes-and-sheet-classifications',
    up: (db) => applyWorkspaceModesMigration(db),
  },
  {
    version: 5,
    name: 'workspace-excluded-rows-and-redo-order',
    up: (db) => applyWorkspaceExcludedAndRedoMigration(db),
  },
  {
    version: 6,
    name: 'workspace-sheet-identity',
    up: (db) => applyWorkspaceSheetIdentityMigration(db),
  },
];

export interface WorkspaceBootstrapOptions {
  /** 工作区目录（应用私有；建议 userData/import-workspace）。 */
  workspaceDir: string;
  now?: () => Date;
}

export interface WorkspaceBootstrapResult {
  db: DatabaseSync;
  dbPath: string;
  schemaVersion: number;
  migrated: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 打开工作区数据库并完成完整性校验与迁移。
 * 任一失败抛 WorkspaceError 子类（损坏/版本不兼容/迁移失败），
 * 调用方捕获后仅禁用历史数据导入入口。
 */
export function bootstrapWorkspaceDatabase(options: WorkspaceBootstrapOptions): WorkspaceBootstrapResult {
  const dbPath = join(options.workspaceDir, WORKSPACE_DB_FILENAME);
  let db: DatabaseSync;
  try {
    db = openDatabase({ path: dbPath, ensureDirectory: true });
  } catch (err) {
    throw new WorkspaceCorruptionError(
      `无法打开导入工作区数据库（导入功能禁用，正式业务库不受影响）: ${errorMessage(err)}`,
    );
  }
  try {
    // Oracle 复审 #4：敏感草稿/checkpoint 数据落盘即擦除（secure_delete=ON）。
    try {
      db.exec('PRAGMA secure_delete = ON;');
    } catch {
      // secure_delete 不可用时忽略（不影响功能）
    }
    assertWorkspaceIntegrity(db);
    const fromVersion = readSchemaVersion(db);
    if (fromVersion > WORKSPACE_SCHEMA_VERSION) {
      throw new WorkspaceVersionError(
        `导入工作区 schema v${fromVersion} 高于当前支持的 v${WORKSPACE_SCHEMA_VERSION}：版本不兼容，` +
          `工作区禁用，正式业务库不受影响；请升级应用后再继续导入`,
      );
    }
    const backupDir = join(options.workspaceDir, 'workspace-migration-backups');
    const result = runMigrations(db, {
      migrations: WORKSPACE_MIGRATIONS,
      backupDir,
      now: options.now,
      backupNamePrefix: 'workspace-pre-migration',
    });
    return { db, dbPath, schemaVersion: result.toVersion, migrated: result.applied.length > 0 };
  } catch (err) {
    closeDatabase(db);
    if (err instanceof WorkspaceError) throw err;
    if (err instanceof MigrationError) {
      throw new WorkspaceMigrationError(
        `导入工作区 schema 迁移失败（原库与迁移前备份已保留，正式业务库不受影响）: ${err.message}`,
      );
    }
    throw new WorkspaceError(
      'WORKSPACE_BOOTSTRAP_FAILED',
      `导入工作区初始化失败（导入功能禁用，正式业务库不受影响）: ${errorMessage(err)}`,
    );
  }
}

/** 完整性校验：损坏或不可读时抛 WorkspaceCorruptionError。 */
function assertWorkspaceIntegrity(db: DatabaseSync): void {
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (row.integrity_check !== 'ok') {
      throw new WorkspaceCorruptionError(
        `导入工作区数据库完整性校验失败（${row.integrity_check}）：导入功能禁用，正式业务库不受影响`,
      );
    }
  } catch (err) {
    if (err instanceof WorkspaceCorruptionError) throw err;
    throw new WorkspaceCorruptionError(
      `导入工作区数据库损坏或不可读（导入功能禁用，正式业务库不受影响）: ${errorMessage(err)}`,
    );
  }
}

/** 关闭工作区连接。 */
export function closeWorkspaceDatabase(db: DatabaseSync): void {
  closeDatabase(db);
}
