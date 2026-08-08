import { ValidationError } from '../../core/errors';
import {
  ALL_STATUSES,
  CANCELLED_STATUS,
  isCancelled,
  isLegalStatus,
  type ProjectStatusOrCancelled,
} from './states';

/**
 * 集中状态校验入口（design D4 / tasks 1.8 / 2.2）。
 *
 * 本模块（relocation-project-lifecycle）是唯一拥有主状态转换/校验入口的模块。
 * 组织方式：人工选择 + 自动触发 + 约束校验。
 *
 * 自动触发（优先于人工选择）：
 * - 标记验收报告并填写报告形成日期 → 自动置为待掉票（不要求当前状态已待验收，
 *   只要有效验收报告事实即生效；已取消拒绝）
 * - 录入实际装机完成时间 → 自动置为待验收（TBD-07）
 * - 待掉票/已完成之间按累计掉票金额与最终可确认金额自动重算（TBD-11，
 *   该区间内金额闭环优先于验收触发）
 *
 * 约束校验：
 * - 目标状态必须为合法状态之一
 * - 取消约束：存在任何掉票历史（含已撤销）禁止取消；已取消不可恢复
 * - 金额闭环约束：无 0 金额闭环；人工调整为「已完成」必须有闭环依据
 * - 未进单先执行标签存在时主状态保持待进单（TBD-08）：带标签的待进单项目
 *   不允许按已发生事实自动跳转或人工调整离开待进单（正式进单后标签清除，
 *   主状态由负责人人工确定；实际装机完成/验收/金额闭环等明确自动触发除外）
 */

export interface AmountClosureFacts {
  /** 累计有效掉票金额（分整数）。 */
  confirmedAmountCents: bigint;
  /** 最终可确认金额（分整数）；null = 未录入。 */
  finalConfirmableAmountCents: bigint | null;
}

export interface CancelFacts {
  /** 是否存在任何掉票历史（含已撤销掉票）。 */
  hasAnyInvoiceHistory: boolean;
}

export interface TransitionContext {
  currentStatus: ProjectStatusOrCancelled;
  requestedStatus: ProjectStatusOrCancelled;
  /** 实际装机完成时间（业务时间）；null = 未录入。 */
  actualInstallDoneAt: string | null;
  /** 验收报告形成日期（业务时间）；null = 尚未验收。 */
  acceptanceReportDate: string | null;
  amounts: AmountClosureFacts;
  cancel: CancelFacts;
  /** 未进单先执行标签是否生效（存在时主状态保持待进单，TBD-08）。 */
  preEntryExecution?: boolean;
  /** 首次上门活动开始或首个搬迁批次开始运输（仅完成排期/工程师/运输安排不计）。 */
  executionStarted?: boolean;
}

export type TransitionReason =
  | 'manual'
  | 'execution_started'
  | 'auto_install_done'
  | 'auto_acceptance'
  | 'auto_amount_closure'
  | 'cancel'
  | 'unchanged';

export type TransitionResult =
  | { ok: true; status: ProjectStatusOrCancelled; reason: TransitionReason }
  | { ok: false; status: ProjectStatusOrCancelled; errors: string[] };

function ok(status: ProjectStatusOrCancelled, reason: TransitionReason): TransitionResult {
  return { ok: true, status, reason };
}

function reject(currentStatus: ProjectStatusOrCancelled, errors: string[]): TransitionResult {
  return { ok: false, status: currentStatus, errors };
}

/** 金额闭环：final 有值且 > 0 时，累计 >= 最终可确认金额即进入已完成（无 0 金额闭环）。 */
function closureTarget(amounts: AmountClosureFacts): ProjectStatusOrCancelled | null {
  const final = amounts.finalConfirmableAmountCents;
  if (final === null || final <= 0n) {
    return null;
  }
  return amounts.confirmedAmountCents >= final ? 'completed' : 'pending_invoice';
}

