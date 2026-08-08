import { WorkspaceStateError } from './workspace-errors';

/**
 * 草稿状态机（design D20 / tasks 8.11）。
 *
 * 主流程：draft → parsing → needs_review ↔ validating → sealed → committing → succeeded；
 * 另有 cancelled 终态。parsing / validating / committing 为运行态：
 * - parsing、validating 在应用重启时回到最后稳定草稿修订（needs_review 或 draft）；
 * - committing 必须先核对正式成功审计，再判定为 succeeded 或回到需重新校验状态。
 */

export const WORKSPACE_DRAFT_STATES = [
  'draft',
  'parsing',
  'needs_review',
  'validating',
  'sealed',
  'committing',
  'succeeded',
  'cancelled',
] as const;
export type WorkspaceDraftState = (typeof WORKSPACE_DRAFT_STATES)[number];

/** 运行态：应用重启时需要恢复。 */
export const RUNTIME_DRAFT_STATES: readonly WorkspaceDraftState[] = [
  'parsing',
  'validating',
  'committing',
];

/** 稳定态：可持久化为草稿修订。 */
export const STABLE_DRAFT_STATES: readonly WorkspaceDraftState[] = [
  'draft',
  'needs_review',
  'sealed',
  'succeeded',
  'cancelled',
];

/** 终态：不再接受任何转换或修改。 */
export const TERMINAL_DRAFT_STATES: readonly WorkspaceDraftState[] = ['succeeded', 'cancelled'];

export type WorkspaceDraftEvent =
  | 'start_parsing'
  | 'parsing_finished'
  | 'start_validating'
  | 'validation_finished'
  | 'validation_passed'
  | 'seal_invalidated'
  | 'start_committing'
  | 'commit_verified'
  | 'commit_failed'
  | 'cancel_draft';

/** 合法转换表：null 表示该事件在当前状态非法。 */
const TRANSITIONS: Record<WorkspaceDraftState, Partial<Record<WorkspaceDraftEvent, WorkspaceDraftState>>> = {
  draft: { start_parsing: 'parsing', cancel_draft: 'cancelled' },
  parsing: { parsing_finished: 'needs_review' },
  needs_review: { start_parsing: 'parsing', start_validating: 'validating', cancel_draft: 'cancelled' },
  validating: { validation_finished: 'needs_review', validation_passed: 'sealed' },
  sealed: { start_committing: 'committing', seal_invalidated: 'needs_review' },
  committing: { commit_verified: 'succeeded', commit_failed: 'needs_review' },
  succeeded: {},
  cancelled: {},
};

/** 校验状态转换；非法转换抛 WorkspaceStateError。 */
export function transitionState(from: WorkspaceDraftState, event: WorkspaceDraftEvent): WorkspaceDraftState {
  const to = TRANSITIONS[from]?.[event];
  if (to === undefined) {
    throw new WorkspaceStateError(`草稿状态 ${from} 不允许事件 ${event} 转换（非法状态转换被拒绝）`);
  }
  return to;
}

export function isRuntimeState(state: WorkspaceDraftState): boolean {
  return RUNTIME_DRAFT_STATES.includes(state);
}

export function isStableState(state: WorkspaceDraftState): boolean {
  return STABLE_DRAFT_STATES.includes(state);
}

export function isTerminalState(state: WorkspaceDraftState): boolean {
  return TERMINAL_DRAFT_STATES.includes(state);
}
