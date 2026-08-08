/**
 * serial-address-update 能力（序列号地址更新事实）。
 *
 * 搬迁仪器实际迁往新址时逐台登记一条更新事实：客户名称、新址地址、序列号、
 * Account ID 与更新时间（更新时间必填、默认当前并可补录历史）。
 * 更新事实不创建、修改或删除不可变 Ship-to 主数据；
 * 项目级新址仅作默认计划，仪器实际关联新址以最近一条更新事实为准；
 * 未登记更新事实的仪器不视为已关联新址。
 * 手工登记绑定当前登录账号归属快照。规则实现见 tasks 4.3。
 */
export interface SerialAddressUpdate {
  id: string;
  instrumentId: string;
  customerName: string;
  newSiteAddress: string;
  serialNo: string;
  /** Account ID（对应不可变 Ship-to，本模块不创建/修改/删除 Ship-to）。 */
  accountId: string;
  /** 更新时间（业务时间，必填；默认当前时间，可补录历史）。 */
  updatedAt: string;
  /** 操作账号归属快照。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  createdAt: string;
}

/** 序列号地址更新登记输入（4.3）。 */
export interface SerialAddressUpdateInput {
  customerName: string;
  newSiteAddress: string;
  /** 非空且与登记的搬迁仪器序列号一致。 */
  serialNo: string;
  /** Account ID（非空）。 */
  accountId: string;
  /** 更新时间（必填，缺省默认当前时间，可补录历史）。 */
  updatedAt?: string;
}

/** 更新事实筛选（4.3）：按客户/新址地址/序列号/Account ID/更新时间。 */
export interface SerialAddressUpdateFilter {
  customerName?: string;
  newSiteAddress?: string;
  serialNo?: string;
  accountId?: string;
  /** 更新月份（yyyy-mm）或具体日期（yyyy-mm-dd）。 */
  updatedAt?: string;
}

/** 按更新时间所属月份计数。 */
export interface SerialAddressUpdateCountRow {
  month: string;
  count: number;
}
