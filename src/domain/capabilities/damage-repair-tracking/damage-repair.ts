/**
 * damage-repair-tracking 能力（损坏/维修事项与单备件）。
 *
 * 一台搬迁仪器的一次运输损坏建立一条事项，一个事项仅含一个备件；
 * 事项字段：损坏原因、处理状态、备件号/数量/金额/币种、备件申请时间、
 * 备件处理状态（待提交/处理中/已到件/已使用）与维修过程备注。
 * 仅「已使用」备件计入维修费用与合同占比（TBD-13）。
 * 合同 USD 含税金额为空或 0 时禁止开始/完成维修与标记备件「已使用」（TBD-15）。
 * 维修上门活动 × 损坏/维修事项为多对多关联（TBD-24，本能力唯一所有）。
 * 手工记录绑定当前登录账号归属快照。规则实现见 tasks 4.4~4.8。
 * 业务时间字段（备件申请/事项登记日期）为 yyyy-mm-dd；createdAt/updatedAt 仍为带偏移 ISO。
 */
import type { BusinessDate } from '../../core/time';

export const DAMAGE_ITEM_STATUSES = [
  'untreated', // 未处理
  'processing', // 处理中
  'repaired', // 已修复
  'closed_unrepaired', // 已关闭未修复（必须记录原因）
] as const;
export type DamageItemStatus = (typeof DAMAGE_ITEM_STATUSES)[number];

export const PART_STATUSES = [
  'pending_submit', // 待提交
  'processing', // 处理中
  'arrived', // 已到件
  'used', // 已使用
] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

/** 备件币种仅限 USD 与 RMB（RMB 按固定汇率 1 USD = 7.2 RMB 折算）。 */
export const PART_CURRENCIES = ['USD', 'RMB'] as const;
export type PartCurrency = (typeof PART_CURRENCIES)[number];

export interface DamageRepairItem {
  id: string;
  instrumentId: string;
  projectId: string;
  /** 损坏原因。 */
  damageReason: string | null;
  issueStatus: DamageItemStatus;
  /** 关闭未修复原因（选择已关闭未修复时必填）。 */
  closeReason: string | null;
  partNumber: string;
  /** 备件数量与金额必须有值且 > 0。 */
  partQuantity: number;
  partAmountCents: bigint;
  partCurrency: PartCurrency;
  /** 备件申请日期（业务日期；直接记录在事项内，不引入独立备件申请对象）。 */
  partRequestedAt: BusinessDate | null;
  partStatus: PartStatus | null;
  /** 维修过程备注（记录上门维修等处理过程）。 */
  repairNote: string | null;
  /** 事项登记日期（业务日期，统计按该月份归属）。 */
  registeredAt: BusinessDate;
  /** 操作账号归属快照。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 损坏/维修事项登记输入（4.4/4.6）。 */
export interface RegisterDamageItemInput {
  damageReason?: string | null;
  partNumber: string;
  /** 备件数量与金额必须有值且 > 0。 */
  partQuantity: number;
  partAmountCents: bigint;
  partCurrency: PartCurrency;
  partRequestedAt?: BusinessDate | null;
  partStatus?: PartStatus | null;
  repairNote?: string | null;
  /** 事项处理状态（缺省未处理）；直接登记为处理中/已修复/已关闭未修复须合同金额为正数（TBD-15）。 */
  issueStatus?: DamageItemStatus | null;
  /** 关闭未修复原因（事项状态为已关闭未修复时必填）。 */
  closeReason?: string | null;
  /** 事项登记日期（缺省当天）。 */
  registeredAt?: BusinessDate;
}

/** 备件信息更新输入（4.5）。 */
export interface PartInfoInput {
  partNumber?: string;
  partQuantity?: number;
  partAmountCents?: bigint;
  partCurrency?: PartCurrency;
  partRequestedAt?: BusinessDate | null;
  repairNote?: string | null;
}

/** 维修上门活动 × 事项关联（TBD-24，仅引用，不建立维修上门子记录）。 */
export interface ActivityDamageLink {
  id: string;
  activityId: string;
  damageItemId: string;
  operatorAccountId: string | null;
  operatorUsername: string | null;
  createdAt: string;
}
