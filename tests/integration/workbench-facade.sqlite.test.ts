import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  SqliteShipToAddressReader,
  SqliteShipToRepository,
  SqliteShipToRequestRepository,
} from '../../src/domain/capabilities/local-data-persistence';
import { ShipToService, type ShipToRepository } from '../../src/domain/capabilities/ship-to-management';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import type { ProjectWizardPayload, WorkbenchV2LookupRow, WorkbenchV2MutationResult } from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 工作台 application facade → 领域服务 → SQLite（Oracle #10 迁移为 v2 有界 API）：
 * 写动作一律经 v2Mutate（不携带 snapshot），读取经 v2Overview/detail/section/
 * independent/lookup；Ship-to 申请仍为独立 requestId 线性命令（仅返回受影响申请）。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function projectIdOf(result: WorkbenchV2MutationResult): string {
  return result.changed!.projectId!;
}

function wizard(overrides: Partial<ProjectWizardPayload> = {}): ProjectWizardPayload {
  return {
    intent: 'formal',
    customerName: '客户',
    region: '华东',
    contractStartDate: '2026-08-01',
    contractEndDate: '2027-07-31',
    oldSiteAddress: '旧址',
    newSiteAddress: '新址',
    instrumentName: '仪器',
    ups: false,
    siteConfirmed: false,
    ...overrides,
  };
}

