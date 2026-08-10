import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteContractRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  SqliteBatchChangeHistoryRepository,
  SqliteBatchRepository,
  SqliteActivityRepository,
  SqliteActivityEngineerRepository,
  SqliteWorkFactRepository,
  SqliteInstrumentRepository,
  SqliteLogisticsFeeRepository,
} from '../../src/domain/capabilities/local-data-persistence/execution-repositories';
import { SqliteQrRequestRepository } from '../../src/domain/capabilities/local-data-persistence/qr-request-repositories';
import {
  SqliteShipToAddressReader,
  SqliteShipToRepository,
  SqliteShipToRequestRepository,
} from '../../src/domain/capabilities/local-data-persistence/ship-to-repositories';
import { SqliteReminderSettingsRepository } from '../../src/domain/capabilities/local-data-persistence/reminder-settings-repositories';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ReminderService } from '../../src/domain/capabilities/workbench-todos/reminder-service';
import { QrRequestService } from '../../src/domain/capabilities/qr-request-tracking/qr-request-service';
import { ShipToService } from '../../src/domain/capabilities/ship-to-management/ship-to-service';
import { ExecutionService } from '../../src/domain/capabilities/relocation-execution/execution-service';
import type { ExecutionLifecycleGateway } from '../../src/domain/capabilities/relocation-execution/execution-service';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * workbench-todos SQLite 集成（tasks 6.5）。
 * 验证项目提醒手工维护/到期分类/临期窗口在真实临时 SQLite 上落库、
 * 关闭重开保留、账号归属快照持久化、schema v5 迁移，以及跨模块
 * 「不自动创建提醒」边界（二维码申请、Ship-to 申请、成交>预算物流
 * 费用均不产生任何项目提醒）。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoices = new SqliteInvoiceReadRepository(db);
  const projectService = new ProjectService(projects, contracts, invoices, CLOCK);
  const settings = new SqliteReminderSettingsRepository(db);
  const reminders = new ReminderService(projects, settings, CLOCK);

  const qrService = new QrRequestService(new SqliteQrRequestRepository(db), CLOCK);
  const shipToService = new ShipToService(
    new SqliteShipToRepository(db),
    new SqliteShipToRequestRepository(db),
    new SqliteShipToAddressReader(db),
    CLOCK,
  );

  const batches = new SqliteBatchRepository(db);
  const instruments = new SqliteInstrumentRepository(db);
  const fees = new SqliteLogisticsFeeRepository(db);
  const gateway: ExecutionLifecycleGateway = {
    onExecutionStarted: (pid) => {
      projectService.adjustStatus(pid, 'executing', { executionStarted: true });
    },
  };
  const executionService = new ExecutionService(
    batches,
    instruments,
    new SqliteBatchChangeHistoryRepository(db),
    new SqliteActivityRepository(db),
    new SqliteActivityEngineerRepository(db),
    new SqliteWorkFactRepository(db),
    fees,
    gateway,
    CLOCK,
  );

  return {
    db,
    dbPath,
    projects,
    projectService,
    reminders,
    settings,
    qrService,
    shipToService,
    executionService,
    batches,
    fees,
  };
}

/** 创建并落库一个项目（返回 id）。 */
function addProject(db: DatabaseSync, id: string): void {
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run(id, `TP-${id}`, 'pending_entry', 't', 't');
}

