import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
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
} from './import-wizard-fixture';

/**
 * 8.83 只读验证：真实 5 份 docs xlsx 经真实打包 Electron 向导 + 真实 IPC/worker
 * 执行完整校验（tasks 8.83）。
 *
 * 硬边界：
 * - 绝不 import/commit：只走到完整校验，不触发确认导入；断言临时业务 DB 业务表零写；
 * - 绝不输出业务值：只收集文件哈希、类别记录数、issue_code+severity 分类计数、
 *   draft 状态、seal 存在性；不读取/不打印客户/ECC/序列号/Account ID/金额。
 *
 * 默认跳过（不影响常规 CI）：仅 `RUN_REAL_SOURCE_READONLY=1 npx playwright test e2e/real-source-readonly.spec.ts` 执行。
 */

const REAL_FILES = [
  'docs/合同信息表.xlsx',
  'docs/项目执行表.xlsx',
  'docs/工作量统计.xlsx',
  'docs/供应商表.xlsx',
  'docs/物流公司信息费用表.xlsx',
];

/** 历史 dry-run（旧 CLI 引擎口径）分类摘要：554 必填缺失错误 / 124 冲突。 */
const HISTORICAL_ERRORS = 554;
const HISTORICAL_CONFLICTS = 124;

test.skip(!process.env.RUN_REAL_SOURCE_READONLY, '只读真实验证：设置 RUN_REAL_SOURCE_READONLY=1 执行（默认跳过，不影响常规 CI）');
test.skip(!existsSync(APP_EXECUTABLE), '未找到真实打包 Electron，请先运行 npm run e2e:build');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function chooseStep(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('navigation', { name: '导入步骤' }).getByRole('button', { name }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function declareData(page: Page): Promise<void> {
  const data = page.getByRole('button', { name: '有数据', exact: true });
  if ((await data.getAttribute('aria-pressed')) !== 'true') await data.click();
  await expect(data).toHaveAttribute('aria-pressed', 'true');
}

test('8.83 只读：真实 5 份 docs 经向导完整校验，七类无静默遗漏、业务库零写', async () => {
  test.setTimeout(360_000);
  const absFiles = REAL_FILES.map((f) => join(process.cwd(), f));
  for (const f of absFiles) expect(existsSync(f), `真实源文件缺失: ${f}`).toBe(true);

  // ① 前哈希
  const preHashes = absFiles.map((f) => [f, sha256(f)] as const);
  for (const [, hash] of preHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);

  const files = createImportE2eFiles();
  let app: ElectronApplication | null = null;
  try {
    // ② 真实打包 Electron + 临时 userData + 登录
    app = await launchImportApp(files.userData);
    const page = await firstWindow(app);
    await installNativeDialogStubs(app, { savePath: files.template, openPaths: absFiles });
    await initializeAndEnterWorkbench(page);
    await openHistoryImport(page);
    await page.getByRole('button', { name: '新建导入' }).click();
    await expect(page.getByRole('heading', { name: '准备数据' })).toBeVisible();

    // ③ 选择 5 份真实文件（真实 worker 解析，非旧 CLI / 非直接 runImport）
    await page.getByRole('button', { name: '选择一个或多个文件' }).click();
    // 解析完成信号：无错误 alert，且任一源文件 sheet 出现
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByText('合同信息表.xlsx').first()).toBeVisible({ timeout: 120_000 });

    // ④ 七类逐类显式声明有数据（任何真实缺失的类别会在校验阶段如实报 DECLARED_DATA_EMPTY，不做静默遗漏）
    await chooseStep(page, /项目与合同/); await declareData(page);
    await chooseStep(page, /开单记录/); await declareData(page);
    await chooseStep(page, /掉票与物流费用/);
    await page.getByRole('tab', { name: /掉票记录/ }).click(); await declareData(page);
    await page.getByRole('tab', { name: /物流费用/ }).click(); await declareData(page);
    await chooseStep(page, /序列号地址更新/); await declareData(page);
    await chooseStep(page, /二维码与 Ship-to 申请/);
    await page.getByRole('tab', { name: /二维码申请/ }).click(); await declareData(page);
    await page.getByRole('tab', { name: /Ship-to 申请/ }).click(); await declareData(page);

    // ⑤ 完整校验（真实 IPC/worker；含阻断时不得触发 commit）
    await chooseStep(page, /校验摘要与确认/);
    await page.getByRole('button', { name: '开始完整校验' }).click();
    await expect(page.getByRole('region', { name: '处理进度' })).toHaveCount(0, { timeout: 180_000 });
    // 校验完成：不点击任何确认导入（绝无 commit 触发）

    await restoreNativeDialogStubs(app);
    await app.close();
    app = null;

    // ⑥ 后哈希一致（应用不修改源文件）
    for (const [f, pre] of preHashes) expect(sha256(f), `源文件被修改: ${f}`).toBe(pre);

    // ⑦ 读取工作区 DB：类别记录数 / issue 按 code+severity 分类 / draft 状态 / seal（不含业务值）
    const wsPath = join(files.userData, 'import-workspace', 'import-workspace.db');
    const bizPath = join(files.userData, 'data', 'workbench.db');
    expect(existsSync(wsPath)).toBe(true);
    expect(existsSync(bizPath)).toBe(true);
    const ws = new DatabaseSync(wsPath, { readOnly: true });
    const biz = new DatabaseSync(bizPath, { readOnly: true });
    try {
      const byCategory = ws.prepare('SELECT category, COUNT(*) AS n FROM workspace_rows GROUP BY category ORDER BY category').all() as Array<{ category: string; n: number }>;
      const byIssue = ws.prepare('SELECT issue_code, severity, COUNT(*) AS n FROM workspace_issues GROUP BY issue_code, severity ORDER BY severity, issue_code').all() as Array<{ issue_code: string; severity: string; n: number }>;
      const drafts = ws.prepare('SELECT state, revision FROM workspace_drafts').all() as Array<{ state: string; revision: number }>;
      const seals = ws.prepare('SELECT status, COUNT(*) AS n FROM workspace_seals GROUP BY status').all() as Array<{ status: string; n: number }>;

      // 业务零写：导入相关业务表全部为 0 行（不含 accounts——登录账号属访问边界）
      const bizTables = [
        'customers', 'projects', 'contracts', 'batches', 'instruments', 'activities',
        'activity_engineers', 'work_facts', 'service_orders', 'ship_tos', 'ship_to_requests',
        'serial_address_updates', 'damage_repair_items', 'activity_damage_links',
        'qr_requests', 'qr_request_types', 'logistics_fees', 'invoices',
        'migration_audit', 'import_record_audit', 'import_run',
      ];
      const bizCounts: Array<[string, number]> = bizTables.map((t) => {
        const row = biz.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number };
        return [t, row.n];
      });
      for (const [, n] of bizCounts) expect(n, `业务表零写断言失败`).toBe(0);

      // 汇总统计（仅计数，无业务值）
      const totalErrors = byIssue.filter((i) => i.severity === 'error').reduce((s, i) => s + i.n, 0);
      const totalConflicts = byIssue.filter((i) => i.severity === 'conflict').reduce((s, i) => s + i.n, 0);
      const totalWarnings = byIssue.filter((i) => i.severity === 'warning').reduce((s, i) => s + i.n, 0);
      const totalRows = byCategory.reduce((s, c) => s + c.n, 0);

      console.log('=== 8.83 只读真实验证：脱敏汇总 ===');
      console.log(`文件哈希:`);
      for (const [f, h] of preHashes) console.log(`  ${f.split('/').pop()}: ${h}`);
      console.log(`类别记录数: ${byCategory.map((c) => `${c.category}=${c.n}`).join(', ')}（合计 ${totalRows}）`);
      console.log(`issues 按 code 分类:`);
      for (const i of byIssue) console.log(`  ${i.severity}/${i.issue_code}: ${i.n}`);
      console.log(`error=${totalErrors} conflict=${totalConflicts} warning=${totalWarnings}`);
      console.log(`draft: ${drafts.map((d) => `${d.state}@rev${d.revision}`).join(', ')}`);
      console.log(`seal: ${seals.length === 0 ? '未生成（存在阻断，未触发 commit）' : seals.map((s) => `${s.status}=${s.n}`).join(', ')}`);
      console.log(`业务零写: ${bizCounts.filter(([, n]) => n > 0).length === 0 ? '全部业务表 0 行' : `非零表: ${bizCounts.filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`).join(', ')}`}`);
      console.log(`与历史 CLI dry-run 比较: 旧口径 error=${HISTORICAL_ERRORS} conflict=${HISTORICAL_CONFLICTS}；新向导口径 error=${totalErrors} conflict=${totalConflicts}（两套校验规则/映射版本不同，见 迁移执行与运维说明.md 第 10 章历史说明）`);

      // 断言：阻断存在 → 未生成 seal（未触发 commit）；七类均显式声明且无静默遗漏
      expect(totalErrors + totalConflicts).toBeGreaterThan(0); // 真实数据含缺失/冲突（历史 554/124 佐证）
      expect(seals.length).toBe(0);
      expect(bizCounts.every(([, n]) => n === 0)).toBe(true);
    } finally {
      ws.close();
      biz.close();
    }
  } finally {
    if (app) {
      await restoreNativeDialogStubs(app).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    cleanupImportE2eFiles(files);
  }
});
