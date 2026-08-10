import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SystemClock, assertValidBusinessDate, type BusinessDate, type Clock } from '../../core/time';
import { resolveStatus, type TransitionContext } from '../relocation-project-lifecycle/lifecycle';
import {
  SqliteContractRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from './repositories';

/**
 * 计划上门日期到期自动推进（Tasks 3.2 / design D5）主进程应用操作。
 *
 * - 自行持有 BEGIN IMMEDIATE 写事务（防并发/TOCTOU）；事务内查询候选
 *   （plan_visit_at <= today 且状态为待进单/待执行，<= 使桌面关闭期间漏跑
 *   在下次 catch-up 补推进）；
 * - 对每个候选在事务内重读完整事实（项目/合同/掉票），经 lifecycle 唯一入口
 *   resolveStatus 决策：到期自动推进优先于人工值、更强事实（实际装机/验收/
 *   金额闭环）继续优先、执行中幂等不写、待验收/待掉票不倒退、终态不变；
 * - 仅真实转换执行条件 UPDATE/CAS（WHERE status = 读取时状态）并写一行
 *   project_status_transition_audit（from/to/reason/effective_business_date/
 *   source=system，禁止任何客户值）；真实项目 UPDATE 经 v10 触发器自然递增
 *   business_revision，审计表不参与业务修订；
 * - 重复执行全零变化（候选已离开待进单/待执行 → 无 UPDATE → 无修订/审计）；
 *   竞争时 CAS 返回 0 行 → 重读新状态并跳过，绝不覆盖并发写入的新状态。
 *
 * 本模块只供主进程 / node 环境（测试）使用；渲染层不导入 local-data-persistence。
 */
export interface DuePlanVisitAdvanceResult {
  /** 候选项目数（plan_visit_at <= today 且状态为待进单/待执行）。 */
  scanned: number;
  /** 真实转换数（仅真实转换更新项目修订并写审计）。 */
  advanced: number;
}

export class SqliteDuePlanVisitAdvancer {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  advanceDuePlanVisits(today: BusinessDate): DuePlanVisitAdvanceResult {
    assertValidBusinessDate(today, '当前业务日期');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.advanceInTransaction(today);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败不影响原错误
      }
      throw err;
    }
  }

  private advanceInTransaction(today: BusinessDate): DuePlanVisitAdvanceResult {
    const projects = new SqliteProjectRepository(this.db);
    const contracts = new SqliteContractRepository(this.db);
    const invoices = new SqliteInvoiceReadRepository(this.db);
    const candidates = this.db
      .prepare(
        `SELECT id FROM projects
         WHERE plan_visit_at IS NOT NULL AND plan_visit_at <= ?
           AND status IN ('pending_entry', 'pending_execution')
         ORDER BY id`,
      )
      .all(today) as Array<{ id: string }>;

    let advanced = 0;
    for (const { id } of candidates) {
      // 事务内重读完整事实（决策不以候选查询的陈旧快照为准）。
      const project = projects.findById(id);
      if (!project) continue;
      const contract = project.contractId ? contracts.findByProjectId(id) : undefined;
      const context: TransitionContext = {
        currentStatus: project.status,
        // 自动推进：以现状态为基线请求保持，由 lifecycle 决策是否真实转换。
        requestedStatus: project.status,
        actualInstallDoneAt: project.actualInstallDoneAt,
        acceptanceReportDate: project.acceptanceReportDate,
        planVisitAt: project.planVisitAt,
        today,
        preEntryExecution: project.preEntryExecution,
        executionStarted: false,
        amounts: {
          confirmedAmountCents: invoices.sumActiveAmounts(id),
          finalConfirmableAmountCents: contract?.finalConfirmableAmountCents ?? null,
        },
        cancel: { hasAnyInvoiceHistory: invoices.hasAnyInvoiceHistory(id) },
      };
      const result = resolveStatus(context);
      if (!result.ok || result.status === project.status) continue;

      const nowIso = this.clock.nowIso();
      // 条件 UPDATE/CAS：仅当状态仍为读取时的状态才更新；0 行 = 并发已写新状态，
      // 重读并跳过，绝不覆盖。
      const updated = this.db
        .prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .run(result.status, nowIso, id, project.status);
      if (updated.changes !== 1) {
        projects.findById(id); // CAS 0：重读新状态（不覆盖），本轮跳过
        continue;
      }
      // 审计：仅真实转换一行（source=system；actor 为空；不携带任何客户值）。
      this.db
        .prepare(
          `INSERT INTO project_status_transition_audit (
             id, project_id, from_status, to_status, reason,
             effective_business_date, source, created_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          id,
          project.status,
          result.status,
          result.reason,
          today,
          'system',
          nowIso,
        );
      advanced += 1;
    }
    return { scanned: candidates.length, advanced };
  }
}
