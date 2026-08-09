/**
 * service-order-recording 能力（四类开单记录）。
 *
 * - 开单区分搬迁、认证、单寄备件、PM 四类业务；搬迁开单关联搬迁项目，
 *   认证/单寄备件/PM 开单独立保存、不进入搬迁项目生命周期。
 * - 非空服务单号全局唯一、四类业务共用唯一空间（TBD-21），
 *   唯一性由 SQLite 部分唯一索引（WHERE service_order_no IS NOT NULL）落实。
 * - 开单工作量按唯一服务单号计数（规则见 tasks 7.4）。
 * - 开单记录为手工录入事实，携带账号归属快照（design D12）。
 * - 业务时间字段（开单日期）为 yyyy-mm-dd；createdAt/updatedAt 仍为带偏移 ISO。
 */
import type { BusinessDate } from '../../core/time';

export const ORDER_TYPES = ['relocation', 'certification', 'parts_by_mail', 'pm'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export interface ServiceOrder {
  id: string;
  orderType: OrderType;
  /** 非空服务单号全局唯一（四类共用唯一空间）。 */
  serviceOrderNo: string | null;
  /** 开单日期（业务日期；未填默认当天，TBD-22）。 */
  orderedAt: BusinessDate;
  /** 参与工程师（必填）。 */
  engineer: string;
  /** 客户单位（必填）。 */
  customerName: string;
  /** 搬迁开单关联的搬迁项目（内部 ID）；其余三类为空。 */
  projectId: string | null;
  /** 备注可选。 */
  note: string | null;
  /** 账号归属快照（负责人手工录入/向导自动创建）。 */
  accountId: string | null;
  usernameSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}
