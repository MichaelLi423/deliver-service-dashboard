import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteActivityDamageLinkRepository,
  SqliteContractAmountReader,
  SqliteDamageInstrumentReader,
  SqliteDamageRepairItemRepository,
  SqliteRepairActivityReader,
} from '../../src/domain/capabilities/local-data-persistence/damage-repair-repositories';
import { SqliteQrRequestRepository } from '../../src/domain/capabilities/local-data-persistence/qr-request-repositories';
import { DamageRepairService } from '../../src/domain/capabilities/damage-repair-tracking/damage-repair-service';
import { QrRequestService } from '../../src/domain/capabilities/qr-request-tracking/qr-request-service';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * damage-repair-tracking（4.13）与 qr-request-tracking（4.14）SQLite 集成。
 * 验证领域行为在真实临时 SQLite 上落库、关闭重开保留、账号归属快照持久化，
 * 以及数据库唯一约束兜底。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const items = new SqliteDamageRepairItemRepository(db);
  const links = new SqliteActivityDamageLinkRepository(db);
  const instrumentReader = new SqliteDamageInstrumentReader(db);
  const activityReader = new SqliteRepairActivityReader(db);
  const contractReader = new SqliteContractAmountReader(db);
  const damageService = new DamageRepairService(
    items,
    links,
    instrumentReader,
    activityReader,
    contractReader,
    CLOCK,
  );

  const requests = new SqliteQrRequestRepository(db);
  const qrService = new QrRequestService(requests, CLOCK);

  return { db, dbPath, items, links, damageService, requests, qrService, contractReader };
}

