/**
 * 主进程 ↔ 渲染进程 IPC 通道定义（tasks 1.1 工程骨架）。
 * 渲染层无 Node 访问（contextIsolation + preload contextBridge），
 * 所有数据操作经此处定义的通道由主进程执行。
 */

export const IPC_CHANNELS = {
  /** workbench-access：账号状态查询（无密码个人模式：仅供工作台展示自动备份错误等状态）。 */
  accountGetStatus: 'account:get-status',
  /** workbench-access：当前访问会话查询（主进程启动/恢复时已自动建立，无需登录）。 */
  accountGetSession: 'account:get-session',
  /** local-data-persistence：手动备份/恢复（主进程负责文件选择对话框）。 */
  backupManual: 'backup:manual',
  restoreFromBackup: 'backup:restore',
  /**
   * Oracle #10：工作台 v2 有界读取 + 有界 mutation 结果（旧 snapshot 通道已删除，
   * 工作台只经 v2 bounded API 读写；账号/备份恢复/报表/history import 仍为独立通道）。
   */
  workbenchV2Overview: 'workbench:v2:overview',
  workbenchV2ProjectPage: 'workbench:v2:project-page',
  workbenchV2ProjectDetail: 'workbench:v2:project-detail',
  workbenchV2SectionPage: 'workbench:v2:section-page',
  workbenchV2IndependentPage: 'workbench:v2:independent-page',
  workbenchV2LookupPage: 'workbench:v2:lookup-page',
  workbenchV2Mutate: 'workbench:v2:mutate',
  /** ship-to-management：按 requestId 线性推进的独立命令（不重复新建、不重复计工作量）。 */
  shipToCreateRequest: 'ship-to:create-request',
  shipToSubmitRequest: 'ship-to:submit-request',
  reportBuild: 'report:build',
  reportDrillDown: 'report:drill-down',
  reportExport: 'report:export',
  /** 能力清单（工作台占位展示）。 */
  capabilitiesList: 'capabilities:list',
} as const;

/**
 * 历史数据导入向导 IPC 通道（tasks 8.47~8.53）。
 * 全部通道（除 progress 事件外）统一经 requireSessionAndSender 守卫；
 * progress 为 主进程 → 受信窗口 的只读事件，不提供渲染层反向订阅路径之外的通道。
 */
export const IMPORT_WIZARD_CHANNELS = {
  listDrafts: 'import-wizard:list-drafts',
  createDraft: 'import-wizard:create-draft',
  openDraft: 'import-wizard:open-draft',
  deleteDraft: 'import-wizard:delete-draft',
  saveStep: 'import-wizard:save-step',
  downloadTemplate: 'import-wizard:download-template',
  selectFiles: 'import-wizard:select-files',
  pasteIntoCategory: 'import-wizard:paste-into-category',
  classifySheet: 'import-wizard:classify-sheet',
  setCategoryMode: 'import-wizard:set-category-mode',
  updateMapping: 'import-wizard:update-mapping',
  queryRows: 'import-wizard:query-rows',
  patchCells: 'import-wizard:patch-cells',
  addRow: 'import-wizard:add-row',
  deleteRows: 'import-wizard:delete-rows',
  validate: 'import-wizard:validate',
  saveConflictDecision: 'import-wizard:save-conflict-decision',
  cancelOperation: 'import-wizard:cancel-operation',
  summary: 'import-wizard:summary',
  commit: 'import-wizard:commit',
  settleInterrupted: 'import-wizard:settle-interrupted',
  recover: 'import-wizard:recover',
  /** 磁盘型 undo checkpoint（tasks 8.59/8.66）：列表/撤销/重做。 */
  checkpoints: 'import-wizard:checkpoints',
  undo: 'import-wizard:undo',
  redo: 'import-wizard:redo',
  /** 主进程 → 受信窗口 的只读进度事件（progress 经受信窗口事件）。 */
  progressEvent: 'import-wizard:progress',
} as const;

export type ImportWizardChannel = (typeof IMPORT_WIZARD_CHANNELS)[keyof typeof IMPORT_WIZARD_CHANNELS];

