import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteContractRepository,
  SqliteCustomerRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import { SqliteDuePlanVisitAdvancer } from '../../src/domain/capabilities/local-data-persistence';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { FixedClock } from '../../src/domain/core/time';
import { Money } from '../../src/domain/core/money';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * relocation-project-lifecycle SQLite 集成（tasks 2.9）。
 * 验证 2.1~2.7 的领域行为在真实临时 SQLite 上落库、关闭重开保留。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoices = new SqliteInvoiceReadRepository(db);
  const service = new ProjectService(projects, contracts, invoices, CLOCK);
  return { db, dbPath, projects, contracts, invoices, service };
}

let customerSeq = 0;

function prepareEnterableProject(
  db: DatabaseSync,
  contracts: SqliteContractRepository,
  service: ProjectService,
) {
  customerSeq += 1;
  const customer = new CustomerService(new SqliteCustomerRepository(db)).register(
    `集成客户${customerSeq}`,
  );
  const project = service.createPendingProject();
  const contract = service.attachContract(project.id);
  new ContractService().setUsdTaxAmount(contract, Money.parse('10000'));
  contracts.save(contract); // 金额变更需落库（领域服务对对象做变更，持久化经仓储）
  service.linkCustomer(project.id, customer.id);
  service.confirmScope(project.id);
  return { projectId: project.id, contractId: contract.id };
}

