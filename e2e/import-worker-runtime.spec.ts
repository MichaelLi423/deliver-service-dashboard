import { existsSync } from 'node:fs';
import { test, expect, type ElectronApplication } from '@playwright/test';
import {
  APP_EXECUTABLE,
  cleanupImportE2eFiles,
  createImportE2eFiles,
  firstWindow,
  initializeAndEnterWorkbench,
  installNativeDialogStubs,
  launchImportApp,
  openHistoryImport,
  restoreNativeDialogStubs,
  setClipboardText,
  writeImportWorkbook,
} from './import-wizard-fixture';

/**
 * 真实打包 import-wizard E2E 诊断（tasks 8.20 DataCloneError 修复）。
 *
 * - 遇到 uncaught / DataClone / worker runtime 错误：立即失败，而不是 90s 超时兜底；
 * - 文件与粘贴必须「真正成功」（sheet/行出现且无错误提示），不允许 fallback 到
 *   「出现任何 alert 都算通过」的旧诊断环；
 * - 全程走真实打包 Electron + 真实 node:worker_threads（webpack worker chunk）。
 */

const WORKER_RUNTIME_ERROR = "Cannot read properties of undefined (reading 'wc')";
const DIAGNOSE_PATTERNS = [
  /uncaught/i,
  /^DataCloneError/i,
  /could not be cloned/,
  /Cannot read properties of undefined/,
];

test.skip(!existsSync(APP_EXECUTABLE), '未找到真实打包 Electron，请先运行 npm run e2e:build');

