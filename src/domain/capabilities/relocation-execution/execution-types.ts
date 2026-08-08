/**
 * relocation-execution 能力（搬迁执行：批次、仪器、上门活动与物流）。
 *
 * 完整业务规则见 tasks 3.x：暂定数量与占位仪器、搬迁仪器字段（名称、型号、
 * UPS、二维码是否申请）、批次归属与改批历史、上门活动的工作事实与工作类型
 * （拆机状态与开始/完成时间显式记录）、仪器拆装进度推导、物流报价与实际物流
 * 费用（物流费用申请/登记时间）。
 *
 * 手工事实统一携带账号归属快照（account_id + username_snapshot，design D12 /
 * tasks 3.x「所有手工事实绑定当前 account attribution」），历史统计按快照归属。
 */

/** 搬迁批次（tasks 3.3/3.6）。 */
export interface Batch {
  id: string;
  projectId: string;
  /** 计划运输日期（yyyy-mm-dd）。 */
  planTransportDate: string | null;
  transportCompany: string | null;
  /** 人民币原价（分整数；有值必须 > 0）。 */
  originalPriceCents: bigint | null;
  /** 人民币折后价（分整数；有值必须 > 0）。 */
  discountedPriceCents: bigint | null;
  /** 开始运输时间（null = 未开始运输）。 */
  startedAt: string | null;
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
  /** 变更时间（业务时间）。 */
  changedAt: string;
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
  /** 到访时间（业务时间）。 */
  visitAt: string | null;
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
  /** 开始时间（创建为进行中时记录）。 */
  startedAt: string;
  /** 完成时间（转为已完成时记录）。 */
  completedAt: string | null;
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
  /** 拆机开始时间（存在拆机事实时）。 */
  teardownStartedAt: string | null;
  /** 拆机完成时间（拆机已完成时）。 */
  teardownCompletedAt: string | null;
  /** 装机开始时间（存在装机事实时）。 */
  installStartedAt: string | null;
  /** 装机完成时间（装机已完成时）。 */
  installCompletedAt: string | null;
}

/**
 * 实际物流费用记录（tasks 3.7）：每批次仅一笔；物流费用申请（登记）时间必填
 * 默认当天、首次登记决定归属月份；预算价格、成交价格、实际物流费用均必填、
 * 以人民币记录且 > 0；成交价格 > 预算价格仅警告。
 */
export interface LogisticsFee {
  id: string;
  batchId: string;
  /** 物流费用申请（登记）时间（业务时间；修改金额不改变）。 */
  appliedAt: string;
  /** 人民币预算价格（分整数，必填且 > 0）。 */
  budgetPriceCents: bigint;
  /** 人民币成交价格（分整数，必填且 > 0）。 */
  dealPriceCents: bigint;
  /** 人民币实际物流费用（分整数，必填且 > 0）。 */
  logisticsCostCents: bigint;
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
  /** 非空序列号在同一项目内唯一；空序列号 = 占位仪器。 */
  serialNo?: string | null;
  /** UPS 是/否（默认否）。 */
  ups?: boolean;
  /** "二维码是否申请"手工是/否（默认否）。 */
  qrRequested?: boolean;
  /** 所属批次（可空，运输开始前可改批）。 */
  batchId?: string | null;
}

/** 批次报价输入（3.6）：计划运输日期、运输公司、人民币原价/折后价。 */
export interface BatchQuoteInput {
  planTransportDate?: string | null;
  transportCompany?: string | null;
  /** 人民币原价（分整数；有值必须 > 0）。 */
  originalPriceCents?: bigint | null;
  /** 人民币折后价（分整数；有值必须 > 0）。 */
  discountedPriceCents?: bigint | null;
}

/** 物流费用记录输入（3.7）。 */
export interface LogisticsFeeInput {
  /** 物流费用申请（登记）时间（必填，缺省默认当天）。 */
  appliedAt?: string;
  /** 人民币预算价格（分整数，必填且 > 0）。 */
  budgetPriceCents: bigint;
  /** 人民币成交价格（分整数，必填且 > 0）。 */
  dealPriceCents: bigint;
  /** 人民币实际物流费用（分整数，必填且 > 0）。 */
  logisticsCostCents: bigint;
}

/** 物流费用记录结果（含成交 > 预算的警告，警告不阻塞保存）。 */
export interface LogisticsFeeResult {
  fee: LogisticsFee;
  /** 成交价格大于预算价格时的警告（否则为 null）。 */
  warning: string | null;
}