describe('workbench-todos SQLite 集成（6.5）', () => {
  it('schema v13：项目提醒归属快照列存在并随迁移写入 user_version=13', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(14);
      const cols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('reminder_account_id');
      expect(cols.map((c) => c.name)).toContain('reminder_username_snapshot');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('提醒创建→编辑→清除落库，关闭重开保留当前提醒与归属快照', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      addProject(ctx.db, 'p1');

      ctx.reminders.setReminder('p1', { at: '2026-08-10', note: '补齐资料' }, ACTOR);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const stored = reopened.projects.findById('p1')!;
      expect(stored.reminderAt).toBe('2026-08-10');
      expect(stored.reminderNote).toBe('补齐资料');
      expect(stored.reminderAccountId).toBe('account-1');
      expect(stored.reminderUsernameSnapshot).toBe('负责人甲');
      expect(reopened.reminders.classifyProject(stored)).toBe('upcoming');

      // 编辑：覆盖为新的当前提醒（不保存旧内容/完成历史）
      reopened.reminders.setReminder('p1', { at: '2026-08-12', note: '新备注' }, ACTOR);
      const edited = reopened.projects.findById('p1')!;
      expect(edited.reminderAt).toBe('2026-08-12');
      expect(edited.reminderNote).toBe('新备注');
      expect(reopened.reminders.classifyProject(edited)).toBe('upcoming');

      // 清除：项目不再显示任何提醒
      reopened.reminders.clearReminder('p1', ACTOR);
      const cleared = reopened.projects.findById('p1')!;
      expect(cleared.reminderAt).toBeNull();
      expect(cleared.reminderNote).toBeNull();
      expect(reopened.reminders.classifyProject(cleared)).toBeNull();
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('临期窗口配置经 app_settings 持久化并立即生效', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      // 未配置默认 7 个自然日
      expect(ctx.reminders.getUpcomingWindowDays()).toBe(7);
      expect(ctx.reminders.classifyAt('2026-08-14')).toBe('upcoming');
      expect(ctx.reminders.classifyAt('2026-08-15')).toBeNull();

      ctx.reminders.setUpcomingWindowDays(3);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.reminders.getUpcomingWindowDays()).toBe(3);
      // 配置立即生效：第 4 天起不再临期
      expect(reopened.reminders.classifyAt('2026-08-10')).toBe('upcoming');
      expect(reopened.reminders.classifyAt('2026-08-11')).toBeNull();
      const row = reopened.db
        .prepare("SELECT value FROM app_settings WHERE key = 'reminder_upcoming_window_days'")
        .get() as { value: string };
      expect(row.value).toBe('3');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  // 持久化已支持 0：0 是合法配置值，必须按 0 落库并重读，绝不能当 falsy 回退默认 7。
  it('窗口配置为 0 时按 0 持久化，关闭重开后仍为 0（0 不当作 falsy 回退 7）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.reminders.setUpcomingWindowDays(0);
      expect(ctx.reminders.getUpcomingWindowDays()).toBe(0);
      // 0 窗口下：当天 today、昨天 overdue、明天不分类
      expect(ctx.reminders.classifyAt('2026-08-07')).toBe('today');
      expect(ctx.reminders.classifyAt('2026-08-06')).toBe('overdue');
      expect(ctx.reminders.classifyAt('2026-08-08')).toBeNull();
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.reminders.getUpcomingWindowDays()).toBe(0);
      expect(reopened.reminders.classifyAt('2026-08-08')).toBeNull();
      const row = reopened.db
        .prepare("SELECT value FROM app_settings WHERE key = 'reminder_upcoming_window_days'")
        .get() as { value: string };
      expect(row.value).toBe('0');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  // 决策：临期窗口无业务上限，仅接受 0..MAX_SAFE_INTEGER 非负安全整数；
  // 保存以十进制文本精确保留 MAX_SAFE_INTEGER，重开读取不回退、不丢精度。
  it('窗口配置 MAX_SAFE_INTEGER 以十进制文本精确保留并重开读取', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.reminders.setUpcomingWindowDays(Number.MAX_SAFE_INTEGER);
      expect(ctx.reminders.getUpcomingWindowDays()).toBe(Number.MAX_SAFE_INTEGER);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.reminders.getUpcomingWindowDays()).toBe(Number.MAX_SAFE_INTEGER);
      // 超大窗口分类稳定（addBusinessDays 饱和到 9999-12-31）
      expect(reopened.reminders.classifyAt('9999-12-31')).toBe('upcoming');
      const row = reopened.db
        .prepare("SELECT value FROM app_settings WHERE key = 'reminder_upcoming_window_days'")
        .get() as { value: string };
      expect(row.value).toBe(String(Number.MAX_SAFE_INTEGER));
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('app_settings 中超出安全整数范围的历史异常文本回退未配置（默认 7）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.db
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run('reminder_upcoming_window_days', String(Number.MAX_SAFE_INTEGER + 1), 't');
      expect(ctx.reminders.getUpcomingWindowDays()).toBe(7);
      // 按默认 7 天窗口分类
      expect(ctx.reminders.classifyAt('2026-08-14')).toBe('upcoming');
      expect(ctx.reminders.classifyAt('2026-08-15')).toBeNull();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('listReminders 供工作台展示：按当前提醒列出项目与到期分类，关闭重开仍可列出', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      addProject(ctx.db, 'p1');
      addProject(ctx.db, 'p2');
      ctx.reminders.setReminder('p1', { at: '2026-08-07', note: '今日' }, ACTOR);
      ctx.reminders.setReminder('p2', { at: '2026-08-05', note: '逾期' }, ACTOR);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const reminders = reopened.reminders.listReminders();
      const dueMap = new Map(reminders.map((r) => [r.project.id, r.dueClass]));
      expect(dueMap.get('p1')).toBe('today');
      expect(dueMap.get('p2')).toBe('overdue');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      addProject(ctx.db, 'p1');

      // 二维码申请（独立模块）保存后：项目提醒保持为空
      ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A', 'B'] }, ACTOR);
      expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();

      // Ship-to 申请未完成：不自动创建项目提醒
      const request = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      ctx.shipToService.submit(request.id, ACTOR);
      expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();
      expect(ctx.projects.findById('p1')!.reminderNote).toBeNull();

      // 批次成交价格高于预算：仅警告，不自动创建项目提醒
      ctx.db
        .prepare('INSERT INTO batches (id, project_id, plan_transport_date, transport_company, original_price_cents, discounted_price_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('b1', 'p1', '2026-08-10', '物流公司甲', 10000, 9000, 't', 't');
      const feeResult = ctx.executionService.recordLogisticsFee(
        'b1',
        { appliedAt: '2026-08-07', budgetPriceCents: 10000n, dealPriceCents: 12000n, logisticsCostCents: 11000n },
        ACTOR,
      );
      expect(feeResult.warning).toContain('不自动创建项目提醒');
      const project = ctx.projects.findById('p1')!;
      expect(project.reminderAt).toBeNull();
      expect(project.reminderNote).toBeNull();
      expect(ctx.reminders.listReminders()).toHaveLength(0);

      // 负责人手工维护后才有提醒（系统绝不由上述事实推导）
      ctx.reminders.setReminder('p1', { at: '2026-08-09', note: '手工跟进' }, ACTOR);
      expect(ctx.projects.findById('p1')!.reminderNote).toBe('手工跟进');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
