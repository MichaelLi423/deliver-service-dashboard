// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcHistoryImportProvider, type HistoryImportProgressEvent } from '../../src/renderer/history-import';
import type { ImportWizardApi, ImportWizardProgressEventDto, ImportWizardWorkspaceDto } from '../../src/shared/ipc';

const workspace: ImportWizardWorkspaceDto = {
  draft: { id: 'draft-1', name: '历史草稿', currentStep: 'projects', totalRows: 1, issueCount: 1, saveState: 'saved', updatedAt: '今天' },
  username: '负责人', templateVersion: 'v3', currentStep: 'projects',
  steps: [{ id: 'prepare', state: 'passed', errorCount: 0 }, { id: 'projects', state: 'blocked', errorCount: 1 }],
  categories: [{ category: 'projects', mode: 'data', count: 1, columns: [{ id: 'ecc', label: 'ECC', businessKey: true }, { id: 'customer', label: '客户名称' }] }],
  sheets: [], mappings: [{ id: 'map-1', category: 'projects', source: 'ECC号', target: 'ecc', targetOptions: [{ id: 'ecc', label: 'ECC' }, { id: 'customer', label: '客户名称' }], match: 'exact', sample: 'ECC-1' }], ecc: [], summary: null, operation: null,
  issues: [{ id: 'issue-1', kind: 'error', category: 'projects', step: 'projects', rowIndex: 0, columnId: 'customer', field: '客户名称', message: '客户名称必填', source: '历史.xlsx / 第 2 行' }],
};

function ipcApi() {
  let progress: ((event: ImportWizardProgressEventDto) => void) | null = null;
  const api: ImportWizardApi = {
    listDrafts: vi.fn().mockResolvedValue([workspace.draft]), createDraft: vi.fn().mockResolvedValue(workspace), openDraft: vi.fn().mockResolvedValue(workspace), deleteDraft: vi.fn().mockResolvedValue(undefined), saveStep: vi.fn().mockResolvedValue(workspace),
    downloadTemplate: vi.fn().mockResolvedValue({ saved: true, version: 'v3' }), selectFiles: vi.fn().mockResolvedValue(workspace), pasteIntoCategory: vi.fn().mockResolvedValue(workspace), classifySheet: vi.fn().mockResolvedValue(workspace), setCategoryMode: vi.fn().mockResolvedValue(workspace), updateMapping: vi.fn().mockResolvedValue(workspace),
    queryRows: vi.fn().mockResolvedValue({ rows: [{ id: 'row-1', values: { ecc: 'ECC-1', customer: '旧客户' } }], total: 1, offset: 0, limit: 1 }), patchCells: vi.fn().mockResolvedValue(workspace), addRow: vi.fn().mockResolvedValue(workspace), deleteRows: vi.fn().mockResolvedValue(workspace), validate: vi.fn().mockResolvedValue(workspace), saveConflictDecision: vi.fn().mockResolvedValue(workspace), cancelOperation: vi.fn().mockResolvedValue(workspace), summary: vi.fn().mockResolvedValue(workspace),
    commit: vi.fn().mockResolvedValue({ status: 'success', title: '完成', message: '已整体提交' }), settleInterrupted: vi.fn().mockResolvedValue({ status: 'success', title: '完成', message: '已核对' }), recover: vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: [] }),
    checkpoints: vi.fn().mockResolvedValue([]), undo: vi.fn().mockResolvedValue(null), redo: vi.fn().mockResolvedValue(null),
    onProgress: vi.fn((callback) => { progress = callback; return () => { progress = null; }; }),
  };
  return { api, emit: (event: ImportWizardProgressEventDto) => progress?.(event) };
}

afterEach(() => vi.restoreAllMocks());

