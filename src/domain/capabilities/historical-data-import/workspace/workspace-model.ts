import type { WorkspaceDraftState } from './workspace-state';

/**
 * 导入工作区领域模型（design D20/D23 / tasks 8.9~8.14）。
 *
 * 七类目标类别与历史数据导入规格一致：项目/合同、开单、掉票、物流费用、
 * 序列号地址更新、二维码申请、Ship-to 申请。金额/摘要一律使用可精确
 * 结构化克隆的字符串表达（不在此层做二进制浮点运算）。
 */

/** 七类导入目标类别（design D11；供应商仅作物流参考，不构成第八类）。 */
export const IMPORT_CATEGORIES = [
  'project',
  'service_order',
  'invoice',
  'logistics_fee',
  'serial_address_update',
  'qr_request',
  'ship_to_request',
] as const;
export type ImportCategory = (typeof IMPORT_CATEGORIES)[number];

export const IMPORT_CATEGORY_LABELS: Record<ImportCategory, string> = {
  project: '项目与合同',
  service_order: '开单记录',
  invoice: '掉票记录',
  logistics_fee: '物流费用',
  serial_address_update: '序列号地址更新',
  qr_request: '二维码申请',
  ship_to_request: 'Ship-to 申请',
};

export interface CreateDraftInput {
  name: string;
  /** 草稿创建账号内部 ID 与用户名快照（design D27）。 */
  createdBy: string | null;
  createdByUsername: string | null;
}

export interface DraftSummary {
  id: string;
  name: string;
  state: WorkspaceDraftState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastSavedAt: string;
  /** 各类别规范化行数（终态草稿读取清理时保留的摘要）。 */
  rowCounts: Record<ImportCategory, number>;
  totalRows: number;
}

export interface DraftDetail extends DraftSummary {
  createdBy: string | null;
  createdByUsername: string | null;
  /** committing 中断后是否等待正式成功审计核对。 */
  pendingOutcome: boolean;
  rowCountSummary: Record<ImportCategory, number>;
}

/** 追加规范化行的输入（分块写入，design D23）。 */
export interface AppendRowInput {
  /** 稳定行 ID（业务键 / 模板 source_row_id / 兜底源行键的映射）。 */
  rowId: string;
  businessKey?: string | null;
  sourceRowId?: string | null;
  sourceFile?: string | null;
  sourceSheet?: string | null;
  sourceRow?: number | null;
  pasteBatch?: string | null;
  cells?: Record<string, string | null>;
}

export interface WorkspaceRow {
  rowId: string;
  revision: number;
  category: ImportCategory;
  sortKey: number;
  gridRow: number;
  sourceRowId: string | null;
  businessKey: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
  sourceRow: number | null;
  pasteBatch: string | null;
  /** sheet 归类为 excluded 的源行标记排除（不进入 normalizedRows/计划/seal/commit）。 */
  excluded: boolean;
  cells: Record<string, string | null>;
}

/** 窗口查询（design D23：renderer 不持有整份大草稿）。 */
export interface RowQuery {
  category?: ImportCategory | null;
  /** 业务键精确匹配（ECC / 服务单号 / Account ID / 序列号）。 */
  businessKey?: string | null;
  /** 筛选带指定严重度未解决问题 的行。 */
  issueSeverity?: IssueSeverity | null;
  offset: number;
  limit: number;
}

export interface RowWindow {
  total: number;
  offset: number;
  limit: number;
  rows: WorkspaceRow[];
}

/** 稀疏 cell patch：一次提交多个单元格，以草稿修订号做乐观并发检查。 */
export interface CellPatch {
  rowId: string;
  field: string;
  value: string | null;
}

export interface SourceInput {
  sourceKind: 'file' | 'paste';
  sourceFile: string;
  sheet?: string | null;
  sourceHash?: string | null;
  rowCount?: number;
}

export interface WorkspaceSource {
  id: string;
  draftId: string;
  sourceKind: 'file' | 'paste';
  sourceFile: string;
  sheet: string | null;
  sourceHash: string | null;
  rowCount: number;
  addedAt: string;
}

/** 列映射（design D21：精确/别名/待选/不用；无相似名称模糊猜测）。 */
export interface ColumnMapping {
  category: ImportCategory;
  sourceColumn: string;
  targetField: string | null;
  mappingState: 'exact' | 'alias' | 'pending' | 'ignored';
  sampleValue?: string | null;
  priority?: number | null;
  sourcePriority?: string | null;
}

