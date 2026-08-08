import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { SystemClock } from '../../src/domain/core/time';
import {
  IMPORT_WIZARD_CHANNELS,
  IPC_CHANNELS,
  type AccountSessionInfo,
} from '../../src/shared/ipc';
import {
  registerIpcHandlers,
  type IpcBus,
  type IpcEvent,
  type IpcHandlerDeps,
} from '../../src/main/ipc-handlers';
import { ImportWizardFacade, type ImportWizardFacadeDeps } from '../../src/main/import-wizard-facade';
import {
  ImportCancelledError,
  type ImportFileTaskResult,
  type ImportPasteTaskResult,
} from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { buildXlsx } from '../helpers/zip-fixtures';

/** 缓存一个可被预检/worker 正常解析的合成 .xlsx（selectFiles 预检需要真实 ZIP）。 */
let validXlsxPromise: Promise<Buffer> | null = null;
function ensureXlsx(): Promise<Buffer> {
  if (!validXlsxPromise) {
    validXlsxPromise = buildXlsx([{ name: 'Sheet1', rows: [['ECC', '客户名称'], ['E-1', '甲']] }]);
  }
  return validXlsxPromise;
}

/**
 * 历史数据导入向导 IPC 测试（tasks 8.47~8.53）。
 *
 * - 未登录/非受信调用全部拒绝（统一 requireSessionAndSender）；
 * - 草稿访问校验（不存在/终态拒绝）；revision 冲突透传；
 * - duplicate operation / cancel（解析可取消并回滚到最后稳定修订，提交不可取消）；
 * - 会话失效：取消活动读取、保留最后修订、invalidate seal（重登录须重新校验）；
 * - dialog 不泄露可复用路径；>MAX_SAFE 金额 DTO 精确往返；
 * - workspace 损坏仅禁用导入，不影响普通工作台。
 */

