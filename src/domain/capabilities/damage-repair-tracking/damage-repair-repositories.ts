import type { ActivityDamageLink, DamageRepairItem } from './damage-repair';

/**
 * damage-repair-tracking 仓储接口（领域服务依赖）。
 * SQLite 实现见 local-data-persistence/damage-repair-repositories.ts。
 */

export interface DamageRepairItemRepository {
  findById(id: string): DamageRepairItem | undefined;
  save(item: DamageRepairItem): void;
  listByProject(projectId: string): DamageRepairItem[];
  listAll(): DamageRepairItem[];
}

export interface ActivityDamageLinkRepository {
  findByKey(activityId: string, damageItemId: string): ActivityDamageLink | undefined;
  save(link: ActivityDamageLink): void;
  listByActivity(activityId: string): ActivityDamageLink[];
  listByDamageItem(damageItemId: string): ActivityDamageLink[];
}

/**
 * 搬迁仪器只读事实源：校验事项所属仪器、取活动仪器集合。
 * 实现可复用 relocation-execution 的仓储。
 */
export interface DamageInstrumentReader {
  findById(id: string):
    | { id: string; projectId: string; serialNo: string | null }
    | undefined;
}

/**
 * 维修上门活动只读事实源（TBD-24 校验）：
 * - 活动须为「维修」类上门活动（含类型为维修的工作事实）；
 * - 关联时校验事项所属仪器属于该活动的仪器集合。
 */
export interface RepairActivityReader {
  findById(id: string):
    | { id: string; projectId: string }
    | undefined;
  /** 活动的仪器集合（活动 × 仪器工作事实中的仪器）。 */
  listInstrumentIds(activityId: string): string[];
  /** 活动是否包含指定工作类型（如维修）。 */
  hasWorkType(activityId: string, workType: string): boolean;
}

/**
 * 合同 USD 含税金额只读事实源（TBD-15 维修限制）。
 * 合同金额为空或 0 时禁止开始/完成维修、禁止备件标记「已使用」。
 */
export interface ContractAmountReader {
  findUsdTaxAmountCents(projectId: string): bigint | null;
}
