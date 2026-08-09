/**
 * project-financial-closure 能力（金额闭环：合同金额、最终可确认金额与掉票）。
 *
 * - 金额一律以分整数（bigint）表达，两位小数、四舍五入，不采用二进制浮点（见 src/domain/core/money.ts）。
 * - 仅合同 USD 含税金额允许为 0；最终可确认金额与掉票金额有值必须 > 0（无 0 金额闭环）。
 * - 掉票不可物理删除，撤销后为终态（禁止编辑、重复撤销或重新激活）。
 * - 待掉票/已完成之间的金额闭环重算调用 lifecycle 校验入口，本模块不重新定义状态
 *   （design D4 / tasks 5.10）。
 * - 合同金额直接覆盖、不保存正式合同变更对象/历史、不要求记录原因（TBD-20）。
 * - 掉票记录为手工录入事实，携带账号归属快照（design D12）。
 * 规则实现见 tasks 5.x。
 * 业务时间字段（掉票/撤销日期）为 yyyy-mm-dd；lastModifiedAt、createdAt 仍为带偏移 ISO。
 */
import type { BusinessDate, IsoDateTime } from '../../core/time';

export interface InvoiceRecord {
  id: string;
  projectId: string;
  /** 掉票金额（分整数，必须 > 0）。 */
  amountCents: bigint;
  /** 掉票日期（业务日期，按该月份归属）。 */
  invoicedAt: BusinessDate;
  /** 撤销日期与原因（业务日期；撤销后为终态）。 */
  revokedAt: BusinessDate | null;
  revokeReason: string | null;
  /** 最后修改时间（审计时间，掉票直接覆盖编辑时自动记录，带偏移 ISO）。 */
  lastModifiedAt: IsoDateTime;
  /** 操作账号归属快照。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  createdAt: string;
}

export function isInvoiceRevoked(invoice: InvoiceRecord): boolean {
  return invoice.revokedAt !== null;
}

/** 累计有效掉票金额（已撤销不计）。 */
export function sumActiveInvoices(invoices: InvoiceRecord[]): bigint {
  return invoices.reduce(
    (acc, invoice) => (isInvoiceRevoked(invoice) ? acc : acc + invoice.amountCents),
    0n,
  );
}

/** 有效掉票次数（已撤销不计）。 */
export function countActiveInvoices(invoices: InvoiceRecord[]): number {
  return invoices.filter((invoice) => !isInvoiceRevoked(invoice)).length;
}

/** 是否存在任何掉票历史（含已撤销掉票；取消约束与金额历史口径）。 */
export function hasAnyInvoiceHistory(invoices: InvoiceRecord[]): boolean {
  return invoices.length > 0;
}

/** 掉票登记/编辑输入（5.5/5.8）。 */
export interface InvoiceInput {
  /** 掉票金额（分整数，必须 > 0）。 */
  amountCents: bigint;
  /** 掉票日期（业务日期；缺省默认当天）。 */
  invoicedAt?: BusinessDate;
}

/** 掉票撤销输入（5.9）：撤销日期与原因均必填。 */
export interface InvoiceRevokeInput {
  revokedAt: BusinessDate;
  revokeReason: string;
}

/** 掉票记录仓储接口（SQLite 实现见 local-data-persistence/financial-repositories.ts）。 */
export interface InvoiceRepository {
  findById(id: string): InvoiceRecord | undefined;
  save(invoice: InvoiceRecord): void;
  listByProject(projectId: string): InvoiceRecord[];
}
