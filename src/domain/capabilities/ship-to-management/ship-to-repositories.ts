import type { ShipTo, ShipToRequest } from './ship-to';

/**
 * ship-to-management 仓储接口（领域服务依赖，可脱离具体持久层测试）。
 * SQLite 实现见 local-data-persistence/ship-to-repositories.ts。
 */

export interface ShipToRepository {
  findById(id: string): ShipTo | undefined;
  findByAccountId(accountId: string): ShipTo | undefined;
  save(shipTo: ShipTo): void;
  listAll(): ShipTo[];
}

export interface ShipToRequestRepository {
  findById(id: string): ShipToRequest | undefined;
  /** 已完成申请 Account ID 唯一性检查（跨申请 + 跨 Ship-to）。 */
  findByAccountId(accountId: string): ShipToRequest | undefined;
  /** 同客户同新址已有申请（待提交/处理中/已完成任一状态），用于「一条申请」去重。 */
  findByCustomerAndAddress(customerName: string, newSiteAddress: string): ShipToRequest | undefined;
  save(request: ShipToRequest): void;
  listAll(): ShipToRequest[];
}

/**
 * 批次/项目所涉 Ship-to 汇总展示的只读事实源（4.2）。
 * 搬迁批次与搬迁项目仅汇总展示所涉 Ship-to，不维护批次级/项目级唯一地址。
 */
export interface ShipToAddressReader {
  /** 某批次的搬迁仪器内部 ID 列表。 */
  listInstrumentIdsByBatch(batchId: string): string[];
  /** 某搬迁项目的搬迁仪器内部 ID 列表。 */
  listInstrumentIdsByProject(projectId: string): string[];
  /** 返回给定仪器集合的目的 Ship-to 内部 ID（去重、排除未关联）。 */
  listDestinationShipToIds(instrumentIds: string[]): string[];
}
