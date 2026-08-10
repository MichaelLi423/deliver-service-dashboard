import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { WorkbenchReadRepository } from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { SqliteInvoiceRepository } from '../../src/domain/capabilities/local-data-persistence/financial-repositories';
import {
  SqliteContractRepository,
  SqliteCustomerRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  FinancialClosureService,
  type FinancialStatusGateway,
} from '../../src/domain/capabilities/project-financial-closure/financial-closure-service';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { Money } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * project-financial-closure SQLite 集成（tasks 5.12）。
 * 验证 5.1~5.11 领域行为在真实临时 SQLite 上落库、关闭重开保留、账号归属快照
 * 持久化，以及与 2.x 正式进单快照/取消的联动。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

let customerSeq = 0;

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoiceRead = new SqliteInvoiceReadRepository(db);
  const projectService = new ProjectService(projects, contracts, invoiceRead, CLOCK);
  const invoices = new SqliteInvoiceRepository(db);
  const gateway: FinancialStatusGateway = {
    reevaluateStatus: (projectId) => {
      const project = projects.findById(projectId)!;
      projectService.adjustStatus(projectId, project.status);
    },
  };
  const financial = new FinancialClosureService(projects, contracts, invoices, gateway, CLOCK);
  return { db, dbPath, projects, contracts, invoices, projectService, financial };
}

/** 构造已正式进单且处于待掉票的项目（SQLite 落库）。 */
function preparePendingInvoice(ctx: ReturnType<typeof openService>, amount = '10000'): string {
  customerSeq += 1;
  const customer = new CustomerService(new SqliteCustomerRepository(ctx.db)).register(`财务客户${customerSeq}`);
  const projectId = ctx.projectService.createPendingProject().id;
  ctx.projectService.attachContract(projectId);
  ctx.financial.setContractUsdTaxAmount(projectId, Money.parse(amount).cents);
  ctx.projectService.linkCustomer(projectId, customer.id);
  ctx.projectService.confirmScope(projectId);
  ctx.projectService.formalEntry(projectId, { ecc: `ECC-FIN-${customerSeq}` });
  ctx.projectService.adjustStatus(projectId, 'executing');
  ctx.projectService.recordActualInstallDone(projectId, '2026-08-05');
  ctx.projectService.markAcceptance(projectId, '2026-08-06');
  return projectId;
}

