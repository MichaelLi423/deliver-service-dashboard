import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { SystemClock } from '../../src/domain/core/time';
import { IMPORT_WIZARD_CHANNELS, IPC_CHANNELS, type AccountSessionInfo } from '../../src/shared/ipc';
import {
  registerIpcHandlers,
  senderFrameMatches,
  type IpcBus,
  type IpcEvent,
  type IpcHandlerDeps,
} from '../../src/main/ipc-handlers';
import { ImportWizardFacade, type ImportWizardFacadeDeps } from '../../src/main/import-wizard-facade';
import type { ImportFileTaskResult } from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { runImport, desensitizeAuditIdentity } from '../../src/domain/capabilities/historical-data-import/migration-service';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { preflightBatch, DEFAULT_XLSX_BATCH_LIMITS } from '../../src/domain/capabilities/historical-data-import/zip-preflight';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { buildXlsx } from '../helpers/zip-fixtures';

/**
 * Oracle 复审 #1~#7 回归测试（除 #10 普通工作台 snapshot）。
 */

class FakeBus implements IpcBus {
  readonly handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`未注册通道: ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: { url: 'http://localhost:3000/' } }, ...args);
  }
  /** 以指定 frame URL 调用（测试 senderFrame URL/origin 校验）。 */
  async invokeWithFrame(channel: string, senderId: number, frameUrl: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`未注册通道: ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: { url: frameUrl } }, ...args);
  }
}

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];

function srow(file: string, sheet: string, rowNumber: number, cells: Record<string, string | null>): SourceRow {
  return { file, sheet, rowNumber, cells };
}

interface Ctx {
  bus: FakeBus;
  facade: ImportWizardFacade;
  facadeDeps: ImportWizardFacadeDeps;
  emitProgress: Array<{ draftId: string; operationId: string }>;
  setSession: (session: AccountSessionInfo | null) => void;
  /** 无密码模式：经账号服务确保本地账号并写入会话（替代已移除的登录 IPC 通道）。 */
  establishSession: () => Promise<AccountSessionInfo>;
  setImportWizardDisabled: (error: string | null) => void;
  setTrustedOrigin: (origin: string | null) => void;
  close: () => void;
}

