import { existsSync } from 'node:fs';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  APP_EXECUTABLE,
  cleanupImportE2eFiles,
  createImportE2eFiles,
  firstWindow,
  initializeAndEnterWorkbench,
  installNativeDialogStubs,
  launchImportApp,
  loginAndEnterWorkbench,
  openHistoryImport,
  restoreNativeDialogStubs,
  setClipboardText,
  writeImportFlowWorkbook,
} from './import-wizard-fixture';

test.skip(!existsSync(APP_EXECUTABLE), '未找到真实打包 Electron，请先运行 npm run e2e:build');

async function chooseStep(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('navigation', { name: '导入步骤' }).getByRole('button', { name }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function chooseNone(page: Page): Promise<void> {
  const none = page.getByRole('button', { name: '本次不导入', exact: true });
  if (await none.getAttribute('aria-pressed') !== 'true') await none.click();
  await expect(none).toHaveAttribute('aria-pressed', 'true');
}

async function saveAndExit(page: Page): Promise<void> {
  await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存并退出？' });
  await dialog.getByRole('button', { name: '保存并退出' }).click();
  await expect(page.getByRole('heading', { name: '先处理提醒，再连续推进项目' })).toBeVisible();
}

async function openSavedDraft(page: Page): Promise<void> {
  await openHistoryImport(page);
  await page.getByRole('button', { name: '继续草稿' }).click();
  await expect(page.getByTestId('history-import-workspace')).toBeVisible();
}

async function editGridCell(page: Page, label: string, value: string, row = 1): Promise<void> {
  const cell = page.getByRole('gridcell', { name: new RegExp(`${label}，第 ${row} 行`) });
  await cell.click();
  await cell.press('Enter');
  const editor = page.getByRole('textbox', { name: `编辑第 ${row} 行 ${label}` });
  await editor.fill(value);
  await editor.press('Enter');
  await expect(cell).toContainText(value);
}

async function captureDesktopEvidence(page: Page, width: 1024 | 1440, screenshotPath: string): Promise<void> {
  await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
  const result = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('[data-testid="history-import-workspace"]');
    const viewport = document.querySelector<HTMLElement>('[data-testid="history-import-grid-viewport"]');
    const issue = document.querySelector<HTMLElement>('.hiw-issue-kind');
    const active = document.activeElement as HTMLElement | null;
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workspaceFont: workspace ? Number.parseFloat(getComputedStyle(workspace).fontSize) : 0,
      issueFont: issue ? Number.parseFloat(getComputedStyle(issue).fontSize) : 0,
      gridOverflow: viewport ? getComputedStyle(viewport).overflowX : '',
      gridHasInternalOverflow: viewport ? viewport.scrollWidth > viewport.clientWidth : false,
      activeRole: active?.getAttribute('role') ?? '',
      activeName: active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? '',
    };
  });
  expect(result.pageOverflow).toBeLessThanOrEqual(1);
  expect(result.workspaceFont).toBeGreaterThanOrEqual(14);
  expect(result.issueFont).toBeGreaterThanOrEqual(11);
  expect(result.gridOverflow).toMatch(/auto|scroll/);
  expect(result.gridHasInternalOverflow).toBe(true);
  expect(result.activeRole).toBe('gridcell');
  expect(result.activeName).toContain('客户名称');
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

