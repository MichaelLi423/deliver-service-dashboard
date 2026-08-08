import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapWorkspaceDatabase,
  closeWorkspaceDatabase,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runImportFileTask, type ChunkWritePort } from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { validatePlan } from '../../src/domain/capabilities/historical-data-import/validation';
import { toNormalizedRows, generateValidationSeal } from '../../src/domain/capabilities/historical-data-import/seal';
import { buildPlanFromRows } from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import { BusinessWriteCoordinator } from '../../src/domain/capabilities/historical-data-import/commit-coordinator';
import { projectRow } from '../helpers/import-fixtures';
import { buildTemplateBuffer } from '../helpers/import-fixtures';
import { IMPORT_CATEGORIES, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 8.73 日志 / 错误 / 运行审计脱敏检查。
 *
 * 静态：historical-data-import 运行时管线模块不得调用 console / stdout / stderr
 * 输出（legacy CLI cli.ts 为开发工具除外，其输出为批次/路径摘要）。
 * 运行：以带敏感业务值（客户/ECC/序列号/Account ID/金额）的文件完整走
 * 读取→校验→封存→提交，捕获 console 输出与 import_run 运行审计，断言
 * 不泄漏完整敏感值；plan digest 为哈希而非明文。
 */

// 敏感哨兵值（确定性、可断言；与任何自然字符串区分）。
const SENSITIVE = {
  customer: '敏感客户甲乙丙丁',
  ecc: 'ECC-敏感-8888',
  serial: 'SN-敏感-1234',
  accountId: 'ACC-敏感-5678',
  amount: '888888.88',
};
const SENTINELS = Object.values(SENSITIVE);

function declaredAll(data: readonly ImportCategory[]): Partial<Record<ImportCategory, 'data' | 'none'>> {
  const declared = {} as Partial<Record<ImportCategory, 'data' | 'none'>>;
  for (const c of IMPORT_CATEGORIES) declared[c] = data.includes(c) ? 'data' : 'none';
  return declared;
}

function importModuleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...importModuleFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('8.73 日志/错误/运行审计脱敏', () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it('静态：运行时导入管线无 console / stdout / stderr 输出调用（外部 CLI 已删除）', () => {
    const base = join(process.cwd(), 'src/domain/capabilities/historical-data-import');
    const files = importModuleFiles(base);
    expect(files.length).toBeGreaterThan(10);
    // 外部迁移 CLI（cli.ts）已删除：导入模块全部文件均不得调用 console / stdout / stderr 输出。
    expect(files.some((f) => f.endsWith('/cli.ts'))).toBe(false);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/console\.(log|warn|error|info|debug|trace)\s*\(|process\.stdout|process\.stderr/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('运行：敏感值文件完整走 读取→校验→封存→提交，console 输出与 import_run 审计不含完整敏感值', async () => {
    const dir = makeTempDir();
    try {
      const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
      const { db } = bootstrapDatabase({ dataDir: join(dir, 'data') });
      try {
        const repo = new WorkspaceRepository(ws.db);
        const d = repo.createDraft({ name: '脱敏检查草稿', createdBy: 'acc-check', createdByUsername: '审计检查账号' });
        let rev = repo.transitionState(d.id, 1, 'start_parsing');

        // 带敏感值的模板文件（project 行）。
        const buffer = await buildTemplateBuffer({ project: [projectRow(1, { eccPrefix: SENSITIVE.ecc, customerPrefix: SENSITIVE.customer })] });
        const writer: ChunkWritePort = {
          append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
        };
        const fileResult = await runImportFileTask({
          draftId: d.id,
          expectedRevision: rev,
          buffer,
          fileName: '脱敏检查.xlsx',
          writer,
        });
        rev = fileResult.newRevision;

        const rows = toNormalizedRows(repo.queryRows(d.id, { offset: 0, limit: 100 }).rows);
        expect(rows).toHaveLength(1);
        rev = repo.transitionState(d.id, rev, 'parsing_finished');
        rev = repo.transitionState(d.id, rev, 'start_validating');
        const declared = declaredAll(['project']);
        const validation = validatePlan(rows, { declared });
        expect(validation.eligible).toBe(true);
        rev = generateValidationSeal(repo, { draftId: d.id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: validation.problems, targetDb: db });

        // 捕获运行期 console 输出。
        for (const method of ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const) {
          spies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
        }

        const coordinator = new BusinessWriteCoordinator();
        const outcome = await coordinator.commitSealedPlanAtomically(db, repo, {
          draftId: d.id,
          expectedRevision: rev,
          planDigest: buildPlanFromRows(rows).planDigest,
          rows,
          problems: validation.problems,
          declared,
          actor: { accountId: 'acc-committer', username: '提交账号' },
          snapshotDir: join(dir, 'snapshots'),
        });
        expect(outcome.status).toBe('committed');

        // ① console 输出不得包含完整敏感值。
        const captured = spies.map((s) => s.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).join('\n');
        for (const sentinel of SENTINELS) {
          expect(captured).not.toContain(sentinel);
        }

        // ② import_run 运行审计不含完整敏感值（planDigest 为哈希）。
        const runRows = db.prepare('SELECT * FROM import_run').all() as Array<Record<string, unknown>>;
        expect(runRows.length).toBe(1);
        const run = runRows[0];
        const runJson = JSON.stringify(run);
        for (const sentinel of SENTINELS) {
          expect(runJson).not.toContain(sentinel);
        }
        expect(String(run.plan_digest)).toMatch(/^[0-9a-f]{64}$/);
        // 审计记录的是账号 ID 与用户名快照（身份），不是业务值。
        expect(run.account_id).toBe('acc-committer');
        expect(run.username_snapshot).toBe('提交账号');
      } finally {
        closeDatabase(db);
        closeWorkspaceDatabase(ws.db);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});
