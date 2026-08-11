import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../../core/errors';
import type {
  ActivityRepository,
  BatchRepository,
  InstrumentRepository,
  LogisticsFeeRepository,
} from './execution-repositories';

/**
 * 执行记录的受保护删除入口。
 *
 * 上门活动、批次和仪器的依赖规则及其自有子记录由 relocation-execution 拥有；调用方
 * 只负责在外层事务中协调审计。SQLite 删除语句集中于此，避免主进程协调层知晓执行表。
 */
export class ProtectedExecutionDeletionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly activities: ActivityRepository,
    private readonly batches: BatchRepository,
    private readonly instruments: InstrumentRepository,
    private readonly fees: LogisticsFeeRepository,
  ) {}

  deleteActivity(id: string): { projectId: string; ownedChildCount: number } {
    const activity = this.activities.findById(id);
    if (!activity) throw new ValidationError('EXECUTION_ACTIVITY_NOT_FOUND', `上门活动不存在: ${id}`);
    this.assertNoDependency('work_facts', 'activity_id', id, '该上门活动已产生工作事实，无法删除；请先处理工作事实');
    this.assertNoDependency('activity_damage_links', 'activity_id', id, '该上门活动已关联损坏/维修事项，无法删除；请先解除维修关联');
    const ownedChildCount = this.count('activity_engineers', 'activity_id', id);
    this.db.prepare('DELETE FROM activity_engineers WHERE activity_id = ?').run(id);
    this.db.prepare('DELETE FROM activities WHERE id = ?').run(id);
    return { projectId: activity.projectId, ownedChildCount };
  }

  deleteBatch(id: string): { projectId: string; ownedChildCount: number; feeId?: string } {
    const batch = this.batches.findById(id);
    if (!batch) throw new ValidationError('EXECUTION_BATCH_NOT_FOUND', `搬迁批次不存在: ${id}`);
    if (batch.startedAt !== null) {
      throw new ValidationError('EXECUTION_DELETE_DEPENDENCIES', '该搬迁批次已开始运输，无法删除');
    }
    this.assertNoDependency('instruments', 'batch_id', id, '该搬迁批次仍存在当前仪器，无法删除；请先解绑仪器');
    if (this.exists('batch_change_history', 'from_batch_id', id) || this.exists('batch_change_history', 'to_batch_id', id)) {
      throw new ValidationError('EXECUTION_DELETE_DEPENDENCIES', '该搬迁批次存在改批历史，无法删除');
    }
    const fee = this.fees.findByBatchId(id);
    if (fee) this.db.prepare('DELETE FROM logistics_fees WHERE id = ?').run(fee.id);
    this.db.prepare('DELETE FROM batches WHERE id = ?').run(id);
    return { projectId: batch.projectId, ownedChildCount: fee ? 1 : 0, feeId: fee?.id };
  }

  deleteInstrument(id: string): { projectId: string; ownedChildCount: number } {
    const instrument = this.instruments.findById(id);
    if (!instrument) throw new ValidationError('EXECUTION_INSTRUMENT_NOT_FOUND', `搬迁仪器不存在: ${id}`);
    const batch = instrument.batchId ? this.batches.findById(instrument.batchId) : undefined;
    if (batch?.startedAt !== null && batch?.startedAt !== undefined) {
      throw new ValidationError('EXECUTION_DELETE_DEPENDENCIES', '该搬迁仪器所属批次已开始运输，无法删除');
    }
    for (const [table, column] of [
      ['damage_repair_items', 'instrument_id'],
      ['work_facts', 'instrument_id'],
      ['batch_change_history', 'instrument_id'],
      ['serial_address_updates', 'instrument_id'],
    ]) {
      this.assertNoDependency(table, column, id, `该搬迁仪器存在依赖记录（${table}），无法安全删除；请先处理依赖记录`);
    }
    this.db.prepare('DELETE FROM instruments WHERE id = ?').run(id);
    return { projectId: instrument.projectId, ownedChildCount: 0 };
  }

  private exists(table: string, column: string, value: string): boolean {
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value) !== undefined;
  }

  private count(table: string, column: string, value: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number }).n;
  }

  private assertNoDependency(table: string, column: string, value: string, message: string): void {
    if (this.exists(table, column, value)) throw new ValidationError('EXECUTION_DELETE_DEPENDENCIES', message);
  }
}
