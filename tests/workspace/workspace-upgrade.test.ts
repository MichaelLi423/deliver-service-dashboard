import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceRepository, encodeSheetId, decodeSheetId } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { WORKSPACE_MIGRATIONS } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { openDatabase, closeDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Oracle 最终复核 #3：既有（v4/v5）undo checkpoint 升级时确定性回填 undo_seq，
 * 且非全新库（升级路径）redo 严格按实际撤销顺序。
 */

describe('workspace 升级迁移：v4 → v5 回填 undo_seq（非新库）', () => {
  it('v4 库中的 undone checkpoint 升级后确定性回填 undo_seq（按 base_revision 顺序），redo 可恢复', () => {
    const dir = makeTempDir();
    const wsDir = join(dir, 'ws');
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, 'import-workspace.db');
    const backupDir = join(dir, 'mb');
    try {
      // 1) 建 v4 库（只应用迁移 1-4）。
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: WORKSPACE_MIGRATIONS.slice(0, 4), backupDir });
      expect(readSchemaVersion(db)).toBe(4);
      const snapshot = JSON.stringify({ baseRevision: 1, modes: {}, rows: [], sources: [], mappings: [], conflictDecisions: [], issues: [], sheetClassifications: [] });
      db.prepare(
        `INSERT INTO workspace_drafts (id, name, state, revision, created_by, created_by_username, created_at, updated_at, last_saved_at, pending_outcome, row_count_summary)
         VALUES ('d1','升级草稿','needs_review',5,NULL,NULL,'t','t','t',0,'{}')`,
      ).run();
      // 两个 undone 成对 checkpoint（v4 无 undo_seq 列）：编辑 A（较早）、编辑 B（较晚）。
      db.prepare(
        `INSERT INTO workspace_checkpoints (id, draft_id, base_revision, kind, pair_id, label, snapshot, state, created_at)
         VALUES ('a-pre','d1',2,'pre','pairA','A',?, 'undone','t')`,
      ).run(snapshot);
      db.prepare(
        `INSERT INTO workspace_checkpoints (id, draft_id, base_revision, kind, pair_id, label, snapshot, state, created_at)
         VALUES ('a-post','d1',3,'post','pairA','A',?, 'undone','t')`,
      ).run(snapshot);
      db.prepare(
        `INSERT INTO workspace_checkpoints (id, draft_id, base_revision, kind, pair_id, label, snapshot, state, created_at)
         VALUES ('b-pre','d1',4,'pre','pairB','B',?, 'undone','t')`,
      ).run(snapshot);
      db.prepare(
        `INSERT INTO workspace_checkpoints (id, draft_id, base_revision, kind, pair_id, label, snapshot, state, created_at)
         VALUES ('b-post','d1',5,'post','pairB','B',?, 'undone','t')`,
      ).run(snapshot);

      // 2) 升级到最新（v5 回填 undo_seq、v6 sheet identity）。
      runMigrations(db, { migrations: WORKSPACE_MIGRATIONS, backupDir });
      expect(readSchemaVersion(db)).toBeGreaterThanOrEqual(6);

      // 3) undo_seq 确定性回填（按 base_revision 升序对全部 undone 行计数；pre 行 a-pre=1、b-pre=3）。
      const seqA = (db.prepare("SELECT undo_seq FROM workspace_checkpoints WHERE id='a-pre'").get() as { undo_seq: number | null }).undo_seq;
      const seqB = (db.prepare("SELECT undo_seq FROM workspace_checkpoints WHERE id='b-pre'").get() as { undo_seq: number | null }).undo_seq;
      expect(seqA).toBe(1);
      expect(seqB).toBe(3);
      // 确定性：同一库重跑回填结果一致（迁移只跑一次；此处验证 redo 顺序由回填序号决定）。
      expect(db.prepare("SELECT COUNT(*) AS n FROM workspace_checkpoints WHERE undo_seq IS NULL").get()).toMatchObject({ n: 0 });

      // 4) redo 严格按回填撤销顺序：先 B（较高 base_revision）后 A。
      const repo = new WorkspaceRepository(db);
      const firstRedo = repo.redo('d1', 5);
      expect(firstRedo?.checkpointId).toBe('b-post');
      const secondRedo = repo.redo('d1', 6);
      expect(secondRedo?.checkpointId).toBe('a-post');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('sheet 来源身份安全化：文件名含 # 时 encode/decode 往返无歧义（Oracle 最终复核 #1）', () => {
    expect(decodeSheetId(encodeSheetId('we#ird.xlsx', 'S1'))).toEqual(['we#ird.xlsx', 'S1']);
    expect(decodeSheetId(encodeSheetId('正常.xlsx', '工作表 1'))).toEqual(['正常.xlsx', '工作表 1']);
    expect(encodeSheetId('a#b#c.xlsx', 'S#1')).toContain('%23');
    expect(decodeSheetId('a%23b%23c.xlsx#S%231')).toEqual(['a#b#c.xlsx', 'S#1']);
  });
});
