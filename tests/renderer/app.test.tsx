// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/renderer/app';
import type {
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2IndependentRow,
  WorkbenchV2OverviewDto,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionPageDto,
} from '../../src/shared/ipc';

function project(index: number): WorkbenchProjectRow {
  return {
    id: `p-${index}`, tempNo: `TMP-${String(index).padStart(6, '0')}`, ecc: `ECC-${String(index).padStart(6, '0')}`,
    customerName: `客户 ${index}`, status: index % 2 ? 'executing' : 'pending_entry', formallyEntered: index % 2 === 1,
    preEntryExecution: index % 2 === 0, region: index % 2 ? '华东' : '华北', entryAt: null,
    reminderAt: index < 3 ? '2026-08-08' : null, reminderNote: index < 3 ? `提醒 ${index}` : null,
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
    : kind === 'batches'
      ? [{ kind: 'batches' as const, id: 'batch-1', projectId, planTransportDate: '2026-08-18', transportCompany: '华东运输', originalPrice: '1000.00', discountedPrice: '900.00', startedAt: null, createdAt: '2026-08-08T00:00:00Z' }]
      : kind === 'invoices'
        ? [{ kind: 'invoices' as const, id: 'inv-1', projectId, amount: '40000.00', invoicedAt: '2026-08-08', active: true, revokedAt: null, revokeReason: null, lastModifiedAt: '2026-08-08T00:00:00Z', createdAt: '2026-08-08T00:00:00Z' }]
        : [];
  return { businessRevision: 1, kind, projectId, rows, total: rows.length, nextCursor: null, limit: 50 };
}

function detailOf(projectRow: WorkbenchProjectRow | null): WorkbenchV2ProjectDetailDto {
  return {
    businessRevision: 1,
    project: projectRow,
    detail: {
      managerApprovalReason: null, managerApprovalMissing: null, oldSiteContact: null, newSiteContact: null,
      oldSiteAddress: null, newSiteAddress: null, contractStartDate: null, contractEndDate: null,
      planVisitAt: null, planTransportAt: null, siteConfirmed: false, actualInstallDoneAt: null,
      acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null,
      temporaryInstrumentCount: null, createdAt: '2026-08-01T00:00:00Z', customerId: 'c1', contractId: 'ct1',
    },
  };
}

function mockApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  const api = {
    getCapabilities: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ initialized: true, autoBackupError: null }),
    getSession: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }),
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
  await screen.findByRole('row', { name: /^客户 1 / });
  fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
  const menu = screen.getByRole('dialog');
  fireEvent.click(within(menu).getByRole('button', { name: new RegExp(label) }));
  return screen.getByRole('dialog');
}

/** 二维码表单实时预览中「本条记录 / 去重类型 / 计入工作量」三个统计行的文本。 */
function qrStat(dialog: HTMLElement, label: string): string | null {
  return within(dialog).getByText(label).parentElement?.textContent ?? null;
}

