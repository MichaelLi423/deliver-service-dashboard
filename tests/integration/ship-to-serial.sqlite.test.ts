import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteShipToAddressReader,
  SqliteShipToRepository,
  SqliteShipToRequestRepository,
} from '../../src/domain/capabilities/local-data-persistence/ship-to-repositories';
import { SqliteSerialAddressUpdateRepository } from '../../src/domain/capabilities/local-data-persistence/serial-address-update-repositories';
import { SqliteInstrumentAddressReader } from '../../src/domain/capabilities/local-data-persistence/serial-address-update-repositories';
import { ShipToService } from '../../src/domain/capabilities/ship-to-management/ship-to-service';
import { SerialAddressUpdateService } from '../../src/domain/capabilities/serial-address-update/serial-address-update-service';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * ship-to-management（4.11）与 serial-address-update（4.12）SQLite 集成。
 * 验证领域行为在真实临时 SQLite 上落库、关闭重开保留、账号归属快照持久化，
 * 以及数据库唯一约束兜底。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  // 测试账号：归属快照引用的本地账号（id = account-1）
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const shipTos = new SqliteShipToRepository(db);
  const requests = new SqliteShipToRequestRepository(db);
  const reader = new SqliteShipToAddressReader(db);
  const shipToService = new ShipToService(shipTos, requests, reader, CLOCK);

  const updates = new SqliteSerialAddressUpdateRepository(db);
  const instrumentReader = new SqliteInstrumentAddressReader(db);
  const serialService = new SerialAddressUpdateService(updates, instrumentReader, CLOCK);

  return { db, dbPath, shipTos, requests, shipToService, updates, serialService };
}

describe('ship-to-management SQLite 集成（4.11）', () => {
  it('申请全流程落库：创建→提交→补 Account ID 完成并创建 Ship-to，关闭重开保留', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const request = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      ctx.shipToService.submit(request.id, ACTOR);
      ctx.shipToService.complete(request.id, 'ACC-100', ACTOR);

      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const stored = reopened.requests.findById(request.id)!;
      expect(stored.status).toBe('completed');
      expect(stored.accountId).toBe('ACC-100');
      expect(reopened.shipTos.findByAccountId('ACC-100')?.newSiteAddress).toBe('新址A');
      expect(reopened.shipToService.countWorkloadByMonth()).toEqual([{ month: '2026-08', count: 1 }]);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号归属快照持久化：申请操作绑定当前登录账号', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const request = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      const row = ctx.db
        .prepare('SELECT actor_account_id, username_snapshot FROM ship_to_requests WHERE id = ?')
        .get(request.id) as { actor_account_id: string; username_snapshot: string };
      expect(row.actor_account_id).toBe('account-1');
      expect(row.username_snapshot).toBe('负责人甲');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('同客户同新址一条申请：trim 后去重，SQLite 仓储 findByCustomerAndAddress 命中（Oracle 修复）', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const r1 = ctx.shipToService.createRequest({ customerName: ' 华东医药 ', newSiteAddress: ' 新址A ' }, ACTOR);
      // 仓储按 trim 后值可查
      expect(ctx.requests.findByCustomerAndAddress('华东医药', '新址A')!.id).toBe(r1.id);
      // trim 后同客户同新址 → 返回既有申请，不重复创建
      const again = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      expect(again.id).toBe(r1.id);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM ship_to_requests').get()?.n).toBe(1);

      // 推进到已完成并补入 Account ID，重复申请仍返回既有
      ctx.shipToService.submit(r1.id, ACTOR);
      ctx.shipToService.complete(r1.id, 'ACC-600', ACTOR);
      const completedAgain = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      expect(completedAgain.id).toBe(r1.id);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM ship_to_requests').get()?.n).toBe(1);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM ship_tos WHERE account_id = ?').get('ACC-600')?.n).toBe(1);

      // 新址不同仍分别创建
      const r2 = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址B' }, ACTOR);
      expect(r2.id).not.toBe(r1.id);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM ship_to_requests').get()?.n).toBe(2);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('Account ID 全局唯一：数据库唯一索引兜底', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.shipToService.createShipTo('ACC-200', '客户', '地址');
      // 绕过领域层直接插入重复 Account ID → 唯一索引拒绝
      expect(() =>
        ctx.db
          .prepare('INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)')
          .run('s-dup', 'ACC-200', '客户2', '地址2', 't'),
      ).toThrow();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('serial-address-update SQLite 集成（4.12）', () => {
  it('更新事实落库：客户/新址/序列号/Account ID/更新时间与归属快照，关闭重开保留', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.db
        .prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('p-1', 'TP-1', 'pending_execution', 't', 't');
      ctx.db
        .prepare('INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('i-1', 'p-1', '仪器A', 'SN-100', 't', 't');

      const update = ctx.serialService.register(
        'i-1',
        { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-100', accountId: 'ACC-300', updatedAt: '2026-08-01T09:00:00+08:00' },
        ACTOR,
      );

      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const stored = reopened.updates.findById(update.id)!;
      expect(stored.newSiteAddress).toBe('新址A');
      expect(stored.serialNo).toBe('SN-100');
      expect(stored.updatedAt).toBe('2026-08-01T09:00:00+08:00');
      expect(reopened.serialService.getActualAddress('i-1')!.accountId).toBe('ACC-300');
      expect(reopened.serialService.countByMonth()).toEqual([{ month: '2026-08', count: 1 }]);

      const row = reopened.db
        .prepare('SELECT actor_account_id, username_snapshot FROM serial_address_updates WHERE id = ?')
        .get(update.id) as { actor_account_id: string; username_snapshot: string };
      expect(row.actor_account_id).toBe('account-1');
      expect(row.username_snapshot).toBe('负责人甲');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
