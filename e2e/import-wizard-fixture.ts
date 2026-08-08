import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const product = '搬迁服务工作台';
const packagedFolder = `${product}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
export const APP_EXECUTABLE = join(process.cwd(), 'out', packagedFolder, `${product}.app`, 'Contents', 'MacOS', product);

export interface ImportE2eFiles {
  root: string;
  userData: string;
  workbook: string;
  template: string;
}

export function createImportE2eFiles(): ImportE2eFiles {
  const root = mkdtempSync(join(tmpdir(), 'rw-import-e2e-'));
  const userData = join(root, 'user-data');
  mkdirSync(userData);
  return {
    root,
    userData,
    workbook: join(root, '历史导入-E2E.xlsx'),
    template: join(root, '下载的空白模板.xlsx'),
  };
}

export function cleanupImportE2eFiles(files: ImportE2eFiles): void {
  rmSync(files.root, { recursive: true, force: true });
}

export async function writeImportWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const project = workbook.addWorksheet('项目与合同');
  project.addRow(['ECC', '客户名称']);
  project.addRow(['E2E-WORKER-0001', 'E2E客户']);
  await workbook.xlsx.writeFile(path);
}

export async function writeImportFlowWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const instructions = workbook.addWorksheet('填写说明');
  instructions.getCell('A1').value = '搬迁服务历史数据导入模板';
  instructions.getCell('A2').value = '模板版本';
  instructions.getCell('B2').value = 1;
  instructions.getCell('A3').value = '字段目录版本';
  instructions.getCell('B3').value = 1;

  const project = workbook.addWorksheet('项目与合同');
  project.addRow(['source_row_id', 'ECC', '客户名称', '合同USD含税金额', '区域', '进单时间', '合同开始日期', '合同截止日期', '实际装机完成时间', '验收报告形成日期', '取消时间', '仪器名称', '序列号']);
  project.addRow(['e2e-project-1', 'E2E-IMPORT-0001', '', '100000.00', '华东', '2026-08-01T09:00:00+08:00', '2026-08-01', '2027-07-31', '', '', '', 'E2E 历史色谱仪', 'E2E-SN-001']);

  const sheets: Array<[string, string[]]> = [
    ['开单记录', ['source_row_id', '服务单号', '开单类型', '开单时间', '工程师', '客户单位', '备注']],
    ['掉票记录', ['source_row_id', 'ECC', '掉票金额', '掉票时间', '区域', '客户名称']],
    ['物流费用', ['source_row_id', 'ECC', '物流费用申请（登记）时间', '预算价格', '成交价格', '实际物流费用', '物流公司']],
    ['序列号地址更新', ['source_row_id', '客户名称', '新址地址', '序列号', 'Account ID', '更新时间']],
    ['二维码申请', ['source_row_id', '申请人', '申请时间', '申请类型', '类型数量']],
    ['Ship-to 申请', ['source_row_id', '客户名称', '新址地址', 'Account ID', '日期']],
  ];
  for (const [name, headers] of sheets) workbook.addWorksheet(name).addRow(headers);
  await workbook.xlsx.writeFile(path);
}

export async function launchImportApp(userData: string): Promise<ElectronApplication> {
  if (!existsSync(APP_EXECUTABLE)) throw new Error(`未找到打包产物：${APP_EXECUTABLE}`);
  return electron.launch({
    executablePath: APP_EXECUTABLE,
    env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userData },
  });
}

export async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export async function installNativeDialogStubs(
  app: ElectronApplication,
  paths: { savePath: string; openPaths: string[] },
): Promise<void> {
  await app.evaluate(async ({ dialog }, value) => {
    const scope = globalThis as typeof globalThis & {
      __rwImportDialogOriginals?: {
        save: typeof dialog.showSaveDialog;
        open: typeof dialog.showOpenDialog;
      };
    };
    if (!scope.__rwImportDialogOriginals) {
      scope.__rwImportDialogOriginals = { save: dialog.showSaveDialog, open: dialog.showOpenDialog };
    }
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePath: value.savePath }),
    });
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: value.openPaths }),
    });
  }, paths);
}

export async function restoreNativeDialogStubs(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ dialog }) => {
    const scope = globalThis as typeof globalThis & {
      __rwImportDialogOriginals?: {
        save: typeof dialog.showSaveDialog;
        open: typeof dialog.showOpenDialog;
      };
    };
    const originals = scope.__rwImportDialogOriginals;
    if (!originals) return;
    Object.defineProperty(dialog, 'showSaveDialog', { configurable: true, value: originals.save });
    Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: originals.open });
    delete scope.__rwImportDialogOriginals;
  });
}

export async function setClipboardText(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(async ({ clipboard }, value) => clipboard.writeText(value), text);
}

export async function initializeAndEnterWorkbench(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '首次使用初始化' }).waitFor();
  await page.getByLabel('用户名').fill('E2E导入负责人');
  await page.getByLabel('密码', { exact: false }).fill('e2e-import-password');
  await page.getByRole('button', { name: '创建账号并继续' }).click();
  await page.getByRole('heading', { name: '离线保存恢复码' }).waitFor();
  await page.getByRole('button', { name: '我已离线保存' }).click();
  await page.getByRole('heading', { name: '先处理提醒，再连续推进项目' }).waitFor();
}

export async function loginAndEnterWorkbench(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '登录本地工作台' }).waitFor();
  await page.getByLabel('用户名').fill('E2E导入负责人');
  await page.getByLabel('密码', { exact: false }).fill('e2e-import-password');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('heading', { name: '先处理提醒，再连续推进项目' }).waitFor();
}

export async function openHistoryImport(page: Page): Promise<void> {
  await page.getByText('数据管理', { exact: true }).click();
  await page.getByRole('button', { name: '历史数据导入' }).click();
  await page.getByRole('heading', { name: '把旧数据整理成一份可核对的导入计划' }).waitFor();
}
