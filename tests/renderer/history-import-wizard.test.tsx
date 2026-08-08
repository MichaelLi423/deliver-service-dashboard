// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  HistoryImportSessionExpiredError,
  HistoryImportWizard,
  type GridColumn,
  type HistoryImportCategory,
  type HistoryImportDraftSummary,
  type HistoryImportSubmitResult,
  type HistoryImportWizardProvider,
  type HistoryImportWorkspace,
  type VirtualGridRow,
  type WizardStepId,
} from '../../src/renderer/history-import';

const categoryColumns: Record<HistoryImportCategory, readonly GridColumn[]> = {
  projects: [{ id: 'ecc', label: 'ECC', businessKey: true }, { id: 'customerName', label: '客户名称' }, { id: 'contractAmount', label: '合同 USD 含税金额' }],
  serviceOrders: [{ id: 'ecc', label: 'ECC', businessKey: true }, { id: 'serviceOrderNo', label: '服务单号' }, { id: 'serviceType', label: '服务类型' }, { id: 'engineer', label: '执行工程师' }],
  invoices: [{ id: 'ecc', label: 'ECC', businessKey: true }, { id: 'invoiceAt', label: '掉票时间' }, { id: 'amount', label: '掉票金额（USD）' }],
  logistics: [{ id: 'ecc', label: 'ECC', businessKey: true }, { id: 'budget', label: '预算价格（RMB）' }, { id: 'final', label: '成交价格（RMB）' }, { id: 'cost', label: '物流费用（RMB）' }, { id: 'registeredAt', label: '登记时间' }],
  serialAddresses: [{ id: 'customerName', label: '客户名称', businessKey: true }, { id: 'serialNo', label: '序列号' }, { id: 'accountId', label: 'Account ID' }, { id: 'address', label: '新址地址' }],
  qrRequests: [{ id: 'applicant', label: '申请人', businessKey: true }, { id: 'requestedAt', label: '申请时间' }, { id: 'types', label: '申请类型' }],
  shipToRequests: [{ id: 'customerName', label: '客户名称', businessKey: true }, { id: 'address', label: '新址地址' }, { id: 'accountId', label: 'Account ID' }],
};

const categoryOrder = Object.keys(categoryColumns) as HistoryImportCategory[];
const stepOrder: WizardStepId[] = ['prepare', 'projects', 'orders', 'finance', 'serials', 'requests', 'review'];
const draft: HistoryImportDraftSummary = { id: 'draft-1', name: '2026 年历史数据整理', updatedAt: '今天 10:32', currentStep: 'prepare', totalRows: 18, issueCount: 3, saveState: 'saved' };

function row(category: HistoryImportCategory): VirtualGridRow {
  const values = Object.fromEntries(categoryColumns[category].map((column) => [column.id, `${column.label}值`]));
  if (category === 'projects') values.ecc = 'ECC-2024-001';
  return { id: `${category}-row`, values };
}

