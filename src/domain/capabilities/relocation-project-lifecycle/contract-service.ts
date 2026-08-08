import { ValidationError } from '../../core/errors';
import { Money } from '../../core/money';
import type { Contract } from './contract';

/**
 * 合同基础金额维护（tasks 1.7 骨架）。
 *
 * - 合同 USD 含税金额由负责人手工录入，允许为 0（TBD-11）；仅合同金额允许 0。
 * - 直接覆盖当前值，不保存正式合同变更对象/历史、不要求记录原因（TBD-20）。
 * - 进单金额快照与最终可确认金额字段占位；锁定/联动规则见 5.x。
 */
export class ContractService {
  /** 设置合同 USD 含税金额（允许 0 或正数；负数拒绝）。 */
  setUsdTaxAmount(contract: Contract, amount: Money): void {
    if (amount.isNegative) {
      throw new ValidationError('AMOUNT_NEGATIVE', '金额不得为负数');
    }
    contract.usdTaxAmountCents = amount.cents;
    contract.updatedAt = new Date().toISOString();
  }

  /** 设置最终可确认金额（占位；默认取合同金额、可调整，规则见 5.4）。 */
  setFinalConfirmableAmount(contract: Contract, amount: Money): void {
    if (amount.isNegative) {
      throw new ValidationError('AMOUNT_NEGATIVE', '金额不得为负数');
    }
    contract.finalConfirmableAmountCents = amount.cents;
    contract.updatedAt = new Date().toISOString();
  }

  /** 保存进单金额快照（正式进单时调用，行为见 2.1/5.2；此处仅提供方法占位）。 */
  lockEntryAmountSnapshot(contract: Contract): void {
    if (contract.entryAmountSnapshotCents === null && contract.usdTaxAmountCents !== null) {
      contract.entryAmountSnapshotCents = contract.usdTaxAmountCents;
      contract.updatedAt = new Date().toISOString();
    }
  }
}