// ---------------------------------------------------------------------------
// 历史数据导入向导 DTO（tasks 8.47~8.53）
// 金额/摘要一律为十进制字符串（分整数由主进程精确格式化），禁止 Number 参与金额运算。
// ---------------------------------------------------------------------------

/** 渲染层目标类别（与领域 7 类一一对应；供应商仅作物流参考，不构成类别）。 */
export type ImportWizardCategory =
  | 'projects'
  | 'serviceOrders'
  | 'invoices'
  | 'logistics'
  | 'serialAddresses'
  | 'qrRequests'
  | 'shipToRequests';

export type ImportWizardStepId = 'prepare' | 'projects' | 'orders' | 'finance' | 'serials' | 'requests' | 'review';
export type ImportWizardStepState = 'not_started' | 'processing' | 'passed' | 'warning' | 'blocked';
export type ImportWizardSaveState = 'saving' | 'saved' | 'failed';
export type ImportWizardCategoryMode = 'data' | 'none' | 'undecided';
export type ImportWizardIssueKind = 'error' | 'conflict' | 'warning';
export type ImportWizardSheetStatus = 'recognized' | 'unknown' | 'empty' | 'excluded';
export type ImportWizardMappingState = 'exact' | 'alias' | 'manual' | 'unused';
export type ImportWizardOperationKind = 'reading' | 'normalizing' | 'validating' | 'submitting';

export interface ImportWizardGridColumnDto {
  id: string;
  label: string;
  width?: number;
  frozen?: boolean;
  businessKey?: boolean;
  readOnly?: boolean;
}

export interface ImportWizardDraftDto {
  id: string;
  name: string;
  currentStep: ImportWizardStepId;
  totalRows: number;
  issueCount: number;
  saveState: ImportWizardSaveState;
  updatedAt: string;
}

export interface ImportWizardCategoryDto {
  category: ImportWizardCategory;
  mode: ImportWizardCategoryMode;
  count: number;
  columns: readonly ImportWizardGridColumnDto[];
}

export interface ImportWizardStepDto {
  id: ImportWizardStepId;
  state: ImportWizardStepState;
  errorCount: number;
}

export interface ImportWizardSheetDto {
  id: string;
  fileName: string;
  sheetName: string;
  rowCount: number;
  category: ImportWizardCategory | null;
  status: ImportWizardSheetStatus;
}

export interface ImportWizardMappingDto {
  id: string;
  category: ImportWizardCategory;
  source: string;
  target: string | null;
  targetOptions: readonly { id: string; label: string }[];
  match: ImportWizardMappingState;
  sample: string;
  priority?: number;
  affectedRows?: number;
}

export interface ImportWizardCandidateDto {
  value: string;
  source: string;
}

export interface ImportWizardIssueDto {
  id: string;
  kind: ImportWizardIssueKind;
  category: ImportWizardCategory;
  step: ImportWizardStepId;
  rowIndex: number;
  columnId: string;
  field: string;
  message: string;
  source: string;
  candidates?: readonly ImportWizardCandidateDto[];
}

export interface ImportWizardEccDto {
  ecc: string;
  projects: number;
  serviceOrders: number;
  invoices: number;
  logistics: number;
  sources: number;
}

export interface ImportWizardValidationCategoryDto {
  category: ImportWizardCategory;
  add: number;
  match: number;
  correct: number;
  skip: number;
  warning: number;
  blocked: number;
}

export interface ImportWizardAmountTotalDto {
  label: string;
  value: string;
}

export interface ImportWizardFinalSummaryDto {
  categories: readonly ImportWizardValidationCategoryDto[];
  eccProjects: number;
  independentRecords: number;
  amountTotals: readonly ImportWizardAmountTotalDto[];
  excludedSources: number;
  confirmedBy: string;
  seal: string | null;
  sealValid: boolean;
  validationComplete: boolean;
  warningCount: number;
  blockingCount: number;
}

export interface ImportWizardOperationDto {
  id: string;
  kind: ImportWizardOperationKind;
  label: string;
  processed: number;
  total: number | null;
  cancelable: boolean;
}

