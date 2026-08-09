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

async function assertViewport(page: Page, width: 1024 | 1440, screenshot: string): Promise<void> {
  await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
  const layout = await page.evaluate(() => {
    const queue = document.querySelector<HTMLElement>('.queue-table-wrap');
    const filters = document.querySelector<HTMLElement>('.queue-filters');
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      queueOverflow: queue ? getComputedStyle(queue).overflowX : '',
      filtersOverflow: filters ? filters.scrollWidth - filters.clientWidth : 999,
    };
  });
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.queueOverflow).toMatch(/auto|scroll/);
  expect(layout.filtersOverflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('heading', { name: /高密项目队列/ })).toBeVisible();
  await expect(page.getByText(/第 0–0 项 \/ 共 0 项/)).toBeVisible();
  await page.screenshot({ path: screenshot, fullPage: true });
}

test('Oracle #10 任务指挥台在 1024 / 1440 无页面横溢', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'rw-v2-layout-'));
  const userData = join(root, 'user-data');
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: executable, env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userData } });
    const page = await app.firstWindow();
    await initialize(page);
    await assertViewport(page, 1024, testInfo.outputPath('workbench-v2-1024.png'));
    await assertViewport(page, 1440, testInfo.outputPath('workbench-v2-1440.png'));
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
