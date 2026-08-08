import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository, MAX_CHECKPOINTS_PER_DRAFT } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { RevisionConflictError } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-errors';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 磁盘型 undo checkpoint（tasks 8.59/8.66）工作区仓储测试。
 *
 * - createCheckpoint 原子保存 rows/cells/sources/mappings/conflict_decisions/issues
 *   + category modes + base revision（renderer 不保存全量）；
 * - undo/redo 成对 pre/post；恢复以 expected revision 并发保护、产生新 revision、
 *   invalidate seal、不能倒退 revision；
 * - 有界保留；成功/取消/删除草稿清理 checkpoint 敏感值。
 */

function openRepo(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
}

function draftWithRows(
  repo: WorkspaceRepository,
  rows: Array<{ rowId: string; category: 'project' | 'service_order'; cells?: Record<string, string | null> }>,
): { id: string; rev: number } {
  const d = repo.createDraft({ name: 'checkpoint 草稿', createdBy: null, createdByUsername: null });
  let rev = 1;
  rev = repo.transitionState(d.id, rev, 'start_parsing');
  for (const row of rows) {
    rev = repo.appendRows(d.id, rev, row.category, [{ rowId: row.rowId, cells: row.cells }]);
  }
  rev = repo.transitionState(d.id, rev, 'parsing_finished');
  return { id: d.id, rev };
}

