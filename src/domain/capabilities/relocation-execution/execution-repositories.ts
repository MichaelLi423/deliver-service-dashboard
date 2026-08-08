import type {
  Activity,
  ActivityEngineer,
  Batch,
  BatchChangeHistory,
  Instrument,
  LogisticsFee,
  WorkFact,
} from './execution-types';

/**
 * relocation-execution 仓储接口（领域服务依赖，可脱离具体持久层测试）。
 * SQLite 实现见 local-data-persistence/execution-repositories.ts。
 */

export interface BatchRepository {
  findById(id: string): Batch | undefined;
  save(batch: Batch): void;
}

export interface InstrumentRepository {
  findById(id: string): Instrument | undefined;
  /** 同一项目内序列号唯一性检查（TBD-02）。 */
  findByProjectAndSerial(projectId: string, serialNo: string): Instrument | undefined;
  listByProject(projectId: string): Instrument[];
  /** 批次归属仪器集合（批次开始运输校验：至少一台）。 */
  listByBatch(batchId: string): Instrument[];
  save(instrument: Instrument): void;
}

export interface BatchChangeHistoryRepository {
  save(history: BatchChangeHistory): void;
  listByInstrument(instrumentId: string): BatchChangeHistory[];
}

export interface ActivityRepository {
  findById(id: string): Activity | undefined;
  save(activity: Activity): void;
}

export interface ActivityEngineerRepository {
  listByActivity(activityId: string): string[];
  /** 保存一名参与工程师（同一活动可多名）。 */
  saveEngineer(engineer: ActivityEngineer): void;
}

export interface WorkFactRepository {
  findByKey(activityId: string, instrumentId: string, workType: string): WorkFact | undefined;
  save(workFact: WorkFact): void;
  listByInstrument(instrumentId: string): WorkFact[];
  listByActivity(activityId: string): WorkFact[];
}

export interface LogisticsFeeRepository {
  findByBatchId(batchId: string): LogisticsFee | undefined;
  findById(id: string): LogisticsFee | undefined;
  save(fee: LogisticsFee): void;
}
