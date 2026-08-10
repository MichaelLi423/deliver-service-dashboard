import { ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import { Money, Ratio } from '../../core/money';
import type { ActorSnapshot } from '../../core/source';
import {
  assertValidBusinessDate,
  SystemClock,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import {
  DAMAGE_ITEM_STATUSES,
  PART_CURRENCIES,
  PART_STATUSES,
  type ActivityDamageLink,
  type DamageItemStatus,
  type DamageRepairItem,
  type PartCurrency,
  type PartInfoInput,
  type PartStatus,
  type RegisterDamageItemInput,
} from './damage-repair';
import type {
  ActivityDamageLinkRepository,
  ContractAmountReader,
  DamageInstrumentReader,
  DamageRepairItemRepository,
  RepairActivityReader,
} from './damage-repair-repositories';

/**
 * damage-repair-tracking 领域服务（tasks 4.4~4.8）。
 *
 * - 一台搬迁仪器的一次运输损坏建立一条事项；一条事项仅含一个备件，
 *   同一损坏涉及多个备件时按备件分别建立多条事项。
 * - 事项处理状态：未处理/处理中/已修复/已关闭未修复（关闭须记录原因）；
 *   备件处理状态：待提交/处理中/已到件/已使用；仅「已使用」计入维修费用与占比。
 * - 备件数量与金额必须有值且 > 0；币种仅限 USD/RMB，RMB 按固定汇率 7.2 折算。
 * - 合同 USD 含税金额为空或 0 时：可登记损坏（未处理事项），但禁止开始/完成维修、
 *   禁止备件标记「已使用」、禁止维修上门活动与事项关联；登记时直接置为处理中/
 *   已修复或备件直接标记已使用同样被拒（TBD-15，全部入口共享同一守卫）。
 * - 不阻塞搬迁项目生命周期：本模块不调用 lifecycle，事项可在任何阶段后继续处理。
 * - 维修上门活动 × 事项多对多关联（TBD-24）：关联仅引用、不建立维修上门子记录，
 *   关联时校验事项所属仪器属于活动的仪器集合。
 *
 * 所有手工记录绑定当前登录账号归属快照。
 */
export class DamageRepairService {
  constructor(
    private readonly items: DamageRepairItemRepository,
    private readonly links: ActivityDamageLinkRepository,
    private readonly instruments: DamageInstrumentReader,
    private readonly activities: RepairActivityReader,
    private readonly contractReader: ContractAmountReader,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  // ---- 4.4/4.6 登记损坏/维修事项（单备件） ----

  /** 登记一条损坏/维修事项：关联一台仪器、仅含一个备件。合同金额为 0 时仍可登记未处理事项。 */
  registerItem(instrumentId: string, input: RegisterDamageItemInput, actor: ActorSnapshot): DamageRepairItem {
    const instrument = this.instruments.findById(instrumentId);
    if (!instrument) {
      throw new ValidationError('INSTRUMENT_NOT_FOUND', `搬迁仪器不存在: ${instrumentId}`);
    }
    const partNumber = assertRequiredText(input.partNumber, '备件号');
    if (!Number.isInteger(input.partQuantity) || input.partQuantity <= 0) {
      throw new ValidationError('PART_QUANTITY_POSITIVE', '备件数量必须有值且大于 0');
    }
    if (input.partAmountCents <= 0n) {
      throw new ValidationError('PART_AMOUNT_POSITIVE', '备件金额必须有值且大于 0');
    }
    this.assertCurrency(input.partCurrency);
    if (input.partRequestedAt !== undefined && input.partRequestedAt !== null) {
      assertValidBusinessDate(input.partRequestedAt, '备件申请时间');
    }
    if (input.partStatus !== undefined && input.partStatus !== null) {
      this.assertPartStatus(input.partStatus);
    }
    const issueStatus = input.issueStatus ?? 'untreated';
    this.assertItemStatus(issueStatus);
    // TBD-15 共享守卫：登记时直接置为处理中/已修复/已关闭未修复，或备件直接标记已使用，
    // 均须合同 USD 含税金额为正数，否则拒绝登记。
    if (input.partStatus === 'used' || issueStatus !== 'untreated') {
      this.assertRepairAllowed(instrument.projectId);
    }
    const closeReason =
      issueStatus === 'closed_unrepaired' ? assertRequiredText(input.closeReason, '关闭原因') : null;
    const registeredAt = input.registeredAt ?? this.today();
    assertValidBusinessDate(registeredAt, '事项登记时间');
    const now = this.now();
    const item: DamageRepairItem = {
      id: newInternalId(),
      instrumentId,
      projectId: instrument.projectId,
      damageReason: input.damageReason?.trim() === '' ? null : (input.damageReason?.trim() ?? null),
      issueStatus,
      closeReason,
      partNumber,
      partQuantity: input.partQuantity,
      partAmountCents: input.partAmountCents,
      partCurrency: input.partCurrency,
      partRequestedAt: input.partRequestedAt ?? null,
      partStatus: input.partStatus ?? null,
      repairNote: input.repairNote?.trim() === '' ? null : (input.repairNote?.trim() ?? null),
      registeredAt,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.items.save(item);
    return item;
  }

  /**
   * 更新事项处理状态。
   * - 处理中/已修复/已关闭未修复表示开始/完成维修，合同金额为空或 0 时拒绝（TBD-15）。
   * - 已关闭未修复必须记录原因。
   */
  updateIssueStatus(itemId: string, status: DamageItemStatus, closeReason: string | null, actor: ActorSnapshot): DamageRepairItem {
    this.assertItemStatus(status);
    const item = this.requireItem(itemId);
    // 处理中/已修复/已关闭未修复表示开始/完成维修，合同金额为空或 0 时拒绝（TBD-15）。
    if (status !== 'untreated') {
      this.assertRepairAllowed(item.projectId);
    }
    if (status === 'closed_unrepaired') {
      const reason = assertRequiredText(closeReason, '关闭原因');
      item.closeReason = reason;
    } else {
      item.closeReason = null;
    }
    item.issueStatus = status;
    item.operatorAccountId = actor.accountId;
    item.operatorUsername = actor.username;
    item.updatedAt = this.now();
    this.items.save(item);
    return item;
  }

  /**
   * 更新备件处理状态：仅限待提交/处理中/已到件/已使用。
   * 标记「已使用」须合同 USD 含税金额为正数（TBD-15）。
   */
  setPartStatus(itemId: string, status: PartStatus, actor: ActorSnapshot): DamageRepairItem {
    this.assertPartStatus(status);
    const item = this.requireItem(itemId);
    // 标记「已使用」须合同 USD 含税金额为正数（TBD-15）。
    if (status === 'used') {
      this.assertRepairAllowed(item.projectId);
    }
    item.partStatus = status;
    item.operatorAccountId = actor.accountId;
    item.operatorUsername = actor.username;
    item.updatedAt = this.now();
    this.items.save(item);
    return item;
  }

  /** 更新备件信息与维修过程备注（数量/金额必须 > 0，币种仅限 USD/RMB）。 */
  updatePart(itemId: string, input: PartInfoInput, actor: ActorSnapshot): DamageRepairItem {
    const item = this.requireItem(itemId);
    if (input.partNumber !== undefined) {
      item.partNumber = assertRequiredText(input.partNumber, '备件号');
    }
    if (input.partQuantity !== undefined) {
      if (!Number.isInteger(input.partQuantity) || input.partQuantity <= 0) {
        throw new ValidationError('PART_QUANTITY_POSITIVE', '备件数量必须有值且大于 0');
      }
      item.partQuantity = input.partQuantity;
    }
    if (input.partAmountCents !== undefined) {
      if (input.partAmountCents <= 0n) {
        throw new ValidationError('PART_AMOUNT_POSITIVE', '备件金额必须有值且大于 0');
      }
      item.partAmountCents = input.partAmountCents;
    }
    if (input.partCurrency !== undefined) {
      this.assertCurrency(input.partCurrency);
      item.partCurrency = input.partCurrency;
    }
    if (input.partRequestedAt !== undefined) {
      if (input.partRequestedAt !== null) assertValidBusinessDate(input.partRequestedAt, '备件申请时间');
      item.partRequestedAt = input.partRequestedAt;
    }
    if (input.repairNote !== undefined) {
      item.repairNote = input.repairNote?.trim() === '' ? null : (input.repairNote?.trim() ?? null);
    }
    item.operatorAccountId = actor.accountId;
    item.operatorUsername = actor.username;
    item.updatedAt = this.now();
    this.items.save(item);
    return item;
  }

  // ---- 4.8 维修上门活动 × 事项多对多关联（TBD-24，本能力唯一所有） ----

  /**
   * 将维修上门活动关联到损坏/维修事项（仅引用，不建立维修上门子记录）。
   * 前置校验：
   * - 活动存在且为「维修」类上门活动（含维修工作事实）；
   * - 事项所属仪器属于该活动的仪器集合，否则拒绝关联且既有关联保持不变。
   */
  linkRepairActivity(activityId: string, damageItemId: string, actor: ActorSnapshot): ActivityDamageLink {
    const activity = this.activities.findById(activityId);
    if (!activity) {
      throw new ValidationError('ACTIVITY_NOT_FOUND', `上门活动不存在: ${activityId}`);
    }
    if (!this.activities.hasWorkType(activityId, 'repair')) {
      throw new ValidationError(
        'ACTIVITY_NOT_REPAIR',
        '仅类型为维修的上门活动可关联损坏/维修事项',
      );
    }
    const item = this.requireItem(damageItemId);
    // TBD-15 共享守卫：维修上门活动 × 事项关联同样受合同 USD 含税金额为正数约束。
    this.assertRepairAllowed(item.projectId);
    const activityInstruments = this.activities.listInstrumentIds(activityId);
    if (!activityInstruments.includes(item.instrumentId)) {
      throw new ValidationError(
        'ITEM_INSTRUMENT_NOT_IN_ACTIVITY',
        '事项所属仪器不在该维修上门活动的仪器集合中，拒绝关联',
      );
    }
    if (this.links.findByKey(activityId, damageItemId)) {
      throw new ValidationError('LINK_ALREADY_EXISTS', '该维修上门活动已关联此事项');
    }
    const now = this.now();
    const link: ActivityDamageLink = {
      id: newInternalId(),
      activityId,
      damageItemId,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
    };
    this.links.save(link);
    return link;
  }

  listLinksByActivity(activityId: string): ActivityDamageLink[] {
    return this.links.listByActivity(activityId);
  }

  listLinksByDamageItem(damageItemId: string): ActivityDamageLink[] {
    return this.links.listByDamageItem(damageItemId);
  }

  /**
   * 确认后删除一条损坏/维修事项（5.2）。
   * - 按 TBD-24 引用关系原子清理仅指向该事项的维修上门活动关联
   *   （activity_damage_links），MUST NOT 删除或修改维修上门活动本身，
   *   其他事项与该活动的关联不受影响；不因存在关联直接拒绝；
   * - 关联仪器与搬迁项目 MUST NOT 被删除或修改，项目生命周期/状态不变；
   * - 删除后该事项不再出现在事项详情、历史浏览与维修报表统计中
   *   （countItems / usedPartUsdCents / contractRatioHundredths 由剩余事项派生）；
   * - 本模块无其他真正下游不可安全删除的事实（活动经 work_facts 独立存在、
   *   维修费用仅由事项记录派生），故不做依赖拒绝。
   */
  deleteItem(id: string): void {
    this.requireItem(id);
    this.links.deleteByDamageItemId(id);
    this.items.deleteById(id);
  }

  // ---- 4.7 维修报表统计口径（本能力统计函数，供 operational-reporting 消费） ----

  /** 事项记录数量：按损坏/维修事项计数。 */
  countItems(projectId: string): number {
    return this.items.listByProject(projectId).length;
  }

  /**
   * 单条事项计入维修费用的 USD 金额（分整数）：仅备件状态为「已使用」时计入；
   * RMB 按固定汇率 1 USD = 7.2 RMB 折算为 USD，其余状态不计入（返回 0）。
   */
  usedPartUsdCents(item: DamageRepairItem): bigint {
    if (item.partStatus !== 'used') return 0n;
    if (item.partCurrency === 'RMB') {
      return Money.fromCents(item.partAmountCents).toUsd().cents;
    }
    return item.partAmountCents; // USD 直接用于统计
  }

  /**
   * 单条事项合同占比（百分之一为单位）：已使用备件折算后 USD ÷ 合同 USD 含税金额。
   * 合同金额为空或 0 时返回 null（不可计算并提示）。
   */
  contractRatioHundredths(item: DamageRepairItem, contractUsdTaxAmountCents: bigint | null): bigint | null {
    if (contractUsdTaxAmountCents === null || contractUsdTaxAmountCents <= 0n) {
      return null;
    }
    const usedUsd = Money.fromCents(this.usedPartUsdCents(item));
    const ratio = Ratio.of(usedUsd, Money.fromCents(contractUsdTaxAmountCents));
    return ratio === null ? null : ratio.hundredths;
  }

  // ---- 内部辅助 ----

  private requireItem(itemId: string): DamageRepairItem {
    const item = this.items.findById(itemId);
    if (!item) {
      throw new ValidationError('DAMAGE_ITEM_NOT_FOUND', `损坏/维修事项不存在: ${itemId}`);
    }
    return item;
  }

  /**
   * TBD-15 共享守卫：所有维修/已使用/上门关联入口统一调用。
   * 合同 USD 含税金额为空或 0 时禁止开始/完成维修、禁止备件标记「已使用」、
   * 禁止维修上门活动与事项关联（补齐正数合同金额后才允许）。
   */
  private assertRepairAllowed(projectId: string): void {
    if (!this.hasPositiveContract(projectId)) {
      throw new ValidationError(
        'CONTRACT_AMOUNT_REQUIRED',
        '合同 USD 含税金额为空或 0 时禁止开始/完成维修或标记备件已使用，请先补齐正数合同金额',
      );
    }
  }

  private hasPositiveContract(projectId: string): boolean {
    const amount = this.contractReader.findUsdTaxAmountCents(projectId);
    return amount !== null && amount > 0n;
  }

  private assertCurrency(currency: PartCurrency): void {
    if (!(PART_CURRENCIES as readonly string[]).includes(currency)) {
      throw new ValidationError('ILLEGAL_PART_CURRENCY', `备件币种仅限 ${PART_CURRENCIES.join('、')}`);
    }
  }

  private assertPartStatus(status: PartStatus): void {
    if (!(PART_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError('ILLEGAL_PART_STATUS', `备件处理状态仅限 ${PART_STATUSES.join('、')}`);
    }
  }

  private assertItemStatus(status: DamageItemStatus): void {
    if (!(DAMAGE_ITEM_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError('ILLEGAL_ITEM_STATUS', `事项处理状态仅限 ${DAMAGE_ITEM_STATUSES.join('、')}`);
    }
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}
