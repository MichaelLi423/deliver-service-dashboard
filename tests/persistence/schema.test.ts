import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { schemaTableNames } from '../../src/domain/capabilities/local-data-persistence/schema';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

describe('初始 schema（tasks 1.9）：覆盖 14 能力核心表/事实表与关键 ID 约束', () => {
  it('核心表全部创建', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      const names = rows.map((r) => r.name).sort();
      for (const table of schemaTableNames()) {
        expect(names).toContain(table);
      }
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('客户名称 trim 后唯一：数据库层唯一约束（待进单阶段合同可空）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '华东医药',
        '2026-08-07T00:00:00+08:00',
        '2026-08-07T00:00:00+08:00',
      );
      expect(() =>
        db
          .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
          .run('c2', ' 华东医药 ', '2026-08-07T00:00:00+08:00', '2026-08-07T00:00:00+08:00'),
      ).toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('ECC 全局唯一（可空：待进单阶段无 ECC）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p1', 'TP-1', 'pending_entry', 't', 't');
      db.prepare(
        'INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('k1', 'p1', 'TP-1', 't', 't');
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p2', 'TP-2', 'pending_entry', 't', 't');
      db.prepare(
        'INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('k2', 'p2', 'TP-2', 't', 't');
      // 无 ECC 的合同可多个（可空唯一）；同项目合同 1:1
      expect(() => db.prepare('INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)').run('k3', 'p1', 'TP-3', 't', 't')).toThrow(); // project 1:1 约束
      db.prepare('UPDATE contracts SET ecc = ? WHERE id = ?').run('ECC-001', 'k1');
      expect(() => db.prepare('UPDATE contracts SET ecc = ? WHERE id = ?').run('ECC-001', 'k2')).toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('非空服务单号全局唯一（四类共用唯一空间）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('o1', 'relocation', 'ORD-001', '2026-08-07T10:00:00+08:00', '工程师甲', '华东医药', 't', 't');
      // 另一业务类型共用同一唯一空间
      expect(() =>
        db
          .prepare(
            'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run('o2', 'pm', 'ORD-001', '2026-08-07T10:00:00+08:00', '工程师乙', '华北医药', 't', 't'),
      ).toThrow();
      // 多个空服务单号允许
      db.prepare(
        'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('o3', 'pm', null, '2026-08-07T10:00:00+08:00', '工程师乙', '华北医药', 't', 't');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('非空序列号在同一项目内唯一、跨项目可重复（TBD-02）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      for (const id of ['p1', 'p2']) {
        db.prepare(
          'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
        ).run(id, `TP-${id}`, 'pending_entry', 't', 't');
      }
      db.prepare(
        'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('i1', 'p1', '仪器A', 't', 't');
      db.prepare(
        'INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('i2', 'p1', '仪器B', 'SN-100', 't', 't');
      // 同项目重复序列号被拒
      expect(() =>
        db
          .prepare(
            'INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          )
          .run('i3', 'p1', '仪器C', 'SN-100', 't', 't'),
      ).toThrow();
      // 跨项目重复允许
      expect(() =>
        db
          .prepare(
            'INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          )
          .run('i4', 'p2', '仪器D', 'SN-100', 't', 't'),
      ).not.toThrow();
      // 无序列号占位允许
      expect(() =>
        db
          .prepare(
            'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
          )
          .run('i5', 'p2', '占位仪器', 't', 't'),
      ).not.toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('Ship-to Account ID 全局唯一且创建后不可修改（无 UPDATE 约束由应用层落实）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        'INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)',
      ).run('s1', 'ACC-001', '华东医药', '新址A', 't');
      expect(() =>
        db
          .prepare(
            'INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)',
          )
          .run('s2', 'ACC-001', '华东医药', '新址B', 't'),
      ).toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('每批次仅一笔实际物流费用记录', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p1', 'TP-batch', 'pending_entry', 't', 't');
      db.prepare(
        'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
      ).run('b1', 'p1', 't', 't');
      db.prepare(
        'INSERT INTO logistics_fees (id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('f1', 'b1', '2026-07-15T00:00:00+08:00', 10000, 12000, 11000, 't', 't');
      expect(() =>
        db
          .prepare(
            'INSERT INTO logistics_fees (id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run('f2', 'b1', '2026-08-01T00:00:00+08:00', 10000, 12000, 11000, 't', 't'),
      ).toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