function makeContext(dir: string): Ctx {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  const business = bootstrapDatabase({ dataDir: join(dir, 'data') });
  let session: AccountSessionInfo | null = null;
  let importWizardDisabled: string | null = null;
  let trustedOrigin: string | null = 'http://localhost:3000/';
  const emitProgress: Array<{ draftId: string; operationId: string }> = [];
  const runFileTask = vi.fn<(params: unknown, writer: { append: (...args: unknown[]) => number }, options: { signal?: AbortSignal }) => Promise<ImportFileTaskResult>>();
  const runPasteTask = vi.fn();
  const facadeDeps: ImportWizardFacadeDeps = {
    workspaceDir: join(dir, 'ws'),
    workspaceDb: () => ws.db,
    businessDb: () => business.db,
    snapshotDir: () => join(dir, 'snap'),
    session: () => session,
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    readFile: vi.fn().mockResolvedValue(Buffer.from('x')),
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
    trustedSenderOrigin: () => trustedOrigin,
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
    establishSession: async () => {
      const next = await accountService().ensureLocalSession();
      const info: AccountSessionInfo = { accountId: next.accountId, username: next.username };
      session = info;
      return info;
    },
    setImportWizardDisabled: (error) => {
      importWizardDisabled = error;
    },
    setTrustedOrigin: (origin) => {
      trustedOrigin = origin;
    },
    close: () => {
      closeDatabase(business.db);
      ws.db.close();
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function login(ctx: Ctx): Promise<string> {
  const session = await ctx.establishSession();
  return session.accountId;
}

async function createDraft(bus: FakeBus): Promise<string> {
  const workspace = (await bus.invoke(IMPORT_WIZARD_CHANNELS.createDraft, 100)) as { draft: { id: string } };
  return workspace.draft.id;
}

async function seedProjectRow(bus: FakeBus, draftId: string, ecc: string, customer: string, modes: boolean = true): Promise<void> {
  await bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
  await bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'projects', [
    { rowIndex: 0, columnId: 'contract.ecc', value: ecc },
    { rowIndex: 0, columnId: 'contract.customer_name', value: customer },
  ]);
  if (modes) {
    await bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
  }
}

describe('Oracle #5 trusted sender：senderFrame URL/origin + 账号通道守卫', () => {
  it('senderFrame 来源不匹配时即使 sender.id 匹配也被拒绝（含账号状态/会话查询通道）', async () => {
    const dir = makeTempDir('oracle-sender-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    // 受信 id=100 但 frame URL 来自恶意 origin → 拒绝（无需会话但需受信窗口的通道）。
    await expect(ctx.bus.invokeWithFrame(IPC_CHANNELS.accountGetStatus, 100, 'http://evil.example/')).rejects.toThrow(/来源不匹配/);
    await expect(ctx.bus.invokeWithFrame(IMPORT_WIZARD_CHANNELS.listDrafts, 100, "http://evil.example/")).rejects.toThrow(/来源不匹配/);
    // 受信 id=100 + 正确 frame URL → 账号状态通道可用（无需会话但需受信窗口）。
    expect(await ctx.bus.invoke(IPC_CHANNELS.accountGetStatus, 100)).toEqual({
      initialized: false,
      autoBackupError: null,
    });
    ctx.close();
  });

  it('会话 token 失效（登出/恢复）取消提交资格：commit 在安全快照后零写拒绝', async () => {
    const dir = makeTempDir('oracle-session-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    await seedProjectRow(ctx.bus, draftId, 'E-SESS-TOKEN', '甲');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string } };
    expect(sealed.summary?.seal).toBeTruthy();
    // 会话失效（token 置空 + seal 失效）。
    ctx.setSession(null);
    await ctx.establishSession();
    // 重新登录后旧 seal 已失效：直接提交被拒（严格 seal 匹配 / 状态守卫），零写。
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary.seal)).rejects.toThrow(/仅已封存草稿可提交|重新完整校验/);
    const projects = (ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    expect(projects).toBe(0);
    ctx.close();
  });
});

describe('Oracle #2 modes 迁入 schema / mode=none 阻断 / commit 严格 seal 匹配', () => {
  it('mode=none 但类别存在 rows 必须阻断', async () => {
    const dir = makeTempDir('oracle-mode-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'none')).rejects.toThrow(/不能声明为本次不导入/);
    ctx.close();
  });

  it('先 none 后补行：validate 与 commit 都阻断 mode=none 且 rows>0（Oracle 二次复审 #1）', async () => {
    const dir = makeTempDir('oracle-mode-then-paste-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    // 先声明 none（无行可通过），再补行（粘贴/文件等效）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'none');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'projects', [
      { rowIndex: 0, columnId: 'contract.ecc', value: 'E-NONE-ROW' },
      { rowIndex: 0, columnId: 'contract.customer_name', value: '甲' },
    ]);
    for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    // validate：mode=none + rows>0 → DECLARED_NONE_WITH_ROWS 阻断（不封存）。
    const validation = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as {
      summary: { sealValid: boolean } | null;
      issues: Array<{ kind: string; message: string }>;
    };
    expect(validation.summary?.sealValid).toBe(false);
    expect(validation.issues.some((i) => i.message.includes('本次不导入但存在'))).toBe(true);
    // commit 前同样阻断：即使伪造 seal 也因状态非 sealed 拒绝，零写。
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, 'fake')).rejects.toThrow(/仅已封存|重新完整校验/);
    expect((ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
    // 修正声明为 data → 可校验封存（阻断解除）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string } | null };
    expect(sealed.summary?.seal).toBeTruthy();
    ctx.close();
  });

  it('commit 必须携带用户确认的 seal ID：错误 seal 被拒绝（不能忽略）', async () => {
    const dir = makeTempDir('oracle-seal-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    await seedProjectRow(ctx.bus, draftId, 'E-SEAL-STRICT', '甲');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string } };
    // 携带错误的 seal ID → 拒绝，不写业务库。
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, 'wrong-seal-id')).rejects.toThrow(/不一致/);
    const projects = (ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    expect(projects).toBe(0);
    // 正确的 seal ID → 提交成功。
    const ok = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary.seal)) as { status: string };
    expect(ok.status).toBe('success');
    ctx.close();
  });

  it('模式/归类修改推进修订并使 seal 失效（纳入 conflict digest）', async () => {
    const dir = makeTempDir('oracle-mode-digest-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    await seedProjectRow(ctx.bus, draftId, 'E-MODE-DIGEST', '甲', false);
    // 完整声明七类（本项目 data，其余 none）后可校验封存。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { sealValid: boolean } | null };
    expect(sealed.summary?.sealValid).toBe(true);
    // 修改任一类别模式（其余声明完整）→ seal 失效（模式修改推进修订 + invalidate seal）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'serviceOrders', 'data');
    const after = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.summary, 100, draftId)) as { summary: { sealValid: boolean } | null };
    expect(after.summary?.sealValid).toBe(false);
    ctx.close();
  });
});

