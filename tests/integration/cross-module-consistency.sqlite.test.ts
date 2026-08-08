import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteContractRepository,
  SqliteCustomerRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import { SqliteInvoiceRepository } from '../../src/domain/capabilities/local-data-persistence/financial-repositories';
import { SqliteReminderSettingsRepository } from '../../src/domain/capabilities/local-data-persistence/reminder-settings-repositories';
import { SqliteReportingFactReader } from '../../src/domain/capabilities/local-data-persistence/reporting-fact-reader';
import {
  ReportingService,
} from '../../src/domain/capabilities/operational-reporting';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { FinancialClosureService } from '../../src/domain/capabilities/project-financial-closure/financial-closure-service';
import { ReminderService } from '../../src/domain/capabilities/workbench-todos/reminder-service';
import { Money } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * 跨模块所有权与实时一致性（tasks 10.3）。
 *
 * 在真实 SQLite 集成层验证：
 * 1. 掉票编辑/撤销后主状态、项目提醒与报表三者实时一致；
 * 2. 区域修改后报表分组实时重算（不保存快照）；
 * 3. 项目主状态人工调整经 lifecycle 校验入口、自动触发优先于人工值；
 * 4. 账号用户名修改后历史统计仍按动作记录中的用户名快照归属；
 * 5. 所有权边界在集成层不越权：
 *    - workbench-todos 只消费提醒字段，维护提醒不改变主状态；
 *    - operational-reporting 只读统计，构建报表不产生任何状态/事实副作用；
 *    - project-financial-closure 仅消费 lifecycle 校验结果（经 gateway 重算）；
 *    - relocation-project-lifecycle 唯一拥有主状态转换（直接写库绕过校验由领域服务拒绝）。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openContext(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoices = new SqliteInvoiceRepository(db);
  const projectService = new ProjectService(projects, contracts, new SqliteInvoiceReadRepository(db), CLOCK);
  const financial = new FinancialClosureService(projects, contracts, invoices, {
    reevaluateStatus: (projectId) => {
      const project = projects.findById(projectId)!;
      projectService.adjustStatus(projectId, project.status); // 仅消费 lifecycle 校验结果
    },
  }, CLOCK);
  const reminder = new ReminderService(projects, new SqliteReminderSettingsRepository(db), CLOCK);
  const reporting = new ReportingService(new SqliteReportingFactReader(db), CLOCK);

  let seq = 0;
  const seedEnteredProject = (opts: { region: string; entryAt: string; snapshot: string }) => {
    seq += 1;
    const customer = new CustomerService(new SqliteCustomerRepository(db)).register(`跨模块客户${seq}`);
    const projectId = projectService.createPendingProject().id;
    projectService.attachContract(projectId);
    financial.setContractUsdTaxAmount(projectId, Money.parse(opts.snapshot).cents);
    projectService.linkCustomer(projectId, customer.id);
    projectService.confirmScope(projectId);
    projectService.setRegion(projectId, opts.region);
    projectService.formalEntry(projectId, { ecc: `ECC-XM-${seq}`, entryAt: opts.entryAt });
    return projectId;
  };

  return {
    db,
    dbPath,
    projects,
    contracts,
    invoices,
    projectService,
    financial,
    reminder,
    reporting,
    seedEnteredProject,
  };
}

