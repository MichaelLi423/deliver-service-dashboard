import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { createManualBackup } from '../../src/domain/capabilities/local-data-persistence/backup';
import { restoreFromBackup } from '../../src/domain/capabilities/local-data-persistence/restore';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { SystemClock } from '../../src/domain/core/time';
import { IPC_CHANNELS, type AccountSessionInfo, type IpcChannel, type ProjectWizardPayload, type WorkbenchV2MutationRequest } from '../../src/shared/ipc';
import {
  registerIpcHandlers,
  type IpcBus,
  type IpcEvent,
  type IpcHandlerDeps,
} from '../../src/main/ipc-handlers';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { establishLocalSession } from '../helpers/establish-session';
import type { ImportWizardFacade } from '../../src/main/import-wizard-facade';

/** 未配置的导入向导 facade 桩（本测试只验证非导入通道；导入通道在独立测试覆盖）。 */
function stubFacade(): ImportWizardFacade {
  const stub = new Proxy({}, {
    get: () => () => {
      throw new Error('导入向导 facade 未在测试中配置');
    },
  });
  return stub as unknown as ImportWizardFacade;
}

/**
 * 真实 IPC handler 级测试（Oracle #10 迁移为 v2 通道；旧 snapshot/整份快照 mutation
 * 通道已删除，守卫与边界以 v2 通道验证）：
 * - 通过可注入的 IPC 总线注册 main/ipc-handlers 中的真实 handler，逐通道调用。
 * - 未登录（v2 读取/mutation、ship-to、report/export、backup/restore）与
 *   非受信主窗口调用一律拒绝。
 * - 金额边界为十进制字符串，由主进程 Money 精确解析（HALF_UP）。
 * - cancel 走 v2 mutation 专用命令；恢复成功后清空会话强制重新登录。
 */