function makeWorkspace(currentStep: WizardStepId = 'prepare', options: { sealValid?: boolean; operation?: boolean; operationKind?: 'reading' | 'validating' | 'submitting'; summary?: boolean } = {}): HistoryImportWorkspace {
  const withSummary = options.summary ?? currentStep === 'review';
  return {
    draft: { ...draft, currentStep }, username: '搬迁负责人', templateVersion: 'v3.2', currentStep,
    steps: stepOrder.map((id, index) => ({ id, state: index === 2 ? 'blocked' : index < stepOrder.indexOf(currentStep) ? 'passed' : id === currentStep ? 'processing' : 'not_started', errorCount: index === 2 ? 2 : 0 })),
    categories: categoryOrder.map((category, index) => ({ category, mode: index === 6 ? 'none' : 'data', count: index === 6 ? 0 : index + 1, columns: categoryColumns[category] })),
    sheets: [
      { id: 'sheet-1', fileName: '历史资料.xlsx', sheetName: '项目合同', rowCount: 12, category: 'projects', status: 'recognized' },
      { id: 'sheet-2', fileName: '历史资料.xlsx', sheetName: '其它资料', rowCount: 6, category: null, status: 'unknown' },
    ],
    mappings: [
      { id: 'map-1', category: 'projects', source: 'ECC号', target: 'ecc', targetOptions: [{ id: 'ecc', label: 'ECC' }], match: 'alias', sample: 'ECC-2024-001', priority: 1, affectedRows: 12 },
      { id: 'map-2', category: 'projects', source: '客户', target: null, targetOptions: [{ id: 'customerName', label: '客户名称' }], match: 'manual', sample: '华东分析中心' },
    ],
    issues: [
      { id: 'error-1', kind: 'error', category: 'serviceOrders', step: 'orders', rowIndex: 0, columnId: 'serviceOrderNo', field: '服务单号', message: '服务单号重复，需要先处理', source: '历史资料.xlsx / 开单 / 第 2 行' },
      { id: 'conflict-1', kind: 'conflict', category: 'projects', step: 'projects', rowIndex: 0, columnId: 'customerName', field: '客户名称', message: '同一 ECC 有两个客户名称', source: '历史资料.xlsx / 项目合同 / 第 2 行', candidates: [{ value: '华东分析中心', source: '历史资料.xlsx / 第 2 行' }, { value: '华东检测中心', source: '粘贴内容 / 第 1 行' }] },
      { id: 'warning-1', kind: 'warning', category: 'logistics', step: 'finance', rowIndex: 0, columnId: 'final', field: '成交价格', message: '成交价格高于预算价格', source: '物流.xlsx / 费用 / 第 8 行' },
    ],
    ecc: [{ ecc: 'ECC-2024-001', projects: 1, serviceOrders: 2, invoices: 1, logistics: 1, sources: 3 }],
    operation: options.operation ? { id: 'op-1', kind: options.operationKind ?? 'reading', label: options.operationKind === 'validating' ? '完整校验' : '正在读取历史资料.xlsx', processed: 25_000, total: 50_000, cancelable: options.operationKind !== 'submitting' } : null,
    summary: withSummary ? {
      categories: categoryOrder.map((category, index) => ({ category, add: index + 1, match: 1, correct: 0, skip: index === 6 ? 1 : 0, warning: category === 'logistics' ? 1 : 0, blocked: 0 })),
      eccProjects: 3, independentRecords: 7, amountTotals: [{ label: '合同金额合计', value: 'USD 120,000.00' }, { label: '物流费用合计', value: 'RMB 8,600.00' }], excludedSources: 1, confirmedBy: '搬迁负责人', seal: options.sealValid === false ? null : 'seal-1', sealValid: options.sealValid !== false, validationComplete: true, warningCount: 1, blockingCount: 0,
    } : null,
  };
}

