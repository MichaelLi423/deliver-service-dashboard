import type { DatabaseSync } from 'node:sqlite';
import type {
  Activity,
  ActivityEngineer,
  Batch,
  BatchChangeHistory,
  Instrument,
  LogisticsFee,
  WorkFact,
} from '../relocation-execution';
import type {
  ActivityEngineerRepository,
  ActivityRepository,
  BatchChangeHistoryRepository,
  BatchRepository,
  InstrumentRepository,
  LogisticsFeeRepository,
  WorkFactRepository,
} from '../relocation-execution';
import { mapConstraintError, toBigInt, toBool } from './repositories';
import { prepareReadBigInt } from './connection';

/**
 * relocation-execution SQLite 仓储（tasks 3.x 落库）。
 * 唯一性以 SQLite 部分唯一索引（instruments(project_id, serial_no) WHERE serial_no
 * IS NOT NULL）为最终防线，并把约束冲突映射为领域错误。
 */

export class SqliteBatchRepository implements BatchRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): Batch | undefined {
    const row = prepareReadBigInt(this.db, 'SELECT * FROM batches WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToBatch(row) : undefined;
  }

  listAll(): Batch[] {
    const rows = prepareReadBigInt(this.db, 'SELECT * FROM batches').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToBatch);
  }

  save(batch: Batch): void {
    try {
      this.db
        .prepare(
          `INSERT INTO batches (
             id, project_id, plan_transport_date, transport_company,
             original_price_cents, discounted_price_cents, started_at,
             account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             plan_transport_date=excluded.plan_transport_date,
             transport_company=excluded.transport_company,
             original_price_cents=excluded.original_price_cents,
             discounted_price_cents=excluded.discounted_price_cents,
             started_at=excluded.started_at,
             account_id=excluded.account_id,
             username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          batch.id,
          batch.projectId,
          batch.planTransportDate,
          batch.transportCompany,
          batch.originalPriceCents === null ? null : batch.originalPriceCents.toString(),
          batch.discountedPriceCents === null ? null : batch.discountedPriceCents.toString(),
          batch.startedAt,
          batch.accountId,
          batch.usernameSnapshot,
          batch.createdAt,
          batch.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `搬迁批次保存失败`);
    }
  }
}

export class SqliteInstrumentRepository implements InstrumentRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): Instrument | undefined {
    const row = this.db.prepare('SELECT * FROM instruments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToInstrument(row) : undefined;
  }

  findByProjectAndSerial(projectId: string, serialNo: string): Instrument | undefined {
    const row = this.db
      .prepare('SELECT * FROM instruments WHERE project_id = ? AND serial_no = ?')
      .get(projectId, serialNo) as Record<string, unknown> | undefined;
    return row ? rowToInstrument(row) : undefined;
  }

  listByProject(projectId: string): Instrument[] {
    const rows = this.db
      .prepare('SELECT * FROM instruments WHERE project_id = ?')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(rowToInstrument);
  }

  listByBatch(batchId: string): Instrument[] {
    const rows = this.db
      .prepare('SELECT * FROM instruments WHERE batch_id = ?')
      .all(batchId) as Record<string, unknown>[];
    return rows.map(rowToInstrument);
  }

  save(instrument: Instrument): void {
    try {
      this.db
        .prepare(
          `INSERT INTO instruments (
             id, project_id, batch_id, name, model, manufacturer, service_level,
             serial_no, ups, qr_requested,
             destination_ship_to_id, account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             batch_id=excluded.batch_id, name=excluded.name, model=excluded.model,
             manufacturer=excluded.manufacturer, service_level=excluded.service_level,
             serial_no=excluded.serial_no, ups=excluded.ups, qr_requested=excluded.qr_requested,
             destination_ship_to_id=excluded.destination_ship_to_id,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          instrument.id,
          instrument.projectId,
          instrument.batchId,
          instrument.name,
          instrument.model,
          instrument.manufacturer,
          instrument.serviceLevel,
          instrument.serialNo,
          instrument.ups ? 1 : 0,
          instrument.qrRequested ? 1 : 0,
          instrument.destinationShipToId,
          instrument.accountId,
          instrument.usernameSnapshot,
          instrument.createdAt,
          instrument.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `搬迁仪器保存失败（序列号在同一项目内唯一）`);
    }
  }
}