describe('IpcHistoryImportProvider renderer 适配', () => {
  it('接通主进程 paste、窗口搜索与问题定位，不把完整行集放入 workspace', async () => {
    const bridge = ipcApi();
    Object.defineProperty(window, 'workbench', { value: { importWizard: bridge.api }, configurable: true });
    const provider = new IpcHistoryImportProvider();
    const opened = await provider.openDraft('draft-1');
    expect(opened).not.toHaveProperty('rows');
    await provider.pasteIntoCategory('draft-1', 'projects', true);
    expect(bridge.api.pasteIntoCategory).toHaveBeenCalledWith('draft-1', 'projects', true);

    const grid = provider.getGridProvider('draft-1', 'projects');
    await grid.readWindow({ offset: 0, limit: 40, search: 'ECC-1', filter: { issueKind: 'error' } });
    expect(bridge.api.queryRows).toHaveBeenLastCalledWith(expect.objectContaining({ businessKey: 'ECC-1', issueSeverity: 'error', limit: 40 }));
    await expect(grid.search?.('ECC-1', {})).resolves.toEqual({ rowIndex: 0, columnId: 'ecc' });
    await expect(grid.locateIssue?.('issue-1')).resolves.toEqual({ rowIndex: 0, columnId: 'customer' });
  });

  it('把 IPC 进度转成可订阅 renderer 元数据；undo/redo 完全委托后端磁盘 checkpoint', async () => {
    const bridge = ipcApi();
    Object.defineProperty(window, 'workbench', { value: { importWizard: bridge.api }, configurable: true });
    const provider = new IpcHistoryImportProvider();
    const events: HistoryImportProgressEvent[] = [];
    const unsubscribe = provider.subscribeProgress(events.push.bind(events));
    bridge.emit({ draftId: 'draft-1', operationId: 'op-1', kind: 'normalizing', stage: '正在规范化', processed: 500, total: 1000, state: 'running' });
    expect(events).toHaveLength(1); expect(events[0]?.processed).toBe(500);
    unsubscribe();

    // Oracle 复审 #4：undo/redo 由后端 pre/post checkpoint 提供，renderer 不保存敏感旧值。
    bridge.api.undo = vi.fn().mockResolvedValue(workspace);
    bridge.api.redo = vi.fn().mockResolvedValue(workspace);
    await provider.patchGrid('draft-1', 'projects', [{ rowIndex: 0, rowId: 'row-1', columnId: 'customer', value: '新客户' }]);
    await provider.undo('draft-1');
    expect(bridge.api.undo).toHaveBeenCalledWith('draft-1');
    await provider.redo('draft-1');
    expect(bridge.api.redo).toHaveBeenCalledWith('draft-1');
  });

  it('后端磁盘 checkpoint 覆盖所有可变操作：mapping/add/delete 只委托主进程，不保存旧值', async () => {
    const mappingBridge = ipcApi();Object.defineProperty(window, 'workbench', { value: { importWizard: mappingBridge.api }, configurable: true });
    const mappingProvider = new IpcHistoryImportProvider();await mappingProvider.openDraft('draft-1');
    await mappingProvider.updateMapping('draft-1', 'map-1', 'customer');
    expect(mappingBridge.api.updateMapping).toHaveBeenLastCalledWith('draft-1', 'map-1', 'customer');

    const addBridge = ipcApi();Object.defineProperty(window, 'workbench', { value: { importWizard: addBridge.api }, configurable: true });
    const addProvider = new IpcHistoryImportProvider();await addProvider.addGridRow('draft-1', 'projects');
    expect(addBridge.api.addRow).toHaveBeenCalledWith('draft-1', 'projects');

    const deleteBridge = ipcApi();Object.defineProperty(window, 'workbench', { value: { importWizard: deleteBridge.api }, configurable: true });
    const deleteProvider = new IpcHistoryImportProvider();
    // 删除既有来源行走后端磁盘 checkpoint（含原位置/来源/只读元数据恢复）。
    await deleteProvider.deleteRows('draft-1', 'projects', { startRow: 0, endRow: 0 });
    expect(deleteBridge.api.deleteRows).toHaveBeenCalledWith('draft-1', 'projects', ['row-1']);
    // undo/redo 委托后端（无 checkpoint 时返回当前工作区，不进行客户端补丁）。
    await deleteProvider.undo('draft-1');
    expect(deleteBridge.api.undo).toHaveBeenCalledWith('draft-1');
  });

  it('恢复并核对中断提交只透传明确的整体结果', async () => {
    const bridge = ipcApi();
    bridge.api.recover = vi.fn().mockResolvedValue({ recovered: [{ draftId: 'draft-1', from: 'submitting', to: 'pending_outcome' }], pendingOutcome: ['draft-1'] });
    Object.defineProperty(window, 'workbench', { value: { importWizard: bridge.api }, configurable: true });
    const provider = new IpcHistoryImportProvider();
    await expect(provider.recover()).resolves.toEqual(expect.objectContaining({ pendingOutcome: ['draft-1'] }));
    await expect(provider.settleInterrupted('draft-1')).resolves.toEqual({ status: 'success', title: '完成', message: '已核对', importedCounts: undefined });
    expect(bridge.api.settleInterrupted).toHaveBeenCalledWith('draft-1');
  });
});