export interface ConflictDecisionInput {
  rowId?: string | null;
  field: string;
  decisionType: 'choose_candidate' | 'fix_value' | 'exclude';
  chosenValue?: string | null;
  resolvedBy?: string | null;
}

export interface ConflictDecision extends ConflictDecisionInput {
  id: string;
  resolvedAt: string;
}

export type IssueSeverity = 'error' | 'conflict' | 'warning';

export interface IssueInput {
  severity: IssueSeverity;
  issueCode: string;
  category?: ImportCategory | null;
  rowId?: string | null;
  field?: string | null;
  businessKey?: string | null;
  gridRow?: number | null;
  sourcePosition?: string | null;
  message: string;
  resolved?: boolean;
}

export interface ImportIssue extends IssueInput {
  id: string;
  revision: number;
  resolved: boolean;
}

export interface IssueQuery {
  severity?: IssueSeverity | null;
  category?: ImportCategory | null;
  resolved?: boolean;
}

export type OperationKind = 'parsing' | 'validating' | 'committing';
export type OperationState = 'running' | 'cancelled' | 'completed' | 'failed';

export interface OperationProgress {
  id: string;
  draftId: string;
  kind: OperationKind;
  state: OperationState;
  stage: string | null;
  progressCurrent: number;
  progressTotal: number | null;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
}

export interface OperationUpdate {
  stage?: string | null;
  progressCurrent?: number;
  progressTotal?: number | null;
}

// ---------------------------------------------------------------------------
// 磁盘型 undo checkpoint（tasks 8.59/8.66）
// ---------------------------------------------------------------------------

export type CheckpointKind = 'pre' | 'post' | 'manual';
export type CheckpointState = 'active' | 'undone';

/** 创建 checkpoint 的输入（快照由仓库从工作区数据库原子捕获）。 */
export interface CheckpointInput {
  kind?: CheckpointKind;
  /** pre/post 成对共享；redo 用 post 恢复。 */
  pairId?: string | null;
  label?: string | null;
  /** 类别模式（facade 侧边状态；纳入快照以便整体 undo/redo）。 */
  modes?: Partial<Record<ImportCategory, 'data' | 'none'>> | null;
}

/** checkpoint 摘要（供 DTO 与撤销栈展示；不含敏感快照值）。 */
export interface CheckpointSummary {
  id: string;
  draftId: string;
  kind: CheckpointKind;
  pairId: string | null;
  label: string | null;
  baseRevision: number;
  state: CheckpointState;
  createdAt: string;
}

/** undo/redo 恢复结果：新修订 + 被恢复快照携带的类别模式（供 facade 同步侧边状态）。 */
export interface CheckpointRestoreResult {
  newRevision: number;
  checkpointId: string;
  kind: CheckpointKind;
  label: string | null;
  modes: Partial<Record<ImportCategory, 'data' | 'none'>>;
}


/** 校验封存输入（design D25 / tasks 8.35：绑定 plan digest、草稿修订、规则版本与目标修订）。 */export interface ValidationSealInput {
  planDigest: string;
  /** 生成 seal 时的草稿修订（仓库自动捕获，绑定被校验内容版本）。 */
  draftRevision?: number;
  templateVersion?: string | null;
  mappingVersion?: string | null;
  validationVersion?: string | null;
  conflictDecisionDigest?: string | null;
  targetSchemaVersion?: number | null;
  targetBusinessRevision?: string | null;
  /** 正式库 database_instance_id（恢复旧库/重建库会变化）。 */
  databaseInstanceId?: string | null;
  /** 正式库 content_generation_id（成功恢复备份后轮换，旧 seal 必失效）。 */
  contentGenerationId?: string | null;
}

export interface ValidationSealRecord extends ValidationSealInput {
  id: string;
  draftId: string;
  /** 生成 seal 时捕获的草稿修订。 */
  draftRevision: number;
  status: 'valid' | 'invalid';
  createdAt: string;
  invalidatedAt: string | null;
}

export interface RecoveryNote {
  draftId: string;
  from: WorkspaceDraftState;
  to: WorkspaceDraftState;
  note: string;
}

export interface RecoveryReport {
  /** 已回到最后稳定草稿修订的运行态草稿。 */
  recovered: RecoveryNote[];
  /** 处于 committing 的草稿：必须先核对正式成功审计再判定结果。 */
  pendingOutcome: string[];
}
