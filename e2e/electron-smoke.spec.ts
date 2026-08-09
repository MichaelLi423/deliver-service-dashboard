import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

/**
 * Electron 应用级 E2E（tasks 10.4 / 10.5 的 macOS 开发机证据）。
 *
 * 运行方式（与 Windows 打包验证无关）：
 *   1) 先构建交付产物：`npm run e2e:build`（内部执行 electron-forge package，
 *      产出 out/搬迁服务工作台-darwin-arm64/搬迁服务工作台.app）
 *   2) `npm run test:e2e`
 *
 * 说明（诚实边界）：
 * - 本组测试在 macOS 开发机、以临时 userData 目录运行真实打包后的 Electron 应用，
 *   全程操作真实 UI（无密码个人模式：启动直接进入工作台，无初始化/登录/恢复码；
 *   随后四步向导/快速记录/提醒/主状态/报表），不通过 IPC 或领域服务绕过界面。
 * - 它验证的是 macOS 开发机上的可运行性；不冒充 Windows 验证。
 *   Windows 打包安装、Windows 操作系统账户保护等仍为待验证状态（见
 *   docs/verification/scenario-test-matrix.md 与 tasks.md 10.4/10.5 备注）。
 * - 应用进程通过 WORKBENCH_E2E_USER_DATA_DIR 指向临时 userData（最小测试钩子，
 *   src/main/index.ts），不会读写开发机的真实数据目录。
 */

const APP_EXECUTABLE = join(
  process.cwd(),
  'out',
  '搬迁服务工作台-darwin-arm64',
  '搬迁服务工作台.app',
  'Contents',
  'MacOS',
  '搬迁服务工作台',
);

function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'rw-e2e-'));
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: APP_EXECUTABLE,
    env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userDataDir },
  });
}

async function mainWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return window;
}

async function expectWorkbench(window: Page): Promise<void> {
  await expect(window.getByRole('heading', { name: '先处理提醒，再连续推进项目' })).toBeVisible();
  // 无密码个人模式：不得出现任何初始化/登录/恢复码界面
  await expect(window.getByRole('heading', { name: '首次使用初始化' })).toHaveCount(0);
  await expect(window.getByRole('heading', { name: '登录本地工作台' })).toHaveCount(0);
}

// 打包产物缺失时跳过（macOS 开发机验收产物未构建），并提示构建命令。
test.skip(!existsSync(APP_EXECUTABLE), '未找到 electron-forge 打包产物，请先执行 npm run e2e:build');

