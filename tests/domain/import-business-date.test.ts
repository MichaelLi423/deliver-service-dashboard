import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { localCalendarDateOf } from '../../src/domain/capabilities/local-data-persistence/business-date';
import { runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { toNormalizedRows } from '../../src/domain/capabilities/historical-data-import/seal';
import { VALIDATION_VERSION } from '../../src/domain/capabilities/historical-data-import/seal';
import { generateValidationSeal, verifyValidationSeal } from '../../src/domain/capabilities/historical-data-import/seal';
import { validatePlan } from '../../src/domain/capabilities/historical-data-import/validation';
import { buildPlanFromRows } from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import { businessKeyFromCells, type NormalizedRow } from '../../src/domain/capabilities/historical-data-import/normalized-row';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import type { ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 导入业务日期化（design D30）：导入目录/规范化/校验统一把目标业务时间视为 date。
 *
 * - 引擎（runImport）接受 Excel serial / 纯日期 / 显式偏移 ISO / 无偏移本地 datetime，
 *   落库统一为 yyyy-mm-dd；审计时间仍精确；
 * - 向导行重建（toNormalizedRows）把旧草稿/手工补录的 datetime 单元格统一换算为
 *   业务日期 —— 旧 seal/草稿无法绕过新语义；
 * - VALIDATION_VERSION 升级到 2：旧版本 seal 自动失效，必须重新完整校验。
 */

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];
const WORKLOAD = SOURCE_TABLE_FILES['workload-stats'];

function srow(file: string, sheet: string, rowNumber: number, cells: Record<string, string>): SourceRow {
  return { file, sheet, rowNumber, cells };
}

let seq = 0;
function nrow(category: ImportCategory, cells: Record<string, string | null>): NormalizedRow {
  seq += 1;
  return {
    category,
    rowId: `row-${seq}`,
    sourceRowId: null,
    businessKey: businessKeyFromCells(category, cells),
    sourceKind: 'file',
    sourceFile: '来源工作簿.xlsx',
    sourceSheet: '数据表',
    sourceRow: seq + 1,
    pasteBatch: null,
    cells,
    positionOnlyIdentity: false,
  };
}

describe('导入业务日期化：引擎路径（runImport）统一输出 yyyy-mm-dd', () => {
  it('四种输入（Excel serial / 纯日期 / 显式偏移 ISO / 无偏移本地 datetime）→ 业务字段存 yyyy-mm-dd', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-1', 客户名称: '甲', 进单时间: '2026-05-01' }),
        srow(CONTRACT, '合同信息', 3, { 'ECC#': 'E-2', 客户名称: '乙', 进单时间: '2026-05-02T00:00:00' }),
        srow(CONTRACT, '合同信息', 4, { 'ECC#': 'E-3', 客户名称: '丙', 进单时间: '2026-05-03T00:00:00+08:00' }),
        srow(CONTRACT, '合同信息', 5, { 'ECC#': 'E-4', 客户名称: '丁', 进单时间: '45292' }),
      ];
      runImport(db, { rows, mapping: MAPPING_V1 });
      const byTemp = new Map(
        (db.prepare('SELECT temp_no, entry_at FROM projects ORDER BY temp_no').all() as { temp_no: string; entry_at: string }[])
          .map((r) => [r.temp_no, r.entry_at]),
      );
      expect(byTemp.get('MIG-E-1')).toBe('2026-05-01');
      expect(byTemp.get('MIG-E-2')).toBe('2026-05-02'); // 无偏移本地 datetime → 墙钟日期
      expect(byTemp.get('MIG-E-3')).toBe(localCalendarDateOf(new Date('2026-05-03T00:00:00+08:00')));
      expect(byTemp.get('MIG-E-4')).toBe('2024-01-01'); // Excel serial 45292（1900 系统）
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('子记录业务时间（开单/掉票/物流/更新/申请）同样统一为 yyyy-mm-dd', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-5', 客户名称: '甲' }),
        srow(WORKLOAD, '开单记录表', 2, { 单号: 'SO-5', 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
        srow(WORKLOAD, '掉票记录表', 2, { ECC: 'E-5', '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
        srow(WORKLOAD, '物流费用表', 2, { ECC: 'E-5', 物流费用申请登记时间: '2026-01-05 10:30:00', 预算价格: '40', 成交价格: '35', 实际物流费用: '30' }),
        srow(WORKLOAD, '搬迁地址信息表', 2, { 单位名称: '甲', 新址地址: '址A', 序列号: 'SN-5', 'Account ID': 'ACC-5', 更新日期: '2026-01-06' }),
        srow(WORKLOAD, '服务二维码表', 2, { 日期: '2026-01-07T00:00:00+08:00', 申请人: '甲', 申请类型: 'A' }),
      ];
      runImport(db, { rows, mapping: MAPPING_V1 });
      const order = db.prepare('SELECT ordered_at FROM service_orders WHERE service_order_no = ?').get('SO-5') as { ordered_at: string };
      expect(order.ordered_at).toBe(localCalendarDateOf(new Date('2026-01-01T00:00:00+08:00')));
      const invoice = db.prepare('SELECT invoiced_at FROM invoices LIMIT 1').get() as { invoiced_at: string };
      expect(invoice.invoiced_at).toBe(localCalendarDateOf(new Date('2026-02-01T00:00:00+08:00')));
      const fee = db.prepare('SELECT applied_at FROM logistics_fees').get() as { applied_at: string };
      expect(fee.applied_at).toBe('2026-01-05'); // 无偏移本地 datetime → 墙钟日期
      const update = db.prepare('SELECT updated_at FROM serial_address_updates').get() as { updated_at: string };
      expect(update.updated_at).toBe('2026-01-06'); // 纯日期原样
      const qr = db.prepare('SELECT requested_at FROM qr_requests').get() as { requested_at: string };
      expect(qr.requested_at).toBe(localCalendarDateOf(new Date('2026-01-07T00:00:00+08:00')));
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('旧 seal/草稿不得绕过新语义', () => {
  it('toNormalizedRows 把旧草稿/手工补录的 datetime 单元格统一换算为业务日期', () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const draft = repo.createDraft({ name: '旧草稿', createdBy: null, createdByUsername: null });
      repo.transitionState(draft.id, 1, 'start_parsing');
      // 模拟旧语义草稿：进单时间以 datetime 单元格入库。
      repo.appendRows(draft.id, 2, 'project', [
        {
          rowId: 'r1',
          businessKey: 'E-OLD',
          cells: { 'contract.ecc': 'E-OLD', 'contract.customer_name': '甲', 'project.entry_at': '2026-05-01T00:00:00+08:00' },
        },
      ]);
      const rows = toNormalizedRows(repo.queryRows(draft.id, { offset: 0, limit: 100 }).rows);
      expect(rows[0].cells['project.entry_at']).toBe(localCalendarDateOf(new Date('2026-05-01T00:00:00+08:00')));
      // 非日期字段不受影响。
      expect(rows[0].cells['contract.customer_name']).toBe('甲');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('VALIDATION_VERSION 升级：旧版本（v1）seal 失效，必须重新完整校验', () => {
    expect(VALIDATION_VERSION).toBe(2);
    const dir = makeTempDir();
    try {
      const { repo, ws, target, close } = openEnv(dir);
      const rows = [nrow('project', { 'contract.ecc': 'E-SEAL', 'contract.customer_name': '甲' })];
      let rev = 1;
      const d = repo.createDraft({ name: 'seal 草稿', createdBy: null, createdByUsername: null });
      rev = repo.transitionState(d.id, rev, 'start_parsing');
      rev = repo.appendRows(d.id, rev, 'project', [
        { rowId: rows[0].rowId, businessKey: rows[0].businessKey, cells: rows[0].cells },
      ]);
      rev = repo.transitionState(d.id, rev, 'parsing_finished');
      rev = repo.transitionState(d.id, rev, 'start_validating');

      const declared = {
        project: 'data' as const,
        service_order: 'none' as const,
        invoice: 'none' as const,
        logistics_fee: 'none' as const,
        serial_address_update: 'none' as const,
        qr_request: 'none' as const,
        ship_to_request: 'none' as const,
      };
      const result = validatePlan(rows, { declared });
      expect(result.eligible).toBe(true);
      generateValidationSeal(repo, {
        draftId: d.id,
        expectedRevision: rev,
        planDigest: buildPlanFromRows(rows).planDigest,
        problems: result.problems,
        targetDb: target.db,
      });
      const seal = repo.getSeal(d.id)!;
      expect(seal.validationVersion).toBe('2');

      // 模拟旧版本 seal（v1）：校验规则版本不一致 → 验证失效。
      ws.db
        .prepare('UPDATE workspace_seals SET validation_version = ? WHERE draft_id = ?')
        .run('1', d.id);
      const verification = verifyValidationSeal(repo, d.id, target.db);
      expect(verification.valid).toBe(false);
      expect(verification.reasons.some((r) => r.includes('校验规则版本变化'))).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('校验：业务日期字段拒绝非日期值（INVALID_VALUE），纯日期通过', () => {
    const dir = makeTempDir();
    try {
      const declared = {
        project: 'data' as const,
        service_order: 'none' as const,
        invoice: 'data' as const,
        logistics_fee: 'none' as const,
        serial_address_update: 'none' as const,
        qr_request: 'none' as const,
        ship_to_request: 'none' as const,
      };
      const bad = nrow('invoice', { 'invoice.ecc': 'E-1', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '仅月份' });
      const badResult = validatePlan([bad], { declared });
      expect(badResult.eligible).toBe(false);
      expect(badResult.problems.some((p) => p.code === 'INVALID_VALUE' && p.field === 'invoice.invoiced_at')).toBe(true);

      // 提供计划内项目使 ECC 引用可解析；纯日期通过校验。
      const good = [
        nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
        nrow('invoice', { 'invoice.ecc': 'E-1', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' }),
      ];
      const goodResult = validatePlan(good, { declared });
      expect(goodResult.eligible).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

function openWorkspace(dir: string): { repo: WorkspaceRepository; ws: ReturnType<typeof bootstrapWorkspaceDatabase>; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: `${dir}/ws` });
  return {
    repo: new WorkspaceRepository(ws.db),
    ws,
    close: () => closeWorkspaceDatabase(ws.db),
  };
}

function openEnv(dir: string): { repo: WorkspaceRepository; ws: ReturnType<typeof bootstrapWorkspaceDatabase>; target: ReturnType<typeof bootstrapDatabase>; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: `${dir}/ws` });
  const target = bootstrapDatabase({ dataDir: `${dir}/data` });
  return {
    repo: new WorkspaceRepository(ws.db),
    ws,
    target,
    close: () => {
      closeDatabase(target.db);
      closeWorkspaceDatabase(ws.db);
    },
  };
}
