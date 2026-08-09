import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import {
  V2_PROJECT_PAGE_DEFAULT_LIMIT,
  WorkbenchReadRepository,
} from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { classifyReminder } from '../../src/domain/capabilities/workbench-todos';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import type {
  WorkbenchProjectRow,
  WorkbenchV2SectionRow,
} from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Oracle #10 后端最小方案：v2 有界读取仓储 + 有界 mutation。
 *
 * - 全部读取为 SQL 有界实现（分页 + 聚合），禁止全量 snapshot / JS P×C；
 * - 每个 DTO 含 businessRevision；金额一律十进制字符串；
 * - 提醒分类与现有纯函数 classifyReminder 完全同口径（含边界）；
 * - v2 mutation 复用写逻辑但不调用 snapshot()，返回 invalidate tags。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

interface Ctx {
  db: DatabaseSync;
  facade: WorkbenchFacade;
  projectId: string;
}

function makeFacade(): Ctx {
  const dir = makeTempDir('workbench-v2-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  // 同步初始化（测试里账号服务是异步的，这里直接建行避免异步初始化开销）。
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('acc-1', '负责人', 'hash', 'salt', 't', 't');
  const facade = new WorkbenchFacade(db, () => ({ accountId: 'acc-1', username: '负责人' }));
  const created = facade.v2Mutate({
    op: 'create_project',
    payload: {
      intent: 'formal',
      customerName: '集成客户甲',
      ecc: 'ECC-V2-001',
      region: '华东',
      contractStartDate: '2026-08-01',
      contractEndDate: '2027-07-31',
      oldSiteAddress: '旧址',
      newSiteAddress: '新址',
      instrumentName: '质谱仪',
      ups: true,
      contractAmount: '100000',
      finalAmount: '100000',
      siteConfirmed: false,
    },
  });
  return { db, facade, projectId: created.changed!.projectId! };
}

function reader(ctx: Ctx, today = '2026-08-08', windowDays = 7): WorkbenchReadRepository {
  return new WorkbenchReadRepository(ctx.db, { today, windowDays });
}

/** 直接 SQL 播种多个项目（temp_no 唯一；updated_at 递增保证排序稳定）。 */
function seedProjects(db: DatabaseSync, count: number, baseUpdatedAt = '2026-08-01T00:00:00+08:00'): void {
  const stmt = db.prepare(
    `INSERT INTO projects (id, temp_no, status, region, customer_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < count; i++) {
    const hour = String((i % 24)).padStart(2, '0');
    const minute = String((i % 60)).padStart(2, '0');
    stmt.run(
      `seed-p-${i}`,
      `TP-SEED-${String(i).padStart(4, '0')}`,
      i % 3 === 0 ? 'pending_execution' : i % 3 === 1 ? 'executing' : 'pending_acceptance',
      i % 2 === 0 ? '华东' : '华北',
      null,
      baseUpdatedAt,
      `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${hour}:${minute}:00+08:00`,
    );
  }
}

describe('工作台 v2 overview（Oracle #10 首屏）', () => {
  it('指标/阶段/提醒预览/total/窗口 + businessRevision；金额为十进制字符串', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    // 再建 4 个项目并设置不同状态/提醒，直接 SQL 播种 + 提醒字段
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('seed-r1', 'TP-R1', 'pending_execution', '华东', '2026-08-07', '逾期提醒', 't', '2026-08-05T00:00:00+08:00');
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('seed-r2', 'TP-R2', 'executing', '华北', '2026-08-10', '临期提醒', 't', '2026-08-06T00:00:00+08:00');
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('seed-r3', 'TP-R3', 'completed', '华东', '2026-08-09', '完成项目也带提醒', 't', '2026-08-07T00:00:00+08:00');

    const overview = reader(ctx).overview();
    expect(overview.businessRevision).toBeGreaterThan(0);
    expect(overview.reminderWindowDays).toBe(7);
    expect(overview.metrics.totalProjects).toBe(4);
    expect(overview.metrics.activeProjects).toBe(3); // 排除 completed/cancelled
    expect(overview.metrics.reminderCount).toBe(3);
    expect(overview.metrics.reminderOverdue).toBe(1);
    expect(overview.metrics.reminderToday).toBe(0); // 今日=2026-08-08，无
    expect(overview.metrics.pendingAmount).toBe('100000.00'); // makeFacade 已进单项目尚待掉票
    expect(typeof overview.metrics.pendingAmount).toBe('string');

    // 阶段：6 个非取消状态，计数正确
    const stage = Object.fromEntries(overview.stages.map((s) => [s.status, s.count]));
    expect(stage).toMatchObject({
      pending_entry: 0,
      pending_execution: 2,
      executing: 1,
      pending_acceptance: 0,
      pending_invoice: 0,
      completed: 1,
    });
    for (const s of overview.stages) {
      expect(Number.isFinite(s.averageDays)).toBe(true);
      expect(s.inflow).toBe(0);
      expect(s.outflow).toBe(0);
    }

    // 提醒预览：≤6、按提醒时间升序、total 一致、分类与纯函数同口径
    expect(overview.reminderPreview.length).toBeLessThanOrEqual(6);
    expect(overview.reminderPreview.map((r) => r.projectId)).toEqual(['seed-r1', 'seed-r3', 'seed-r2']);
    expect(overview.reminderTotal).toBe(3);
    for (const r of overview.reminderPreview) {
      expect(r.reminderDueClass).toBe(
        classifyReminder(r.reminderAt, '2026-08-08', 7),
      );
    }
    closeDatabase(ctx.db);
  });

  it('提醒边界：昨日/今日/窗口内/窗口外/仅备注 分类与纯函数完全同口径', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const today = '2026-08-08';
    const windowDays = 7;
    const seed = (id: string, at: string | null, note: string | null): void => {
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, `TP-${id}`, 'pending_execution', '华东', at, note, 't', '2026-08-01T00:00:00+08:00');
    };
    seed('b-overdue', '2026-08-07', '昨日'); // < today → overdue
    seed('b-today', '2026-08-08', '今日'); // == today → today
    seed('b-upcoming', '2026-08-10', '窗口内'); // today < d <= today+7 → upcoming
    seed('b-window-edge', '2026-08-15', '窗口最后一天'); // == today+7 → upcoming
    seed('b-outside', '2026-08-16', '窗口外'); // > today+7 → null
    seed('b-note-only', null, '仅备注无时间'); // null → 无分类但计入 any

    const repo = reader(ctx, today, windowDays);
    const page = repo.projectPage({ reminder: 'any', limit: 100 });
    const byId = new Map(page.projects.map((p) => [p.id, p]));
    const expectClass = (id: string, cls: string | null): void => {
      const row = byId.get(id);
      expect(row).toBeTruthy();
      expect(row!.reminderDueClass).toBe(cls);
      // 与纯函数逐行对照
      expect(row!.reminderDueClass).toBe(classifyReminder(row!.reminderAt, today, windowDays));
    };
    expectClass('b-overdue', 'overdue');
    expectClass('b-today', 'today');
    expectClass('b-upcoming', 'upcoming');
    expectClass('b-window-edge', 'upcoming');
    expectClass('b-outside', null);
    expectClass('b-note-only', null);

    // 过滤口径
    expect(repo.projectPage({ reminder: 'overdue', limit: 100 }).projects.map((p) => p.id)).toContain('b-overdue');
    expect(repo.projectPage({ reminder: 'today', limit: 100 }).projects.map((p) => p.id)).toEqual(['b-today']);
    const upcoming = repo.projectPage({ reminder: 'upcoming', limit: 100 }).projects.map((p) => p.id).sort();
    expect(upcoming).toEqual(['b-upcoming', 'b-window-edge']);
    const anyIds = repo.projectPage({ reminder: 'any', limit: 100 }).projects.map((p) => p.id).sort();
    expect(anyIds).toEqual(['b-note-only', 'b-outside', 'b-overdue', 'b-today', 'b-upcoming', 'b-window-edge']);
    closeDatabase(ctx.db);
  });
});

describe('工作台 v2 项目 keyset 分页（Oracle #10）', () => {
  it('默认 50 / 上限 100：翻页无重复无遗漏、游标稳定、total 正确', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 120);
    const repo = reader(ctx);

    const first = repo.projectPage({});
    expect(first.limit).toBe(V2_PROJECT_PAGE_DEFAULT_LIMIT);
    expect(first.projects.length).toBe(50);
    expect(first.total).toBe(121); // 120 + makeFacade 的 1 个
    expect(first.nextCursor).toBeTruthy();

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    const collected: WorkbenchProjectRow[] = [];
    do {
      const page = repo.projectPage({ cursor });
      for (const p of page.projects) {
        expect(seen.has(p.id), `不应重复: ${p.id}`).toBe(false);
        seen.add(p.id);
      }
      collected.push(...page.projects);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor !== null);
    expect(collected.length).toBe(121);
    expect(seen.size).toBe(121);

    // 上限 100：请求 1000 只返回 100
    const capped = repo.projectPage({ limit: 1000 });
    expect(capped.projects.length).toBe(100);
    expect(capped.limit).toBe(100);

    // 游标稳定：同一 cursor 两次请求返回完全相同
    const again = repo.projectPage({ cursor: first.nextCursor });
    const second = repo.projectPage({ cursor: first.nextCursor });
    expect(again.projects.map((p) => p.id)).toEqual(second.projects.map((p) => p.id));

    // 默认排序为 updated_at DESC：第一页的 updatedAt 字典序单调不增
    const updated = first.projects.map((p) => p.updatedAt);
    expect([...updated].sort().reverse()).toEqual(updated);
    closeDatabase(ctx.db);
  });

  it('过滤：status / region / query（客户名称）/ reminder', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    seedProjects(db, 30);
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('filter-r', 'TP-F-R', 'pending_acceptance', '华南', '2026-08-07', '过滤提醒', 't', '2026-08-02T00:00:00+08:00');
    const repo = reader(ctx);

    expect(repo.projectPage({ status: 'pending_acceptance' }).projects.length).toBe(11); // 10 seed(3%3==2) + 1 filter-r
    expect(repo.projectPage({ region: '华北' }).projects.every((p) => p.region === '华北')).toBe(true);
    // query 命中客户名称（makeFacade 的集成客户甲）
    const byCustomer = repo.projectPage({ query: '集成客户' });
    expect(byCustomer.projects.length).toBe(1);
    expect(byCustomer.projects[0].customerName).toBe('集成客户甲');
    // query 命中临时编号
    expect(repo.projectPage({ query: 'TP-SEED-0000' }).projects.length).toBe(1);
    // reminder 过滤（今日=2026-08-08）
    expect(repo.projectPage({ reminder: 'overdue' }).projects.map((p) => p.id)).toEqual(['filter-r']);
    expect(repo.projectPage({ reminder: 'any' }).projects.map((p) => p.id)).toEqual(['filter-r']);
    closeDatabase(ctx.db);
  });

  it('排序变体：created / temp / reminder 游标稳定且无重复遗漏', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    seedProjects(db, 30);
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sort-r1', 'TP-SORT-AAA', 'pending_execution', '华东', null, '备注甲', 't', '2026-08-01T00:00:00+08:00');
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sort-r2', 'TP-SORT-BBB', 'pending_execution', '华东', '2026-08-09', null, 't', '2026-08-01T00:00:00+08:00');
    const repo = reader(ctx);

    for (const sort of ['created', 'temp', 'reminder'] as const) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      const collected: WorkbenchProjectRow[] = [];
      let guard = 0;
      do {
        const page = repo.projectPage({ sort, cursor });
        for (const p of page.projects) {
          expect(seen.has(p.id), `${sort} 不应重复: ${p.id}`).toBe(false);
          seen.add(p.id);
        }
        collected.push(...page.projects);
        cursor = page.nextCursor;
        guard += 1;
        expect(guard).toBeLessThanOrEqual(5);
      } while (cursor !== null);
      expect(seen.size).toBe(33); // 1 + 30 + 2
      expect(collected.length).toBe(33);

      // temp 排序升序稳定
      if (sort === 'temp') {
        const temps = collected.map((p) => p.tempNo);
        expect([...temps].sort()).toEqual(temps);
      }
      // reminder 排序：无提醒（空串）在前，其余按提醒时间升序
      if (sort === 'reminder') {
        const reminderSortKeys = collected.map((p) => p.reminderAt ?? '');
        expect(reminderSortKeys.every((k, idx) => idx === 0 || reminderSortKeys[idx - 1] <= k)).toBe(true);
      }
    }
    closeDatabase(ctx.db);
  });
});

describe('工作台 v2 项目详情 + 子记录分页（Oracle #10）', () => {
  it('detail：金额字符串、计数、非阻塞；不存在返回 null', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 加子记录
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '20000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-12', engineers: '工程师甲、工程师乙', status: 'done', instrumentIds: [String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id)], workTypes: ['teardown'] } } });

    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.businessRevision).toBeGreaterThan(0);
    expect(detail.project).not.toBeNull();
    const p = detail.project!;
    expect(p.contractAmount).toBe('100000.00');
    expect(p.finalAmount).toBe('100000.00');
    expect(p.invoicedAmount).toBe('20000.00');
    expect(p.counts).toMatchObject({ batches: 1, instruments: 1, activities: 1, orders: 0, repairs: 0 });
    expect(detail.detail).toMatchObject({ siteConfirmed: false, contractStartDate: '2026-08-01' });

    // 不存在 → project/detail 均为 null
    const missing = facade.v2ProjectDetail('no-such-project');
    expect(missing.project).toBeNull();
    expect(missing.detail).toBeNull();
    closeDatabase(db);
  });

  it('section：六类 tab 子记录分页，total + keyset + 金额字符串', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    // 预置各 tab 记录
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1234.567' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'order', values: { orderType: 'relocation', serviceOrderNo: 'ORD-V2-001', orderedAt: '2026-08-11', engineer: '工程师甲', customerName: '集成客户甲', projectId } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-12', engineers: '工程师甲、工程师乙', status: 'done', instrumentIds: [instrumentId], workTypes: ['teardown'] } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'damage', projectId, values: { instrumentId, damageReason: '运输碰撞', issueStatus: 'processing', partNumber: 'PART-1', partQuantity: '1', partCurrency: 'USD', partAmount: '500', partStatus: 'arrived', registeredAt: '2026-08-12' } } });

    const kinds = ['batches', 'instruments', 'activities', 'orders', 'invoices', 'damage_items'] as const;
    for (const kind of kinds) {
      const page = facade.v2SectionPage({ projectId, kind });
      expect(page.kind).toBe(kind);
      expect(page.businessRevision).toBeGreaterThan(0);
      expect(page.total).toBe(1);
      expect(page.rows.length).toBe(1);
      expect(page.nextCursor).toBeNull();
      const row = page.rows[0] as WorkbenchV2SectionRow;
      expect(row.kind).toBe(kind);
      if (kind === 'invoices') {
        const invoice = row as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
        expect(invoice.amount).toBe('1234.57'); // HALF_UP 字符串
        expect(invoice.active).toBe(true);
      }
      if (kind === 'batches') {
        const batch = row as Extract<WorkbenchV2SectionRow, { kind: 'batches' }>;
        // 合同预算价 → originalPrice；物流成交价 → discountedPrice
        expect(batch.originalPrice).toBe('12000.00');
        expect(batch.discountedPrice).toBe('11000.00');
      }
      if (kind === 'activities') {
        const activity = row as Extract<WorkbenchV2SectionRow, { kind: 'activities' }>;
        expect(activity.engineers).toBe('工程师甲、工程师乙');
      }
      if (kind === 'damage_items') {
        const damage = row as Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>;
        expect(damage.partAmount).toBe('500.00');
        expect(damage.instrumentName).toBe('质谱仪');
      }
      if (kind === 'orders') {
        const order = row as Extract<WorkbenchV2SectionRow, { kind: 'orders' }>;
        expect(order.serviceOrderNo).toBe('ORD-V2-001');
      }
      if (kind === 'instruments') {
        const instrument = row as Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>;
        expect(instrument.name).toBe('质谱仪');
        expect(instrument.ups).toBe(true);
      }
    }

    // 多记录 keyset：再记一笔掉票，limit=1 翻页无重复（keyset 仅在页满时给出 nextCursor）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-13', amount: '1000' } } });
    const first = facade.v2SectionPage({ projectId, kind: 'invoices', limit: 1 });
    expect(first.total).toBe(2);
    expect(first.rows.length).toBe(1);
    expect(first.nextCursor).toBeTruthy();
    const second = facade.v2SectionPage({ projectId, kind: 'invoices', cursor: first.nextCursor! });
    expect(second.rows.length).toBe(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    closeDatabase(db);
  });
});

describe('工作台 v2 独立模块 + lookup 分页（Oracle #10）', () => {
  it('independent：serial_address / qr_request 分页、types 数组、query 过滤', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    // 序列号地址更新要求仪器已有序列号且一致
    db.prepare('UPDATE instruments SET serial_no = ? WHERE id = ?').run('SN-001', instrumentId);

    facade.v2Mutate({ op: 'submit_action', action: { type: 'serial_address', values: { instrumentId, customerName: '独立客户', newSiteAddress: '新址独立', serialNo: 'SN-001', accountId: 'ACC-IND-1', updatedAt: '2026-08-10' } } });
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人甲', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人乙', requestedAt: '2026-08-11', types: ['B'] } } });

    const serial = facade.v2IndependentPage({ kind: 'serial_address' });
    expect(serial.rows.length).toBe(1);
    expect(serial.total).toBe(1);
    const serialRow = serial.rows[0] as Extract<typeof serial.rows[number], { kind: 'serial_address' }>;
    expect(serialRow.instrumentName).toBe('质谱仪');
    expect(serialRow.accountId).toBe('ACC-IND-1');

    const qr = facade.v2IndependentPage({ kind: 'qr_request' });
    expect(qr.total).toBe(2);
    const qrRows = qr.rows as Array<Extract<typeof qr.rows[number], { kind: 'qr_request' }>>;
    expect(qrRows).toHaveLength(2);
    const byApplicant = new Map(qrRows.map((r) => [r.applicant, r]));
    expect(byApplicant.get('申请人甲')!.types).toEqual(['A', 'logistics_management']);
    expect(byApplicant.get('申请人甲')!.workload).toBe(2);
    expect(byApplicant.get('申请人乙')!.types).toEqual(['B']);
    expect(byApplicant.get('申请人乙')!.workload).toBe(1);

    // query 过滤
    expect(facade.v2IndependentPage({ kind: 'qr_request', query: '申请人乙' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'serial_address', query: 'ACC-IND-1' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'serial_address', query: '不存在' }).total).toBe(0);
    closeDatabase(db);
  });

  it('lookup：ship_to_requests / customers 分页与 query', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const req1 = facade.createShipToRequest({ customerName: 'Lookup客户甲', newSiteAddress: '新址甲' }).request;
    facade.createShipToRequest({ customerName: 'Lookup客户乙', newSiteAddress: '新址乙' });
    facade.createShipToRequest({ customerName: '另一个客户', newSiteAddress: '新址丙' });
    // 完成一条
    facade.submitShipToRequest(req1.id);
    facade.v2Mutate({ op: 'ship_to_complete', requestId: req1.id, accountId: 'ACC-LK-1' });

    const page = facade.v2LookupPage({ kind: 'ship_to_requests' });
    expect(page.total).toBe(3);
    expect(page.rows.length).toBe(3);
    const done = page.rows.find((r) => r.kind === 'ship_to_requests' && r.accountId === 'ACC-LK-1') as Extract<typeof page.rows[number], { kind: 'ship_to_requests' }>;
    expect(done.status).toBe('completed');

    // query 命中客户名 / 新址
    expect(facade.v2LookupPage({ kind: 'ship_to_requests', query: 'Lookup客户' }).total).toBe(2);
    expect(facade.v2LookupPage({ kind: 'ship_to_requests', query: '新址乙' }).total).toBe(1);

    // customers：ship-to 申请不注册客户；makeFacade(集成客户甲) + 新项目(第二个客户)
    facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '第二个客户',
        ecc: 'ECC-LK-2',
        region: '华北',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentName: '仪器',
        ups: false,
        contractAmount: '1000',
        finalAmount: '1000',
        siteConfirmed: false,
      },
    });
    const customers = facade.v2LookupPage({ kind: 'customers' });
    expect(customers.total).toBe(2);
    expect(customers.rows.every((r) => r.kind === 'customers')).toBe(true);
    expect(facade.v2LookupPage({ kind: 'customers', query: '集成' }).total).toBe(1);
    expect(facade.v2LookupPage({ kind: 'customers', query: '第二个' }).total).toBe(1);
    closeDatabase(db);
  });
});

/**
 * Oracle #10 二次复审：independent/lookup keyset 分页缺陷回归。
 * - 两个 independent kind 与两个 lookup kind 均跨 3 页（limit=10、25 条）：
 *   无重复/遗漏、nextCursor 正确终止；
 * - query 筛选后仍可带 cursor 继续翻页，且只覆盖筛选集合；
 * - 游标列带表别名（serial_address 的 LEFT JOIN 不再产生歧义列错误）。
 */
describe('Oracle #10 二次复审：independent/lookup 分页缺陷回归', () => {
  /** 按 i 生成互不相同的带偏移 ISO 时间（created_at 排序稳定）。 */
  const ts = (i: number): string => {
    const day = 1 + Math.floor(i / 86400);
    const rem = i % 86400;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `2026-08-${pad(day)}T${pad(Math.floor(rem / 3600))}:${pad(Math.floor((rem % 3600) / 60))}:${pad(rem % 60)}+08:00`;
  };

  /** 用 request.cursor 全量翻页；返回访问顺序 ids，断言无重复且页数有界。 */
  const walk = <T extends { id: string }>(
    page: (cursor: string | null) => { rows: readonly T[]; nextCursor: string | null },
  ): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = page(cursor);
      for (const row of result.rows) {
        expect(seen.has(row.id), `翻页不应重复: ${row.id}`).toBe(false);
        seen.add(row.id);
        ids.push(row.id);
      }
      cursor = result.nextCursor;
      pages += 1;
      expect(pages, '翻页页数有界').toBeLessThanOrEqual(10);
    } while (cursor !== null);
    return ids;
  };

  it('independent serial_address：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentStmt = db.prepare(
      `INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    );
    const serialStmt = db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      instrumentStmt.run(`pg-i-${i}`, projectId, `仪器${i}`, `PG-SN-${i}`, 't', 't');
      serialStmt.run(
        `pg-s-${i}`,
        `pg-i-${i}`,
        i % 2 === 0 ? '分页客户甲' : '分页客户乙',
        `新址${i}`,
        `PG-SN-${i}`,
        `ACC-PG-${i}`,
        ts(i),
        ts(i),
      );
    }
    // 跨 3 页（25 条 / limit=10）：无重复遗漏、nextCursor 在第 3 页（余 5 条）终止
    const all = walk((cursor) => facade.v2IndependentPage({ kind: 'serial_address', limit: 10, cursor }));
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);
    const first = facade.v2IndependentPage({ kind: 'serial_address', limit: 10 });
    const second = facade.v2IndependentPage({ kind: 'serial_address', limit: 10, cursor: first.nextCursor! });
    expect(second.rows.length).toBe(10);
    const third = facade.v2IndependentPage({ kind: 'serial_address', limit: 10, cursor: second.nextCursor! });
    expect(third.rows.length).toBe(5);
    expect(third.nextCursor).toBeNull();

    // query 筛选（13 条「分页客户甲」）后仍可带 cursor 翻页，且只覆盖筛选集合
    const filtered = walk((cursor) =>
      facade.v2IndependentPage({ kind: 'serial_address', query: '分页客户甲', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(13);
    expect(filtered.every((id) => id.startsWith('pg-s-'))).toBe(true);
    expect(new Set(filtered).size).toBe(13);
    // 筛选 + cursor 与不带 cursor 首页一致（cursor 不影响筛选结果集）
    const fFirst = facade.v2IndependentPage({ kind: 'serial_address', query: '分页客户甲', limit: 10 });
    expect(fFirst.nextCursor).toBeTruthy();
    closeDatabase(db);
  });

  it('independent qr_request：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const qrStmt = db.prepare(
      `INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      qrStmt.run(`pg-q-${i}`, i % 3 === 0 ? '二维码申请人甲' : i % 3 === 1 ? '二维码申请人乙' : '二维码申请人丙', ts(i), ts(i));
    }
    const all = walk((cursor) => facade.v2IndependentPage({ kind: 'qr_request', limit: 10, cursor }));
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);

    // query 筛选（9 条「二维码申请人甲」，i%3==0 → i=0,3,...,24 → 9 条）
    const filtered = walk((cursor) =>
      facade.v2IndependentPage({ kind: 'qr_request', query: '二维码申请人甲', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(9);
    expect(filtered.every((id) => id.startsWith('pg-q-'))).toBe(true);
    closeDatabase(db);
  });

  it('lookup ship_to_requests：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const reqStmt = db.prepare(
      `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      reqStmt.run(
        `pg-r-${i}`,
        i % 2 === 0 ? '分页ShipTo客户甲' : '分页ShipTo客户乙',
        `新址${i}`,
        i % 4 === 0 ? 'completed' : i % 4 === 2 ? 'processing' : 'pending_submit',
        ts(i),
        ts(i),
      );
    }
    const all = walk((cursor) => facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10, cursor }));
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);
    const first = facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10 });
    const second = facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10, cursor: first.nextCursor! });
    expect(second.rows.length).toBe(10);
    const third = facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10, cursor: second.nextCursor! });
    expect(third.rows.length).toBe(5);
    expect(third.nextCursor).toBeNull();

    // query 筛选（13 条「分页ShipTo客户甲」）后 cursor 翻页只覆盖筛选集合
    const filtered = walk((cursor) =>
      facade.v2LookupPage({ kind: 'ship_to_requests', query: '分页ShipTo客户甲', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(13);
    expect(new Set(filtered).size).toBe(13);
    closeDatabase(db);
  });

  it('lookup customers：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const customerStmt = db.prepare(
      `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      customerStmt.run(`pg-c-${i}`, `客户PG-${String(i).padStart(2, '0')}`, ts(i), ts(i));
    }
    // makeFacade 已有 集成客户甲；翻页覆盖全部 26 条（name 升序 + id 升序 keyset）
    const all = walk((cursor) => facade.v2LookupPage({ kind: 'customers', limit: 10, cursor }));
    expect(all.length).toBe(26);
    expect(new Set(all).size).toBe(26);

    // query 筛选（10 条含 PG-1 前缀：PG-10..PG-19）后 cursor 翻页只覆盖筛选集合
    const filtered = walk((cursor) =>
      facade.v2LookupPage({ kind: 'customers', query: 'PG-1', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(10); // PG-10..PG-19（PG-01 不含子串 "PG-1"）
    expect(filtered.every((id) => id.startsWith('pg-c-'))).toBe(true);
    // 升序稳定：首行字典序最小
    const ascNames = facade.v2LookupPage({ kind: 'customers', limit: 10 }).rows.map((r) => (r as { name: string }).name);
    expect([...ascNames].sort()).toEqual(ascNames);
    closeDatabase(db);
  });
});

describe('工作台 v2 mutation（Oracle #10：复用写逻辑，无 snapshot）', () => {
  it('create_project：返回 bounded 结果（revision + invalidate + changed），不返回快照', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const before = readBusinessRevision(db);
    const result = ctx.facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'Mutation客户',
        ecc: 'ECC-MUT-001',
        region: '华东',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentName: '仪器',
        ups: false,
        contractAmount: '50000',
        finalAmount: '50000',
        siteConfirmed: false,
      },
    });
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.changed?.created).toBe(true);
    expect(result.changed?.projectId).toBeTruthy();
    const tags = result.invalidated as string[];
    expect(tags).toContain('overview');
    expect(tags).toContain('projects');
    expect(tags).toContain(`project:${result.changed!.projectId}`);
    expect(tags).toContain(`sections:${result.changed!.projectId}`);
    closeDatabase(db);
  });

  it('submit_action 各类型 invalidate 标签正确；serial/qr 独立模块生效', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    db.prepare('UPDATE instruments SET serial_no = ? WHERE id = ?').run('SN-MUT', instrumentId);
    const serial = facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'serial_address', projectId, values: { instrumentId, customerName: '集成客户甲', newSiteAddress: '新址', serialNo: 'SN-MUT', accountId: 'ACC-MUT', updatedAt: '2026-08-10' } } });
    expect(serial.invalidated).toContain('independent:serial_address');
    const qr = facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A'] } } });
    expect(qr.invalidated).toContain('independent:qr_request');
    expect(qr.changed?.projectId).toBeUndefined();
    const invoice = facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    expect(invoice.invalidated).toContain(`sections:${projectId}`);
    closeDatabase(db);
  });

  it('ship_to_complete：invalidate lookup，changed 携带 request 状态与 accountId', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const created = facade.createShipToRequest({ customerName: 'ShipTo客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(created.request.id);
    const result = facade.v2Mutate({ op: 'ship_to_complete', requestId: created.request.id, accountId: 'ACC-FIN-1' });
    expect(result.changed).toMatchObject({ requestId: created.request.id, status: 'completed', accountId: 'ACC-FIN-1' });
    expect(result.invalidated).toContain('lookup:ship_to_requests');
    closeDatabase(db);
  });

  it('invoice_edit / invoice_revoke：金额字符串精确编辑，invalidate project + sections', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoiceId = String(db.prepare('SELECT id FROM invoices WHERE project_id = ?').get(projectId)!.id);
    const edited = facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-12', amount: '1234.567' });
    expect(edited.changed?.invoiceId).toBe(invoiceId);
    expect(edited.invalidated).toContain(`project:${projectId}`);
    const section = facade.v2SectionPage({ projectId, kind: 'invoices' });
    const row = section.rows[0] as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
    expect(row.amount).toBe('1234.57');

    const revoked = facade.v2Mutate({ op: 'invoice_revoke', invoiceId, time: '2026-08-13', reason: '客户更正' });
    expect(revoked.changed).toMatchObject({ invoiceId, status: 'revoked' });
    expect(revoked.invalidated).toContain(`sections:${projectId}`);
    closeDatabase(db);
  });

  it('adjust_status 拒绝 cancelled；cancel_project 经 lifecycle 校验', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    expect(() =>
      facade.v2Mutate({ op: 'adjust_status', projectId, status: 'cancelled' as never }),
    ).toThrow(/cancelProject/);
    const cancelled = facade.v2Mutate({ op: 'cancel_project', projectId, time: '2026-08-12', reason: '客户业务调整' });
    expect(cancelled.changed?.status).toBe('cancelled');
    expect(cancelled.invalidated).toContain(`project:${projectId}`);
    // 已取消：拒绝金额修改（5.11）
    expect(() =>
      facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-12', amount: '100' } } }),
    ).toThrow(/已取消/);
    closeDatabase(db);
  });

  it('未知 op 拒绝且不写库', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const before = readBusinessRevision(db);
    expect(() =>
      facadeFrom(ctx).v2Mutate({ op: 'no_such_op' as never }),
    ).toThrow(/未知的 v2 mutation/);
    expect(readBusinessRevision(db)).toBe(before);
    closeDatabase(db);
  });
});

function facadeFrom(ctx: Ctx): WorkbenchFacade {
  return ctx.facade;
}

describe('工作台 v2 BigInt 金额（Oracle #10 精度）', () => {
  it('超过 MAX_SAFE_INTEGER 的金额经 detail/page 精确往返为十进制字符串', () => {
    const dir = makeTempDir('workbench-v2-big-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      db.prepare(
        'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('acc-big', '负责人', 'hash', 'salt', 't', 't');
      const facade = new WorkbenchFacade(db, () => ({ accountId: 'acc-big', username: '负责人' }));
      const BIG = '90071992547409.93'; // 分整数 > MAX_SAFE_INTEGER
      const result = facade.v2Mutate({
        op: 'create_project',
        payload: {
          intent: 'formal',
          customerName: '超精度客户',
          ecc: 'ECC-BIG-V2',
          region: '华东',
          contractStartDate: '2026-08-01',
          contractEndDate: '2027-07-31',
          oldSiteAddress: '旧址',
          newSiteAddress: '新址',
          instrumentName: '质谱仪',
          ups: true,
          contractAmount: BIG,
          finalAmount: BIG,
          actualInstallDoneAt: '2026-08-08',
          siteConfirmed: false,
        },
      });
      const projectId = result.changed!.projectId!;
      const detail = facade.v2ProjectDetail(projectId);
      expect(detail.project!.contractAmount).toBe(BIG);
      expect(detail.project!.finalAmount).toBe(BIG);
      expect(detail.project!.invoicedAmount).toBe('0.00');
      // 掉票后累计金额也精确
      facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: BIG } } });
      const after = facade.v2ProjectDetail(projectId);
      expect(after.project!.invoicedAmount).toBe(BIG);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('工作台 v2 有界性（Oracle #10 反全量约束）', () => {
  it('projectPage 返回页内行数与 total，不因数据规模放大 DTO', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 5000);
    const repo = reader(ctx);
    const page = repo.projectPage({ limit: 50 });
    expect(page.projects.length).toBe(50);
    expect(page.total).toBe(5001);
    const serialized = JSON.stringify(page);
    // 有界：页大小固定（50 行），序列化体积与总数据量无关
    expect(serialized.length).toBeLessThan(200_000);
    closeDatabase(ctx.db);
  });

  it('overview 提醒预览固定 ≤6，不随提醒数放大', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const stmt = db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 50; i++) {
      stmt.run(`rem-${i}`, `TP-REM-${String(i).padStart(3, '0')}`, 'pending_execution', '华东', `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, `备注${i}`, 't', `2026-08-0${i % 9}T00:00:00+08:00`);
    }
    const overview = reader(ctx).overview();
    expect(overview.reminderPreview.length).toBeLessThanOrEqual(6);
    expect(overview.reminderTotal).toBe(50); // makeFacade 项目无提醒
    closeDatabase(db);
  });
});