describe('8.59 checkpoint 原子快照与 undo/redo', () => {
  it('redo 严格按撤销时间序：A/B → undo B → undo A → redo A → redo B（Oracle 二次复审 #3）', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r0', category: 'project', cells: { 'contract.ecc': 'E-0' } }]);
      // 编辑 A：加 r1；编辑 B：加 r2。
      const pairA = 'pair-A';
      const pairB = 'pair-B';
      repo.createCheckpoint(id, rev, { kind: 'pre', pairId: pairA, label: 'A' });
      let current = repo.appendRows(id, repo.getDraft(id)!.revision, 'project', [{ rowId: 'r1', cells: { 'contract.ecc': 'E-1' } }]);
      repo.createCheckpoint(id, current, { kind: 'post', pairId: pairA, label: 'A' });
      repo.createCheckpoint(id, repo.getDraft(id)!.revision, { kind: 'pre', pairId: pairB, label: 'B' });
      current = repo.appendRows(id, repo.getDraft(id)!.revision, 'project', [{ rowId: 'r2', cells: { 'contract.ecc': 'E-2' } }]);
      repo.createCheckpoint(id, current, { kind: 'post', pairId: pairB, label: 'B' });
      const eccs = () => repo.queryRows(id, { offset: 0, limit: 10 }).rows.map((r) => r.cells['contract.ecc']).sort();

      expect(eccs()).toEqual(['E-0', 'E-1', 'E-2']);
      repo.undo(id, repo.getDraft(id)!.revision); // undo B → 移除 E-2
      expect(eccs()).toEqual(['E-0', 'E-1']);
      repo.undo(id, repo.getDraft(id)!.revision); // undo A → 移除 E-1
      expect(eccs()).toEqual(['E-0']);
      // redo 按撤销时间序：先 A 后 B。
      repo.redo(id, repo.getDraft(id)!.revision); // redo A
      expect(eccs()).toEqual(['E-0', 'E-1']);
      repo.redo(id, repo.getDraft(id)!.revision); // redo B
      expect(eccs()).toEqual(['E-0', 'E-1', 'E-2']);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('createCheckpoint 原子保存 rows/cells/sources/mappings/decisions/issues/modes；undo 整体恢复', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [
        { rowId: 'r1', category: 'project', cells: { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' } },
      ]);
      repo.addSource(id, { sourceKind: 'file', sourceFile: '合同信息表.xlsx', sheet: '合同信息', sourceHash: 'h', rowCount: 1 });
      repo.saveMappings(id, rev, [{ category: 'project', sourceColumn: 'ECC#', targetField: 'contract.ecc', mappingState: 'exact' }]);
      repo.replaceIssues(id, rev + 1, [{ severity: 'error', issueCode: 'X', rowId: 'r1', field: 'contract.ecc', message: 'm' }]);
      repo.saveConflictDecision(id, rev + 2, { rowId: 'r1', field: 'contract.customer_name', decisionType: 'fix_value', chosenValue: '乙' });

      // 建立 checkpoint（含类别模式）。
      const checkpoint = repo.createCheckpoint(id, repo.getDraft(id)!.revision, { kind: 'manual', label: '编辑前', modes: { project: 'data', service_order: 'none' } });
      const before = repo.getDraft(id)!.revision;

      // 修改可变状态：加行、删行、改单元格、加来源、清映射/问题。
      let current = repo.getDraft(id)!.revision;
      current = repo.appendRows(id, current, 'project', [{ rowId: 'r2', cells: { 'contract.ecc': 'E-2' } }]);
      current = repo.deleteRows(id, current, ['r1']);
      repo.addSource(id, { sourceKind: 'paste', sourceFile: '粘贴' });
      current = repo.replaceIssues(id, current, []);
      expect(repo.getDraft(id)!.revision).toBeGreaterThan(before);

      // undo：整体恢复到 checkpoint 状态（行/来源/映射/决定/问题/模式）。
      const restored = repo.restoreCheckpoint(id, repo.getDraft(id)!.revision, checkpoint.id);
      expect(restored).not.toBeNull();
      expect(restored!.modes).toMatchObject({ project: 'data', service_order: 'none' });
      expect(restored!.newRevision).toBeGreaterThan(before);
      const window = repo.queryRows(id, { offset: 0, limit: 100 });
      expect(window.total).toBe(1);
      expect(window.rows[0].rowId).toBe('r1');
      expect(window.rows[0].cells['contract.customer_name']).toBe('甲');
      expect(repo.listSources(id)).toHaveLength(1);
      expect(repo.listMappings(id)).toHaveLength(1);
      expect(repo.listConflictDecisions(id)).toHaveLength(1);
      expect(repo.listIssues(id)).toHaveLength(1);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('undo/redo 成对 pre/post checkpoint：编辑前/后整体往返', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { 'contract.ecc': 'E-1' } }]);
      const pairId = 'pair-1';
      repo.createCheckpoint(id, rev, { kind: 'pre', pairId, label: '删除行', modes: { project: 'data' } });
      let current = repo.deleteRows(id, repo.getDraft(id)!.revision, ['r1']);
      repo.createCheckpoint(id, current, { kind: 'post', pairId, label: '删除行', modes: { project: 'data' } });
      expect(repo.queryRows(id, { offset: 0, limit: 10 }).total).toBe(0);

      // undo → 恢复 pre（行回来了）。
      const undoResult = repo.undo(id, repo.getDraft(id)!.revision)!;
      expect(repo.queryRows(id, { offset: 0, limit: 10 }).total).toBe(1);
      expect(repo.queryRows(id, { offset: 0, limit: 10 }).rows[0].cells['contract.ecc']).toBe('E-1');
      expect(undoResult.kind).toBe('pre');

      // redo → 恢复 post（行删除回来）。
      const redoResult = repo.redo(id, repo.getDraft(id)!.revision)!;
      expect(redoResult.kind).toBe('post');
      expect(repo.queryRows(id, { offset: 0, limit: 10 }).total).toBe(0);

      // undo/redo 摘要可列出（不含敏感快照值）。
      const list = repo.listCheckpoints(id);
      expect(list.length).toBe(2);
      expect(list[0]).toMatchObject({ kind: 'pre', pairId, label: '删除行' });
      expect(JSON.stringify(list)).not.toContain('E-1');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('恢复以 expected revision 并发保护；RevisionConflictError 不覆盖较新草稿', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { 'contract.ecc': 'E-1' } }]);
      repo.createCheckpoint(id, rev, { kind: 'pre', pairId: 'p', label: '编辑' });
      let current = repo.deleteRows(id, repo.getDraft(id)!.revision, ['r1']);
      repo.createCheckpoint(id, current, { kind: 'post', pairId: 'p', label: '编辑' });
      // 并发修改推进修订。
      current = repo.appendRows(id, repo.getDraft(id)!.revision, 'project', [{ rowId: 'r-new', cells: {} }]);
      // 用陈旧修订恢复 → 拒绝。
      expect(() => repo.undo(id, current - 1)).toThrow(RevisionConflictError);
      // 较新状态未被覆盖。
      expect(repo.queryRows(id, { offset: 0, limit: 10 }).total).toBe(1);
      expect(repo.queryRows(id, { offset: 0, limit: 10 }).rows[0].rowId).toBe('r-new');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('revision 单调递增：undo/redo 不会倒退修订号', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { 'contract.ecc': 'E-1' } }]);
      repo.createCheckpoint(id, rev, { kind: 'pre', pairId: 'p', label: '编辑' });
      const postRev = repo.deleteRows(id, repo.getDraft(id)!.revision, ['r1']);
      repo.createCheckpoint(id, postRev, { kind: 'post', pairId: 'p', label: '编辑' });
      const undoRev = repo.undo(id, repo.getDraft(id)!.revision)!.newRevision;
      const redoRev = repo.redo(id, repo.getDraft(id)!.revision)!.newRevision;
      expect(undoRev).toBeGreaterThan(rev);
      expect(redoRev).toBeGreaterThan(undoRev);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('恢复已封存草稿使 seal 失效并回到 needs_review（需重新完整校验）', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { 'contract.ecc': 'E-1' } }]);
      const revV = repo.transitionState(id, rev, 'start_validating');
      repo.saveSeal(id, revV, { planDigest: 'pd', mappingVersion: '1' });
      expect(repo.getDraft(id)!.state).toBe('sealed');
      repo.createCheckpoint(id, repo.getDraft(id)!.revision, { kind: 'manual', label: '封存后编辑前' });
      let current = repo.appendRows(id, repo.getDraft(id)!.revision, 'project', [{ rowId: 'r2', cells: {} }]);
      repo.undo(id, current);
      expect(repo.getDraft(id)!.state).toBe('needs_review');
      expect(repo.getSeal(id)?.status).toBe('invalid');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('8.59 有界保留与敏感值清理', () => {
  it('每草稿最多保留 MAX_CHECKPOINTS_PER_DRAFT 份，超出清理最旧', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: {} }]);
      let current = rev;
      for (let i = 0; i < MAX_CHECKPOINTS_PER_DRAFT + 5; i++) {
        repo.createCheckpoint(id, current, { kind: 'manual', label: `c${i}` });
        current = repo.appendRows(id, repo.getDraft(id)!.revision, 'project', [{ rowId: `r-${i}`, cells: {} }]);
      }
      expect(repo.checkpointCount(id)).toBeLessThanOrEqual(MAX_CHECKPOINTS_PER_DRAFT);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('成功 settleCommit / cancelDraft / deleteDraft 清除 checkpoint 敏感快照', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { 'contract.ecc': 'E-1' } }]);
      repo.createCheckpoint(id, rev, { kind: 'pre', pairId: 'p', label: '编辑' });
      const post = repo.appendRows(id, repo.getDraft(id)!.revision, 'project', [{ rowId: 'r2', cells: {} }]);
      repo.createCheckpoint(id, post, { kind: 'post', pairId: 'p', label: '编辑' });
      expect(repo.checkpointCount(id)).toBe(2);
      // 取消：清除 checkpoint。
      const c2 = repo.createDraft({ name: '取消草稿', createdBy: null, createdByUsername: null });
      let c2rev = repo.transitionState(c2.id, 1, 'start_parsing');
      c2rev = repo.transitionState(c2.id, c2rev, 'parsing_finished');
      repo.createCheckpoint(c2.id, c2rev, { kind: 'manual', label: 'x' });
      repo.cancelDraft(c2.id, repo.getDraft(c2.id)!.revision);
      expect(repo.checkpointCount(c2.id)).toBe(0);
      // 成功：清除 checkpoint（先走 validating 生成 seal 后 settle）。
      const revV = repo.transitionState(id, repo.getDraft(id)!.revision, 'start_validating');
      repo.saveSeal(id, revV, { planDigest: 'pd' });
      repo.transitionState(id, repo.getDraft(id)!.revision, 'start_committing');
      repo.settleCommit(id, true);
      expect(repo.checkpointCount(id)).toBe(0);
      // 删除草稿：级联清除。
      repo.deleteDraft(id);
      expect(repo.checkpointCount(id)).toBe(0);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('consumeCheckpoint 删除指定 checkpoint；clearCheckpoints 全清', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: {} }]);
      const a = repo.createCheckpoint(id, rev, { kind: 'manual', label: 'a' });
      const b = repo.createCheckpoint(id, repo.getDraft(id)!.revision, { kind: 'manual', label: 'b' });
      repo.consumeCheckpoint(id, a.id);
      expect(repo.listCheckpoints(id).map((c) => c.id)).toEqual([b.id]);
      repo.clearCheckpoints(id);
      expect(repo.checkpointCount(id)).toBe(0);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