function fakeProvider(initial = makeWorkspace(), submitPromise?: Promise<HistoryImportSubmitResult>) {
  let state = initial;
  const mutate = (patch: Partial<HistoryImportWorkspace>) => { state = { ...state, ...patch, draft: { ...state.draft, currentStep: patch.currentStep ?? state.currentStep, saveState: 'saved' } }; return Promise.resolve(state); };
  const provider: HistoryImportWizardProvider = {
    listDrafts: vi.fn().mockResolvedValue([draft]), createDraft: vi.fn(async () => state), openDraft: vi.fn(async () => state), deleteDraft: vi.fn().mockResolvedValue(undefined),
    saveDraft: vi.fn((_id, currentStep) => mutate({ currentStep })), downloadTemplate: vi.fn().mockResolvedValue({ saved: true, version: 'v3.2' }), selectFiles: vi.fn(async () => state),
    pasteIntoCategory: vi.fn(async () => state),
    classifySheet: vi.fn((_id, sheetId, category) => mutate({ sheets: state.sheets.map((sheet) => sheet.id === sheetId ? { ...sheet, category: category === 'excluded' ? null : category, status: category === 'excluded' ? 'excluded' : 'recognized' } : sheet) })),
    setCategoryMode: vi.fn((_id, category, mode) => mutate({ categories: state.categories.map((item) => item.category === category ? { ...item, mode, count: mode === 'none' ? 0 : Math.max(1, item.count) } : item) })),
    updateMapping: vi.fn((_id, mappingId, target) => mutate({ mappings: state.mappings.map((mapping) => mapping.id === mappingId ? { ...mapping, target, match: target ? 'manual' : 'unused' } : mapping) })),
    getGridProvider: vi.fn((_id: string, category: HistoryImportCategory) => ({ readWindow: vi.fn(async () => ({ rows: [row(category)], total: 1 })), locateIssue: vi.fn(async () => ({ rowIndex: 0, columnId: category === 'projects' ? 'customerName' : categoryColumns[category][0]?.id })) })),
    patchGrid: vi.fn(async () => state), addGridRow: vi.fn(async () => state), deleteRows: vi.fn(async () => state), undo: vi.fn(async () => state), redo: vi.fn(async () => state),
    validate: vi.fn(() => mutate({ summary: makeWorkspace('review', { summary: true }).summary, operation: null })), cancelOperation: vi.fn(() => mutate({ operation: null })),
    resolveConflict: vi.fn((_id, issueId) => mutate({ issues: state.issues.filter((issue) => issue.id !== issueId) })),
    submit: vi.fn((): Promise<HistoryImportSubmitResult> => submitPromise ?? Promise.resolve({ status: 'success', title: '导入完成', message: '七类数据已在一个事务中完成导入。' })),
  };
  return provider;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('历史导入草稿首页与全窗口结构', () => {
  it('支持新建、继续、摘要和删除草稿', async () => {
    const provider = fakeProvider();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<HistoryImportWizard provider={provider} />);
    expect(await screen.findByRole('heading', { name: '导入草稿' })).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续草稿' }));
    expect(await screen.findByRole('heading', { name: '准备数据' })).toBeInTheDocument();
    cleanup();
    render(<HistoryImportWizard provider={provider} />);
    await screen.findByRole('heading', { name: '导入草稿' });
    fireEvent.click(screen.getByRole('button', { name: '删除草稿' }));
    await waitFor(() => expect(provider.deleteDraft).toHaveBeenCalledWith('draft-1'));
    fireEvent.click(screen.getByRole('button', { name: '新建导入' }));
    await waitFor(() => expect(provider.createDraft).toHaveBeenCalledTimes(1));
  });

  it('展示固定七步、账号、保存状态、问题状态与返回确认焦点', async () => {
    const provider = fakeProvider();
    render(<HistoryImportWizard provider={provider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    const nav = await screen.findByRole('navigation', { name: '导入步骤' });
    expect(within(nav).getAllByRole('button').filter((button) => /^0\d/.test(button.textContent ?? ''))).toHaveLength(7);
    expect(screen.getByText('搬迁负责人')).toBeInTheDocument();
    expect(screen.getAllByText(/已保存/).length).toBeGreaterThan(0);
    expect(within(nav).getByRole('button', { name: /开单记录.*已阻断.*2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '键盘帮助' }));
    const keyboardHelp = screen.getByRole('region', { name: '键盘操作说明' });
    expect(keyboardHelp).toHaveTextContent('F8'); expect(keyboardHelp).toHaveTextContent('Ctrl Z'); expect(keyboardHelp).toHaveTextContent('Ctrl V');
    const back = screen.getByRole('button', { name: /返回数据管理/ });
    back.focus(); fireEvent.click(back);
    expect(await screen.findByRole('dialog', { name: '保存并退出？' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(back).toHaveFocus());
  });

  it('保存失败时保留全窗口草稿并阻止误退出', async () => {
    const provider = fakeProvider();
    provider.saveDraft = vi.fn().mockRejectedValue(new Error('草稿保存失败，请检查本地存储后重试'));
    const onExit = vi.fn();
    render(<HistoryImportWizard provider={provider} onExit={onExit} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: '保存并退出' }));
    const dialog = await screen.findByRole('dialog', { name: '保存并退出？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并退出' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿保存失败');
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '保存并退出？' })).toBeInTheDocument();
  });

  it('提交中断后明确区分完整成功与完整回滚，回滚草稿强制回到重新校验', async () => {
    const failedProvider = fakeProvider();
    failedProvider.recover = vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: ['draft-1'] });
    failedProvider.settleInterrupted = vi.fn().mockResolvedValue({ status: 'failed', title: '已回滚', message: '事务没有提交。' });
    const failedView = render(<HistoryImportWizard provider={failedProvider} />);
    fireEvent.click(await screen.findByRole('button', { name: /核对.*最终状态/ }));
    const rollbackHeading = await screen.findByRole('heading', { name: '整批导入已完整回滚' });
    expect(rollbackHeading).toHaveFocus();
    expect(screen.getByText('没有产生部分导入')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续草稿并重新校验' }));
    await waitFor(() => expect(failedProvider.saveDraft).toHaveBeenCalledWith('draft-1', 'review'));
    failedView.unmount();

    const successProvider = fakeProvider();
    successProvider.recover = vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: ['draft-1'] });
    successProvider.settleInterrupted = vi.fn().mockResolvedValue({ status: 'success', title: '完成', message: '成功审计与整体事务均已核对。' });
    render(<HistoryImportWizard provider={successProvider} />);
    fireEvent.click(await screen.findByRole('button', { name: /核对.*最终状态/ }));
    expect(await screen.findByRole('heading', { name: '整批导入已完整成功' })).toBeInTheDocument();
    expect(screen.getByText('成功结果已经核对')).toBeInTheDocument();
  });
});