class FakeBus implements IpcBus {
  readonly handlers = new Map<string, (event: IpcEvent, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: IpcChannel, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`未注册通道: ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: { url: "http://localhost:3000/" } }, ...args);
  }
}

function makeContext(dir: string) {
  let db = bootstrapDatabase({ dataDir: dir }).db;
  const dbPath = join(dir, 'workbench.db');
  let session: AccountSessionInfo | null = null;
  let autoBackupError: string | null = null;
  let trustedSenderId: number | null = 100;
  const accountService = () => new LocalAccountService(new SqliteAccountRepository(db));
  const deps: IpcHandlerDeps = {
    db: () => db,
    dbPath: () => dbPath,
    dataDir: () => dir,
    accountService,
    session: () => session,
    setSession: (s) => {
      session = s;
    },
    trustedSenderId: () => trustedSenderId,
    trustedSenderOrigin: () => "http://localhost:3000/",
    autoBackupError: () => autoBackupError,
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    createManualBackup: (targetDir) => createManualBackup(db, targetDir, { clock: new SystemClock() }),
    restoreFromBackup: (backupPath) =>
      restoreFromBackup({
        backupPath,
        dbPath,
        snapshotDir: join(dir, 'restore-snapshots'),
        currentDb: db,
        closeConnection: () => {
          closeDatabase(db);
        },
        openConnection: () => {
          db = openDatabase({ path: dbPath });
        },
        clock: new SystemClock(),
      }),
    importWizardFacade: stubFacade,
    importWizardEnabled: () => true,
    importWizardError: () => null,
  };
  return {
    dbPath,
    deps,
    bus: new FakeBus(),
    session: () => session,
    setTrustedSender: (id: number | null) => {
      trustedSenderId = id;
    },
    setAutoBackupError: (message: string | null) => {
      autoBackupError = message;
    },
  };
}

/** 无密码模式：经账号服务确保本地账号并写入会话（主进程启动/恢复同款接线）。 */
async function establishSession(ctx: ReturnType<typeof makeContext>): Promise<AccountSessionInfo> {
  return establishLocalSession(ctx.deps.accountService, ctx.deps.setSession);
}

/** 需登录的 v2/业务通道清单：未登录时全部应拒绝（除账号初始化/登录/恢复/状态查询）。 */
const SESSION_REQUIRED_CHANNELS: IpcChannel[] = [
  IPC_CHANNELS.workbenchV2Overview,
  IPC_CHANNELS.workbenchV2ProjectPage,
  IPC_CHANNELS.workbenchV2ProjectDetail,
  IPC_CHANNELS.workbenchV2SectionPage,
  IPC_CHANNELS.workbenchV2IndependentPage,
  IPC_CHANNELS.workbenchV2LookupPage,
  IPC_CHANNELS.workbenchV2Mutate,
  IPC_CHANNELS.shipToCreateRequest,
  IPC_CHANNELS.shipToSubmitRequest,
  IPC_CHANNELS.reportBuild,
  IPC_CHANNELS.reportDrillDown,
  IPC_CHANNELS.reportExport,
  IPC_CHANNELS.backupManual,
  IPC_CHANNELS.restoreFromBackup,
];

/** 项目向导 payload（v2Mutate create_project 使用）。 */
const PROJECT_PAYLOAD = (overrides: Partial<ProjectWizardPayload> = {}): ProjectWizardPayload => ({
  intent: 'formal',
  customerName: 'IPC客户',
  ecc: 'ECC-IPC-001',
  region: '华东',
  contractStartDate: '2026-08-01',
  contractEndDate: '2027-07-31',
  oldSiteAddress: '旧址',
  newSiteAddress: '新址',
  instrumentCount: 1,
  contractAmount: '50000',
  finalAmount: '50000',
  siteConfirmed: false,
  ...overrides,
});

describe('IPC handler 安全边界（未登录/非受信主窗口一律拒绝）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  it('未登录时 v2/报表/备份/恢复全部拒绝，不进入业务逻辑', async () => {
    const dir = makeTempDir('ipc-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);

    for (const channel of SESSION_REQUIRED_CHANNELS) {
      await expect(ctx.bus.invoke(channel, 100)).rejects.toThrow(/登录状态已失效/);
    }
    // 守卫在先：伪造 sender 的调用方被受信主窗口校验拦截（会话校验之前）
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 999)).rejects.toThrow(/受信主窗口/);
  });

  it('建立会话后仍拒绝非受信主窗口调用', async () => {
    const dir = makeTempDir('ipc-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);

    // 受信 sender id=100 正常
    await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 100);
    // 非受信 sender → 拒绝
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 101)).rejects.toThrow(/受信主窗口/);
    // 窗口不存在（trustedSenderId=null）→ 拒绝
    ctx.setTrustedSender(null);
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 100)).rejects.toThrow(/受信主窗口/);
  });

  it('账号状态/会话查询不要求会话；会话由主进程自动建立，且自动备份失败状态传到工作台', async () => {
    const dir = makeTempDir('ipc-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    ctx.setAutoBackupError('磁盘空间不足，自动备份失败');
    expect(await ctx.bus.invoke(IPC_CHANNELS.accountGetStatus, 100)).toEqual({
      initialized: false,
      autoBackupError: '磁盘空间不足，自动备份失败',
    });
    // 无密码模式：主进程启动/恢复时经 ensureLocalSession 自动建号并写入会话。
    const session = await establishSession(ctx);
    expect(session.username).toBe('本地用户');
    expect(ctx.session()).toMatchObject({ username: '本地用户' });
    expect(await ctx.bus.invoke(IPC_CHANNELS.accountGetSession, 100)).toEqual(ctx.session());
    expect(await ctx.bus.invoke(IPC_CHANNELS.accountGetStatus, 100)).toEqual({
      initialized: true,
      autoBackupError: '磁盘空间不足，自动备份失败',
    });
  });
});

describe('金额 IPC 边界（十进制字符串 → 主进程 Money 精确解析）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  async function loggedInBus() {
    const dir = makeTempDir('ipc-money-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx.bus;
  }

  it('decimal 字符串精确转分（HALF_UP），renderer 侧无 Number(value)*100 参与', async () => {
    const bus = await loggedInBus();
    const created = (await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: PROJECT_PAYLOAD({ contractAmount: '0.1', finalAmount: '1234.567' }),
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    const detail = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId)) as {
      project: { contractAmount: string | null; finalAmount: string | null; id: string };
    };
    expect(detail.project.contractAmount).toBe('0.10'); // 0.1 元 = 10 分 → 十进制字符串
    expect(detail.project.finalAmount).toBe('1234.57'); // 1234.567 元 HALF_UP → 123457 分

    // 掉票金额同样按十进制字符串精确入账（v2 详情金额为十进制字符串，不引入 Number 精度）
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '12.34' } },
    } as WorkbenchV2MutationRequest);
    const after = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId)) as {
      project: { invoicedAmount: string };
    };
    expect(after.project.invoicedAmount).toBe('12.34');
  });

  it('超过 MAX_SAFE_INTEGER 的金额经 v2 detail/report IPC 往返保持精确（十进制字符串）', async () => {
    const bus = await loggedInBus();
    // 9007199254740993n 分 = Number.MAX_SAFE_INTEGER + 1
    const BIG_DEC = '90071992547409.93';
    const created = (await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: PROJECT_PAYLOAD({
        customerName: '超精度客户',
        ecc: 'ECC-BIG-001',
        contractAmount: BIG_DEC,
        finalAmount: BIG_DEC,
        actualInstallDoneAt: '2026-08-08',
      }),
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    const detail = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId)) as {
      project: { contractAmount: string | null; finalAmount: string | null; invoicedAmount: string };
    };
    expect(detail.project.contractAmount).toBe(BIG_DEC);
    expect(detail.project.finalAmount).toBe(BIG_DEC);
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-09' } },
    } as WorkbenchV2MutationRequest);
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: BIG_DEC } },
    } as WorkbenchV2MutationRequest);
    const invoiced = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId)) as {
      project: { invoicedAmount: string };
    };
    expect(invoiced.project.invoicedAmount).toBe(BIG_DEC);

    // 报表与下钻经显式 IPC 序列化：bigint → 十进制字符串，无 Number 退化
    const report = (await bus.invoke(IPC_CHANNELS.reportBuild, 100, {
      monthFrom: '2026-08',
      monthTo: '2026-08',
    } as never)) as { sections: Array<{ key: string; rows: Array<Record<string, unknown>> }> };
    const invRow = report.sections.find((s) => s.key === 'monthly_invoice_amount')?.rows?.[0];
    expect(invRow?.amountCents).toBe(BIG_DEC);
    const details = (await bus.invoke(IPC_CHANNELS.reportDrillDown, 100, 'monthly_invoice_amount', {
      monthFrom: '2026-08',
      monthTo: '2026-08',
    } as never)) as Array<Record<string, unknown>>;
    expect(details[0].amountCents).toBe(BIG_DEC);
  });

  it('非法金额格式在 main 侧 Money 解析即被拒绝（renderer 不解析金额）', async () => {
    const bus = await loggedInBus();
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        projectId: 'p-none',
        action: { type: 'invoice', projectId: 'p-none', values: { invoicedAt: '2026-08-11', amount: '12.34.5' } },
      } as WorkbenchV2MutationRequest),
    ).rejects.toThrow(/金额/);
  });
});

describe('取消项目命令（v2 adjust_status 拒绝 cancelled；cancel_project 记录时间原因）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  async function loggedInProject() {
    const dir = makeTempDir('ipc-cancel-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: PROJECT_PAYLOAD({ customerName: '取消客户', ecc: 'ECC-CANCEL-IPC', region: '西南' }),
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    return { bus: ctx.bus, projectId: created.changed.projectId };
  }

  it('adjust_status 拒绝 cancelled（取消走专用命令）', async () => {
    const { bus, projectId } = await loggedInProject();
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, { op: 'adjust_status', projectId, status: 'cancelled' } as never),
    ).rejects.toThrow(/cancelProject/);
  });

  it('cancel_project 合法：无掉票历史可取消（时间与原因一并持久化）', async () => {
    const { bus, projectId } = await loggedInProject();
    const result = (await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'cancel_project',
      projectId,
      time: '2026-08-12',
      reason: '客户业务调整',
    } as WorkbenchV2MutationRequest)) as { changed: { status: string } };
    expect(result.changed.status).toBe('cancelled');
    const detail = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId)) as {
      project: { status: string };
    };
    expect(detail.project.status).toBe('cancelled');
    // 已取消为终态：不可恢复
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, { op: 'adjust_status', projectId, status: 'executing' } as WorkbenchV2MutationRequest),
    ).rejects.toThrow(/已取消/);
  });

  it('cancel_project 非法：存在掉票历史（含已撤销）禁止取消，且状态不被修改', async () => {
    const { bus, projectId } = await loggedInProject();
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '10000' } },
    } as WorkbenchV2MutationRequest);
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'cancel_project',
        projectId,
        time: '2026-08-12',
        reason: '尝试取消',
      } as WorkbenchV2MutationRequest),
    ).rejects.toThrow(/掉票/);
    const detail = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId)) as {
      project: { status: string };
    };
    expect(detail.project.status).not.toBe('cancelled');
  });
});

describe('Ship-to 申请命令（按 requestId 线性推进、去重、工作量、完成态不回退）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  async function loggedInBus() {
    const dir = makeTempDir('ipc-shipto-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx.bus;
  }

  it('创建草稿→提交→完成按同一 requestId 线性推进；重复创建返回既有申请', async () => {
    const bus = await loggedInBus();
    // 创建草稿：返回该记录，不自动 submit
    const created = (await bus.invoke(IPC_CHANNELS.shipToCreateRequest, 100, {
      customerName: 'IPC客户',
      newSiteAddress: '新址IPC',
    })) as { request: { id: string; status: string; submittedAt: string | null } };
    expect(created.request.status).toBe('pending_submit');
    expect(created.request.submittedAt).toBeNull();
    const requestId = created.request.id;

    // 重复创建同客户同地址：返回既有申请，不新建
    const again = (await bus.invoke(IPC_CHANNELS.shipToCreateRequest, 100, {
      customerName: 'IPC客户',
      newSiteAddress: '新址IPC',
    })) as { request: { id: string; status: string } };
    expect(again.request.id).toBe(requestId);

    // 提交：pending → processing
    const submitted = (await bus.invoke(IPC_CHANNELS.shipToSubmitRequest, 100, requestId)) as {
      request: { status: string; submittedAt: string | null };
    };
    expect(submitted.request.status).toBe('processing');
    expect(submitted.request.submittedAt).toBeTruthy();

    // 完成：processing → completed（v2 mutation，补入 Account ID）
    const completed = (await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'ship_to_complete',
      requestId,
      accountId: 'ACC-IPC-1',
    } as WorkbenchV2MutationRequest)) as { changed: { status: string; accountId: string | null } };
    expect(completed.changed.status).toBe('completed');
    expect(completed.changed.accountId).toBe('ACC-IPC-1');

    // 完成态不回退：再次提交被领域拒绝
    await expect(bus.invoke(IPC_CHANNELS.shipToSubmitRequest, 100, requestId)).rejects.toThrow(/不可再次提交/);
    // 重复创建已完成申请：返回既有，不重复计工作量
    const finalAgain = (await bus.invoke(IPC_CHANNELS.shipToCreateRequest, 100, {
      customerName: 'IPC客户',
      newSiteAddress: '新址IPC',
    })) as { request: { id: string } };
    expect(finalAgain.request.id).toBe(requestId);
    const lookup = (await bus.invoke(IPC_CHANNELS.workbenchV2LookupPage, 100, {
      kind: 'ship_to_requests',
    })) as { total: number };
    expect(lookup.total).toBe(1);
  });
});

describe('掉票编辑/撤销（v2 invoice_edit / invoice_revoke）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  async function loggedInProject() {
    const dir = makeTempDir('ipc-invoice-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    // 正式进单 + 实际装机完成 + 验收 → 待掉票
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: PROJECT_PAYLOAD({
        customerName: '掉票IPC客户',
        ecc: 'ECC-INV-IPC',
        contractAmount: '2000',
        finalAmount: '2000',
        actualInstallDoneAt: '2026-08-08',
      }),
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-09' } },
    } as WorkbenchV2MutationRequest);
    await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } },
    } as WorkbenchV2MutationRequest);
    const section = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2SectionPage, 100, {
      projectId,
      kind: 'invoices',
    })) as { rows: Array<{ id: string }> };
    return { bus: ctx.bus, projectId, invoiceId: String(section.rows[0].id) };
  }

  it('编辑金额字符串精确解析（1234.567 → 123457 分 → 金额字符串 1234.57），撤销后为终态', async () => {
    const { bus, projectId, invoiceId } = await loggedInProject();
    // 编辑：Money 精确解析
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'invoice_edit',
      invoiceId,
      invoicedAt: '2026-08-12',
      amount: '1234.567',
    } as WorkbenchV2MutationRequest);
    const editedInvoices = (await bus.invoke(IPC_CHANNELS.workbenchV2SectionPage, 100, { projectId, kind: 'invoices' })) as {
      rows: Array<{ amount: string; active: boolean }>;
    };
    expect(editedInvoices.rows[0].amount).toBe('1234.57');
    expect(editedInvoices.rows[0].active).toBe(true);

    // 撤销 → 终态：active=false 且带撤销时间
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'invoice_revoke',
      invoiceId,
      time: '2026-08-13',
      reason: '客户更正',
    } as WorkbenchV2MutationRequest);
    const revokedInvoices = (await bus.invoke(IPC_CHANNELS.workbenchV2SectionPage, 100, { projectId, kind: 'invoices' })) as {
      rows: Array<{ active: boolean; revokedAt: string | null }>;
    };
    expect(revokedInvoices.rows[0].active).toBe(false);
    expect(revokedInvoices.rows[0].revokedAt).toBeTruthy();

    // 重复撤销 / 撤销后编辑：终态错误透传安全业务消息
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'invoice_revoke',
        invoiceId,
        time: '2026-08-14',
        reason: '再次撤销',
      } as WorkbenchV2MutationRequest),
    ).rejects.toThrow(/终态/);
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'invoice_edit',
        invoiceId,
        invoicedAt: '2026-08-14',
        amount: '2000',
      } as WorkbenchV2MutationRequest),
    ).rejects.toThrow(/终态/);
  });

  it('未登录时 v2 mutation 与其它业务通道一并拒绝', async () => {
    const dir = makeTempDir('ipc-invoice-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100)).rejects.toThrow(/登录状态已失效/);
    for (const channel of [IPC_CHANNELS.workbenchV2Mutate, IPC_CHANNELS.workbenchV2Overview]) {
      await expect(ctx.bus.invoke(channel, 100)).rejects.toThrow(/登录状态已失效/);
    }
  });
});

describe('手动备份/恢复（主进程 file dialog；恢复成功后自动恢复本地会话）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  async function restoreFromPath(ctx: ReturnType<typeof makeContext>, backupPath: string): Promise<{
    canceled: boolean;
    restored: boolean;
  }> {
    (ctx.deps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [backupPath],
    });
    return (await ctx.bus.invoke(IPC_CHANNELS.restoreFromBackup, 100)) as {
      canceled: boolean;
      restored: boolean;
    };
  }

  async function makeBackup(
    dataDir: string,
    seed: (db: import('node:sqlite').DatabaseSync) => Promise<void> = async () => undefined,
  ): Promise<string> {
    const backupSrc = bootstrapDatabase({ dataDir });
    await seed(backupSrc.db);
    const path = await createManualBackup(backupSrc.db, join(dataDir, 'backups'), {
      clock: new SystemClock(),
    });
    closeDatabase(backupSrc.db);
    return path;
  }

  it('恢复成功后自动取得/确保本地账号并恢复会话（空账号库自动建「本地用户」）；取消对话框不触碰会话', async () => {
    const dir = makeTempDir('ipc-restore-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    expect(ctx.session()).not.toBeNull();

    // 取消文件选择 → 会话保留
    (ctx.deps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await ctx.bus.invoke(IPC_CHANNELS.restoreFromBackup, 100)).toEqual({ canceled: true });
    expect(ctx.session()).not.toBeNull();

    // 备份源为全新数据库（无账号行）→ 恢复后自动建「本地用户」并恢复会话
    const backupPath = await makeBackup(makeTempDir('ipc-restore-src-'));
    const result = await restoreFromPath(ctx, backupPath);
    expect(result).toEqual({ canceled: false, restored: true });
    // 无密码模式：不再踢到登录页，恢复后会话自动建立
    expect(ctx.session()).not.toBeNull();
    expect(ctx.session()!.username).toBe('本地用户');
  });

  it('恢复含已有账号的备份：会话沿用原 username（既有账号不删除不迁移）', async () => {
    const dir = makeTempDir('ipc-restore-account-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    expect(ctx.session()!.username).toBe('本地用户');

    const backupSrcDir = makeTempDir('ipc-restore-account-src-');
    const backupPath = await makeBackup(backupSrcDir, async (db) => {
      await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
        username: '负责人',
        password: 'password1',
      });
    });

    const result = await restoreFromPath(ctx, backupPath);
    expect(result).toEqual({ canceled: false, restored: true });
    // 恢复后的账号为「负责人」，会话自动沿用该 username
    expect(ctx.session()!.username).toBe('负责人');
  });

  it('手动备份成功返回文件路径；未登录时 backup/restore 均被拒绝', async () => {
    const dir = makeTempDir('ipc-backup-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);

    // 未登录
    await expect(ctx.bus.invoke(IPC_CHANNELS.backupManual, 100)).rejects.toThrow(/登录状态已失效/);
    await expect(ctx.bus.invoke(IPC_CHANNELS.restoreFromBackup, 100)).rejects.toThrow(/登录状态已失效/);

    await establishSession(ctx);
    const targetDir = join(dir, 'manual-backups');
    (ctx.deps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [targetDir],
    });
    const result = (await ctx.bus.invoke(IPC_CHANNELS.backupManual, 100)) as { canceled: boolean; path: string };
    expect(result.canceled).toBe(false);
    expect(result.path).toContain('manual-');
    expect(result.path.endsWith('.db')).toBe(true);
  });
});
