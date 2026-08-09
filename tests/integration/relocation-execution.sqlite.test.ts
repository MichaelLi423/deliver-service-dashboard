import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteBatchChangeHistoryRepository,
  SqliteBatchRepository,
  SqliteActivityEngineerRepository,
  SqliteActivityRepository,
  SqliteInstrumentRepository,
  SqliteLogisticsFeeRepository,
  SqliteWorkFactRepository,
} from '../../src/domain/capabilities/local-data-persistence/execution-repositories';
import {
  SqliteContractRepository,
  SqliteCustomerRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import { ExecutionService } from '../../src/domain/capabilities/relocation-execution/execution-service';
import type { ExecutionLifecycleGateway } from '../../src/domain/capabilities/relocation-execution/execution-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { FixedClock } from '../../src/domain/core/time';
import { Money } from '../../src/domain/core/money';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * relocation-execution SQLite 集成（tasks 3.11）。
 * 验证 3.1~3.7 的领域行为在真实临时 SQLite 上落库、关闭重开保留，
 * 账号归属快照持久化，以及「首次执行触发 lifecycle 执行中」联动。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  // 测试账号：归属快照引用的本地账号（id = account-1）
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');
  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoices = new SqliteInvoiceReadRepository(db);
  const projectService = new ProjectService(projects, contracts, invoices, CLOCK);
  const batches = new SqliteBatchRepository(db);
  const instruments = new SqliteInstrumentRepository(db);
  const batchChanges = new SqliteBatchChangeHistoryRepository(db);
  const activities = new SqliteActivityRepository(db);
  const engineers = new SqliteActivityEngineerRepository(db);
  const workFacts = new SqliteWorkFactRepository(db);
  const fees = new SqliteLogisticsFeeRepository(db);
  const gateway: ExecutionLifecycleGateway = {
    onExecutionStarted: (pid) => {
      projectService.adjustStatus(pid, 'executing', { executionStarted: true });
    },
  };
  const service = new ExecutionService(
    batches,
    instruments,
    batchChanges,
    activities,
    engineers,
    workFacts,
    fees,
    gateway,
    CLOCK,
  );
  return {
    db,
    dbPath,
    projects,
    contracts,
    projectService,
    batches,
    instruments,
    batchChanges,
    activities,
    engineers,
    workFacts,
    fees,
    service,
  };
}

let customerSeq = 0;

/** 构造正式进单后的项目（可立即投入执行）。 */
function prepareEnteredProject(ctx: ReturnType<typeof openService>): string {
  customerSeq += 1;
  const customer = new CustomerService(new SqliteCustomerRepository(ctx.db)).register(
    `执行客户${customerSeq}`,
  );
  const project = ctx.projectService.createPendingProject();
  const contract = ctx.projectService.attachContract(project.id);
  new ContractService().setUsdTaxAmount(contract, Money.parse('10000'));
  ctx.contracts.save(contract);
  ctx.projectService.linkCustomer(project.id, customer.id);
  ctx.projectService.confirmScope(project.id);
  ctx.projectService.formalEntry(project.id, { ecc: `ECC-EXEC-${customerSeq}` });
  return project.id;
}

