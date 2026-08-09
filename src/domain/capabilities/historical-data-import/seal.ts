import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkspaceRepository } from './workspace/workspace-repository';
import type { ValidationSealRecord, WorkspaceRow } from './workspace/workspace-model';
import { TEMPLATE_VERSION } from './template';
import { MIGRATION_MAPPING_VERSION } from './mapping';
import { readDatabaseIdentity } from '../local-data-persistence/identity';
import { readSchemaVersion } from '../local-data-persistence/connection';
import { normalizedRowHash, planDigestFromRowHashes } from './digest';
import {
  normalizeCellValue,
  type NormalizedRow,
} from './normalized-row';
import { findFieldByTarget } from './field-catalog';
import type { ImportProblem } from './validation-model';

/**
 * 校验封存绑定与验证（design D25 / tasks 8.35）。
 *
 * seal 绑定：draftId + draftRevision + planDigest + 模板/映射/校验版本 +
 * conflictDecisionDigest + database_instance_id + content_generation_id +
 * business_revision + schema version。任一草稿修改（行/单元格/映射/冲突决定）
 * 或目标变化（业务修订/schema/恢复轮换 generation）都会使 seal 失效。
 *
 * 生成前必须满足完整校验资格（无错误且无未解决冲突、非空导入、七类均已声明），
 * 否则拒绝生成；验证时逐分量比较，不一致即失效（草稿仍在 sealed 时持久化失效）。
 */

/** 校验规则版本（8.35：任一规则升级使旧 seal 失效）。
 *  v2：业务日期化（design D30）——业务时间字段统一按 yyyy-mm-dd 校验/规范化，
 *  旧版本 seal 因 validationVersion 不一致自动失效，旧草稿必须重新完整校验，
 *  不得以旧语义绕过新日期语义。 */
export const VALIDATION_VERSION = 2;

/** seal 绑定分量（可审计/可稳定序列化）。 */
export interface SealBinding {
  draftId: string;
  draftRevision: number;
  planDigest: string;
  templateVersion: string;
  mappingVersion: string;
  validationVersion: string;
  conflictDecisionDigest: string;
  databaseInstanceId: string;
  contentGenerationId: string;
  businessRevision: number;
  schemaVersion: number;
}

export interface SealVerification {
  valid: boolean;
  seal: ValidationSealRecord | undefined;
  /** 失效原因（valid 时为空数组）。 */
  reasons: string[];
}

/** 冲突决定摘要：按 行/字段/类型/取值 稳定排序后哈希（同内容决定得到同一摘要）。
 *  Oracle 复审 #2：纳入 category modes 与 sheet 归类，任何模式/归类修改使 seal 绑定变化。 */
export function conflictDecisionDigest(repo: WorkspaceRepository, draftId: string): string {
  const decisions = repo
    .listConflictDecisions(draftId)
    .map((d) =>
      JSON.stringify({
        rowId: d.rowId,
        field: d.field,
        decisionType: d.decisionType,
        chosenValue: d.chosenValue,
      }),
    )
    .sort();
  const modes = repo.getCategoryModes(draftId);
  const sheetClassifications = repo.getSheetClassifications(draftId);
  const modesCanonical = Object.keys(modes)
    .sort()
    .map((c) => `${c}=${modes[c as keyof typeof modes]}`)
    .join('|');
  const sheetsCanonical = sheetClassifications
    .map((s) => `${s.file}#${s.sheet}=${s.classification}`)
    .sort()
    .join('|');
  return createHash('sha256')
    .update([decisions.join('\n'), modesCanonical, sheetsCanonical].join('\n'))
    .digest('hex');
}

/** 由工作区行重建 NormalizedRow（供 planDigest 防御性复核）。
 *  业务日期字段（type=date）在读取时统一规范化为 yyyy-mm-dd（design D30）：
 *  旧草稿/手工补录单元格即使以 datetime 形式入库，重建时也按新语义输出日期，
 *  保证旧 seal/草稿无法绕过业务日期化语义（配合 VALIDATION_VERSION 升级双保险）。 */
