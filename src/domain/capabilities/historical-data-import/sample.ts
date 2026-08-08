import ExcelJS from 'exceljs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 脱敏样本源文件生成（tasks 8.6/8.10 验证用）。
 *
 * 生成不含真实客户业务数据的匿名样本 xlsx，用于验证 dry-run 只读预演与
 * CLI 命令，不读取/不使用 docs/ 下真实客户 Excel。
 *
 * 样本 sheet 与表头遵循冻结映射 MAPPING_V1 的 sheet 路由与列别名：
 * - 合同信息表：sheet「合同信息」，ECC# 列；
 * - 项目执行表：sheet「搬迁项目」（另含辅助 sheet「工作表1」「MRS Node」验证 ignored）；
 * - 工作量统计：sheet「开单」「掉票」「物流费用」「地址更新」「二维码」「Ship-to申请」；
 * - 物流公司信息费用表：sheet「物流费用表」；
 * - 供应商表：供应商主数据 sheet（默认 supplier，不伪造费用错误）。
 */
export interface DesensitizedSampleOptions {
  /** 目标目录。 */
  dir: string;
  /** 子目录前缀（默认 desensitized）。 */
  prefix?: string;
}

export interface DesensitizedSampleResult {
  files: string[];
  /** 生成的 dry-run 报告文件路径。 */
  reportPath: string;
}

const CONTRACT_FILE = '合同信息表.xlsx';
const EXEC_FILE = '项目执行表.xlsx';
const WORKLOAD_FILE = '工作量统计.xlsx';
const LOGISTICS_FILE = '物流公司信息费用表.xlsx';
const SUPPLIER_FILE = '供应商表.xlsx';

async function writeSheet(wb: ExcelJS.Workbook, name: string, headers: string[], rows: (string | number | null)[][]): Promise<void> {
  const ws = wb.addWorksheet(name);
  ws.addRow(headers);
  for (const r of rows) {
    ws.addRow(r);
  }
}

