import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteServiceOrderRepository } from '../../src/domain/capabilities/local-data-persistence/service-order-repositories';
import { SqliteProjectRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { createPendingProject } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { ServiceOrderService } from '../../src/domain/capabilities/service-order-recording/service-order-service';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * service-order-recording SQLite 集成（tasks 3.12）。
 * 验证独立开单在真实临时 SQLite 上落库、关闭重开保留及服务单号唯一索引兜底。
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
  const orders = new SqliteServiceOrderRepository(db);
  const orderService = new ServiceOrderService(orders, projects, CLOCK);
  return { db, dbPath, projects, orders, orderService };
}

describe('service-order-recording SQLite 集成（3.12）', () => {
  it('四类开单落库、关闭重开保留，搬迁开单关联项目', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const project = createPendingProject();
      ctx.projects.save(project);

      const relocation = ctx.orderService.recordOrder(
        {
          orderType: 'relocation',
          serviceOrderNo: 'ORD-100',
          engineer: '工程师甲',
          customerName: '华东医药',
          projectId: project.id,
        },
        ACTOR,
      );
      ctx.orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-101', engineer: '工程师乙', customerName: '华北医药' },
        ACTOR,
      );
      ctx.orderService.recordOrder(
        { orderType: 'parts_by_mail', serviceOrderNo: 'ORD-102', engineer: '工程师丙', customerName: '华南医药' },
        ACTOR,
      );
      const pm = ctx.orderService.recordOrder(
        { orderType: 'pm', serviceOrderNo: 'ORD-103', engineer: '工程师丁', customerName: '西部医药' },
        ACTOR,
      );

      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.orders.findById(relocation.id)?.projectId).toBe(project.id);
      expect(reopened.orders.findById(relocation.id)?.engineer).toBe('工程师甲');
      expect(reopened.orders.listByProject(project.id)).toHaveLength(1);
      expect(reopened.orders.findById(pm.id)?.orderType).toBe('pm');
      expect(reopened.orders.list()).toHaveLength(4);
      expect(reopened.orderService.countWorkload().reduce((s, r) => s + r.count, 0)).toBe(4);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('服务单号全局唯一：领域校验 + SQLite 部分唯一索引兜底', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      ctx.orderService.recordOrder(
        { orderType: 'pm', serviceOrderNo: 'ORD-200', engineer: '工程师甲', customerName: '客户A' },
        ACTOR,
      );

      // 领域层拒绝
      expect(() =>
        ctx.orderService.recordOrder(
          { orderType: 'certification', serviceOrderNo: 'ORD-200', engineer: '工程师乙', customerName: '客户B' },
          ACTOR,
        ),
      ).toThrow(/全局唯一/);

      // 绕过领域层直接 UPDATE 仍被数据库唯一索引拒绝
      expect(() =>
        ctx.db
          .prepare('UPDATE service_orders SET service_order_no = ? WHERE service_order_no = ?')
          .run('ORD-200', 'ORD-200'),
      ).not.toThrow();
      // 直接插入重复单号被拒
      expect(() =>
        ctx.db
          .prepare(
            'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run('o-dup', 'certification', 'ORD-200', 't', '工程师', '客户', 't', 't'),
      ).toThrow();
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('独立搬迁开单默认当天并保存账号归属快照', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const project = createPendingProject();
      ctx.projects.save(project);
      const order = ctx.orderService.recordOrder(
        { orderType: 'relocation', serviceOrderNo: 'ORD-300', engineer: '工程师甲、工程师乙', customerName: '华东医药', projectId: project.id },
        ACTOR,
      );

      expect(ctx.projects.findById(project.id)?.id).toBe(project.id);
      expect(ctx.orders.findById(order.id)?.serviceOrderNo).toBe('ORD-300');
      expect(ctx.orders.findById(order.id)?.projectId).toBe(project.id);
      expect(ctx.orders.findById(order.id)?.orderedAt).toBe('2026-08-07');
      // 账号归属快照持久化
      const orderRow = ctx.db
        .prepare('SELECT account_id, username_snapshot FROM service_orders WHERE id = ?')
        .get(order.id) as { account_id: string; username_snapshot: string };
      expect(orderRow.account_id).toBe('account-1');
      expect(orderRow.username_snapshot).toBe('负责人甲');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

});