test('真实打包 Electron：文件选择与 clipboard paste worker 真正成功且无 DataClone/wc 错误', async () => {
  test.setTimeout(90_000);
  const files = createImportE2eFiles();
  await writeImportWorkbook(files.workbook);
  let app: ElectronApplication | null = await launchImportApp(files.userData);

  try {
    const page = await firstWindow(app);
    const rendererConsole: string[] = [];
    const mainConsole: string[] = [];
    const diagnosed: string[] = [];
    const diagnose = (source: string, text: string): void => {
      rendererConsole.push(`[${source}] ${text}`);
      if (DIAGNOSE_PATTERNS.some((pattern) => pattern.test(text))) {
        diagnosed.push(`[${source}] ${text}`);
      }
    };
    page.on('console', (message) => {
      if (message.type() === 'error') diagnose('renderer:error', message.text());
      else diagnose('renderer', message.text());
    });
    page.on('pageerror', (error) => diagnose('pageerror', String(error)));
    app.process().stdout?.on('data', (chunk) => diagnose('main:stdout', String(chunk)));
    app.process().stderr?.on('data', (chunk) => diagnose('main:stderr', String(chunk)));

    /** 立即失败诊断：遇 uncaught/DataClone/wc 错误或错误 alert，抛错终止（不做 90s 超时兜底）。 */
    const assertNoDiagnosed = (what: string): void => {
      if (diagnosed.length > 0) {
        throw new Error(`E2E 诊断立即失败（${what}）：${diagnosed[0]}`);
      }
    };
    const failOnAlert = async (what: string): Promise<void> => {
      const alerts = await page.getByRole('alert').allTextContents();
      if (alerts.length > 0) {
        throw new Error(`E2E 诊断失败（${what}）：出现错误提示（不允许 fallback）：${alerts.join('|')}`);
      }
    };
    /** 严格成功轮询：仅当 poll 返回 true 且无错误信号/alert 时通过；超时抛明确错误。 */
    const waitForSuccess = async (what: string, poll: () => Promise<boolean>, deadlineMs: number): Promise<void> => {
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        assertNoDiagnosed(what);
        await failOnAlert(what);
        if (await poll()) return;
        if (Date.now() > deadline) {
          throw new Error(`E2E 诊断超时（${what}）：未在 ${deadlineMs}ms 内真正成功`);
        }
        await page.waitForTimeout(200);
      }
    };

    await installNativeDialogStubs(app, { savePath: files.template, openPaths: [files.workbook] });
    await initializeAndEnterWorkbench(page);
    await openHistoryImport(page);
    await page.getByRole('button', { name: '新建导入' }).click();
    await expect(page.getByRole('heading', { name: '准备数据' })).toBeVisible();

    // ---- 文件选择：必须真正成功（sheet 出现，无错误提示、无 DataClone/wc 信号） ----
    const fileRendererStart = rendererConsole.length;
    const fileMainStart = mainConsole.length;
    await page.getByRole('button', { name: '选择一个或多个文件' }).click();
    await waitForSuccess('文件导入', async () => (await page.getByText('历史导入-E2E.xlsx').count()) > 0, 60_000);
    assertNoDiagnosed('文件导入');
    const fileEvidence = [
      `UI: ${(await page.getByRole('alert').allTextContents()).join('\n')}`,
      `renderer console: ${rendererConsole.slice(fileRendererStart).join('\n')}`,
      `main console: ${mainConsole.slice(fileMainStart).join('\n')}`,
    ].join('\n');
    expect.soft(fileEvidence, '文件选择 worker 的界面和 console 不得出现 wc runtime 错误').not.toContain(WORKER_RUNTIME_ERROR);
    expect.soft(fileEvidence, '文件导入必须真正成功（无错误提示）').not.toContain('出现错误');

    // ---- clipboard paste：必须真正成功（行 tab 出现，无错误提示、无 DataClone/wc 信号） ----
    await page.getByRole('navigation', { name: '导入步骤' })
      .getByRole('button', { name: /二维码与 Account ID 申请/ }).click();
    await expect(page.getByRole('heading', { name: '二维码与 Account ID 申请', level: 2 })).toBeVisible();
    const dataMode = page.getByRole('button', { name: '有数据', exact: true });
    await dataMode.click();
    await expect(dataMode).toHaveAttribute('aria-pressed', 'true');

    await setClipboardText(app, [
      '申请人\t申请时间\t申请类型',
      'E2E申请人\t2026-08-02T09:00:00+08:00\t仪器服务',
    ].join('\n'));
    await page.getByRole('button', { name: '从 Excel 粘贴' }).click();
    const pasteDialog = page.getByRole('dialog', { name: '粘贴到二维码申请' });
    await pasteDialog.getByLabel('字段表头').check();
    await pasteDialog.getByLabel(/我已核对目标类别和第一行含义/).check();

    const pasteRendererStart = rendererConsole.length;
    const pasteMainStart = mainConsole.length;
    await pasteDialog.getByRole('button', { name: '建立检查点并读取剪贴板' }).click();
    await waitForSuccess('粘贴导入', async () => (await page.getByRole('tab', { name: /二维码申请 1/ }).count()) > 0, 60_000);
    assertNoDiagnosed('粘贴导入');
    const pasteEvidence = [
      `UI: ${(await page.getByRole('alert').allTextContents()).join('\n')}`,
      `renderer console: ${rendererConsole.slice(pasteRendererStart).join('\n')}`,
      `main console: ${mainConsole.slice(pasteMainStart).join('\n')}`,
    ].join('\n');
    expect.soft(pasteEvidence, 'clipboard paste worker 的界面和 console 不得出现 wc runtime 错误').not.toContain(WORKER_RUNTIME_ERROR);
    expect.soft(pasteEvidence, '粘贴导入必须真正成功（无错误提示）').not.toContain('出现错误');

    // 最终强断言：整个会话无 uncaught/DataClone/wc 信号（任何一条都会在此失败而非 90s 超时）。
    expect(diagnosed, `E2E 诊断：检测到 uncaught/DataClone/wc 错误：\n${diagnosed.join('\n')}`).toEqual([]);
  } finally {
    if (app) {
      await restoreNativeDialogStubs(app).catch(() => undefined);
      await app.close().catch(() => undefined);
      app = null;
    }
    cleanupImportE2eFiles(files);
  }
});