describe('Oracle #3 仅 invoice/logistics 引用主库既有 ECC', () => {
  it('only-invoice（ECC 已存在于主库）→ standalone 写入并解析目标 project', async () => {
    const dir = makeTempDir('oracle-only-invoice-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    // 主库已有 ECC 项目（CLI 迁移路径）。
    runImport(ctx.facadeDeps.businessDb(), {
      rows: [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-EXIST', 'Account name': '甲', 合同USD含税金额: '100' })],
      mapping: MAPPING_V1,
    });
    // 只导入掉票（引用既有 ECC）。
    const draftId = await createDraft(ctx.bus);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'invoices');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'invoices', [
      { rowIndex: 0, columnId: 'invoice.ecc', value: 'E-EXIST' },
      { rowIndex: 0, columnId: 'invoice.amount_cents', value: '5000' },
      { rowIndex: 0, columnId: 'invoice.invoiced_at', value: '2026-03-01T00:00:00+08:00' },
    ]);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'invoices', 'data');
    for (const category of ['projects', 'serviceOrders', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string; blockingCount: number } | null };
    expect(sealed.summary?.blockingCount).toBe(0);
    const ok = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary!.seal)) as { status: string; importedCounts?: Record<string, number> };
    expect(ok.status).toBe('success');
    expect(ok.importedCounts?.invoices).toBe(1);
    const invoices = (ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n;
    expect(invoices).toBe(1);
    // 掉票挂到既有项目下（ECC 解析目标 project，非空批次成功）。
    const projectId = (ctx.facadeDeps.businessDb().prepare("SELECT project_id FROM invoices LIMIT 1").get() as { project_id: string }).project_id;
    const project = (ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(projectId) as { n: number }).n;
    expect(project).toBe(1);
    ctx.close();
  });

  it('only-logistics（ECC 已存在）→ standalone 写入批次与费用', async () => {
    const dir = makeTempDir('oracle-only-logistics-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    runImport(ctx.facadeDeps.businessDb(), {
      rows: [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LOG-EXIST', 'Account name': '甲', 合同USD含税金额: '100' })],
      mapping: MAPPING_V1,
    });
    const draftId = await createDraft(ctx.bus);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'logistics');
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.patchCells, 100, draftId, 'logistics', [
      { rowIndex: 0, columnId: 'logistics_fee.ecc', value: 'E-LOG-EXIST' },
      { rowIndex: 0, columnId: 'logistics_fee.applied_at', value: '2026-02-01T00:00:00+08:00' },
      { rowIndex: 0, columnId: 'logistics_fee.budget_price_cents', value: '4000' },
      { rowIndex: 0, columnId: 'logistics_fee.deal_price_cents', value: '3500' },
      { rowIndex: 0, columnId: 'logistics_fee.logistics_cost_cents', value: '3000' },
    ]);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'logistics', 'data');
    for (const category of ['projects', 'serviceOrders', 'invoices', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string; blockingCount: number } | null };
    expect(sealed.summary?.blockingCount).toBe(0);
    const ok = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary!.seal)) as { status: string };
    expect(ok.status).toBe('success');
    expect((ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM logistics_fees').get() as { n: number }).n).toBe(1);
    ctx.close();
  });
});

