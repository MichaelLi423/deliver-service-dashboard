import { describe, expect, it } from 'vitest';
import {
  LEGACY_SOURCE_FILES,
  isLegacySourceFile,
  legacySourcePriority,
  recognizeLegacyColumns,
  recognizeLegacySheet,
  targetFieldsFor,
} from '../../src/domain/capabilities/historical-data-import/legacy-sources';
import { SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';

/**
 * 8.21 旧五份来源工作簿的冻结 sheet/列别名识别和来源优先级；
 * 未知 sheet/列只进入待人工映射或明确排除，不做模糊猜测。
 */

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];
const EXEC = SOURCE_TABLE_FILES['project-execution'];
const WORKLOAD = SOURCE_TABLE_FILES['workload-stats'];

describe('8.21 旧五源冻结 sheet 识别', () => {
  it('覆盖旧五份来源工作簿文件名', () => {
    expect(LEGACY_SOURCE_FILES).toHaveLength(5);
    for (const file of Object.values(SOURCE_TABLE_FILES)) {
      expect(LEGACY_SOURCE_FILES).toContain(file);
      expect(isLegacySourceFile(file)).toBe(true);
    }
    expect(isLegacySourceFile('新增文件.xlsx')).toBe(false);
  });

  it('已知 sheet 精确路由到类别；辅助 sheet 明确忽略；未知 sheet 待人工映射', () => {
    expect(recognizeLegacySheet(CONTRACT, '合同信息')).toMatchObject({ state: 'exact', category: 'project', role: 'project' });
    expect(recognizeLegacySheet(EXEC, '搬迁项目')).toMatchObject({ state: 'exact', category: 'project' });
    expect(recognizeLegacySheet(EXEC, '工作表1')).toMatchObject({ state: 'exact', role: 'ignored', category: null });
    expect(recognizeLegacySheet(WORKLOAD, '开单记录表')).toMatchObject({ state: 'exact', category: 'service_order' });
    expect(recognizeLegacySheet(WORKLOAD, '掉票记录表')).toMatchObject({ state: 'exact', category: 'invoice' });
    expect(recognizeLegacySheet(WORKLOAD, '物流费用表')).toMatchObject({ state: 'exact', category: 'logistics_fee' });
    expect(recognizeLegacySheet(WORKLOAD, '搬迁地址信息表')).toMatchObject({ state: 'exact', category: 'serial_address_update' });
    expect(recognizeLegacySheet(WORKLOAD, '服务二维码表')).toMatchObject({ state: 'exact', category: 'qr_request' });
    expect(recognizeLegacySheet(WORKLOAD, 'Ship-to申请')).toMatchObject({ state: 'exact', category: 'ship_to_request' });
    // 未知 sheet：待人工映射或排除，不猜测
    const unknown = recognizeLegacySheet(WORKLOAD, '未知统计表');
    expect(unknown.state).toBe('unknown');
    expect(unknown.category).toBeNull();
    expect(unknown.reason).toContain('待人工映射或排除');
    // trim 后精确匹配（不模糊）
    expect(recognizeLegacySheet(EXEC, ' 搬迁项目 ').state).toBe('exact');
  });

  it('供应商 sheet 仅作物流参考，不构成第八类记录', () => {
    const supplier = recognizeLegacySheet(SOURCE_TABLE_FILES.supplier, '供应商主数据');
    expect(supplier.role).toBe('supplier');
    expect(supplier.category).toBeNull();
  });
});

describe('8.21 冻结列别名识别与来源优先级', () => {
  it('已知列按别名精确匹配；未知列进入待人工映射（pending）', () => {
    const recs = recognizeLegacyColumns('project', ['ECC#', 'Account name', '仪器名称', '自定义列', '']);
    expect(recs.map((r) => [r.sourceColumn, r.targetField, r.state])).toEqual([
      ['ECC#', 'contract.ecc', 'alias'],
      ['Account name', 'contract.customer_name', 'alias'],
      ['仪器名称', 'instrument.name', 'exact'],
      ['自定义列', null, 'pending'],
    ]);
  });

  it('明确排除的列进入 ignored（不猜测、不映射）', () => {
    const recs = recognizeLegacyColumns('invoice', ['ECC', '备注列'], { excluded: ['备注列'] });
    const ignored = recs.find((r) => r.sourceColumn === '备注列');
    expect(ignored).toMatchObject({ targetField: null, state: 'ignored' });
  });

  it('工作表实际表头别名：单号/类型/日期/金额（USD）/AccountID 精确匹配', () => {
    const serviceOrder = recognizeLegacyColumns('service_order', ['单号', '类型', '日期', '工程师', '客户单位']);
    expect(serviceOrder.map((r) => r.targetField)).toEqual([
      'service_order.service_order_no',
      'service_order.order_type',
      'service_order.ordered_at',
      'service_order.engineer',
      'service_order.customer_name',
    ]);
    const invoice = recognizeLegacyColumns('invoice', ['ECC', '金额（USD）', '掉票时间']);
    expect(invoice.every((r) => r.state !== 'pending')).toBe(true);
    const sau = recognizeLegacyColumns('serial_address_update', ['AccountID', '单位名称', '更新日期']);
    expect(sau.map((r) => r.targetField)).toEqual([
      'serial_address_update.account_id',
      'serial_address_update.customer_name',
      'serial_address_update.updated_at',
    ]);
  });

  it('来源优先级：合同字段以合同信息表为主、执行字段以项目执行表为主', () => {
    // 数字越小越优先
    expect(legacySourcePriority('contract-info', 'contract.customer_name')).toBe(1);
    expect(legacySourcePriority('project-execution', 'contract.customer_name')).toBe(2);
    expect(legacySourcePriority('project-execution', 'project.region')).toBe(1);
    expect(legacySourcePriority('contract-info', 'project.region')).toBe(2);
    expect(legacySourcePriority('supplier', 'contract.ecc')).toBeNull();
  });

  it('目标字段目录可列出供列映射界面展示', () => {
    const fields = targetFieldsFor('service_order');
    expect(fields).toContain('service_order.service_order_no');
    expect(fields).toContain('service_order.note');
  });
});
