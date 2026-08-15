/**
 * relocation-execution 能力（搬迁执行：批次、仪器、上门活动与物流）。
 *
 * 完整业务规则见 tasks 3.x：暂定数量与占位仪器、搬迁仪器字段（名称、型号、
 * UPS、二维码是否申请）、批次归属与改批历史、上门活动的工作事实与工作类型
 * （拆机状态与开始/完成时间显式记录）、仪器拆装进度推导、物流报价与实际物流
 * 费用（物流费用申请/登记时间）。
 *
 * 业务时间字段一律为 yyyy-mm-dd 业务日期（用户录入/推导），审计/技术时间
 * （createdAt/updatedAt 等）仍为带偏移 ISO。
 *
 * 手工事实统一携带账号归属快照（account_id + username_snapshot，design D12 /
 * tasks 3.x「所有手工事实绑定当前 account attribution」），历史统计按快照归属。
 */

import type { BusinessDate } from '../../core/time';

/** 搬迁批次（tasks 3.3/3.6）。 */
export interface Batch {
  id: string;
  projectId: string;
  /** 计划运输日期（业务日期 yyyy-mm-dd）。 */
  planTransportDate: BusinessDate | null;
  transportCompany: string | null;
  /**
   * 合同预算价（分整数；有值必须 > 0）。
   * 物理字段名 originalPriceCents 沿用历史命名（旧「原价」口径），业务术语为「合同预算价」。
   */
  originalPriceCents: bigint | null;
  /**
   * 物流成交价（分整数；有值必须 >= 0，允许 0；即最终实际费用）。
   * 物理字段名 discountedPriceCents 沿用历史命名（旧「折后价」口径），业务术语为「物流成交价」。
   */
  discountedPriceCents: bigint | null;
  /** 开始运输日期（业务日期；null = 未开始运输）。 */
  startedAt: BusinessDate | null;
  /** 账号归属快照（负责人手工录入报价/批次时记录）。 */
  accountId: string | null;
  usernameSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 改批历史（运输开始前改批，TBD-03）。 */
export interface BatchChangeHistory {
  id: string;
  instrumentId: string;
  fromBatchId: string | null;
  toBatchId: string | null;
  /** 变更日期（业务日期）。 */
  changedAt: BusinessDate;
  /** 登录账号归属（内部 ID + 用户名快照，必填）。 */
  accountId: string | null;
  usernameSnapshot: string | null;
}

/** 搬迁仪器（tasks 3.1/3.2）。 */
export interface Instrument {
  id: string;
  projectId: string;
  batchId: string | null;
  /** 仪器名称（必填）。 */
  name: string;
  /** 型号（选填）。 */
  model: string | null;
  /** 厂商（选填；批量导入列之一）。 */
  manufacturer: string | null;
  /** 服务级别（选填；批量导入列之一）。 */
  serviceLevel: string | null;
  /** 非空序列号在同一合同/其唯一搬迁项目内唯一、跨合同可重复（TBD-02）。 */
  serialNo: string | null;
  /** UPS 是/否。 */
  ups: boolean;
  /** "二维码是否申请"手工是/否字段（不保存 URL、不由申请记录推导）。 */
  qrRequested: boolean;
  /** 目的 Ship-to（内部 ID，引用 ship-to-management 主数据）。 */
  destinationShipToId: string | null;
  /** 账号归属快照。 */
  accountId: string | null;
  usernameSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 工作类型（仅限四类）。 */
export const WORK_TYPES = ['teardown', 'install', 'repair', 'other'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** 工作事实两态持久化（不存在事实 = 未开始；进行中记录开始时间；完成记录完成时间）。 */
export const WORK_FACT_STATUSES = ['in_progress', 'done'] as const;
export type WorkFactStatus = (typeof WORK_FACT_STATUSES)[number];

/** 上门活动（tasks 3.4）。 */
export interface Activity {
  id: string;
  projectId: string;
  /** 到访日期（业务日期）。 */
  visitAt: BusinessDate | null;
  /** 账号归属快照。 */
  accountId: string | null;
  usernameSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 参与工程师（同一活动可多名工程师参与）。 */
export interface ActivityEngineer {
  id: string;
  activityId: string;
  engineer: string;
}

/** 活动 × 仪器 × 工作类型事实行（TBD-05）。 */
export interface WorkFact {
  id: string;
  activityId: string;
  instrumentId: string;
  workType: WorkType;
  status: WorkFactStatus;
  /** 开始日期（业务日期；创建为进行中时记录）。 */
  startedAt: BusinessDate;
  /** 完成日期（业务日期；转为已完成时记录）。 */
  completedAt: BusinessDate | null;
  /** 账号归属快照。 */
  accountId: string | null;
  usernameSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 拆装进度推导结果（tasks 3.5）：进度不可手工维护，
 * 由工作事实推导（不存在事实=未开始、存在已完成事实=已完成、仅进行中=进行中）。
 */
export interface InstrumentProgress {
  teardown: 'not_started' | 'in_progress' | 'done';
  install: 'not_started' | 'in_progress' | 'done';
  /** 拆机开始日期（业务日期；存在拆机事实时）。 */
  teardownStartedAt: BusinessDate | null;
  /** 拆机完成日期（业务日期；拆机已完成时）。 */
  teardownCompletedAt: BusinessDate | null;
  /** 装机开始日期（业务日期；存在装机事实时）。 */
  installStartedAt: BusinessDate | null;
  /** 装机完成日期（业务日期；装机已完成时）。 */
  installCompletedAt: BusinessDate | null;
}

/**
 * 实际物流费用记录（tasks 3.7）：每批次仅一笔；登记时间/三金额均可选（部分费用）。
 * - appliedAt：物流费用申请（登记）日期（业务日期；可空，可后补/修改/清空）；
 * - budgetPriceCents：合同预算价（分整数；有值必须 > 0）；
 * - dealPriceCents：物流成交价（分整数；有值允许 0，即最终实际费用）；
 * - logisticsCostCents：历史兼容旧列，现行业务与 dealPriceCents 恒同值（仅历史导入保留）。
 */
export interface LogisticsFee {
  id: string;
  batchId: string;
  /** 物流费用申请（登记）日期（业务日期；部分费用时可空）。 */
  appliedAt: BusinessDate | null;
  /** 合同预算价（分整数；部分费用时可空；有值必须 > 0）。 */
  budgetPriceCents: bigint | null;
  /** 物流成交价（分整数；部分费用时可空；有值允许 0；即最终实际费用）。 */
  dealPriceCents: bigint | null;
  /**
   * 历史兼容旧列（旧「实际物流费用」口径）：现行业务与 dealPriceCents 恒同值
   * （物流成交价即最终实际费用），仅历史数据/导入保留，不新增业务语义。
   */
  logisticsCostCents: bigint | null;
  /** 账号归属快照。 */
  accountId: string | null;
  usernameSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 搬迁仪器登记输入（3.1/3.2）。 */
export interface RegisterInstrumentInput {
  /** 仪器名称（必填）。 */
  name: string;
  /** 型号（选填）。 */
  model?: string | null;
  /** 厂商（选填）。 */
  manufacturer?: string | null;
  /** 服务级别（选填）。 */
  serviceLevel?: string | null;
  /** 非空序列号在同一项目内唯一；空序列号 = 占位仪器。 */
  serialNo?: string | null;
  /** UPS 是/否（默认否）。 */
  ups?: boolean;
  /** "二维码是否申请"手工是/否（默认否）。 */
  qrRequested?: boolean;
  /** 所属批次（可空，运输开始前可改批）。 */
  batchId?: string | null;
}

/**
 * 仪器批量导入行（.xlsx 5 列：仪器名称/厂商/型号/序列号/服务级别，renderer 解析后整批提交）。
 * 只有仪器名称必填；其余列选填并去除首尾空白。
 */
export interface InstrumentBulkInput {
  /** 仪器名称（必填，去除首尾空白）。 */
  name: string;
  /** 厂商（选填）。 */
  manufacturer?: string | null;
  /** 型号（选填）。 */
  model?: string | null;
  /** 序列号（选填；payload 内及库内同一项目均不得重复）。 */
  serialNo?: string | null;
  /** 服务级别（选填）。 */
  serviceLevel?: string | null;
}

/** 批次报价输入（3.6）：计划运输日期、运输公司、合同预算价/物流成交价。 */
export interface BatchQuoteInput {
  planTransportDate?: BusinessDate | null;
  transportCompany?: string | null;
  /**
   * 合同预算价（分整数；有值必须 > 0）。
   * 物理字段名 originalPriceCents 沿用历史命名（旧「原价」口径）。
   */
  originalPriceCents?: bigint | null;
  /**
   * 物流成交价（分整数；允许 0；即最终实际费用）。
   * 物理字段名 discountedPriceCents 沿用历史命名（旧「折后价」口径）。
   */
  discountedPriceCents?: bigint | null;
}

/** 物流费用记录输入（部分费用语义）：未提交字段不参与（undefined）；null = 显式清空。 */
export interface LogisticsFeeInput {
  /** 物流费用申请（登记）日期（undefined=不提交；null=清空；有值须为合法业务日期）。 */
  appliedAt?: BusinessDate | null;
  /** 合同预算价（分整数；undefined=不提交；null=清空；有值必须 > 0）。 */
  budgetPriceCents?: bigint | null;
  /** 物流成交价（分整数；undefined=不提交；null=清空；有值允许 0 即最终实际费用）。 */
  dealPriceCents?: bigint | null;
  /**
   * 历史兼容旧列（旧「实际物流费用」口径）：现行业务与 dealPriceCents 恒同值
   * （物流成交价即最终实际费用）；仅历史导入需单独提供，新流程调用方传 dealPriceCents。
   */
  logisticsCostCents?: bigint | null;
}

/** 物流费用记录结果（含物流成交价 > 合同预算价的警告，警告不阻塞保存）。 */
export interface LogisticsFeeResult {
  fee: LogisticsFee;
  /** 物流成交价大于合同预算价时的警告（否则为 null）。 */
  warning: string | null;
}