export class SqliteBatchChangeHistoryRepository implements BatchChangeHistoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(history: BatchChangeHistory): void {
    try {
      this.db
        .prepare(
          `INSERT INTO batch_change_history (
             id, instrument_id, from_batch_id, to_batch_id, changed_at,
             account_id, username_snapshot, created_at
           ) VALUES (?,?,?,?,?,?,?,?)
        `,
        )
        .run(
          history.id,
          history.instrumentId,
          history.fromBatchId,
          history.toBatchId,
          history.changedAt,
          history.accountId,
          history.usernameSnapshot,
          history.changedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `改批历史保存失败`);
    }
  }

  listByInstrument(instrumentId: string): BatchChangeHistory[] {
    const rows = this.db
      .prepare('SELECT * FROM batch_change_history WHERE instrument_id = ?')
      .all(instrumentId) as Record<string, unknown>[];
    return rows.map(rowToBatchChangeHistory);
  }
}

export class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): Activity | undefined {
    const row = this.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToActivity(row) : undefined;
  }

  save(activity: Activity): void {
    try {
      this.db
        .prepare(
          `INSERT INTO activities (
             id, project_id, visit_at, account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             visit_at=excluded.visit_at,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          activity.id,
          activity.projectId,
          activity.visitAt,
          activity.accountId,
          activity.usernameSnapshot,
          activity.createdAt,
          activity.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `上门活动保存失败`);
    }
  }
}

export class SqliteActivityEngineerRepository implements ActivityEngineerRepository {
  constructor(private readonly db: DatabaseSync) {}

  listByActivity(activityId: string): string[] {
    const rows = this.db
      .prepare('SELECT engineer FROM activity_engineers WHERE activity_id = ?')
      .all(activityId) as { engineer: string }[];
    return rows.map((r) => r.engineer);
  }

  saveEngineer(engineer: ActivityEngineer): void {
    try {
      this.db
        .prepare('INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?,?,?)')
        .run(engineer.id, engineer.activityId, engineer.engineer);
    } catch (err) {
      throw mapConstraintError(err, `参与工程师保存失败`);
    }
  }
}

export class SqliteWorkFactRepository implements WorkFactRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByKey(activityId: string, instrumentId: string, workType: string): WorkFact | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM work_facts WHERE activity_id = ? AND instrument_id = ? AND work_type = ?',
      )
      .get(activityId, instrumentId, workType) as Record<string, unknown> | undefined;
    return row ? rowToWorkFact(row) : undefined;
  }

  save(workFact: WorkFact): void {
    try {
      this.db
        .prepare(
          `INSERT INTO work_facts (
             id, activity_id, instrument_id, work_type, status, started_at, completed_at,
             account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status, started_at=excluded.started_at,
             completed_at=excluded.completed_at,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          workFact.id,
          workFact.activityId,
          workFact.instrumentId,
          workFact.workType,
          workFact.status,
          workFact.startedAt,
          workFact.completedAt,
          workFact.accountId,
          workFact.usernameSnapshot,
          workFact.createdAt,
          workFact.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `工作事实保存失败`);
    }
  }

  listByInstrument(instrumentId: string): WorkFact[] {
    const rows = this.db
      .prepare('SELECT * FROM work_facts WHERE instrument_id = ?')
      .all(instrumentId) as Record<string, unknown>[];
    return rows.map(rowToWorkFact);
  }

  listByActivity(activityId: string): WorkFact[] {
    const rows = this.db
      .prepare('SELECT * FROM work_facts WHERE activity_id = ?')
      .all(activityId) as Record<string, unknown>[];
    return rows.map(rowToWorkFact);
  }
}

