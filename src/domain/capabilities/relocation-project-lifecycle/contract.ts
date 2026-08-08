import { newInternalId, newTempNumber } from '../../core/ids';

/**
 * 合同领域对象（tasks 1.7 / design D3）。
 *
 * 合同与搬迁项目 1:1 独立建模；待进单阶段合同可空（可不关联合同，系统不强制
 * 创建合同草稿，TBD-01），正式进单前必须补齐合同。
 *
 * 字段：临时编号、ECC、合同 USD 含税金额（允许 0）、进单金额快照、最终可确认金额。
 * 正式进单（补 ECC、快照锁定）行为见 2.1/5.x，本任务只建立基础模型。
 */
export interface Contract {
  id: string;
  projectId: string;
  /** 合同临时编号（待进单阶段使用；正式进单后补唯一 ECC）。 */
  tempNumber: string;
  /** 正式进单后必填、全局唯一；待进单阶段可空。 */
  ecc: string | null;
  /** 合同 USD 含税金额（分整数）。仅合同金额允许为 0；null = 未录入。 */
  usdTaxAmountCents: bigint | null;
  /** 进单金额快照（分整数）：正式进单时锁定，仅用于进单金额统计。 */
  entryAmountSnapshotCents: bigint | null;
  /** 最终可确认金额（分整数）：默认取合同金额、可调整，不得低于累计掉票。 */
  finalConfirmableAmountCents: bigint | null;
  /** ECC 最后修改时间（正式进单后 ECC 纠错时自动记录）。 */
  eccLastModifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContractInput {
  id?: string;
  projectId: string;
  tempNumber?: string;
  createdAt?: string;
}

export function createContract(input: CreateContractInput): Contract {
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: input.id ?? newInternalId(),
    projectId: input.projectId,
    tempNumber: input.tempNumber ?? newTempNumber(),
    ecc: null,
    usdTaxAmountCents: null,
    entryAmountSnapshotCents: null,
    finalConfirmableAmountCents: null,
    eccLastModifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
