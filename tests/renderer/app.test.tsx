// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/renderer/app';
import type {
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2OverviewDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionPageDto,
} from '../../src/shared/ipc';

function project(index: number): WorkbenchProjectRow {
  return {
    id: `p-${index}`, tempNo: `TMP-${String(index).padStart(6, '0')}`, ecc: `ECC-${String(index).padStart(6, '0')}`,
    customerName: `客户 ${index}`, status: index % 2 ? 'executing' : 'pending_entry', formallyEntered: index % 2 === 1,
    preEntryExecution: index % 2 === 0, region: index % 2 ? '华东' : '华北', entryAt: null,
    reminderAt: index < 3 ? '2026-08-08T09:00:00+08:00' : null, reminderNote: index < 3 ? `提醒 ${index}` : null,
    reminderDueClass: index < 3 ? 'today' : null, finalAmount: '100000.00', invoicedAmount: '40000.00', contractAmount: '110000.00',
    counts: { batches: 1, instruments: 1, activities: 1, orders: 1, repairs: 0 }, nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    updatedAt: '2026-08-08T08:00:00+08:00',
  };
}

const firstProjects = Array.from({ length: 50 }, (_, index) => project(index + 1));
const secondProjects = Array.from({ length: 50 }, (_, index) => project(index + 51));
const overview: WorkbenchV2OverviewDto = {
  businessRevision: 1, generatedAt: '2026-08-08T09:00:00+08:00',
  metrics: { totalProjects: 100_000, activeProjects: 99_900, reminderCount: 200, reminderOverdue: 20, reminderToday: 30, pendingAcceptance: 12, pendingInvoice: 18, pendingAmount: '123456.78' },
  stages: [
    { status: 'pending_entry', count: 20_000, averageDays: 3, inflow: 0, outflow: 0 },
    { status: 'pending_execution', count: 20_000, averageDays: 4, inflow: 0, outflow: 0 },
    { status: 'executing', count: 20_000, averageDays: 5, inflow: 0, outflow: 0 },
    { status: 'pending_acceptance', count: 15_000, averageDays: 2, inflow: 0, outflow: 0 },
    { status: 'pending_invoice', count: 15_000, averageDays: 2, inflow: 0, outflow: 0 },
    { status: 'completed', count: 10_000, averageDays: 1, inflow: 0, outflow: 0 },
  ],
  reminderPreview: firstProjects.slice(0, 3).map((row) => ({ projectId: row.id, customerName: row.customerName, ecc: row.ecc, tempNo: row.tempNo, reminderAt: row.reminderAt, reminderNote: row.reminderNote, reminderDueClass: row.reminderDueClass })),
  reminderTotal: 200, reminderWindowDays: 7,
};

function page(rows = firstProjects, cursor: string | null = 'cursor-2', total = 100_000, revision = 1): WorkbenchV2ProjectPageDto {
  return { businessRevision: revision, projects: rows, total, nextCursor: cursor, limit: 50 };
}

function section(kind: WorkbenchV2SectionPageDto['kind'], projectId = 'p-1'): WorkbenchV2SectionPageDto {
  const rows: WorkbenchV2SectionPageDto['rows'] = kind === 'instruments'
    ? Array.from({ length: 25 }, (_, index) => ({ kind: 'instruments' as const, id: `i-${index}`, projectId, batchId: null, name: `仪器 ${index}`, model: null, serialNo: `SN-${index}`, ups: false, qrRequested: false, destinationShipToId: null, createdAt: '2026-08-08T00:00:00Z' }))
    : kind === 'invoices'
      ? [{ kind: 'invoices' as const, id: 'inv-1', projectId, amount: '40000.00', invoicedAt: '2026-08-08T00:00:00Z', active: true, revokedAt: null, revokeReason: null, lastModifiedAt: '2026-08-08T00:00:00Z', createdAt: '2026-08-08T00:00:00Z' }]
      : [];
  return { businessRevision: 1, kind, projectId, rows, total: rows.length, nextCursor: null, limit: 50 };
}

function mockApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  const api = {
    getCapabilities: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ initialized: true, autoBackupError: null }),
    getSession: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }),
    initializeAccount: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人', recoveryCode: 'RECOVERY' }),
    login: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }), resetPassword: vi.fn(),
    v2Overview: vi.fn().mockResolvedValue(overview),
    v2ProjectPage: vi.fn().mockImplementation((request: { cursor?: string | null }) => Promise.resolve(request.cursor ? page(secondProjects, null) : page())),
    v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => Promise.resolve({ businessRevision: 1, project: [...firstProjects, ...secondProjects].find((row) => row.id === projectId) ?? null, detail: { managerApprovalReason: null, managerApprovalMissing: null, oldSiteContact: null, newSiteContact: null, oldSiteAddress: null, newSiteAddress: null, contractStartDate: null, contractEndDate: null, planVisitAt: null, planTransportAt: null, siteConfirmed: false, actualInstallDoneAt: null, acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null, temporaryInstrumentCount: null, createdAt: '2026-08-01T00:00:00Z', customerId: 'c1', contractId: 'ct1' } })),
    v2SectionPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2SectionPageDto['kind']; projectId: string }) => Promise.resolve(section(request.kind, request.projectId))),
    v2IndependentPage: vi.fn().mockImplementation((request: { kind: string }) => Promise.resolve({ businessRevision: 1, kind: request.kind, rows: [], total: 0, nextCursor: null, limit: 50 })),
    v2LookupPage: vi.fn().mockImplementation((request: { kind: string }) => Promise.resolve({ businessRevision: 1, kind: request.kind, rows: [], total: 0, nextCursor: null, limit: 50 })),
    v2Mutate: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: ['overview', 'projects', 'project:p-1', 'sections:p-1'], changed: { projectId: 'p-1' } }),
    backupManual: vi.fn().mockResolvedValue({ canceled: false, path: '/tmp/backup.db' }), restoreFromBackup: vi.fn().mockResolvedValue({ canceled: true, restored: false }),
    buildReport: vi.fn().mockResolvedValue({ range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '', sections: [] }), drillDown: vi.fn().mockResolvedValue([]), exportReport: vi.fn().mockResolvedValue({ saved: true }),
    importWizard: { listDrafts: vi.fn().mockResolvedValue([]), createDraft: vi.fn(), openDraft: vi.fn(), deleteDraft: vi.fn(), saveStep: vi.fn(), downloadTemplate: vi.fn(), selectFiles: vi.fn(), pasteIntoCategory: vi.fn(), classifySheet: vi.fn(), setCategoryMode: vi.fn(), updateMapping: vi.fn(), queryRows: vi.fn(), patchCells: vi.fn(), addRow: vi.fn(), deleteRows: vi.fn(), validate: vi.fn(), saveConflictDecision: vi.fn(), cancelOperation: vi.fn(), summary: vi.fn(), commit: vi.fn(), settleInterrupted: vi.fn(), recover: vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: [] }), checkpoints: vi.fn(), undo: vi.fn(), redo: vi.fn(), onProgress: vi.fn().mockReturnValue(() => undefined) },
    ...overrides,
  };
  return api as unknown as WorkbenchApi;
}