describe('relocation-project-lifecycle SQLite 集成（2.9）', () => {
  it('正式进单全流程落库（ECC/进单时间/快照/最终金额），关闭重开保留', () => {
    const dir = makeTempDir();
    try {
      const { db, contracts, service } = openService(dir);
      new CustomerService(new SqliteCustomerRepository(db)).register('华东医药');
      const { projectId } = prepareEnterableProject(db, contracts, service);

      const entered = service.formalEntry(projectId, {
        ecc: 'ECC-001',
        entryAt: '2026-07-01',
      });
      expect(entered.status).toBe('pending_execution');

      const contract = contracts.findByProjectId(projectId)!;
      expect(contract.ecc).toBe('ECC-001');
      expect(contract.eccLastModifiedAt).toBe('2026-08-07T10:00:00+08:00');
      expect(contract.entryAmountSnapshotCents).toBe(1000000n);
      expect(contract.finalConfirmableAmountCents).toBe(1000000n);

      closeDatabase(db);

      // 关闭重开：数据保留
      const reopened = openService(dir);
      expect(reopened.projects.findById(projectId)!.entryAt).toBe('2026-07-01');
      expect(reopened.contracts.findByProjectId(projectId)!.ecc).toBe('ECC-001');
      expect(reopened.contracts.findByProjectId(projectId)!.entryAmountSnapshotCents).toBe(
        1000000n,
      );
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('ECC 全局唯一：领域校验 + SQLite 部分唯一索引兜底', () => {
    const dir = makeTempDir();
    try {
      const { db, contracts, service } = openService(dir);
      const a = prepareEnterableProject(db, contracts, service);
      service.formalEntry(a.projectId, { ecc: 'ECC-001' });

      const b = prepareEnterableProject(db, contracts, service);
      expect(() => service.formalEntry(b.projectId, { ecc: 'ECC-001' })).toThrow();

      // 绕过领域层直接 UPDATE 仍被数据库唯一索引拒绝
      expect(() => db.prepare('UPDATE contracts SET ecc = ? WHERE project_id = ?').run('ECC-001', b.projectId)).toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('有掉票历史（含已撤销）禁止取消；取消保留已发生的上门活动与物流记录', () => {
    const dir = makeTempDir();
    try {
      const { db, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-001' });
      service.adjustStatus(projectId, 'executing');

      // 已发生的上门活动与物流费用记录
      db.prepare(
        'INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('act-1', projectId, '2026-07-20', 't', 't');
      db.prepare(
        'INSERT INTO batches (id, project_id, plan_transport_date, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('batch-1', projectId, '2026-07-21', 't', 't');
      db.prepare(
        'INSERT INTO logistics_fees (id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('fee-1', 'batch-1', '2026-07-21', 10000, 11000, 10500, 't', 't');

      // 存在掉票记录 → 禁止取消
      db.prepare(
        'INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at) VALUES (?,?,?,?,?,?)',
      ).run('inv-1', projectId, 500000, '2026-08-01', 't', 't');
      expect(() =>
        service.cancelProject(projectId, {
          time: '2026-08-07',
          reason: '客户取消搬迁计划',
        }),
      ).toThrow(/掉票历史/);

      // 撤销掉票（终态）后仍存在掉票历史 → 仍禁止取消（含已撤销）
      db.prepare('UPDATE invoices SET revoked_at = ?, revoke_reason = ? WHERE id = ?').run(
        '2026-08-02',
        '撤销',
        'inv-1',
      );
      expect(() =>
        service.cancelProject(projectId, {
          time: '2026-08-07',
          reason: '客户取消搬迁计划',
        }),
      ).toThrow(/掉票历史/);

      // 移除掉票历史后取消成功
      db.prepare('DELETE FROM invoices WHERE id = ?').run('inv-1');
      const cancelled = service.cancelProject(projectId, {
        time: '2026-08-07',
        reason: '客户取消搬迁计划',
      });
      expect(cancelled.status).toBe('cancelled');

      // 上门活动与物流记录保留（取消只改变项目状态）
      expect(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE project_id = ?').get(projectId)?.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE batch_id = ?').get('batch-1')?.n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('实际装机完成自动待验收并持久化；计划时间与场地确认不触发', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-001' });
      service.adjustStatus(projectId, 'executing');

      // 计划时间与场地确认不触发状态流转
      service.updateExecutionPreparation(projectId, {
        planVisitAt: '2026-08-01',
        planTransportAt: '2026-08-02',
        siteConfirmed: true,
      });
      expect(projects.findById(projectId)!.status).toBe('executing');

      // 实际装机完成 → 待验收（持久化）
      service.recordActualInstallDone(projectId, '2026-08-05');
      expect(projects.findById(projectId)!.status).toBe('pending_acceptance');
      expect(
        db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status,
      ).toBe('pending_acceptance');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('未进单先执行 → 正式进单在原项目上完成，自动触发待验收', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.setPreEntryExecution(projectId, {
        reason: '客户产线停产急需搬迁',
        missingItems: '合同金额待定',
      });
      service.recordActualInstallDone(projectId, '2026-07-20');
      expect(projects.findById(projectId)!.status).toBe('pending_entry');

      service.formalEntry(projectId, { ecc: 'ECC-001' });
      const project = projects.findById(projectId)!;
      expect(project.id).toBe(projectId); // 在原项目上进单、不新建项目
      expect(project.preEntryExecution).toBe(false);
      expect(project.status).toBe('pending_acceptance'); // 自动触发优先
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('区域 trim 后持久化，修改后按最新值分组', () => {
    const dir = makeTempDir();
    try {
      const { db, service } = openService(dir);
      const projectId = service.createPendingProject().id;
      service.setRegion(projectId, '  East ');
      expect(db.prepare('SELECT region FROM projects WHERE id = ?').get(projectId)?.region).toBe(
        'East',
      );
      service.setRegion(projectId, '  West ');
      expect(db.prepare('SELECT region FROM projects WHERE id = ?').get(projectId)?.region).toBe(
        'West',
      );
      // 非枚举值拒绝保存（region 仅五个固定选项）
      expect(() => service.setRegion(projectId, '华东')).toThrow(/五个固定选项/);
      expect(db.prepare('SELECT region FROM projects WHERE id = ?').get(projectId)?.region).toBe(
        'West',
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('计划上门日期到期自动推进（tasks 3.2 / 3.4 集成）', () => {
  function advancer(db: DatabaseSync) {
    return new SqliteDuePlanVisitAdvancer(db, CLOCK);
  }

  it('到期自动推进：pending_execution → executing，仅真实转换递增 revision 并写审计（source=system，无客户值）', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-DUE-1', entryAt: '2026-07-01' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });
      expect(projects.findById(projectId)!.status).toBe('pending_execution');

      const revisionBefore = readBusinessRevision(db);
      const result = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(result).toEqual({ scanned: 1, advanced: 1 });
      expect(projects.findById(projectId)!.status).toBe('executing');
      expect(readBusinessRevision(db)).toBe(revisionBefore + 1); // 同一真实项目 UPDATE 自然递增

      const audits = db.prepare('SELECT * FROM project_status_transition_audit').all() as Array<
        Record<string, unknown>
      >;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        project_id: projectId,
        from_status: 'pending_execution',
        to_status: 'executing',
        reason: 'plan_visit_due',
        effective_business_date: '2026-08-07',
        source: 'system',
      });
      expect(audits[0].actor_id).toBeNull();
      expect(audits[0].actor_username_snapshot).toBeNull();
      // 审计不含任何客户值：仅项目引用/状态/原因/日期/source/技术时间
      expect(Object.keys(audits[0]).sort()).toEqual([
        'actor_id',
        'actor_username_snapshot',
        'created_at',
        'effective_business_date',
        'from_status',
        'id',
        'project_id',
        'reason',
        'source',
        'to_status',
      ]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('重复执行幂等零写：项目/revision/audit 全零变化', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-IDEM-1', entryAt: '2026-07-01' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });

      const first = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(first).toEqual({ scanned: 1, advanced: 1 });
      const revisionAfterFirst = readBusinessRevision(db);
      const updatedAtAfterFirst = (
        db.prepare('SELECT updated_at FROM projects WHERE id = ?').get(projectId) as { updated_at: string }
      ).updated_at;

      const second = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(second).toEqual({ scanned: 0, advanced: 0 });
      expect(projects.findById(projectId)!.status).toBe('executing');
      expect(readBusinessRevision(db)).toBe(revisionAfterFirst);
      expect((db.prepare('SELECT updated_at FROM projects WHERE id = ?').get(projectId) as { updated_at: string }).updated_at).toBe(updatedAtAfterFirst);
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('待进单（含未进单先执行标签）到期自动进入执行中，标签保留', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, service } = openService(dir);
      const projectId = service.createPendingProject().id;
      service.setPreEntryExecution(projectId, { reason: '客户产线停产急需搬迁', missingItems: '合同金额待定' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });
      expect(projects.findById(projectId)!.status).toBe('pending_entry');

      const result = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(result).toEqual({ scanned: 1, advanced: 1 });
      const project = projects.findById(projectId)!;
      expect(project.status).toBe('executing');
      expect(project.preEntryExecution).toBe(true); // 标签为独立事实，不因自动推进清除
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('事务内重查完整事实：更强事实（实际装机完成）优先于到期执行中', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-STRONG-1', entryAt: '2026-07-01' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });
      // 模拟候选状态仍为 pending_execution 但已存在更强事实的行（历史/边缘数据）：
      // 直接落实际装机完成事实（不触发记录路径），advancer 必须重读完整事实而非盲推进执行中。
      db.prepare('UPDATE projects SET actual_install_done_at = ? WHERE id = ?').run('2026-08-05', projectId);
      expect(projects.findById(projectId)!.status).toBe('pending_execution');

      const result = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(result).toEqual({ scanned: 1, advanced: 1 });
      expect(projects.findById(projectId)!.status).toBe('pending_acceptance'); // 更强事实优先
      const audit = db.prepare('SELECT from_status, to_status, reason FROM project_status_transition_audit').get() as {
        from_status: string;
        to_status: string;
        reason: string;
      };
      expect(audit).toEqual({ from_status: 'pending_execution', to_status: 'pending_acceptance', reason: 'auto_install_done' });
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('自动到期优先于人工提交的状态值；系统不覆盖自动推进后的新状态', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-PRIO-1', entryAt: '2026-07-01' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });

      // 人工提交其他状态值但项目已到期：自动触发（plan_visit_due）优先
      const manual = service.adjustStatus(projectId, 'pending_acceptance', { today: '2026-08-07' });
      expect(manual.ok).toBe(true);
      if (manual.ok) {
        expect(manual.status).toBe('executing');
        expect(manual.reason).toBe('plan_visit_due');
      }
      expect(projects.findById(projectId)!.status).toBe('executing');

      // 人工后续把推进结果改成新状态后，自动推进不覆盖
      service.adjustStatus(projectId, 'pending_acceptance');
      expect(projects.findById(projectId)!.status).toBe('pending_acceptance');
      const rerun = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(rerun).toEqual({ scanned: 0, advanced: 0 });
      expect(projects.findById(projectId)!.status).toBe('pending_acceptance'); // 不覆盖新状态
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('条件 UPDATE/CAS：状态守卫不匹配时 0 行，不覆盖并发写入的新状态', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.formalEntry(projectId, { ecc: 'ECC-CAS-1', entryAt: '2026-07-01' });
      expect(projects.findById(projectId)!.status).toBe('pending_execution');

      // 用与当前状态不匹配的守卫执行条件更新 → 0 行（模拟 CAS 竞争：不覆盖新状态）
      const stale = db
        .prepare('UPDATE projects SET status = ? WHERE id = ? AND status = ?')
        .run('executing', projectId, 'executing');
      expect(stale.changes).toBe(0);
      expect(projects.findById(projectId)!.status).toBe('pending_execution');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('正式进单不倒退：已在执行中的项目进单后保持执行中，在原项目上完成', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.setPreEntryExecution(projectId, { reason: '客户产线停产急需搬迁', missingItems: '合同金额待定' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });
      const advanced = advancer(db).advanceDuePlanVisits('2026-08-07');
      expect(advanced.advanced).toBe(1);
      expect(projects.findById(projectId)!.status).toBe('executing');

      const entered = service.formalEntry(projectId, { ecc: 'ECC-NO-REGRESS', entryAt: '2026-08-07' });
      expect(entered.id).toBe(projectId); // 在原项目上进单、不新建项目
      expect(entered.preEntryExecution).toBe(false);
      expect(entered.entryAt).toBe('2026-08-07');
      expect(entered.status).toBe('executing'); // 执行中及后续状态不得因进单回退
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('正式进单对到期待进单项目不覆盖自动触发：进单即进入执行中', () => {
    const dir = makeTempDir();
    try {
      const { db, projects, contracts, service } = openService(dir);
      const { projectId } = prepareEnterableProject(db, contracts, service);
      service.setPreEntryExecution(projectId, { reason: '经理批复：优先安排上门', missingItems: '' });
      service.updateExecutionPreparation(projectId, { planVisitAt: '2026-08-01' });
      expect(projects.findById(projectId)!.status).toBe('pending_entry');

      const entered = service.formalEntry(projectId, { ecc: 'ECC-DUE-FORMAL', entryAt: '2026-07-20' });
      expect(entered.id).toBe(projectId);
      expect(entered.status).toBe('executing'); // 计划上门到期自动触发优先于进单基线 pending_execution
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