export interface ImportWizardWorkspaceDto {
  draft: ImportWizardDraftDto;
  username: string;
  templateVersion: string;
  currentStep: ImportWizardStepId;
  steps: readonly ImportWizardStepDto[];
  categories: readonly ImportWizardCategoryDto[];
  sheets: readonly ImportWizardSheetDto[];
  mappings: readonly ImportWizardMappingDto[];
  issues: readonly ImportWizardIssueDto[];
  ecc: readonly ImportWizardEccDto[];
  summary: ImportWizardFinalSummaryDto | null;
  operation: ImportWizardOperationDto | null;
}

export interface ImportWizardSubmitResultDto {
  status: 'success' | 'failed' | 'unknown';
  title: string;
  message: string;
  importedCounts?: Partial<Record<ImportWizardCategory, number>>;
}

export interface ImportWizardGridIssueDto {
  id: string;
  kind: ImportWizardIssueKind;
  message: string;
  rowIndex: number;
  columnId: string;
  source?: string;
}

export interface ImportWizardGridRowDto {
  id: string;
  values: Record<string, string | null>;
  issues?: readonly ImportWizardGridIssueDto[];
  readOnlyColumns?: readonly string[];
}

export interface ImportWizardGridWindowDto {
  rows: readonly ImportWizardGridRowDto[];
  total: number;
  offset: number;
  limit: number;
}

export interface ImportWizardGridPatchDto {
  rowIndex: number;
  rowId?: string;
  columnId: string;
  value: string;
}

export interface ImportWizardRowWindowRequestDto {
  draftId: string;
  category: ImportWizardCategory;
  offset: number;
  limit: number;
  businessKey?: string | null;
  issueSeverity?: 'error' | 'conflict' | 'warning' | null;
}

export interface ImportWizardProgressEventDto {
  draftId: string;
  operationId: string;
  kind: ImportWizardOperationKind;
  stage: string | null;
  processed: number;
  total: number | null;
  state: 'running' | 'cancelled' | 'completed' | 'failed';
}

export interface ImportWizardRecoverDto {
  recovered: Array<{ draftId: string; from: string; to: string }>;
  pendingOutcome: string[];
}

/** checkpoint 摘要 DTO（不含敏感快照值；供撤销栈展示）。 */
export interface ImportWizardCheckpointDto {
  id: string;
  kind: 'pre' | 'post' | 'manual';
  label: string | null;
  baseRevision: number;
  state: 'active' | 'undone';
  createdAt: string;
}

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** 访问会话的对外形状（不暴露口令与恢复码派生值）。 */
export interface AccountSessionInfo {
  accountId: string;
  username: string;
}

export type ProjectStatus =
  | 'pending_entry'
  | 'pending_execution'
  | 'executing'
  | 'pending_acceptance'
  | 'pending_invoice'
  | 'completed'
  | 'cancelled';

/**
 * 人工主状态调整可选的六种非终止状态。
 * 取消（cancelled）只能通过 cancelProject 专用命令（须提供取消时间与原因），
 * adjustStatus 拒绝 cancelled。
 */
export type AdjustableProjectStatus = Exclude<ProjectStatus, 'cancelled'>;

/** 手动备份/恢复结果（主进程 file dialog；canceled = 用户取消对话框）。 */
export interface BackupManualResult {
  canceled: boolean;
  /** 手动备份文件完整路径（canceled 时为空）。 */
  path?: string;
}

export interface RestoreResultDto {
  canceled: boolean;
  /**
   * 恢复成功（此时主进程已重建数据库，并重新取得/确保本地账号、恢复访问会话；
   * 无密码个人模式下不要求重新登录）。
   */
  restored?: boolean;
}

/** Ship-to 申请线性状态（待提交 → 处理中 → 已完成，不支持退回或取消）。 */
export type ShipToRequestStatus = 'pending_submit' | 'processing' | 'completed';

/** Ship-to 申请 DTO（typed IPC 返回，供表单展示返回/当前状态）。 */
export interface ShipToRequestDto {
  id: string;
  customerName: string;
  newSiteAddress: string;
  /** 创建时可空；进入已完成前必填，补入后全局唯一。 */
  accountId: string | null;
  status: ShipToRequestStatus;
  /** 首次实际提交时间（计一次工作量的归属月份）。 */
  submittedAt: string | null;
  completedAt: string | null;
}

