import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { FixedClock } from '../../src/domain/core/time';
import { WorkspaceStateError } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-errors';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 敏感草稿清理与异常遗留草稿策略（design D20 / tasks 8.13/8.14）。
 * 成功/取消清除敏感行保留摘要、用户删除整体清除、遗留草稿可见保留/清理，
 * 清理绝不触碰正式业务记录（主库零写由 workspace-bootstrap.test.ts 覆盖）。
 */

function openRepo(dir: string, clock?: FixedClock): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db, clock), close: () => closeWorkspaceDatabase(ws.db) };
}

function fullFlowDraft(repo: WorkspaceRepository): { id: string } {
  const d = repo.createDraft({ name: '全流程草稿', createdBy: 'acc-1', createdByUsername: '负责人' });
  let rev = repo.transitionState(d.id, 1, 'start_parsing');
  rev = repo.appendRows(d.id, rev, 'project', [
    { rowId: 'r1', businessKey: 'ECC-001', cells: { ecc: 'ECC-001', customer_name: '客户甲' } },
  ]);
  rev = repo.appendRows(d.id, rev, 'invoice', [{ rowId: 'r2', businessKey: 'ECC-001', cells: { amount: '10000' } }]);
  rev = repo.transitionState(d.id, rev, 'parsing_finished');
  rev = repo.replaceIssues(d.id, rev, [{ severity: 'warning', issueCode: 'WARN', message: '提示' }]);
  rev = repo.transitionState(d.id, rev, 'start_validating');
  rev = repo.replaceIssues(d.id, rev, []);
  rev = repo.saveSeal(d.id, rev, { planDigest: 'pd', mappingVersion: 'v1' });
  rev = repo.transitionState(d.id, rev, 'start_committing');
  repo.addSource(d.id, { sourceKind: 'file', sourceFile: '合同信息表.xlsx', rowCount: 1 });
  return { id: d.id };
}