describe('准备数据、业务网格与问题处理', () => {
  it('覆盖模板、文件/sheet、50k 进度取消和共用列映射', async () => {
    const provider = fakeProvider(makeWorkspace('prepare', { operation: true }));
    render(<HistoryImportWizard provider={provider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    expect(await screen.findByText('已处理 25,000 / 50,000 行')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消处理' }));
    await waitFor(() => expect(provider.cancelOperation).toHaveBeenCalledWith('draft-1', 'op-1'));
    fireEvent.click(screen.getByRole('button', { name: '下载 Excel 模板' }));
    expect(provider.downloadTemplate).toHaveBeenCalled();
    expect(screen.getByText('其它资料')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('其它资料 目标类别'), { target: { value: 'excluded' } });
    await waitFor(() => expect(provider.classifySheet).toHaveBeenCalledWith('draft-1', 'sheet-2', 'excluded'));
    fireEvent.click(screen.getByRole('button', { name: /列映射 2/ }));
    expect(screen.getByRole('region', { name: '列映射' })).toHaveTextContent('已知别名');
    fireEvent.change(screen.getByLabelText('客户 映射目标'), { target: { value: 'customerName' } });
    await waitFor(() => expect(provider.updateMapping).toHaveBeenCalledWith('draft-1', 'map-2', 'customerName'));
  });

  it('六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid', async () => {
    const provider = fakeProvider();
    render(<HistoryImportWizard provider={provider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    await screen.findByRole('navigation', { name: '导入步骤' });
    const checks: [string, string][] = [['项目与合同', '合同 USD 含税金额'], ['开单记录', '执行工程师'], ['掉票与物流费用', '掉票金额（USD）'], ['序列号地址更新', '序列号'], ['二维码与 Ship-to 申请', '申请类型']];
    for (const [step, column] of checks) {
      fireEvent.click(within(screen.getByRole('navigation', { name: '导入步骤' })).getByRole('button', { name: new RegExp(step) }));
      expect(await screen.findByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('tab', { name: /Ship-to 申请/ }));
    expect(screen.getByText('本次不导入Ship-to 申请')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '有数据' }));
    expect(await screen.findByRole('columnheader', { name: 'Account ID' })).toBeInTheDocument();
    expect(provider.getGridProvider).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true });
    await waitFor(() => expect(provider.undo).toHaveBeenCalledWith('draft-1'));
    await waitFor(() => expect(provider.redo).toHaveBeenCalledWith('draft-1'));
  });

  it('ECC 中心、四层问题反馈、定位和冲突候选处理均可操作', async () => {
    const provider = fakeProvider();
    render(<HistoryImportWizard provider={provider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: /ECC 中心/ }));
    expect(screen.getByText('ECC-2024-001')).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: '全局问题面板' });
    expect(panel).toHaveTextContent('错误1'); expect(panel).toHaveTextContent('冲突1'); expect(panel).toHaveTextContent('警告1');
    const conflictItem = within(panel).getByText('同一 ECC 有两个客户名称').closest('li')!;
    fireEvent.click(within(conflictItem).getByRole('button', { name: '定位' }));
    await screen.findByRole('gridcell', { name: '客户名称，第 1 行' });
    await waitFor(() => expect(screen.getByRole('gridcell', { name: '客户名称，第 1 行' })).toHaveFocus());
    fireEvent.click(within(conflictItem).getByRole('button', { name: '处理冲突' }));
    const dialog = await screen.findByRole('dialog', { name: '选择要保留的值' });
    expect(dialog).toHaveTextContent('历史资料.xlsx / 第 2 行');
    fireEvent.click(within(dialog).getByLabelText(/华东检测中心/));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存冲突决定' }));
    await waitFor(() => expect(provider.resolveConflict).toHaveBeenCalledWith('draft-1', 'conflict-1', '华东检测中心'));
  });

  it('显式粘贴入口由 provider 主进程 API 读取剪贴板，并确认首行为表头或数据', async () => {
    const provider = fakeProvider();
    render(<HistoryImportWizard provider={provider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    const nav = await screen.findByRole('navigation', { name: '导入步骤' });
    fireEvent.click(within(nav).getByRole('button', { name: /项目与合同/ }));
    const paste = await screen.findByRole('button', { name: '从 Excel 粘贴' });
    paste.focus(); fireEvent.click(paste);
    const dialog = await screen.findByRole('dialog', { name: '粘贴到项目与合同' });
    expect(within(dialog).getByRole('button', { name: '关闭' })).toHaveFocus();
    fireEvent.click(within(dialog).getByLabelText('业务数据'));
    expect(within(dialog).getByText('开始前会建立可恢复检查点')).toBeInTheDocument();
    const execute = within(dialog).getByRole('button', { name: '建立检查点并读取剪贴板' });
    expect(execute).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/我已核对目标类别/));
    fireEvent.click(execute);
    await waitFor(() => expect(provider.pasteIntoCategory).toHaveBeenCalledWith('draft-1', 'projects', false));
    expect(provider.saveDraft).toHaveBeenCalledWith('draft-1', 'projects');
    await waitFor(() => expect(paste).toHaveFocus());
  });
});

