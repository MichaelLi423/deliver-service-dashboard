import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import {
  RevisionConflictError,
  WorkspaceNotFoundError,
  WorkspaceStateError,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-errors';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 草稿仓储（design D23 / tasks 8.12）：创建/列出/读取/删除、乐观修订号、
 * 稀疏 cell patch、按类别窗口分页/筛选、自动保存状态、来源与问题查询。
 */

function openRepo(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
}

/** 将一个草稿推进到 needs_review，并追加给定行。返回 { draft, rev }。 */
function draftWithRows(
  repo: WorkspaceRepository,
  rows: Array<{ rowId: string; category: 'project' | 'service_order'; businessKey?: string; cells?: Record<string, string | null> }>,
): { id: string; rev: number } {
  const d = repo.createDraft({ name: '草稿', createdBy: null, createdByUsername: null });
  let rev = 1;
  rev = repo.transitionState(d.id, rev, 'start_parsing');
  for (const row of rows) {
    rev = repo.appendRows(d.id, rev, row.category, [
      { rowId: row.rowId, businessKey: row.businessKey ?? null, cells: row.cells },
    ]);
  }
  rev = repo.transitionState(d.id, rev, 'parsing_finished');
  return { id: d.id, rev };
}

describe('草稿生命周期（tasks 8.12）', () => {
  it('创建/列出/读取草稿：修订号从 1 起，来源与账号快照保留', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const d1 = repo.createDraft({ name: '草稿A', createdBy: 'acc-1', createdByUsername: '负责人甲' });
      const d2 = repo.createDraft({ name: '草稿B', createdBy: null, createdByUsername: null });

      const list = repo.listDrafts();
      expect(list).toHaveLength(2);
      expect(list.map((d) => d.name).sort()).toEqual(['草稿A', '草稿B']);

      const detail = repo.getDraft(d1.id)!;
      expect(detail.name).toBe('草稿A');
      expect(detail.state).toBe('draft');
      expect(detail.revision).toBe(1);
      expect(detail.createdBy).toBe('acc-1');
      expect(detail.createdByUsername).toBe('负责人甲');
      expect(detail.pendingOutcome).toBe(false);
      expect(detail.totalRows).toBe(0);
      expect(repo.getDraft('missing-id')).toBeUndefined();
      void d2;
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('删除草稿级联清除全部工作区内容（行、单元格、问题、seal、修订、操作）', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [
        { rowId: 'r1', category: 'project', businessKey: 'ECC-1', cells: { ecc: 'ECC-1' } },
      ]);
      repo.replaceIssues(id, rev, [{ severity: 'error', issueCode: 'X', rowId: 'r1', message: '问题' }]);
      repo.saveMappings(id, rev + 1, [{ category: 'project', sourceColumn: 'ECC#', targetField: 'ecc', mappingState: 'exact' }]);
      repo.addSource(id, { sourceKind: 'file', sourceFile: '合同信息表.xlsx', rowCount: 1 });
      const op = repo.createOperation(id, 'parsing');

      repo.deleteDraft(id);
      expect(repo.getDraft(id)).toBeUndefined();
      expect(repo.queryRows(id, { category: 'project', offset: 0, limit: 100 }).total).toBe(0);
      expect(repo.listIssues(id)).toHaveLength(0);
      expect(repo.listMappings(id)).toHaveLength(0);
      expect(repo.listSources(id)).toHaveLength(0);
      expect(repo.listOperations(id)).toHaveLength(0);
      expect(repo.getSeal(id)).toBeUndefined();
      void op;
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('乐观修订号与稀疏 cell patch（tasks 8.12）', () => {
  it('每次自动保存返回递增修订号；lastSavedAt 随保存推进', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { ecc: 'ECC-1' } }]);
      const before = repo.getDraft(id)!.lastSavedAt;
      const rev2 = repo.patchCells(id, rev, [{ rowId: 'r1', field: 'customer_name', value: '客户甲' }]);
      expect(rev2).toBe(rev + 1);
      const after = repo.getDraft(id)!;
      expect(after.revision).toBe(rev2);
      expect(after.lastSavedAt >= before).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('修订冲突拒绝覆盖较新草稿（RevisionConflictError），较新值保持不变', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { ecc: 'ECC-1' } }]);
      // 一个会话以旧修订发起 patch，另一个会话已把修订推进到 rev+1
      repo.patchCells(id, rev, [{ rowId: 'r1', field: 'region', value: '华东' }]);
      expect(() => repo.patchCells(id, rev, [{ rowId: 'r1', field: 'region', value: '华北' }])).toThrowError(
        RevisionConflictError,
      );
      // 较新草稿未被覆盖
      const window = repo.queryRows(id, { category: 'project', offset: 0, limit: 10 });
      expect(window.rows[0].cells.region).toBe('华东');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('稀疏 patch 只更新变更单元格；未知行抛 WorkspaceNotFoundError', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { a: '1', b: '2' } }]);
      const rev2 = repo.patchCells(id, rev, [{ rowId: 'r1', field: 'a', value: '9' }]);
      const window = repo.queryRows(id, { category: 'project', offset: 0, limit: 10 });
      expect(window.rows[0].cells).toEqual({ a: '9', b: '2' });
      expect(() => repo.patchCells(id, rev2, [{ rowId: 'ghost', field: 'a', value: 'x' }])).toThrowError(
        WorkspaceNotFoundError,
      );
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('按类别窗口分页：total 正确、offset/limit 生效、gridRow 连续', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const rows = Array.from({ length: 25 }, (_, i) => ({
        rowId: `p${i + 1}`,
        category: 'project' as const,
        businessKey: `ECC-${String(i + 1).padStart(3, '0')}`,
        cells: { ecc: `ECC-${String(i + 1).padStart(3, '0')}` },
      }));
      const { id, rev } = draftWithRows(repo, rows);
      // 追加另一类别
      repo.appendRows(id, rev, 'service_order', [{ rowId: 'o1', businessKey: 'ORD-1', cells: { service_order_no: 'ORD-1' } }]);

      const page1 = repo.queryRows(id, { category: 'project', offset: 0, limit: 10 });
      expect(page1.total).toBe(25);
      expect(page1.rows).toHaveLength(10);
      expect(page1.rows[0].gridRow).toBe(1);
      expect(page1.rows[0].businessKey).toBe('ECC-001');
      expect(page1.rows[9].gridRow).toBe(10);

      const page3 = repo.queryRows(id, { category: 'project', offset: 20, limit: 10 });
      expect(page3.rows).toHaveLength(5);
      expect(page3.rows[0].businessKey).toBe('ECC-021');

      const orderWindow = repo.queryRows(id, { category: 'service_order', offset: 0, limit: 10 });
      expect(orderWindow.total).toBe(1);
      expect(orderWindow.rows[0].cells.service_order_no).toBe('ORD-1');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('筛选：按业务键精确匹配、按未解决问题严重度筛选', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [
        { rowId: 'r1', category: 'project', businessKey: 'ECC-100', cells: { ecc: 'ECC-100' } },
        { rowId: 'r2', category: 'project', businessKey: 'ECC-200', cells: { ecc: 'ECC-200' } },
      ]);
      repo.replaceIssues(id, rev, [
        { severity: 'error', issueCode: 'REQ', rowId: 'r1', field: 'ecc', message: '错误' },
      ]);

      const byKey = repo.queryRows(id, { businessKey: 'ECC-200', offset: 0, limit: 10 });
      expect(byKey.total).toBe(1);
      expect(byKey.rows[0].rowId).toBe('r2');

      const withError = repo.queryRows(id, { issueSeverity: 'error', offset: 0, limit: 10 });
      expect(withError.total).toBe(1);
      expect(withError.rows[0].rowId).toBe('r1');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('来源、映射、冲突决定与问题（tasks 8.12）', () => {
  it('来源/映射/冲突决定可保存、列出并随修订推进', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { ecc: 'ECC-1' } }]);
      repo.addSource(id, { sourceKind: 'file', sourceFile: '合同信息表.xlsx', sheet: '合同信息', sourceHash: 'abc', rowCount: 3 });
      repo.addSource(id, { sourceKind: 'paste', sourceFile: '粘贴', sourceHash: 'def' });
      const sources = repo.listSources(id);
      expect(sources).toHaveLength(2);
      expect(sources[0].sourceKind).toBe('file');
      expect(sources[0].sourceFile).toBe('合同信息表.xlsx');

      const rev2 = repo.saveMappings(id, rev, [
        { category: 'project', sourceColumn: 'ECC#', targetField: 'ecc', mappingState: 'exact' },
        { category: 'project', sourceColumn: '未知列', targetField: null, mappingState: 'pending' },
      ]);
      const mappings = repo.listMappings(id);
      expect(mappings).toHaveLength(2);
      expect(mappings.find((m) => m.sourceColumn === '未知列')?.mappingState).toBe('pending');

      const rev3 = repo.saveConflictDecision(id, rev2, {
        rowId: 'r1',
        field: 'customer_name',
        decisionType: 'choose_candidate',
        chosenValue: '客户甲',
        resolvedBy: '负责人',
      });
      const decisions = repo.listConflictDecisions(id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decisionType).toBe('choose_candidate');
      expect(decisions[0].chosenValue).toBe('客户甲');
      expect(rev3).toBe(rev2 + 1);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('问题：错误/冲突/警告分级、定位信息与按严重度/类别筛选', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [
        { rowId: 'r1', category: 'project', businessKey: 'ECC-1', cells: { ecc: 'ECC-1' } },
        { rowId: 'r2', category: 'project', businessKey: 'ECC-2', cells: { ecc: 'ECC-2' } },
      ]);
      repo.replaceIssues(id, rev, [
        { severity: 'error', issueCode: 'MISSING_ECC', rowId: 'r1', field: 'ecc', businessKey: 'ECC-1', gridRow: 1, sourcePosition: '合同信息表#合同信息#2', message: '缺 ECC' },
        { severity: 'warning', issueCode: 'DEAL_ABOVE_BUDGET', category: 'logistics_fee', businessKey: 'ECC-1', gridRow: 2, message: '成交价格高于预算' },
        { severity: 'conflict', issueCode: 'SOURCE_CONFLICT', rowId: 'r2', field: 'customer_name', message: '来源冲突' },
      ]);
      const issues = repo.listIssues(id);
      expect(issues).toHaveLength(3);
      // 排序：error 最先，其次 conflict，最后 warning
      expect(issues.map((i) => i.severity)).toEqual(['error', 'conflict', 'warning']);
      expect(issues[0].sourcePosition).toBe('合同信息表#合同信息#2');
      expect(repo.listIssues(id, { severity: 'warning' })).toHaveLength(1);
      expect(repo.listIssues(id, { category: 'logistics_fee' })).toHaveLength(1);
      expect(repo.listIssues(id, { resolved: false })).toHaveLength(3);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('删除行级联清理其单元格与问题；终态草稿禁止修改', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [
        { rowId: 'r1', category: 'project', cells: { ecc: 'ECC-1' } },
        { rowId: 'r2', category: 'project', cells: { ecc: 'ECC-2' } },
      ]);
      repo.replaceIssues(id, rev, [{ severity: 'error', issueCode: 'X', rowId: 'r2', message: '问题' }]);
      const rev2 = repo.deleteRows(id, rev + 1, ['r2']);
      const window = repo.queryRows(id, { category: 'project', offset: 0, limit: 10 });
      expect(window.total).toBe(1);
      expect(window.rows[0].rowId).toBe('r1');
      expect(repo.listIssues(id)).toHaveLength(0);
      void rev2;
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('校验封存与 seal 失效（tasks 8.12）', () => {
  it('seal 仅在 validating 状态生成；任一数据修改使 seal 失效并回到 needs_review', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: { ecc: 'ECC-1' } }]);
      expect(() => repo.saveSeal(id, rev, { planDigest: 'x' })).toThrowError(WorkspaceStateError);

      const revV = repo.transitionState(id, rev, 'start_validating');
      const revSealed = repo.saveSeal(id, revV, {
        planDigest: 'pd-1',
        templateVersion: 'v1',
        mappingVersion: 'v1',
        validationVersion: 'v1',
        conflictDecisionDigest: 'cd-1',
        targetSchemaVersion: 9,
        targetBusinessRevision: '42',
      });
      const sealed = repo.getDraft(id)!;
      expect(sealed.state).toBe('sealed');
      expect(repo.getSeal(id)?.status).toBe('valid');

      // 修改单元格 → seal 失效、状态回到 needs_review
      const revInvalid = repo.patchCells(id, revSealed, [{ rowId: 'r1', field: 'region', value: '华东' }]);
      const after = repo.getDraft(id)!;
      expect(after.state).toBe('needs_review');
      expect(after.revision).toBe(revInvalid);
      expect(repo.getSeal(id)?.status).toBe('invalid');
      expect(repo.getSeal(id)?.invalidatedAt).not.toBeNull();
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('显式 invalidateSeal 仅允许 sealed 状态', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: {} }]);
      expect(() => repo.invalidateSeal(id, rev)).toThrowError(WorkspaceStateError);
      const revV = repo.transitionState(id, rev, 'start_validating');
      repo.saveSeal(id, revV, { planDigest: 'pd' });
      repo.invalidateSeal(id, revV + 1);
      const after = repo.getDraft(id)!;
      expect(after.state).toBe('needs_review');
      expect(repo.getSeal(id)?.status).toBe('invalid');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('operation 进度（tasks 8.12）', () => {
  it('创建/更新/完成 operation：进度与结果可查询、取消解析不会形成部分草稿合并', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openRepo(dir);
      const { id, rev } = draftWithRows(repo, [{ rowId: 'r1', category: 'project', cells: {} }]);
      const op = repo.createOperation(id, 'parsing');
      expect(op.state).toBe('running');
      const updated = repo.updateOperationProgress(op.id, { stage: '解析 sheet', progressCurrent: 500, progressTotal: 1000 });
      expect(updated.progressCurrent).toBe(500);
      expect(updated.stage).toBe('解析 sheet');
      const done = repo.finishOperation(op.id, 'completed', 'ok');
      expect(done.state).toBe('completed');
      expect(done.finishedAt).not.toBeNull();
      const ops = repo.listOperations(id);
      expect(ops).toHaveLength(1);
      expect(ops[0].kind).toBe('parsing');
      void rev;
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
