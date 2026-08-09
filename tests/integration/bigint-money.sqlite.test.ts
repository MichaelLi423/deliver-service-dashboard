import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteContractRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import { SqliteInvoiceRepository } from '../../src/domain/capabilities/local-data-persistence/financial-repositories';
import {
  SqliteBatchRepository,
  SqliteInstrumentRepository,
  SqliteLogisticsFeeRepository,
} from '../../src/domain/capabilities/local-data-persistence/execution-repositories';
import { SqliteDamageRepairItemRepository } from '../../src/domain/capabilities/local-data-persistence/damage-repair-repositories';
import { SqliteReportingFactReader } from '../../src/domain/capabilities/local-data-persistence/reporting-fact-reader';
import type { Batch } from '../../src/domain/capabilities/relocation-execution';
import type { Instrument } from '../../src/domain/capabilities/relocation-execution';
import type { Contract } from '../../src/domain/capabilities/relocation-project-lifecycle';
import type { InvoiceRecord } from '../../src/domain/capabilities/project-financial-closure';
import type { DamageRepairItem } from '../../src/domain/capabilities/damage-repair-tracking';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Oracle 高风险 6：金额/分整数 SQLite 读取必须走 BigInt 安全路径。
 * node:sqlite 未启用 setReadBigInts 时，超过 Number.MAX_SAFE_INTEGER 的
 * INTEGER 直接抛 RangeError（绝不静默丢精度）。本测试验证 contracts/invoices/
 * batches/logistics_fees/damage_repair_items 以及报表基础读取（ReportingFactReader）
 * 在存取重开后无精度丢失。
 */

const BIG = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 1

/** 初始化数据库：项目 + 合同 + 批次 + 仪器 fixture（后续金额由仓储写入）。 */
function seedBase(db: DatabaseSync): void {
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'TP-1', 'pending_execution', 't', 't');
}

function openRepos(db: DatabaseSync) {
  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const batches = new SqliteBatchRepository(db);
  const instruments = new SqliteInstrumentRepository(db);
  const fees = new SqliteLogisticsFeeRepository(db);
  const invoices = new SqliteInvoiceRepository(db);
  const damage = new SqliteDamageRepairItemRepository(db);
  const invoiceReader = new SqliteInvoiceReadRepository(db);
  const reporting = new SqliteReportingFactReader(db);
  return { projects, contracts, batches, instruments, fees, invoices, damage, invoiceReader, reporting };
}

function makeContract(projectId: string, amount: bigint): Contract {
  return {
    id: 'c1',
    projectId,
    tempNumber: 'TP-1',
    ecc: 'ECC-1',
    eccLastModifiedAt: null,
    usdTaxAmountCents: amount,
    entryAmountSnapshotCents: amount + 1n,
    finalConfirmableAmountCents: amount + 2n,
    createdAt: 't',
    updatedAt: 't',
  };
}

function makeBatch(projectId: string): Batch {
  return {
    id: 'b1',
    projectId,
    planTransportDate: null,
    transportCompany: '物流A',
    originalPriceCents: BIG,
    discountedPriceCents: BIG + 1n,
    startedAt: null,
    accountId: null,
    usernameSnapshot: null,
    createdAt: 't',
    updatedAt: 't',
  };
}

function makeInstrument(projectId: string): Instrument {
  return {
    id: 'i1',
    projectId,
    batchId: null,
    name: '仪器A',
    model: null,
    serialNo: 'SN-1',
    ups: false,
    qrRequested: false,
    destinationShipToId: null,
    accountId: null,
    usernameSnapshot: null,
    createdAt: 't',
    updatedAt: 't',
  };
}

function makeDamageItem(projectId: string): DamageRepairItem {
  return {
    id: 'd1',
    instrumentId: 'i1',
    projectId,
    damageReason: '运输碰撞',
    issueStatus: 'untreated',
    closeReason: null,
    partNumber: 'PART-1',
    partQuantity: 1,
    partAmountCents: BIG,
    partCurrency: 'USD',
    partRequestedAt: null,
    partStatus: null,
    repairNote: null,
    registeredAt: 't',
    operatorAccountId: null,
    operatorUsername: null,
    createdAt: 't',
    updatedAt: 't',
  };
}

/** 打开/重开数据目录并返回仓储上下文。 */
function openService(dir: string) {
  const { db } = bootstrapDatabase({ dataDir: dir });
  return { db, ...openRepos(db) };
}

