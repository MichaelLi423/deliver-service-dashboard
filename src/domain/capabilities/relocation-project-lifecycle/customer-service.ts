import { UniquenessError } from '../../core/errors';
import { normalizeCustomerName } from '../../core/ids';
import { createCustomer, type Customer } from './customer';

/**
 * 客户名称唯一业务标识校验（TBD-25 / D13 / tasks 1.6）。
 * 仓库接口使领域服务可脱离具体持久层测试；SQLite 实现见 local-data-persistence。
 */
export interface CustomerRepository {
  findByName(name: string): Customer | undefined;
  save(customer: Customer): void;
}

export class CustomerService {
  constructor(private readonly repo: CustomerRepository) {}

  /**
   * 登记客户：去除首尾空白后全局唯一，重复时拒绝保存。
   * 同一客户名称可关联多个不同 ECC 项目（项目侧关联规则见 project-service）。
   */
  register(name: string): Customer {
    const trimmed = normalizeCustomerName(name);
    if (trimmed === '') {
      throw new UniquenessError('CUSTOMER_NAME_REQUIRED', '客户名称必填');
    }
    const existing = this.repo.findByName(trimmed);
    if (existing) {
      throw new UniquenessError(
        'CUSTOMER_NAME_UNIQUE',
        `客户名称「${trimmed}」已存在，客户名称为去除首尾空白后全局唯一的业务标识`,
      );
    }
    const customer = createCustomer({ name: trimmed });
    this.repo.save(customer);
    return customer;
  }
}