export class SqliteLogisticsFeeRepository implements LogisticsFeeRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByBatchId(batchId: string): LogisticsFee | undefined {
    const row = prepareReadBigInt(this.db, 'SELECT * FROM logistics_fees WHERE batch_id = ?').get(
      batchId,
    ) as Record<string, unknown> | undefined;
    return row ? rowToLogisticsFee(row) : undefined;
  }

  findById(id: string): LogisticsFee | undefined {
    const row = prepareReadBigInt(this.db, 'SELECT * FROM logistics_fees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToLogisticsFee(row) : undefined;
  }

  listAll(): LogisticsFee[] {
    const rows = prepareReadBigInt(this.db, 'SELECT * FROM logistics_fees').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToLogisticsFee);
  }

  save(fee: LogisticsFee): void {
    try {
      this.db
        .prepare(
          `INSERT INTO logistics_fees (
             id, batch_id, applied_at, budget_price_cents, deal_price_cents,
             logistics_cost_cents, account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             budget_price_cents=excluded.budget_price_cents,
             deal_price_cents=excluded.deal_price_cents,
             logistics_cost_cents=excluded.logistics_cost_cents,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          fee.id,
          fee.batchId,
          fee.appliedAt,
          fee.budgetPriceCents.toString(),
          fee.dealPriceCents.toString(),
          fee.logisticsCostCents.toString(),
          fee.accountId,
          fee.usernameSnapshot,
          fee.createdAt,
          fee.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `物流费用记录保存失败（每批次仅允许一笔）`);
    }
  }
}

// ---- row → 领域对象映射 ----

function rowToBatch(row: Record<string, unknown>): Batch {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    planTransportDate: row.plan_transport_date === null ? null : String(row.plan_transport_date),
    transportCompany: row.transport_company === null ? null : String(row.transport_company),
    originalPriceCents: toBigInt(row.original_price_cents),
    discountedPriceCents: toBigInt(row.discounted_price_cents),
    startedAt: row.started_at === null ? null : String(row.started_at),
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToBatchChangeHistory(row: Record<string, unknown>): BatchChangeHistory {
  return {
    id: String(row.id),
    instrumentId: String(row.instrument_id),
    fromBatchId: row.from_batch_id === null ? null : String(row.from_batch_id),
    toBatchId: row.to_batch_id === null ? null : String(row.to_batch_id),
    changedAt: String(row.changed_at),
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
  };
}

function rowToInstrument(row: Record<string, unknown>): Instrument {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    batchId: row.batch_id === null ? null : String(row.batch_id),
    name: String(row.name),
    model: row.model === null ? null : String(row.model),
    manufacturer: row.manufacturer === null ? null : String(row.manufacturer),
    serviceLevel: row.service_level === null ? null : String(row.service_level),
    serialNo: row.serial_no === null ? null : String(row.serial_no),
    ups: toBool(row.ups),
    qrRequested: toBool(row.qr_requested),
    destinationShipToId: row.destination_ship_to_id === null ? null : String(row.destination_ship_to_id),
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToActivity(row: Record<string, unknown>): Activity {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    visitAt: row.visit_at === null ? null : String(row.visit_at),
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToWorkFact(row: Record<string, unknown>): WorkFact {
  return {
    id: String(row.id),
    activityId: String(row.activity_id),
    instrumentId: String(row.instrument_id),
    workType: row.work_type as WorkFact['workType'],
    status: row.status as WorkFact['status'],
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToLogisticsFee(row: Record<string, unknown>): LogisticsFee {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    appliedAt: String(row.applied_at),
    budgetPriceCents: toBigInt(row.budget_price_cents) ?? 0n,
    dealPriceCents: toBigInt(row.deal_price_cents) ?? 0n,
    logisticsCostCents: toBigInt(row.logistics_cost_cents) ?? 0n,
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
