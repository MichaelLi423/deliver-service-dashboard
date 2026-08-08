import type { InvoiceRecord, InvoiceRepository } from '../../src/domain/capabilities/project-financial-closure';
import type { InvoiceReadRepository } from '../../src/domain/capabilities/relocation-project-lifecycle';
import {
  hasAnyInvoiceHistory,
  sumActiveInvoices,
} from '../../src/domain/capabilities/project-financial-closure';

/**
 * project-financial-closure 内存仓储（领域测试；tasks 5.x 场景）。
 * SQLite 实现见 src/domain/capabilities/local-data-persistence/financial-repositories.ts。
 */

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly store = new Map<string, InvoiceRecord>();

  findById(id: string): InvoiceRecord | undefined {
    return this.store.get(id);
  }

  save(invoice: InvoiceRecord): void {
    this.store.set(invoice.id, invoice);
  }

  listByProject(projectId: string): InvoiceRecord[] {
    return [...this.store.values()]
      .filter((i) => i.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  get all(): InvoiceRecord[] {
    return [...this.store.values()];
  }
}

/**
 * lifecycle 掉票只读事实源（内存版，与同一 InMemoryInvoiceRepository 共享存储）。
 * 使 ProjectService.adjustStatus 的取消约束与金额闭环重算读取最新掉票事实。
 */
export class InMemoryInvoiceReadRepository implements InvoiceReadRepository {
  constructor(private readonly repo: InMemoryInvoiceRepository) {}

  sumActiveAmounts(projectId: string): bigint {
    return sumActiveInvoices(this.repo.listByProject(projectId));
  }

  hasAnyInvoiceHistory(projectId: string): boolean {
    return hasAnyInvoiceHistory(this.repo.listByProject(projectId));
  }
}