describe('Oracle #6 selectFiles 跨文件 preflightBatch（失败草稿零 merge）', () => {
  it('preflightBatch 落实 20 文件 / 压缩总量 / 展开总量上限', () => {
    const violations = preflightBatch(
      Array.from({ length: 25 }, (_, i) => ({ fileName: `f${i}.xlsx`, fileBytes: 10, totalCompressedBytes: 10, totalUncompressedBytes: 10 })),
      DEFAULT_XLSX_BATCH_LIMITS,
    );
    expect(violations.some((v) => v.message.includes('文件数'))).toBe(true);
    const expanded = preflightBatch(
      [{ fileName: 'a.xlsx', fileBytes: 10, totalCompressedBytes: 10, totalUncompressedBytes: DEFAULT_XLSX_BATCH_LIMITS.maxTotalUncompressedBytes + 1 }],
      DEFAULT_XLSX_BATCH_LIMITS,
    );
    expect(expanded.some((v) => v.code === 'TOTAL_UNCOMPRESSED_TOO_LARGE')).toBe(true);
  });

  it('非法文件在任何 worker 前被拒绝，草稿零 merge', async () => {
    const dir = makeTempDir('oracle-preflight-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    (ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('not a zip'));
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, '坏.xlsx')] });
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)).rejects.toThrow(/预检/);
    // 草稿零 merge：无行、无来源、运行态已恢复。
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, { draftId, category: "projects", offset: 0, limit: 10 })) as { total: number };
    expect(window.total).toBe(0);
    expect((ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    ctx.close();
  });
});

describe('Oracle #7 migration_audit 脱敏', () => {
  it('migration_audit 不保存完整 fileName/sheet/ECC，仍可幂等重跑', () => {
    const dir = makeTempDir('oracle-audit-');
    dirs.push(dir);
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-AUDIT-7', 'Account name': '甲', 合同USD含税金额: '100' })];
      runImport(db, { rows, mapping: MAPPING_V1 });
      runImport(db, { rows, mapping: MAPPING_V1 }); // 幂等重跑
      const audits = db.prepare('SELECT * FROM migration_audit').all() as Array<Record<string, unknown>>;
      expect(audits.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(audits);
      // 完整业务标识不落审计库。
      expect(serialized).not.toContain('E-AUDIT-7');
      expect(serialized).not.toContain(CONTRACT);
      expect(serialized).not.toContain('合同信息');
      // 脱敏摘要确定性：与 desensitizeAuditIdentity 一致。
      expect(serialized).toContain(desensitizeAuditIdentity('E-AUDIT-7'));
      expect(serialized).toContain(desensitizeAuditIdentity(CONTRACT));
      // source_hash 仍保留（幂等/forward-fix 依据）。
      expect(audits[0].source_hash).toBeTruthy();
      // 重跑后项目数不重复（幂等仍工作）。
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Oracle #1 restore 竞态：旧 facade 取消 worker 后不写新连接', () => {
  it('selectFiles 进行中执行会话/恢复回收：活动任务被取消，新连接零行', async () => {
    const dir = makeTempDir('oracle-restore-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    let abortSignal: AbortSignal | null = null;
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { draftId: string; expectedRevision: number }, writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number }, options: { signal: AbortSignal }) => {
        abortSignal = options.signal;
        writer.append(params.draftId, params.expectedRevision, 'project', [{ rowId: 'restore-1', cells: {} }]);
        return new Promise<ImportFileTaskResult>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('已取消')));
        });
      },
    );
    (ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(await buildXlsx([{ name: 'Sheet1', rows: [['a']] }]));
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, 'f.xlsx')] });
    const first = ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(abortSignal).not.toBeNull());
    // 模拟恢复：会话失效 → 活动 worker 被取消（onSessionInvalidated abort）。
    ctx.setSession(null);
    await first;
    expect(abortSignal!.aborted).toBe(true);
    // 解析期间写入的行已回滚（草稿回到稳定态），没有形成部分 merge。
    await ctx.establishSession();
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, { draftId, category: 'projects', offset: 0, limit: 10 })) as { total: number };
    expect(window.total).toBe(0);
    ctx.close();
  });
});

