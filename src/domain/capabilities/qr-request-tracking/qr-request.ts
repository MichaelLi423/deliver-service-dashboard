/**
 * qr-request-tracking 能力（二维码申请独立模块）。
 *
 * 二维码申请为独立模块，每条申请记录保存申请人、申请时间与一个或多个申请类型（多选）；
 * 申请类型沿用九类固定代码；申请不设状态流转（TBD-06）；
 * 工作量按申请记录 × 去重后的选中类型计数（同一条记录内相同类型只计一次，
 * 不同申请中的相同类型分别计数）；重复申请保留完整历史。
 * 搬迁仪器上的「二维码是否申请」为手工是/否字段（归属 relocation-execution），
 * 不保存 URL、不由申请记录推导、不自动创建提醒、不阻塞上门/运输/项目流转。
 * 手工记录绑定当前登录账号归属快照。规则实现见 tasks 4.9~4.10。
 */
/** 九类固定申请类型（TBD-06）。 */
export const QR_REQUEST_TYPE_CODES = [
  'A',
  'B',
  'C',
  'D',
  'precise_instrument_packing_only', // 仅打包搬运精密仪器
  'oem_equipment', // OEM 设备
  'temporary_label', // 临时标签
  'project_acceptance_form', // 项目验收单
  'logistics_management', // 物流管理
] as const;
export type QrRequestTypeCode = (typeof QR_REQUEST_TYPE_CODES)[number];

export interface QrRequest {
  id: string;
  /** 申请人。 */
  applicant: string;
  /** 申请时间（业务时间，按该月份归属）。 */
  requestedAt: string;
  /** 一条申请内去重后的选中类型。 */
  types: QrRequestTypeCode[];
  /** 操作账号归属快照。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  createdAt: string;
}

/** 二维码申请创建输入（4.9）。 */
export interface QrRequestInput {
  applicant: string;
  /** 申请时间（缺省当前时间）。 */
  requestedAt?: string;
  /** 一个或多个申请类型（多选，同一条内去重）。 */
  types: QrRequestTypeCode[];
}

/** 二维码申请工作量：按申请记录 × 去重类型计数，按类型分组。 */
export interface QrRequestWorkloadRow {
  typeCode: QrRequestTypeCode;
  count: number;
}
