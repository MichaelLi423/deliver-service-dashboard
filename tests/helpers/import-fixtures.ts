import ExcelJS from 'exceljs';
import { fieldCatalogFor } from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { TEMPLATE_INSTRUCTIONS_SHEET, TEMPLATE_VERSION } from '../../src/domain/capabilities/historical-data-import/template';
import { IMPORT_CATEGORY_LABELS, IMPORT_CATEGORIES, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';

/**
 * import 集成测试夹具（8.69 / 8.79~8.82）。
 *
 * 只构造合成数据，不读取真实 docs。模板工作簿 = 填写说明 + 七类业务 sheet，
 * 数据行以「表头 label → 值」表达，与模板列一一对齐；粘贴文本为同一表头的
 * TSV 矩形，保证文件/粘贴共享同一规范化行模型（design D21）。
 */

/** 模板业务 sheet 表头：source_row_id 前置 + 字段目录 label。 */
export function templateHeaders(category: ImportCategory): string[] {
  return ['source_row_id', ...fieldCatalogFor(category).map((f) => f.label)];
}

export interface TemplateFixtureOptions {
  /** 覆盖模板版本单元格（旧版本识别测试用）。 */
  version?: number;
}

/** 构造模板工作簿：每类别 sheet 写入表头 + 数据行（label → 值）。 */
export async function buildTemplateBuffer(
  rowsByCategory: Partial<Record<ImportCategory, Array<Record<string, string | number>>>>,
  options: TemplateFixtureOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
  instructions.getCell('A2').value = '模板版本';
  instructions.getCell('B2').value = String(options.version ?? TEMPLATE_VERSION);
  for (const category of IMPORT_CATEGORIES) {
    const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS[category]);
    const headers = templateHeaders(category);
    ws.addRow(headers);
    for (const values of rowsByCategory[category] ?? []) {
      ws.addRow(headers.map((h) => values[h] ?? ''));
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** 项目行的确定性合成数据（source_row_id / ECC / 客户名称 / 区域 / 合同区间 / 仪器 / 序列号 / 合同金额）。 */
export function projectRow(i: number, options: { eccPrefix?: string; customerPrefix?: string } = {}): Record<string, string> {
  const ecc = `${options.eccPrefix ?? 'ECC'}-${String(i).padStart(6, '0')}`;
  return {
    source_row_id: `sid-${ecc}`,
    ECC: ecc,
    客户名称: `${options.customerPrefix ?? '客户'}${i}`,
    区域: '华东',
    合同开始日期: '2025-01-01',
    合同截止日期: '2025-12-31',
    仪器名称: `仪器${i}`,
    序列号: `SN-${String(i).padStart(6, '0')}`,
    合同USD含税金额: '10000.00',
  };
}

/** 50k 基准夹具定义：project 类别 13 列（含 source_row_id），每行填充 9 个数据单元格。 */
export const LARGE_FIXTURE_COLUMNS = 13;
export const LARGE_FIXTURE_CELLS_PER_ROW = 9;
export const LARGE_FIXTURE_ROWS = 50_000;

/** 构造 50,000 行 project 模板工作簿（合成、确定性；字节数由测试记录）。 */
export async function buildLargeTemplateBuffer(rows: number = LARGE_FIXTURE_ROWS): Promise<Buffer> {
  const data = Array.from({ length: rows }, (_, i) => projectRow(i));
  return buildTemplateBuffer({ project: data });
}

/** 同一批 project 行的粘贴 TSV 文本（表头 + 数据行，逐列对齐）。 */
export function projectPasteText(rows: readonly (Record<string, string | number>)[]): string {
  const headers = templateHeaders('project');
  const lines = [headers.join('\t')];
  for (const values of rows) {
    lines.push(headers.map((h) => values[h] ?? '').join('\t'));
  }
  return lines.join('\n');
}
