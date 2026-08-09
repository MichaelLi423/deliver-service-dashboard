import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../domain/capabilities/local-data-persistence/connection';
import {
  createAutoBackupIfNeeded,
  createManualBackup,
} from '../domain/capabilities/local-data-persistence/backup';
import { restoreFromBackup } from '../domain/capabilities/local-data-persistence/restore';
import { rotateContentGeneration } from '../domain/capabilities/local-data-persistence/identity';
import { SqliteAccountRepository } from '../domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../domain/capabilities/workbench-access';
import { SystemClock } from '../domain/core/time';
import type { AccountSessionInfo } from '../shared/ipc';
import { IMPORT_WIZARD_CHANNELS } from '../shared/ipc';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../domain/capabilities/historical-data-import/workspace';
import { runImportFileTaskInWorker, runImportPasteTaskInWorker } from '../domain/capabilities/historical-data-import/import-worker/import-worker-host';
import {
  registerIpcHandlers,
  type IpcHandlerDeps,
} from './ipc-handlers';
import { ImportWizardFacade, type ImportWizardFacadeDeps } from './import-wizard-facade';

/**
 * 主进程入口（tasks 1.1 工程骨架）。
 * main / preload / renderer 严格分离：
 * - contextIsolation: true，nodeIntegration: false，sandbox: true；
 * - 渲染层无 Node 访问，仅经 preload contextBridge 调用 IPC。
 * - 本地 SQLite（node:sqlite）仅在主进程使用；数据目录 userData/data。
 *
 * MAIN_WINDOW_WEBPACK_ENTRY / MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
 * 由 @electron-forge/plugin-webpack 在构建时注入（见 forge.config.ts entryPoints）。
 */

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const isDev = !app.isPackaged;

// 测试钩子（仅 E2E/验收环境使用，不改变业务行为）：允许把 userData 指向临时目录，
// 避免污染真实数据目录（Windows 交付形态不受影响）。
if (process.env.WORKBENCH_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.WORKBENCH_E2E_USER_DATA_DIR);
}

let mainWindow: BrowserWindow | null = null;
let db: DatabaseSync | null = null;
let dbPath = '';

/** 导入工作区（独立 app-private 数据库；损坏/不兼容仅禁用导入）。 */
let workspaceDb: DatabaseSync | null = null;
let workspaceDir = '';
/** 工作区不可用原因（enabled=false 时展示；普通工作台不受影响）。 */
let importWizardErrorState: string | null = null;

/** 历史数据导入向导 facade（启动/恢复时初始化或重连）。 */
let importWizardFacade: ImportWizardFacade | null = null;

/** 当前访问会话（仅主进程内存持有；无密码个人模式下启动/恢复时自动建立）。 */
let currentSession: AccountSessionInfo | null = null;

/** 启动时每日自动备份失败信息（失败不阻止窗口打开，传给访问门/工作台展示）。 */
let autoBackupError: string | null = null;

function accountService(): LocalAccountService {
  return new LocalAccountService(new SqliteAccountRepository(requireDb()));
}

/**
 * 无密码个人模式：确保唯一本地账号并建立访问会话。
 * - 已有账号：沿用其 username 建立会话；
 * - 空数据库：自动创建固定内部账号「本地用户」（随机秘密仅落 scrypt 派生值）。
 * 应用启动后直接进入工作台，无需登录。
 */
async function ensureLocalSession(): Promise<AccountSessionInfo> {
  const session = await accountService().ensureLocalSession();
  const info: AccountSessionInfo = { accountId: session.accountId, username: session.username };
  currentSession = info;
  return info;
}

function requireDb(): DatabaseSync {
  if (!db) {
    throw new Error('本地数据库尚未初始化');
  }
  return db;
}

function dataDir(): string {
  return path.join(app.getPath('userData'), 'data');
}

/**
 * 回收旧导入向导（Oracle 复审 #1）：会话失效/取消 worker → 关闭旧工作区连接 →
 * 丢弃旧 facade。旧 facade 的 chunkWriter/repo 经全局 getter 指向 `workspaceDb`，
 * 不回收会写入恢复后的新库（跨库写入竞态）。
 */
function teardownImportWizard(): void {
  if (importWizardFacade) {
    try {
      importWizardFacade.onSessionInvalidated();
    } catch {
      // 回收失败不影响主流程
    }
    importWizardFacade = null;
  }
  if (workspaceDb) {
    try {
      closeWorkspaceDatabase(workspaceDb);
    } catch {
      // 关闭失败不影响主流程
    }
    workspaceDb = null;
  }
}

/**
 * 初始化导入工作区与 facade（tasks 8.53 + Oracle 复审 #1：启动/数据库恢复时正确
 * 初始化或重连）。工作区损坏/版本不兼容：仅禁用导入功能，普通工作台不受影响。
 */
