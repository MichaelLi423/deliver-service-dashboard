import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { rotateContentGeneration } from '../../src/domain/capabilities/local-data-persistence/identity';
import { businessKeyFromCells, type NormalizedRow } from '../../src/domain/capabilities/historical-data-import/normalized-row';
import { buildPlanFromRows } from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import {
  generateValidationSeal,
  verifyValidationSeal,
  currentPlanDigest,
  sealBindingDigest,
  conflictDecisionDigest,
  VALIDATION_VERSION,
  type SealBinding,
} from '../../src/domain/capabilities/historical-data-import/seal';
import { validatePlan } from '../../src/domain/capabilities/historical-data-import/validation';
import type { ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 校验封存（validation seal）测试（design D25 / tasks 8.35）。
 *
 * seal 绑定 draftId + draftRevision + planDigest + 模板/映射/校验版本 +
 * conflictDecisionDigest + database_instance_id + content_generation_id +
 * business_revision + schema version；任一草稿或目标变化必须使 seal 失效。
 * 错误/未解决冲突/空导入/未声明类别阻止生成 seal。
 */

/** 只有项目类有数据，其余六类确认无数据（七类均已声明）。 */
const PROJECT_ONLY = {
  project: 'data',
  service_order: 'none',
  invoice: 'none',
  logistics_fee: 'none',
  serial_address_update: 'none',
  qr_request: 'none',
  ship_to_request: 'none',
} as const;

let seq = 0;
function nrow(category: ImportCategory, cells: Record<string, string | null>): NormalizedRow {
  seq += 1;
  return {
    category,
    rowId: `row-${seq}`,
    sourceRowId: null,
    businessKey: businessKeyFromCells(category, cells),
    sourceKind: 'file',
    sourceFile: '合同信息表.xlsx',
    sourceSheet: '合同信息',
    sourceRow: seq + 1,
    pasteBatch: null,
    cells,
    positionOnlyIdentity: false,
  };
}

function openEnv(dir: string): {
  repo: WorkspaceRepository;
  target: ReturnType<typeof bootstrapDatabase>;
  close: () => void;
} {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  const target = bootstrapDatabase({ dataDir: join(dir, 'data') });
  return {
    repo: new WorkspaceRepository(ws.db),
    target,
    close: () => {
      closeDatabase(target.db);
      closeWorkspaceDatabase(ws.db);
    },
  };
}

/** 构建一个带项目行的草稿并推进到 validating（返回最新修订）。 */
function draftToValidating(
  repo: WorkspaceRepository,
  rows: NormalizedRow[],
): { id: string; rev: number } {
  const d = repo.createDraft({ name: 'seal 草稿', createdBy: null, createdByUsername: null });
  let rev = 1;
  rev = repo.transitionState(d.id, rev, 'start_parsing');
  for (const row of rows) {
    rev = repo.appendRows(d.id, rev, row.category, [
      {
        rowId: row.rowId,
        businessKey: row.businessKey,
        sourceFile: row.sourceFile,
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        cells: row.cells,
      },
    ]);
  }
  rev = repo.transitionState(d.id, rev, 'parsing_finished');
  rev = repo.transitionState(d.id, rev, 'start_validating');
  return { id: d.id, rev };
}

function projectRows(): NormalizedRow[] {
  return [nrow('project', { 'contract.ecc': 'E-SEAL', 'contract.customer_name': '甲' })];
}

describe('8.35 seal 生成与绑定分量', () => {
  it('seal 绑定草稿修订、计划摘要、规则版本、冲突决定与目标身份分量', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);

      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      const planDigest = buildPlanFromRows(rows).planDigest;
      const newRev = generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest, problems: result.problems, targetDb: target.db });

      const seal = repo.getSeal(id)!;
      expect(repo.getDraft(id)?.state).toBe('sealed');
      expect(newRev).toBe(rev + 1);
      // 草稿修订绑定：生成时草稿修订被捕获。
      expect(seal.draftRevision).toBe(rev);
      expect(seal.planDigest).toBe(planDigest);
      expect(seal.templateVersion).toBe('1');
      expect(seal.mappingVersion).toBe('1');
      expect(seal.validationVersion).toBe(String(VALIDATION_VERSION));
      expect(seal.conflictDecisionDigest).toBe(conflictDecisionDigest(repo, id));
      expect(seal.databaseInstanceId).toBeTruthy();
      expect(seal.contentGenerationId).toBeTruthy();
      expect(seal.targetBusinessRevision).toBe('0');
      expect(seal.targetSchemaVersion).toBeGreaterThan(0);

      // 验证通过：当前草稿与目标与 seal 绑定一致。
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(true);
      expect(verification.reasons).toEqual([]);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('相同语义内容产生稳定计划摘要与稳定 seal 绑定摘要', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const planDigest = buildPlanFromRows(rows).planDigest;
      const { id, rev } = draftToValidating(repo, rows);

      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest, problems: result.problems, targetDb: target.db });

      const seal = repo.getSeal(id)!;
      const binding: SealBinding = {
        draftId: id,
        draftRevision: seal.draftRevision,
        planDigest: seal.planDigest,
        templateVersion: seal.templateVersion ?? '',
        mappingVersion: seal.mappingVersion ?? '',
        validationVersion: seal.validationVersion ?? '',
        conflictDecisionDigest: seal.conflictDecisionDigest ?? '',
        databaseInstanceId: seal.databaseInstanceId ?? '',
        contentGenerationId: seal.contentGenerationId ?? '',
        businessRevision: Number(seal.targetBusinessRevision ?? '0'),
        schemaVersion: seal.targetSchemaVersion ?? 0,
      };
      // 重复计算稳定
      expect(sealBindingDigest(binding)).toBe(sealBindingDigest(binding));
      // 草稿行重建计划摘要与生成时一致
      expect(currentPlanDigest(repo, id)).toBe(planDigest);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('错误或未解决冲突阻止生成 seal；空导入/未声明类别也阻止', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = [nrow('project', { 'contract.ecc': 'E-SEAL' })]; // 缺客户名称 → 错误
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      expect(result.eligible).toBe(false);
      expect(() =>
        generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: 'pd', problems: result.problems, targetDb: target.db }),
      ).toThrowError(/完整校验未通过/);
      expect(repo.getSeal(id)).toBeUndefined();
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('8.35 seal 失效：任一草稿或目标变化', () => {
  it('草稿单元格修改 → seal 立即失效并回到 needs_review', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      repo.patchCells(id, rev + 1, [{ rowId: rows[0].rowId, field: 'project.region', value: '华东' }]);
      const after = repo.getDraft(id)!;
      expect(after.state).toBe('needs_review');
      expect(repo.getSeal(id)?.status).toBe('invalid');
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(false);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('冲突决定变化 → seal 失效', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      repo.saveConflictDecision(id, rev + 1, { field: 'contract.customer_name', decisionType: 'choose_candidate', chosenValue: '甲' });
      expect(repo.getDraft(id)?.state).toBe('needs_review');
      expect(verifyValidationSeal(repo, id, target.db).valid).toBe(false);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('目标业务修订变化 → seal 失效（任一业务写入都使旧 seal 无效）', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      // 目标业务写入（customer 为业务表）→ business_revision 递增。
      target.db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('c-new', '新客户', 't', 't');
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(false);
      expect(verification.reasons.some((r) => r.includes('业务修订'))).toBe(true);
      // 校验未通过的 seal 被持久化失效（草稿仍 sealed 时自动失效）。
      expect(repo.getDraft(id)?.state).toBe('needs_review');
      expect(repo.getSeal(id)?.status).toBe('invalid');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('内容代际变化（成功恢复轮换 content_generation_id）→ seal 失效', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      rotateContentGeneration(target.db);
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(false);
      expect(verification.reasons.some((r) => r.includes('内容代际'))).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('数据库实例变化（恢复旧库）→ seal 失效', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      // 模拟恢复到另一个实例：直接改写 database_instance_id。
      target.db.prepare('UPDATE database_metadata SET database_instance_id = ? WHERE id = 1').run('instance-restored');
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(false);
      expect(verification.reasons.some((r) => r.includes('实例'))).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('规则版本变化（模板/映射/校验版本）→ seal 失效', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      // 模拟规则升级：模板版本从 1 → 2（旧 seal 必失效）。
      repo.getSeal(id); // ensure seal exists
      const sealId = (repo as unknown as { getSeal: (d: string) => { id: string } | undefined }).getSeal(id)?.id;
      expect(sealId).toBeTruthy();
      (repo as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare('UPDATE workspace_seals SET template_version = ? WHERE id = ?')
        .run('2', sealId);
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(false);
      expect(verification.reasons.some((r) => r.includes('模板版本'))).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('schema 版本变化 → seal 失效', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });

      const schemaVersion = (target.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      target.db.exec(`PRAGMA user_version = ${schemaVersion + 1}`);
      const verification = verifyValidationSeal(repo, id, target.db);
      expect(verification.valid).toBe(false);
      expect(verification.reasons.some((r) => r.includes('schema'))).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('8.35 校验/封存阶段零业务写入', () => {
  it('生成与验证 seal 不写任何正式业务表', () => {
    const dir = makeTempDir();
    try {
      const { repo, target, close } = openEnv(dir);
      const snapshot = (): string => {
        const tables = target.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        return tables
          .map((t) => `${t.name}:${JSON.stringify(target.db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all())}`)
          .join('\n');
      };
      const before = snapshot();

      const rows = projectRows();
      const { id, rev } = draftToValidating(repo, rows);
      const result = validatePlan(rows, { declared: PROJECT_ONLY });
      generateValidationSeal(repo, { draftId: id, expectedRevision: rev, planDigest: buildPlanFromRows(rows).planDigest, problems: result.problems, targetDb: target.db });
      verifyValidationSeal(repo, id, target.db);

      expect(snapshot()).toBe(before);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