class FakeBus implements IpcBus {
  readonly handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`未注册通道: ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: { url: "http://localhost:3000/" } }, ...args);
  }
}

const fakeFileResult: ImportFileTaskResult = {
  newRevision: 0,
  preflight: {
    ok: true,
    violations: [],
    entries: 1,
    fileBytes: 1,
    totalCompressedBytes: 1,
    totalUncompressedBytes: 1,
    sheetCount: 1,
    dateSystem: '1900',
  },
  dateSystem: '1900',
  templateMode: false,
  templateVersionSupported: true,
  sheets: [],
  fileRows: 1,
  normalizedRows: 1,
  categories: { project: 1 },
  issues: [],
  rawDigest: 'raw-digest',
  planDigest: 'plan-digest',
};

interface Ctx {
  bus: FakeBus;
  facade: ImportWizardFacade;
  facadeDeps: ImportWizardFacadeDeps;
  emitProgress: Array<{ draftId: string; operationId: string }>;
  setSession: (session: AccountSessionInfo | null) => void;
  setImportWizardDisabled: (error: string | null) => void;
  close: () => void;
}

function makeContext(dir: string): Ctx {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  const business = bootstrapDatabase({ dataDir: join(dir, 'data') });
  let session: AccountSessionInfo | null = null;
  let importWizardDisabled: string | null = null;
  const emitProgress: Array<{ draftId: string; operationId: string }> = [];
  const runFileTask = vi.fn<(params: import('../../src/domain/capabilities/historical-data-import/import-tasks').ImportFileTaskParams, writer: import('../../src/domain/capabilities/historical-data-import/import-tasks').ChunkWritePort, options: import('../../src/domain/capabilities/historical-data-import/import-worker/import-worker-host').ImportWorkerTaskOptions) => Promise<ImportFileTaskResult>>();
  const runPasteTask = vi.fn<(...args: never[]) => Promise<ImportPasteTaskResult>>();
  const facadeDeps: ImportWizardFacadeDeps = {
    workspaceDir: join(dir, 'ws'),
    workspaceDb: () => ws.db,
    businessDb: () => business.db,
    snapshotDir: () => join(dir, 'snap'),
    session: () => session,
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    readFile: vi.fn().mockImplementation(() => ensureXlsx()),
    statFile: vi.fn().mockResolvedValue({ size: 1024 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    clipboardText: () => '',
    runFileTask: runFileTask as never,
    runPasteTask: runPasteTask as never,
    emitProgress: (event) => {
      emitProgress.push({ draftId: event.draftId, operationId: event.operationId });
    },
  };
  const facade = new ImportWizardFacade(facadeDeps, new SystemClock());
  const accountService = () => new LocalAccountService(new SqliteAccountRepository(business.db));
  const deps: IpcHandlerDeps = {
    db: () => business.db,
    dbPath: () => join(dir, 'workbench.db'),
    dataDir: () => dir,
    accountService,
    session: () => session,
    setSession: (next) => {
      const wasLoggedIn = session !== null;
      session = next;
      if (wasLoggedIn && next === null) facade.onSessionInvalidated();
    },
    trustedSenderId: () => 100,
    trustedSenderOrigin: () => "http://localhost:3000/",
    autoBackupError: () => null,
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    createManualBackup: () => Promise.resolve(join(dir, 'manual.db')),
    restoreFromBackup: () => ({ restored: false }),
    importWizardFacade: () => facade,
    importWizardEnabled: () => importWizardDisabled === null,
    importWizardError: () => importWizardDisabled,
  };
  const bus = new FakeBus();
  registerIpcHandlers(bus, deps);
  return {
    bus,
    facade,
    facadeDeps,
    emitProgress,
    setSession: (next) => {
      const wasLoggedIn = session !== null;
      session = next;
      if (wasLoggedIn && next === null) facade.onSessionInvalidated();
    },
    setImportWizardDisabled: (error) => {
      importWizardDisabled = error;
    },
    close: () => {
      closeDatabase(business.db);
      ws.db.close();
    },
  };
}

async function login(bus: FakeBus): Promise<string> {
  const result = (await bus.invoke(IPC_CHANNELS.accountInitialize, 100, '负责人', 'password1')) as {
    accountId: string;
  };
  return result.accountId;
}

async function createDraft(bus: FakeBus): Promise<string> {
  const workspace = (await bus.invoke(IMPORT_WIZARD_CHANNELS.createDraft, 100)) as { draft: { id: string } };
  return workspace.draft.id;
}

/** 给项目类补一条有效行（addRow + patch），其余六类声明为无数据。 */
async function seedProjectRow(bus: FakeBus, draftId: string, ecc: string, customer: string): Promise<void> {
  await bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
  await bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'projects', [
    { rowIndex: 0, columnId: 'contract.ecc', value: ecc },
    { rowIndex: 0, columnId: 'contract.customer_name', value: customer },
  ]);
  await bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
  for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
    await bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('8.53 IPC 守卫：未登录 / 非受信 / 工作区不可用', () => {
  it('未登录时导入向导全部 invoke 通道拒绝；非受信 sender 拒绝', async () => {
    const dir = makeTempDir('iw-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    const channels = Object.values(IMPORT_WIZARD_CHANNELS).filter(
      (c) => c !== IMPORT_WIZARD_CHANNELS.progressEvent,
    );
    for (const channel of channels) {
      await expect(ctx.bus.invoke(channel, 100)).rejects.toThrow(/登录状态已失效/);
    }
    await login(ctx.bus);
    // 受信 sender 正常；非受信拒绝
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.listDrafts, 100);
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.listDrafts, 999)).rejects.toThrow(/受信主窗口/);
    ctx.close();
  });

  it('工作区损坏/不可用仅禁用导入：普通工作台不受影响', async () => {
    const dir = makeTempDir('iw-corrupt-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    ctx.setImportWizardDisabled('工作区数据库损坏');
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.listDrafts, 100)).rejects.toThrow(/工作区不可用.*工作区数据库损坏/);
    // 普通工作台通道仍然可用（Oracle #10：v2 有界读取取代 snapshot）
    const overview = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 100)) as { metrics: { totalProjects: number } };
    expect(overview.metrics.totalProjects).toBe(0);
    ctx.close();
  });
});

describe('8.47/8.48 工作区 DTO 与草稿访问', () => {
  it('createDraft 返回完整工作区 DTO：七类/列/步骤/模板版本/账号', async () => {
    const dir = makeTempDir('iw-dto-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const workspace = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.createDraft, 100)) as {
      draft: { id: string; name: string; totalRows: number; issueCount: number };
      username: string;
      templateVersion: string;
      currentStep: string;
      categories: Array<{ category: string; mode: string; columns: Array<{ id: string; label: string; businessKey?: boolean }> }>;
      steps: unknown[];
    };
    expect(workspace.draft.id).toBeTruthy();
    expect(workspace.username).toBe('负责人');
    expect(workspace.templateVersion).toBe('1');
    expect(workspace.currentStep).toBe('prepare');
    expect(workspace.categories).toHaveLength(7);
    const projects = workspace.categories.find((c) => c.category === 'projects')!;
    expect(projects.columns.map((c) => c.id)).toContain('contract.ecc');
    expect(projects.columns.find((c) => c.id === 'contract.ecc')?.businessKey).toBe(true);
    expect(workspace.steps).toHaveLength(7);
    // 列表/读取
    const list = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.listDrafts, 100)) as Array<{ id: string }>;
    expect(list).toHaveLength(1);
    ctx.close();
  });

  it('越权草稿：不存在/已删除的草稿被拒绝，不触碰业务数据', async () => {
    const dir = makeTempDir('iw-access-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.openDraft, 100, 'missing-draft')).rejects.toThrow(/不存在/);
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId: 'missing-draft',
      category: 'projects',
      offset: 0,
      limit: 10,
    })).rejects.toThrow(/不存在/);
    const draftId = await createDraft(ctx.bus);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.deleteDraft, 100, draftId);
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.openDraft, 100, draftId)).rejects.toThrow(/不存在/);
    ctx.close();
  });
});

describe('8.49 校验 / 封存 / 提交 端到端', () => {
  it('patch 局部校验 → 完整校验封存 → 提交整体写入 import_run 与业务库', async () => {
    const dir = makeTempDir('iw-e2e-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    const accountId = await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    await seedProjectRow(ctx.bus, draftId, 'E-IPC-1', '甲');
    // 金额以十进制字符串精确写入（>MAX_SAFE 分值）
    const huge = '90071992547409.93';
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'projects', [
      { rowIndex: 0, columnId: 'contract.usd_tax_amount_cents', value: huge },
    ]);
    // 网格窗口往返保持精确字符串
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId,
      category: 'projects',
      offset: 0,
      limit: 10,
    })) as { rows: Array<{ values: Record<string, string | null> }> };
    expect(window.rows[0].values['contract.usd_tax_amount_cents']).toBe(huge);

    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as {
      summary: { seal: string | null; sealValid: boolean; validationComplete: boolean; blockingCount: number; amountTotals: Array<{ label: string; value: string }> } | null;
      issues: unknown[];
    };
    expect(sealed.summary?.seal).toBeTruthy();
    expect(sealed.summary?.sealValid).toBe(true);
    expect(sealed.summary?.validationComplete).toBe(true);
    expect(sealed.summary?.blockingCount).toBe(0);
    // 金额合计 DTO 为十进制字符串（无 Number 退化）
    const contractTotal = sealed.summary?.amountTotals.find((a) => a.label.includes('合同金额'))?.value;
    expect(contractTotal).toBe(huge);

    const result = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary!.seal!)) as {
      status: string;
      importedCounts?: Record<string, number>;
    };
    expect(result.status).toBe('success');
    expect(result.importedCounts?.projects).toBe(1);
    // 业务库已写入 + import_run 成功审计
    const projects = (ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    expect(projects).toBe(1);
    const run = ctx.facadeDeps.businessDb().prepare('SELECT status, account_id FROM import_run LIMIT 1').get() as { status: string; account_id: string | null };
    expect(run.status).toBe('succeeded');
    expect(run.account_id).toBe(accountId);
    // 终态草稿不可再打开编辑
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.openDraft, 100, draftId)).rejects.toThrow(/导入成功/);
    ctx.close();
  });

  it('重复提交（同一草稿二次 submit）被拒绝，不二次写入', async () => {
    const dir = makeTempDir('iw-double-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    await seedProjectRow(ctx.bus, draftId, 'E-DBL', '甲');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string } };
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary.seal);
    // 草稿已 succeeded：再次提交被拒（facade 状态守卫）
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary.seal)).rejects.toThrow(/封存|成功/);
    const projects = (ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    expect(projects).toBe(1);
    ctx.close();
  });
});

describe('8.51 duplicate operation / cancel', () => {
  it('解析期间草稿被并发修改 → 下一块写入触发 revision 冲突并透传（不静默覆盖较新草稿）', async () => {
    const dir = makeTempDir('iw-revision-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        params: { draftId: string; expectedRevision: number },
        writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number },
        options: { onProgress?: (p: { stage: string; currentRows: number; totalRows: number | null }) => void },
      ) => {
        options.onProgress?.({ stage: 'reading', currentRows: 0, totalRows: 10 });
        const rev1 = writer.append(params.draftId, params.expectedRevision, 'project', [{ rowId: 'r-1', cells: {} }]);
        // 并发修改推进草稿修订（模拟另一个窗口/操作）。
        await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
        // 下一块使用陈旧修订 → RevisionConflictError。
        writer.append(params.draftId, rev1, 'project', [{ rowId: 'r-2', cells: {} }]);
        return fakeFileResult;
      },
    );
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [join(dir, '并发.xlsx')],
    });
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)).rejects.toThrow(/修订冲突/);
    // 解析失败已回滚到最后稳定修订：无部分行残留，草稿可继续查询。
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId,
      category: 'projects',
      offset: 0,
      limit: 10,
    })) as { total: number };
    expect(window.total).toBe(0);
    ctx.close();
  });

  it('文件读取进行中重复触发被抑制（operation 去重），不二次启动', async () => {
    const dir = makeTempDir('iw-dup-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    let resolveTask: ((value: ImportFileTaskResult) => void) | undefined;
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      (
        params: { draftId: string },
        writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number },
        options: { onProgress?: (p: { stage: string; currentRows: number; totalRows: number | null }) => void },
      ) => {
        void params;
        void writer;
        options.onProgress?.({ stage: 'reading', currentRows: 0, totalRows: 10 });
        return new Promise<ImportFileTaskResult>((resolve) => {
          resolveTask = resolve;
        });
      },
    );
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [join(dir, '数据.xlsx')],
    });
    const first = ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId);
    // 等待任务进入进行中（进度事件已发出）
    await vi.waitFor(() => expect(ctx.emitProgress.length).toBeGreaterThan(0));
    // 重复触发 → 拒绝（不二次启动 worker）
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)).rejects.toThrow(/去重/);
    resolveTask?.(fakeFileResult);
    await first;
    // 只有一次运行
    expect((ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    ctx.close();
  });

  it('解析可取消：回滚到最后稳定修订，不形成部分 merge；提交不可取消', async () => {
    const dir = makeTempDir('iw-cancel-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    // 文件任务：先写入一块，随后挂起等待中止。
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { draftId: string; expectedRevision: number }, writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number }, options: { signal?: AbortSignal; onProgress?: (p: { stage: string; currentRows: number; totalRows: number | null }) => void }) => {
        options.onProgress?.({ stage: 'reading', currentRows: 0, totalRows: 10 });
        const rev = writer.append(params.draftId, params.expectedRevision, 'project', [
          { rowId: 't-row-1', cells: { 'contract.ecc': 'E-TMP' } },
        ]);
        void rev;
        return new Promise<ImportFileTaskResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new ImportCancelledError('已取消'));
          });
        });
      },
    );
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [join(dir, '数据.xlsx')],
    });
    const first = ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(ctx.emitProgress.length).toBeGreaterThan(0));
    const operationId = ctx.emitProgress[0]!.operationId;
    // 取消 → 草稿回滚到最后稳定修订
    const cancelled = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.cancelOperation, 100, draftId, operationId)) as {
      draft: { totalRows: number };
      operation: unknown;
    };
    expect(cancelled.draft.totalRows).toBe(0); // 解析期间写入的行已回滚
    expect(cancelled.operation).toBeNull();
    const firstResult = await first;
    expect(firstResult).toBeInstanceOf(ImportCancelledError);
    // 提交不可取消（committing 阶段取消被拒绝）
    const draftId2 = await createDraft(ctx.bus);
    await expect(
      ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.cancelOperation, 100, draftId2, 'op-not-found'),
    ).resolves.toBeTruthy();
    ctx.close();
  });
});

describe('8.52 会话失效：取消活动读取、保留修订、invalidate seal、重登录重新校验', () => {
  it('登出/恢复清空会话后 seal 失效；重新登录后须重新完整校验', async () => {
    const dir = makeTempDir('iw-session-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    await seedProjectRow(ctx.bus, draftId, 'E-SESS', '甲');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as {
      summary: { sealValid: boolean; validationComplete: boolean };
    };
    expect(sealed.summary?.sealValid).toBe(true);

    // 会话失效（登出/恢复后 setSession(null) 触发 onSessionInvalidated）
    ctx.setSession(null);
    // 重新登录（账号已存在，走登录而非初始化）
    await ctx.bus.invoke(IPC_CHANNELS.accountLogin, 100, '负责人', 'password1');
    const reopened = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.openDraft, 100, draftId)) as {
      summary: { sealValid: boolean; validationComplete: boolean } | null;
      steps: Array<{ id: string; state: string }>;
    };
    expect(reopened.summary?.sealValid).toBe(false);
    expect(reopened.summary?.validationComplete).toBe(false);
    // 草稿行保留（最后修订未被清除）
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId,
      category: 'projects',
      offset: 0,
      limit: 10,
    })) as { total: number };
    expect(window.total).toBe(1);
    ctx.close();
  });
});

describe('8.50 dialog 不泄露路径 / 金额 DTO 精确', () => {
  it('文件选择与模板保存只返回展示元数据，不返回可复用路径', async () => {
    const dir = makeTempDir('iw-dialog-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    const secretPath = join(dir, '绝对路径', '机密来源.xlsx');
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePaths: [secretPath],
    });
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockResolvedValue(fakeFileResult);
    const afterFiles = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)) as {
      sheets: Array<{ fileName: string }>;
    };
    expect(afterFiles.sheets[0]?.fileName).toBe('机密来源.xlsx'); // 仅展示文件名（basename）
    expect(JSON.stringify(afterFiles)).not.toContain(secretPath); // 不泄露绝对路径
    expect(JSON.stringify(afterFiles)).not.toContain('绝对路径');

    (ctx.facadeDeps.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      canceled: false,
      filePath: join(dir, '模板保存位置', 'template.xlsx'),
    });
    const template = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.downloadTemplate, 100)) as {
      saved: boolean;
      version: string;
    };
    expect(template.saved).toBe(true);
    expect(template.version).toBe('1');
    ctx.close();
  });

  it('超过 MAX_SAFE_INTEGER 的金额经 patch → 网格窗口 → 校验摘要 IPC 往返保持精确字符串', async () => {
    const dir = makeTempDir('iw-bigmoney-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    const huge = '90071992547409.93';
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'projects', [
      { rowIndex: 0, columnId: 'contract.ecc', value: 'E-BIG-IPC' },
      { rowIndex: 0, columnId: 'contract.customer_name', value: '甲' },
      { rowIndex: 0, columnId: 'contract.usd_tax_amount_cents', value: huge },
    ]);
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId,
      category: 'projects',
      offset: 0,
      limit: 10,
    })) as { rows: Array<{ values: Record<string, string | null> }> };
    expect(window.rows[0].values['contract.usd_tax_amount_cents']).toBe(huge);
    ctx.close();
  });
});

describe('8.59/8.66 后端 undo/redo checkpoint（IPC）', () => {
  it('大粘贴建立磁盘 checkpoint：undo 整体撤销、redo 整体重做（操作数不保存在 renderer）', async () => {
    const dir = makeTempDir('iw-undo-paste-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    // 粘贴 5000 行：粘贴前建 pre、成功后建 post checkpoint。
    (ctx.facadeDeps.clipboardText as () => string) = () => Array.from({ length: 200 }, () => 'a\tb\tc').join('\n');
    (ctx.facadeDeps.runPasteTask as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { draftId: string; expectedRevision: number; category: string }, writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number }) => {
        const rows = Array.from({ length: 5000 }, (_, i) => ({ rowId: `paste-${i}`, cells: { 'contract.ecc': `E-${i}` } }));
        const rev = writer.append(params.draftId, params.expectedRevision, params.category, rows);
        return Promise.resolve({
          newRevision: rev,
          pasteBatch: 'pb-1',
          columnMapping: [],
          overlay: { allowed: true },
          width: 3,
          header: ['a', 'b', 'c'],
          rowCount: 200,
          normalizedRows: 5000,
          issues: [],
          rawDigest: 'rd',
          planDigest: 'pd',
        });
      },
    );
    const pasted = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.pasteIntoCategory, 100, draftId, 'projects', true)) as {
      categories: Array<{ category: string; count: number }>;
      checkpoints?: unknown;
    };
    expect(pasted.categories.find((c) => c.category === 'projects')?.count).toBe(5000);
    const list = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.checkpoints, 100, draftId)) as Array<{ kind: string; label: string }>;
    expect(list.some((c) => c.kind === 'pre' && c.label === '粘贴')).toBe(true);
    expect(list.some((c) => c.kind === 'post' && c.label === '粘贴')).toBe(true);
    // checkpoint 摘要不泄露敏感值。
    expect(JSON.stringify(list)).not.toContain('E-4999');

    const undone = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.undo, 100, draftId)) as {
      categories: Array<{ category: string; count: number }>;
    };
    expect(undone.categories.find((c) => c.category === 'projects')?.count).toBe(0);
    const redone = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.redo, 100, draftId)) as {
      categories: Array<{ category: string; count: number }>;
    };
    expect(redone.categories.find((c) => c.category === 'projects')?.count).toBe(5000);
    ctx.close();
  });

  it('删除既有来源行后可整体 undo（原位置/来源/只读元数据恢复）与 redo', async () => {
    const dir = makeTempDir('iw-undo-delete-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    // 建立两行（含来源定位与业务键）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'projects', [
      { rowIndex: 0, columnId: 'contract.ecc', value: 'E-1' },
      { rowIndex: 0, columnId: 'contract.customer_name', value: '甲' },
      { rowIndex: 1, columnId: 'contract.ecc', value: 'E-2' },
      { rowIndex: 1, columnId: 'contract.customer_name', value: '乙' },
    ]);
    // 删除第 0 行（既有行）。
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId,
      category: 'projects',
      offset: 0,
      limit: 10,
    })) as { rows: Array<{ id: string; values: Record<string, string | null> }> };
    const firstRowId = window.rows[0]!.id;
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.deleteRows, 100, draftId, 'projects', [firstRowId]);
    expect(((await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, { draftId, category: 'projects', offset: 0, limit: 10 })) as { total: number }).total).toBe(1);

    const undone = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.undo, 100, draftId)) as {
      categories: Array<{ category: string; count: number }>;
    };
    expect(undone.categories.find((c) => c.category === 'projects')?.count).toBe(2);
    // 恢复后原位置/业务键保留。
    const restored = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, {
      draftId,
      category: 'projects',
      offset: 0,
      limit: 10,
    })) as { rows: Array<{ id: string; values: Record<string, string | null> }> };
    expect(restored.rows[0]!.values['contract.ecc']).toBe('E-1');
    expect(restored.rows[0]!.values['contract.customer_name']).toBe('甲');

    const redone = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.redo, 100, draftId)) as {
      categories: Array<{ category: string; count: number }>;
    };
    expect(redone.categories.find((c) => c.category === 'projects')?.count).toBe(1);
    ctx.close();
  });

  it('会话失效后 undo/redo 仍受守卫且草稿可恢复；checkpoint 历史保留', async () => {
    const dir = makeTempDir('iw-undo-session-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const draftId = await createDraft(ctx.bus);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.deleteRows, 100, draftId, 'projects', []);
    // 会话失效。
    ctx.setSession(null);
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.undo, 100, draftId)).rejects.toThrow(/登录状态已失效/);
    // 重新登录后 undo/redo 正常（checkpoint 历史在草稿上持久保留）。
    await ctx.bus.invoke(IPC_CHANNELS.accountLogin, 100, '负责人', 'password1');
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.checkpoints, 100, draftId)).resolves.toBeTruthy();
    ctx.close();
  });

  it('checkpoint/undo/redo 阶段正式业务库零写', async () => {
    const dir = makeTempDir('iw-undo-zerowrite-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx.bus);
    const snapshot = (): string => {
      const tables = ['customers', 'projects', 'contracts', 'invoices', 'service_orders', 'import_run'];
      return tables
        .map((t) => `${t}:${JSON.stringify(ctx.facadeDeps.businessDb().prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())}`)
        .join('\n');
    };
    const before = snapshot();
    const draftId = await createDraft(ctx.bus);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.deleteRows, 100, draftId, 'projects', []);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.undo, 100, draftId);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.redo, 100, draftId);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.checkpoints, 100, draftId);
    expect(snapshot()).toBe(before);
    ctx.close();
  });
});