export function toNormalizedRows(rows: readonly WorkspaceRow[]): NormalizedRow[] {
  return rows.map((r) => {
    let businessKey = r.businessKey;
    let positionOnlyIdentity = false;
    if (businessKey !== null && businessKey.startsWith('pos:')) {
      // toAppendRowInput 将物理位置兜底身份写入 business_key。
      positionOnlyIdentity = true;
      businessKey = null;
    }
    const cells: Record<string, string | null> = {};
    for (const [field, value] of Object.entries(r.cells)) {
      const def = findFieldByTarget(r.category, field);
      // 日期系统默认 1900（与模板一致；日期单元格读取层已转本地墙钟文本，
      // 此处只对仍为 datetime/纯日期文本的单元格做统一换算）。
      cells[field] =
        def !== undefined && def.type === 'date' && value !== null && value !== ''
          ? normalizeCellValue(def, value, '1900')
          : value;
    }
    return {
      category: r.category,
      rowId: r.rowId,
      sourceRowId: r.sourceRowId,
      businessKey,
      sourceKind: r.pasteBatch !== null ? 'paste' : 'file',
      sourceFile: r.sourceFile,
      sourceSheet: r.sourceSheet,
      sourceRow: r.sourceRow,
      pasteBatch: r.pasteBatch,
      cells,
      positionOnlyIdentity: positionOnlyIdentity || (businessKey === null && r.sourceRowId === null),
    };
  });
}

/**
 * 由工作区草稿行重建的规范化计划摘要。
 * 分批窗口读取（SQLite IN 变量有上限，不能一次取整份大草稿），
 * 逐行哈希累积后整体摘要 —— 与 planDigestFromRows 完全等价（8.69：50k 草稿）。
 */
export function currentPlanDigest(repo: WorkspaceRepository, draftId: string): string {
  const WINDOW = 10_000;
  const hashes: string[] = [];
  let offset = 0;
  for (;;) {
    const window = repo.queryRows(draftId, { offset, limit: WINDOW });
    // Oracle 最终复核 #2：只哈希实际计划行（排除 excluded 源行），与 seal 生成/commit 摘要一致。
    hashes.push(...toNormalizedRows(window.rows.filter((r) => !r.excluded)).map((r) => normalizedRowHash(r)));
    offset += window.rows.length;
    if (window.rows.length < WINDOW || offset >= window.total) break;
  }
  return planDigestFromRowHashes(hashes);
}