describe('Oracle 二次复审 #2：sheet 归类真实影响 rows/计划（excluded 零写）', () => {
  it('excluded 来源行不进入计划/seal/commit（零写）；重新归类正确恢复', async () => {
    const dir = makeTempDir('oracle-excluded-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    // 用文件任务注入带 source_file/source_sheet 的源行。
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { draftId: string; expectedRevision: number }, writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number }) => {
        const rev = writer.append(params.draftId, params.expectedRevision, 'project', [
          { rowId: 'src-1', sourceFile: '来源.xlsx', sourceSheet: 'Sheet1', businessKey: 'E-EXCL', cells: { 'contract.ecc': 'E-EXCL', 'contract.customer_name': '甲' } },
        ]);
        return Promise.resolve({
          newRevision: rev, preflight: { ok: true, violations: [], entries: 1, fileBytes: 1, totalCompressedBytes: 1, totalUncompressedBytes: 1, sheetCount: 1, dateSystem: '1900' },
          dateSystem: '1900', templateMode: false, templateVersionSupported: true, sheets: [], fileRows: 1, normalizedRows: 1,
          categories: { project: 1 }, issues: [], rawDigest: 'rd', planDigest: 'pd',
        });
      },
    );
    (ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(await buildXlsx([{ name: 'Sheet1', rows: [['a']] }]));
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, '来源.xlsx')] });
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    // 排除该 sheet：excluded 行不得进入计划（validate 报 DECLARED_DATA_EMPTY，不封存）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.classifySheet, 100, draftId, '来源.xlsx#Sheet1', 'excluded');
    const excludedValidation = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string | null } | null };
    expect(excludedValidation.summary?.seal).toBeNull();
    // 重新归类回原类别 → 行恢复，可封存并提交（零写前提已解除）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.classifySheet, 100, draftId, '来源.xlsx#Sheet1', 'projects');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string } | null };
    expect(sealed.summary?.seal).toBeTruthy();
    const ok = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary!.seal)) as { status: string };
    expect(ok.status).toBe('success');
    expect((ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
    ctx.close();
  });

  it('excluded 后重新归类到不同类别（存在源行）阻断：无法安全重映射', async () => {
    const dir = makeTempDir('oracle-excluded-block-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    // 直接以带来源的行追加（等价文件源行）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.addRow, 100, draftId, 'projects');
    // 归类到与既有行类别不同的目标类别（projects 行 → serviceOrders）→ 阻断。
    const window = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.queryRows, 100, { draftId, category: 'projects', offset: 0, limit: 10 })) as { rows: Array<{ id: string }> };
    expect(window.rows).toHaveLength(1);
    // 无来源的 blank 行不能被 sheet 归类安全移动（目标类别不匹配既有行类别时阻断）。
    // 这里使用 repo 直测：归类到不同类别且存在行 → 阻断。
    const { WorkspaceRepository } = await import('../../src/domain/capabilities/historical-data-import/workspace');
    const { bootstrapWorkspaceDatabase } = await import('../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap');
    const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws2') });
    const repo = new WorkspaceRepository(ws.db);
    const d = repo.createDraft({ name: 'x', createdBy: null, createdByUsername: null });
    let rev = repo.transitionState(d.id, 1, 'start_parsing');
    rev = repo.appendRows(d.id, rev, 'project', [{ rowId: 'r1', sourceFile: 'f.xlsx', sourceSheet: 'S1', cells: { 'contract.ecc': 'E-1' } }]);
    rev = repo.transitionState(d.id, rev, 'parsing_finished');
    // 排除后再重归类到不同类别 → 阻断（不安全重映射）。
    rev = repo.setSheetClassification(d.id, rev, 'f.xlsx', 'S1', 'excluded');
    expect(() => repo.setSheetClassification(d.id, rev, 'f.xlsx', 'S1', 'service_order')).toThrow(/无法安全重映射/);
    // 重归类回原类别（project）→ 允许并解除排除。
    rev = repo.setSheetClassification(d.id, rev, 'f.xlsx', 'S1', 'project');
    const rows = repo.queryRows(d.id, { offset: 0, limit: 10 }).rows;
    expect(rows[0]!.excluded).toBe(false);
    ws.db.close();
    ctx.close();
  });
});

