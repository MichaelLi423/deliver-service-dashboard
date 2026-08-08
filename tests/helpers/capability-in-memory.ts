import type { ShipTo, ShipToRequest } from '../../src/domain/capabilities/ship-to-management';
import type {
  ShipToAddressReader,
  ShipToRepository,
  ShipToRequestRepository,
} from '../../src/domain/capabilities/ship-to-management';
import type { SerialAddressUpdate } from '../../src/domain/capabilities/serial-address-update';
import type { SerialAddressUpdateRepository } from '../../src/domain/capabilities/serial-address-update';
import type {
  ActivityDamageLink,
  DamageRepairItem,
} from '../../src/domain/capabilities/damage-repair-tracking';
import type {
  ActivityDamageLinkRepository,
  ContractAmountReader,
  DamageRepairItemRepository,
  RepairActivityReader,
} from '../../src/domain/capabilities/damage-repair-tracking';
import type { QrRequest } from '../../src/domain/capabilities/qr-request-tracking';
import type { QrRequestRepository } from '../../src/domain/capabilities/qr-request-tracking';
import type { ReminderSettingsRepository } from '../../src/domain/capabilities/workbench-todos';
import { InMemoryActivityRepository, InMemoryWorkFactRepository } from './execution-in-memory';

/**
 * 4.x 能力内存仓储（领域测试；tasks 4.1~4.10 场景）。
 * SQLite 实现见 src/domain/capabilities/local-data-persistence/ 下对应仓库文件。
 */

// ---- ship-to-management ----

export class InMemoryShipToRepository implements ShipToRepository {
  private readonly store = new Map<string, ShipTo>();

  findById(id: string): ShipTo | undefined {
    return this.store.get(id);
  }

  findByAccountId(accountId: string): ShipTo | undefined {
    return [...this.store.values()].find((s) => s.accountId === accountId);
  }

  save(shipTo: ShipTo): void {
    this.store.set(shipTo.id, shipTo);
  }

  listAll(): ShipTo[] {
    return [...this.store.values()];
  }

  get all(): ShipTo[] {
    return [...this.store.values()];
  }
}

export class InMemoryShipToRequestRepository implements ShipToRequestRepository {
  private readonly store = new Map<string, ShipToRequest>();

  findById(id: string): ShipToRequest | undefined {
    return this.store.get(id);
  }

  findByAccountId(accountId: string): ShipToRequest | undefined {
    return [...this.store.values()].find((r) => r.accountId === accountId);
  }

  findByCustomerAndAddress(customerName: string, newSiteAddress: string): ShipToRequest | undefined {
    return [...this.store.values()].find(
      (r) => r.customerName === customerName && r.newSiteAddress === newSiteAddress,
    );
  }

  save(request: ShipToRequest): void {
    this.store.set(request.id, request);
  }

  listAll(): ShipToRequest[] {
    return [...this.store.values()];
  }

  get all(): ShipToRequest[] {
    return [...this.store.values()];
  }
}

/** 批次/项目所涉 Ship-to 只读事实源（内存版）。 */
export class InMemoryShipToAddressReader implements ShipToAddressReader {
  constructor(private readonly instruments: { id: string; batchId: string | null; projectId: string; destinationShipToId: string | null }[]) {}

  listInstrumentIdsByBatch(batchId: string): string[] {
    return this.instruments.filter((i) => i.batchId === batchId).map((i) => i.id);
  }

  listInstrumentIdsByProject(projectId: string): string[] {
    return this.instruments.filter((i) => i.projectId === projectId).map((i) => i.id);
  }

  listDestinationShipToIds(instrumentIds: string[]): string[] {
    const ids = new Set<string>();
    for (const instrument of this.instruments) {
      if (instrumentIds.includes(instrument.id) && instrument.destinationShipToId !== null) {
        ids.add(instrument.destinationShipToId);
      }
    }
    return [...ids];
  }
}

// ---- serial-address-update ----

export class InMemorySerialAddressUpdateRepository implements SerialAddressUpdateRepository {
  private readonly store = new Map<string, SerialAddressUpdate>();

