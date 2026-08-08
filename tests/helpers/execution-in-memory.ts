import type {
  Activity,
  ActivityEngineer,
  Batch,
  BatchChangeHistory,
  Instrument,
  LogisticsFee,
  WorkFact,
} from '../../src/domain/capabilities/relocation-execution';
import type {
  ActivityEngineerRepository,
  ActivityRepository,
  BatchChangeHistoryRepository,
  BatchRepository,
  InstrumentRepository,
  LogisticsFeeRepository,
  WorkFactRepository,
} from '../../src/domain/capabilities/relocation-execution';

/**
 * relocation-execution 内存仓储（领域测试；tasks 3.1~3.7 场景）。
 * SQLite 实现见 src/domain/capabilities/local-data-persistence/execution-repositories.ts。
 */

export class InMemoryBatchRepository implements BatchRepository {
  private readonly store = new Map<string, Batch>();

  findById(id: string): Batch | undefined {
    return this.store.get(id);
  }

  save(batch: Batch): void {
    this.store.set(batch.id, batch);
  }

  get all(): Batch[] {
    return [...this.store.values()];
  }
}

export class InMemoryInstrumentRepository implements InstrumentRepository {
  private readonly store = new Map<string, Instrument>();

  findById(id: string): Instrument | undefined {
    return this.store.get(id);
  }

  findByProjectAndSerial(projectId: string, serialNo: string): Instrument | undefined {
    return [...this.store.values()].find(
      (i) => i.projectId === projectId && i.serialNo === serialNo,
    );
  }

  listByProject(projectId: string): Instrument[] {
    return [...this.store.values()].filter((i) => i.projectId === projectId);
  }

  listByBatch(batchId: string): Instrument[] {
    return [...this.store.values()].filter((i) => i.batchId === batchId);
  }

  save(instrument: Instrument): void {
    this.store.set(instrument.id, instrument);
  }

  get all(): Instrument[] {
    return [...this.store.values()];
  }
}

export class InMemoryBatchChangeHistoryRepository implements BatchChangeHistoryRepository {
  private readonly store = new Map<string, BatchChangeHistory>();

  save(history: BatchChangeHistory): void {
    this.store.set(history.id, history);
  }

  listByInstrument(instrumentId: string): BatchChangeHistory[] {
    return [...this.store.values()].filter((h) => h.instrumentId === instrumentId);
  }

  get all(): BatchChangeHistory[] {
    return [...this.store.values()];
  }
}

export class InMemoryActivityRepository implements ActivityRepository {
  private readonly store = new Map<string, Activity>();

  findById(id: string): Activity | undefined {
    return this.store.get(id);
  }

  save(activity: Activity): void {
    this.store.set(activity.id, activity);
  }

  get all(): Activity[] {
    return [...this.store.values()];
  }
}

export class InMemoryActivityEngineerRepository implements ActivityEngineerRepository {
  private readonly store = new Map<string, ActivityEngineer>();

  listByActivity(activityId: string): string[] {
    return [...this.store.values()]
      .filter((e) => e.activityId === activityId)
      .map((e) => e.engineer);
  }

  saveEngineer(engineer: ActivityEngineer): void {
    this.store.set(engineer.id, engineer);
  }
}

export class InMemoryWorkFactRepository implements WorkFactRepository {
  private readonly store = new Map<string, WorkFact>();

  findByKey(activityId: string, instrumentId: string, workType: string): WorkFact | undefined {
    return [...this.store.values()].find(
      (f) =>
        f.activityId === activityId && f.instrumentId === instrumentId && f.workType === workType,
    );
  }

  save(workFact: WorkFact): void {
    this.store.set(workFact.id, workFact);
  }

  listByInstrument(instrumentId: string): WorkFact[] {
    return [...this.store.values()].filter((f) => f.instrumentId === instrumentId);
  }

  listByActivity(activityId: string): WorkFact[] {
    return [...this.store.values()].filter((f) => f.activityId === activityId);
  }

  get all(): WorkFact[] {
    return [...this.store.values()];
  }
}

export class InMemoryLogisticsFeeRepository implements LogisticsFeeRepository {
  private readonly store = new Map<string, LogisticsFee>();

  findByBatchId(batchId: string): LogisticsFee | undefined {
    return [...this.store.values()].find((f) => f.batchId === batchId);
  }

  findById(id: string): LogisticsFee | undefined {
    return this.store.get(id);
  }

  save(fee: LogisticsFee): void {
    this.store.set(fee.id, fee);
  }

  get all(): LogisticsFee[] {
    return [...this.store.values()];
  }
}