/** seal 绑定摘要（稳定排序序列化；相同绑定得到同一摘要，供测试与审计）。 */
export function sealBindingDigest(binding: SealBinding): string {
  const canonical = JSON.stringify(
    {
      draftId: binding.draftId,
      draftRevision: binding.draftRevision,
      planDigest: binding.planDigest,
      templateVersion: binding.templateVersion,
      mappingVersion: binding.mappingVersion,
      validationVersion: binding.validationVersion,
      conflictDecisionDigest: binding.conflictDecisionDigest,
      databaseInstanceId: binding.databaseInstanceId,
      contentGenerationId: binding.contentGenerationId,
      businessRevision: binding.businessRevision,
      schemaVersion: binding.schemaVersion,
    },
    Object.keys(binding).sort() as never,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export interface SealGenerationInput {
  draftId: string;
  expectedRevision: number;
  /** 完整校验通过后的规范化计划摘要。 */
  planDigest: string;
  /** 完整校验问题清单：存在错误或未解决冲突时拒绝生成 seal（8.34）。 */
  problems: readonly ImportProblem[];
  targetDb: DatabaseSync;
}

/**
 * 生成校验封存：要求完整校验资格（无错误/未解决冲突）。
 * seal 绑定草稿修订（仓库自动捕获）、计划摘要、规则版本、冲突决定摘要与目标身份。
 */
export function generateValidationSeal(repo: WorkspaceRepository, input: SealGenerationInput): number {
  const blocking = input.problems.filter((p) => p.severity === 'error' || p.severity === 'conflict');
  if (blocking.length > 0) {
    throw new Error(
      `完整校验未通过：存在 ${blocking.length} 条错误或未解决冲突（空导入/错误/冲突均阻止封存），请解决后重新完整校验`,
    );
  }
  const identity = readDatabaseIdentity(input.targetDb);
  const schemaVersion = readSchemaVersion(input.targetDb);
  return repo.saveSeal(input.draftId, input.expectedRevision, {
    planDigest: input.planDigest,
    templateVersion: String(TEMPLATE_VERSION),
    mappingVersion: String(MIGRATION_MAPPING_VERSION),
    validationVersion: String(VALIDATION_VERSION),
    conflictDecisionDigest: conflictDecisionDigest(repo, input.draftId),
    targetSchemaVersion: schemaVersion,
    targetBusinessRevision: String(identity.businessRevision),
    databaseInstanceId: identity.databaseInstanceId,
    contentGenerationId: identity.contentGenerationId,
  });
}

/** 读取当前目标身份并构造完整 SealBinding（供生成与测试）。 */
export function buildSealBinding(
  repo: WorkspaceRepository,
  draftId: string,
  planDigest: string,
  targetDb: DatabaseSync,
): SealBinding {
  const draft = repo.getDraft(draftId);
  if (!draft) throw new Error(`导入草稿不存在: ${draftId}`);
  const seal = repo.getSeal(draftId);
  const identity = readDatabaseIdentity(targetDb);
  return {
    draftId,
    draftRevision: seal?.draftRevision ?? draft.revision,
    planDigest,
    templateVersion: String(TEMPLATE_VERSION),
    mappingVersion: String(MIGRATION_MAPPING_VERSION),
    validationVersion: String(VALIDATION_VERSION),
    conflictDecisionDigest: conflictDecisionDigest(repo, draftId),
    databaseInstanceId: identity.databaseInstanceId,
    contentGenerationId: identity.contentGenerationId,
    businessRevision: identity.businessRevision,
    schemaVersion: readSchemaVersion(targetDb),
  };
}

/**
 * 验证 seal：逐分量比较当前草稿与目标身份。
 * 任一草稿变化、规则版本升级、冲突决定变化、目标业务修订/schema/内容代际变化 → 失效；
 * 草稿仍在 sealed 时持久化失效（标记 invalid 并回到 needs_review）。
 *
 * @param options.allowCommitting 提交事务内核验时草稿已处于 committing（草稿已锁定），
 *   允许状态为 sealed/committing，不做状态判定；任一绑定分量变化仍判失效。
 */
export function verifyValidationSeal(
  repo: WorkspaceRepository,
  draftId: string,
  targetDb: DatabaseSync,
  options: { allowCommitting?: boolean } = {},
): SealVerification {
  const seal = repo.getSeal(draftId);
  if (!seal) return { valid: false, seal: undefined, reasons: ['不存在校验封存'] };

  const draft = repo.getDraft(draftId);
  const reasons: string[] = [];
  if (seal.status !== 'valid') reasons.push('校验封存已被标记为失效');
  if (!draft) reasons.push('草稿不存在');
  else if (draft.state !== 'sealed' && !(options.allowCommitting && draft.state === 'committing')) {
    reasons.push(`草稿状态为 ${draft.state}，不是 sealed`);
  }
  // 生成 seal 后：sealed 状态只允许「seal 写入」递增一次修订；
  // committing 提交锁定状态额外允许一次 start_committing 转换递增。
  const revisionOk =
    draft !== undefined &&
    (options.allowCommitting
      ? draft.revision === seal.draftRevision + 1 || draft.revision === seal.draftRevision + 2
      : draft.revision === seal.draftRevision + 1);
  if (seal.draftRevision !== undefined && draft && !revisionOk) {
    reasons.push('草稿修订已变化（生成封存后发生其他修改）');
  }
  if (seal.templateVersion !== String(TEMPLATE_VERSION)) reasons.push('模板版本变化');
  if (seal.mappingVersion !== String(MIGRATION_MAPPING_VERSION)) reasons.push('映射版本变化');
  if (seal.validationVersion !== String(VALIDATION_VERSION)) reasons.push('校验规则版本变化');
  const digest = conflictDecisionDigest(repo, draftId);
  if ((seal.conflictDecisionDigest ?? '') !== digest) reasons.push('冲突决定清单变化');
  if (seal.planDigest !== currentPlanDigest(repo, draftId)) reasons.push('规范化计划摘要变化');

  try {
    const identity = readDatabaseIdentity(targetDb);
    if (seal.databaseInstanceId !== identity.databaseInstanceId) reasons.push('目标库实例（database_instance_id）变化');
    if (seal.contentGenerationId !== identity.contentGenerationId) reasons.push('目标库内容代际（content_generation_id）变化');
    if (seal.targetBusinessRevision !== String(identity.businessRevision)) reasons.push('目标业务修订（business_revision）变化');
    const schemaVersion = readSchemaVersion(targetDb);
    if (seal.targetSchemaVersion !== schemaVersion) reasons.push('目标 schema 版本变化');
  } catch {
    reasons.push('无法读取目标库身份（schema 元数据缺失）');
  }

  const valid = reasons.length === 0;
  // 任一变化使 seal 失效：草稿仍在 sealed 时持久化失效。
  if (!valid && draft && draft.state === 'sealed') {
    try {
      repo.invalidateSeal(draftId, draft.revision);
    } catch {
      // 失效已由状态机保证；继续返回验证结果
    }
  }
  return { valid, seal, reasons };
}
