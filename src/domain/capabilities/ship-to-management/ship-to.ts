/**
 * ship-to-management 能力（Ship-to 不可变主数据与线性申请状态）。
 *
 * - Ship-to 创建后不可修改，唯一编号沿用现有业务字段名 Account ID（非客户主账号）。
 * - Ship-to 申请只记录客户名称与新址地址，不关联搬迁仪器、不保存结构化地址快照；
 *   状态线性流转：待提交 → 处理中 → 已完成，不支持退回或取消（TBD-04）。
 * - Account ID 完成前必填，补入后全局唯一并创建/对应不可变 Ship-to。
 * - 首次实际提交计一次工作量，待提交草稿不计，后续状态更新不重复计数。
 * - 批次与项目仅汇总展示所涉 Ship-to，不维护批次级/项目级唯一地址；
 *   申请未完成仅作独立提醒、不阻塞搬迁项目任何状态流转。
 * 规则实现见 tasks 4.1~4.2。
 */
export const SHIP_TO_REQUEST_STATUSES = [
  'pending_submit', // 待提交
  'processing', // 处理中
  'completed', // 已完成
] as const;
export type ShipToRequestStatus = (typeof SHIP_TO_REQUEST_STATUSES)[number];

/** 不可变 Ship-to 主数据。 */
export interface ShipTo {
  id: string;
  /** 唯一编号（沿用现有业务字段名 Account ID）。 */
  accountId: string;
  customerName: string;
  newSiteAddress: string;
  createdAt: string;
}

/** Ship-to 申请（线性状态，不支持退回或取消）。 */
export interface ShipToRequest {
  id: string;
  customerName: string;
  newSiteAddress: string;
  /** 创建时可为空；进入已完成前必填，补入后全局唯一。 */
  accountId: string | null;
  status: ShipToRequestStatus;
  /** 首次实际提交时间（计一次工作量，按该月份归属）。 */
  submittedAt: string | null;
  completedAt: string | null;
  /** 操作账号归属快照（手工创建/维护申请时记录）。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ship-to 申请创建输入（4.2）：仅客户名称与新址地址。 */
export interface ShipToRequestInput {
  customerName: string;
  newSiteAddress: string;
}

/** Ship-to 申请工作量（按首次实际提交月份归属）。 */
export interface ShipToRequestWorkloadRow {
  /** 首次实际提交月份（yyyy-mm）。 */
  month: string;
  count: number;
}