export function resolveStatus(context: TransitionContext): TransitionResult {
  const { currentStatus, requestedStatus } = context;

  // 已取消为终态：不可恢复、不可继续流转（TBD-10）。
  if (isCancelled(currentStatus)) {
    return reject(
      currentStatus,
      ['已取消项目不可恢复；如需继续工作需重新新增项目'],
    );
  }

  // 取消请求：必须通过取消约束（任何掉票历史含已撤销禁止取消）。
  if (requestedStatus === CANCELLED_STATUS) {
    if (context.cancel.hasAnyInvoiceHistory) {
      return reject(currentStatus, [
        '存在任何掉票历史（含已撤销掉票）的项目禁止取消',
      ]);
    }
    return ok(CANCELLED_STATUS, 'cancel');
  }

  // 未进单先执行标签：带标签的待进单项目主状态保持待进单（TBD-08）。
  // 取消请求已在上方处理（此处 requestedStatus 必非已取消）；正式进单
  // （service 层清除标签后再重新校验）不受此约束。
  // 保持待进单的请求返回 unchanged（即使存在实际装机完成等自动触发事实，也先保持待进单，
  // 待正式进单后由负责人确定主状态或按明确自动触发流转）。
  if (context.preEntryExecution === true && currentStatus === 'pending_entry') {
    if (requestedStatus === 'pending_entry') {
      return ok('pending_entry', 'unchanged');
    }
    return reject(currentStatus, [
      '未进单先执行标签存在时主状态保持待进单；补齐核心信息完成正式进单后再由负责人确定主状态',
    ]);
  }

  // 自动触发 1：标记验收报告并填写报告形成日期 → 待掉票（不要求客户确认）。
  // 只要存在有效验收报告事实即自动置为待掉票，不要求当前状态已处于待验收
  // （已取消在上方拒绝；带未进单先执行标签的待进单项目由上方标签规则保持待进单；
  // 待掉票/已完成之间的金额闭环重算优先于本触发，TBD-11）。
  if (
    context.acceptanceReportDate !== null &&
    currentStatus !== 'pending_invoice' &&
    currentStatus !== 'completed'
  ) {
    return ok('pending_invoice', 'auto_acceptance');
  }

  // 自动触发 2：实际装机完成时间 → 待验收（TBD-07），优先于人工选择。
  if (
    context.actualInstallDoneAt !== null &&
    (currentStatus === 'pending_entry' ||
      currentStatus === 'pending_execution' ||
      currentStatus === 'executing')
  ) {
    return ok('pending_acceptance', 'auto_install_done');
  }

  // 自动触发 3：待掉票/已完成之间按金额闭环自动重算（TBD-11），优先于人工值。
  if (currentStatus === 'pending_invoice' || currentStatus === 'completed') {
    const target = closureTarget(context.amounts);
    if (target !== null && target !== currentStatus) {
      return ok(target, 'auto_amount_closure');
    }
  }

  // 人工选择：校验合法状态与金额闭环约束。
  if (!isLegalStatus(requestedStatus)) {
    return reject(currentStatus, [
      `目标状态「${requestedStatus}」不是合法状态之一（${ALL_STATUSES.join('、')}）`,
    ]);
  }

  if (requestedStatus === 'completed') {
    const final = context.amounts.finalConfirmableAmountCents;
    if (final === null || final <= 0n) {
      return reject(currentStatus, [
        '无法直接调整为已完成：无 0 金额闭环，须先录入大于 0 的最终可确认金额',
      ]);
    }
    if (context.amounts.confirmedAmountCents < final) {
      return reject(currentStatus, [
        '无法直接调整为已完成：累计掉票金额尚未达到最终可确认金额',
      ]);
    }
    return ok('completed', 'manual');
  }

  if (requestedStatus === currentStatus) {
    return ok(currentStatus, 'unchanged');
  }

  // 首次上门活动开始或首个搬迁批次开始运输 → 执行中（TBD-08 下为人工触发的
  // 合法流转，理由标注 execution_started；仅完成排期/工程师/运输公司安排不计）。
  if (requestedStatus === 'executing' && context.executionStarted === true) {
    return ok('executing', 'execution_started');
  }

  return ok(requestedStatus, 'manual');
}

/** 供各模块引用的校验辅助：目标状态是否为合法状态。 */
export function assertLegalStatus(status: string): asserts status is ProjectStatusOrCancelled {
  if (!isLegalStatus(status)) {
    throw new ValidationError('ILLEGAL_STATUS', `非法状态: ${status}`);
  }
}
