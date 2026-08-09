import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const product = '搬迁服务工作台';
const packagedFolder = `${product}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const executable = join(process.cwd(), 'out', packagedFolder, `${product}.app`, 'Contents', 'MacOS', product);
test.skip(!existsSync(executable), '未找到真实打包 Electron，请先运行 npm run e2e:build');

async function initialize(page: Page): Promise<void> {
  // 无密码个人模式：空数据库自动建号并直接进入工作台（无初始化/登录界面）。
  await page.getByRole('heading', { name: '先处理提醒，再连续推进项目' }).waitFor();
}

async function assertViewport(page: Page, width: 820 | 1024 | 1440, screenshot: string): Promise<void> {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
  const layout = await page.evaluate(() => {
    const queue = document.querySelector<HTMLElement>('.queue-table-wrap');
    const filters = document.querySelector<HTMLElement>('.queue-filters');
    const topbar = document.querySelector<HTMLElement>('.topbar');
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      queueOverflow: queue ? getComputedStyle(queue).overflowX : '',
      filtersOverflow: filters ? filters.scrollWidth - filters.clientWidth : 999,
      topbarPosition: topbar ? getComputedStyle(topbar).position : '',
      topbarTop: topbar?.getBoundingClientRect().top ?? 999,
    };
  });
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.queueOverflow).toMatch(/auto|scroll/);
  expect(layout.filtersOverflow).toBeLessThanOrEqual(1);
  expect(layout.topbarPosition).toBe('sticky');
  expect(layout.topbarTop).toBeGreaterThanOrEqual(-1);
  await expect(page.getByRole('heading', { name: /高密项目队列/ })).toBeVisible();
  await expect(page.getByText(/第 0–0 项 \/ 共 0 项/)).toBeVisible();
  await page.screenshot({ path: screenshot, fullPage: true });
}

async function assertIndependentDrawer(page: Page, width: 820 | 1024, screenshot: string): Promise<void> {
  await page.setViewportSize({ width, height: 768 });
  await page.getByRole('button', { name: '序列号地址更新' }).click();
  const layout = await page.locator('.v2-independent').evaluate((root) => {
    const columns = getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean);
    const list = root.querySelector<HTMLElement>('.module-list');
    const pagination = root.querySelector<HTMLElement>('.queue-pagination');
    return {
      columns: columns.length,
      listWidth: list?.getBoundingClientRect().width ?? 0,
      paginationOverflow: pagination ? pagination.scrollWidth - pagination.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(layout.columns).toBe(width === 1024 ? 2 : 1);
  expect(layout.listWidth).toBeGreaterThan(440);
  expect(layout.paginationOverflow).toBeLessThanOrEqual(1);
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();
}

async function assertHistoryDrawer(page: Page, width: 820 | 1024, screenshot: string): Promise<void> {
  await page.setViewportSize({ width, height: 768 });
  await page.getByRole('button', { name: '浏览全部记录' }).click();
  const dialog = page.getByRole('dialog', { name: '浏览往期与全部记录' });
  await expect(dialog.getByText('全部项目')).toBeVisible();
  await expect(dialog.getByText(/后端尚未提供|请选择项目/)).toHaveCount(0);
  await expect(dialog.getByRole('columnheader', { name: '项目 / 客户' })).toBeVisible();
  const layout = await dialog.locator('.history-browser').evaluate((root) => ({
    columns: getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean).length,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(layout.columns).toBe(width === 1024 ? 2 : 1);
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: screenshot, fullPage: true });
  await dialog.getByRole('button', { name: '关闭' }).click();
}

test('Oracle #10 任务指挥台在 820 / 1024 / 1440 无页面横溢且独立模块记录区可读', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'rw-v2-layout-'));
  const userData = join(root, 'user-data');
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: executable, env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userData } });
    const page = await app.firstWindow();
    await initialize(page);
    await assertViewport(page, 1024, testInfo.outputPath('workbench-v2-1024.png'));
    await assertViewport(page, 1440, testInfo.outputPath('workbench-v2-1440.png'));
    await assertViewport(page, 820, testInfo.outputPath('workbench-v2-820.png'));
    await assertIndependentDrawer(page, 1024, testInfo.outputPath('serial-address-drawer-1024.png'));
    await assertIndependentDrawer(page, 820, testInfo.outputPath('serial-address-drawer-820.png'));
    await assertHistoryDrawer(page, 1024, testInfo.outputPath('history-drawer-1024.png'));
    await assertHistoryDrawer(page, 820, testInfo.outputPath('history-drawer-820.png'));
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