describe('Oracle 二次复审 #4：trusted sender 精确 origin / file 入口', () => {
  it('localhost.evil 被拒绝；正常 dev origin 通过；file:// 精确入口通过/不同路径拒绝', async () => {
    const dir = makeTempDir('oracle-origin-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    // 受信 origin 为 dev URL。
    await expect(ctx.bus.invokeWithFrame(IPC_CHANNELS.accountGetStatus, 100, 'http://localhost:3000.evil.com/')).rejects.toThrow(/来源不匹配/);
    await expect(ctx.bus.invokeWithFrame(IPC_CHANNELS.accountGetStatus, 100, 'http://localhost:3000/index.html')).resolves.toBeTruthy();
    // file:// 打包：精确入口通过、其它路径/前缀拒绝。
    const matches = senderFrameMatches;
    expect(matches('file:///app/index.html', 'file:///app/index.html')).toBe(true);
    expect(matches('file:///app/other.html', 'file:///app/index.html')).toBe(false);
    expect(matches('file:///app/index.html.evil', 'file:///app/index.html')).toBe(false);
    expect(matches('http://localhost:3000.evil.com/', 'http://localhost:3000/index.html')).toBe(false);
    expect(matches('http://localhost:3000/app', 'http://localhost:3000/index.html')).toBe(true);
    ctx.close();
  });
});

describe('Oracle 二次复审 #5：selectFiles 读取前拒绝 >20 / 增量上限 / 超限停止', () => {
  it('读取前拒绝 >20 个文件（零 readFile）', async () => {
    const dir = makeTempDir('oracle-maxfiles-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    const files = Array.from({ length: 21 }, (_, i) => join(dir, `f${i}.xlsx`));
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: files });
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)).rejects.toThrow(/文件数/);
    expect((ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    ctx.close();
  });

  it('按实际 byteLength 增量累计 250MiB：超限立即停止，后续 readFile 零调用', async () => {
    const dir = makeTempDir('oracle-incremental-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    // 第 1 个文件为合法 xlsx（通过预检）；第 2 个文件 300MiB 实际字节 → 累计超 250MiB
    // 立即停止（第 3 个文件不再 readFile、worker 未启动）。
    const small = await buildXlsx([{ name: 'Sheet1', rows: [['a']] }]);
    const big = Buffer.alloc(300 * 1024 * 1024, 0);
    const reads: string[] = [];
    (ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (filePath: string) => {
      reads.push(filePath);
      return filePath.includes('big') ? big : small;
    });
    const files = [join(dir, 'a.xlsx'), join(dir, 'big.xlsx'), join(dir, 'c.xlsx')];
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: files });
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)).rejects.toThrow(/压缩输入/);
    expect(reads).toHaveLength(2); // a + big 后立即停止
    expect(reads).not.toContain(files[2]);
    expect((ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    ctx.close();
  });

  it('readFile 前 stat 累计超限 → 零 readFile（Oracle 最终复核 #4：数 GB 声明不读取）', async () => {
    const dir = makeTempDir('oracle-stat-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    (ctx.facadeDeps.statFile as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 2 * 1024 * 1024 * 1024 }); // 2GB 声明
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, 'huge.xlsx')] });
    await expect(ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId)).rejects.toThrow(/stat 大小/);
    expect((ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    ctx.close();
  });
});

