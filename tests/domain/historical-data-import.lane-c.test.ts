import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import {
  applyPlanInOpenTransaction,
  prepareImport,
  preflightPlan,
  runDryRun,
  runImport,
  type FaultPhase,
} from '../../src/domain/capabilities/historical-data-import/migration-service';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Gate1 Lane C：runImport 拆分为可复用阶段（prepare → preflight → applyPlanInOpenTransaction
 * → 外层原子提交），单事务内完成全部七类写入/来源审计/目标快照/写后对账；
 * 任一点失败整体回滚零业务写入；故障注入覆盖七个 writer + 审计 + 对账；
 * 前后全表内容 hash 证明零部分写入。
 */

function row(
  file: string,
  sheet: string,
  rowNumber: number,
  cells: Record<string, string | null>,
): SourceRow {
  return { file, sheet, rowNumber, cells };
}

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];
const EXEC = SOURCE_TABLE_FILES['project-execution'];
const WORKLOAD = SOURCE_TABLE_FILES['workload-stats'];

/** 全部目标业务表 + 迁移元数据表的内容摘要（前后对比证明零部分写入）。 */
function dbContentHash(db: { prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown } }): string {
  const tables = [
    'customers', 'projects', 'contracts', 'batches', 'instruments',
    'activities', 'activity_engineers', 'work_facts', 'service_orders',
    'ship_tos', 'ship_to_requests', 'serial_address_updates',
    'damage_repair_items', 'activity_damage_links', 'qr_requests', 'qr_request_types',
    'logistics_fees', 'invoices', 'migration_audit', 'import_record_audit',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** 构造同时覆盖 project + invoice + logistics + service_order 的输入。 */
function mixedRows(ecc = 'E-LANE-1'): SourceRow[] {
  return [
    row(CONTRACT, '合同信息', 2, { 'ECC#': ecc, 'Account name': '甲', 合同USD含税金额: '100' }),
    row(EXEC, '搬迁项目', 2, { 'ECC#': ecc, 客户单位名称: '甲' }),
    row(WORKLOAD, '掉票记录表', 2, { ECC: ecc, '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
    row(WORKLOAD, '物流费用表', 2, { ECC: ecc, 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '40', 成交价格: '35', 实际物流费用: '30' }),
    row(WORKLOAD, '开单记录表', 2, { 单号: `SO-${ecc}`, 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
  ];
}

describe('Lane C：runImport 拆分可复用阶段', () => {
  it('prepareImport 构建 plan + 批次；preflightPlan 零问题；applyPlanInOpenTransaction 在事务内写入', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = mixedRows();
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      expect(dry.importable).toBe(true);

      // Phase 1：prepare（零写校验）
      const prepared = prepareImport({ rows, mapping: MAPPING_V1, expectedSourceDigest: dry.sourceDigest });
      expect(prepared.plan.projects).toHaveLength(1);
      expect(prepared.batches.length).toBeGreaterThan(0);
      // preflight 独立可调用
      expect(preflightPlan(prepared.plan)).toHaveLength(0);

      // Phase 3：在调用方事务内 apply（本函数不 BEGIN/COMMIT）
      db.exec('BEGIN IMMEDIATE');
      const applied = applyPlanInOpenTransaction(db, prepared);
      expect(applied.batches.every((b) => b.status === 'success')).toBe(true);
      expect(applied.writtenCounts.project).toBe(1);
      expect(applied.writtenCounts.invoice).toBe(1);
      expect(applied.writtenCounts.logistics_fee).toBe(1);
      expect(applied.writtenCounts.service_order).toBe(1);
      db.exec('COMMIT');

      // 全部落库
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('applyPlanInOpenTransaction 本身不调用事务控制：事务边界完全由外层 COMMIT/ROLLBACK 决定', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = mixedRows('E-TXCTL-1');
      const prepared = prepareImport({ rows, mapping: MAPPING_V1 });

      // 外层开事务 → applyPlan 写入 → 外层 ROLLBACK → 零写入（证明本函数无内部 COMMIT）
      db.exec('BEGIN IMMEDIATE');
      const applied = applyPlanInOpenTransaction(db, prepared);
      expect(applied.batches.every((b) => b.status === 'success')).toBe(true);
      // 事务内已写（未提交，同连接可见）
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      db.exec('ROLLBACK');
      // 回滚后零写入：证明 applyPlan 未自行 COMMIT
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get() as { n: number }).n).toBe(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('单事务原子：一次 BEGIN IMMEDIATE 内完成七类 + 审计 + 快照 + 对账，失败整体回滚', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = mixedRows('E-ATOM-1');
      // 手工注入：所有 writer 正常但 reconcile 前触发故障 → 整体回滚
      let hitReconcile = false;
      const result = runImport(db, {
        rows,
        mapping: MAPPING_V1,
        injectFault: (phase: FaultPhase) => {
          if (phase === 'reconcile') {
            hitReconcile = true;
            throw new Error('reconcile 注入失败');
          }
        },
      });
      expect(hitReconcile).toBe(true);
      expect(result.batches.every((b) => b.status === 'failed')).toBe(true);
      // 零业务写入：全部表为空
      for (const t of ['projects', 'contracts', 'customers', 'invoices', 'logistics_fees', 'batches', 'service_orders', 'migration_audit', 'import_record_audit']) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
      }
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('applyPlanInOpenTransaction 幂等重跑：同源全部批次 skipped，不重复写入', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = mixedRows('E-IDEM-1');
      runImport(db, { rows, mapping: MAPPING_V1 });
      const before = dbContentHash(db as never);
      // 同源重跑
      const prepared = prepareImport({ rows, mapping: MAPPING_V1 });
      db.exec('BEGIN IMMEDIATE');
      const applied = applyPlanInOpenTransaction(db, prepared);
      db.exec('COMMIT');
      expect(applied.batches.every((b) => b.status === 'skipped')).toBe(true);
      expect(applied.writtenCounts.project).toBe(0);
      expect(dbContentHash(db as never)).toBe(before); // 内容不变
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Lane C：七类 writer + 审计 + 对账故障注入（前后全表 hash 零部分写入）', () => {
  const phases: FaultPhase[] = [
    'writer_project',
    'writer_service_order',
    'writer_invoice',
    'writer_logistics_fee',
    'writer_serial_address_update',
    'writer_qr_request',
    'writer_ship_to_request',
    'audit',
    'reconcile',
  ];

  for (const phase of phases) {
    it(`故障注入 @${phase} → 整体回滚零业务写入（前后全表内容 hash 一致）`, () => {
      const dir = makeTempDir();
      try {
        const { db } = bootstrapDatabase({ dataDir: dir });
        const rows: SourceRow[] = [
          ...mixedRows(`E-FAULT-${phase.replace('_', '-')}`),
          row(WORKLOAD, '搬迁地址信息表', 2, { 单位名称: '甲', 新址地址: '址A', 序列号: 'SN-1', 'Account ID': 'ACC-1', 更新日期: '2026-01-06T00:00:00+08:00' }),
          row(WORKLOAD, '服务二维码表', 2, { 日期: '2026-01-07T00:00:00+08:00', 申请人: '甲', 申请类型: 'A' }),
          row(WORKLOAD, 'Ship-to申请', 2, { 客户名称: '甲', 新址地址: '址B' }),
        ];
        const before = dbContentHash(db as never);
        let hit = false;
        const result = runImport(db, {
          rows,
          mapping: MAPPING_V1,
          injectFault: (p: FaultPhase) => {
            if (p === phase) {
              hit = true;
              throw new Error(`注入故障 @${phase}`);
            }
          },
        });
        expect(hit).toBe(true);
        expect(result.batches.length).toBeGreaterThan(0);
        expect(result.batches.every((b) => b.status === 'failed')).toBe(true);
        expect(result.batches[0].errorDetails).toContain(`注入故障 @${phase}`);
        // 前后全表内容 hash 一致 → 零部分写入
        expect(dbContentHash(db as never)).toBe(before);
        closeDatabase(db);
      } finally {
        cleanupTempDir(dir);
      }
    });
  }

  it('重复执行：相同输入多次运行结果一致、内容稳定（幂等）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = mixedRows('E-REPEAT-1');
      const r1 = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(r1.batches.every((b) => b.status === 'success')).toBe(true);
      const afterFirst = dbContentHash(db as never);
      // 重复执行：全部 skipped，内容不变
      const r2 = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(r2.batches.every((b) => b.status === 'skipped')).toBe(true);
      expect(dbContentHash(db as never)).toBe(afterFirst);
      const r3 = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(r3.batches.every((b) => b.status === 'skipped')).toBe(true);
      expect(dbContentHash(db as never)).toBe(afterFirst);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
