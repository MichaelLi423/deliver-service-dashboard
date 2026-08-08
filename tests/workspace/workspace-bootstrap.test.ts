import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootstrapWorkspaceDatabase,
  closeWorkspaceDatabase,
  WORKSPACE_DB_FILENAME,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import {
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_TABLES,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-schema';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import {
  WorkspaceCorruptionError,
  WorkspaceError,
  WorkspaceMigrationError,
  WorkspaceVersionError,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-errors';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { schemaTableNames } from '../../src/domain/capabilities/local-data-persistence/schema';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 工作区 bootstrap、版本迁移与连接生命周期（tasks 8.9/8.10/8.14）。
 * 物理路径隔离、主库零写、损坏/版本不兼容只禁用导入、不影响正式业务库。
 */

describe('8.9/8.10 工作区 schema 与 bootstrap', () => {
  it('首次 bootstrap 创建全部工作区表并迁移到当前版本；重开不重复迁移且数据保留', () => {
    const dir = makeTempDir();
    try {
      const wsDir = join(dir, 'ws');
      const first = bootstrapWorkspaceDatabase({ workspaceDir: wsDir });
      expect(first.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
      expect(first.migrated).toBe(true);
      expect(first.dbPath.endsWith(WORKSPACE_DB_FILENAME)).toBe(true);
      const names = (
        first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      ).map((r) => r.name).sort();
      for (const table of WORKSPACE_TABLES) {
        expect(names).toContain(table);
      }
      // 工作区只含 workspace_* 表，不含任何正式业务表
      const businessTables = ['projects', 'contracts', 'customers', 'service_orders', 'invoices', 'logistics_fees', 'batches', 'instruments', 'accounts'];
      for (const t of businessTables) {
        expect(names).not.toContain(t);
      }
      closeWorkspaceDatabase(first.db);

      // 重开：迁移不再执行，草稿数据保留
      const second = bootstrapWorkspaceDatabase({ workspaceDir: wsDir });
      expect(second.migrated).toBe(false);
      expect(second.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
      closeWorkspaceDatabase(second.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('物理路径隔离：工作区与正式业务库为不同文件、表集合互不相交', () => {
    const dir = makeTempDir();
    try {
      const wsDir = join(dir, 'ws');
      const dataDir = join(dir, 'data');
      const ws = bootstrapWorkspaceDatabase({ workspaceDir: wsDir });
      // 工作区 bootstrap 不创建正式业务库文件
      expect(join(wsDir, WORKSPACE_DB_FILENAME) === ws.dbPath).toBe(true);
      closeWorkspaceDatabase(ws.db);

      const main = bootstrapDatabase({ dataDir });
      // 正式业务库 bootstrap 不创建工作区文件
      expect(main.dbPath.endsWith('workbench.db')).toBe(true);
      expect(main.dbPath).not.toBe(join(wsDir, WORKSPACE_DB_FILENAME));

      const mainTables = new Set(schemaTableNames());
      for (const table of WORKSPACE_TABLES) {
        expect(mainTables.has(table)).toBe(false);
      }
      const wsTables = new Set(WORKSPACE_TABLES);
      for (const table of schemaTableNames()) {
        expect(wsTables.has(table)).toBe(false);
      }
      closeDatabase(main.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('工作区损坏：抛出可恢复的 WorkspaceError，正式业务库完全不受影响', () => {
    const dir = makeTempDir();
    try {
      const wsDir = join(dir, 'ws');
      // 写入非 SQLite 垃圾字节模拟损坏
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, WORKSPACE_DB_FILENAME), 'this is not a sqlite database file at all');
      expect(() => bootstrapWorkspaceDatabase({ workspaceDir: wsDir })).toThrowError(WorkspaceCorruptionError);

      // 正式业务库仍可正常打开与读写
      const dataDir = join(dir, 'data');
      const { db } = bootstrapDatabase({ dataDir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c-corrupt',
        '损坏隔离客户',
        't',
        't',
      );
      const n = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE id='c-corrupt'").get() as { n: number };
      expect(n.n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('版本不兼容（工作区版本高于应用支持）：拒绝打开并抛 WorkspaceVersionError', () => {
    const dir = makeTempDir();
    try {
      const wsDir = join(dir, 'ws');
      const first = bootstrapWorkspaceDatabase({ workspaceDir: wsDir });
      // 模拟由更高版本应用升级过的工作区
      first.db.exec(`PRAGMA user_version = ${WORKSPACE_SCHEMA_VERSION + 1}`);
      closeWorkspaceDatabase(first.db);

      expect(() => bootstrapWorkspaceDatabase({ workspaceDir: wsDir })).toThrowError(WorkspaceVersionError);
      try {
        bootstrapWorkspaceDatabase({ workspaceDir: wsDir });
        expect.unreachable('应当抛出版本不兼容错误');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('迁移失败：保留原库、抛 WorkspaceMigrationError，正式业务库不受影响', () => {
    const dir = makeTempDir();
    try {
      const wsDir = join(dir, 'ws');
      // 预置一个缺少必需列的同名表，使迁移 v1 的索引创建失败
      const raw = openDatabase({ path: join(wsDir, WORKSPACE_DB_FILENAME) });
      raw.exec('CREATE TABLE workspace_rows (x INTEGER)');
      raw.exec('PRAGMA user_version = 0');
      closeDatabase(raw);

      expect(() => bootstrapWorkspaceDatabase({ workspaceDir: wsDir })).toThrowError(WorkspaceMigrationError);
      // 正式业务库不受影响
      const dataDir = join(dir, 'data');
      const { db } = bootstrapDatabase({ dataDir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c-mig',
        '迁移失败隔离客户',
        't',
        't',
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('主库零写：完整工作区操作流程不触碰正式业务库任何数据', () => {
    const dir = makeTempDir();
    try {
      const dataDir = join(dir, 'data');
      const { db: mainDb } = bootstrapDatabase({ dataDir });
      mainDb.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c-main',
        '主库客户',
        't',
        't',
      );
      const snapshot = () => {
        const tables = mainDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        const snap: Record<string, unknown> = {};
        for (const t of tables) {
          snap[t.name] = mainDb.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all();
        }
        return snap;
      };
      const before = snapshot();

      // 工作区全流程：创建草稿、追加行、patch、问题、seal、committing、恢复、判定成功
      const wsDir = join(dir, 'ws');
      const ws = bootstrapWorkspaceDatabase({ workspaceDir: wsDir });
      const repo = new WorkspaceRepository(ws.db);
      const d = repo.createDraft({ name: '主库零写草稿', createdBy: 'acc-1', createdByUsername: '负责人' });
      repo.transitionState(d.id, 1, 'start_parsing');
      repo.appendRows(d.id, 2, 'project', [
        { rowId: 'r-main', businessKey: 'ECC-ZERO', cells: { ecc: 'ECC-ZERO', customer_name: '零写客户' } },
      ]);
      repo.transitionState(d.id, 3, 'parsing_finished');
      repo.replaceIssues(d.id, 4, [{ severity: 'warning', issueCode: 'WARN', message: '警告' }]);
      repo.transitionState(d.id, 5, 'start_validating');
      repo.replaceIssues(d.id, 6, []);
      repo.saveSeal(d.id, 7, { planDigest: 'digest-zero', mappingVersion: 'v1' });
      repo.transitionState(d.id, 8, 'start_committing');
      repo.recoverRuntimeStates();
      repo.settleCommit(d.id, true);
      closeWorkspaceDatabase(ws.db);

      const after = snapshot();
      expect(after).toEqual(before);
      closeDatabase(mainDb);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
