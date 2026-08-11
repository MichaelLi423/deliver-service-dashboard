import type {
  ServiceOrder,
  ServiceOrderRepository,
} from '../../src/domain/capabilities/service-order-recording';

/**
 * service-order-recording 内存仓储（领域测试；tasks 3.8~3.10 场景）。
 * SQLite 实现见 src/domain/capabilities/local-data-persistence/service-order-repositories.ts。
 */

export class InMemoryServiceOrderRepository implements ServiceOrderRepository {
  private readonly store = new Map<string, ServiceOrder>();

  findById(id: string): ServiceOrder | undefined {
    return this.store.get(id);
  }

  findByServiceOrderNo(serviceOrderNo: string): ServiceOrder | undefined {
    return [...this.store.values()].find((o) => o.serviceOrderNo === serviceOrderNo);
  }

  save(order: ServiceOrder): void {
    this.store.set(order.id, order);
  }

  list(): ServiceOrder[] {
    return [...this.store.values()];
  }

  listByProject(projectId: string): ServiceOrder[] {
    return [...this.store.values()].filter((o) => o.projectId === projectId);
  }

  deleteById(id: string): void {
    this.store.delete(id);
  }

  get all(): ServiceOrder[] {
    return [...this.store.values()];
  }
}
