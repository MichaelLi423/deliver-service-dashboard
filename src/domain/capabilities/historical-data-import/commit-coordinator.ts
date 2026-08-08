import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../core/errors';
import { SystemClock, type Clock } from '../../core/time';
import { openDatabase } from '../local-data-persistence/connection';
import { runOnlineBackup } from '../local-data-persistence/backup';
import { readBusinessRevision } from '../local-data-persistence/identity';
import { WorkspaceRepository } from './workspace/workspace-repository';
import { IMPORT_CATEGORIES, type ImportCategory } from './workspace/workspace-model';
import type { NormalizedRow } from './normalized-row';
import type { ImportProblem } from './validation-model';
import { buildPlanFromRows, type NormalizedImportPlan } from './validation-kernel';
import { validatePlan } from './validation';
import { TargetConflictReader } from './target-reader';
import { verifyValidationSeal, VALIDATION_VERSION } from './seal';
import { TEMPLATE_VERSION } from './template';
import { MIGRATION_MAPPING_VERSION } from './mapping';
import {
  applyPlanInOpenTransaction,
  prepareImportFromKernelPlan,
  type FaultPhase,
} from './migration-service';

/**
 * 正式提交协调器（design D26 / tasks 8.38~8.41、8.44）。
 *
 * BusinessWriteCoordinator：
 * - 互斥 + operation ID 去重：双击/重复快捷键/重复 IPC 只能产生一个运行结果；
 * - 事务外创建并验证导入前安全快照，快照失败禁止开始业务写入（零写）；
 * - 单个立即写事务内：复核草稿修订、validation seal 全部分量、目标身份
 *   （instance/generation/revision/schema）、唯一性/引用/目标快照，再调用现有
 *   applyPlanInOpenTransaction 一次写入七类 + 来源审计 + 目标快照 + 运行审计 + 对账；
 * - 中断后以 import_run 成功审计（与完整事务同生共灭）判定完整成功，否则完整回滚并
 *   要求重新完整校验（settleCommit(verified=false) → needs_review + seal 失效）。
 */

/** 提交协调器故障注入阶段（含 migration-service 全部 writer/审计/对账阶段）。 */
export type CommitFaultPhase = 'snapshot' | 'pre_run_audit' | 'run_audit' | 'reconcile' | FaultPhase;

export class CommitRejectedError extends DomainError {
  constructor(message: string) {
    super('COMMIT_REJECTED', message);
    this.name = 'CommitRejectedError';
  }
}

/** 正式迁移运行审计记录（import_run，design D27 / tasks 8.16）。 */
export interface ImportRunRecord {
  id: string;
  operationId: string;
  draftId: string;
  planDigest: string;
  templateVersion: string | null;
  mappingVersion: string | null;
  validationVersion: string | null;
  accountId: string | null;
  usernameSnapshot: string | null;
  startedAt: string;
  confirmedAt: string | null;
  committedAt: string | null;
  status: 'running' | 'confirmed' | 'succeeded' | 'rolled_back' | 'unknown';
  planCounts: Record<ImportCategory, number>;
  writtenCounts: Record<ImportCategory, number>;
  preBusinessRevision: number;
  postBusinessRevision: number | null;
  result: string | null;
}

export interface CommitActor {
  accountId: string | null;
  username: string | null;
}

export interface CommitInput {
  draftId: string;
  expectedRevision: number;
  /** 业务提交 operation ID（缺省自动生成；同 operation 重复提交返回同一结果）。 */
  operationId?: string;
  /** 与 validation seal 同源的规范化计划摘要。 */
  planDigest: string;
  rows: readonly NormalizedRow[];
  /** 完整校验问题清单（存在错误或未解决冲突时拒绝提交）。 */
  problems: readonly ImportProblem[];
  /** 七类显式声明（未声明类别阻止提交资格）。 */
  declared: Partial<Record<ImportCategory, 'data' | 'none'>>;
  /** 确认导入的登录账号（内部 ID + 确认时用户名快照）。 */
  actor: CommitActor;
  /** 提交注册时的会话 token（Oracle 复审 #5）：随会话失效/generation 变化而失效。 */
  sessionToken?: string;
  /** 会话有效性回调：快照 await 后、BEGIN 前、事务内写入前复核；失效 → 零写拒绝。 */
  verifySessionToken?: (token: string) => boolean;
  /** 导入前安全快照目录（事务外创建与验证）。 */
  snapshotDir: string;
  now?: Clock;
  injectFault?: (phase: CommitFaultPhase) => void;
}