function initializeImportWizard(): void {
  // 先回收旧 facade/连接，再重开新连接（恢复竞态安全：旧 writer 不能写新库）。
  teardownImportWizard();
  try {
    workspaceDir = path.join(app.getPath('userData'), 'import-workspace');
    workspaceDb = bootstrapWorkspaceDatabase({ workspaceDir }).db;
    importWizardErrorState = null;
  } catch (error) {
    workspaceDb = null;
    importWizardErrorState = error instanceof Error ? error.message : String(error);
  }
  const facadeDeps: ImportWizardFacadeDeps = {
    workspaceDir,
    workspaceDb: () => {
      if (!workspaceDb) {
        throw new Error(`导入工作区不可用：${importWizardErrorState ?? '未知原因'}`);
      }
      return workspaceDb;
    },
    businessDb: requireDb,
    snapshotDir: () => path.join(dataDir(), 'import-snapshots'),
    session: () => currentSession,
    showOpenDialog: (options) => dialog.showOpenDialog(mainWindow!, options),
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow!, options),
    readFile: (filePath) => readFile(filePath),
    statFile: async (filePath) => {
      const s = await stat(filePath);
      return { size: s.size };
    },
    writeFile: (filePath, bytes) => writeFile(filePath, bytes),
    clipboardText: () => clipboard.readText(),
    runFileTask: (params, writer, options) => runImportFileTaskInWorker(params, writer, options),
    runPasteTask: (params, writer, options) => runImportPasteTaskInWorker(params, writer, options),
    emitProgress: (event) => {
      mainWindow?.webContents.send(IMPORT_WIZARD_CHANNELS.progressEvent, event);
    },
  };
  importWizardFacade = new ImportWizardFacade(facadeDeps, new SystemClock());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    show: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Oracle 复审 #5：阻止外部导航与 window.open（受信窗口只加载主窗口入口）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== MAIN_WINDOW_WEBPACK_ENTRY) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function registerIpcHandlersWithDeps(): void {
  const deps: IpcHandlerDeps = {
    db: requireDb,
    dbPath: () => dbPath,
    dataDir,
    accountService,
    session: () => currentSession,
    setSession: (session) => {
      const wasLoggedIn = currentSession !== null;
      currentSession = session;
      // 会话失效/登出/恢复后：取消活动读取、保留最后修订、invalidate seal（重登录须重新校验）。
      if (wasLoggedIn && session === null) {
        importWizardFacade?.onSessionInvalidated();
      }
    },
    trustedSenderId: () => mainWindow?.webContents.id ?? null,
    // Oracle 二次复审 #4：返回受信入口 URL（http 精确 origin / file 精确入口路径）。
    trustedSenderOrigin: () => MAIN_WINDOW_WEBPACK_ENTRY,
    autoBackupError: () => autoBackupError,
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow!, options),
    showOpenDialog: (options) => dialog.showOpenDialog(mainWindow!, options),
    writeFile: (filePath, bytes) => writeFile(filePath, bytes),
    createManualBackup: (targetDir) =>
      createManualBackup(requireDb(), targetDir, { clock: new SystemClock() }),
    createCleanupBackup: () => {
      const backupDir = path.join(app.getPath('userData'), 'backups', 'clean');
      return createManualBackup(requireDb(), backupDir, { clock: new SystemClock() });
    },
    restoreFromBackup: (backupPath) =>
      restoreFromBackup({
        backupPath,
        dbPath,
        snapshotDir: path.join(dataDir(), 'restore-snapshots'),
        currentDb: requireDb(),
        closeConnection: () => {
          if (db) {
            closeDatabase(db);
            db = null;
          }
        },
        openConnection: () => {
          db = bootstrapDatabase({ dataDir: dataDir() }).db;
        },
        // 成功恢复后轮换 content_generation_id：使基于旧库内容的 validation seal 必失效；
        // 失败恢复不进入该回调，原库 generation 保持不变。此时 openConnection 已重建 db。
        onRestored: () => {
          rotateContentGeneration(requireDb());
          // 恢复业务库后重连/重建导入向导 facade（先回收旧连接与活动任务，再重开 + recover）。
          initializeImportWizard();
          if (workspaceDb !== null) {
            importWizardFacade?.recover();
          }
        },
        clock: new SystemClock(),
      }),
    importWizardFacade: () => {
      if (!importWizardFacade) throw new Error('历史数据导入向导尚未初始化');
      return importWizardFacade;
    },
    importWizardEnabled: () => importWizardErrorState === null,
    importWizardError: () => importWizardErrorState,
  };
  registerIpcHandlers(ipcMain, deps);
}

app.whenReady().then(async () => {
  db = bootstrapDatabase({ dataDir: dataDir() }).db;
  dbPath = path.join(dataDir(), 'workbench.db');

  // 无密码个人模式：启动时确保唯一本地账号并建立访问会话
  // （已有账号自动会话；空数据库自动建「本地用户」并直接进入工作台）。
  await ensureLocalSession();

  // 导入工作区初始化（损坏/不兼容仅禁用导入，普通工作台不受影响）。
  initializeImportWizard();
  if (workspaceDb !== null) {
    importWizardFacade?.recover();
  }

  // 每日首次使用自动备份（当日已存在则不重复创建）。
  // 自动备份失败不阻止窗口打开：记录明确错误状态，由访问门/工作台展示。
  try {
    const autoBackupDir = path.join(app.getPath('userData'), 'backups', 'auto');
    await createAutoBackupIfNeeded(requireDb(), autoBackupDir, { clock: new SystemClock() });
  } catch (error) {
    autoBackupError = (error as Error).message ?? String(error);
  }

  registerIpcHandlersWithDeps();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (db) {
    try {
      closeDatabase(db);
    } catch {
      // 退出清理失败不影响退出流程
    }
    db = null;
  }
  teardownImportWizard();
});
