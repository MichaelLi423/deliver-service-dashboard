import type { ServiceOrder } from './service-order';

/**
 * service-order-recording 仓储接口（领域服务依赖，可脱离具体持久层测试）。
 * SQLite 实现见 local-data-persistence/service-order-repositories.ts。
 */

export interface ServiceOrderRepository {
  findById(id: string): ServiceOrder | undefined;
  /** 非空服务单号全局唯一性检查（四类共用唯一空间，TBD-21）。 */
  findByServiceOrderNo(serviceOrderNo: string): ServiceOrder | undefined;
  save(order: ServiceOrder): void;
  list(): ServiceOrder[];
  listByProject(projectId: string): ServiceOrder[];
  /** 确认后删除一条开单记录（5.2：不修改/删除关联项目，主状态与进单状态不变）。 */
  deleteById(id: string): void;
}