describe('Oracle #10 bounded workbench renderer', () => {
  it('无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '先处理提醒，再连续推进项目' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '首次使用初始化' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '登录本地工作台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '使用恢复码重置密码' })).not.toBeInTheDocument();
    expect(api.getSession).toHaveBeenCalled();
  });

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
    expect(within(lifecycle).getByRole('button', { name: /待进单.*20000/ })).toHaveClass('stage', 'not-entered');
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
    expect(context).toHaveTextContent('2026-08-08');
    expect(context).not.toHaveTextContent('09:00');
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

  it('新建向导补齐联系人和开单信息，并在第四步汇总后提交所选保存路径', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });

    expect(within(dialog).getByLabelText(/进单日期/)).not.toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '向导客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: '华东' } });
    fireEvent.change(within(dialog).getByLabelText(/进单日期/), { target: { value: '2026-08-09' } });
    fireEvent.change(within(dialog).getByLabelText(/旧址联系人/), { target: { value: '旧址王工' } });
    fireEvent.change(within(dialog).getByLabelText(/新址联系人/), { target: { value: '新址李工' } });
    fireEvent.change(within(dialog).getByLabelText(/合同 USD 含税金额/), { target: { value: '120000' } });
    fireEvent.change(within(dialog).getByLabelText(/合同开始日期/), { target: { value: '2026-08-01' } });
    fireEvent.change(within(dialog).getByLabelText(/合同截止日期/), { target: { value: '2027-07-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));

    fireEvent.change(within(dialog).getByLabelText(/旧址地址/), { target: { value: '旧址 A' } });
    fireEvent.change(within(dialog).getByLabelText(/新址地址/), { target: { value: '新址 B' } });
    fireEvent.change(within(dialog).getByLabelText(/仪器名称/), { target: { value: '质谱仪' } });
    fireEvent.change(within(dialog).getByLabelText(/型号/), { target: { value: 'MS-9' } });
    fireEvent.change(within(dialog).getByLabelText('UPS'), { target: { value: 'true' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));

    const orderNo = within(dialog).getByLabelText(/服务单号/);
    const engineers = within(dialog).getByLabelText(/参与工程师/);
    expect(orderNo).toHaveAccessibleDescription(/同次创建/);
    expect(engineers).toHaveAccessibleDescription(/必须补齐/);
    fireEvent.change(orderNo, { target: { value: 'SO-WIZ-001' } });
    fireEvent.change(engineers, { target: { value: '工程师甲、乙' } });
    fireEvent.change(within(dialog).getByLabelText(/开单备注/), { target: { value: '现场提前联系' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));

    expect(within(dialog).getByRole('heading', { name: '录入摘要' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('向导客户 / 华东');
    expect(dialog).toHaveTextContent('旧址王工 / 新址李工');
    expect(dialog).toHaveTextContent('SO-WIZ-001 · 工程师甲、乙');
    expect(within(dialog).getByRole('button', { name: /正式进单.*请先填写 ECC/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /未进单先执行.*经理批复/ })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-WIZ-001' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /正式进单.*校验进单日期/ }));

    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'create_project',
      payload: expect.objectContaining({
        intent: 'formal', customerName: '向导客户', entryAt: '2026-08-09',
        oldSiteContact: '旧址王工', newSiteContact: '新址李工', serviceOrderNo: 'SO-WIZ-001',
        engineers: '工程师甲、乙', serviceOrderNote: '现场提前联系', ecc: 'ECC-WIZ-001',
      }),
    })));
  });

  it('快速记录移除独立物流费用入口，九类动作均提供真实字段而非通用空表单', async () => {
    render(<App />); await screen.findByRole('row', { name: /^客户 1 / });
    const labels = ['搬迁批次', '搬迁仪器', '上门活动', '开单记录', '验收报告', '掉票', 'Ship-to 申请', '损坏/维修事项', '补齐进单核心资料'];
    for (const label of labels) {
      fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
      const menu = screen.getByRole('dialog');
      expect(within(menu).getAllByRole('button')).toHaveLength(10);
      expect(menu).toHaveTextContent('九类项目动作');
      expect(menu).not.toHaveTextContent('实际物流费用');
      expect(within(menu).queryByRole('button', { name: '二维码申请' })).not.toBeInTheDocument();
      expect(within(menu).getByText(/二维码申请位于独立导航/)).toBeInTheDocument();
      fireEvent.click(within(menu).getByText(label, { selector: 'strong' }).closest('button')!);
      const form = screen.getByRole('dialog');
      expect(form.querySelectorAll('input,select').length, label).toBeGreaterThan(0);
      fireEvent.keyDown(document, { key: 'Escape' });
    }
  });

  it('开单、合并批次、仪器二维码与损坏维修表单给出对应字段约束和就地反馈', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    let dialog = await openQuickAction('开单记录');
    const orderNo = within(dialog).getByRole('textbox', { name: /服务单号.*必填/ }); const engineer = within(dialog).getByRole('textbox', { name: /工程师.*必填/ });
    expect(orderNo).toHaveAccessibleDescription(/同次创建开单记录/); expect(engineer).toHaveAccessibleDescription(/同一次保存/);
    fireEvent.change(orderNo, { target: { value: 'SO-100' } }); fireEvent.change(engineer, { target: { value: '工程师甲' } }); fireEvent.change(within(dialog).getByLabelText(/开单日期/), { target: { value: '2026-08-08' } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'order', values: expect.objectContaining({ serviceOrderNo: 'SO-100', engineer: '工程师甲' }) }) })));
    dialog = await openQuickAction('搬迁批次');
    const planDate = within(dialog).getByLabelText(/计划运输日期.*必填/);
    const company = within(dialog).getByLabelText(/运输公司.*可后补/);
    const appliedAt = within(dialog).getByLabelText(/费用登记日期.*必填/);
    const budget = within(dialog).getByRole('spinbutton', { name: /合同预算价.*必填/ });
    const deal = within(dialog).getByRole('spinbutton', { name: /物流成交价.*必填/ });
    expect(planDate).toBeRequired(); expect(company).not.toBeRequired(); expect(appliedAt).toBeRequired();
    expect(budget).toBeRequired(); expect(deal).toBeRequired(); expect(budget).toHaveAttribute('min', '0.01'); expect(deal).toHaveAttribute('min', '0.01');
    fireEvent.change(planDate, { target: { value: '2026-08-18' } }); fireEvent.change(company, { target: { value: '华东运输' } }); fireEvent.change(appliedAt, { target: { value: '2026-08-09' } }); fireEvent.change(budget, { target: { value: '100' } }); fireEvent.change(deal, { target: { value: '120' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('物流成交价高于合同预算价');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'submit_action', action: {
        type: 'batch', projectId: 'p-1', values: { planTransportDate: '2026-08-18', transportCompany: '华东运输', appliedAt: '2026-08-09', budgetPrice: '100', dealPrice: '120' },
      },
    })));
    dialog = await openQuickAction('搬迁仪器');
    expect(within(dialog).getByRole('combobox', { name: /二维码是否申请.*必填/ })).toHaveAccessibleDescription(/不保存二维码地址/);
    fireEvent.keyDown(document, { key: 'Escape' });
    dialog = await openQuickAction('损坏/维修事项');
    expect(within(dialog).getByRole('spinbutton', { name: /备件金额.*必填/ })).toHaveAccessibleDescription(/合同金额为 0 时占比不可计算/);
  });

  it('队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口', async () => {
    render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '为客户 2快速记录' }));
    expect(screen.getByRole('dialog', { name: '快速记录' })).toHaveTextContent('九类项目动作');
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
    fireEvent.change(within(dialog).getByLabelText(/计划运输日期/), { target: { value: '2026-08-18' } });
    fireEvent.change(within(dialog).getByLabelText(/费用登记日期/), { target: { value: '2026-08-09' } });
    fireEvent.change(within(dialog).getByLabelText(/合同预算价/), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByLabelText(/物流成交价/), { target: { value: '90' } });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(api.v2Mutate).toHaveBeenCalledTimes(1); expect(save).toBeDisabled();
    const before = vi.mocked(api.v2Overview!).mock.calls.length;
    resolveMutation({ businessRevision: 2, invalidated: ['overview', 'projects', 'project:p-1'], changed: { projectId: 'p-1' } });
    expect(await screen.findByText('业务记录已保存')).toHaveAttribute('role', 'status');
    await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(before));
  });

  it('搬迁批次行可预填编辑，并只提交约定字段且不修改费用登记日期', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('row', { name: /^客户 1 / });
    fireEvent.click(screen.getByRole('tab', { name: '搬迁批次' }));
    const budgetHeading = await screen.findByRole('columnheader', { name: '合同预算价' });
    const table = budgetHeading.closest('table')!;
    expect(table).toHaveTextContent('合同预算价'); expect(table).toHaveTextContent('物流成交价');
    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑搬迁批次' });
    expect(dialog).toHaveTextContent('费用登记日期保持首次登记月份');
    expect(within(dialog).queryByLabelText(/费用登记日期/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/计划运输日期/)).toHaveValue('2026-08-18');
    expect(within(dialog).getByLabelText(/运输公司/)).toHaveValue('华东运输');
    expect(within(dialog).getByLabelText(/合同预算价/)).toHaveValue(1000);
    expect(within(dialog).getByLabelText(/物流成交价/)).toHaveValue(900);
    fireEvent.change(within(dialog).getByLabelText(/计划运输日期/), { target: { value: '2026-08-20' } });
    fireEvent.change(within(dialog).getByLabelText(/运输公司/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/合同预算价/), { target: { value: '1100' } });
    fireEvent.change(within(dialog).getByLabelText(/物流成交价/), { target: { value: '950' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次修改' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({
      op: 'batch_edit', payload: { batchId: 'batch-1', planTransportDate: '2026-08-20', transportCompany: '', budgetPrice: '1100', dealPrice: '950' },
    }));
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

  it('独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '序列号地址更新' })); let dialog = screen.getByRole('dialog', { name: '序列号地址更新' });
    expect(within(dialog).getByRole('combobox', { name: /搬迁仪器.*必填/ })).toBeInTheDocument(); expect(within(dialog).getByRole('textbox', { name: /序列号.*必填/ })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/更新日期/)).toHaveAttribute('type', 'date');
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(screen.getByRole('button', { name: '二维码申请' })); dialog = screen.getByRole('dialog', { name: '二维码申请' });
    expect(within(dialog).getByLabelText(/申请日期/)).toHaveAttribute('type', 'date');
    const group = within(dialog).getByRole('group', { name: /申请类型/ });
    const typeLabels = ['A', 'B', 'C', 'D', '仅打包搬运精密仪器', 'OEM 设备', '临时标签', '项目验收单', '物流管理'];
    expect(within(group).getAllByRole('checkbox')).toHaveLength(typeLabels.length);
    for (const label of typeLabels) expect(within(group).getByRole('checkbox', { name: label })).toBeInTheDocument();
    expect(within(group).getByRole('checkbox', { name: 'A' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'B' })).toBeChecked();
    expect(qrStat(dialog, '本条记录')).toBe('本条记录1 条');
    expect(qrStat(dialog, '去重类型')).toBe('去重类型2 类');
    expect(qrStat(dialog, '计入工作量')).toBe('计入工作量2');
    fireEvent.click(within(group).getByRole('checkbox', { name: 'C' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: '仅打包搬运精密仪器' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: '物流管理' }));
    await waitFor(() => expect(qrStat(dialog, '去重类型')).toBe('去重类型5 类'));
    expect(qrStat(dialog, '计入工作量')).toBe('计入工作量5');
    expect(qrStat(dialog, '本条记录')).toBe('本条记录1 条');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /申请人.*必填/ }), { target: { value: '负责人' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存申请' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'qr_request', values: expect.objectContaining({ types: ['A', 'B', 'C', 'precise_instrument_packing_only', 'logistics_management'] }) }) })));
    expect(await screen.findByText('记录已保存')).toHaveAttribute('role', 'status');
  });

  it('二维码申请不选任何类型时阻止提交并就地提示', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '二维码申请' }));
    const dialog = screen.getByRole('dialog', { name: '二维码申请' });
    const group = within(dialog).getByRole('group', { name: /申请类型/ });
    fireEvent.click(within(group).getByRole('checkbox', { name: 'A' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'B' }));
    await waitFor(() => expect(qrStat(dialog, '去重类型')).toBe('去重类型0 类'));
    expect(qrStat(dialog, '计入工作量')).toBe('计入工作量0');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存申请' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('请至少选择一种二维码申请类型');
    expect(api.v2Mutate).not.toHaveBeenCalled();
  });

  it('二维码申请列表展示去重类型与工作量列，重复申请独立保留', async () => {
    const rows: WorkbenchV2IndependentRow[] = [
      { kind: 'qr_request', id: 'qr-1', applicant: '负责人甲', requestedAt: '2026-08-01', types: ['A', 'logistics_management'], workload: 2, createdAt: '2026-08-01T09:00:00+08:00' },
      { kind: 'qr_request', id: 'qr-2', applicant: '负责人乙', requestedAt: '2026-08-02', types: ['precise_instrument_packing_only', 'oem_equipment', 'temporary_label'], workload: 3, createdAt: '2026-08-02T10:00:00+08:00' },
    ];
    const api = mockApi({ v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'qr_request', rows, total: 2, nextCursor: null, limit: 50 }) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /高密项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '二维码申请' }));
    const dialog = screen.getByRole('dialog', { name: '二维码申请' });
    expect(within(dialog).getByRole('heading', { name: '申请记录' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('重复申请独立保留并分别计入工作量。');
    expect(await within(dialog).findByText('2 条')).toBeInTheDocument();
    const table = within(dialog).getByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    for (const header of ['申请人', '申请日期', '申请类型', '工作量']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    const tableRows = within(table).getAllByRole('row');
    expect(tableRows).toHaveLength(3);
    expect(within(tableRows[1]!).getByText('负责人甲')).toBeInTheDocument();
    expect(within(tableRows[1]!).getByText('2026-08-01')).toBeInTheDocument();
    expect(within(tableRows[1]!).getByText('A、物流管理')).toBeInTheDocument();
    expect(within(tableRows[1]!).getByRole('cell', { name: '2' })).toBeInTheDocument();
    expect(within(tableRows[2]!).getByText('仅打包搬运精密仪器、OEM 设备、临时标签')).toBeInTheDocument();
    expect(within(tableRows[2]!).getByRole('cell', { name: '3' })).toBeInTheDocument();
  });

  it('项目总览编辑资料预填分组字段，显式提交 false/空值并在成功后关闭刷新详情', async () => {
    const row = { ...project(1), customerName: '预填客户', region: '华南' };
    const loaded = detailOf(row);
    loaded.detail = {
      ...loaded.detail!, contractStartDate: '2026-01-01', contractEndDate: '2026-12-31',
      oldSiteContact: '旧址王工', newSiteContact: '新址李工', oldSiteAddress: '旧址 A', newSiteAddress: '新址 B',
      planVisitAt: '2026-08-10', planTransportAt: '2026-08-11', siteConfirmed: true,
    };
    let detailReads = 0;
    let resolveMutation!: (value: { businessRevision: number; invalidated: string[]; changed: { projectId: string } }) => void;
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockImplementation(() => Promise.resolve({ ...loaded, businessRevision: ++detailReads > 1 ? 2 : 1 })),
      v2Mutate: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: '预填客户' });
    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(dialog).getByRole('group', { name: '基本信息' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: '地点与联系人' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: '执行准备' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/客户名称/)).toHaveValue('预填客户');
    await waitFor(() => expect(within(dialog).getByLabelText(/客户名称/)).toHaveFocus());
    expect(within(dialog).getByLabelText(/合同开始日期/)).toHaveValue('2026-01-01');
    expect(within(dialog).getByLabelText(/计划上门日期/)).toHaveValue('2026-08-10');
    const siteConfirmed = within(dialog).getByRole('checkbox', { name: '现场条件已确认' });
    expect(siteConfirmed).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '  更新客户  ' } });
    fireEvent.change(within(dialog).getByLabelText(/新址联系人/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/新址地址/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/计划上门日期/), { target: { value: '' } });
    fireEvent.click(siteConfirmed);
    fireEvent.click(within(dialog).getByRole('button', { name: '保存项目资料' }));
    expect(within(dialog).getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(api.v2Mutate).toHaveBeenCalledWith({
      op: 'update_project',
      payload: {
        projectId: 'p-1', customerName: '更新客户', region: '华南',
        contractStartDate: '2026-01-01', contractEndDate: '2026-12-31',
        oldSiteContact: '旧址王工', newSiteContact: null, oldSiteAddress: '旧址 A', newSiteAddress: null,
        plannedVisitAt: null, plannedTransportAt: '2026-08-11', siteConfirmed: false,
      },
    });
    resolveMutation({ businessRevision: 2, invalidated: ['project:p-1'], changed: { projectId: 'p-1' } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument());
    await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledTimes(2));
  });

  it('正式进单项目谨慎更正进单合同资料，预填金额并在错误时保留表单反馈', async () => {
    const row = { ...project(1), entryAt: '2026-08-01', contractAmount: '0.00', finalAmount: '125000.50' };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue(detailOf(row)),
      v2Mutate: vi.fn().mockRejectedValue(new Error('ECC 已存在，未保存更正')),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: row.customerName });
    fireEvent.click(screen.getByRole('button', { name: '更正进单/合同资料' }));
    const dialog = screen.getByRole('dialog', { name: '更正进单/合同资料' });
    expect(dialog).toHaveTextContent('进单金额快照保留正式进单当时的口径');
    expect(within(dialog).getByLabelText(/^ECC/)).toHaveValue(row.ecc);
    expect(within(dialog).getByLabelText(/进单日期/)).toHaveValue('2026-08-01');
    expect(within(dialog).getByLabelText(/合同 USD 含税金额/)).toHaveValue(0);
    expect(within(dialog).getByLabelText(/最终可确认金额/)).toHaveValue(125000.5);
    expect(within(dialog).queryByLabelText(/仪器名称|序列号|服务单号/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/最终可确认金额/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更正' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('ECC 已存在，未保存更正'));
    expect(screen.getByRole('dialog', { name: '更正进单/合同资料' })).toBeInTheDocument();
    expect(api.v2Mutate).toHaveBeenCalledWith({
      op: 'update_project',
      payload: { projectId: 'p-1', ecc: row.ecc, entryAt: '2026-08-01', contractUsdTaxAmount: '0.00', finalConfirmableAmount: null },
    });
  });

  it('待进单项目不显示更正入口，继续使用补齐进单核心资料路径', async () => {
    const pending = { ...project(2), formallyEntered: false, status: 'pending_entry' as const, ecc: null, entryAt: null };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([pending], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue(detailOf(pending)),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: pending.customerName });
    expect(screen.queryByRole('button', { name: '更正进单/合同资料' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '补齐进单核心资料' }));
    expect(screen.getByRole('dialog', { name: '补齐进单核心资料' })).toBeInTheDocument();
  });

  it('提醒跨页选择且详情失败时详情面板不消失，稳定显示错误与重试并可在重试后恢复', async () => {
    const crossRow = { ...project(51), id: 'p-51', customerName: '跨页客户', ecc: 'ECC-000051', status: 'pending_entry' as const };
    const findProject = (id: string): WorkbenchProjectRow | null =>
      id === 'p-51' ? crossRow : [...firstProjects, ...secondProjects].find((row) => row.id === id) ?? null;
    let detailFailed = false;
    const api = mockApi({
      v2Overview: vi.fn().mockResolvedValue({
        ...overview,
        reminderPreview: [{
          projectId: 'p-51', customerName: '跨页客户', ecc: 'ECC-000051', tempNo: 'TMP-000051',
          reminderAt: '2026-08-08', reminderNote: '跨页提醒', reminderDueClass: 'today' as const,
        }],
      }),
      // 新筛选（ECC-000051）下项目不在当前页，用于复现 detail 为空且 selectedId 不在页内时面板消失。
      v2ProjectPage: vi.fn().mockImplementation((request: { cursor?: string | null; query?: string | null }) =>
        request.query === 'ECC-000051'
          ? Promise.resolve(page([], null, 0))
          : Promise.resolve(request.cursor ? page(secondProjects, null) : page()),
      ),
      v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => {
        if (projectId === 'p-51' && !detailFailed) {
          detailFailed = true;
          return Promise.reject(new Error('详情读取失败'));
        }
        return Promise.resolve(detailOf(findProject(projectId)));
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /高密项目队列/ });

    fireEvent.click(within(screen.getByRole('region', { name: /项目提醒快速处理/ })).getByRole('button', { name: /跨页客户/ }));

    // 原症状：详情请求失败 + 项目不在当前页时，整个面板（含错误与重试）消失。
    expect(await screen.findByText('详情读取失败')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: '重试详情' });
    expect(screen.getByRole('heading', { name: '未选择项目' })).toBeInTheDocument();

    // 重试仍按选中 id 重新读取详情，成功后跨页展示项目详情。
    fireEvent.click(retry);
    expect(await screen.findByRole('region', { name: '跨页客户' })).toBeInTheDocument();
    expect(vi.mocked(api.v2ProjectDetail!).mock.calls.filter(([id]) => id === 'p-51')).toHaveLength(2);
  });

  it('新建项目成功后清除隐藏筛选、回到首屏、刷新列表并自动选中新项目', async () => {
    const created = { ...project(1), id: 'p-new', customerName: '新建客户', ecc: 'ECC-NEW-001', status: 'pending_entry' as const };
    let projectCreated = false;
    const api = mockApi({
      // 创建前：普通查询返回首页，'隐藏条件' 查询返回空页；创建后：新项目出现在首页首位（revision 跟随 mutation）。
      v2ProjectPage: vi.fn().mockImplementation((request: { query?: string | null }) => {
        if (projectCreated) return Promise.resolve(page([created, ...firstProjects], null, 51, 2));
        if (request.query === '隐藏条件') return Promise.resolve(page([], null, 0));
        return Promise.resolve(page(firstProjects, null, 100_000));
      }),
      v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => {
        const row = projectId === 'p-new' ? created : [...firstProjects, ...secondProjects].find((r) => r.id === projectId) ?? null;
        return Promise.resolve({ ...detailOf(row), businessRevision: projectCreated ? 2 : 1 });
      }),
      v2Mutate: vi.fn().mockImplementation(() => {
        projectCreated = true;
        return Promise.resolve({
          businessRevision: 2,
          invalidated: ['overview', 'projects', 'project:p-new', 'sections:p-new'],
          changed: { projectId: 'p-new', created: true },
        });
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /高密项目队列/ });

    // 先设置会隐藏新项目的查询筛选。
    fireEvent.change(screen.getByLabelText('查找项目'), { target: { value: '隐藏条件' } });
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ query: '隐藏条件' })));

    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '新建客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: '华东' } });
    fireEvent.change(within(dialog).getByLabelText(/合同开始日期/), { target: { value: '2026-08-01' } });
    fireEvent.change(within(dialog).getByLabelText(/合同截止日期/), { target: { value: '2027-07-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
    fireEvent.change(within(dialog).getByLabelText(/旧址地址/), { target: { value: '旧址 A' } });
    fireEvent.change(within(dialog).getByLabelText(/新址地址/), { target: { value: '新址 B' } });
    fireEvent.change(within(dialog).getByLabelText(/仪器名称/), { target: { value: '质谱仪' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-NEW-001' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /正式进单.*校验进单日期/ }));

    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'create_project' })));
    // 弹层关闭，筛选清除并回到首屏。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建搬迁项目' })).not.toBeInTheDocument());
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: null, reminder: null, region: null, query: null })));
    // 新项目可见、被选中且详情按返回的 id 加载。
    const newRow = await screen.findByRole('row', { name: /新建客户/ });
    await waitFor(() => expect(newRow).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledWith('p-new'));
    expect(await screen.findByRole('region', { name: '新建客户' })).toBeInTheDocument();
  });
});
