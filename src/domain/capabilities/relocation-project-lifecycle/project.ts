import { newInternalId, newTempNumber } from '../../core/ids';
import type { BusinessDate } from '../../core/time';
import type { ProjectStatusOrCancelled } from './states';

/**
 * 搬迁项目聚合根（tasks 1.7 / 2.x / design D3）。
 *
 * 基础模型：稳定内部 ID + 系统临时编号、客户关联、合同可空（待进单阶段，
 * 系统不强制创建合同草稿，TBD-01）、进单时间、区域、旧址/新址联系人、项目默认
 * 旧址/新址、合同起止日期、未进单先执行标签、取消信息、执行准备与项目提醒字段。
 *
 * 2.x 扩展：scopeConfirmed（搬迁范围明确）、managerApproval 字段（未进单先执行
 * 的经理批复、原因与缺失项）、isFormallyEntered 判定事实（未进单/已进单视觉区分）。
 */
export interface Project {
  /** 稳定内部 ID（全局唯一、不复用）。 */
  id: string;
  /** 系统临时编号（待进单阶段使用，正式进单后保留）。 */
  tempNo: string;
  status: ProjectStatusOrCancelled;
  /** 未进单先执行标签（独立标签，与主状态并存）。 */
  preEntryExecution: boolean;
  /** 搬迁范围是否明确（向导搬迁范围步骤至少一台仪器后标记；正式进单前必填）。 */
  scopeConfirmed: boolean;
  /** 未进单先执行：经理批复原因与缺失项（TBD-08）。 */
  managerApprovalReason: string | null;
  managerApprovalMissing: string | null;
  /** 关联客户（内部 ID）；待进单阶段可为空。 */
  customerId: string | null;
  /** 关联合同（内部 ID）；待进单阶段合同可空，正式进单前必须补齐。 */
  contractId: string | null;
  /** 进单日期（业务日期）；待进单可空，正式进单必填默认当前可补录。 */
  entryAt: BusinessDate | null;
  /** 区域（手工文本，trim 后精确分组）。 */
  region: string | null;
  oldSiteContact: string | null;
  newSiteContact: string | null;
  /** 项目默认旧址地址。 */
  oldSiteAddress: string | null;
  /** 项目默认新址地址（仅作默认计划，实际关联以序列号地址更新事实为准）。 */
  newSiteAddress: string | null;
  contractStartDate: BusinessDate | null;
  contractEndDate: BusinessDate | null;
  /** 执行准备占位：计划上门日期（不触发状态流转）。 */
  planVisitAt: BusinessDate | null;
  /** 执行准备占位：计划运输日期（不触发状态流转）。 */
  planTransportAt: BusinessDate | null;
  /** 执行准备占位：场地确认状态（不触发状态流转）。 */
  siteConfirmed: boolean;
  /** 执行准备占位：实际装机完成日期（录入后由 lifecycle 自动置为待验收）。 */
  actualInstallDoneAt: BusinessDate | null;
  /** 验收报告标记与报告形成日期（自动触发规则归 lifecycle）。 */
  acceptanceReport: boolean;
  acceptanceReportDate: BusinessDate | null;
  /** 取消信息（取消日期与原因，TBD-10）。 */
  cancelledAt: BusinessDate | null;
  cancelReason: string | null;
  /** 项目提醒字段（当前提醒日期与备注，手工维护，见 workbench-todos 第 6 组）。 */
  reminderAt: BusinessDate | null;
  reminderNote: string | null;
  /** 最近一次提醒创建/编辑/清除操作绑定的登录账号内部 ID（手工事实归属，D12）。 */
  reminderAccountId: string | null;
  /** 最近一次提醒操作绑定录入时用户名快照（历史统计不因改名变化）。 */
  reminderUsernameSnapshot: string | null;
  /** 暂定仪器数量（不生成虚拟仪器，见 3.1）。 */
  temporaryInstrumentCount: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 已进单判定事实（TBD-08 未进单/已进单视觉区分）。
 * 正式进单后进单时间必填（relocation-project-lifecycle 正式进单规则），
 * 故以 entryAt 是否已记录作为是否完成正式进单的判定依据。
 */
export function isFormallyEntered(project: Project): boolean {
  return project.entryAt !== null;
}

export interface CreateProjectInput {
  id?: string;
  tempNo?: string;
  status?: ProjectStatusOrCancelled;
  createdAt?: string;
  updatedAt?: string;
  customerId?: string | null;
  contractId?: string | null;
}

export function createPendingProject(input: CreateProjectInput = {}): Project {
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: input.id ?? newInternalId(),
    tempNo: input.tempNo ?? newTempNumber(),
    status: input.status ?? 'pending_entry',
    preEntryExecution: false,
    scopeConfirmed: false,
    managerApprovalReason: null,
    managerApprovalMissing: null,
    customerId: input.customerId ?? null,
    contractId: input.contractId ?? null,
    entryAt: null,
    region: null,
    oldSiteContact: null,
    newSiteContact: null,
    oldSiteAddress: null,
    newSiteAddress: null,
    contractStartDate: null,
    contractEndDate: null,
    planVisitAt: null,
    planTransportAt: null,
    siteConfirmed: false,
    actualInstallDoneAt: null,
    acceptanceReport: false,
    acceptanceReportDate: null,
    cancelledAt: null,
    cancelReason: null,
    reminderAt: null,
    reminderNote: null,
    reminderAccountId: null,
    reminderUsernameSnapshot: null,
    temporaryInstrumentCount: null,
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
  };
}