describe('relocation-execution SQLite 集成（3.11）', () => {
  it('仪器/批次/改批/活动/工作事实/报价/物流费用全部落库，关闭重开保留', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = ctx.projectService.createPendingProject().id;
      const batch = ctx.service.createBatch(projectId, ACTOR);
      const instrument = ctx.service.registerInstrument(projectId, {
        name: '仪器A',
        model: 'M-1',
        serialNo: 'SN-900',
        ups: true,
        qrRequested: true,
      }, ACTOR);
      ctx.service.setInstrumentBatch(instrument.id, batch.id, ACTOR);
      ctx.service.updateBatchQuote(batch.id, {
        planTransportDate: '2026-08-10',
        transportCompany: '顺丰',
        originalPriceCents: 100000n,
        discountedPriceCents: 90000n,
      }, ACTOR);
      const activity = ctx.service.createActivity(projectId, '2026-08-09', ['工程师甲', '工程师乙'], ACTOR);
      ctx.service.startWorkFact(activity.id, instrument.id, 'teardown', ACTOR);
      ctx.service.completeWorkFact(activity.id, instrument.id, 'teardown', ACTOR);
      const { fee } = ctx.service.recordLogisticsFee(batch.id, {
        appliedAt: '2026-08-06',
        budgetPriceCents: 10000n,
        dealPriceCents: 12000n,
        logisticsCostCents: 11000n,
      }, ACTOR);

      closeDatabase(ctx.db);

      // 关闭重开：数据保留
      const reopened = openService(dir);
      expect(reopened.instruments.findById(instrument.id)?.serialNo).toBe('SN-900');
      expect(reopened.batches.findById(batch.id)?.transportCompany).toBe('顺丰');
      expect(reopened.batches.findById(batch.id)?.originalPriceCents).toBe(100000n);
      expect(reopened.activities.findById(activity.id)?.visitAt).toBe('2026-08-09');
      expect(reopened.engineers.listByActivity(activity.id)).toEqual(['工程师甲', '工程师乙']);
      expect(reopened.workFacts.listByActivity(activity.id)[0].status).toBe('done');
      expect(reopened.workFacts.listByInstrument(instrument.id)).toHaveLength(1);
      expect(reopened.fees.findByBatchId(batch.id)?.dealPriceCents).toBe(12000n);
      expect(reopened.batchChanges.listByInstrument(instrument.id)).toHaveLength(1);
      expect(reopened.service.getInstrumentProgress(instrument.id).teardown).toBe('done');
      expect(reopened.service.getLogisticsFeeDifference(fee)).toBe(1000n);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('首次执行触发 lifecycle 执行中：首个工作事实开始 / 首个批次开始运输', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = prepareEnteredProject(ctx);
      expect(ctx.projects.findById(projectId)!.status).toBe('pending_entry');

      // 批次开始运输 → 执行中
      const batch = ctx.service.createBatch(projectId, ACTOR);
      const instrument = ctx.service.registerInstrument(projectId, { name: '仪器B' }, ACTOR);
      ctx.service.setInstrumentBatch(instrument.id, batch.id, ACTOR);
      ctx.service.startBatchTransport(batch.id, ACTOR);
      expect(ctx.projects.findById(projectId)!.status).toBe('executing');
      expect(
        ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status,
      ).toBe('executing');

      // 另一个项目：首个上门活动工作事实开始 → 执行中（创建活动/排期不计）
      const projectId2 = prepareEnteredProject(ctx);
      const activity = ctx.service.createActivity(projectId2, null, ['工程师甲'], ACTOR);
      expect(ctx.projects.findById(projectId2)!.status).toBe('pending_entry'); // 仅排期不计
      const i2 = ctx.service.registerInstrument(projectId2, { name: '仪器C' }, ACTOR);
      ctx.service.startWorkFact(activity.id, i2.id, 'teardown', ACTOR);
      expect(ctx.projects.findById(projectId2)!.status).toBe('executing');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号归属快照持久化：改批/仪器/活动/工作事实/物流费用绑定当前登录账号', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = ctx.projectService.createPendingProject().id;
      const batch = ctx.service.createBatch(projectId, ACTOR);
      const instrument = ctx.service.registerInstrument(projectId, { name: '仪器D' }, ACTOR);
      ctx.service.setInstrumentBatch(instrument.id, batch.id, ACTOR);
      const activity = ctx.service.createActivity(projectId, null, ['工程师甲'], ACTOR);
      ctx.service.startWorkFact(activity.id, instrument.id, 'teardown', ACTOR);
      ctx.service.recordLogisticsFee(batch.id, {
        appliedAt: '2026-08-06',
        budgetPriceCents: 10000n,
        dealPriceCents: 12000n,
        logisticsCostCents: 11000n,
      }, ACTOR);

      const history = ctx.db
        .prepare('SELECT account_id, username_snapshot FROM batch_change_history WHERE instrument_id = ?')
        .get(instrument.id) as { account_id: string; username_snapshot: string };
      expect(history.account_id).toBe('account-1');
      expect(history.username_snapshot).toBe('负责人甲');

      const rows = ctx.db.prepare(`
        SELECT (SELECT account_id FROM instruments WHERE id = ?) AS ins,
               (SELECT account_id FROM activities WHERE id = ?) AS act,
               (SELECT account_id FROM work_facts WHERE activity_id = ?) AS fact,
               (SELECT account_id FROM logistics_fees WHERE batch_id = ?) AS fee
      `).get(instrument.id, activity.id, activity.id, batch.id) as Record<string, string | null>;
      expect(rows.ins).toBe('account-1');
      expect(rows.act).toBe('account-1');
      expect(rows.fact).toBe('account-1');
      expect(rows.fee).toBe('account-1');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('序列号唯一性与每批次一笔物流费用：数据库唯一索引兜底', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = ctx.projectService.createPendingProject().id;
      const projectId2 = ctx.projectService.createPendingProject().id;
      ctx.service.registerInstrument(projectId, { name: '仪器E', serialNo: 'SN-100' }, ACTOR);

      // 绕过领域层直接插入同项目重复序列号 → 被 SQLite 部分唯一索引拒绝
      expect(() =>
        ctx.db.prepare(
          'INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        ).run('i-dup', projectId, '重复仪器', 'SN-100', 't', 't'),
      ).toThrow();
      // 跨项目重复允许
      expect(() =>
        ctx.db.prepare(
          'INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        ).run('i-ok', projectId2, '跨项目仪器', 'SN-100', 't', 't'),
      ).not.toThrow();
      // 无序列号占位允许
      expect(() =>
        ctx.db.prepare(
          'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
        ).run('i-ph', projectId2, '占位仪器', 't', 't'),
      ).not.toThrow();

      // 每批次仅一笔物流费用：唯一索引兜底
      const batch = ctx.service.createBatch(projectId, ACTOR);
      ctx.service.recordLogisticsFee(batch.id, {
        appliedAt: '2026-08-06',
        budgetPriceCents: 10000n,
        dealPriceCents: 12000n,
        logisticsCostCents: 11000n,
      }, ACTOR);
      expect(() =>
        ctx.db.prepare(
          'INSERT INTO logistics_fees (id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run('f-dup', batch.id, '2026-08-07', 10000, 12000, 11000, 't', 't'),
      ).toThrow();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