describe('project-financial-closure SQLite 集成（5.12）', () => {
  it('掉票全流程落库：登记→编辑→撤销→新增更正，关闭重开保留', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = preparePendingInvoice(ctx, '10000');

      const inv = ctx.financial.recordInvoice(projectId, { amountCents: 500000n, invoicedAt: '2026-08-01' }, ACTOR);
      ctx.financial.editInvoice(inv.id, { amountCents: 600000n, invoicedAt: '2026-08-02' }, ACTOR);
      ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-04', revokeReason: '误登记' }, ACTOR);
      const correction = ctx.financial.recordInvoice(projectId, { amountCents: 400000n, invoicedAt: '2026-08-05' }, ACTOR);

      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.financial.listInvoices(projectId)).toHaveLength(2); // 原记录保留（已撤销）+ 更正
      const revoked = reopened.financial.listInvoices(projectId).find((i) => i.id === inv.id)!;
      expect(revoked.revokedAt).toBe('2026-08-04');
      expect(revoked.amountCents).toBe(600000n); // 编辑后的值保留
      expect(reopened.financial.sumActiveAmounts(projectId)).toBe(400000n); // 仅更正计入
      expect(
        reopened.financial.listInvoices(projectId).find((i) => i.id === correction.id)!.amountCents,
      ).toBe(400000n);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号归属快照持久化：掉票新增/编辑/撤销绑定当前登录账号', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = preparePendingInvoice(ctx, '10000');
      const inv = ctx.financial.recordInvoice(projectId, { amountCents: 500000n, invoicedAt: '2026-08-01' }, ACTOR);
      ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-04', revokeReason: '撤销' }, ACTOR);

      const row = ctx.db
        .prepare('SELECT account_id, username_snapshot FROM invoices WHERE id = ?')
        .get(inv.id) as { account_id: string; username_snapshot: string };
      expect(row.account_id).toBe('account-1');
      expect(row.username_snapshot).toBe('负责人甲');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('金额闭环状态落库：任意有效掉票即已完成；撤销最后有效掉票 → 待掉票', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = preparePendingInvoice(ctx, '8000'); // final 800000
      // 已确认语义：第一笔 600000（< final 800000）即已完成，不再等累计金额足额。
      ctx.financial.recordInvoice(projectId, { amountCents: 600000n, invoicedAt: '2026-08-01' }, ACTOR);
      expect(
        ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status,
      ).toBe('completed');
      ctx.financial.recordInvoice(projectId, { amountCents: 200000n, invoicedAt: '2026-08-02' }, ACTOR);
      expect(
        ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status,
      ).toBe('completed');

      // 撤销其中一笔：仍有其他有效掉票 → 保持已完成。
      const second = ctx.financial.listInvoices(projectId).find((i) => i.amountCents === 200000n)!;
      ctx.financial.revokeInvoice(second.id, { revokedAt: '2026-08-05', revokeReason: '撤销' }, ACTOR);
      expect(
        ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status,
      ).toBe('completed');

      // 撤销最后有效掉票：累计归 0 → 回到待掉票。
      const first = ctx.financial.listInvoices(projectId).find((i) => i.amountCents === 600000n)!;
      ctx.financial.revokeInvoice(first.id, { revokedAt: '2026-08-06', revokeReason: '撤销' }, ACTOR);
      expect(
        ctx.db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)?.status,
      ).toBe('pending_invoice');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('已取消项目冻结金额与掉票；有掉票历史（含已撤销）禁止取消（与 2.x 联动）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      // 无掉票项目可取消
      const projectId = preparePendingInvoice(ctx, '10000');
      ctx.projectService.cancelProject(projectId, { time: '2026-08-06', reason: '客户取消' });
      expect(ctx.projects.findById(projectId)!.status).toBe('cancelled');
      // 取消期间冻结
      expect(() => ctx.financial.setContractUsdTaxAmount(projectId, 1200000n)).toThrow(/已取消/);
      expect(() => ctx.financial.setFinalConfirmableAmount(projectId, 900000n)).toThrow(/已取消/);
      expect(() => ctx.financial.recordInvoice(projectId, { amountCents: 100000n }, ACTOR)).toThrow(/已取消/);

      // 有掉票历史的项目禁止取消（含已撤销）
      const projectId2 = preparePendingInvoice(ctx, '10000');
      const inv = ctx.financial.recordInvoice(projectId2, { amountCents: 100000n, invoicedAt: '2026-08-01' }, ACTOR);
      ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-02', revokeReason: '撤销' }, ACTOR);
      expect(() =>
        ctx.projectService.cancelProject(projectId2, { time: '2026-08-06', reason: '取消' }),
      ).toThrow(/掉票历史/);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('合同金额覆盖不改写进单金额快照（2.1 快照锁定联动），最新金额用于占比重算', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const projectId = preparePendingInvoice(ctx, '10000');
      expect(ctx.contracts.findByProjectId(projectId)!.entryAmountSnapshotCents).toBe(1000000n);

      ctx.financial.setContractUsdTaxAmount(projectId, Money.parse('12000').cents);
      const after = ctx.contracts.findByProjectId(projectId)!;
      expect(after.entryAmountSnapshotCents).toBe(1000000n); // 快照不变
      expect(after.usdTaxAmountCents).toBe(1200000n); // 最新合同金额（damage-repair 占比重算读取此值）
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

/**
 * 任务 4.2：待掉票金额指标仅由「仍存在项目」的有效财务事实计算。
 * 直接观测 WorkbenchReadRepository.overview() 的 pendingAmount 指标，覆盖四场景：
 * 零项目为 0 / 孤立排除 / 已完成余额纳入 / 已取消排除。
 * 财务公式不变：final_confirmable_amount_cents − 有效（未撤销）掉票合计，
 * 仅对仍存在且非 cancelled 的已进单项目计算（JOIN contracts）。
 */
describe('待掉票金额指标（4.2：仅仍存在项目的有效财务事实）', () => {
  interface FinCtx {
    db: DatabaseSync;
    repo: WorkbenchReadRepository;
    dir: string;
  }

  function openFinCtx(): FinCtx {
    const dir = makeTempDir('fin-closure-42-');
    const { db } = bootstrapDatabase({ dataDir: dir });
    const repo = new WorkbenchReadRepository(db, { today: '2026-08-08', windowDays: 7 });
    return { db, repo, dir };
  }

  function seedProject(db: DatabaseSync, id: string, tempNo: string, status: string): void {
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, entry_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, tempNo, status, '华东', '2026-08-01', 't', 't');
  }

  function seedContract(db: DatabaseSync, id: string, projectId: string, tempNo: string, finalCents: number): void {
    db.prepare(
      `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, projectId, tempNo, finalCents, 't', 't');
  }

  function seedInvoice(
    db: DatabaseSync,
    id: string,
    projectId: string,
    amountCents: number,
    revokedAt: string | null,
  ): void {
    db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoked_at, last_modified_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, projectId, amountCents, '2026-08-02', revokedAt, '2026-08-02T00:00:00+08:00', 't');
  }

  /** 写入引用不存在项目的孤立财务事实（模拟旧库遗留脏数据；FK 临时关闭）。 */
  function seedOrphan(db: DatabaseSync, contractId: string, invoiceId: string, ghostProject: string): void {
    db.exec('PRAGMA foreign_keys = OFF');
    seedContract(db, contractId, ghostProject, 'TP-GHOST', 90000000);
    seedInvoice(db, invoiceId, ghostProject, 80000000, null);
    db.exec('PRAGMA foreign_keys = ON');
  }

  it('零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0', () => {
    const ctx = openFinCtx();
    try {
      seedOrphan(ctx.db, 'c-ghost-a', 'inv-ghost-a', 'ghost-a');
      const overview = ctx.repo.overview();
      expect(overview.metrics.totalProjects).toBe(0);
      expect(overview.metrics.pendingAmount).toBe('0.00'); // 不因孤立数据显示非 0
    } finally {
      closeDatabase(ctx.db);
      cleanupTempDir(ctx.dir);
    }
  });

  it('孤立排除：引用不存在项目的掉票/合同事实不计入指标', () => {
    const ctx = openFinCtx();
    try {
      const { db, repo } = ctx;
      // 有效项目：final=5000.00 且无掉票 → 待掉票 5000.00
      seedProject(db, 'p-valid', 'TP-VALID', 'pending_invoice');
      seedContract(db, 'c-valid', 'p-valid', 'TP-VALID', 500000);
      // 孤立：final=900000.00 合同 + 800000.00 有效掉票（引用不存在项目）
      seedOrphan(db, 'c-ghost-b', 'inv-ghost-b', 'ghost-b');

      const overview = repo.overview();
      expect(overview.metrics.totalProjects).toBe(1);
      expect(overview.metrics.pendingAmount).toBe('5000.00');
    } finally {
      closeDatabase(ctx.db);
      cleanupTempDir(ctx.dir);
    }
  });

  it('已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入', () => {
    const ctx = openFinCtx();
    try {
      const { db, repo } = ctx;
      seedProject(db, 'p-done', 'TP-DONE', 'completed');
      seedContract(db, 'c-done', 'p-done', 'TP-DONE', 800000); // final 8000.00
      seedInvoice(db, 'inv-done-1', 'p-done', 200000, null); // 有效 2000.00
      seedInvoice(db, 'inv-done-2', 'p-done', 500000, '2026-08-05'); // 已撤销 5000.00 不计

      const overview = repo.overview();
      expect(overview.metrics.totalProjects).toBe(1);
      expect(overview.metrics.pendingAmount).toBe('6000.00'); // 8000 − 2000
    } finally {
      closeDatabase(ctx.db);
      cleanupTempDir(ctx.dir);
    }
  });

  it('已取消排除：仅已取消项目存在时 pendingAmount 为 0（口径不改动为仅活跃项目）', () => {
    const ctx = openFinCtx();
    try {
      const { db, repo } = ctx;
      seedProject(db, 'p-cancel', 'TP-CANCEL', 'cancelled');
      seedContract(db, 'c-cancel', 'p-cancel', 'TP-CANCEL', 500000); // 若计入将是 5000.00

      const overview = repo.overview();
      expect(overview.metrics.totalProjects).toBe(1);
      expect(overview.metrics.activeProjects).toBe(0);
      expect(overview.metrics.pendingAmount).toBe('0.00');
    } finally {
      closeDatabase(ctx.db);
      cleanupTempDir(ctx.dir);
    }
  });
});
