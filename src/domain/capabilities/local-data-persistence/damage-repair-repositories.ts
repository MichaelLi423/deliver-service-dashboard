import type { DatabaseSync } from 'node:sqlite';
import type {
  ActivityDamageLink,
  DamageItemStatus,
  DamageRepairItem,
  PartCurrency,
  PartStatus,
} from '../damage-repair-tracking';
import type {
  ActivityDamageLinkRepository,
  ContractAmountReader,
  DamageInstrumentReader,
  DamageRepairItemRepository,
  RepairActivityReader,
} from '../damage-repair-tracking';
import { mapConstraintError, toBigInt } from './repositories';
import { prepareReadBigInt } from './connection';

/**
 * damage-repair-tracking SQLite 仓储（tasks 4.4~4.8 落库）。
 * 事项记录、维修上门 × 事项关联，以及 TBD-24 校验所需的只读事实源。
 */

export class SqliteDamageRepairItemRepository implements DamageRepairItemRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): DamageRepairItem | undefined {
    const row = prepareReadBigInt(
      this.db,
      'SELECT * FROM damage_repair_items WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined;
    return row ? rowToDamageRepairItem(row) : undefined;
  }

  save(item: DamageRepairItem): void {
    try {
      this.db
        .prepare(
          `INSERT INTO damage_repair_items (
             id, instrument_id, project_id, damage_reason, issue_status, close_reason,
             part_number, part_quantity, part_amount_cents, part_currency,
             part_requested_at, part_status, repair_note, registered_at,
             account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             damage_reason=excluded.damage_reason, issue_status=excluded.issue_status,
             close_reason=excluded.close_reason, part_number=excluded.part_number,
             part_quantity=excluded.part_quantity, part_amount_cents=excluded.part_amount_cents,
             part_currency=excluded.part_currency, part_requested_at=excluded.part_requested_at,
             part_status=excluded.part_status, repair_note=excluded.repair_note,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          item.id,
          item.instrumentId,
          item.projectId,
          item.damageReason,
          item.issueStatus,
          item.closeReason,
          item.partNumber,
          item.partQuantity,
          item.partAmountCents.toString(),
          item.partCurrency,
          item.partRequestedAt,
          item.partStatus,
          item.repairNote,
          item.registeredAt,
          item.operatorAccountId,
          item.operatorUsername,
          item.createdAt,
          item.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `损坏/维修事项保存失败`);
    }
  }

  listByProject(projectId: string): DamageRepairItem[] {
    const rows = prepareReadBigInt(
      this.db,
      'SELECT * FROM damage_repair_items WHERE project_id = ?',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(rowToDamageRepairItem);
  }

  listAll(): DamageRepairItem[] {
    const rows = prepareReadBigInt(this.db, 'SELECT * FROM damage_repair_items').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToDamageRepairItem);
  }
}

export class SqliteActivityDamageLinkRepository implements ActivityDamageLinkRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByKey(activityId: string, damageItemId: string): ActivityDamageLink | undefined {
    const row = this.db
      .prepare('SELECT * FROM activity_damage_links WHERE activity_id = ? AND damage_item_id = ?')
      .get(activityId, damageItemId) as Record<string, unknown> | undefined;
    return row ? rowToActivityDamageLink(row) : undefined;
  }

  save(link: ActivityDamageLink): void {
    try {
      this.db
        .prepare(
          `INSERT INTO activity_damage_links (
             id, activity_id, damage_item_id, account_id, username_snapshot, created_at
           ) VALUES (?,?,?,?,?,?)
        `,
        )
        .run(
          link.id,
          link.activityId,
          link.damageItemId,
          link.operatorAccountId,
          link.operatorUsername,
          link.createdAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `维修上门活动与事项关联保存失败`);
    }
  }

  listByActivity(activityId: string): ActivityDamageLink[] {
    const rows = this.db
      .prepare('SELECT * FROM activity_damage_links WHERE activity_id = ?')
      .all(activityId) as Record<string, unknown>[];
    return rows.map(rowToActivityDamageLink);
  }

  listByDamageItem(damageItemId: string): ActivityDamageLink[] {
    const rows = this.db
      .prepare('SELECT * FROM activity_damage_links WHERE damage_item_id = ?')
      .all(damageItemId) as Record<string, unknown>[];
    return rows.map(rowToActivityDamageLink);
  }
}

/** 搬迁仪器只读事实源（SQLite）。 */
export class SqliteDamageInstrumentReader implements DamageInstrumentReader {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): { id: string; projectId: string; serialNo: string | null } | undefined {
    const row = this.db
      .prepare('SELECT id, project_id, serial_no FROM instruments WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      serialNo: row.serial_no === null ? null : String(row.serial_no),
    };
  }
}

/** 维修上门活动只读事实源（SQLite）：活动存在性、仪器集合与工作类型。 */
export class SqliteRepairActivityReader implements RepairActivityReader {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): { id: string; projectId: string } | undefined {
    const row = this.db
      .prepare('SELECT id, project_id FROM activities WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: String(row.id), projectId: String(row.project_id) };
  }

  listInstrumentIds(activityId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT instrument_id FROM work_facts WHERE activity_id = ?')
      .all(activityId) as { instrument_id: string }[];
    return rows.map((r) => r.instrument_id);
  }

  hasWorkType(activityId: string, workType: string): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM work_facts WHERE activity_id = ? AND work_type = ?')
      .get(activityId, workType) as { n: number };
    return row.n > 0;
  }
}

/** 合同 USD 含税金额只读事实源（SQLite，TBD-15 维修限制）。 */
export class SqliteContractAmountReader implements ContractAmountReader {
  constructor(private readonly db: DatabaseSync) {}

  findUsdTaxAmountCents(projectId: string): bigint | null {
    const row = prepareReadBigInt(
      this.db,
      'SELECT usd_tax_amount_cents FROM contracts WHERE project_id = ?',
    ).get(projectId) as { usd_tax_amount_cents: bigint | string | number | null } | undefined;
    return row === undefined ? null : toBigInt(row.usd_tax_amount_cents);
  }
}

// ---- row → 领域对象映射 ----

function rowToDamageRepairItem(row: Record<string, unknown>): DamageRepairItem {
  return {
    id: String(row.id),
    instrumentId: String(row.instrument_id),
    projectId: String(row.project_id),
    damageReason: row.damage_reason === null ? null : String(row.damage_reason),
    issueStatus: row.issue_status as DamageItemStatus,
    closeReason: row.close_reason === null ? null : String(row.close_reason),
    // 严禁 String(null)：旧数据/占位行未填备件信息时保留空值，不产生 "null" 字符串。
    partNumber: row.part_number === null ? '' : String(row.part_number),
    partQuantity: row.part_quantity === null ? 0 : Number(row.part_quantity),
    partAmountCents: toBigInt(row.part_amount_cents) ?? 0n,
    partCurrency: row.part_currency as PartCurrency,
    partRequestedAt: row.part_requested_at === null ? null : String(row.part_requested_at),
    partStatus: row.part_status === null ? null : (row.part_status as PartStatus),
    repairNote: row.repair_note === null ? null : String(row.repair_note),
    registeredAt: String(row.registered_at),
    operatorAccountId: row.account_id === null ? null : String(row.account_id),
    operatorUsername: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToActivityDamageLink(row: Record<string, unknown>): ActivityDamageLink {
  return {
    id: String(row.id),
    activityId: String(row.activity_id),
    damageItemId: String(row.damage_item_id),
    operatorAccountId: row.account_id === null ? null : String(row.account_id),
    operatorUsername: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
  };
}