beforeEach(() => { Object.defineProperty(window, 'workbench', { value: mockApi(), configurable: true }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openQuickAction(label: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: /高密项目队列/ });
  fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
  const menu = screen.getByRole('dialog');
  fireEvent.click(within(menu).getByRole('button', { name: new RegExp(label) }));
  return screen.getByRole('dialog');
}

describe('Oracle #10 bounded workbench renderer', () => {
  it('100k total 只渲染当前 50 项', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    expect(await screen.findByRole('heading', { name: '高密项目队列 100000' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getByText('第 1–50 项 / 共 100000 项')).toBeInTheDocument();
  });

  it('阶段、提醒、区域和查询筛选下推并重置到首页 cursor', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /执行中.*20000.*平均 5 天/ }, { timeout: 5_000 }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: 'executing' })));
    fireEvent.change(screen.getByLabelText('提醒'), { target: { value: 'overdue' } }); fireEvent.change(screen.getByLabelText('区域'), { target: { value: '华东' } }); fireEvent.change(screen.getByLabelText('查找项目'), { target: { value: 'ECC-9' } }); fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: 'executing', reminder: 'overdue', region: '华东', query: 'ECC-9' })));
  });

  it('项目分页使用 cursor 栈，旧页响应不能覆盖新筛选结果', async () => {
    const resolvers: Array<(value: WorkbenchV2ProjectPageDto) => void> = [];
    const api = mockApi({ v2ProjectPage: vi.fn().mockImplementation(() => new Promise<WorkbenchV2ProjectPageDto>((resolve) => resolvers.push(resolve))) }); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await waitFor(() => expect(resolvers).toHaveLength(1)); fireEvent.change(screen.getByLabelText('查找项目'), { target: { value: '最新' } }); fireEvent.click(screen.getByRole('button', { name: '筛选' })); await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!(page([project(999)], null, 1, 2)); expect((await screen.findAllByText('客户 999')).length).toBeGreaterThan(0); resolvers[0]!(page(firstProjects, 'cursor-2', 100_000, 1)); await new Promise((resolve) => setTimeout(resolve, 0)); expect(within(screen.getByRole('grid')).queryByText('客户 1')).not.toBeInTheDocument();
  });

  it('详情 tab 按需加载，项目总览不读取 section', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ }); await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledWith('p-1')); expect(api.v2SectionPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '搬迁仪器' })); await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', kind: 'instruments', limit: 50 })));
  });

  it('mutation 仅走 v2Mutate，并按 tags 局部刷新', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ }); const beforeOverview = vi.mocked(api.v2Overview!).mock.calls.length; const beforeProjects = vi.mocked(api.v2ProjectPage!).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '维护提醒' })); fireEvent.change(screen.getByLabelText('备注内容'), { target: { value: '局部刷新' } }); fireEvent.click(screen.getByRole('button', { name: '保存当前提醒' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'set_reminder', projectId: 'p-1', reminderNote: '局部刷新' }))); await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(beforeOverview)); expect(vi.mocked(api.v2ProjectPage!).mock.calls.length).toBeGreaterThan(beforeProjects);
  });

  it('mutation 后项目被当前筛选移除时稳定选择并聚焦下一行', async () => {
    let reads = 0;
    const api = mockApi({ v2ProjectPage: vi.fn().mockImplementation(() => Promise.resolve(reads++ === 0 ? page([project(1)], null, 1) : page([project(2)], null, 1, 2))) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await within(await screen.findByRole('grid')).findByText('客户 1');
    fireEvent.click(screen.getByRole('button', { name: '维护提醒' })); fireEvent.change(screen.getByLabelText('备注内容'), { target: { value: '触发筛出' } }); fireEvent.click(screen.getByRole('button', { name: '保存当前提醒' }));
    const nextRow = await screen.findByRole('row', { name: /客户 2/ }); await waitFor(() => expect(nextRow).toHaveAttribute('aria-selected', 'true')); await waitFor(() => expect(nextRow).toHaveFocus());
  });

  it('动作选项只加载当前项目有界 section 页', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ }); fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]); fireEvent.click(within(screen.getByRole('dialog')).getByText('上门活动', { selector: 'strong' }).closest('button')!);
    await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', kind: 'instruments', limit: 25 }))); expect(within(screen.getByRole('dialog')).getAllByRole('option').length).toBeLessThanOrEqual(30);
  });

  it('项目队列支持 roving focus 与方向/Home/End/Enter/PageDown', async () => {
    render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ }); const rows = screen.getAllByRole('row').slice(1); rows[0]!.focus(); fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); expect(rows[1]).toHaveFocus(); fireEvent.keyDown(rows[1]!, { key: 'End' }); expect(rows.at(-1)).toHaveFocus(); fireEvent.keyDown(rows.at(-1)!, { key: 'Home' }); expect(rows[0]).toHaveFocus(); fireEvent.keyDown(rows[0]!, { key: ' ' }); expect(rows[0]).toHaveAttribute('aria-selected', 'true'); fireEvent.keyDown(rows[0]!, { key: 'PageDown' }); expect(await screen.findByText('客户 51')).toBeInTheDocument();
  });

  it('历史导入返回后刷新 overview 与项目首页并恢复入口焦点', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ }); fireEvent.click(screen.getByText('数据管理')); const entry = screen.getByRole('button', { name: '历史数据导入' }); fireEvent.click(entry); expect(await screen.findByRole('heading', { name: '把旧数据整理成一份可核对的导入计划' })).toBeInTheDocument(); const before = vi.mocked(api.v2Overview!).mock.calls.length; fireEvent.click(screen.getByRole('button', { name: /返回数据管理/ })); await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(before)); await waitFor(() => expect(screen.getByRole('button', { name: '历史数据导入' })).toHaveFocus()); expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
  });

  it('任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色和真实瓶颈', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: '先处理提醒，再连续推进项目' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '关键运营指标' })).toHaveTextContent('活跃搬迁项目99900');
    const lifecycle = screen.getByRole('region', { name: '生命周期吞吐' });
    expect(lifecycle).toHaveTextContent('当前瓶颈：执行中');
    expect(lifecycle).toHaveTextContent('平均停留 5 天');
    expect(within(lifecycle).queryByText('客户 1')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /项目提醒快速处理/ })).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: '项目队列' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '当前上下文' })).toHaveClass('entered');
    expect(within(screen.getByRole('grid', { name: '项目队列' })).getByRole('row', { name: /^客户 1 / })).toHaveClass('project-status-executing');
  });

  it('上下文同时联动状态异常、提醒、金额闭环与非阻塞事项，提醒可直达对应项目', async () => {
    const row = { ...project(1), preEntryExecution: true, reminderNote: '先联系现场', nonBlocking: { pendingShipTo: 2, qrUnmarked: 1, repairs: 3 } };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue({ businessRevision: 1, project: row, detail: { managerApprovalReason: null, managerApprovalMissing: null, oldSiteContact: null, newSiteContact: null, oldSiteAddress: null, newSiteAddress: null, contractStartDate: null, contractEndDate: null, planVisitAt: null, planTransportAt: null, siteConfirmed: false, actualInstallDoneAt: null, acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null, temporaryInstrumentCount: null, createdAt: '', customerId: 'c1', contractId: 'ct1' } }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    expect(context).toHaveTextContent('未进单先执行');
    expect(context).toHaveTextContent('先联系现场');
    expect(context).toHaveTextContent('Ship-to 待处理 2');
    expect(context).toHaveTextContent('二维码待标记 1');
    expect(context).toHaveTextContent('损坏/维修 3');
    expect(within(context).getByLabelText('金额闭环')).toHaveTextContent('待掉票USD 60,000.00');
    fireEvent.click(within(screen.getByRole('region', { name: /项目提醒快速处理/ })).getByRole('button', { name: /客户 1/ }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ reminder: 'any', query: 'ECC-000001' })));
    expect(screen.getByRole('region', { name: /高密项目队列/ })).toHaveFocus();
  });

  it('向导明确必填、可后补和合同为 0 的反馈，弹层首字段聚焦且 Escape 可关闭', async () => {
    render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    const customer = within(dialog).getByRole('textbox', { name: /客户名称.*必填/ });
    await waitFor(() => expect(customer).toHaveFocus());
    expect(within(dialog).getByText(/标记“可后补”的字段/)).toBeInTheDocument();
    expect(within(dialog).getByText(/仅合同 USD 含税金额允许为 0/)).toBeInTheDocument();
    expect(within(dialog).getByRole('spinbutton', { name: /合同 USD 含税金额.*可后补/ })).toHaveAccessibleDescription(/最终可确认金额/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('新建搬迁项目分步向导：第一步输入不得残留到第二步同位置字段', async () => {
    render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '残留演示客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: '华东' } });
    fireEvent.change(within(dialog).getByLabelText(/合同 USD 含税金额/), { target: { value: '12345' } });
    fireEvent.change(within(dialog).getByLabelText(/合同开始日期/), { target: { value: '2026-08-01' } });
    fireEvent.change(within(dialog).getByLabelText(/合同截止日期/), { target: { value: '2027-08-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
    expect(within(dialog).getByLabelText(/旧址地址/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/新址地址/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/仪器名称/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/型号/)).toHaveValue('');
  });

  it('快速记录不混入二维码独立申请，十类动作均提供真实字段而非通用空表单', async () => {
    render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    const labels = ['搬迁批次', '搬迁仪器', '上门活动', '开单记录', '实际物流费用', '验收报告', '掉票', 'Ship-to 申请', '损坏/维修事项', '补齐进单核心资料'];
    for (const label of labels) {
      fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
      const menu = screen.getByRole('dialog');
      expect(within(menu).queryByRole('button', { name: '二维码申请' })).not.toBeInTheDocument();
      expect(within(menu).getByText(/二维码申请位于独立导航/)).toBeInTheDocument();
      fireEvent.click(within(menu).getByText(label, { selector: 'strong' }).closest('button')!);
      const form = screen.getByRole('dialog');
      expect(form.querySelectorAll('input,select').length, label).toBeGreaterThan(0);
      fireEvent.keyDown(document, { key: 'Escape' });
    }
  });

  it('开单、物流、仪器二维码与损坏维修表单给出对应字段约束和就地反馈', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    let dialog = await openQuickAction('开单记录');
    const orderNo = within(dialog).getByRole('textbox', { name: /服务单号.*必填/ }); const engineer = within(dialog).getByRole('textbox', { name: /工程师.*必填/ });
    expect(orderNo).toHaveAccessibleDescription(/同次创建开单记录/); expect(engineer).toHaveAccessibleDescription(/同一次保存/);
    fireEvent.change(orderNo, { target: { value: 'SO-100' } }); fireEvent.change(engineer, { target: { value: '工程师甲' } }); fireEvent.change(within(dialog).getByLabelText(/开单时间/), { target: { value: '2026-08-08T09:00' } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'order', values: expect.objectContaining({ serviceOrderNo: 'SO-100', engineer: '工程师甲' }) }) })));
    dialog = await openQuickAction('实际物流费用');
    const budget = within(dialog).getByRole('spinbutton', { name: /预算价格/ }); const deal = within(dialog).getByRole('spinbutton', { name: /成交价格/ });
    expect(budget).toHaveAttribute('min', '0.01'); fireEvent.change(budget, { target: { value: '100' } }); fireEvent.change(deal, { target: { value: '120' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('成交价格高于预算价格');
    fireEvent.keyDown(document, { key: 'Escape' });
    dialog = await openQuickAction('搬迁仪器');
    expect(within(dialog).getByRole('combobox', { name: /二维码是否申请.*必填/ })).toHaveAccessibleDescription(/不保存二维码地址/);
    fireEvent.keyDown(document, { key: 'Escape' });
    dialog = await openQuickAction('损坏/维修事项');
    expect(within(dialog).getByRole('spinbutton', { name: /备件金额.*必填/ })).toHaveAccessibleDescription(/合同金额为 0 时占比不可计算/);
  });

  it('队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口', async () => {
    render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '为客户 2快速记录' }));
    expect(screen.getByRole('dialog', { name: '快速记录' })).toHaveTextContent('十类项目动作');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(screen.getByRole('grid', { name: '项目队列' })).getByRole('row', { name: /^客户 2 / })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(screen.getByRole('complementary', { name: '当前上下文' })).getByRole('button', { name: '快速记录' }));
    expect(screen.getByRole('dialog', { name: '快速记录' })).toBeInTheDocument(); fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('tab', { name: '搬迁仪器' })); await waitFor(() => expect(screen.getByRole('tab', { name: '搬迁仪器' })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '就近记录' }));
    expect(screen.getByRole('dialog', { name: '搬迁仪器' })).toBeInTheDocument();
  });

  it('提交期间禁用并拦截重复保存，成功后显示 toast 且同步刷新失效数据', async () => {
    let resolveMutation!: (value: Awaited<ReturnType<NonNullable<WorkbenchApi['v2Mutate']>>>) => void;
    const api = mockApi({ v2Mutate: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; })) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const dialog = await openQuickAction('搬迁批次'); const save = within(dialog).getByRole('button', { name: '保存记录' }); const form = save.closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(api.v2Mutate).toHaveBeenCalledTimes(1); expect(save).toBeDisabled();
    const before = vi.mocked(api.v2Overview!).mock.calls.length;
    resolveMutation({ businessRevision: 2, invalidated: ['overview', 'projects', 'project:p-1'], changed: { projectId: 'p-1' } });
    expect(await screen.findByText('业务记录已保存')).toHaveAttribute('role', 'status');
    await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(before));
  });

  it('报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示', async () => {
    const api = mockApi({ exportReport: vi.fn().mockImplementation((format: string) => format === 'png' ? Promise.reject(new Error('磁盘不可写')) : Promise.resolve({ saved: true })) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '运营报表' })); const dialog = screen.getByRole('dialog', { name: '运营报表' });
    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-07' } }); fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } }); fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    expect(await within(dialog).findByRole('button', { name: '导出 Excel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '导出 PNG' })).toBeInTheDocument(); expect(within(dialog).getByRole('button', { name: '导出 PDF' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 PNG' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('导出失败：磁盘不可写');
  });

  it('独立导航打开序列号地址更新与二维码申请，二维码支持有名称的多选类型', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '序列号地址更新' })); let dialog = screen.getByRole('dialog', { name: '序列号地址更新' });
    expect(within(dialog).getByRole('combobox', { name: /搬迁仪器.*必填/ })).toBeInTheDocument(); expect(within(dialog).getByRole('textbox', { name: /序列号.*必填/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(screen.getByRole('button', { name: '二维码申请' })); dialog = screen.getByRole('dialog', { name: '二维码申请' });
    const group = within(dialog).getByRole('group', { name: /申请类型.*必填.*可多选/ });
    const instrument = within(group).getByRole('checkbox', { name: '仪器服务' }); const logistics = within(group).getByRole('checkbox', { name: '物流管理' });
    fireEvent.click(instrument); fireEvent.click(logistics); fireEvent.change(within(dialog).getByRole('textbox', { name: /申请人.*必填/ }), { target: { value: '负责人' } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'qr_request', values: expect.objectContaining({ types: ['A', 'logistics_management'] }) }) })));
  });
});
