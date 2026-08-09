import { describe, expect, it } from 'vitest';
import type { NormalizedRow } from '../../src/domain/capabilities/historical-data-import/normalized-row';
import { businessKeyFromCells } from '../../src/domain/capabilities/historical-data-import/normalized-row';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import {
  buildPlanFromRows,
  planSourceKey,
  sourcePositionOf,
} from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import { IMPORT_PROBLEM_CODES, type ImportProblem, type ImportProblemCode } from '../../src/domain/capabilities/historical-data-import/validation-model';
import {
  validateAffected,
  validatePlan,
} from '../../src/domain/capabilities/historical-data-import/validation';
import { TargetConflictReader } from '../../src/domain/capabilities/historical-data-import/target-reader';
import { runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import type { ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';

/**
 * 历史数据导入校验/冲突/封存资格测试（tasks 8.27~8.34、8.36）。
 *
 * 领域内核消费统一 NormalizedRow（不依赖 CLI 参数），产出七类记录计划；
 * 统一问题模型（error/conflict/warning + 类别/记录键/字段/网格行/业务键/来源位置）；
 * ECC 聚合与来源候选冲突；必填/金额/成交>预算警告；跨类 ECC/服务单号/Account ID/序列号；
 * QR/Ship-to/序列号地址/供应商边界；目标库冲突（v9 快照基线 + BigInt 精确）；
 * 受影响记录/ECC 局部校验与七类完整校验资格；校验阶段零业务写入。
 */

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];
const EXEC = SOURCE_TABLE_FILES['project-execution'];
const WORKLOAD = SOURCE_TABLE_FILES['workload-stats'];

let seq = 0;
/** 构造 NormalizedRow（文件来源；可覆盖来源定位）。 */
function nrow(
  category: ImportCategory,
  cells: Record<string, string | null>,
  extra: Partial<NormalizedRow> = {},
): NormalizedRow {
  seq += 1;
  const businessKey = businessKeyFromCells(category, cells);
  return {
    category,
    rowId: `row-${seq}`,
    sourceRowId: null,
    businessKey,
    sourceKind: 'file',
    sourceFile: '来源工作簿.xlsx',
    sourceSheet: '数据表',
    sourceRow: seq + 1,
    pasteBatch: null,
    cells,
    positionOnlyIdentity: false,
    ...extra,
  };
}

function hasCode(problems: ImportProblem[], code: ImportProblemCode): boolean {
  return problems.some((p) => p.code === code);
}

/** 构造旧五份来源 SourceRow（供 runImport 播种目标库基线）。 */
function srow(file: string, sheet: string, rowNumber: number, cells: Record<string, string | null>): SourceRow {
  return { file, sheet, rowNumber, cells };
}

// ---------------------------------------------------------------------------
// 8.27 领域内核解耦
// ---------------------------------------------------------------------------
describe('8.27 领域内核解耦：消费统一规范化行，保留七类记录计划与来源定位', () => {
  it('NormalizedRow → 七类记录计划（项目按 ECC 聚合），不依赖 CLI 参数', () => {
    const rows: NormalizedRow[] = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }, { sourceFile: CONTRACT, sourceSheet: '合同信息' }),
      nrow('invoice', { 'invoice.ecc': 'E-1', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' }),
      nrow('logistics_fee', { 'logistics_fee.ecc': 'E-1', 'logistics_fee.applied_at': '2026-01-05', 'logistics_fee.budget_price_cents': '4000', 'logistics_fee.deal_price_cents': '3500', 'logistics_fee.logistics_cost_cents': '3000', 'logistics_fee.transport_company': '顺丰' }),
      nrow('service_order', { 'service_order.service_order_no': 'SO-1', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-01-01', 'service_order.engineer': '工', 'service_order.customer_name': '甲' }),
      nrow('serial_address_update', { 'serial_address_update.customer_name': '甲', 'serial_address_update.new_site_address': '新址', 'serial_address_update.serial_no': 'SN-1', 'serial_address_update.account_id': 'ACC-1', 'serial_address_update.updated_at': '2026-01-05' }),
      nrow('qr_request', { 'qr_request.applicant': '负责人', 'qr_request.requested_at': '2026-01-05', 'qr_request.type_code': 'service' }),
      nrow('ship_to_request', { 'ship_to_request.customer_name': '甲', 'ship_to_request.new_site_address': '新址', 'ship_to_request.account_id': 'ACC-2' }),
    ];
    const plan = buildPlanFromRows(rows);
    expect(plan.projects).toHaveLength(1);
    expect(plan.projects[0].ecc).toBe('E-1');
    expect(plan.projects[0].customerName).toBe('甲');
    expect(plan.serviceOrders).toHaveLength(1);
    expect(plan.invoices).toHaveLength(1);
    expect(plan.logisticsFees).toHaveLength(1);
    expect(plan.serialAddressUpdates).toHaveLength(1);
    expect(plan.qrRequests).toHaveLength(1);
    expect(plan.shipToRequests).toHaveLength(1);
    expect(plan.recordCounts).toMatchObject({
      project: 1,
      service_order: 1,
      invoice: 1,
      logistics_fee: 1,
      serial_address_update: 1,
      qr_request: 1,
      ship_to_request: 1,
    });
    // 来源定位保留
    expect(sourcePositionOf(rows[0])).toBe(`${CONTRACT}#合同信息#2`);
    // 供应商不构成第八类独立记录
    expect(plan.suppliers).toHaveLength(0);
    expect(plan.planDigest).toBeTruthy();
  });

  it('相同语义不同物理顺序得到相同计划摘要（内核输出适配现有 ImportPlan 摘要）', () => {
    const a: NormalizedRow[] = [
      nrow('project', { 'contract.ecc': 'E-2', 'contract.customer_name': '甲' }),
      nrow('invoice', { 'invoice.ecc': 'E-2', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' }),
      nrow('ship_to_request', { 'ship_to_request.customer_name': '甲', 'ship_to_request.new_site_address': '新址' }),
    ];
    const b = [...a].reverse();
    expect(buildPlanFromRows(a).planDigest).toBe(buildPlanFromRows(b).planDigest);
  });

  it('planSourceKey 与 migration-service 幂等键同构（文件 file#sheet#row|suffix）', () => {
    const row = nrow('logistics_fee', {}, { sourceFile: WORKLOAD, sourceSheet: '物流费用表', sourceRow: 2 });
    expect(planSourceKey('lf', row)).toBe(`${WORKLOAD}#物流费用表#2|lf`);
  });
});

// ---------------------------------------------------------------------------
// 8.28 统一问题模型
// ---------------------------------------------------------------------------
describe('8.28 统一问题模型与稳定问题代码', () => {
  it('错误携带类别/记录键/字段/网格行/业务键/来源位置与稳定代码', () => {
    const row = nrow('project', { 'project.region': '华东' }, { sourceFile: CONTRACT, sourceSheet: '合同信息', sourceRow: 5 });
    const result = validatePlan([row], { declared: { project: 'data' } });
    const ecc = result.problems.find((p) => p.code === 'MISSING_ECC');
    expect(ecc).toBeDefined();
    expect(ecc).toMatchObject({
      severity: 'error',
      category: 'project',
      recordKey: row.rowId,
      field: 'contract.ecc',
      gridRow: 5,
      sourcePosition: `${CONTRACT}#合同信息#5`,
      message: expect.stringContaining('ECC'),
    });
  });

  it('稳定代码集分级：阻断 error/conflict 与非阻断 warning', () => {
    expect(IMPORT_PROBLEM_CODES.MISSING_ECC).toBe('MISSING_ECC');
    expect(IMPORT_PROBLEM_CODES.SOURCE_CONFLICT).toBe('SOURCE_CONFLICT');
    expect(IMPORT_PROBLEM_CODES.DEAL_ABOVE_BUDGET).toBe('DEAL_ABOVE_BUDGET');
    const problems: ImportProblem[] = [
      { code: 'MISSING_ECC', severity: 'error', category: 'project', recordKey: 'r', field: 'contract.ecc', gridRow: 1, businessKey: null, sourcePosition: null, message: 'e' },
      { code: 'SOURCE_CONFLICT', severity: 'conflict', category: 'project', recordKey: 'r2', field: 'contract.customer_name', gridRow: 1, businessKey: 'E-1', sourcePosition: null, message: 'c' },
      { code: 'DEAL_ABOVE_BUDGET', severity: 'warning', category: 'logistics_fee', recordKey: 'r3', field: 'logistics_fee.deal_price_cents', gridRow: 1, businessKey: null, sourcePosition: null, message: 'w' },
    ];
    expect(problems.filter((p) => p.severity === 'error' || p.severity === 'conflict')).toHaveLength(2);
    expect(problems.filter((p) => p.severity === 'warning')).toHaveLength(1);
  });

  it('必填缺失可定位（类别、目标字段、网格行、原始输入位置）', () => {
    const row = nrow('service_order', { 'service_order.service_order_no': 'SO-9' }, { sourceFile: WORKLOAD, sourceSheet: '开单记录表', sourceRow: 7 });
    const result = validatePlan([row], { declared: { service_order: 'data' } });
    const missing = result.problems.find((p) => p.code === 'MISSING_REQUIRED_FIELD' && p.field === 'service_order.order_type');
    expect(missing).toMatchObject({ severity: 'error', category: 'service_order', gridRow: 7, sourcePosition: `${WORKLOAD}#开单记录表#7` });
  });
});

// ---------------------------------------------------------------------------
// 8.29 ECC 聚合与来源优先级
// ---------------------------------------------------------------------------
describe('8.29 ECC 聚合与来源候选冲突', () => {
  it('同一 ECC 聚合为一个搬迁项目；来源一致时按优先级一致取值', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-A', 'contract.customer_name': '甲' }, { sourceFile: CONTRACT, sourceSheet: '合同信息' }),
      nrow('project', { 'contract.ecc': 'E-A', 'project.region': '华东' }, { sourceFile: EXEC, sourceSheet: '搬迁项目' }),
    ];
    const plan = buildPlanFromRows(rows);
    expect(plan.projects).toHaveLength(1);
    expect(plan.projects[0].ecc).toBe('E-A');
    expect(plan.projects[0].customerName).toBe('甲');
    expect(plan.projects[0].region).toBe('华东');
    expect(plan.sourceConflicts).toHaveLength(0);
  });

  it('不同来源相同规范化值不产生冲突', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-B', 'contract.customer_name': '甲' }, { sourceFile: CONTRACT }),
      nrow('project', { 'contract.ecc': 'E-B', 'contract.customer_name': '甲' }, { sourceFile: EXEC }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data' } });
    expect(hasCode(result.problems, 'SOURCE_CONFLICT')).toBe(false);
    expect(result.plan.projects[0].customerName).toBe('甲');
  });

  it('不同合法值进入冲突并展示候选来源；必须显式选择或修正，不自动覆盖', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-C', 'contract.customer_name': '甲' }, { sourceFile: CONTRACT, sourceSheet: '合同信息', sourceRow: 2 }),
      nrow('project', { 'contract.ecc': 'E-C', 'contract.customer_name': '乙' }, { sourceFile: EXEC, sourceSheet: '搬迁项目', sourceRow: 3 }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data' } });
    const conflict = result.problems.find((p) => p.code === 'SOURCE_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe('conflict');
    expect(conflict?.field).toBe('contract.customer_name');
    expect(conflict?.businessKey).toBe('E-C');
    expect(conflict?.candidates).toHaveLength(2);
    const candidates = conflict?.candidates ?? [];
    expect(new Set(candidates.map((c) => c.value))).toEqual(new Set(['甲', '乙']));
    expect(candidates.every((c) => c.sourcePosition !== null)).toBe(true);
    // 冲突不自动覆盖：字段保持空
    expect(result.plan.projects[0].customerName).toBeNull();
    expect(result.eligible).toBe(false);

    // 修正（第二个来源改为一致值）后冲突消失
    const fixed = [
      nrow('project', { 'contract.ecc': 'E-C', 'contract.customer_name': '甲' }, { sourceFile: CONTRACT }),
      nrow('project', { 'contract.ecc': 'E-C', 'contract.customer_name': '甲' }, { sourceFile: EXEC }),
    ];
    const fixedResult = validatePlan(fixed, { declared: { project: 'data' } });
    expect(hasCode(fixedResult.problems, 'SOURCE_CONFLICT')).toBe(false);
    expect(fixedResult.plan.projects[0].customerName).toBe('甲');
  });
});

// ---------------------------------------------------------------------------
// 8.30 字段与金额校验
// ---------------------------------------------------------------------------
describe('8.30 必填 / 金额 / 成交>预算警告', () => {
  it('物流费用申请（登记）时间为目标必填，缺失为阻断错误', () => {
    const row = nrow('logistics_fee', {
      'logistics_fee.ecc': 'E-1',
      'logistics_fee.budget_price_cents': '4000',
      'logistics_fee.deal_price_cents': '3500',
      'logistics_fee.logistics_cost_cents': '3000',
    });
    const result = validatePlan([row], { declared: { logistics_fee: 'data' } });
    const missing = result.problems.find((p) => p.code === 'MISSING_REQUIRED_FIELD' && p.field === 'logistics_fee.applied_at');
    expect(missing).toBeDefined();
    expect(result.eligible).toBe(false);
  });

  it('缺 ECC 报必填错误并阻止导入', () => {
    const row = nrow('invoice', { 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' });
    const result = validatePlan([row], { declared: { invoice: 'data' } });
    expect(hasCode(result.problems, 'MISSING_ECC')).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it('合同 USD 含税金额允许为 0；其余金额有值必须大于 0', () => {
    const project = nrow('project', { 'contract.ecc': 'E-0', 'contract.customer_name': '甲', 'contract.usd_tax_amount_cents': '0' });
    const invoice = nrow('invoice', { 'invoice.ecc': 'E-0', 'invoice.amount_cents': '0', 'invoice.invoiced_at': '2026-01-05' });
    const result = validatePlan([project, invoice], { declared: { project: 'data', invoice: 'data' } });
    expect(hasCode(result.problems, 'AMOUNT_NOT_POSITIVE')).toBe(true);
    const projectProblem = result.problems.filter((p) => p.category === 'project' && p.code === 'AMOUNT_NOT_POSITIVE');
    expect(projectProblem).toHaveLength(0);
    expect(result.problems.some((p) => p.field === 'invoice.amount_cents' && p.code === 'AMOUNT_NOT_POSITIVE')).toBe(true);
  });

  it('非法金额报 INVALID_AMOUNT', () => {
    const row = nrow('invoice', { 'invoice.ecc': 'E-1', 'invoice.amount_cents': 'abc', 'invoice.invoiced_at': '2026-01-05' });
    const result = validatePlan([row], { declared: { invoice: 'data' } });
    expect(hasCode(result.problems, 'INVALID_AMOUNT')).toBe(true);
  });

  it('成交价格高于预算价格仅警告，不阻断提交资格', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('logistics_fee', {
        'logistics_fee.ecc': 'E-1',
        'logistics_fee.applied_at': '2026-01-05',
        'logistics_fee.budget_price_cents': '1000',
        'logistics_fee.deal_price_cents': '1200',
        'logistics_fee.logistics_cost_cents': '1100',
      }),
    ];
    const result = validatePlan(rows, {
      declared: {
        project: 'data',
        logistics_fee: 'data',
        service_order: 'none',
        invoice: 'none',
        serial_address_update: 'none',
        qr_request: 'none',
        ship_to_request: 'none',
      },
    });
    const warning = result.problems.find((p) => p.code === 'DEAL_ABOVE_BUDGET');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('200.00');
    expect(result.eligible).toBe(true);
  });

  it('成交价格不高于预算时不产生警告', () => {
    const row = nrow('logistics_fee', {
      'logistics_fee.ecc': 'E-1',
      'logistics_fee.applied_at': '2026-01-05',
      'logistics_fee.budget_price_cents': '1000',
      'logistics_fee.deal_price_cents': '900',
      'logistics_fee.logistics_cost_cents': '880',
    });
    const result = validatePlan([row], { declared: { logistics_fee: 'data' } });
    expect(hasCode(result.problems, 'DEAL_ABOVE_BUDGET')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8.31 跨类关联与唯一性
// ---------------------------------------------------------------------------
describe('8.31 跨类 ECC / 服务单号 / Account ID / 序列号', () => {
  it('掉票 ECC 未在计划或目标库中唯一匹配 → 阻断错误', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('invoice', { 'invoice.ecc': 'E-NOPE', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data', invoice: 'data' } });
    expect(hasCode(result.problems, 'UNRESOLVED_ECC_REFERENCE')).toBe(true);
    expect(result.problems.find((p) => p.code === 'UNRESOLVED_ECC_REFERENCE')?.field).toBe('invoice.ecc');
    expect(result.eligible).toBe(false);
  });

  it('物流费用 ECC 可引用计划或目标库；独立申请不强制 ECC', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('logistics_fee', { 'logistics_fee.ecc': 'E-1', 'logistics_fee.applied_at': '2026-01-05', 'logistics_fee.budget_price_cents': '4000', 'logistics_fee.deal_price_cents': '3500', 'logistics_fee.logistics_cost_cents': '3000' }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data', logistics_fee: 'data' } });
    expect(hasCode(result.problems, 'UNRESOLVED_ECC_REFERENCE')).toBe(false);
  });

  it('重复非空服务单号 → 冲突清单（解决前不可提交）', () => {
    const rows = [
      nrow('service_order', { 'service_order.service_order_no': 'SO-1', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-01-01', 'service_order.engineer': '工', 'service_order.customer_name': '甲' }),
      nrow('service_order', { 'service_order.service_order_no': 'SO-1', 'service_order.order_type': 'relocation', 'service_order.ordered_at': '2026-01-02', 'service_order.engineer': '乙', 'service_order.customer_name': '甲' }),
    ];
    const result = validatePlan(rows, { declared: { service_order: 'data' } });
    const dup = result.problems.filter((p) => p.code === 'DUPLICATE_SERVICE_ORDER');
    expect(dup).toHaveLength(2); // 所有相关记录上都列出
    expect(dup[0].severity).toBe('conflict');
    expect(result.eligible).toBe(false);
  });

  it('重复非空 Account ID → 冲突', () => {
    const rows = [
      nrow('ship_to_request', { 'ship_to_request.customer_name': '甲', 'ship_to_request.new_site_address': 'A', 'ship_to_request.account_id': 'ACC-X' }),
      nrow('ship_to_request', { 'ship_to_request.customer_name': '乙', 'ship_to_request.new_site_address': 'B', 'ship_to_request.account_id': 'ACC-X' }),
    ];
    const result = validatePlan(rows, { declared: { ship_to_request: 'data' } });
    expect(hasCode(result.problems, 'DUPLICATE_ACCOUNT_ID')).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it('序列号必须唯一匹配搬迁仪器；无法唯一匹配阻止提交', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('serial_address_update', { 'serial_address_update.customer_name': '甲', 'serial_address_update.new_site_address': '新址', 'serial_address_update.serial_no': 'SN-NOPE', 'serial_address_update.account_id': 'ACC-1', 'serial_address_update.updated_at': '2026-01-05' }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data', serial_address_update: 'data' } });
    expect(hasCode(result.problems, 'SERIAL_NO_MISMATCH')).toBe(true);
  });

  it('违反同项目序列号唯一性 → 阻断错误', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('project', { 'contract.ecc': 'E-1', 'instrument.name': '色谱仪', 'instrument.serial_no': 'SN-1' }),
      nrow('project', { 'contract.ecc': 'E-1', 'instrument.name': '光谱仪', 'instrument.serial_no': 'SN-1' }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data' } });
    expect(hasCode(result.problems, 'DUPLICATE_SERIAL_IN_PROJECT')).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it('同项目内不同序列号不冲突', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('project', { 'contract.ecc': 'E-1', 'instrument.name': '色谱仪', 'instrument.serial_no': 'SN-1' }),
      nrow('project', { 'contract.ecc': 'E-1', 'instrument.name': '光谱仪', 'instrument.serial_no': 'SN-2' }),
    ];
    const result = validatePlan(rows, { declared: { project: 'data' } });
    expect(hasCode(result.problems, 'DUPLICATE_SERIAL_IN_PROJECT')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8.32 独立申请边界
// ---------------------------------------------------------------------------
describe('8.32 二维码 / Ship-to / 序列号地址 / 供应商边界', () => {
  it('二维码类型不得由数量猜测：仅有类型数量无具体类型 → 冲突', () => {
    const row = nrow('qr_request', { 'qr_request.applicant': '负责人', 'qr_request.requested_at': '2026-01-05', 'qr_request.type_count': '2' });
    const result = validatePlan([row], { declared: { qr_request: 'data' } });
    const conflict = result.problems.find((p) => p.code === 'QR_TYPE_MISSING');
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe('conflict');
    expect(result.eligible).toBe(false);
    // 明确申请类型后通过
    const fixed = nrow('qr_request', { 'qr_request.applicant': '负责人', 'qr_request.requested_at': '2026-01-05', 'qr_request.type_code': 'service', 'qr_request.type_count': '1' });
    expect(hasCode(validatePlan([fixed], { declared: { qr_request: 'data' } }).problems, 'QR_TYPE_MISSING')).toBe(false);
  });

  it('二维码申请与 Ship-to 申请不强制关联 ECC（无 ECC 字段不产生关联错误）', () => {
    const rows = [
      nrow('qr_request', { 'qr_request.applicant': '负责人', 'qr_request.requested_at': '2026-01-05', 'qr_request.type_code': 'service' }),
      nrow('ship_to_request', { 'ship_to_request.customer_name': '甲', 'ship_to_request.new_site_address': '新址' }),
    ];
    const result = validatePlan(rows, { declared: { qr_request: 'data', ship_to_request: 'data' } });
    expect(hasCode(result.problems, 'MISSING_ECC')).toBe(false);
    expect(hasCode(result.problems, 'UNRESOLVED_ECC_REFERENCE')).toBe(false);
  });

  it('序列号地址更新不创建或修改 Ship-to 主数据（且校验不产生 Ship-to 问题）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const reader = new TargetConflictReader(db);
      const rows = [
        nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲', 'instrument.serial_no': 'SN-1', 'instrument.name': '色谱仪' }),
        nrow('serial_address_update', { 'serial_address_update.customer_name': '甲', 'serial_address_update.new_site_address': '新址', 'serial_address_update.serial_no': 'SN-1', 'serial_address_update.account_id': 'ACC-1', 'serial_address_update.updated_at': '2026-01-05' }),
      ];
      const before = (db.prepare('SELECT COUNT(*) AS n FROM ship_tos').get() as { n: number }).n;
      const result = validatePlan(rows, { declared: { project: 'data', serial_address_update: 'data' }, target: reader });
      const after = (db.prepare('SELECT COUNT(*) AS n FROM ship_tos').get() as { n: number }).n;
      expect(after).toBe(before); // 校验不创建 Ship-to
      expect(hasCode(result.problems, 'SERIAL_NO_MISMATCH')).toBe(false); // 计划内唯一匹配
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('供应商只作物流参考：不构成第八类记录，运输公司并入物流类别', () => {
    const rows = [
      nrow('logistics_fee', { 'logistics_fee.ecc': 'E-1', 'logistics_fee.applied_at': '2026-01-05', 'logistics_fee.budget_price_cents': '4000', 'logistics_fee.deal_price_cents': '3500', 'logistics_fee.logistics_cost_cents': '3000', 'logistics_fee.transport_company': '顺丰' }),
    ];
    const plan = buildPlanFromRows(rows);
    expect(plan.suppliers).toHaveLength(0);
    expect(Object.keys(plan.recordCounts)).not.toContain('supplier');
    expect(plan.logisticsFees[0].transportCompany).toBe('顺丰');
  });
});

// ---------------------------------------------------------------------------
// 8.33 目标库冲突检查
// ---------------------------------------------------------------------------
describe('8.33 目标库冲突与 v9 快照保护（BigInt 精确）', () => {
  it('人工目标阻止覆盖（项目+合同金额）：非迁移来源记录不得覆盖', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('c-m', '手工客户', 't', 't');
      db.prepare('INSERT INTO projects (id, temp_no, status, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('p-m', 'P-M', 'pending_entry', 'c-m', 't', 't');
      db.prepare('INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('ct-m', 'p-m', 'P-M', 'E-MANUAL', 't', 't');

      const reader = new TargetConflictReader(db);
      const rows = [nrow('project', { 'contract.ecc': 'E-MANUAL', 'contract.customer_name': '手工客户' })];
      const result = validatePlan(rows, { declared: { project: 'data' }, target: reader });
      const conflict = result.problems.find((p) => p.code === 'TARGET_CONFLICT');
      expect(conflict).toBeDefined();
      expect(conflict?.target?.manualOrForeignSource).toBe(true);
      expect(result.eligible).toBe(false);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('缺少可信基线阻止覆盖：v9 快照缺失（import_record_audit 无记录）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      runImport(db, { rows: [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-BL', 'Account name': '甲', 合同USD含税金额: '100' })], mapping: MAPPING_V1 });
      db.prepare('DELETE FROM import_record_audit').run();

      const reader = new TargetConflictReader(db);
      const rows = [nrow('project', { 'contract.ecc': 'E-BL', 'contract.customer_name': '甲' })];
      const result = validatePlan(rows, { declared: { project: 'data' }, target: reader });
      const conflict = result.problems.find((p) => p.code === 'TARGET_CONFLICT');
      expect(conflict).toBeDefined();
      expect(conflict?.target?.missingBaseline).toBe(true);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('目标被人工修改阻止覆盖：项目金额 / 物流批次运输公司 / 二维码申请类型', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      runImport(db, {
        rows: [
          srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-MOD', 'Account name': '甲', 合同USD含税金额: '100' }),
          srow(WORKLOAD, '物流费用表', 2, { ECC: 'E-MOD', 物流费用申请登记时间: '2026-01-05', 预算价格: '40', 成交价格: '35', 实际物流费用: '30', 物流公司: '顺丰' }),
          srow(WORKLOAD, '服务二维码表', 3, { 申请人: '负责人', 申请时间: '2026-01-05', 申请类型: 'service' }),
        ],
        mapping: MAPPING_V1,
      });
      // 人工修改目标：项目区域、批次运输公司、二维码类型。
      db.prepare("UPDATE projects SET region='华北' WHERE id=(SELECT project_id FROM contracts WHERE ecc='E-MOD')").run();
      db.prepare("UPDATE batches SET transport_company='人工改' WHERE project_id=(SELECT project_id FROM contracts WHERE ecc='E-MOD')").run();
      db.prepare("UPDATE qr_request_types SET type_code='manual' WHERE type_code='service'").run();

      const reader = new TargetConflictReader(db);
      const rows = [
        nrow('project', { 'contract.ecc': 'E-MOD', 'contract.customer_name': '甲', 'project.region': '华东' }),
        nrow('logistics_fee', { 'logistics_fee.ecc': 'E-MOD', 'logistics_fee.applied_at': '2026-01-05', 'logistics_fee.budget_price_cents': '4000', 'logistics_fee.deal_price_cents': '3500', 'logistics_fee.logistics_cost_cents': '3000', 'logistics_fee.transport_company': '顺丰' }, { sourceFile: WORKLOAD, sourceSheet: '物流费用表', sourceRow: 2 }),
        nrow('qr_request', { 'qr_request.applicant': '负责人', 'qr_request.requested_at': '2026-01-05', 'qr_request.type_code': 'service' }, { sourceFile: WORKLOAD, sourceSheet: '服务二维码表', sourceRow: 3 }),
      ];
      const result = validatePlan(rows, { declared: { project: 'data', logistics_fee: 'data', qr_request: 'data' }, target: reader });
      const targetConflicts = result.problems.filter((p) => p.code === 'TARGET_CONFLICT');
      const categories = targetConflicts.map((p) => p.category).sort();
      expect(categories).toContain('project');
      expect(categories).toContain('logistics_fee');
      expect(categories).toContain('qr_request');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('BigInt 金额精确：超大金额 forward-fix 不产生伪冲突；金额变化可检出', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const huge = '9007199254740993'; // 分值远超 Number.MAX_SAFE_INTEGER
      runImport(db, { rows: [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-BIG', 'Account name': '甲', 合同USD含税金额: huge })], mapping: MAPPING_V1 });

      const reader = new TargetConflictReader(db);
      // 同金额 forward-fix：BigInt 快照一致 → 无冲突。
      const same = validatePlan(
        [nrow('project', { 'contract.ecc': 'E-BIG', 'contract.customer_name': '甲', 'contract.usd_tax_amount_cents': huge })],
        { declared: { project: 'data' }, target: reader },
      );
      expect(hasCode(same.problems, 'TARGET_CONFLICT')).toBe(false);

      // 金额被人工修改 +1 分 → 快照不一致 → 冲突（BigInt 比较不退化 Number）。
      db.prepare("UPDATE contracts SET usd_tax_amount_cents=usd_tax_amount_cents+1 WHERE ecc='E-BIG'").run();
      const modified = validatePlan(
        [nrow('project', { 'contract.ecc': 'E-BIG', 'contract.customer_name': '甲', 'contract.usd_tax_amount_cents': huge })],
        { declared: { project: 'data' }, target: reader },
      );
      expect(hasCode(modified.problems, 'TARGET_CONFLICT')).toBe(true);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.34 局部/完整校验与提交资格
// ---------------------------------------------------------------------------
describe('8.34 受影响记录/ECC 局部校验与七类完整校验资格', () => {
  it('任一未声明类别阻止提交资格', () => {
    const rows = [nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' })];
    const result = validatePlan(rows, { declared: { project: 'data' } }); // 其余六类未声明
    expect(hasCode(result.problems, 'UNDECLARED_CATEGORY')).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it('七类均确认无数据且记录总数为零 → 空导入阻止提交', () => {
    const result = validatePlan([], { declared: { project: 'none', service_order: 'none', invoice: 'none', logistics_fee: 'none', serial_address_update: 'none', qr_request: 'none', ship_to_request: 'none' } });
    expect(hasCode(result.problems, 'EMPTY_IMPORT')).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it('声明有数据但规范化记录数为零 → 阻断', () => {
    const result = validatePlan([nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' })], {
      declared: { project: 'data', service_order: 'data', invoice: 'none', logistics_fee: 'none', serial_address_update: 'none', qr_request: 'none', ship_to_request: 'none' },
    });
    expect(hasCode(result.problems, 'DECLARED_DATA_EMPTY')).toBe(true);
  });

  it('错误或未解决冲突不得生成提交资格；警告不阻断', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('logistics_fee', { 'logistics_fee.ecc': 'E-1', 'logistics_fee.applied_at': '2026-01-05', 'logistics_fee.budget_price_cents': '1000', 'logistics_fee.deal_price_cents': '1200', 'logistics_fee.logistics_cost_cents': '1100' }),
    ];
    const ok = validatePlan(rows, { declared: { project: 'data', logistics_fee: 'data', service_order: 'none', invoice: 'none', serial_address_update: 'none', qr_request: 'none', ship_to_request: 'none' } });
    expect(ok.eligible).toBe(true); // 仅警告（DEAL_ABOVE_BUDGET）
    expect(hasCode(ok.problems, 'DEAL_ABOVE_BUDGET')).toBe(true);

    const broken = validatePlan(
      [nrow('invoice', { 'invoice.ecc': 'E-NOPE', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' })],
      { declared: { invoice: 'data' } },
    );
    expect(broken.eligible).toBe(false);
    expect(broken.blockingReasons.length).toBeGreaterThan(0);
  });

  it('局部重校验只覆盖受影响记录与 ECC；完整校验覆盖跨类', () => {
    const rows = [
      nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲' }),
      nrow('invoice', { 'invoice.ecc': 'E-1', 'invoice.amount_cents': '0', 'invoice.invoiced_at': '2026-01-05' }),
      nrow('service_order', { 'service_order.service_order_no': 'SO-1', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-01-01', 'service_order.engineer': '工', 'service_order.customer_name': '甲' }),
      nrow('service_order', { 'service_order.service_order_no': 'SO-1', 'service_order.order_type': 'relocation', 'service_order.ordered_at': '2026-01-02', 'service_order.engineer': '乙', 'service_order.customer_name': '甲' }),
    ];
    const invoiceRow = rows[1];
    // 编辑掉票行（受影响记录 = invoice 行；受影响 ECC = E-1）。
    const partial = validateAffected(rows, { rowIds: [invoiceRow.rowId], eccs: ['E-1'] }, { declared: { project: 'data', invoice: 'data', service_order: 'data' } });
    // 局部校验命中该行金额错误与 ECC 引用（E-1 在计划内，无引用错误）
    expect(hasCode(partial, 'AMOUNT_NOT_POSITIVE')).toBe(true);
    expect(hasCode(partial, 'UNRESOLVED_ECC_REFERENCE')).toBe(false);
    // 跨类重复服务单号属于完整校验（D23：局部编辑不重算跨类唯一性）
    expect(hasCode(partial, 'DUPLICATE_SERVICE_ORDER')).toBe(false);

    const full = validatePlan(rows, { declared: { project: 'data', invoice: 'data', service_order: 'data' } });
    expect(hasCode(full.problems, 'DUPLICATE_SERVICE_ORDER')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8.36 校验阶段零业务写入
// ---------------------------------------------------------------------------
describe('8.36 校验阶段主业务表零写', () => {
  it('文件/网格编辑/完整校验反复执行不改变正式业务数据', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      runImport(db, { rows: [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-Z', 'Account name': '甲', 合同USD含税金额: '100' })], mapping: MAPPING_V1 });

      const snapshot = (): string => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        const parts = tables.map((t) => {
          const rows = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all() as unknown[];
          return `${t.name}:${JSON.stringify(rows)}`;
        });
        return parts.join('\n');
      };
      const before = snapshot();

      const reader = new TargetConflictReader(db);
      const rows = [nrow('project', { 'contract.ecc': 'E-Z', 'contract.customer_name': '甲' })];
      validatePlan(rows, { declared: { project: 'data' }, target: reader });
      validateAffected(rows, { rowIds: [rows[0].rowId], eccs: ['E-Z'] }, { declared: { project: 'data' }, target: reader });
      validatePlan([], { declared: { project: 'none', service_order: 'none', invoice: 'none', logistics_fee: 'none', serial_address_update: 'none', qr_request: 'none', ship_to_request: 'none' } });

      expect(snapshot()).toBe(before);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.87 仅有物理行位置时提示身份风险（POSITION_ONLY_IDENTITY）
// ---------------------------------------------------------------------------
describe('8.87 物理位置兜底身份提示', () => {
  it('仅以物理行位置为身份时提示身份风险：既无业务键也无稳定源行 ID 的记录进入 POSITION_ONLY_IDENTITY 警告', () => {
    const row = nrow('project', { 'contract.customer_name': '甲' }, { positionOnlyIdentity: true });
    expect(row.businessKey ?? null).toBeNull();
    expect(row.sourceRowId).toBeNull();
    const result = validatePlan([row], { declared: { project: 'data' } });
    expect(hasCode(result.problems, 'POSITION_ONLY_IDENTITY')).toBe(true);
    const p = result.problems.find((x) => x.code === 'POSITION_ONLY_IDENTITY')!;
    // 仅警告（非阻断）：身份以来源与物理行号为兜底，重排行可能改变后续修正匹配。
    expect(p.severity).toBe('warning');
  });
});
