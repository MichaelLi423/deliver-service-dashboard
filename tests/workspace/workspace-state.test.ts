import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import {
  transitionState,
  WORKSPACE_DRAFT_STATES,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-state';
import { WorkspaceStateError } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-errors';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 草稿状态机与运行态重启恢复（design D20 / tasks 8.11）。
 * 合法转换表、非法转换拒绝、parsing/validating 回到最后稳定修订、
 * committing 必须先核对正式成功审计再判定 succeeded 或回到需重新校验。
 */

function openRepo(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
}

describe('状态机转换表（tasks 8.11）', () => {
  it('合法转换表完整覆盖设计主流程与 cancelled', () => {
    expect(transitionState('draft', 'start_parsing')).toBe('parsing');
    expect(transitionState('draft', 'cancel_draft')).toBe('cancelled');
    expect(transitionState('parsing', 'parsing_finished')).toBe('needs_review');
    expect(transitionState('needs_review', 'start_parsing')).toBe('parsing');
    expect(transitionState('needs_review', 'start_validating')).toBe('validating');
    expect(transitionState('needs_review', 'cancel_draft')).toBe('cancelled');
    expect(transitionState('validating', 'validation_finished')).toBe('needs_review');
    expect(transitionState('validating', 'validation_passed')).toBe('sealed');
    expect(transitionState('sealed', 'start_committing')).toBe('committing');
    expect(transitionState('sealed', 'seal_invalidated')).toBe('needs_review');
    expect(transitionState('committing', 'commit_verified')).toBe('succeeded');
    expect(transitionState('committing', 'commit_failed')).toBe('needs_review');
  });

  it('非法状态转换被拒绝（终态/越级/运行态错误流转）', () => {
    expect(() => transitionState('draft', 'start_validating')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('draft', 'start_committing')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('parsing', 'validation_passed')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('needs_review', 'validation_passed')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('sealed', 'start_parsing')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('succeeded', 'start_parsing')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('cancelled', 'cancel_draft')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('cancelled', 'start_parsing')).toThrowError(WorkspaceStateError);
    expect(() => transitionState('committing', 'start_validating')).toThrowError(WorkspaceStateError);
  });

  it('状态枚举与设计一致：运行态、终态划分正确', () => {
    expect(WORKSPACE_DRAFT_STATES).toEqual([
      'draft',
      'parsing',
      'needs_review',
      'validating',
      'sealed',
      'committing',
      'succeeded',
      'cancelled',
    ]);
  });
});

describe('运行态重启恢复（tasks 8.11）', () => {
  it('parsing 中重启：回到创建时最后稳定修订，运行期追加的行被回滚', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const d = repo.createDraft({ name: '解析中草稿', createdBy: null, createdByUsername: null });
      repo.transitionState(d.id, 1, 'start_parsing'); // rev2 parsing
      repo.appendRows(d.id, 2, 'project', [
        { rowId: 'r1', businessKey: 'ECC-1', cells: { ecc: 'ECC-1' } },
        { rowId: 'r2', businessKey: 'ECC-2', cells: { ecc: 'ECC-2' } },
      ]); // rev3 parsing
      repo.createOperation(d.id, 'parsing');

      const report = repo.recoverRuntimeStates();
      expect(report.recovered).toHaveLength(1);
      expect(report.recovered[0]).toMatchObject({ draftId: d.id, from: 'parsing', to: 'draft' });
      const after = repo.getDraft(d.id)!;
      expect(after.state).toBe('draft');
      expect(after.revision).toBe(1);
      // 运行期写入的行与 running 操作被回滚
      expect(repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 }).total).toBe(0);
      expect(repo.listOperations(d.id).every((o) => o.state === 'cancelled')).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('validating 中重启：回到最后稳定草稿修订（needs_review），修订前数据保留', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const d = repo.createDraft({ name: '校验中草稿', createdBy: null, createdByUsername: null });
      repo.transitionState(d.id, 1, 'start_parsing'); // rev2
      repo.appendRows(d.id, 2, 'project', [{ rowId: 'r1', businessKey: 'ECC-1', cells: { ecc: 'ECC-1', customer_name: '客户甲' } }]); // rev3
      repo.transitionState(d.id, 3, 'parsing_finished'); // rev4 needs_review（稳定）
      repo.patchCells(d.id, 4, [{ rowId: 'r1', field: 'region', value: '华东' }]); // rev5 needs_review
      repo.transitionState(d.id, 5, 'start_validating'); // rev6 validating
      repo.replaceIssues(d.id, 6, [{ severity: 'error', issueCode: 'MISSING_ECC', rowId: 'r1', field: 'ecc', message: '缺 ECC' }]); // rev7 validating

      const report = repo.recoverRuntimeStates();
      expect(report.recovered).toHaveLength(1);
      const after = repo.getDraft(d.id)!;
      expect(after.state).toBe('needs_review');
      expect(after.revision).toBe(5);
      // 稳定修订前的行与单元格保留，运行期写入的问题被回滚
      const window = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 });
      expect(window.total).toBe(1);
      expect(window.rows[0].cells).toMatchObject({ ecc: 'ECC-1', customer_name: '客户甲', region: '华东' });
      expect(repo.listIssues(d.id)).toHaveLength(0);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('committing 中断重启：标记 pendingOutcome，先核对正式成功审计再判定', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const d = repo.createDraft({ name: '提交中草稿', createdBy: null, createdByUsername: null });
      repo.transitionState(d.id, 1, 'start_parsing'); // rev2
      repo.appendRows(d.id, 2, 'invoice', [{ rowId: 'i1', businessKey: 'ECC-1', cells: { amount: '10000' } }]); // rev3
      repo.transitionState(d.id, 3, 'parsing_finished'); // rev4
      repo.transitionState(d.id, 4, 'start_validating'); // rev5
      repo.saveSeal(d.id, 5, { planDigest: 'pd-commit', mappingVersion: 'v1', targetBusinessRevision: '42' }); // rev6 sealed
      repo.transitionState(d.id, 6, 'start_committing'); // rev7 committing
      repo.createOperation(d.id, 'committing');

      const report = repo.recoverRuntimeStates();
      expect(report.recovered).toHaveLength(0);
      expect(report.pendingOutcome).toContain(d.id);
      const pending = repo.getDraft(d.id)!;
      expect(pending.state).toBe('committing');
      expect(pending.pendingOutcome).toBe(true);

      // 核对成功审计通过 → succeeded，敏感行清除、摘要保留
      const revOk = repo.settleCommit(d.id, true);
      const succeeded = repo.getDraft(d.id)!;
      expect(succeeded.state).toBe('succeeded');
      expect(succeeded.pendingOutcome).toBe(false);
      expect(succeeded.revision).toBe(revOk);
      expect(repo.queryRows(d.id, { category: 'invoice', offset: 0, limit: 100 }).total).toBe(0);
      expect(succeeded.rowCounts.invoice).toBe(1);
      expect(succeeded.totalRows).toBe(1);
      // seal 保留（status valid）
      expect(repo.getSeal(d.id)?.status).toBe('valid');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('committing 核对失败：回到需重新校验状态并使 seal 失效，禁止自动重提', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const d = repo.createDraft({ name: '提交失败草稿', createdBy: null, createdByUsername: null });
      repo.transitionState(d.id, 1, 'start_parsing');
      repo.appendRows(d.id, 2, 'project', [{ rowId: 'p1', businessKey: 'ECC-X', cells: { ecc: 'ECC-X' } }]);
      repo.transitionState(d.id, 3, 'parsing_finished');
      repo.transitionState(d.id, 4, 'start_validating');
      repo.saveSeal(d.id, 5, { planDigest: 'pd-fail', targetBusinessRevision: '7' });
      repo.transitionState(d.id, 6, 'start_committing');
      repo.recoverRuntimeStates();

      repo.settleCommit(d.id, false);
      const after = repo.getDraft(d.id)!;
      expect(after.state).toBe('needs_review');
      expect(after.pendingOutcome).toBe(false);
      expect(repo.getSeal(d.id)?.status).toBe('invalid');
      // 行数据保留（整体回滚，不产生部分写入），但需重新完整校验
      expect(repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 }).total).toBe(1);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('settleCommit 仅允许在 committing 状态；commit 事件不允许经 transitionState 直接调用', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const d = repo.createDraft({ name: '状态守卫', createdBy: null, createdByUsername: null });
      expect(() => repo.settleCommit(d.id, true)).toThrowError(WorkspaceStateError);
      expect(() => repo.transitionState(d.id, 1, 'commit_verified')).toThrowError(WorkspaceStateError);
      expect(() => repo.transitionState(d.id, 1, 'commit_failed')).toThrowError(WorkspaceStateError);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
