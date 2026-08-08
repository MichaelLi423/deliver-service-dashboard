import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { IMPORT_WIZARD_CHANNELS, IPC_CHANNELS } from '../../src/shared/ipc';
import {
  generateDesensitizedSampleAndReport,
} from '../../src/domain/capabilities/historical-data-import/sample';
import { runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import { readExcelFile } from '../../src/domain/capabilities/historical-data-import/excel-source';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * historical-data-import 集成（tasks 8.1/8.6/8.10/8.11）。
 * 历史数据导入经工作台「历史数据导入向导」唯一入口执行（登录账号 + 受信窗口），
 * 外部迁移 CLI 已删除；引擎/映射/writer 保留供向导与合成对账测试使用。
 */

describe('8.1 导入唯一入口：历史数据导入向导（无外部 CLI）', () => {
  it('导入能力仅经 import-wizard:* 通道，工作台无其他迁移/导入通道', () => {
    // 工作台（IPC_CHANNELS）不包含迁移/导入通道；导入向导通道独立注册且全部为 import-wizard:*。
    const channels = Object.values(IPC_CHANNELS);
    const migrationLike = channels.filter(
      (c) => /migrat|import|迁/i.test(c) && c !== 'backup:restore',
    );
    expect(migrationLike).toEqual([]);
    const wizardChannels = Object.values(IMPORT_WIZARD_CHANNELS);
    expect(wizardChannels.length).toBeGreaterThan(20);
    expect(wizardChannels.every((c) => c.startsWith('import-wizard:'))).toBe(true);
  });

  it('外部迁移 CLI 已删除：无入口文件、无构建/预演脚本、无打包产物路径', () => {
    // 构建与打包产物不含 CLI 入口（防止隐藏 CLI 重新出现）。
    expect(existsSync(join(process.cwd(), 'migrate-cli.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src', 'domain', 'capabilities', 'historical-data-import', 'cli.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'out', 'migrate-cli.cjs'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['migrate:build'] ?? pkg.scripts['migrate:dry-run']).toBeUndefined();
  });

  it('历史导入必须经登录账号；runImport 旧写入路径保留为测试/对账，不改变账号语义', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const accounts = new SqliteAccountRepository(db);
      expect(accounts.findFirst()).toBeUndefined();
      const rows = [
        {
          file: SOURCE_TABLE_FILES['contract-info'],
          sheet: '合同信息',
          rowNumber: 2,
          cells: { 'ECC#': 'ECC-090', 客户名称: '客户X', 合同USD含税金额: '10000' },
        },
      ];
      // 向导写入的账号归属由 commit 协调器 + 会话守卫处理（8.53）；此处保留旧 writer 路径
      // 作合成对账：不创建本地账号、不携带自由文本 operator。
      runImport(db, { rows, mapping: MAPPING_V1 });
      expect(accounts.findFirst()).toBeUndefined();
      const project = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      expect(project.n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('8.6/8.10 脱敏样本 dry-run 与导入（不读取真实 docs Excel）', () => {
  it('对脱敏样本执行 dry-run：各 sheet 路由正确，仅真实不完整映射报错（物流必填、Ship-to 新址）', async () => {
    const dir = makeTempDir();
    try {
      const { reportPath } = await generateDesensitizedSampleAndReport({ dir, prefix: 'dryrun' });
      expect(existsSync(reportPath)).toBe(true);
      const fs = await import('node:fs');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      // 物流旧表（月份/金额/物流公司）→ applied_at/budget/deal 必填；Ship-to 待新增项缺新址
      expect(report.report.importable).toBe(false);
      const errFields = report.report.errors.map((e: { field: string }) => e.field);
      expect(errFields).toContain('logistics_fee.applied_at');
      expect(errFields).toContain('logistics_fee.budget_price_cents');
      expect(errFields).toContain('logistics_fee.deal_price_cents');
      expect(errFields).not.toContain('logistics_fee.logistics_cost_cents'); // 金额已映射
      expect(errFields).toContain('ship_to_request.new_site_address');
      // QR 类型数量 → 明确映射冲突（requested_at 由「日期」映射，不误报）
      expect(report.report.conflicts.some((c: { conflictCode: string }) => c.conflictCode === 'QR_TYPE_COUNT_UNMAPPABLE')).toBe(true);
      expect(errFields).not.toContain('qr_request.requested_at');
      // 各 sheet 路由正确：开单/掉票/物流费用/地址更新/二维码/Ship-to申请
      expect(report.report.parse.recordCounts.service_order).toBe(2);
      expect(report.report.parse.recordCounts.invoice).toBe(1);
      expect(report.report.parse.recordCounts.serial_address_update).toBe(1);
      expect(report.report.parse.recordCounts.qr_request).toBe(1);
      expect(report.report.parse.recordCounts.ship_to_request).toBe(1);
      // 错误/冲突不含 cell value
      expect(JSON.stringify(report.report.errors)).not.toContain('2750');
      expect(JSON.stringify(report.report.errors)).not.toContain('样本运输');
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('脱敏样本中合同/项目数据可对账（记录数一致、切换后基于新模型）', async () => {
    const dir = makeTempDir();
    try {
      const { files } = await generateDesensitizedSampleAndReport({ dir, prefix: 'import' });
      const rows = [];
      for (const file of files) {
        rows.push(...(await readExcelFile(file)));
      }
      // 过滤掉会因真实不完整映射报错的 workload 行（物流旧表、Ship-to 待新增项、QR 类型数量），
      // 只保留可导入的合同/项目/开单/掉票/地址更新数据做对账。
      const importableRows = rows.filter(
        (r) =>
          !(
            r.sheet === '物流费用表' ||
            r.sheet === '搬迁地址信息表（原表无，待新增项）' ||
            r.sheet === '服务二维码表'
          ),
      );
      const { db } = bootstrapDatabase({ dataDir: dir });
      const result = runImport(db, { rows: importableRows, mapping: MAPPING_V1 });
      expect(result.importedProjectCount).toBe(2);
      expect(result.batches.every((b) => b.status === 'success')).toBe(true);

      // 对账：导入后的项目数、合同 ECC、状态重建结果与源文件一致
      const projects = db.prepare('SELECT temp_no, status FROM projects ORDER BY temp_no').all() as { temp_no: string; status: string }[];
      expect(projects).toHaveLength(2);
      const contracts = db.prepare('SELECT ecc FROM contracts ORDER BY ecc').all() as { ecc: string }[];
      expect(contracts.map((c) => c.ecc)).toEqual(['MIG-0001', 'MIG-0002']);
      // 状态由事实确定性重建（MIG-0001 含实际装机完成时间与验收报告形成日期 → 待掉票）
      const p1 = db.prepare("SELECT status FROM projects WHERE temp_no = 'MIG-MIG-0001'").get() as { status: string };
      expect(p1.status).toBe('pending_invoice');
      // 迁移审计记录（导入时间只作审计字段，不替代源业务时间）
      const audit = db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get() as { n: number };
      expect(audit.n).toBeGreaterThan(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('excel-source：表头正确跳过、报告物理行号、空白行跳过', async () => {
    const dir = makeTempDir();
    try {
      const { files } = await generateDesensitizedSampleAndReport({ dir, prefix: 'header' });
      const contractFile = files.find((f) => f.endsWith(SOURCE_TABLE_FILES['contract-info']))!;
      const rows = await readExcelFile(contractFile);
      expect(rows).toHaveLength(2);
      // 表头在第 1 行，数据从物理行 2 开始
      expect(rows[0].rowNumber).toBe(2);
      expect(rows[1].rowNumber).toBe(3);
      // ECC# 列别名被正确读取
      expect(rows[0].cells['ECC#']).toBe('MIG-0001');
    } finally {
      cleanupTempDir(dir);
    }
  });
});