/** Ship-to 申请创建输入：仅客户名称与新址地址（不关联搬迁仪器、不保存地址快照）。 */
export interface ShipToRequestInputDto {
  customerName: string;
  newSiteAddress: string;
}

/** Ship-to 申请操作结果：仅返回受影响申请记录（Oracle #10 起不携带任何工作台快照）。 */
export interface ShipToRequestResultDto {
  request: ShipToRequestDto;
}

export interface WorkbenchProjectRow {
  id: string;
  tempNo: string;
  ecc: string | null;
  customerName: string;
  status: ProjectStatus;
  formallyEntered: boolean;
  preEntryExecution: boolean;
  region: string | null;
  entryAt: string | null;
  reminderAt: string | null;
  reminderNote: string | null;
  reminderDueClass: 'upcoming' | 'today' | 'overdue' | null;
  /**
   * 金额一律为十进制字符串（如 "1234.57"、"0.00"），由主进程以分整数精确格式化；
   * 禁止渲染层用 Number 参与金额计算（计数/百分比除外）。
   */
  finalAmount: string | null;
  invoicedAmount: string;
  contractAmount: string | null;
  counts: { batches: number; instruments: number; activities: number; orders: number; repairs: number };
  nonBlocking: { pendingShipTo: number; qrUnmarked: number; repairs: number };
  updatedAt: string;
}

/** 提醒到期分类（与 workbench-todos classifyReminder 同口径）。 */
export type WorkbenchReminderDueClass = 'upcoming' | 'today' | 'overdue';

// ---------------------------------------------------------------------------
// Oracle #10：工作台 v2 有界读取 / mutation DTO
// - 每个 v2 响应 DTO 均携带 businessRevision（database_metadata 业务修订）；
// - 金额一律十进制字符串（主进程分整数精确格式化，禁止 Number 参与金额运算）；
// - 读取全部为有界分页（keyset id 游标 + total），禁止全量快照与 JS P×C。
// ---------------------------------------------------------------------------

/** v2 分页请求公共字段：默认 50，最大 100。 */
export interface WorkbenchV2PageRequest {
  limit?: number;
  /** 上一页返回的 nextCursor（首页为空）。 */
  cursor?: string | null;
}

/** 项目 keyset 分页请求。sort 默认 updated（稳定 id 游标）。 */
export interface WorkbenchV2ProjectPageRequest extends WorkbenchV2PageRequest {
  status?: ProjectStatus | null;
  region?: string | null;
  /** 客户名称 / 临时编号 / ECC 模糊查询。 */
  query?: string | null;
  /** 提醒过滤：any=有提醒；overdue/today/upcoming=到期分类（与纯函数同口径）。 */
  reminder?: 'any' | 'overdue' | 'today' | 'upcoming' | null;
  sort?: 'updated' | 'created' | 'temp' | 'reminder' | null;
}