describe('金额/分整数超过 Number.MAX_SAFE_INTEGER：存取重开无精度丢失', () => {
  it('contracts：三列金额以 BigInt 精确存取，关闭重开不变', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      seedBase(ctx.db);
      ctx.contracts.save(makeContract('p1', BIG));

      closeDatabase(ctx.db);
      const reopened = openService(dir);
      const read = reopened.contracts.findByProjectId('p1')!;
      expect(read.usdTaxAmountCents).toBe(BIG);
      expect(read.entryAmountSnapshotCents).toBe(BIG + 1n);
      expect(read.finalConfirmableAmountCents).toBe(BIG + 2n);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('invoices：掉票金额 BigInt 精确存取，sumActiveAmounts 聚合精确', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      seedBase(ctx.db);
      const mkInvoice = (id: string, amount: bigint): InvoiceRecord => ({
        id,
        projectId: 'p1',
        amountCents: amount,
        invoicedAt: '2026-08-01',
        revokedAt: null,
        revokeReason: null,
        lastModifiedAt: 't',
        operatorAccountId: null,
        operatorUsername: null,
        createdAt: 't',
      });
      ctx.invoices.save(mkInvoice('inv1', BIG));
      ctx.invoices.save(mkInvoice('inv2', BIG + 5n));

      closeDatabase(ctx.db);
      const reopened = openService(dir);
      expect(reopened.invoices.findById('inv1')!.amountCents).toBe(BIG);
      expect(reopened.invoices.listByProject('p1').map((i) => i.amountCents).sort((a, b) => (a > b ? 1 : -1))).toEqual([
        BIG,
        BIG + 5n,
      ]);
      // 聚合求和同样精确（> 2^53 的两笔相加）
      expect(reopened.invoiceReader.sumActiveAmounts('p1')).toBe(BIG + BIG + 5n);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('batches + logistics_fees：报价与三项物流金额 BigInt 精确存取', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      seedBase(ctx.db);
      ctx.batches.save(makeBatch('p1'));
      ctx.fees.save({
        id: 'f1',
        batchId: 'b1',
        appliedAt: '2026-08-01',
        budgetPriceCents: BIG,
        dealPriceCents: BIG + 10n,
        logisticsCostCents: BIG + 20n,
        accountId: null,
        usernameSnapshot: null,
        createdAt: 't',
        updatedAt: 't',
      });

      closeDatabase(ctx.db);
      const reopened = openService(dir);
      const batch = reopened.batches.findById('b1')!;
      expect(batch.originalPriceCents).toBe(BIG);
      expect(batch.discountedPriceCents).toBe(BIG + 1n);
      const fee = reopened.fees.findByBatchId('b1')!;
      expect(fee.budgetPriceCents).toBe(BIG);
      expect(fee.dealPriceCents).toBe(BIG + 10n);
      expect(fee.logisticsCostCents).toBe(BIG + 20n);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('damage_repair_items：备件金额 BigInt 精确存取，按项目列表读取一致', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      seedBase(ctx.db);
      ctx.instruments.save(makeInstrument('p1'));
      ctx.damage.save(makeDamageItem('p1'));

      closeDatabase(ctx.db);
      const reopened = openService(dir);
      const item = reopened.damage.findById('d1')!;
      expect(item.partAmountCents).toBe(BIG);
      expect(reopened.damage.listByProject('p1')[0]!.partAmountCents).toBe(BIG);
      // 严禁 String(null)：未填备件号/数量的旧数据读取不产生 "null" 字符串
      reopened.db
        .prepare(
          `INSERT INTO damage_repair_items (
             id, instrument_id, project_id, issue_status, registered_at, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?)`,
        )
        .run('d-legacy', 'i1', 'p1', 'untreated', 't', 't', 't');
      const legacy = reopened.damage.findById('d-legacy')!;
      expect(legacy.partNumber).toBe('');
      expect(legacy.partQuantity).toBe(0);
      expect(legacy.partNumber).not.toBe('null');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('报表基础读取（ReportingFactReader）：contracts/invoices/batches/logistics/damage 全部 BigInt 精确', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      seedBase(db);
      const { contracts, batches, instruments, fees, invoices, damage } = openRepos(db);
      contracts.save(makeContract('p1', BIG));
      batches.save(makeBatch('p1'));
      instruments.save(makeInstrument('p1'));
      fees.save({
        id: 'f1',
        batchId: 'b1',
        appliedAt: '2026-08-01',
        budgetPriceCents: BIG,
        dealPriceCents: BIG + 10n,
        logisticsCostCents: BIG + 20n,
        accountId: null,
        usernameSnapshot: null,
        createdAt: 't',
        updatedAt: 't',
      });
      invoices.save({
        id: 'inv1',
        projectId: 'p1',
        amountCents: BIG,
        invoicedAt: '2026-08-01',
        revokedAt: null,
        revokeReason: null,
        lastModifiedAt: 't',
        operatorAccountId: null,
        operatorUsername: null,
        createdAt: 't',
      });
      damage.save(makeDamageItem('p1'));

      const reporting = new SqliteReportingFactReader(db);
      expect(reporting.listContracts()[0]!.usdTaxAmountCents).toBe(BIG);
      expect(reporting.listBatches()[0]!.originalPriceCents).toBe(BIG);
      expect(reporting.listLogisticsFees()[0]!.dealPriceCents).toBe(BIG + 10n);
      expect(reporting.listInvoices()[0]!.amountCents).toBe(BIG);
      expect(reporting.listDamageItems()[0]!.partAmountCents).toBe(BIG);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('未启用 BigInt 读取时超大 INTEGER 直接报错（绝不静默丢精度）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p1', 'TP-1', 'pending_execution', 't', 't');
      db.prepare(
        'INSERT INTO contracts (id, project_id, temp_number, usd_tax_amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('c1', 'p1', 'TP-1', BIG.toString(), 't', 't');
      // 默认读取（非 BigInt 路径）读取超大整数抛 RangeError，而非返回丢失精度的数字
      expect(() => db.prepare('SELECT usd_tax_amount_cents FROM contracts WHERE id = ?').get('c1')).toThrow(
        RangeError,
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
