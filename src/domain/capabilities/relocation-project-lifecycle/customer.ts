import { newInternalId, normalizeCustomerName } from '../../core/ids';
import { assertRequiredText } from '../../core/ids';

/**
 * 客户主数据（tasks 1.6 / D13 / TBD-25）。
 *
 * - 客户名称为客户唯一业务标识：去除首尾空白后全局唯一。
 * - 同一客户名称可关联多个不同 ECC 搬迁项目。
 * - 系统内部保留技术引用 ID；不记录客户外部编号。
 */

export interface Customer {
  /** 稳定内部技术 ID（全局唯一、不复用）。 */
  id: string;
  /** trim 后唯一业务名称。 */
  name: string;
  createdAt: string;
}

export interface CreateCustomerInput {
  name: string;
  id?: string;
  createdAt?: string;
}

export function createCustomer(input: CreateCustomerInput): Customer {
  const name = normalizeCustomerName(assertRequiredText(input.name, '客户名称'));
  return {
    id: input.id ?? newInternalId(),
    name,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
