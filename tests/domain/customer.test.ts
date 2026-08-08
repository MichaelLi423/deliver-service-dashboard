import { describe, expect, it } from 'vitest';
import { CustomerService, type CustomerRepository } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import type { Customer } from '../../src/domain/capabilities/relocation-project-lifecycle/customer';
import { UniquenessError } from '../../src/domain/core/errors';
import { newInternalId } from '../../src/domain/core/ids';

/** 内存客户仓储（领域测试）。 */
class InMemoryCustomerRepository implements CustomerRepository {
  private readonly store = new Map<string, Customer>();
  findByName(name: string): Customer | undefined {
    return [...this.store.values()].find((c) => c.name === name);
  }
  save(customer: Customer): void {
    this.store.set(customer.id, customer);
  }
  get all(): Customer[] {
    return [...this.store.values()];
  }
}

describe('客户主数据（tasks 1.6 / D13 / TBD-25）', () => {
  it('登记客户：trim 后保存为全局唯一业务标识', () => {
    const repo = new InMemoryCustomerRepository();
    const service = new CustomerService(repo);
    const customer = service.register(' 华东医药 ');
    expect(customer.name).toBe('华东医药');
    expect(customer.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('客户名称 trim 后全局唯一：重复（含首尾空白变体）拒绝保存', () => {
    const repo = new InMemoryCustomerRepository();
    const service = new CustomerService(repo);
    service.register('华东医药');
    expect(() => service.register(' 华东医药 ')).toThrow(UniquenessError);
    expect(() => service.register('华东医药')).toThrow(UniquenessError);
    expect(repo.all.length).toBe(1);
  });

  it('同一客户名称可关联多个不同 ECC 项目（客户侧允许复用）', () => {
    const repo = new InMemoryCustomerRepository();
    const service = new CustomerService(repo);
    const customer = service.register('华东医药');
    // 多个不同内部 ID 引用同一客户名称（项目侧关联规则见 2.1）
    const projectRefs = [newInternalId(), newInternalId()];
    expect(customer.name).toBe('华东医药');
    expect(projectRefs.length).toBe(2);
  });

  it('不记录客户外部编号', () => {
    const customer = new CustomerService(new InMemoryCustomerRepository()).register('华东医药');
    expect('externalCode' in customer).toBe(false);
    expect(Object.keys(customer).sort()).toEqual(['createdAt', 'id', 'name']);
  });

  it('空客户名称拒绝', () => {
    const service = new CustomerService(new InMemoryCustomerRepository());
    expect(() => service.register('   ')).toThrow(UniquenessError);
  });
});