test.describe('Electron 应用级冒烟（macOS 开发机 · 临时 userData · 无密码个人模式）', () => {
  test('空数据库启动直接进入工作台 → 四步向导正式进单 → 快速记录 → 提醒/主状态 → 报表下钻', async () => {
    const userDataDir = makeUserDataDir();
    const app = await launchApp(userDataDir);
    try {
      const window = await mainWindow(app);

      // —— 无密码个人模式：空数据库自动建「本地用户」并直接进入工作台 ——
      await expectWorkbench(window);

      // —— 四步新建搬迁项目向导：正式进单 ——
      await window.getByRole('button', { name: '新建搬迁项目' }).click();
      const dialog = window.getByRole('dialog');
      await expect(dialog.getByText('基本信息')).toBeVisible();
      await dialog.getByLabel('客户名称').fill('E2E 华东实验室');
      await dialog.getByLabel('区域').fill('华东');
      await dialog.getByLabel('合同开始日期').fill('2026-08-01');
      await dialog.getByLabel('合同截止日期').fill('2027-07-31');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('旧址地址').fill('旧址 A 楼');
      await dialog.getByLabel('新址地址').fill('新址 B 楼');
      await dialog.getByLabel('仪器名称').fill('E2E 质谱仪');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('ECC').fill('E2E-2026-0001');
      await dialog.getByLabel('最终可确认金额（USD）').fill('100000');
      await dialog.getByRole('button', { name: /正式进单/ }).click();
      // 保存后返回工作台，项目队列出现该项目
      await expect(window.getByText('E2E-2026-0001').first()).toBeVisible();
      await expect(window.getByText('E2E 华东实验室').first()).toBeVisible();
      // 已进单项目标识（未进单/已进单视觉区分事实）
      await expect(window.getByText('已进单').first()).toBeVisible();

      // —— 快速记录：搬迁批次 ——
      await window.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await window.getByRole('button', { name: /搬迁批次/ }).click();
      const batchDialog = window.getByRole('dialog');
      await batchDialog.getByLabel('计划运输日期').fill('2026-08-10');
      await batchDialog.getByLabel('运输公司').fill('E2E 运输');
      await batchDialog.getByLabel('人民币原价').fill('12000');
      await batchDialog.getByLabel('人民币折后价').fill('11000');
      await batchDialog.getByRole('button', { name: '保存记录' }).click();
      await window.getByRole('tab', { name: '搬迁批次' }).click();
      await expect(window.getByText('E2E 运输').first()).toBeVisible();

      // —— 快速记录：上门活动（同页拆机事实） ——
      await window.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await window.getByRole('button', { name: /上门活动/ }).click();
      const visitDialog = window.getByRole('dialog');
      await expect(visitDialog.getByText('拆机', { exact: true })).toBeVisible();
      await visitDialog.getByLabel('参与工程师').fill('E2E 工程师');
      await visitDialog.getByLabel('工作事实状态').selectOption('done');
      await visitDialog.getByRole('button', { name: '保存记录' }).click();
      await window.getByRole('tab', { name: '上门活动' }).click();
      await expect(window.getByText('E2E 工程师').first()).toBeVisible();

      // —— 快速记录：掉票 ——
      await window.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await window.getByRole('button', { name: /^掉票 按 ECC/ }).click();
      const invoiceDialog = window.getByRole('dialog');
      await invoiceDialog.getByLabel('掉票金额（USD）').fill('40000');
      await invoiceDialog.getByLabel('掉票时间').fill('2026-08-11T09:00');
      await invoiceDialog.getByRole('button', { name: '保存记录' }).click();
      await window.getByRole('tab', { name: '费用与掉票' }).click();
      await expect(window.getByText('USD 40,000.00').first()).toBeVisible();

      // —— 掉票维护：十进制字符串编辑、不可恢复撤销、更正后新增 ——
      let invoicePanel = window.getByRole('tabpanel');
      await invoicePanel.getByRole('button', { name: '编辑' }).click();
      const editInvoiceDialog = window.getByRole('dialog');
      await editInvoiceDialog.getByLabel('掉票金额（USD）').fill('39000.125');
      await editInvoiceDialog.getByRole('button', { name: '保存修改' }).click();
      await expect(window.getByText('USD 39,000.13').first()).toBeVisible();

      invoicePanel = window.getByRole('tabpanel');
      await invoicePanel.getByRole('button', { name: '撤销' }).click();
      const revokeDialog = window.getByRole('dialog');
      await revokeDialog.getByLabel('撤销原因').fill('E2E 金额更正');
      await revokeDialog.getByLabel(/我确认撤销后不可恢复/).check();
      await revokeDialog.getByRole('button', { name: '确认撤销掉票' }).click();
      await expect(window.getByText('终态 · 更正请新增')).toBeVisible();

      await window.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await window.getByRole('button', { name: /^掉票 按 ECC/ }).click();
      const correctedInvoiceDialog = window.getByRole('dialog');
      await correctedInvoiceDialog.getByLabel('掉票金额（USD）').fill('40000');
      await correctedInvoiceDialog.getByLabel('掉票时间').fill('2026-08-11T10:00');
      await correctedInvoiceDialog.getByRole('button', { name: '保存记录' }).click();

      // —— 项目提醒手工维护 ——
      await window.getByRole('button', { name: '维护提醒' }).first().click();
      const reminderDialog = window.getByRole('dialog');
      await reminderDialog.getByLabel('当前提醒时间').fill('2026-08-12T09:00');
      await reminderDialog.getByLabel('备注内容').fill('E2E 提醒：确认第二批次运输');
      await reminderDialog.getByRole('button', { name: '保存当前提醒' }).click();
      await expect(window.getByText(/E2E 提醒/).first()).toBeVisible();

      // —— 主状态人工调整（待执行 → 执行中，经 lifecycle 校验） ——
      await window.getByLabel('人工调整主状态').selectOption('executing');
      await window.getByRole('button', { name: '提交校验' }).click();
      await expect(window.getByText('项目主状态已通过生命周期校验并更新')).toBeVisible();

      // —— 报表：手工月份区间、下钻 ——
      await window.getByRole('button', { name: '运营报表' }).click();
      const reportDialog = window.getByRole('dialog');
      await reportDialog.getByLabel('起始月份').fill('2026-08');
      await reportDialog.getByLabel('截止月份').fill('2026-08');
      await reportDialog.getByRole('button', { name: '实时计算报表' }).click();
      await expect(reportDialog.getByText('月度掉票').first()).toBeVisible();
      await reportDialog.getByRole('button', { name: '查看明细' }).first().click();
      await expect(reportDialog.getByRole('heading', { name: '下钻明细' })).toBeVisible();

      // —— 已移除路径核查：无独立备件申请、无 CSV 导出 ——
      await window.keyboard.press('Escape'); // 关闭运营报表层
      await window.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await expect(window.getByRole('dialog').getByText('备件申请')).not.toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByRole('button', { name: '导出 CSV' })).toHaveCount(0);
    } finally {
      await app.close();
      previousUserDataDir = userDataDir;
    }
  });

  test('关闭并重开应用：无密码模式直接进入工作台，已有账号与数据保留', async () => {
    // 上一用例产物目录（顺序执行，fullyParallel=false）
    test.skip(previousUserDataDir === null, '需要先运行初始化用例以得到临时 userData 目录');
    const userDataDir = previousUserDataDir!;

    const app = await launchApp(userDataDir);
    try {
      const window = await mainWindow(app);
      // 重开应用：无密码模式直接进入工作台（无登录界面），数据保留
      await expectWorkbench(window);
      await expect(window.getByText('E2E-2026-0001').first()).toBeVisible();
      await expect(window.getByText('E2E 华东实验室').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）', async () => {
    const userDataDir = makeUserDataDir();
    const app = await launchApp(userDataDir);
    try {
      const window = await mainWindow(app);

      // 无密码个人模式：空数据库自动建号并直接进入工作台
      await expectWorkbench(window);

      // —— 未进单先执行：四步向导第三个保存路径 ——
      await window.getByRole('button', { name: '新建搬迁项目' }).click();
      let dialog = window.getByRole('dialog');
      await dialog.getByLabel('客户名称').fill('E2E 未进单先执行客户');
      await dialog.getByLabel('区域').fill('华北');
      await dialog.getByLabel('合同开始日期').fill('2026-08-01');
      await dialog.getByLabel('合同截止日期').fill('2027-07-31');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('旧址地址').fill('旧址');
      await dialog.getByLabel('新址地址').fill('新址');
      await dialog.getByLabel('仪器名称').fill('E2E 仪器甲');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('经理批复原因').fill('E2E 经理批复');
      await dialog.getByRole('button', { name: /未进单先执行/ }).click();
      // 未进单项目标识 + 未进单先执行标签
      await expect(window.getByText('未进单').first()).toBeVisible();
      await expect(window.getByText('未进单先执行').first()).toBeVisible();

      // —— 实际装机完成时间自动进入待验收 ——
      await window.getByRole('button', { name: '新建搬迁项目' }).click();
      dialog = window.getByRole('dialog');
      await dialog.getByLabel('客户名称').fill('E2E 装机完成客户');
      await dialog.getByLabel('区域').fill('华东');
      await dialog.getByLabel('合同 USD 含税金额').fill('10000');
      await dialog.getByLabel('合同开始日期').fill('2026-08-01');
      await dialog.getByLabel('合同截止日期').fill('2027-07-31');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('旧址地址').fill('旧址');
      await dialog.getByLabel('新址地址').fill('新址');
      await dialog.getByLabel('仪器名称').fill('E2E 仪器乙');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('实际装机完成时间').fill('2026-08-08T18:00');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await dialog.getByLabel('ECC').fill('E2E-2026-0002');
      await dialog.getByRole('button', { name: /正式进单/ }).click();
      // 实际装机完成 → 自动进入待验收
      await expect(window.getByText('待验收').first()).toBeVisible();

      // —— 验收报告 → 自动进入待掉票 ——
      await window.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await window.getByRole('button', { name: /验收报告/ }).click();
      const acceptanceDialog = window.getByRole('dialog');
      await acceptanceDialog.getByLabel('验收报告形成日期').fill('2026-08-10');
      await acceptanceDialog.getByRole('button', { name: '保存记录' }).click();
      await expect(window.getByText('待掉票').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

// 跨用例共享：初始化用例产生的临时 userData（同一 worker 顺序执行）。
let previousUserDataDir: string | null = null;
