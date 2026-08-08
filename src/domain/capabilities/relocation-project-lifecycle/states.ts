/**
 * 项目主状态（tasks 1.8 / design D4）。
 *
 * 主状态依次为：待进单、待执行、执行中、待验收、待掉票、已完成；
 * 终止项目标记为已取消。状态转换/校验入口由本能力（relocation-project-lifecycle）唯一拥有，
 * 其他模块（todos / reporting / interface / financial）只消费校验结果，不维护状态副本。
 */

export const PROJECT_STATUSES = [
  'pending_entry', // 待进单
  'pending_execution', // 待执行
  'executing', // 执行中
  'pending_acceptance', // 待验收
  'pending_invoice', // 待掉票
  'completed', // 已完成
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 终止状态：已取消（不可恢复，继续工作需重新新增项目）。 */
export const CANCELLED_STATUS = 'cancelled' as const;

export type ProjectStatusOrCancelled = ProjectStatus | typeof CANCELLED_STATUS;

export const ALL_STATUSES: readonly ProjectStatusOrCancelled[] = [
  ...PROJECT_STATUSES,
  CANCELLED_STATUS,
];

/** 未进单先执行：独立标签，与主状态并存；存在该标签时主状态保持待进单。 */
export interface PreEntryExecutionLabel {
  approved: boolean;
  reason: string | null;
  missingItems: string | null;
}

/** 状态显示名（语义展示用，不涉及视觉样式）。 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatusOrCancelled, string> = {
  pending_entry: '待进单',
  pending_execution: '待执行',
  executing: '执行中',
  pending_acceptance: '待验收',
  pending_invoice: '待掉票',
  completed: '已完成',
  cancelled: '已取消',
};

export function isCancelled(status: ProjectStatusOrCancelled): boolean {
  return status === CANCELLED_STATUS;
}

export function isLegalStatus(status: string): status is ProjectStatusOrCancelled {
  return (ALL_STATUSES as readonly string[]).includes(status);
}
