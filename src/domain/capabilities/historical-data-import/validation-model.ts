import type { ImportCategory } from './workspace/workspace-model';

/**
 * 统一问题模型与稳定问题代码（design D24 / tasks 8.28）。
 *
 * - 分级：error（阻断）、conflict（待解决冲突）、warning（非阻断）；
 * - 每个问题携带类别、记录键（rowId）、目标字段、网格行、ECC/业务键与原始来源位置，
 *   供向导投影到单元格、行、步骤与全局问题面板；
 * - 冲突问题可携带候选值 + 来源位置（供用户显式选择或修正，不自动覆盖）。
 */

/** 稳定问题代码（error / conflict / warning 分级见 ImportProblem.severity）。 */
export const IMPORT_PROBLEM_CODES = {
  // ---- error：格式、必填、引用、唯一性或业务不变量不满足（阻断）----
  MISSING_ECC: 'MISSING_ECC',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_NOT_POSITIVE: 'AMOUNT_NOT_POSITIVE',
  INVALID_VALUE: 'INVALID_VALUE',
  INVALID_DATE_RANGE: 'INVALID_DATE_RANGE',
  UNRESOLVED_ECC_REFERENCE: 'UNRESOLVED_ECC_REFERENCE',
  SERIAL_NO_MISMATCH: 'SERIAL_NO_MISMATCH',
  DUPLICATE_SERIAL_IN_PROJECT: 'DUPLICATE_SERIAL_IN_PROJECT',
  EMPTY_IMPORT: 'EMPTY_IMPORT',
  UNDECLARED_CATEGORY: 'UNDECLARED_CATEGORY',
  DECLARED_DATA_EMPTY: 'DECLARED_DATA_EMPTY',
  /** 声明为本次不导入（none）但该类别存在源行（Oracle 二次复审 #1）。 */
  DECLARED_NONE_WITH_ROWS: 'DECLARED_NONE_WITH_ROWS',
  // ---- conflict：多个合法候选值或与目标数据碰撞（待解决，解决前不可提交）----
  SOURCE_CONFLICT: 'SOURCE_CONFLICT',
  DUPLICATE_SERVICE_ORDER: 'DUPLICATE_SERVICE_ORDER',
  DUPLICATE_ACCOUNT_ID: 'DUPLICATE_ACCOUNT_ID',
  QR_TYPE_MISSING: 'QR_TYPE_MISSING',
  TARGET_CONFLICT: 'TARGET_CONFLICT',
  // ---- warning：业务规则明确允许继续的异常（可见但不得误报为错误）----
  DEAL_ABOVE_BUDGET: 'DEAL_ABOVE_BUDGET',
  POSITION_ONLY_IDENTITY: 'POSITION_ONLY_IDENTITY',
} as const;

export type ImportProblemCode = (typeof IMPORT_PROBLEM_CODES)[keyof typeof IMPORT_PROBLEM_CODES];

export type ImportProblemSeverity = 'error' | 'conflict' | 'warning';

/** 冲突候选：合法来源值 + 来源位置（供用户显式选择或修正）。 */
export interface ImportConflictCandidate {
  value: string;
  /** 来源位置（file#sheet#row / paste#batch#row）。 */
  sourcePosition: string | null;
  /** 来源优先级（数字越小越高；粘贴/未知来源为 null）。 */
  sourcePriority: number | null;
  /** 来源描述（如「合同信息表」sheet「合同信息」）。 */
  source: string;
}

/** 目标冲突信息（8.33：人工目标 / 缺少可信基线 / 目标被修改）。 */
export interface ImportTargetConflictInfo {
  table: string;
  targetId: string | null;
  /** 目标是否缺少 v9 快照基线（缺少可信基线时 true）。 */
  missingBaseline: boolean;
  /** 目标为人工记录或来源键不匹配（非本次来源可覆盖）。 */
  manualOrForeignSource: boolean;
}

/** 统一校验问题（design D24）。 */
export interface ImportProblem {
  /** 稳定问题代码。 */
  code: ImportProblemCode;
  severity: ImportProblemSeverity;
  /** 受影响类别（无法定位到具体类别时为 null）。 */
  category: ImportCategory | null;
  /** 规范化记录键（工作区 rowId）。 */
  recordKey: string | null;
  /** 目标字段（field.field，如 contract.ecc）。 */
  field: string | null;
  /** 网格行（来源物理行 / 粘贴行序）。 */
  gridRow: number | null;
  /** ECC / 服务单号 / Account ID / 序列号等业务键。 */
  businessKey: string | null;
  /** 原始来源位置（file#sheet#row / paste#batch#row）。 */
  sourcePosition: string | null;
  /** 人类可读说明（不含完整业务值）。 */
  message: string;
  /** 冲突候选（仅 SOURCE_CONFLICT 等冲突问题携带）。 */
  candidates?: ImportConflictCandidate[];
  /** 目标冲突详情（仅 TARGET_CONFLICT 携带）。 */
  target?: ImportTargetConflictInfo;
}

export function isBlocking(problem: ImportProblem): boolean {
  return problem.severity === 'error' || problem.severity === 'conflict';
}

/** 稳定问题代码 → 分级（error 阻断 / conflict 待解决 / warning 非阻断）。 */
export const SEVERITY_BY_PROBLEM_CODE: Record<ImportProblemCode, ImportProblemSeverity> = {
  // error：格式、必填、引用、唯一性或业务不变量不满足（阻断）。
  MISSING_ECC: 'error',
  MISSING_REQUIRED_FIELD: 'error',
  INVALID_AMOUNT: 'error',
  AMOUNT_NOT_POSITIVE: 'error',
  INVALID_VALUE: 'error',
  INVALID_DATE_RANGE: 'error',
  UNRESOLVED_ECC_REFERENCE: 'error',
  SERIAL_NO_MISMATCH: 'error',
  DUPLICATE_SERIAL_IN_PROJECT: 'error',
  EMPTY_IMPORT: 'error',
  UNDECLARED_CATEGORY: 'error',
  DECLARED_DATA_EMPTY: 'error',
  DECLARED_NONE_WITH_ROWS: 'error',
  // conflict：多个合法候选值或与目标数据碰撞（解决前不可提交）。
  SOURCE_CONFLICT: 'conflict',
  DUPLICATE_SERVICE_ORDER: 'conflict',
  DUPLICATE_ACCOUNT_ID: 'conflict',
  QR_TYPE_MISSING: 'conflict',
  TARGET_CONFLICT: 'conflict',
  // warning：业务规则明确允许继续的异常。
  DEAL_ABOVE_BUDGET: 'warning',
  POSITION_ONLY_IDENTITY: 'warning',
};

/** 由问题代码取分级。 */
export function severityOfCode(code: ImportProblemCode): ImportProblemSeverity {
  return SEVERITY_BY_PROBLEM_CODE[code];
}
