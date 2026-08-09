import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import {
  IPC_CHANNELS,
  type AccountSessionInfo,
  type IpcChannel,
  type WorkbenchV2MutationRequest,
  type WorkbenchV2OverviewDto,
  type WorkbenchV2ProjectPageRequest,
} from '../../src/shared/ipc';
import {
  registerIpcHandlers,
  type IpcBus,
  type IpcEvent,
  type IpcHandlerDeps,
} from '../../src/main/ipc-handlers';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { establishLocalSession } from '../helpers/establish-session';
import type { ImportWizardFacade } from '../../src/main/import-wizard-facade';

/**
 * Oracle #10 v2 IPC 通道：
 * - v2 读取（overview/project-page/detail/section/independent/lookup）与 v2 mutation
 *   统一经会话 + 受信主窗口守卫；
 * - v2 mutation 返回有界结果（businessRevision + invalidate tags），不携带 snapshot。
 */

function stubFacade(): ImportWizardFacade {
  const stub = new Proxy({}, {
    get: () => () => {
      throw new Error('导入向导 facade 未在测试中配置');
    },
  });
  return stub as unknown as ImportWizardFacade;
}

class FakeBus implements IpcBus {
  readonly handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: IpcChannel, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`未注册通道: ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: { url: 'http://localhost:3000/' } }, ...args);
  }
}

function makeContext(dir: string) {
  let db = bootstrapDatabase({ dataDir: dir }).db;
  const dbPath = join(dir, 'workbench.db');
  let session: AccountSessionInfo | null = null;
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
    trustedSenderOrigin: () => 'http://localhost:3000/',
    autoBackupError: () => null,
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    writeFile: async () => undefined,
    createManualBackup: () => Promise.resolve(join(dir, 'manual.db')),
    restoreFromBackup: () => ({ restored: false }),
    importWizardFacade: stubFacade,
    importWizardEnabled: () => true,
    importWizardError: () => null,
  };
  return {
    db: () => db,
    deps,
    bus: new FakeBus(),
    session: () => session,
    setTrustedSender: (id: number | null) => {
      trustedSenderId = id;
    },
  };
}

/** 无密码模式：经账号服务确保本地账号并写入会话（主进程启动/恢复同款接线）。 */
async function establishSession(ctx: ReturnType<typeof makeContext>): Promise<AccountSessionInfo> {
  return establishLocalSession(ctx.deps.accountService, ctx.deps.setSession);
}

const V2_CHANNELS: IpcChannel[] = [
  IPC_CHANNELS.workbenchV2Overview,
  IPC_CHANNELS.workbenchV2ProjectPage,
  IPC_CHANNELS.workbenchV2ProjectDetail,
  IPC_CHANNELS.workbenchV2SectionPage,
  IPC_CHANNELS.workbenchV2IndependentPage,
  IPC_CHANNELS.workbenchV2LookupPage,
  IPC_CHANNELS.workbenchV2Mutate,
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('Oracle #10 v2 IPC：会话 + 受信主窗口守卫', () => {
  it('未登录时全部 v2 通道被拒绝；登录后正常', async () => {
    const dir = makeTempDir('ipc-v2-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);

    for (const channel of V2_CHANNELS) {
      await expect(ctx.bus.invoke(channel, 100)).rejects.toThrow(/登录状态已失效/);
    }
    // 非受信 sender 拒绝
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 999)).rejects.toThrow(/受信主窗口/);

    await establishSession(ctx);
    const overview = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 100)) as WorkbenchV2OverviewDto;
    expect(overview.businessRevision).toBe(0);
    expect(overview.metrics.totalProjects).toBe(0);
    expect(overview.reminderPreview).toEqual([]);
  });
});

describe('Oracle #10 v2 IPC：mutation 有界结果与写后读取', () => {
  async function loggedIn() {
    const dir = makeTempDir('ipc-v2-mut-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx;
  }

  it('v2Mutate create_project 返回 bounded 结果（revision + invalidate + changed），无 snapshot 字段', async () => {
    const ctx = await loggedIn();
    const before = readBusinessRevision(ctx.db());
    const request: WorkbenchV2MutationRequest = {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'IPC v2 客户',
        ecc: 'ECC-IPC-V2',
        region: '华东',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentName: '质谱仪',
        ups: true,
        contractAmount: '100000',
        finalAmount: '100000',
        siteConfirmed: false,
      },
    };
    const result = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, request)) as Record<string, unknown>;
    // bounded：只有业务修订 + 失效标签 + 变更引用，绝不含 projects/batches/... 快照
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.invalidated).toContain('overview');
    expect(result.invalidated).toContain('projects');

    // 写后读取：v2ProjectPage / detail 可见新项目
    const pageRequest: WorkbenchV2ProjectPageRequest = { query: 'IPC v2 客户' };
    const page = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, pageRequest)) as {
      projects: Array<{ id: string; customerName: string }>;
      total: number;
      businessRevision: number;
    };
    expect(page.total).toBe(1);
    expect(page.projects[0].customerName).toBe('IPC v2 客户');
    expect(page.businessRevision).toBeGreaterThan(before);

    const detail = (await ctx.bus.invoke(
      IPC_CHANNELS.workbenchV2ProjectDetail,
      100,
      page.projects[0].id,
    )) as { project: { contractAmount: string } };
    expect(detail.project.contractAmount).toBe('100000.00');
  });

  it('v2 mutation 后 businessRevision 递增（写后 invalidate 语义）', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '递增客户',
        ecc: 'ECC-REV-1',
        region: '华东',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentName: '仪器',
        ups: false,
        contractAmount: '1000',
        finalAmount: '1000',
        siteConfirmed: false,
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const r1 = readBusinessRevision(ctx.db());
    const reminded = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'set_reminder',
      projectId: created.changed.projectId,
      reminderAt: '2026-08-10T09:00',
      reminderNote: '跟进',
    } as WorkbenchV2MutationRequest)) as { businessRevision: number; invalidated: string[] };
    expect(reminded.businessRevision).toBeGreaterThan(r1);
    expect(reminded.invalidated).toContain(`project:${created.changed.projectId}`);
    // 页面提醒分类生效
    const page = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, {
      reminder: 'any',
    } as WorkbenchV2ProjectPageRequest)) as { projects: Array<{ reminderNote: string | null }> };
    expect(page.projects[0].reminderNote).toBe('跟进');
  });

  it('update_project 经 IPC 通道：资料更新落库并返回 bounded 失效标签', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'IPC 更新客户',
        ecc: 'ECC-UPD-IPC',
        region: '华东',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentName: '仪器',
        ups: false,
        contractAmount: '1000',
        finalAmount: '1000',
        siteConfirmed: false,
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    const before = readBusinessRevision(ctx.db());

    const result = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'update_project',
      payload: { projectId, region: '华南', oldSiteContact: '旧址王工', siteConfirmed: false },
    } as WorkbenchV2MutationRequest)) as { businessRevision: number; invalidated: string[]; changed: { projectId: string } };
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.changed).toEqual({ projectId });
    expect(result.invalidated).toEqual(
      expect.arrayContaining(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]),
    );

    const detail = (await ctx.bus.invoke(
      IPC_CHANNELS.workbenchV2ProjectDetail,
      100,
      projectId,
    )) as { project: { region: string | null }; detail: { oldSiteContact: string | null; siteConfirmed: boolean } | null };
    expect(detail.project.region).toBe('华南');
    expect(detail.detail?.oldSiteContact).toBe('旧址王工');
    expect(detail.detail?.siteConfirmed).toBe(false);
  });
});