export type CommitStatus = 'committed' | 'already_committed' | 'busy' | 'failed';

export interface CommitOutcome {
  status: CommitStatus;
  operationId: string;
  run: ImportRunRecord | null;
  error: string | null;
}

export interface InterruptionOutcome {
  status: 'succeeded' | 'rolled_back';
  runId: string | null;
}

// ---------------------------------------------------------------------------
// import_run 审计读写（schema v11）
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  operation_id: string;
  draft_id: string;
  plan_digest: string;
  template_version: string | null;
  mapping_version: string | null;
  validation_version: string | null;
  account_id: string | null;
  username_snapshot: string | null;
  started_at: string;
  confirmed_at: string | null;
  committed_at: string | null;
  status: ImportRunRecord['status'];
  plan_project: number;
  plan_service_order: number;
  plan_invoice: number;
  plan_logistics_fee: number;
  plan_serial_address_update: number;
  plan_qr_request: number;
  plan_ship_to_request: number;
  written_project: number;
  written_service_order: number;
  written_invoice: number;
  written_logistics_fee: number;
  written_serial_address_update: number;
  written_qr_request: number;
  written_ship_to_request: number;
  pre_business_revision: number;
  post_business_revision: number | null;
  result: string | null;
}

function toRunRecord(r: RunRow): ImportRunRecord {
  const counts = (prefix: 'plan' | 'written'): Record<ImportCategory, number> => ({
    project: prefix === 'plan' ? r.plan_project : r.written_project,
    service_order: prefix === 'plan' ? r.plan_service_order : r.written_service_order,
    invoice: prefix === 'plan' ? r.plan_invoice : r.written_invoice,
    logistics_fee: prefix === 'plan' ? r.plan_logistics_fee : r.written_logistics_fee,
    serial_address_update: prefix === 'plan' ? r.plan_serial_address_update : r.written_serial_address_update,
    qr_request: prefix === 'plan' ? r.plan_qr_request : r.written_qr_request,
    ship_to_request: prefix === 'plan' ? r.plan_ship_to_request : r.written_ship_to_request,
  });
  return {
    id: r.id,
    operationId: r.operation_id,
    draftId: r.draft_id,
    planDigest: r.plan_digest,
    templateVersion: r.template_version,
    mappingVersion: r.mapping_version,
    validationVersion: r.validation_version,
    accountId: r.account_id,
    usernameSnapshot: r.username_snapshot,
    startedAt: r.started_at,
    confirmedAt: r.confirmed_at,
    committedAt: r.committed_at,
    status: r.status,
    planCounts: counts('plan'),
    writtenCounts: counts('written'),
    preBusinessRevision: r.pre_business_revision,
    postBusinessRevision: r.post_business_revision,
    result: r.result,
  };
}