describe('damage-repair-tracking SQLite 集成（4.13）', () => {
  it('事项全流程落库：登记→维修→备件已使用→维修上门关联，关闭重开保留', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.db
        .prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('p-1', 'TP-1', 'pending_execution', 't', 't');
      ctx.db
        .prepare('INSERT INTO contracts (id, project_id, temp_number, usd_tax_amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('c-1', 'p-1', 'TP-1', '200000', 't', 't');
      ctx.db
        .prepare('INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('i-1', 'p-1', '仪器A', 'SN-100', 't', 't');
      ctx.db
        .prepare('INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)')
        .run('act-1', 'p-1', 't', 't');
      ctx.db
        .prepare('INSERT INTO work_facts (id, activity_id, instrument_id, work_type, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('wf-1', 'act-1', 'i-1', 'repair', 'done', 't', 't', 't');

      const item = ctx.damageService.registerItem(
        'i-1',
        { damageReason: '运输碰撞', partNumber: 'PART-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD', partStatus: 'arrived' },
        ACTOR,
      );
      ctx.damageService.updateIssueStatus(item.id, 'processing', null, ACTOR);
      ctx.damageService.setPartStatus(item.id, 'used', ACTOR);
      ctx.damageService.linkRepairActivity('act-1', item.id, ACTOR);

      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const stored = reopened.items.findById(item.id)!;
      expect(stored.issueStatus).toBe('processing');
      expect(stored.partStatus).toBe('used');
      expect(reopened.damageService.usedPartUsdCents(stored)).toBe(10000n);
      expect(reopened.links.listByActivity('act-1')).toHaveLength(1);

      const row = reopened.db
        .prepare('SELECT account_id, username_snapshot FROM damage_repair_items WHERE id = ?')
        .get(item.id) as { account_id: string; username_snapshot: string };
      expect(row.account_id).toBe('account-1');
      expect(row.username_snapshot).toBe('负责人甲');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('确认删除事项：仅清理指向该事项的维修上门关联，活动/其他关联/仪器保留（5.2）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.db
        .prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('p-1', 'TP-1', 'pending_execution', 't', 't');
      ctx.db
        .prepare('INSERT INTO contracts (id, project_id, temp_number, usd_tax_amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('c-1', 'p-1', 'TP-1', '200000', 't', 't');
      ctx.db
        .prepare('INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('i-1', 'p-1', '仪器A', 'SN-100', 't', 't');
      ctx.db
        .prepare('INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)')
        .run('act-1', 'p-1', 't', 't');
      ctx.db
        .prepare('INSERT INTO work_facts (id, activity_id, instrument_id, work_type, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('wf-1', 'act-1', 'i-1', 'repair', 'done', 't', 't', 't');

      const removed = ctx.damageService.registerItem('i-1', { partNumber: 'PART-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD' }, ACTOR);
      const kept = ctx.damageService.registerItem('i-1', { partNumber: 'PART-2', partQuantity: 1, partAmountCents: 20000n, partCurrency: 'USD' }, ACTOR);
      ctx.damageService.linkRepairActivity('act-1', removed.id, ACTOR);
      ctx.damageService.linkRepairActivity('act-1', kept.id, ACTOR);

      ctx.damageService.deleteItem(removed.id);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM damage_repair_items WHERE id = ?').get(removed.id)!.n).toBe(0);
      // 仅指向被删事项的关联清理；活动与其他事项关联保留
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM activity_damage_links WHERE damage_item_id = ?').get(removed.id)!.n).toBe(0);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM activity_damage_links WHERE damage_item_id = ?').get(kept.id)!.n).toBe(1);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE id = ?').get('act-1')!.n).toBe(1);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM instruments WHERE id = ?').get('i-1')!.n).toBe(1);
      expect(ctx.damageService.countItems('p-1')).toBe(1);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('维修上门 × 事项关联唯一约束兜底', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.db
        .prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('p-1', 'TP-1', 'pending_execution', 't', 't');
      ctx.db
        .prepare('INSERT INTO contracts (id, project_id, temp_number, usd_tax_amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('c-1', 'p-1', 'TP-1', '200000', 't', 't');
      ctx.db
        .prepare('INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('i-1', 'p-1', '仪器A', 'SN-100', 't', 't');
      ctx.db
        .prepare('INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)')
        .run('act-1', 'p-1', 't', 't');
      ctx.db
        .prepare('INSERT INTO work_facts (id, activity_id, instrument_id, work_type, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('wf-1', 'act-1', 'i-1', 'repair', 'done', 't', 't', 't');

      const item = ctx.damageService.registerItem(
        'i-1',
        { partNumber: 'PART-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD' },
        ACTOR,
      );
      ctx.damageService.linkRepairActivity('act-1', item.id, ACTOR);
      // 重复关联被领域层拒绝，数据库层唯一约束兜底
      expect(() => ctx.damageService.linkRepairActivity('act-1', item.id, ACTOR)).toThrow(/已关联/);
      expect(() =>
        ctx.db
          .prepare('INSERT INTO activity_damage_links (id, activity_id, damage_item_id, created_at) VALUES (?,?,?,?)')
          .run('l-dup', 'act-1', item.id, 't'),
      ).toThrow();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('TBD-15 直接入口守卫：合同金额为空/0 时拒绝已使用备件登记、直接处理中登记与维修上门关联（Oracle 修复）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.db
        .prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('p-1', 'TP-1', 'pending_execution', 't', 't');
      ctx.db
        .prepare('INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('i-1', 'p-1', '仪器A', 'SN-100', 't', 't');
      ctx.db
        .prepare('INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)')
        .run('act-1', 'p-1', 't', 't');
      ctx.db
        .prepare('INSERT INTO work_facts (id, activity_id, instrument_id, work_type, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('wf-1', 'act-1', 'i-1', 'repair', 'done', 't', 't', 't');

      const base = { partNumber: 'PART-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD' as const };

      // 合同金额为空：拒绝已使用备件登记 / 直接处理中登记 / 维修上门关联
      expect(() => ctx.damageService.registerItem('i-1', { ...base, partStatus: 'used' }, ACTOR)).toThrow(/补齐正数合同金额/);
      expect(() => ctx.damageService.registerItem('i-1', { ...base, issueStatus: 'processing' }, ACTOR)).toThrow(/补齐正数合同金额/);
      const untreated = ctx.damageService.registerItem('i-1', { ...base, partStatus: 'arrived' }, ACTOR); // 未处理仍可登记
      expect(() => ctx.damageService.linkRepairActivity('act-1', untreated.id, ACTOR)).toThrow(/补齐正数合同金额/);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM damage_repair_items').get()?.n).toBe(1);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM activity_damage_links').get()?.n).toBe(0);

      // 补齐正数合同金额后允许全部直接入口
      ctx.db
        .prepare('INSERT INTO contracts (id, project_id, temp_number, usd_tax_amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('c-1', 'p-1', 'TP-1', '200000', 't', 't');
      const used = ctx.damageService.registerItem('i-1', { ...base, partNumber: 'PART-2', partStatus: 'used' }, ACTOR);
      expect(used.partStatus).toBe('used');
      const direct = ctx.damageService.registerItem('i-1', { ...base, partNumber: 'PART-3', issueStatus: 'repaired' }, ACTOR);
      expect(direct.issueStatus).toBe('repaired');
      const link = ctx.damageService.linkRepairActivity('act-1', untreated.id, ACTOR);
      expect(link.damageItemId).toBe(untreated.id);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('qr-request-tracking SQLite 集成（4.14 / 6.2）', () => {
  it('申请记录与类型落库、关闭重开保留、工作量按去重类型计数', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const r1 = ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A', 'A', 'B'] }, ACTOR);
      const r2 = ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A', 'oem_equipment'] }, ACTOR);

      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.requests.findById(r1.id)!.types).toEqual(['A', 'B']);
      expect(reopened.requests.findById(r2.id)!.types).toEqual(['A', 'oem_equipment']);
      const workload = reopened.qrService.countWorkloadByType();
      expect(workload.find((w) => w.typeCode === 'A')?.count).toBe(2);
      expect(workload.find((w) => w.typeCode === 'B')?.count).toBe(1);
      expect(reopened.qrService.countByMonth()).toEqual([{ month: '2026-08', count: 2 }]);

      const row = reopened.db
        .prepare('SELECT account_id, username_snapshot FROM qr_requests WHERE id = ?')
        .get(r1.id) as { account_id: string; username_snapshot: string };
      expect(row.account_id).toBe('account-1');
      expect(row.username_snapshot).toBe('负责人甲');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('确认删除：多选类型一并清理，历史/工作量统计消失且不影响其他申请', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const removed = ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A', 'B'] }, ACTOR);
      const kept = ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);

      ctx.qrService.delete(removed.id);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM qr_requests WHERE id = ?').get(removed.id)!.n).toBe(0);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM qr_request_types WHERE qr_request_id = ?').get(removed.id)!.n).toBe(0);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM qr_requests WHERE id = ?').get(kept.id)!.n).toBe(1);
      // 工作量仅计剩余申请：kept 的 A 计一次
      const workload = ctx.qrService.countWorkloadByType();
      expect(workload.find((w) => w.typeCode === 'A')?.count).toBe(1);
      expect(workload.find((w) => w.typeCode === 'B')).toBeUndefined();
      expect(ctx.qrService.countByMonth()).toEqual([{ month: '2026-08', count: 1 }]);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('同一条申请内类型唯一（qr_request_types 唯一约束兜底）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const r = ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
      // 绕过领域层重复插入同一类型 → 唯一索引拒绝
      expect(() =>
        ctx.db
          .prepare('INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)')
          .run('t-dup', r.id, 'A'),
      ).toThrow();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
