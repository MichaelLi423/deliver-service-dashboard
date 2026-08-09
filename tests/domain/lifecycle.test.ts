import { describe, it } from 'vitest';
import { resolveStatus, type TransitionContext } from '../../src/domain/capabilities/relocation-project-lifecycle/lifecycle';
import type { ProjectStatusOrCancelled } from '../../src/domain/capabilities/relocation-project-lifecycle/states';
import { expectReason, expectRejected, expectStatus } from '../helpers/state-assert';

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    currentStatus: 'pending_execution',
    requestedStatus: 'executing',
    actualInstallDoneAt: null,
    acceptanceReportDate: null,
    amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: null },
    cancel: { hasAnyInvoiceHistory: false },
    ...overrides,
  };
}

describe('集中状态校验入口（tasks 1.8 / 2.2 / D4）', () => {
  it('负责人人工调整主状态：待执行 → 执行中 校验通过', () => {
    const result = resolveStatus(ctx());
    expectStatus(result, 'executing');
    expectReason(result, 'manual');
  });

  it('非法状态调整被拒：待执行 → 已完成（无任何掉票闭环依据）', () => {
    const result = resolveStatus(
      ctx({ currentStatus: 'pending_execution', requestedStatus: 'completed' }),
    );
    expectRejected(result, '已完成');
  });

  it('人工调整为已完成需有闭环依据（累计掉票达到最终可确认金额且金额 > 0）', () => {
    const withClosure = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 1000000n, finalConfirmableAmountCents: 1000000n },
      }),
    );
    expectStatus(withClosure, 'completed');

    const zeroClosure = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: 0n },
      }),
    );
    expectRejected(zeroClosure, '0 金额闭环');
  });

  it('自动触发 1：实际装机完成时间自动置为待验收，且优先于人工选择', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing', // 负责人同时提交人工值
        actualInstallDoneAt: '2026-07-20',
      }),
    );
    expectStatus(result, 'pending_acceptance');
    expectReason(result, 'auto_install_done');
  });

  it('自动触发 2：标记验收报告并填写报告形成日期自动置为待掉票（不要求客户确认）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'pending_acceptance',
        requestedStatus: 'pending_acceptance',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('自动触发 2（Oracle 修复）：验收报告事实不要求当前状态已待验收（执行中直接待掉票）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing', // 负责人同时提交人工值
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('自动触发 2 优先于实际装机完成：验收报告事实存在时跳过待验收直接待掉票', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing',
        actualInstallDoneAt: '2026-07-20',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('金额闭环区间内（待掉票/已完成）不因验收事实回退，闭环重算优先', () => {
    // 已完成项目再次标记验收报告 → 保持已完成（金额闭环优先，不退回待掉票）
    const staysCompleted = resolveStatus(
      ctx({
        currentStatus: 'completed',
        requestedStatus: 'completed',
        acceptanceReportDate: '2026-07-25',
        amounts: { confirmedAmountCents: 800000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(staysCompleted, 'completed');

    // 待掉票项目有验收事实且金额已达闭环 → 自动进入已完成（金额闭环优先于验收触发）
    const closed = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        acceptanceReportDate: '2026-07-25',
        amounts: { confirmedAmountCents: 800000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(closed, 'completed');
    expectReason(closed, 'auto_amount_closure');
  });

  it('已取消项目即使存在验收报告事实也拒绝流转（终态不可恢复）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'cancelled',
        requestedStatus: 'cancelled',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectRejected(result, '不可恢复');
  });

  it('自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）', () => {
    // 已确认语义：任意成功登记一笔掉票（累计有效 > 0）即进入已完成，不再等累计金额足额。
    const toCompleted = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(toCompleted, 'completed');
    expectReason(toCompleted, 'auto_amount_closure');

    // 撤销最后有效掉票后累计归 0 → 回到待掉票。
    const backToPending = resolveStatus(
      ctx({
        currentStatus: 'completed',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(backToPending, 'pending_invoice');
    expectReason(backToPending, 'auto_amount_closure');

    // 无 0 金额闭环：final 为空/0 时不产生闭环判定。
    const noClosure = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        amounts: { confirmedAmountCents: 500000n, finalConfirmableAmountCents: 0n },
      }),
    );
    expectStatus(noClosure, 'pending_invoice');
    expectReason(noClosure, 'unchanged');
  });

  it('项目未处于待掉票/已完成时金额修改不改变主状态', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing',
        amounts: { confirmedAmountCents: 500000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'unchanged');
  });

  it('取消约束：存在任何掉票历史（含已撤销）禁止取消', () => {
    const rejected = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'cancelled',
        cancel: { hasAnyInvoiceHistory: true },
      }),
    );
    expectRejected(rejected, '掉票历史');

    const allowed = resolveStatus(
      ctx({ currentStatus: 'executing', requestedStatus: 'cancelled' }),
    );
    expectStatus(allowed, 'cancelled');
    expectReason(allowed, 'cancel');
  });

  it('已取消为终态：不可恢复、禁止继续流转', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'cancelled',
        requestedStatus: 'pending_execution',
      }),
    );
    expectRejected(result, '不可恢复');
  });

  it('非法状态字符串被拒', () => {
    const result = resolveStatus(
      ctx({ currentStatus: 'pending_execution', requestedStatus: 'unknown_status' as ProjectStatusOrCancelled }),
    );
    expectRejected(result, '不是合法状态');
  });

  it('未进单先执行标签存在时主状态保持待进单（TBD-08）', () => {
    // 带标签的待进单项目不允许人工调整离开待进单（取消除外）
    const blocked = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'executing',
        preEntryExecution: true,
      }),
    );
    expectRejected(blocked, '未进单先执行');

    // 带标签时自动触发事实也不流转：保持待进单（unchanged）
    const staysPending = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'pending_entry',
        actualInstallDoneAt: '2026-07-20',
        preEntryExecution: true,
      }),
    );
    expectStatus(staysPending, 'pending_entry');
    expectReason(staysPending, 'unchanged');

    // 取消不受标签约束
    const cancelAllowed = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'cancelled',
        preEntryExecution: true,
      }),
    );
    expectStatus(cancelAllowed, 'cancelled');
  });

  it('标签清除后主状态由负责人人工确定，且明确自动触发仍生效', () => {
    // 无标签的待进单项目可人工调整
    const manual = resolveStatus(
      ctx({ currentStatus: 'pending_entry', requestedStatus: 'executing' }),
    );
    expectStatus(manual, 'executing');
    expectReason(manual, 'manual');

    // 无标签 + 已录入实际装机完成时间 → 自动待验收（先执行后进单场景）
    const auto = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'pending_entry',
        actualInstallDoneAt: '2026-07-20',
      }),
    );
    expectStatus(auto, 'pending_acceptance');
    expectReason(auto, 'auto_install_done');
  });

  it('首次上门活动开始或首个搬迁批次开始运输 → 执行中（reason 标注 execution_started）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'pending_execution',
        requestedStatus: 'executing',
        executionStarted: true,
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'execution_started');
  });
});