async function buildSample(dir: string, prefix: string): Promise<string[]> {
  const outDir = join(dir, prefix);
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];

  // 合同信息表：sheet「合同信息」，ECC# 列别名
  {
    const wb = new ExcelJS.Workbook();
    await writeSheet(wb, '合同信息', ['ECC#', '客户名称', '合同USD含税金额', '进单时间', '区域', '合同开始日期', '合同截止日期'], [
      ['MIG-0001', '样本客户甲', '120000', '2026-01-15T09:00:00+08:00', '华东', '2026-01-01', '2026-12-31'],
      ['MIG-0002', '样本客户乙', '80000', '2026-03-01T09:00:00+08:00', '华南', '2026-03-01', '2026-12-31'],
    ]);
    const file = join(outDir, CONTRACT_FILE);
    await wb.xlsx.writeFile(file);
    files.push(file);
  }

  // 项目执行表：sheet「搬迁项目」；辅助 sheet「工作表1」「MRS Node」按 mapping ignored
  {
    const wb = new ExcelJS.Workbook();
    await writeSheet(wb, '搬迁项目', ['ECC#', '客户名称', '区域', '仪器名称', '序列号', '实际装机完成时间', '验收报告形成日期'], [
      ['MIG-0001', '样本客户甲', '华东', '分析仪A', 'SN-SAMPLE-001', '2026-02-10T16:00:00+08:00', '2026-02-20'],
      ['MIG-0001', '样本客户甲', '华东', '分析仪B', 'SN-SAMPLE-002', null, null],
    ]);
    await writeSheet(wb, '工作表1', ['辅助列'], [['工作表1 辅助数据']]);
    await writeSheet(wb, 'MRS Node', ['辅助列'], [['MRS Node 辅助数据']]);
    const file = join(outDir, EXEC_FILE);
    await wb.xlsx.writeFile(file);
    files.push(file);
  }

  // 工作量统计：按 sheet 分别解析开单/掉票/物流费用/地址更新/二维码/Ship-to申请
  // （表头使用真实 workbook 已确认别名，验证 别名+Unicode NFC/trim 匹配）
  {
    const wb = new ExcelJS.Workbook();
    await writeSheet(wb, '开单记录表', ['日期', '单号', '类型', '工程师', '客户单位'], [
      ['2026-01-20T10:00:00+08:00', 'SO-SAMPLE-001', 'relocation', '工程师丙', '样本客户甲'],
      ['2026-02-01T10:00:00+08:00', 'SO-SAMPLE-002', 'pm', '工程师丁', '样本客户乙'],
    ]);
    await writeSheet(wb, '掉票记录表', ['掉票时间', 'ECC', '区域', '客户名称', '金额（USD）'], [
      ['2026-03-01T00:00:00+08:00', 'MIG-0001', '华东', '样本客户甲', '50000'],
    ]);
    await writeSheet(wb, '物流费用表', ['月份', '金额', '物流公司'], [
      ['2026-01', '2750', '样本运输公司'],
    ]);
    await writeSheet(wb, '搬迁地址信息表', ['单位名称', '新址地址', '序列号', 'Account ID', '更新日期'], [
      ['样本客户甲', '样本新址A', 'SN-SAMPLE-001', 'ACC-SAMPLE-001', '2026-02-15T00:00:00+08:00'],
    ]);
    await writeSheet(wb, '服务二维码表', ['日期', '申请人', '类型数量'], [
      ['2026-02-16T00:00:00+08:00', '样本客户甲', '1'],
    ]);
    await writeSheet(wb, '搬迁地址信息表（原表无，待新增项）', ['日期', '客户单位名称', 'Account ID'], [
      ['2026-02-17T00:00:00+08:00', '样本客户甲', 'ACC-SAMPLE-002'],
    ]);
    const file = join(outDir, WORKLOAD_FILE);
    await wb.xlsx.writeFile(file);
    files.push(file);
  }

  // 物流公司信息费用表：sheet「物流费用表」；其余 sheet 为供应商主数据（不伪造费用错误）
  {
    const wb = new ExcelJS.Workbook();
    await writeSheet(wb, '物流费用表', ['ECC', '物流费用申请登记时间', '预算价格', '成交价格', '实际物流费用'], [
      ['MIG-0001', '2026-01-25T00:00:00+08:00', '3000', '2800', '2750'],
    ]);
    await writeSheet(wb, '供应商主数据', ['运输公司', '联系人'], [['样本运输公司', '样本联系人']]);
    const file = join(outDir, LOGISTICS_FILE);
    await wb.xlsx.writeFile(file);
    files.push(file);
  }

  // 供应商表：供应商主数据（default supplier，不产生记录/错误）
  {
    const wb = new ExcelJS.Workbook();
    await writeSheet(wb, '供应商', ['运输公司'], [['样本运输公司']]);
    const file = join(outDir, SUPPLIER_FILE);
    await wb.xlsx.writeFile(file);
    files.push(file);
  }

  return files;
}

/** 生成脱敏样本并执行 dry-run，返回报告路径。 */
export async function generateDesensitizedSampleAndReport(
  options: DesensitizedSampleOptions,
): Promise<DesensitizedSampleResult> {
  const { dir, prefix = 'desensitized' } = options;
  const files = await buildSample(dir, prefix);

  // 动态导入避免构建 CLI 入口时执行
  const { runDryRun } = await import('./migration-service');
  const { MAPPING_V1 } = await import('./mapping');
  const { readExcelFile } = await import('./excel-source');

  const rows = [];
  for (const file of files) {
    rows.push(...(await readExcelFile(file)));
  }
  const report = runDryRun({ rows, mapping: MAPPING_V1 });
  const reportPath = join(dir, `${prefix}-migration-dry-run.json`);
  writeFileSync(reportPath, JSON.stringify({ mappingVersion: MAPPING_V1.version, report }, null, 2), 'utf-8');
  return { files, reportPath };
}
