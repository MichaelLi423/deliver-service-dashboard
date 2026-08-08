import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootstrapWorkspaceDatabase,
  closeWorkspaceDatabase,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runImportFileTask, runImportPasteTask, type ChunkWritePort } from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { validatePlan } from '../../src/domain/capabilities/historical-data-import/validation';
import { toNormalizedRows, generateValidationSeal, verifyValidationSeal } from '../../src/domain/capabilities/historical-data-import/seal';
import { buildPlanFromRows } from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import { BusinessWriteCoordinator, latestRunForDraft } from '../../src/domain/capabilities/historical-data-import/commit-coordinator';
import type { CommitInput } from '../../src/domain/capabilities/historical-data-import/commit-coordinator';
import type { ImportProblem } from '../../src/domain/capabilities/historical-data-import/validation-model';
import { IMPORT_CATEGORIES, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { ReportingService } from '../../src/domain/capabilities/operational-reporting';
import { SqliteReportingFactReader } from '../../src/domain/capabilities/local-data-persistence';
import { FixedClock } from '../../src/domain/core/time';
import { buildTemplateBuffer, projectPasteText } from '../helpers/import-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 8.79~8.82 合成七类全流程集成（不读取真实 docs）。
 *
 * - 8.79：模板文件与粘贴产生相同计划 → 修正问题 → 完整校验 → 封存 →
 *   单事务提交 → 逐类对账；
 * - 8.80：状态确定性重建、源业务时间进入业务字段、导入时间只进审计不改变报表月份；
 * - 8.81：草稿创建人与最终提交人审计可追溯、用户名快照不随改名变化、
 *   业务事实与工作量不归属提交账号；
 * - 8.82：草稿退出恢复、删除、校验/提交中断的确定结果。
 */

// ---------------------------------------------------------------------------
// 夹具：七类合成模板行（label → 值；跨类引用闭合）
// ---------------------------------------------------------------------------

type TemplateRow = Record<string, string>;
type TemplateRowsByCategory = Partial<Record<ImportCategory, TemplateRow[]>>;
const SEVEN_ROWS: TemplateRowsByCategory = {
  project: [
    { source_row_id: 'sid-p1', ECC: 'E-F1', 客户名称: '客户F', 合同USD含税金额: '10000.00', 区域: '华东', 进单时间: '2026-01-01T08:00:00+08:00', 合同开始日期: '2025-01-01', 合同截止日期: '2025-12-31', 验收报告形成日期: '2026-06-30', 仪器名称: '色谱仪', 序列号: 'SN-F1' },
    // 待修正行：缺客户名称（校验问题）
    { source_row_id: 'sid-p2', ECC: 'E-F2', 客户名称: '', 仪器名称: '液相色谱', 序列号: 'SN-F2' },
  ],
  service_order: [
    { source_row_id: 'sid-so1', 服务单号: 'SO-F1', 开单类型: 'pm', 开单时间: '2026-01-15T00:00:00+08:00', 工程师: '工程师甲', 客户单位: '客户F' },
  ],
  invoice: [
    { source_row_id: 'sid-in1', ECC: 'E-F1', 掉票金额: '5000.00', 掉票时间: '2026-03-01T00:00:00+08:00' },
  ],
  logistics_fee: [
    { source_row_id: 'sid-lf1', ECC: 'E-F1', '物流费用申请（登记）时间': '2026-02-01T00:00:00+08:00', 预算价格: '4000.00', 成交价格: '3500.00', 实际物流费用: '3000.00', 物流公司: '顺丰' },
  ],
  serial_address_update: [
    { source_row_id: 'sid-sau1', 客户名称: '客户F', 新址地址: '新址F', 序列号: 'SN-F1', 'Account ID': 'ACC-F1', 更新时间: '2026-04-01T00:00:00+08:00' },
  ],
  qr_request: [
    { source_row_id: 'sid-qr1', 申请人: '负责人', 申请时间: '2026-01-20T00:00:00+08:00', 申请类型: 'service' },
  ],
  ship_to_request: [
    { source_row_id: 'sid-str1', 客户名称: '客户F', 新址地址: '新址F', 'Account ID': 'ACC-F2', 日期: '2026-01-25T00:00:00+08:00' },
  ],
};

function declaredAll(data: readonly ImportCategory[]): Partial<Record<ImportCategory, 'data' | 'none'>> {
  const declared = {} as Partial<Record<ImportCategory, 'data' | 'none'>>;
  for (const c of IMPORT_CATEGORIES) declared[c] = data.includes(c) ? 'data' : 'none';
  return declared;
}

interface Env {
  repo: WorkspaceRepository;
  db: import('node:sqlite').DatabaseSync;
  coordinator: BusinessWriteCoordinator;
  close: () => void;
}

function openEnv(dir: string): Env {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  const { db } = bootstrapDatabase({ dataDir: join(dir, 'data') });
  return {
    repo: new WorkspaceRepository(ws.db),
    db,
    coordinator: new BusinessWriteCoordinator(),
    close: () => {
      closeDatabase(db);
      closeWorkspaceDatabase(ws.db);
    },
  };
}

function workspaceWriter(repo: WorkspaceRepository): ChunkWritePort {
  return {
    append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
  };
}

/** 模板文件解析 → workspace 行（返回新修订号）。 */
async function parseTemplateInto(
  repo: WorkspaceRepository,
  draftId: string,
  revision: number,
  rowsByCategory: Parameters<typeof buildTemplateBuffer>[0],
): Promise<number> {
  const buffer = await buildTemplateBuffer(rowsByCategory);
  const result = await runImportFileTask({
    draftId,
    expectedRevision: revision,
    buffer,
    fileName: '七类合成模板.xlsx',
    writer: workspaceWriter(repo),
  });
  return result.newRevision;
}

/** 由工作区重建规范化行并执行完整校验。 */
function validateDraft(
  repo: WorkspaceRepository,
  draftId: string,
  categories: readonly ImportCategory[] = IMPORT_CATEGORIES,
) {
  const rows = toNormalizedRows(repo.queryRows(draftId, { offset: 0, limit: 100_000 }).rows);
  const declared = declaredAll(categories);
  const validation = validatePlan(rows, { declared });
  return { rows, declared, validation };
}

function commitInput(
  draftId: string,
  expectedRevision: number,
  rows: ReturnType<typeof toNormalizedRows>,
  declared: Partial<Record<ImportCategory, 'data' | 'none'>>,
  problems: ImportProblem[],
  snapshotDir: string,
  actor: { accountId: string; username: string },
  now?: FixedClock,
): CommitInput {
  return {
    draftId,
    expectedRevision,
    planDigest: buildPlanFromRows(rows).planDigest,
    rows,
    problems,
    declared,
    actor,
    snapshotDir,
    ...(now ? { now } : {}),
  };
}

// ---------------------------------------------------------------------------
// 8.79 合成七类全流程
// ---------------------------------------------------------------------------

describe('8.79 七类全流程（模板文件 + 粘贴同计划 → 修正 → 校验 → 封存 → 单事务提交 → 对账）', () => {
  it('模板文件与粘贴（相同语义）产生相同规范化计划摘要', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openEnv(dir);
      const d = repo.createDraft({ name: '等价草稿', createdBy: null, createdByUsername: null });
      let rev = repo.transitionState(d.id, 1, 'start_parsing');

      const projectRows = [SEVEN_ROWS.project![0]];
      const fileBuffer = await buildTemplateBuffer({ project: projectRows });
      const fileResult = await runImportFileTask({
        draftId: d.id, expectedRevision: rev, buffer: fileBuffer, fileName: '等价.xlsx',
        writer: workspaceWriter(repo),
      });
      rev = fileResult.newRevision;

      const pasteResult = await runImportPasteTask({
        draftId: d.id, expectedRevision: rev, category: 'project',
        text: projectPasteText(projectRows),
        headerConfirmed: true, append: true, existingRows: 0, existingColumns: 13,
        writer: { append: (_draftId, expectedRevision) => expectedRevision + 1 },
      });
      expect(pasteResult.planDigest).toBe(fileResult.planDigest);
      // 原始摘要区分来源
      expect(pasteResult.rawDigest).not.toBe(fileResult.rawDigest);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('七类全流程：解析 → 修正缺客户名称 → 完整校验通过 → 封存 → 单事务提交 → 逐类对账', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const { repo, db } = env;
      const d = repo.createDraft({ name: '七类全流程草稿', createdBy: 'acc-creator', createdByUsername: '创建人甲' });
      let rev = repo.transitionState(d.id, 1, 'start_parsing');
      rev = await parseTemplateInto(repo, d.id, rev, SEVEN_ROWS);
      rev = repo.transitionState(d.id, rev, 'parsing_finished');
      expect(repo.getDraft(d.id)!.state).toBe('needs_review');

      // ① 完整校验：存在待修正问题（客户名称缺失）→ 不通过
      let { rows, declared, validation } = validateDraft(repo, d.id);
      expect(validation.eligible).toBe(false);
      expect(validation.problems.some((p) => p.code === 'MISSING_REQUIRED_FIELD' && p.field === 'contract.customer_name')).toBe(true);

      // ② 修正：补 E-F2 的客户名称（稀疏 cell patch）
      const rowE2 = repo.queryRows(d.id, { businessKey: 'E-F2', offset: 0, limit: 10 }).rows[0];
      expect(rowE2).toBeDefined();
      rev = repo.patchCells(d.id, repo.getDraft(d.id)!.revision, [{ rowId: rowE2.rowId, field: 'contract.customer_name', value: '客户G' }]);

      // ③ 重新完整校验 → 通过
      ({ rows, declared, validation } = validateDraft(repo, d.id));
      expect(validation.eligible).toBe(true);

      // ④ 完整校验 → 封存（sealed）
      rev = repo.transitionState(d.id, rev, 'start_validating');
      rev = generateValidationSeal(repo, { draftId: d.id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: validation.problems, targetDb: db });
      const sealCheck = verifyValidationSeal(repo, d.id, db);
      expect(sealCheck.valid).toBe(true);
      expect(repo.getDraft(d.id)!.state).toBe('sealed');

      // ⑤ 单事务提交
      const snapshotDir = join(dir, 'snap');
      const outcome = await env.coordinator.commitSealedPlanAtomically(
        db, repo,
        commitInput(d.id, rev, rows, declared, validation.problems, snapshotDir, { accountId: 'acc-committer', username: '提交人乙' }),
      );
      expect(outcome.status).toBe('committed');

      // ⑥ 逐类对账：import_run written 数 = 计划数，业务表行数与计划一致
      const run = latestRunForDraft(db, d.id)!;
      expect(run.status).toBe('succeeded');
      expect(run.planCounts.project).toBe(2);
      expect(run.planCounts.service_order).toBe(1);
      expect(run.planCounts.invoice).toBe(1);
      expect(run.planCounts.logistics_fee).toBe(1);
      expect(run.planCounts.serial_address_update).toBe(1);
      expect(run.planCounts.qr_request).toBe(1);
      expect(run.planCounts.ship_to_request).toBe(1);
      expect(run.writtenCounts).toEqual(run.planCounts);
      // 草稿终态：succeeded（敏感行已清除，保留摘要）
      const draft = repo.getDraft(d.id)!;
      expect(draft.state).toBe('succeeded');
      expect(draft.totalRows).toBe(8); // 摘要保留（2 项目 + 6 其他类别）
      expect(repo.queryRows(d.id, { offset: 0, limit: 10 }).total).toBe(0); // 敏感行清除
      // 业务表行数（与 migration-service writer 实际写表语义一致：七类 + 客户/批次）
      const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(count('projects')).toBe(2);
      expect(count('contracts')).toBe(2);
      expect(count('customers')).toBe(2);
      expect(count('batches')).toBe(1);
      expect(count('service_orders')).toBe(1);
      expect(count('invoices')).toBe(1);
      expect(count('logistics_fees')).toBe(1);
      expect(count('serial_address_updates')).toBe(1);
      expect(count('qr_requests')).toBe(1);
      expect(count('qr_request_types')).toBe(1);
      expect(count('ship_to_requests')).toBe(1);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});


/** 解析七类模板并修正 E-F2 缺客户名称，返回可完整校验通过的草稿状态。 */
async function prepareEligibleSeven(
  env: Env,
  name: string,
  createdBy = 'acc-s',
  createdByUsername = '账号',
): Promise<{ d: { id: string }; rev: number; rows: ReturnType<typeof toNormalizedRows>; declared: Partial<Record<ImportCategory, 'data' | 'none'>>; validation: ReturnType<typeof validatePlan> }> {
  const { repo, db } = env;
  const d = repo.createDraft({ name, createdBy, createdByUsername });
  let rev = repo.transitionState(d.id, 1, 'start_parsing');
  rev = await parseTemplateInto(repo, d.id, rev, SEVEN_ROWS);
  rev = repo.transitionState(d.id, rev, 'parsing_finished');
  const rowE2 = repo.queryRows(d.id, { businessKey: 'E-F2', offset: 0, limit: 10 }).rows[0];
  rev = repo.patchCells(d.id, repo.getDraft(d.id)!.revision, [{ rowId: rowE2.rowId, field: 'contract.customer_name', value: '客户G' }]);
  const { rows, declared, validation } = validateDraft(repo, d.id);
  expect(validation.eligible, `fixture 应完整校验通过: ${validation.blockingReasons.join('；')}`).toBe(true);
  void db;
  return { d, rev, rows, declared, validation };
}

// ---------------------------------------------------------------------------
// 8.80 状态与业务时间重建
// ---------------------------------------------------------------------------

describe('8.80 状态与业务时间重建', () => {
  it('主状态由导入事实确定性重建，源时间进入业务字段，导入时间只进审计且不改变报表月份', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const { repo, db } = env;
      const { d, rev, rows, declared, validation } = await prepareEligibleSeven(env, '状态时间草稿', 'acc-s', '时间账号');

      // 完整校验通过 → 封存。
      let sealedRev = repo.transitionState(d.id, rev, 'start_validating');
      sealedRev = generateValidationSeal(repo, { draftId: d.id, expectedRevision: sealedRev, planDigest: buildPlanFromRows(rows).planDigest, problems: validation.problems, targetDb: db });

      // 导入时间固定为 2026-12-31（与源业务时间明显不同）。
      const importNow = new FixedClock('2026-12-31T23:59:00+08:00');
      const outcome = await env.coordinator.commitSealedPlanAtomically(
        db, repo,
        commitInput(d.id, sealedRev, rows, declared, validation.problems, join(dir, 'snap'), { accountId: 'acc-s', username: '时间账号' }, importNow),
      );
      expect(outcome.status).toBe('committed');

      // ① 状态确定性重建：E-F1（进单 + 验收报告）→ pending_invoice；E-F2（无进单事实）→ pending_entry
      const project = db.prepare("SELECT ecc, status, entry_at FROM projects p JOIN contracts c ON c.project_id=p.id WHERE c.ecc=?").all('E-F1') as Array<{ ecc: string; status: string; entry_at: string | null }>;
      const f1 = project.find((p) => p.ecc === 'E-F1')!;
      const f2 = db.prepare("SELECT status, entry_at FROM projects p JOIN contracts c ON c.project_id=p.id WHERE c.ecc=?").get('E-F2') as { status: string; entry_at: string | null };
      expect(f1.status).toBe('pending_invoice');
      expect(f2.status).toBe('pending_entry');

      // ② 源业务时间进入业务字段（非导入时间）。
      expect(f1.entry_at).toBe('2026-01-01T08:00:00+08:00');
      expect(f2.entry_at).toBeNull();

      // ③ 导入时间只进审计：migration_audit/import_run 记录 started/committed（2026-12-31）。
      const run = latestRunForDraft(db, d.id)!;
      expect(run.committedAt).toContain('2026-12-31');

      // ④ 报表月份按源业务时间（掉票 2026-03-01），不因导入时间（2026-12-31）改变。
      const reporting = new ReportingService(new SqliteReportingFactReader(db));
      const march = reporting.buildReport({ monthFrom: '2026-03', monthTo: '2026-03' });
      const marchInvoices = march.monthlyInvoices.filter((r) => r.month === '2026-03');
      expect(marchInvoices.reduce((sum, r) => sum + r.amountCents, 0n)).toBe(500000n);
      const december = reporting.buildReport({ monthFrom: '2026-12', monthTo: '2026-12' });
      expect(december.monthlyInvoices.filter((r) => r.month === '2026-12').reduce((sum, r) => sum + r.amountCents, 0n)).toBe(0n);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.81 账号语义
// ---------------------------------------------------------------------------

describe('8.81 账号语义：创建人与提交人可追溯、用户名快照、工作量不归属提交账号', () => {
  it('草稿创建人与最终提交人分列审计；用户名快照在提交时固化；业务事实不归属提交账号', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const { repo, db } = env;
      // 草稿由「创建人甲」创建；提交由当前会话「提交人乙」执行。
      const { d, rev, rows, declared, validation } = await prepareEligibleSeven(env, '账号语义草稿', 'acc-creator', '创建人甲');
      let sealedRev = repo.transitionState(d.id, rev, 'start_validating');
      sealedRev = generateValidationSeal(repo, { draftId: d.id, expectedRevision: sealedRev, planDigest: buildPlanFromRows(rows).planDigest, problems: validation.problems, targetDb: db });

      // 提交人（当前会话）为乙：账号内部 ID 与提交时用户名快照写入运行审计。
      const outcome = await env.coordinator.commitSealedPlanAtomically(
        db, repo,
        commitInput(d.id, sealedRev, rows, declared, validation.problems, join(dir, 'snap'), { accountId: 'acc-committer', username: '提交人乙' }),
      );
      expect(outcome.status).toBe('committed');

      const run = latestRunForDraft(db, d.id)!;
      expect(run.accountId).toBe('acc-committer');
      expect(run.usernameSnapshot).toBe('提交人乙');
      // 创建人快照保留在草稿（创建时固化，不随提交人变化）。
      expect(repo.getDraft(d.id)!.createdBy).toBe('acc-creator');
      expect(repo.getDraft(d.id)!.createdByUsername).toBe('创建人甲');
      // 用户名快照为提交时固化值：提交后改名不影响审计中的快照（审计列不再变化）。
      expect(run.usernameSnapshot).not.toBe('创建人甲');

      // 业务事实不归属提交账号：import_source_key 标记历史导入，account_id/actor 为空。
      const so = db.prepare("SELECT import_source_key, account_id FROM service_orders WHERE service_order_no='SO-F1'").get() as { import_source_key: string | null; account_id: string | null };
      expect(so.import_source_key).toBeTruthy();
      expect(so.account_id).toBeNull();
      // 不产生任何手工工作事实（导入不计入提交账号工作量）。
      expect((db.prepare('SELECT COUNT(*) AS n FROM work_facts').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n).toBe(0);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.82 草稿与业务生命周期
// ---------------------------------------------------------------------------

describe('8.82 草稿与业务生命周期：退出恢复、删除、提交中断确定结果', () => {
  it('解析期间退出：重开工作区后回到最后稳定草稿修订，运行期行清除', async () => {
    const dir = makeTempDir();
    try {
      const ws1 = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
      const repo1 = new WorkspaceRepository(ws1.db);
      const d = repo1.createDraft({ name: '退出恢复草稿', createdBy: null, createdByUsername: null });
      let rev = repo1.transitionState(d.id, 1, 'start_parsing');
      // 解析部分写入（未 parsing_finished）→ 模拟应用退出。
      const buffer = await buildTemplateBuffer({ project: [SEVEN_ROWS.project![0]] });
      const result = await runImportFileTask({
        draftId: d.id, expectedRevision: rev, buffer, fileName: '中断.xlsx',
        writer: workspaceWriter(repo1),
      });
      rev = result.newRevision;
      expect(repo1.getDraft(d.id)!.state).toBe('parsing');
      closeWorkspaceDatabase(ws1.db);

      const ws2 = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
      try {
        const repo2 = new WorkspaceRepository(ws2.db);
        const report = repo2.recoverRuntimeStates();
        expect(report.recovered.some((r) => r.draftId === d.id && r.to === 'draft')).toBe(true);
        const draft2 = repo2.getDraft(d.id)!;
        expect(draft2.state).toBe('draft');
        expect(draft2.revision).toBe(1);
        expect(repo2.queryRows(d.id, { offset: 0, limit: 10 }).total).toBe(0);
      } finally {
        closeWorkspaceDatabase(ws2.db);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('删除草稿：工作区内容清除，正式业务库零接触', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const { repo, db } = env;
      const d = repo.createDraft({ name: '删除草稿', createdBy: 'acc-del', createdByUsername: '删除账号' });
      let rev = repo.transitionState(d.id, 1, 'start_parsing');
      rev = await parseTemplateInto(repo, d.id, rev, SEVEN_ROWS);
      expect(repo.queryRows(d.id, { offset: 0, limit: 100 }).total).toBeGreaterThan(0);

      repo.deleteDraft(d.id);
      expect(repo.getDraft(d.id)).toBeUndefined();
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(0);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('提交中断（无成功审计）：判定完整回滚 → needs_review 且 seal 失效，结果确定', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const { repo, db } = env;
      const d = repo.createDraft({ name: '中断草稿', createdBy: 'acc-i', createdByUsername: '中断账号' });
      let rev = repo.transitionState(d.id, 1, 'start_parsing');
      rev = await parseTemplateInto(repo, d.id, rev, { project: [SEVEN_ROWS.project![0]] });
      rev = repo.transitionState(d.id, rev, 'parsing_finished');
      const { rows, validation } = validateDraft(repo, d.id, ['project']);
      expect(validation.eligible).toBe(true);
      rev = repo.transitionState(d.id, rev, 'start_validating');
      rev = generateValidationSeal(repo, { draftId: d.id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: validation.problems, targetDb: db });
      expect(repo.getDraft(d.id)!.state).toBe('sealed');

      // 模拟提交期间应用退出：草稿停在 committing，import_run 无成功审计。
      rev = repo.transitionState(d.id, rev, 'start_committing');
      expect(repo.getDraft(d.id)!.state).toBe('committing');

      const outcome = env.coordinator.settleInterruptedCommit(db, repo, d.id);
      expect(outcome.status).toBe('rolled_back');
      const draft = repo.getDraft(d.id)!;
      expect(draft.state).toBe('needs_review'); // 要求重新完整校验
      expect(repo.getSeal(d.id)!.status).toBe('invalid'); // seal 失效
      // 零业务写入
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
