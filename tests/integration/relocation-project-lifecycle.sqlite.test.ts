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
      service.setRegion(projectId, ' 华东 ');
      expect(db.prepare('SELECT region FROM projects WHERE id = ?').get(projectId)?.region).toBe(
        '华东',
      );
      service.setRegion(projectId, ' 华南 ');
      expect(db.prepare('SELECT region FROM projects WHERE id = ?').get(projectId)?.region).toBe(
        '华南',
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