/** 按 operation_id 查运行记录（唯一；防重复提交）。 */
export function findRunByOperationId(db: DatabaseSync, operationId: string): ImportRunRecord | null {
  const row = db
    .prepare('SELECT * FROM import_run WHERE operation_id = ? LIMIT 1')
    .get(operationId) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

/** 草稿最近一次运行记录（中断结果判定）。 */
export function latestRunForDraft(db: DatabaseSync, draftId: string): ImportRunRecord | null {
  const row = db
    .prepare('SELECT * FROM import_run WHERE draft_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(draftId) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

function planCountsFor(plan: NormalizedImportPlan): Record<ImportCategory, number> {
  const counts = {} as Record<ImportCategory, number>;
  for (const c of IMPORT_CATEGORIES) counts[c] = plan.recordCounts[c];
  counts.project = plan.projects.length; // 计划项目数以 ECC 聚合项目计
  return counts;
}

/** 事务外注册运行（status=confirmed；operation_id 唯一约束防重）。 */
function insertRunConfirmed(
  db: DatabaseSync,
  input: CommitInput,
  plan: NormalizedImportPlan,
  nowIso: string,
  preRevision: number,
): string {
  const id = randomUUID();
  const counts = planCountsFor(plan);
  db.prepare(
    `INSERT INTO import_run (
       id, operation_id, draft_id, plan_digest, template_version, mapping_version, validation_version,
       account_id, username_snapshot, started_at, confirmed_at, committed_at, status,
       plan_project, plan_service_order, plan_invoice, plan_logistics_fee,
       plan_serial_address_update, plan_qr_request, plan_ship_to_request,
       written_project, written_service_order, written_invoice, written_logistics_fee,
       written_serial_address_update, written_qr_request, written_ship_to_request,
       pre_business_revision, post_business_revision, result, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.operationId ?? '',
    input.draftId,
    input.planDigest,
    String(TEMPLATE_VERSION),
    String(MIGRATION_MAPPING_VERSION),
    String(VALIDATION_VERSION),
    input.actor.accountId,
    input.actor.username,
    nowIso,
    nowIso,
    null,
    'confirmed',
    counts.project, counts.service_order, counts.invoice, counts.logistics_fee,
    counts.serial_address_update, counts.qr_request, counts.ship_to_request,
    0, 0, 0, 0, 0, 0, 0,
    preRevision,
    null,
    null,
    nowIso,
  );
  return id;
}

/** 事务内标记 succeeded（提交成功审计；与完整事务同生共灭）。 */
function updateRunSucceeded(
  db: DatabaseSync,
  runId: string,
  written: Record<ImportCategory, number>,
  postRevision: number,
  committedAt: string,
): void {
  db.prepare(
    `UPDATE import_run SET status='succeeded', committed_at=?, post_business_revision=?,
       written_project=?, written_service_order=?, written_invoice=?, written_logistics_fee=?,
       written_serial_address_update=?, written_qr_request=?, written_ship_to_request=?, result=?
     WHERE id=?`,
  ).run(
    committedAt,
    postRevision,
    written.project, written.service_order, written.invoice, written.logistics_fee,
    written.serial_address_update, written.qr_request, written.ship_to_request,
    'succeeded',
    runId,
  );
}

/** 事务外标记失败（best effort 审计；不改变业务数据）。 */
function markRunFailed(db: DatabaseSync, runId: string, message: string): void {
  db.prepare("UPDATE import_run SET status='rolled_back', result=? WHERE id=? AND status <> 'succeeded'").run(
    message,
    runId,
  );
}

// ---------------------------------------------------------------------------
// 协调器
// ---------------------------------------------------------------------------

/**
 * 写后对账：七类计划数与实际写入数必须一致（project 按 ECC 聚合）。
 * 静默丢弃 → 抛错 → 事务整体回滚。
 */
export function reconcileWrittenCounts(plan: NormalizedImportPlan, writtenCounts: Record<string, number>): void {
  const expectedProject = plan.projects.length;
  const actualProject = writtenCounts.project ?? 0;
  if (actualProject !== expectedProject) {
    throw new Error(`角色「project」计划 ${expectedProject} 条但实际写入 ${actualProject} 条：存在静默丢弃，导入失败`);
  }
  for (const category of IMPORT_CATEGORIES) {
    if (category === 'project') continue;
    const expected = plan.recordCounts[category];
    const actual = writtenCounts[category] ?? 0;
    if (actual !== expected) {
      throw new Error(`角色「${category}」计划 ${expected} 条但实际写入 ${actual} 条：存在静默丢弃，导入失败`);
    }
  }
}

/** 计划是否有任何目标记录（项目按 ECC 聚合，其余按类别记录数）。 */
function planHasRecords(plan: NormalizedImportPlan): boolean {
  if (plan.projects.length > 0) return true;
  for (const category of IMPORT_CATEGORIES) {
    if (plan.recordCounts[category] > 0) return true;
  }
  return false;
}

export class BusinessWriteCoordinator {
  /** 进行中 operation（双击/重复 IPC 去重）。 */
  private readonly inFlight = new Set<string>();
  /** 进程内互斥：一次只允许一个正式提交。 */
  private mutexHeld = false;

  private acquireMutex(): void {
    if (this.mutexHeld) {
      throw new CommitRejectedError('另一个正式提交正在进行中（互斥），请稍后重试');
    }
    this.mutexHeld = true;
  }

  private releaseMutex(): void {
    this.mutexHeld = false;
  }

  /**
   * 封存计划原子提交（design D26 / tasks 8.38~8.41）。
   * 互斥 → 安全快照（事务外）→ 锁定草稿 → BEGIN IMMEDIATE → 事务内复核 →
   * applyPlanInOpenTransaction 一次写七类 + 来源/目标快照 → 运行审计 → 对账 → COMMIT。
   */
  async commitSealedPlanAtomically(
    businessDb: DatabaseSync,
    workspace: WorkspaceRepository,
    input: CommitInput,
  ): Promise<CommitOutcome> {
    const operationId = input.operationId ?? randomUUID();
    const now = input.now ?? new SystemClock();
    const nowIso = now.nowIso();
    const plan = buildPlanFromRows(input.rows);

    // 计划摘要与封存计划一致。
    if (plan.planDigest !== input.planDigest) {
      throw new CommitRejectedError('计划摘要与封存计划不一致，请重新完整校验');
    }

    // 重复 operation / double submit：同一 operation 已成功 → 返回同一成功；进行中 → busy。
    if (this.inFlight.has(operationId)) {
      return { status: 'busy', operationId, run: null, error: '该 operation 正在提交中（重复触发被抑制）' };
    }
    const existingRun = findRunByOperationId(businessDb, operationId);
    if (existingRun !== null) {
      if (existingRun.status === 'succeeded') {
        return { status: 'already_committed', operationId, run: existingRun, error: null };
      }
      return {
        status: 'busy',
        operationId,
        run: existingRun,
        error: '该 operation 已有未完成运行记录（中断遗留），先核对结果后再以新 operation 重试',
      };
    }

    // 事务外前置校验：草稿 sealed、修订一致、seal 有效、资格通过。
    this.preVerify(businessDb, workspace, input);

    this.inFlight.add(operationId);
    try {
      this.acquireMutex();
      try {
        // 1) 事务外创建并验证导入前安全快照（失败 → 零业务写入、草稿不变）。
        let snapshotPath: string;
        try {
          input.injectFault?.('snapshot');
          snapshotPath = await this.createSafeSnapshot(businessDb, input.snapshotDir, now);
        } catch (err) {
          if (err instanceof CommitRejectedError) throw err;
          throw new CommitRejectedError(
            `导入前安全快照失败（禁止开始业务写入）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        void snapshotPath;

        // 2) 安全快照 await 之后、BEGIN 之前复核会话 token（会话在快照期间失效 → 零写）。
        this.assertSessionActive(input);

        // 2) 注册运行审计（事务外；operation_id 唯一约束兜底防重）。
        input.injectFault?.('pre_run_audit');
        let runId: string;
        let preRevision: number;
        try {
          preRevision = readBusinessRevision(businessDb);
          runId = insertRunConfirmed(businessDb, { ...input, operationId }, plan, nowIso, preRevision);
        } catch (err) {
          throw new CommitRejectedError(
            `运行审计写入失败（operation 去重兜底）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // 3) 锁定草稿（提交期间禁止修改）。
        let commitRevision: number;
        try {
          commitRevision = workspace.transitionState(input.draftId, input.expectedRevision, 'start_committing');
        } catch (err) {
          try {
            markRunFailed(businessDb, runId, err instanceof Error ? err.message : String(err));
          } catch {
            // 审计失败不影响主错误
          }
          throw new CommitRejectedError(
            `无法锁定草稿提交（修订冲突或状态非法）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // 4) 单个立即写事务（事务开始后为同步路径：无 await，防止会话/竞态在窗口内变化）。
        businessDb.exec('BEGIN IMMEDIATE');
        try {
          // 事务内复核：草稿修订 / seal 全部分量 / 目标身份与 schema / 唯一性/引用/目标快照。
          const re = this.reVerifyInTransaction(businessDb, workspace, input, plan, commitRevision);
          if (!re.ok) throw new CommitRejectedError(re.reason);

          // 事务内、业务写入前复核会话 token（Oracle 复审 #5：失效 → 整体回滚零写）。
          this.assertSessionActive(input);

          // 写七类 + 来源审计（migration_audit）+ 目标快照（import_record_audit）。
          const prepared = prepareImportFromKernelPlan(plan, {
            now,
            injectFault: (phase) => input.injectFault?.(phase),
          });
          const result = applyPlanInOpenTransaction(businessDb, prepared);

          // 空写保护（Oracle 复审 #3）：计划有记录但生成零批次 → 失败（不静默成功空导）。
          if (result.batches.length === 0 && planHasRecords(plan)) {
            throw new Error('计划有记录但生成零批次：存在静默丢弃/空导，导入失败');
          }

          // 运行审计（事务内标记 succeeded = 完整事务已成功写入的审计证据）。
          input.injectFault?.('run_audit');
          const written = { ...result.writtenCounts } as unknown as Record<ImportCategory, number>;
          const postRevision = readBusinessRevision(businessDb);
          updateRunSucceeded(businessDb, runId, written, postRevision, nowIso);

          // 写后对账：任一类别不一致 → 整体回滚。
          input.injectFault?.('reconcile');
          const hasFailedBatch = result.batches.some((b) => b.status === 'failed');
          if (hasFailedBatch) {
            throw new Error('存在失败批次：写入不完整，整体回滚');
          }
          if (result.batches.some((b) => b.status === 'success')) {
            reconcileWrittenCounts(plan, result.writtenCounts);
          }

          businessDb.exec('COMMIT');
        } catch (err) {
          try {
            businessDb.exec('ROLLBACK');
          } catch {
            // 回滚失败不影响主错误上报
          }
          const message = err instanceof Error ? err.message : String(err);
          try {
            markRunFailed(businessDb, runId, message);
          } catch {
            // 审计失败不影响主错误上报
          }
          // 完整回滚 → 草稿回到需重新校验状态（seal 失效）。
          try {
            workspace.settleCommit(input.draftId, false);
          } catch {
            // 草稿状态异常时以运行审计为准（settleInterruptedCommit 兜底）
          }
          return { status: 'failed', operationId, run: findRunByOperationId(businessDb, operationId), error: message };
        }

        // 5) 提交成功：草稿 succeeded（清除敏感行、保留摘要）。
        try {
          workspace.settleCommit(input.draftId, true);
        } catch (err) {
          // 业务数据已提交；草稿状态异常时由 settleInterruptedCommit 兜底。
          return {
            status: 'committed',
            operationId,
            run: findRunByOperationId(businessDb, operationId),
            error: `业务数据已提交，但草稿状态判定异常: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return { status: 'committed', operationId, run: findRunByOperationId(businessDb, operationId), error: null };
      } finally {
        this.releaseMutex();
      }
    } finally {
      this.inFlight.delete(operationId);
    }
  }

  /**
   * 中断后的结果判定（tasks 8.44）：仅「成功审计（import_run.status=succeeded，
   * 与完整事务同生共灭）+ 事务完整提交」同时存在才判成功；否则完整回滚并要求重新完整校验。
   */
  settleInterruptedCommit(businessDb: DatabaseSync, workspace: WorkspaceRepository, draftId: string): InterruptionOutcome {
    const run = latestRunForDraft(businessDb, draftId);
    if (run !== null && run.status === 'succeeded') {
      workspace.settleCommit(draftId, true);
      return { status: 'succeeded', runId: run.id };
    }
    workspace.settleCommit(draftId, false);
    return { status: 'rolled_back', runId: run?.id ?? null };
  }

  /** 会话 token 复核（Oracle 复审 #5）：提交注册的 token 在当前会话有效时才放行。 */
  private assertSessionActive(input: CommitInput): void {
    if (input.verifySessionToken && !input.verifySessionToken(input.sessionToken ?? '')) {
      throw new CommitRejectedError('会话已失效（token/generation 变化），禁止写入业务数据');
    }
  }

  /** 事务外前置校验（草稿状态/修订/seal/资格），失败抛 CommitRejectedError。 */
  private preVerify(businessDb: DatabaseSync, workspace: WorkspaceRepository, input: CommitInput): void {
    const draft = workspace.getDraft(input.draftId);
    if (!draft) throw new CommitRejectedError('导入草稿不存在');
    if (draft.state !== 'sealed') {
      throw new CommitRejectedError(`草稿状态为 ${draft.state}，未封存（需先完整校验并生成校验封存）`);
    }
    if (draft.revision !== input.expectedRevision) {
      throw new CommitRejectedError(`草稿修订已变化（当前 ${draft.revision}，期望 ${input.expectedRevision}），请基于最新草稿重新完整校验`);
    }
    const seal = workspace.getSeal(input.draftId);
    if (!seal || seal.status !== 'valid') {
      throw new CommitRejectedError('校验封存缺失或已失效，请重新完整校验');
    }
    const verification = verifyValidationSeal(workspace, input.draftId, businessDb);
    if (!verification.valid) {
      throw new CommitRejectedError(`校验封存失效：${verification.reasons.join('；')}`);
    }
    const blocking = input.problems.filter((p) => p.severity === 'error' || p.severity === 'conflict');
    if (blocking.length > 0) {
      throw new CommitRejectedError(`完整校验未通过：存在 ${blocking.length} 条错误或未解决冲突，禁止提交`);
    }
  }

  /** 事务内复核（design D26 第 4 步）。 */
  private reVerifyInTransaction(
    businessDb: DatabaseSync,
    workspace: WorkspaceRepository,
    input: CommitInput,
    plan: NormalizedImportPlan,
    commitRevision: number,
  ): { ok: true } | { ok: false; reason: string } {
    // 草稿修订与提交锁定时一致（提交期间禁止修改）。
    const draft = workspace.getDraft(input.draftId);
    if (!draft || draft.revision !== commitRevision) {
      return { ok: false, reason: '草稿修订在提交期间发生变化（revision 竞争），请重新完整校验' };
    }
    if (draft.state !== 'committing') {
      return { ok: false, reason: `草稿状态为 ${draft.state}，未进入提交锁定` };
    }
    // seal 全部分量 + 目标身份（instance/generation/revision/schema）。
    const verification = verifyValidationSeal(workspace, input.draftId, businessDb, { allowCommitting: true });
    if (!verification.valid) {
      return { ok: false, reason: `校验封存失效：${verification.reasons.join('；')}` };
    }
    // 唯一性 / 引用 / 目标快照（事务内以最新目标数据复核，不依赖 UI 禁用状态）。
    const revalidation = validatePlan(input.rows, { declared: input.declared, target: new TargetConflictReader(businessDb) });
    if (!revalidation.eligible) {
      return { ok: false, reason: `目标数据已变化：${revalidation.blockingReasons.slice(0, 5).join('；')}` };
    }
    if (revalidation.plan.planDigest !== plan.planDigest) {
      return { ok: false, reason: '规范化计划摘要不一致，请重新完整校验' };
    }
    return { ok: true };
  }

  /** 事务外创建并验证导入前安全快照（复用在线备份能力；失败抛 CommitRejectedError）。 */
  private async createSafeSnapshot(db: DatabaseSync, snapshotDir: string, now: Clock): Promise<string> {
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }
    const stamp = now.nowIso().replace(/[-:T.]/g, '').slice(0, 14);
    const file = join(snapshotDir, `import-pre-${stamp}-${randomUUID().slice(0, 4)}.db`);
    try {
      await runOnlineBackup(db, file);
    } catch (err) {
      throw new CommitRejectedError(
        `导入前安全快照创建失败（禁止开始业务写入）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const probe = openDatabase({ path: file, readOnly: true });
      try {
        const row = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        if (row.integrity_check !== 'ok') {
          throw new CommitRejectedError('导入前安全快照完整性校验失败');
        }
      } finally {
        probe.close();
      }
    } catch (err) {
      if (err instanceof CommitRejectedError) throw err;
      throw new CommitRejectedError(
        `导入前安全快照验证失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return file;
  }
}