test('真实历史导入全流程：失败零部分、原子提交与重启持久化', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const files = createImportE2eFiles();
  await writeImportFlowWorkbook(files.workbook);
  let app: ElectronApplication | null = await launchImportApp(files.userData);

  try {
    let page = await firstWindow(app);
    await installNativeDialogStubs(app, { savePath: files.template, openPaths: [files.workbook] });
    await initializeAndEnterWorkbench(page);

    await page.getByText('数据管理', { exact: true }).click();
    const dataMenu = page.getByRole('group').filter({ hasText: '数据管理' });
    await expect(dataMenu.getByRole('button', { name: '历史数据导入' })).toBeVisible();
    await expect(dataMenu.getByRole('button', { name: '手动备份' })).toBeVisible();
    await expect(dataMenu.getByRole('button', { name: '恢复备份' })).toBeVisible();
    await dataMenu.getByRole('button', { name: '历史数据导入' }).click();
    await expect(page.getByRole('heading', { name: '把旧数据整理成一份可核对的导入计划' })).toBeVisible();
    await page.getByRole('button', { name: '新建导入' }).click();

    await page.getByRole('button', { name: '下载 Excel 模板' }).click();
    await expect.poll(() => existsSync(files.template)).toBe(true);
    await expect(page.getByText(/空白模板.*已保存/)).toBeVisible();

    await page.getByRole('button', { name: '选择一个或多个文件' }).click();
    await expect(page.getByText('历史导入-E2E.xlsx').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('项目与合同 目标类别')).toHaveValue('projects');
    await page.getByRole('button', { name: /^列映射/ }).click();
    const mapping = page.getByRole('region', { name: '列映射' });
    await expect(mapping.getByRole('columnheader', { name: '源列' })).toBeVisible();
    await expect(mapping.getByRole('columnheader', { name: '目标字段' })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();

    await chooseStep(page, /项目与合同/);
    await page.getByRole('button', { name: '有数据', exact: true }).click();
    await expect(page.getByRole('grid', { name: '项目与合同目标网格' })).toContainText('E2E-IMPORT-0001');

    await chooseStep(page, /开单记录/); await chooseNone(page);
    await chooseStep(page, /掉票与物流费用/); await chooseNone(page);
    await page.getByRole('tab', { name: /物流费用/ }).click(); await chooseNone(page);
    await chooseStep(page, /序列号地址更新/); await chooseNone(page);
    await chooseStep(page, /二维码与 Ship-to 申请/);
    await page.getByRole('button', { name: '有数据', exact: true }).click();

    await setClipboardText(app, [
      'source_row_id\t申请人\t申请时间\t申请类型',
      'e2e-qr-1\tE2E 粘贴申请人\t2026-08-02T09:00:00+08:00\t仪器服务',
    ].join('\n'));
    await page.getByRole('button', { name: '从 Excel 粘贴' }).click();
    const pasteDialog = page.getByRole('dialog', { name: '粘贴到二维码申请' });
    await pasteDialog.getByLabel('字段表头').check();
    await pasteDialog.getByLabel(/我已核对目标类别和第一行含义/).check();
    await pasteDialog.getByRole('button', { name: '建立检查点并读取剪贴板' }).click();
    await expect(page.getByRole('tab', { name: /二维码申请 1/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: /撤销/ }).click();
    await expect(page.getByRole('tab', { name: /二维码申请 0/ })).toBeVisible();
    await page.getByRole('button', { name: /重做/ }).click();
    await expect(page.getByRole('tab', { name: /二维码申请 1/ })).toBeVisible();
    await page.getByRole('tab', { name: /Ship-to 申请/ }).click(); await chooseNone(page);

    await saveAndExit(page);
    await openSavedDraft(page);
    await expect(page.getByRole('heading', { name: '二维码与 Ship-to 申请', level: 2 })).toBeVisible();
    await expect(page.getByRole('tab', { name: /二维码申请 1/ })).toBeVisible();

    await chooseStep(page, /校验摘要与确认/);
    await page.getByRole('button', { name: '开始完整校验' }).click();
    const issues = page.getByRole('complementary', { name: '全局问题面板' });
    await expect(issues).toContainText(/客户名称.*必填/, { timeout: 60_000 });
    await issues.getByRole('listitem').filter({ hasText: '客户名称' }).getByRole('button', { name: '定位' }).click();
    const customerCell = page.getByRole('gridcell', { name: /客户名称，第 1 行/ });
    await expect(customerCell).toBeFocused();

    await captureDesktopEvidence(page, 1024, testInfo.outputPath('import-wizard-1024.png'));
    await captureDesktopEvidence(page, 1440, testInfo.outputPath('import-wizard-1440.png'));
    await expect(issues.getByText('错误', { exact: true }).first()).toBeVisible();
    await expect(issues.getByText('冲突', { exact: true }).first()).toBeVisible();
    await expect(issues.getByText('警告', { exact: true }).first()).toBeVisible();
    await editGridCell(page, '客户名称', 'E2E 历史客户');

    await chooseStep(page, /校验摘要与确认/);
    await page.getByRole('button', { name: /重新完整校验|开始完整校验/ }).click();
    await expect(page.getByText('计划已封存')).toBeVisible({ timeout: 60_000 });
    const review = page.getByRole('region', { name: '校验摘要与确认' });
    await expect(review.getByText('E2E导入负责人')).toBeVisible();
    await expect(review.getByText('100000.00')).toBeVisible();
    await expect(review).toContainText('项目与合同');
    await expect(review).toContainText('二维码申请');

    await saveAndExit(page);
    await page.getByRole('button', { name: '二维码申请' }).click();
    const qrDialog = page.getByRole('dialog');
    await qrDialog.getByLabel('申请人').fill('E2E 基线变更申请人');
    await qrDialog.getByRole('checkbox').first().check();
    await qrDialog.getByRole('button', { name: /保存/ }).click();

    await openSavedDraft(page);
    await chooseStep(page, /校验摘要与确认/);
    await page.getByLabel(/我已核对七类记录范围/).check();
    const firstWarningCheck = page.getByLabel(/我已查看并确认/);
    if (await firstWarningCheck.count()) await firstWarningCheck.check();
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.getByRole('dialog', { name: '确认整体导入' }).getByRole('button', { name: '开始导入' }).click();
    const failed = page.getByRole('dialog', { name: '导入未完成' });
    await expect(failed).toContainText('没有产生部分导入');
    await failed.getByRole('button', { name: '完成' }).click();
    await saveAndExit(page);
    await expect(page.getByText('E2E-IMPORT-0001')).toHaveCount(0);

    await openSavedDraft(page);
    await chooseStep(page, /校验摘要与确认/);
    await page.getByRole('button', { name: /重新完整校验|开始完整校验/ }).click();
    await expect(page.getByText('计划已封存')).toBeVisible({ timeout: 60_000 });
    await page.getByLabel(/我已核对七类记录范围/).check();
    const warningCheck = page.getByLabel(/我已查看并确认/);
    if (await warningCheck.count()) await warningCheck.check();
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.getByRole('dialog', { name: '确认整体导入' }).getByRole('button', { name: '开始导入' }).click();
    await expect(page.getByRole('dialog', { name: '导入完成' })).toContainText('未产生部分导入');

    await restoreNativeDialogStubs(app);
    await app.close();
    app = null;

    app = await launchImportApp(files.userData);
    page = await firstWindow(app);
    await loginAndEnterWorkbench(page);
    await expect(page.getByText('E2E-IMPORT-0001').first()).toBeVisible();
    await expect(page.getByText('E2E 历史客户').first()).toBeVisible();
    await page.getByRole('button', { name: '二维码申请' }).click();
    await expect(page.getByRole('dialog')).toContainText('E2E 粘贴申请人');
  } finally {
    if (app) {
      await restoreNativeDialogStubs(app).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    cleanupImportE2eFiles(files);
  }
});