describe('最终校验、会话与单一提交', () => {
  it('seal 失效禁用；有效摘要要求范围和 warning 确认后只提交一次并展示结果', async () => {
    const invalidProvider = fakeProvider(makeWorkspace('review', { summary: true, sealValid: false }));
    const first = render(<HistoryImportWizard provider={invalidProvider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    expect(await screen.findByText('封存已失效')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认导入' })).toBeDisabled();
    first.unmount();

    let resolveSubmit!: (value: HistoryImportSubmitResult) => void;
    const pending = new Promise<HistoryImportSubmitResult>((resolve) => { resolveSubmit = resolve; });
    const provider = fakeProvider(makeWorkspace('review', { summary: true }), pending);
    render(<HistoryImportWizard provider={provider} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    expect(await screen.findByText('USD 120,000.00')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '确认导入' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/我已核对七类记录范围/));
    fireEvent.click(screen.getByLabelText(/我已查看并确认 1 条警告/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    const dialog = await screen.findByRole('dialog', { name: '确认整体导入' });
    expect(dialog).toHaveTextContent('任一记录失败时，本次全部数据都不会保存');
    const start = within(dialog).getByRole('button', { name: '开始导入' });
    fireEvent.click(start); fireEvent.click(start);
    expect(await screen.findByText('正在整体提交')).toBeInTheDocument();
    expect(provider.submit).toHaveBeenCalledTimes(1);
    resolveSubmit({ status: 'success', title: '导入完成', message: '七类数据已在一个事务中完成导入。' });
    expect(await screen.findByRole('dialog', { name: '导入完成' })).toHaveTextContent('一个事务');
  });

  it('会话失效停止操作、提示保留草稿并要求重新校验', async () => {
    const provider = fakeProvider();
    provider.selectFiles = vi.fn().mockRejectedValue(new HistoryImportSessionExpiredError());
    const onSessionExpired = vi.fn();
    render(<HistoryImportWizard provider={provider} onSessionExpired={onSessionExpired} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择一个或多个文件' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('最后一次成功保存的草稿仍会保留');
    expect(screen.getByRole('alert')).toHaveTextContent('重新完整校验');
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it('取消完整校验：validating 操作可取消，点击取消处理调用 cancelOperation 并回到保存状态', async () => {
  const provider = fakeProvider(makeWorkspace('review', { operation: true, operationKind: 'validating' }));
  render(<HistoryImportWizard provider={provider} />);
  fireEvent.click(await screen.findByRole('button', { name: '继续草稿' }));
  expect(await screen.findByText('完整校验')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消处理' }));
  await waitFor(() => expect(provider.cancelOperation).toHaveBeenCalledWith('draft-1', 'op-1'));
  await waitFor(() => expect(screen.getByText(/操作已取消/)).toBeInTheDocument());
});
