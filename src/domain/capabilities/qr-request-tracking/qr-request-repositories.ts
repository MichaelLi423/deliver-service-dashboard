import type { QrRequest, QrRequestTypeCode } from './qr-request';

/**
 * qr-request-tracking 仓储接口（领域服务依赖）。
 * SQLite 实现见 local-data-persistence/qr-request-repositories.ts。
 */

export interface QrRequestRepository {
  findById(id: string): QrRequest | undefined;
  save(request: QrRequest): void;
  /** 独立保存、可查询；历史申请不覆盖、不删除。 */
  listAll(): QrRequest[];
  /** 清理申请拥有的多选类型行；由 QrRequestService 与申请删除同一调用方事务内协调。 */
  deleteTypesByRequestId?(id: string): void;
  /** 删除申请主行；调用方须先清理其拥有的多选类型行。 */
  deleteById(id: string): void;
}

/** 类型行（qr_request_types 表）：申请记录 × 选中类型，同条内唯一。 */
export interface QrRequestTypeRow {
  id: string;
  qrRequestId: string;
  typeCode: QrRequestTypeCode;
}