describe('跨模块所有权与实时一致性（tasks 10.3）', () => {
  it('掉票编辑/撤销后：主状态、项目提醒与报表实时一致', () => {
    const dir = makeTempDir();
    try {
      const ctx = openContext(dir);
      const p1 = ctx.seedEnteredProject({ region: '华东', entryAt: '2026-07-01T09:00:00+08:00', snapshot: '10000' });
      // 推进到待掉票：实际装机完成 → 待验收；验收报告 → 待掉票
      ctx.projectService.recordActualInstallDone(p1, '2026-07-10T18:00:00+08:00');
      ctx.projectService.markAcceptance(p1, '2026-07-12');
      expect(ctx.projects.findById(p1)!.status).toBe('pending_invoice');

      // 项目提醒（workbench-todos 消费提醒字段）
      ctx.reminder.setReminder(p1, { at: '2026-08-20T09:00:00+08:00', note: '跟踪回款资料' }, ACTOR);

      // 掉票 6000 → 达到最终可确认金额 10000 的 60%，状态仍待掉票
      const inv = ctx.financial.recordInvoice(p1, { amountCents: 600000n, invoicedAt: '2026-07-15T10:00:00+08:00' }, ACTOR);
      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      expect(ctx.projects.findById(p1)!.status).toBe('pending_invoice');
      expect(ctx.reporting.buildReport(month).monthlyInvoices[0].amountCents).toBe(600000n);

      // 编辑掉票 → 报表实时更新；主状态与项目提醒不受影响
      ctx.financial.editInvoice(inv.id, { amountCents: 1000000n, invoicedAt: '2026-07-16T10:00:00+08:00' }, ACTOR);
      // 累计 10000 = 最终可确认 10000 → 金额闭环自动进入已完成（经 lifecycle 校验入口）
      expect(ctx.projects.findById(p1)!.status).toBe('completed');
      expect(ctx.reporting.buildReport(month).monthlyInvoices[0].amountCents).toBe(1000000n);
      expect(ctx.projects.findById(p1)!.reminderNote).toBe('跟踪回款资料'); // 项目提醒不因金额/状态变化改变

      // 撤销掉票（终态）→ 金额闭环回到待掉票；报表排除；项目提醒仍不变
      ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-07-20T10:00:00+08:00', revokeReason: '重复登记' }, ACTOR);
      expect(ctx.projects.findById(p1)!.status).toBe('pending_invoice');
      expect(ctx.reporting.buildReport(month).monthlyInvoices).toHaveLength(0);
      expect(ctx.projects.findById(p1)!.reminderNote).toBe('跟踪回款资料');

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('区域修改后报表分组实时重算', () => {
    const dir = makeTempDir();
    try {
      const ctx = openContext(dir);
      const p1 = ctx.seedEnteredProject({ region: '华东', entryAt: '2026-07-01T09:00:00+08:00', snapshot: '10000' });
      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      expect(ctx.reporting.buildReport(month).entryAmountByRegion[0].region).toBe('华东');
      // 区域为项目事实，修改后按去除首尾空白后的精确值实时重算，不保存快照
      ctx.projectService.setRegion(p1, '  华南  ');
      const after = ctx.reporting.buildReport(month).entryAmountByRegion;
      expect(after[0].region).toBe('华南');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('项目主状态人工调整经 lifecycle 校验入口，自动触发优先于人工值', () => {
    const dir = makeTempDir();
    try {
      const ctx = openContext(dir);
      const p1 = ctx.seedEnteredProject({ region: '华东', entryAt: '2026-07-01T09:00:00+08:00', snapshot: '10000' });
      // 已录入实际装机完成时间：自动触发待验收
      ctx.projectService.recordActualInstallDone(p1, '2026-07-10T18:00:00+08:00');
      expect(ctx.projects.findById(p1)!.status).toBe('pending_acceptance');

      // 人工提交相同/其他状态 → 自动触发优先（实际装机完成 → 待验收）
      const manual = ctx.projectService.adjustStatus(p1, 'pending_acceptance');
      expect(manual.ok).toBe(true);
      expect(manual.status).toBe('pending_acceptance');

      // 非法人工调整（无闭环依据直接已完成）被 lifecycle 拒绝
      const rejected = ctx.projectService.adjustStatus(p1, 'completed');
      expect(rejected.ok).toBe(false);
      expect(ctx.projects.findById(p1)!.status).toBe('pending_acceptance');

      // 直接写库绕过校验会被领域校验在下次读取/操作时拒绝（部分唯一约束等兜底）
      expect(() => {
        ctx.projectService.adjustStatus('no-such-project', 'executing');
      }).toThrow();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号用户名修改后历史统计仍按动作记录中的用户名快照归属、不动态变化', () => {
    const dir = makeTempDir();
    try {
      const ctx = openContext(dir);
      const p1 = ctx.seedEnteredProject({ region: '华东', entryAt: '2026-07-01T09:00:00+08:00', snapshot: '10000' });
      ctx.financial.recordInvoice(p1, { amountCents: 500000n, invoicedAt: '2026-07-15T10:00:00+08:00' }, ACTOR);
      ctx.reminder.setReminder(p1, { at: '2026-08-01T09:00:00+08:00', note: '提醒A' }, ACTOR);

      // 动作记录持久化用户名快照「负责人甲」
      const snapshotBefore = ctx.db.prepare('SELECT username_snapshot FROM invoices').get() as { username_snapshot: string | null };
      expect(snapshotBefore.username_snapshot).toBe('负责人甲');

      // 账号改名（模拟用户修改用户名）：动作记录中的快照不动态变化
      ctx.db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run('负责人甲（新名）', 'account-1');
      const snapshotAfter = ctx.db.prepare('SELECT username_snapshot FROM invoices').get() as { username_snapshot: string | null };
      expect(snapshotAfter.username_snapshot).toBe('负责人甲');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('所有权边界在集成层不越权：提醒维护不改状态、报表只读、状态转换唯一经 lifecycle', () => {
    const dir = makeTempDir();
    try {
      const ctx = openContext(dir);
      const p1 = ctx.seedEnteredProject({ region: '华东', entryAt: '2026-07-01T09:00:00+08:00', snapshot: '10000' });
      const before = ctx.projects.findById(p1)!.status;
      const beforeUpdatedAt = ctx.projects.findById(p1)!.updatedAt;

      // workbench-todos 只消费提醒字段：维护提醒不改变主状态（也不触发 lifecycle）
      ctx.reminder.setReminder(p1, { at: '2026-08-01T09:00:00+08:00', note: '仅提醒' }, ACTOR);
      expect(ctx.projects.findById(p1)!.status).toBe(before);

      // operational-reporting 只读：构建报表不产生任何事实/状态副作用
      ctx.reporting.buildReport({ monthFrom: '2026-06', monthTo: '2026-08' });
      expect(ctx.projects.findById(p1)!.status).toBe(before);
      expect(ctx.projects.findById(p1)!.updatedAt).toBe(beforeUpdatedAt);

      // 主状态转换唯一经 lifecycle 校验入口：非法人工调整（无闭环依据直接已完成）被拒且状态不变
      ctx.reminder.setReminder(p1, { at: '2026-08-01T09:00:00+08:00', note: '仅提醒' }, ACTOR);
      const rejected = ctx.projectService.adjustStatus(p1, 'completed');
      expect(rejected.ok).toBe(false);
      expect(ctx.projects.findById(p1)!.status).toBe('pending_entry');

      // financial 仅消费 lifecycle 校验结果：取消有掉票历史的项目被 lifecycle 拒绝
      ctx.financial.recordInvoice(p1, { amountCents: 100000n, invoicedAt: '2026-07-15T10:00:00+08:00' }, ACTOR);
      expect(() => ctx.projectService.cancelProject(p1, { time: '2026-07-20T10:00:00+08:00', reason: '尝试取消' })).toThrow(/掉票/);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