describe('Oracle 最终复核 #1/#2：excluded 约束追加 / 混合 included-excluded 提交', () => {
  it('文件名含 # 的 sheet 归类正确；先排除后追加同一来源行仍不入计划/提交（零写）', async () => {
    const dir = makeTempDir('oracle-hash-name-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    // 文件任务追加带 '#' 文件名的源行（Sheet1）。
    const fileWithHash = 'we#ird.xlsx';
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { draftId: string; expectedRevision: number }, writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number }) => {
        const rev = writer.append(params.draftId, params.expectedRevision, 'project', [
          { rowId: 'src-1', sourceFile: fileWithHash, sourceSheet: 'Sheet1', businessKey: 'E-HASH', cells: { 'contract.ecc': 'E-HASH', 'contract.customer_name': '甲' } },
        ]);
        return Promise.resolve({
          newRevision: rev, preflight: { ok: true, violations: [], entries: 1, fileBytes: 1, totalCompressedBytes: 1, totalUncompressedBytes: 1, sheetCount: 1, dateSystem: '1900' },
          dateSystem: '1900', templateMode: false, templateVersionSupported: true, sheets: [], fileRows: 1, normalizedRows: 1,
          categories: { project: 1 }, issues: [], rawDigest: 'rd', planDigest: 'pd',
        });
      },
    );
    (ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(await buildXlsx([{ name: 'Sheet1', rows: [['a']] }]));
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, fileWithHash)] });
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    // sheet DTO id 为规范编码：编码后含 %23 的标识经 decodeSheetId 无歧义还原。
    const { encodeSheetId, decodeSheetId } = await import('../../src/domain/capabilities/historical-data-import/workspace/workspace-repository');
    const encodedId = encodeSheetId(fileWithHash, 'Sheet1');
    expect(decodeSheetId(encodedId)).toEqual([fileWithHash, 'Sheet1']);
    // 排除该来源。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.classifySheet, 100, draftId, encodedId, 'excluded');
    // 先排除后追加同一 (file, sheet) → 追加行自动 excluded → 不进入计划（validate 不封存）。
    const { WorkspaceRepository } = await import('../../src/domain/capabilities/historical-data-import/workspace/workspace-repository');
    const { bootstrapWorkspaceDatabase } = await import('../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap');
    const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws-hash') });
    const repo = new WorkspaceRepository(ws.db);
    const d = repo.createDraft({ name: 'x', createdBy: null, createdByUsername: null });
    let rev = repo.transitionState(d.id, 1, 'start_parsing');
    rev = repo.appendRows(d.id, rev, 'project', [{ rowId: 'h1', sourceFile: fileWithHash, sourceSheet: 'Sheet1', cells: { 'contract.ecc': 'E-H' } }]);
    rev = repo.transitionState(d.id, rev, 'parsing_finished');
    rev = repo.setSheetClassification(d.id, rev, fileWithHash, 'Sheet1', 'excluded');
    rev = repo.appendRows(d.id, rev, 'project', [{ rowId: 'h2', sourceFile: fileWithHash, sourceSheet: 'Sheet1', cells: { 'contract.ecc': 'E-H2' } }]);
    const rows = repo.queryRows(d.id, { offset: 0, limit: 10 }).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.excluded)).toBe(true); // 追加行自动 excluded
    ws.db.close();
    ctx.close();
  });

  it('混合 included/excluded：排除部分来源后剩余来源可提交且被排除零写（Oracle 最终复核 #2）', async () => {
    const dir = makeTempDir('oracle-mixed-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    await login(ctx);
    const draftId = await createDraft(ctx.bus);
    // 文件任务追加两个 sheet：A（保留）、B（排除），各自一条 project 行。
    (ctx.facadeDeps.runFileTask as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { draftId: string; expectedRevision: number }, writer: { append: (id: string, rev: number, category: string, rows: unknown[]) => number }) => {
        const rev = writer.append(params.draftId, params.expectedRevision, 'project', [
          { rowId: 'a-1', sourceFile: 'f.xlsx', sourceSheet: 'A', businessKey: 'E-KEEP', cells: { 'contract.ecc': 'E-KEEP', 'contract.customer_name': '甲' } },
          { rowId: 'b-1', sourceFile: 'f.xlsx', sourceSheet: 'B', businessKey: 'E-DROP', cells: { 'contract.ecc': 'E-DROP', 'contract.customer_name': '乙' } },
        ]);
        return Promise.resolve({
          newRevision: rev, preflight: { ok: true, violations: [], entries: 1, fileBytes: 1, totalCompressedBytes: 1, totalUncompressedBytes: 1, sheetCount: 1, dateSystem: '1900' },
          dateSystem: '1900', templateMode: false, templateVersionSupported: true, sheets: [], fileRows: 2, normalizedRows: 2,
          categories: { project: 2 }, issues: [], rawDigest: 'rd', planDigest: 'pd',
        });
      },
    );
    (ctx.facadeDeps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(await buildXlsx([{ name: 'Sheet1', rows: [['a']] }]));
    (ctx.facadeDeps.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [join(dir, 'f.xlsx')] });
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, 100, draftId);
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, 'projects', 'data');
    for (const category of ['serviceOrders', 'invoices', 'logistics', 'serialAddresses', 'qrRequests', 'shipToRequests']) {
      await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, 100, draftId, category, 'none');
    }
    // 排除 B 来源（A 保留）。
    await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.classifySheet, 100, draftId, 'f.xlsx#B', 'excluded');
    const sealed = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.validate, 100, draftId)) as { summary: { seal: string; blockingCount: number } | null };
    expect(sealed.summary?.blockingCount).toBe(0);
    const ok = (await ctx.bus.invoke(IMPORT_WIZARD_CHANNELS.commit, 100, draftId, sealed.summary!.seal)) as { status: string; importedCounts?: Record<string, number> };
    expect(ok.status).toBe('success');
    // 仅 A 来源写入（项目 E-KEEP）；被排除的 B 零写（E-DROP 不存在）。
    expect((ctx.facadeDeps.businessDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
    const drop = ctx.facadeDeps.businessDb().prepare('SELECT id FROM contracts WHERE ecc=?').get('E-DROP');
    expect(drop).toBeUndefined();
    const keep = ctx.facadeDeps.businessDb().prepare('SELECT id FROM contracts WHERE ecc=?').get('E-KEEP');
    expect(keep).toBeTruthy();
    ctx.close();
  });
});