  findById(id: string): SerialAddressUpdate | undefined {
    return this.store.get(id);
  }

  save(update: SerialAddressUpdate): void {
    this.store.set(update.id, update);
  }

  listAll(): SerialAddressUpdate[] {
    return [...this.store.values()];
  }

  get all(): SerialAddressUpdate[] {
    return [...this.store.values()];
  }
}

// ---- damage-repair-tracking ----

export class InMemoryDamageRepairItemRepository implements DamageRepairItemRepository {
  private readonly store = new Map<string, DamageRepairItem>();

  findById(id: string): DamageRepairItem | undefined {
    return this.store.get(id);
  }

  save(item: DamageRepairItem): void {
    this.store.set(item.id, item);
  }

  listByProject(projectId: string): DamageRepairItem[] {
    return [...this.store.values()].filter((i) => i.projectId === projectId);
  }

  listAll(): DamageRepairItem[] {
    return [...this.store.values()];
  }

  get all(): DamageRepairItem[] {
    return [...this.store.values()];
  }
}

export class InMemoryActivityDamageLinkRepository implements ActivityDamageLinkRepository {
  private readonly store = new Map<string, ActivityDamageLink>();

  findByKey(activityId: string, damageItemId: string): ActivityDamageLink | undefined {
    return [...this.store.values()].find(
      (l) => l.activityId === activityId && l.damageItemId === damageItemId,
    );
  }

  save(link: ActivityDamageLink): void {
    this.store.set(link.id, link);
  }

  listByActivity(activityId: string): ActivityDamageLink[] {
    return [...this.store.values()].filter((l) => l.activityId === activityId);
  }

  listByDamageItem(damageItemId: string): ActivityDamageLink[] {
    return [...this.store.values()].filter((l) => l.damageItemId === damageItemId);
  }

  get all(): ActivityDamageLink[] {
    return [...this.store.values()];
  }
}

/** 维修上门活动只读事实源（内存版，基于执行侧内存仓储）。 */
export class InMemoryRepairActivityReader implements RepairActivityReader {
  constructor(
    private readonly activities: InMemoryActivityRepository,
    private readonly workFacts: InMemoryWorkFactRepository,
  ) {}

  findById(id: string): { id: string; projectId: string } | undefined {
    const activity = this.activities.findById(id);
    return activity ? { id: activity.id, projectId: activity.projectId } : undefined;
  }

  listInstrumentIds(activityId: string): string[] {
    return [...new Set(this.workFacts.listByActivity(activityId).map((f) => f.instrumentId))];
  }

  hasWorkType(activityId: string, workType: string): boolean {
    return this.workFacts.listByActivity(activityId).some((f) => f.workType === workType);
  }
}

/** 合同 USD 含税金额只读事实源（内存版）。 */
export class InMemoryContractAmountReader implements ContractAmountReader {
  private readonly amounts = new Map<string, bigint>();

  set(projectId: string, usdTaxAmountCents: bigint | null): void {
    if (usdTaxAmountCents === null) {
      this.amounts.delete(projectId);
    } else {
      this.amounts.set(projectId, usdTaxAmountCents);
    }
  }

  findUsdTaxAmountCents(projectId: string): bigint | null {
    return this.amounts.has(projectId) ? this.amounts.get(projectId)! : null;
  }
}

// ---- qr-request-tracking ----

export class InMemoryQrRequestRepository implements QrRequestRepository {
  private readonly store = new Map<string, QrRequest>();

  findById(id: string): QrRequest | undefined {
    return this.store.get(id);
  }

  save(request: QrRequest): void {
    this.store.set(request.id, request);
  }

  listAll(): QrRequest[] {
    return [...this.store.values()];
  }

  get all(): QrRequest[] {
    return [...this.store.values()];
  }
}

// ---- workbench-todos ----

/** 临期窗口配置内存仓储（默认未配置 → null，由领域层取默认 7 个自然日）。 */
export class InMemoryReminderSettingsRepository implements ReminderSettingsRepository {
  private days: number | null = null;

  getUpcomingWindowDays(): number | null {
    return this.days;
  }

  setUpcomingWindowDays(days: number): void {
    this.days = days;
  }
}