async function makeFacade(): Promise<{ facade: WorkbenchFacade }> {
  const dir = makeTempDir('workbench-facade-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
  return { facade };
}

describe('工作台 application facade → 领域服务 → SQLite（v2 有界 API）', () => {
  it('真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '集成测试客户',
        ecc: 'ECC-UI-001',
        contractAmount: '100000',
        finalAmount: '100000',
        instrumentName: '质谱仪',
        model: 'MS-1',
        ups: true,
      }),
    });
    const projectId = projectIdOf(created);
    let detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.formallyEntered).toBe(true);
    expect(detail.ecc).toBe('ECC-UI-001');
    facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2026-08-09T09:00:00+08:00', reminderNote: '确认运输安排' });
    expect(facade.v2ProjectDetail(projectId).project!.reminderNote).toBe('确认运输安排');
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '测试运输公司', originalPrice: '12000', discountedPrice: '11000' } },
    });
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(1);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11T09:00', amount: '20000' } },
    });
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.invoicedAmount).toBe('20000.00');
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'qr_request', values: { applicant: '负责人', requestedAt: '2026-08-11T10:00', types: ['A', 'logistics_management'] } },
    });
    const qr = facade.v2IndependentPage({ kind: 'qr_request' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2IndependentPage']>['rows'][number],
      { kind: 'qr_request' }
    >;
    expect(qr.workload).toBe(2);
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    expect(report.sections.find((s) => s.key === 'monthly_invoice_amount')?.rows).toHaveLength(1);
  });

  it('人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '待进单客户', region: '华北' }),
    });
    const projectId = projectIdOf(created);
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId, status: 'completed' })).toThrow();
  });

  it('Ship-to 申请按 requestId 线性推进：创建草稿→提交→完成；重复创建/重复推进不重复申请与工作量', async () => {
    const { facade } = await makeFacade();
    // 创建草稿：API 返回该记录（不自动 submit），无提交时间不计工作量
    const created = facade.createShipToRequest({ customerName: 'ShipTo客户', newSiteAddress: '新址甲' });
    expect(created.request.status).toBe('pending_submit');
    expect(created.request.submittedAt).toBeNull();
    // 有界结果：仅受影响申请，不携带任何快照
    expect(Object.keys(created)).toEqual(['request']);
    const requestId = created.request.id;
    // 重复创建同客户同地址：返回既有申请，不新建
    const again = facade.createShipToRequest({ customerName: 'ShipTo客户', newSiteAddress: '新址甲' });
    expect(again.request.id).toBe(requestId);
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1);
    // 提交：pending → processing（记录首次提交时间）
    const submitted = facade.submitShipToRequest(requestId);
    expect(submitted.request.status).toBe('processing');
    expect(submitted.request.submittedAt).toBeTruthy();
    // 重复提交：领域拒绝（线性流转不可退回）
    expect(() => facade.submitShipToRequest(requestId)).toThrow(/不可退回|已提交/);
    // 完成：processing → completed（v2 mutation，补入 Account ID）
    const completed = facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-900' });
    expect(completed.changed).toMatchObject({ requestId, status: 'completed', accountId: 'ACC-900' });
    // 完成态不回退：再次提交/完成均被领域拒绝
    expect(() => facade.submitShipToRequest(requestId)).toThrow(/不可再次提交/);
    expect(() => facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-901' })).toThrow(/仅处理中/);
    // 工作量：仅首次提交计一次（草稿与后续状态更新不重复计数）
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const workload = report.sections.find((s) => s.key === 'ship_to_request_workload')?.rows ?? [];
    expect(workload).toHaveLength(1);
    expect(workload[0]).toMatchObject({ count: 1 });
  });

  it('Ship-to 组合快速动作幂等：pending 才 submit、processing 只允许 complete、completed 只返回不回退', async () => {
    const { facade } = await makeFacade();
    // 组合动作创建并推进到 completed（一次调用）
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: '幂等客户', newSiteAddress: '新址幂等', status: 'completed', accountId: 'ACC-IDEM-1' } },
    });
    const shipToRows = (): Array<Extract<WorkbenchV2LookupRow, { kind: 'ship_to_requests' }>> =>
      facade.v2LookupPage({ kind: 'ship_to_requests' }).rows as unknown as Array<
        Extract<WorkbenchV2LookupRow, { kind: 'ship_to_requests' }>
      >;
    const request = shipToRows().find((r) => r.accountId === 'ACC-IDEM-1');
    expect(request?.status).toBe('completed');
    // 重复调用同客户同地址：返回既有已完成申请，不新建、不回退、不重复计工作量
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: '幂等客户', newSiteAddress: '新址幂等', status: 'completed', accountId: 'ACC-IDEM-1' } },
    });
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1);
    expect(shipToRows()[0].status).toBe('completed');
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const workload = report.sections.find((s) => s.key === 'ship_to_request_workload')?.rows ?? [];
    expect(workload).toHaveLength(1);
    expect(workload[0]).toMatchObject({ count: 1 });
    // 已完成申请再次以 pending_submit 调用也不会回退
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: '幂等客户', newSiteAddress: '新址幂等', status: 'pending_submit' } },
    });
    expect(shipToRows()[0].status).toBe('completed');
  });

  it('掉票编辑/撤销：金额字符串精确编辑并更新报表/状态；撤销为终态；取消项目被拒', async () => {
    const { facade } = await makeFacade();
    // 正式进单 + 实际装机完成 + 验收 → 待掉票（金额闭环可重算）
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '掉票编辑客户',
        ecc: 'ECC-INV-EDIT',
        contractAmount: '2000',
        finalAmount: '2000',
        actualInstallDoneAt: '2026-08-08T18:00',
        instrumentName: '质谱仪',
        ups: true,
      }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-09' } } });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_invoice');
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11T09:00', amount: '1000' } } });
    let invoices = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows as Array<
      Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'invoices' }>
    >;
    expect(invoices[0].amount).toBe('1000.00'); // 金额为十进制字符串，不引入 Number 精度
    expect(invoices[0].active).toBe(true);
    const invoiceId = invoices[0].id;

    // 编辑：1234.567 → 123457 分（HALF_UP），金额字符串 '1234.57'
    facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-12T09:00', amount: '1234.567' });
    invoices = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows as Array<
      Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'invoices' }>
    >;
    expect(invoices[0].amount).toBe('1234.57');
    expect(facade.v2ProjectDetail(projectId).project!.invoicedAmount).toBe('1234.57');

    // 编辑至累计达到最终可确认金额 → 自动进入已完成（金额闭环）
    facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-12T09:00', amount: '2000' });
    let detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.invoicedAmount).toBe('2000.00');
    expect(detail.status).toBe('completed');
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const invRow = report.sections.find((s) => s.key === 'monthly_invoice_amount')?.rows?.[0] as Record<string, unknown>;
    expect(invRow.amountCents).toBe('2000.00'); // 报表 IPC 序列化：bigint → 十进制字符串

    // 撤销：撤销后为终态，不计入金额，状态回退到待掉票
    facade.v2Mutate({ op: 'invoice_revoke', invoiceId, time: '2026-08-13T09:00', reason: '客户更正' });
    invoices = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows as Array<
      Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'invoices' }>
    >;
    expect(invoices[0].active).toBe(false);
    expect(invoices[0].revokedAt).toBeTruthy();
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.invoicedAmount).toBe('0.00');
    expect(detail.status).toBe('pending_invoice');

    // 重复撤销 / 撤销后编辑：终态拒绝
    expect(() => facade.v2Mutate({ op: 'invoice_revoke', invoiceId, time: '2026-08-14T09:00', reason: '再次撤销' })).toThrow(/终态/);
    expect(() => facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-14T09:00', amount: '2000' })).toThrow(/终态/);

    // 取消项目：任何掉票历史（含已撤销）禁止取消
    expect(() => facade.v2Mutate({ op: 'cancel_project', projectId, time: '2026-08-15T09:00', reason: '客户取消' })).toThrow(/掉票/);
  });

  it('Ship-to complete 原子性：第二步不可变 Ship-to 落库失败时整体回滚，申请保持 processing 且无 Ship-to', async () => {
    const dir = makeTempDir('workbench-shipto-atomic-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
      // 注入第二步失败的 ShipToRepository（真实 SQLite：请求落库成功、Ship-to 创建失败）
      const realShipTos = new SqliteShipToRepository(db);
      const failingShipTos: ShipToRepository = {
        findById: (id) => realShipTos.findById(id),
        findByAccountId: (acc) => realShipTos.findByAccountId(acc),
        save: () => {
          throw new Error('第二步：不可变 Ship-to 落库失败');
        },
        listAll: () => realShipTos.listAll(),
      };
      const service = new ShipToService(failingShipTos, new SqliteShipToRequestRepository(db), new SqliteShipToAddressReader(db));
      const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }), { shipToService: service });
      const created = facade.createShipToRequest({ customerName: '原子客户', newSiteAddress: '新址原子' });
      const requestId = created.request.id;
      expect(created.request.status).toBe('pending_submit');
      expect(facade.submitShipToRequest(requestId).request.status).toBe('processing');
      // 完成：请求状态保存成功但第二步 Ship-to 落库失败 → 同一 SQLite 事务整体回滚
      expect(() => facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-ATOMIC-1' })).toThrow(/第二步/);
      const row = db.prepare('SELECT status, account_id FROM ship_to_requests WHERE id = ?').get(requestId) as { status: string; account_id: string | null };
      expect(row.status).toBe('processing');
      expect(row.account_id).toBeNull();
      expect((db.prepare('SELECT COUNT(*) AS n FROM ship_tos').get() as { n: number }).n).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('Ship-to complete 唯一冲突：目标 Account ID 已存在时拒绝，申请保持 processing 且不产生新 Ship-to', async () => {
    const dir = makeTempDir('workbench-shipto-conflict-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
      const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
      // 预置一条不可变 Ship-to（系统外已占用该 Account ID）
      db.prepare('INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)').run('ghost', 'ACC-CONFLICT', '其他客户', '其他地址', 't');
      const created = facade.createShipToRequest({ customerName: '冲突客户', newSiteAddress: '新址冲突' });
      const requestId = created.request.id;
      facade.submitShipToRequest(requestId);
      expect(() => facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-CONFLICT' })).toThrow(/已存在/);
      const row = db.prepare('SELECT status FROM ship_to_requests WHERE id = ?').get(requestId) as { status: string };
      expect(row.status).toBe('processing');
      expect((db.prepare('SELECT COUNT(*) AS n FROM ship_tos').get() as { n: number }).n).toBe(1); // 仅预置那条，未产生新的
    } finally {
      closeDatabase(db);
    }
  });
});
