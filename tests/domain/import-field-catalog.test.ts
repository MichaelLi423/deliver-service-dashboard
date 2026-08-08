import { describe, expect, it } from 'vitest';
import {
  CATEGORY_FIELDS,
  FIELD_CATALOG_VERSION,
  businessKeyFieldsOf,
  fieldCatalogFor,
  findFieldByHeader,
  findFieldByTarget,
} from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { IMPORT_CATEGORIES } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';

/**
 * 8.17 七类固定目标字段目录：字段名、类型、必填/可选、业务键、稳定别名、
 * 金额币种、日期语义与是否允许用户编辑。
 */

describe('8.17 七类固定目标字段目录', () => {
  it('覆盖全部七类且每类字段表头（label）唯一', () => {
    for (const category of IMPORT_CATEGORIES) {
      const fields = fieldCatalogFor(category);
      expect(fields.length).toBeGreaterThan(0);
      const labels = fields.map((f) => f.label);
      expect(new Set(labels).size).toBe(labels.length); // label 唯一（模板表头唯一）
      const fieldNames = fields.map((f) => f.field);
      expect(new Set(fieldNames).size).toBe(fieldNames.length);
    }
    expect(CATEGORY_FIELDS.project).toBeDefined();
    expect(CATEGORY_FIELDS.service_order).toBeDefined();
    expect(CATEGORY_FIELDS.invoice).toBeDefined();
    expect(CATEGORY_FIELDS.logistics_fee).toBeDefined();
    expect(CATEGORY_FIELDS.serial_address_update).toBeDefined();
    expect(CATEGORY_FIELDS.qr_request).toBeDefined();
    expect(CATEGORY_FIELDS.ship_to_request).toBeDefined();
    expect(FIELD_CATALOG_VERSION).toBe(1);
  });

  it('每个字段定义类型、必填/可选、业务键、别名、可编辑性', () => {
    const ecc = findFieldByTarget('project', 'contract.ecc')!;
    expect(ecc.type).toBe('text');
    expect(ecc.required).toBe(true);
    expect(ecc.businessKey).toBe(true);
    expect(ecc.editable).toBe(true);
    expect(ecc.aliases).toContain('ECC#');

    const amount = findFieldByTarget('invoice', 'invoice.amount_cents')!;
    expect(amount.type).toBe('money');
    expect(amount.currency).toBe('USD');
    expect(amount.required).toBe(true);

    const budget = findFieldByTarget('logistics_fee', 'logistics_fee.budget_price_cents')!;
    expect(budget.currency).toBe('RMB');

    const appliedAt = findFieldByTarget('logistics_fee', 'logistics_fee.applied_at')!;
    expect(appliedAt.type).toBe('datetime');
    expect(appliedAt.dateSemantics).toBe('datetime');
    expect(appliedAt.required).toBe(true); // 目标必填：物流费用申请（登记）时间

    const contractStart = findFieldByTarget('project', 'project.contract_start_date')!;
    expect(contractStart.type).toBe('date');
    expect(contractStart.dateSemantics).toBe('date');
    expect(contractStart.required).toBe(false);
  });

  it('业务键字段覆盖 ECC / 服务单号 / Account ID / 序列号', () => {
    expect(businessKeyFieldsOf('project').map((f) => f.field)).toContain('contract.ecc');
    expect(businessKeyFieldsOf('project').map((f) => f.field)).toContain('instrument.serial_no');
    expect(businessKeyFieldsOf('service_order').map((f) => f.field)).toContain('service_order.service_order_no');
    expect(businessKeyFieldsOf('serial_address_update').map((f) => f.field)).toContain('serial_address_update.serial_no');
    expect(businessKeyFieldsOf('serial_address_update').map((f) => f.field)).toContain('serial_address_update.account_id');
    expect(businessKeyFieldsOf('ship_to_request').map((f) => f.field)).toContain('ship_to_request.account_id');
  });

  it('稳定别名覆盖旧五源列名（ECC#/Account name/单号/金额（USD）等），精确匹配不模糊猜测', () => {
    expect(findFieldByHeader('project', 'ECC#')?.field).toBe('contract.ecc');
    expect(findFieldByHeader('project', 'Account name')?.field).toBe('contract.customer_name');
    expect(findFieldByHeader('service_order', '单号')?.field).toBe('service_order.service_order_no');
    expect(findFieldByHeader('invoice', '金额（USD）')?.field).toBe('invoice.amount_cents');
    expect(findFieldByHeader('logistics_fee', '物流费用申请登记时间')?.field).toBe('logistics_fee.applied_at');
    expect(findFieldByHeader('logistics_fee', '运输公司')?.field).toBe('logistics_fee.transport_company');
    // 未配置的相似名称不猜测
    expect(findFieldByHeader('project', 'ECC编号（近似）')).toBeUndefined();
  });

  it('主状态（project.status）不作为可编辑目标字段（状态由事实重建，不可手工指定）', () => {
    expect(findFieldByTarget('project', 'project.status')).toBeUndefined();
  });

  it('二维码申请只有类型数量不构成可猜测字段：type_code 为可选、type_count 为 number', () => {
    const typeCode = findFieldByTarget('qr_request', 'qr_request.type_code')!;
    const typeCount = findFieldByTarget('qr_request', 'qr_request.type_count')!;
    expect(typeCode.required).toBe(false);
    expect(typeCount.type).toBe('number');
    expect(typeCode.help).toContain('不得由类型数量猜测');
  });
});