export interface WorkbenchV2ProjectPageDto {
  businessRevision: number;
  projects: readonly WorkbenchProjectRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/** 首页/概览 DTO（bounded：提醒预览最多 6 条，其余为聚合指标）。 */
export interface WorkbenchV2OverviewDto {
  businessRevision: number;
  generatedAt: string;
  metrics: {
    totalProjects: number;
    /** 未完成且未取消。 */
    activeProjects: number;
    /** 有当前提醒（时间或备注任一）的项目数。 */
    reminderCount: number;
    reminderOverdue: number;
    reminderToday: number;
    pendingAcceptance: number;
    pendingInvoice: number;
    /** 待掉票金额（已进单项目 最终可确认金额-累计有效掉票 之和），十进制字符串。 */
    pendingAmount: string;
  };
  stages: Array<{ status: ProjectStatus; count: number; averageDays: number; inflow: number; outflow: number }>;
  reminderPreview: Array<{
    projectId: string;
    customerName: string;
    ecc: string | null;
    tempNo: string;
    reminderAt: string | null;
    reminderNote: string | null;
    reminderDueClass: WorkbenchReminderDueClass | null;
  }>;
  reminderTotal: number;
  reminderWindowDays: number;
}

export interface WorkbenchV2ProjectDetailDto {
  businessRevision: number;
  project: WorkbenchProjectRow | null;
  detail: {
    managerApprovalReason: string | null;
    managerApprovalMissing: string | null;
    oldSiteContact: string | null;
    newSiteContact: string | null;
    oldSiteAddress: string | null;
    newSiteAddress: string | null;
    contractStartDate: string | null;
    contractEndDate: string | null;
    planVisitAt: string | null;
    planTransportAt: string | null;
    siteConfirmed: boolean;
    actualInstallDoneAt: string | null;
    acceptanceReport: boolean;
    acceptanceReportDate: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    temporaryInstrumentCount: number | null;
    createdAt: string;
    customerId: string | null;
    contractId: string | null;
  } | null;
}

/** 项目详情当前 tab 的子记录类型。 */
export type WorkbenchV2SectionKind =
  | 'batches'
  | 'instruments'
  | 'activities'
  | 'orders'
  | 'invoices'
  | 'damage_items';

export interface WorkbenchV2SectionPageRequest extends WorkbenchV2PageRequest {
  projectId: string;
  kind: WorkbenchV2SectionKind;
}

export type WorkbenchV2SectionRow =
  | {
      kind: 'batches';
      id: string;
      projectId: string;
      planTransportDate: string | null;
      transportCompany: string | null;
      originalPrice: string | null;
      discountedPrice: string | null;
      startedAt: string | null;
      createdAt: string;
    }
  | {
      kind: 'instruments';
      id: string;
      projectId: string;
      batchId: string | null;
      name: string;
      model: string | null;
      serialNo: string | null;
      ups: boolean;
      qrRequested: boolean;
      destinationShipToId: string | null;
      createdAt: string;
    }
  | {
      kind: 'activities';
      id: string;
      projectId: string;
      visitAt: string | null;
      engineers: string;
      createdAt: string;
    }
  | {
      kind: 'orders';
      id: string;
      projectId: string | null;
      orderType: 'relocation' | 'certification' | 'parts_by_mail' | 'pm';
      serviceOrderNo: string | null;
      orderedAt: string;
      engineer: string;
      customerName: string;
      note: string | null;
      createdAt: string;
    }
  | {
      kind: 'invoices';
      id: string;
      projectId: string;
      amount: string;
      invoicedAt: string;
      active: boolean;
      revokedAt: string | null;
      revokeReason: string | null;
      lastModifiedAt: string;
      createdAt: string;
    }
  | {
      kind: 'damage_items';
      id: string;
      projectId: string;
      instrumentId: string;
      instrumentName: string;
      serialNo: string | null;
      damageReason: string | null;
      issueStatus: string;
      partNumber: string;
      partQuantity: number;
      partAmount: string;
      partCurrency: string | null;
      partStatus: string | null;
      registeredAt: string;
      repairNote: string | null;
      createdAt: string;
    };

export interface WorkbenchV2SectionPageDto {
  businessRevision: number;
  kind: WorkbenchV2SectionKind;
  projectId: string;
  rows: readonly WorkbenchV2SectionRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/** 独立模块（序列号地址更新 / 二维码申请）记录类型。 */
export type WorkbenchV2IndependentKind = 'serial_address' | 'qr_request';

export interface WorkbenchV2IndependentPageRequest extends WorkbenchV2PageRequest {
  kind: WorkbenchV2IndependentKind;
  query?: string | null;
}

export type WorkbenchV2IndependentRow =
  | {
      kind: 'serial_address';
      id: string;
      instrumentId: string;
      instrumentName: string;
      serialNo: string;
      customerName: string;
      newSiteAddress: string;
      accountId: string;
      updatedAt: string;
      createdAt: string;
    }
  | {
      kind: 'qr_request';
      id: string;
      applicant: string;
      requestedAt: string;
      types: readonly string[];
      workload: number;
      createdAt: string;
    };

export interface WorkbenchV2IndependentPageDto {
  businessRevision: number;
  kind: WorkbenchV2IndependentKind;
  rows: readonly WorkbenchV2IndependentRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/** lookup 分页（Ship-to 申请按客户 / 客户按名称）。 */
export type WorkbenchV2LookupKind = 'ship_to_requests' | 'customers';

export interface WorkbenchV2LookupPageRequest extends WorkbenchV2PageRequest {
  kind: WorkbenchV2LookupKind;
  query?: string | null;
}

export type WorkbenchV2LookupRow =
  | {
      kind: 'ship_to_requests';
      id: string;
      customerName: string;
      newSiteAddress: string;
      accountId: string | null;
      status: ShipToRequestStatus;
      submittedAt: string | null;
      completedAt: string | null;
      createdAt: string;
    }
  | {
      kind: 'customers';
      id: string;
      name: string;
      createdAt: string;
    };

export interface WorkbenchV2LookupPageDto {
  businessRevision: number;
  kind: WorkbenchV2LookupKind;
  rows: readonly WorkbenchV2LookupRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/**
 * v2 普通写动作（复用现有写逻辑，绝不调用 snapshot；返回有界 mutation 结果）。
 * 覆盖：新建项目 / submitAction / 提醒 / 状态 / 取消 / Ship-to complete / 掉票编辑与撤销。
 */
export type WorkbenchV2MutationOp =
  | 'create_project'
  | 'submit_action'
  | 'set_reminder'
  | 'clear_reminder'
  | 'adjust_status'
  | 'cancel_project'
  | 'ship_to_complete'
  | 'invoice_edit'
  | 'invoice_revoke';

/** 写后失效标签：告知新 UI 哪些有界缓存需重读。 */
export type WorkbenchV2InvalidateTag =
  | 'overview'
  | 'projects'
  | `project:${string}`
  | `sections:${string}`
  | 'independent:serial_address'
  | 'independent:qr_request'
  | 'lookup:ship_to_requests'
  | 'lookup:customers';

export interface WorkbenchV2MutationRequest {
  op: WorkbenchV2MutationOp;
  /** submit_action / adjust_status / cancel_project / set_reminder 等需要。 */
  projectId?: string;
  /** create_project。 */
  payload?: ProjectWizardPayload;
  /** submit_action。 */
  action?: WorkbenchActionPayload;
  /** set_reminder。 */
  reminderAt?: string | null;
  reminderNote?: string | null;
  /** adjust_status（拒绝 cancelled，取消走 cancel_project）。 */
  status?: AdjustableProjectStatus;
  /** cancel_project。 */
  time?: string;
  reason?: string;
  /** ship_to_complete。 */
  requestId?: string;
  accountId?: string;
  /** invoice_edit / invoice_revoke。 */
  invoiceId?: string;
  invoicedAt?: string;
  amount?: string;
}

export interface WorkbenchV2MutationResult {
  businessRevision: number;
  invalidated: readonly WorkbenchV2InvalidateTag[];
  changed: {
    projectId?: string;
    requestId?: string;
    invoiceId?: string;
    status?: string;
    accountId?: string | null;
    created?: boolean;
  } | null;
}

export interface ProjectWizardPayload {
  intent: 'draft' | 'formal' | 'pre_entry_execution';
  customerName: string;
  ecc?: string;
  entryAt?: string;
  region: string;
  oldSiteContact?: string;
  newSiteContact?: string;
  contractStartDate: string;
  contractEndDate: string;
  oldSiteAddress: string;
  newSiteAddress: string;
  instrumentName: string;
  model?: string;
  ups: boolean;
  /**
   * 合同 USD 含税金额：十进制字符串（如 "100000.50"），由主进程按 Money 精确解析为分。
   * 渲染层禁止 Number(value)*100 与浮点金额计算；空字符串 = 未录入。
   */
  contractAmount?: string;
  /** 最终可确认金额（USD）：十进制字符串。 */
  finalAmount?: string;
  planVisitAt?: string;
  planTransportAt?: string;
  siteConfirmed: boolean;
  actualInstallDoneAt?: string;
  serviceOrderNo?: string;
  engineers?: string;
  serviceOrderNote?: string;
  approvalReason?: string;
  missingItems?: string;
}

export type WorkbenchActionType =
  | 'batch' | 'instrument' | 'visit' | 'order' | 'logistics'
  | 'acceptance' | 'invoice' | 'ship_to' | 'damage' | 'core'
  | 'serial_address' | 'qr_request';

export interface WorkbenchActionPayload {
  type: WorkbenchActionType;
  projectId?: string;
  /**
   * 业务动作字段值。金额字段（originalPrice/discountedPrice/budgetPrice/dealPrice/
   * logisticsCost/amount/contractAmount/finalAmount/partAmount）为十进制字符串，
   * 由主进程按 Money 精确解析；渲染层禁止 Number(value)*100 与浮点金额计算。
   */
  values: Record<string, string | number | boolean | string[] | null>;
}

export interface ReportFilterDto {
  monthFrom: string;
  monthTo: string;
  region?: string | null;
  orderType?: 'relocation' | 'certification' | 'parts_by_mail' | 'pm' | null;
  transportCompany?: string | null;
  engineer?: string | null;
}

export interface ReportDto {
  range: { from: string; to: string };
  filters: Record<string, string | null>;
  generatedAt: string;
  sections: Array<{ key: string; label: string; rows: Array<Record<string, string | number | boolean | null>> }>;
}

/** preload 暴露给渲染层的 API 形状（Oracle #10：工作台只走 v2 有界读取/mutation，无 snapshot）。 */
export interface WorkbenchApi {
  getCapabilities(): Promise<string[]>;
  getAccountStatus(): Promise<{ initialized: boolean; autoBackupError: string | null }>;
  getSession(): Promise<AccountSessionInfo | null>;
  // ---- Oracle #10：工作台 v2 有界读取 / mutation（旧 snapshot API 已删除，仅此入口） ----
  v2Overview(): Promise<WorkbenchV2OverviewDto>;
  v2ProjectPage(request: WorkbenchV2ProjectPageRequest): Promise<WorkbenchV2ProjectPageDto>;
  v2ProjectDetail(projectId: string): Promise<WorkbenchV2ProjectDetailDto>;
  v2SectionPage(request: WorkbenchV2SectionPageRequest): Promise<WorkbenchV2SectionPageDto>;
  v2IndependentPage(request: WorkbenchV2IndependentPageRequest): Promise<WorkbenchV2IndependentPageDto>;
  v2LookupPage(request: WorkbenchV2LookupPageRequest): Promise<WorkbenchV2LookupPageDto>;
  /** 有界 mutation：复用现有写逻辑，返回 businessRevision + invalidate tags（不含快照）。 */
  v2Mutate(request: WorkbenchV2MutationRequest): Promise<WorkbenchV2MutationResult>;
  /**
   * 创建 Ship-to 申请：同客户同新址地址已有申请（任一状态）时返回既有记录，不自动 submit、
   * 不重复创建；首次实际提交才计一次工作量。
   */
  createShipToRequest(input: ShipToRequestInputDto): Promise<ShipToRequestResultDto>;
  /** 按 requestId 推进：待提交 → 处理中（记录首次提交时间，计一次工作量）。 */
  submitShipToRequest(requestId: string): Promise<ShipToRequestResultDto>;
  buildReport(filter: ReportFilterDto): Promise<ReportDto>;
  drillDown(metricKey: string, filter: ReportFilterDto): Promise<Array<Record<string, string | number | boolean | null>>>;
  exportReport(format: 'xlsx' | 'png' | 'pdf', filter: ReportFilterDto): Promise<{ saved: boolean; path?: string }>;
  /** 手动备份：主进程弹出目录选择框并生成 manual-*.db。 */
  backupManual(): Promise<BackupManualResult>;
  /** 恢复备份：主进程弹出文件选择框；成功时重建数据库并重新取得/确保本地账号、恢复会话。 */
  restoreFromBackup(): Promise<RestoreResultDto>;
  /** 历史数据导入向导：最小化 IPC 语义 API（主进程编排工作区/worker/校验/封存/提交）。 */
  importWizard: ImportWizardApi;
}

/**
 * 历史数据导入向导 IPC API（tasks 8.48：preload 只暴露最小语义，无路径/fs/db/worker）。
 * dialog 只返回展示元数据/结果，不返回可复用的任意本地路径；金额一律十进制字符串。
 */
export interface ImportWizardApi {
  listDrafts(): Promise<readonly ImportWizardDraftDto[]>;
  createDraft(): Promise<ImportWizardWorkspaceDto>;
  openDraft(draftId: string): Promise<ImportWizardWorkspaceDto>;
  deleteDraft(draftId: string): Promise<void>;
  /** 保存当前步骤并返回刷新后工作区（步骤在会话/工作区持久化）。 */
  saveStep(draftId: string, step: ImportWizardStepId): Promise<ImportWizardWorkspaceDto>;
  /** 生成当前版本空白模板并弹出保存对话框（不返回路径）。 */
  downloadTemplate(): Promise<{ saved: boolean; version: string }>;
  /** 弹出文件选择框并立即启动 worker 读取/规范化（返回展示元数据，不返回路径）。 */
  selectFiles(draftId: string): Promise<ImportWizardWorkspaceDto>;
  /** 主进程读取剪贴板纯文本并在 worker 中规范化粘贴到指定类别。 */
  pasteIntoCategory(draftId: string, category: ImportWizardCategory, headerConfirmed: boolean): Promise<ImportWizardWorkspaceDto>;
  classifySheet(draftId: string, sheetId: string, category: ImportWizardCategory | 'excluded'): Promise<ImportWizardWorkspaceDto>;
  setCategoryMode(draftId: string, category: ImportWizardCategory, mode: 'data' | 'none'): Promise<ImportWizardWorkspaceDto>;
  updateMapping(draftId: string, mappingId: string, target: string | null): Promise<ImportWizardWorkspaceDto>;
  /** 网格窗口查询（renderer 不持有整份大草稿）。 */
  queryRows(request: ImportWizardRowWindowRequestDto): Promise<ImportWizardGridWindowDto>;
  patchCells(draftId: string, category: ImportWizardCategory, patches: readonly ImportWizardGridPatchDto[]): Promise<ImportWizardWorkspaceDto>;
  addRow(draftId: string, category: ImportWizardCategory): Promise<ImportWizardWorkspaceDto>;
  deleteRows(draftId: string, category: ImportWizardCategory, rowIds: readonly string[]): Promise<ImportWizardWorkspaceDto>;
  /** 完整校验（可取消）；通过后生成 validation seal。 */
  validate(draftId: string): Promise<ImportWizardWorkspaceDto>;
  /** 保存冲突决定并把选定值写回单元格（局部重校验）。 */
  saveConflictDecision(draftId: string, issueId: string, value: string): Promise<ImportWizardWorkspaceDto>;
  cancelOperation(draftId: string, operationId: string): Promise<ImportWizardWorkspaceDto>;
  summary(draftId: string): Promise<ImportWizardWorkspaceDto>;
  /** 提交封存计划（operation 去重；提交不可取消为部分业务状态）。 */
  commit(draftId: string, seal: string): Promise<ImportWizardSubmitResultDto>;
  /** committing 中断后的结果核对（成功审计 + 完整事务同时存在才判成功）。 */
  settleInterrupted(draftId: string): Promise<ImportWizardSubmitResultDto>;
  /** 启动/恢复时的工作区运行态恢复。 */
  recover(): Promise<ImportWizardRecoverDto>;
  /** 列出磁盘型 checkpoint 摘要（undo 栈；不含敏感值）。 */
  checkpoints(draftId: string): Promise<readonly ImportWizardCheckpointDto[]>;
  /** 撤销到最近一个 pre checkpoint（新修订 + seal 失效；无可撤销返回 null）。 */
  undo(draftId: string): Promise<ImportWizardWorkspaceDto | null>;
  /** 重做成对 post checkpoint（新修订 + seal 失效；无可重做返回 null）。 */
  redo(draftId: string): Promise<ImportWizardWorkspaceDto | null>;
  /** 订阅主进程进度事件；返回取消订阅函数。 */
  onProgress(callback: (event: ImportWizardProgressEventDto) => void): () => void;
}