describe('成功/取消清理敏感数据（tasks 8.13）', () => {
  it('提交成功：清除规范化行/单元格/问题，保留草稿摘要、来源元数据与 seal', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id } = fullFlowDraft(repo);
      repo.settleCommit(id, true);

      const after = repo.getDraft(id)!;
      expect(after.state).toBe('succeeded');
      // 敏感行已清除
      expect(repo.queryRows(id, { category: 'project', offset: 0, limit: 100 }).total).toBe(0);
      expect(repo.queryRows(id, { category: 'invoice', offset: 0, limit: 100 }).total).toBe(0);
      expect(repo.listIssues(id)).toHaveLength(0);
      // 摘要保留：各类别计数
      expect(after.rowCounts.project).toBe(1);
      expect(after.rowCounts.invoice).toBe(1);
      expect(after.totalRows).toBe(2);
      expect(after.rowCountSummary.project).toBe(1);
      // 来源元数据与 seal 保留（不含业务值）
      expect(repo.listSources(id)).toHaveLength(1);
      expect(repo.getSeal(id)?.status).toBe('valid');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('取消草稿：清除敏感行保留摘要；已取消草稿禁止再修改', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id } = fullFlowDraft(repo);
      // 从 committing 不能直接取消；先回到 needs_review（提交失败路径）再取消
      repo.settleCommit(id, false);
      const afterSettle = repo.getDraft(id)!;
      expect(afterSettle.state).toBe('needs_review');

      const rev = afterSettle.revision;
      repo.cancelDraft(id, rev);
      const after = repo.getDraft(id)!;
      expect(after.state).toBe('cancelled');
      expect(repo.queryRows(id, { category: 'project', offset: 0, limit: 100 }).total).toBe(0);
      expect(after.rowCounts.project).toBe(1);
      expect(after.totalRows).toBe(2);
      // 已取消草稿禁止修改
      expect(() => repo.patchCells(id, after.revision, [{ rowId: 'r1', field: 'x', value: 'y' }])).toThrowError(
        WorkspaceStateError,
      );
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('直接从 needs_review 取消：取消不触碰正式业务记录（主库内容不变）', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id } = fullFlowDraft(repo);
      // 从 needs_review 取消需要先撤销 committing：settleCommit(false) → needs_review
      repo.settleCommit(id, false);
      const d = repo.getDraft(id)!;
      repo.cancelDraft(id, d.revision);
      expect(repo.getDraft(id)!.state).toBe('cancelled');
      // 草稿仍可列出（可查看摘要），且不残留 rows/cells
      const listed = repo.listDrafts();
      expect(listed.find((x) => x.id === id)?.state).toBe('cancelled');
      expect(listed.find((x) => x.id === id)?.totalRows).toBe(2);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('用户删除草稿：连同摘要一起整体清除（清理不得触碰正式业务记录）', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id } = fullFlowDraft(repo);
      repo.deleteDraft(id);
      expect(repo.getDraft(id)).toBeUndefined();
      expect(repo.listDrafts()).toHaveLength(0);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('异常遗留草稿的可见保留/清理策略（tasks 8.13）', () => {
  it('运行态遗留草稿与超期未更新草稿可列出（可见保留），可确认后清理', () => {
    const dir = makeTempDir();
    try {
      const clock = new FixedClock('2026-01-01T08:00:00+08:00');
      const { repo, close } = openRepo(dir, clock);
      // 超期未更新的稳定草稿（最后一次保存早于截止时间）
      const stale = repo.createDraft({ name: '超期草稿', createdBy: null, createdByUsername: null });
      repo.appendRows(stale.id, 1, 'project', [{ rowId: 'r1', cells: { ecc: 'ECC-1' } }]);
      // 运行态遗留草稿（解析中未恢复）
      const stuck = repo.createDraft({ name: '解析遗留', createdBy: null, createdByUsername: null });
      repo.transitionState(stuck.id, 1, 'start_parsing');

      const cutoff = '2026-01-10T00:00:00+08:00';
      const abandoned = repo.listAbandonedDrafts(cutoff);
      expect(abandoned.map((d) => d.name).sort()).toEqual(['解析遗留', '超期草稿']);

      // 清理后两者都被删除；未过期的正常草稿不受影响
      const { deleted } = repo.cleanupAbandonedDrafts(cutoff);
      expect(deleted).toBe(2);
      expect(repo.getDraft(stale.id)).toBeUndefined();
      expect(repo.getDraft(stuck.id)).toBeUndefined();
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('未超过截止时间的草稿不算遗留；终态草稿不算遗留', () => {
    const dir = makeTempDir();
    try {
      const clock = new FixedClock('2026-01-15T08:00:00+08:00');
      const { repo, close } = openRepo(dir, clock);
      const active = repo.createDraft({ name: '活跃草稿', createdBy: null, createdByUsername: null });
      const done = repo.createDraft({ name: '已完成', createdBy: null, createdByUsername: null });
      repo.transitionState(done.id, 1, 'start_parsing');
      repo.appendRows(done.id, 2, 'project', [{ rowId: 'r1', cells: { ecc: 'E' } }]);
      repo.transitionState(done.id, 3, 'parsing_finished');
      repo.transitionState(done.id, 4, 'start_validating');
      repo.saveSeal(done.id, 5, { planDigest: 'p' });
      repo.transitionState(done.id, 6, 'start_committing');
      repo.settleCommit(done.id, true);

      // 截止时间早于草稿最后保存时间（活跃草稿）或终态草稿 → 不列为遗留
      const cutoff = '2026-01-01T00:00:00+08:00';
      const abandoned = repo.listAbandonedDrafts(cutoff);
      expect(abandoned.map((d) => d.id).sort()).not.toContain(active.id);
      expect(abandoned.map((d) => d.id).sort()).not.toContain(done.id);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
