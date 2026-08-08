import ExcelJS from 'exceljs';
import { IMPORT_CATEGORIES, IMPORT_CATEGORY_LABELS, type ImportCategory } from './workspace/workspace-model';
import { fieldCatalogFor, FIELD_CATALOG_VERSION } from './field-catalog';

/**
 * 当前版本 Excel 空白模板生成器（design D21 / tasks 8.18）。
 *
 * - 单个工作簿：填写说明 sheet + 七个业务 sheet（七类数据各一个）；
 * - 每个业务 sheet 首列为稳定 `source_row_id`（无业务键时用于幂等与修正识别），
 *   其后为对应类别的目标字段表头（来自字段目录）；
 * - 模板版本写入填写说明，`readTemplateVersionFromBuffer` 可识别；
 * - 不包含任何会被识别为真实数据的示例行：业务 sheet 只有表头、无数据行。
 */

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_INSTRUCTIONS_SHEET = '填写说明';
export const SOURCE_ROW_ID_COLUMN = 'source_row_id';
export const TEMPLATE_SHEET_NAME = '搬迁服务历史数据导入模板';

/** 业务 sheet 名（与工作区 IMPORT_CATEGORY_LABELS 一致，保证模板↔工作区同一映射）。 */
export function templateSheetName(category: ImportCategory): string {
  return IMPORT_CATEGORY_LABELS[category];
}

/** 按 sheet 名反向解析类别（模板模式下精确匹配；未知 sheet 返回 undefined）。 */
export function categoryByTemplateSheet(sheetName: string): ImportCategory | undefined {
  const key = sheetName.trim();
  return IMPORT_CATEGORIES.find((c) => IMPORT_CATEGORY_LABELS[c] === key);
}

export interface TemplateOptions {
  /** 覆盖说明 sheet 中的版本单元格（测试旧版本识别用）。 */
  version?: number;
}

/**
 * 生成当前版本空白模板（.xlsx Buffer）。
 * 业务 sheet 仅含表头（source_row_id + 目标字段），不写入任何业务示例行。
 */
export async function generateTemplateWorkbook(options: TemplateOptions = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '搬迁服务工作台';
  workbook.created = new Date();
  workbook.properties.date1904 = false;

  const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
  instructions.getCell('A1').value = TEMPLATE_SHEET_NAME;
  instructions.getCell('A1').font = { bold: true, size: 14 };
  instructions.getCell('A2').value = '模板版本';
  instructions.getCell('B2').value = options.version ?? TEMPLATE_VERSION;
  instructions.getCell('A3').value = '字段目录版本';
  instructions.getCell('B3').value = FIELD_CATALOG_VERSION;
  instructions.getCell('A4').value = '填写说明';
  instructions.getCell('A4').font = { bold: true };
  const lines: Array<[string, string]> = [
    ['source_row_id', '稳定源行 ID（每行填写，sheet 内唯一）：无业务键时用于识别该行，后续修正与幂等重跑不因文件名或行号变化而改变身份；导出后请勿重排行。'],
    ['业务键', 'ECC、服务单号、Account ID、序列号按文本填写，前导零必须保留；系统不会把标识符转为数值。'],
    ['金额', '合同 USD 含税金额允许为 0；其余金额有值必须大于 0。按两位小数录入，系统以分整数精确保存，不使用浮点。'],
    ['日期', '日期列填写 yyyy-mm-dd 或带时区偏移的日期时间；仅填月份无法推断具体日期。'],
    ['开单类型', '搬迁 / 认证 / 单寄备件 / PM。'],
    ['二维码申请', '申请类型必须有明确类型；只有"类型数量"无法导入为具体申请记录。'],
    ['七类数据', '每个业务 sheet 一份数据；某类本次无数据时保留空 sheet 并在向导中确认"本次不导入"，不要删除 sheet。'],
    ['公式与宏', '不接受公式单元格、宏、DDE 或外部链接；请粘贴为静态值。'],
  ];
  for (let i = 0; i < lines.length; i += 1) {
    instructions.getCell(`A${5 + i}`).value = lines[i][0];
    instructions.getCell(`A${5 + i}`).font = { bold: true };
    instructions.getCell(`B${5 + i}`).value = lines[i][1];
    instructions.getCell(`B${5 + i}`).alignment = { wrapText: true };
  }
  instructions.columns = [{ width: 28 }, { width: 72 }];

  for (const category of IMPORT_CATEGORIES) {
    const sheet = workbook.addWorksheet(IMPORT_CATEGORY_LABELS[category]);
    const fields = fieldCatalogFor(category);
    const headers = [SOURCE_ROW_ID_COLUMN, ...fields.map((f) => f.label)];
    sheet.columns = headers.map((h, i) => ({
      header: h,
      key: h,
      width: i === 0 ? 18 : Math.max(14, Math.min(h.length * 2 + 4, 34)),
    }));
    // 仅表头行，无示例/数据行
    sheet.getRow(1).font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface TemplateVersionInfo {
  version: number | null;
  supported: boolean;
}

/** 识别模板版本：读取填写说明 sheet 的版本单元格；解析失败视为不支持。 */
export async function readTemplateVersionFromBuffer(buffer: Buffer): Promise<TemplateVersionInfo> {
  const version = await parseTemplateVersion(buffer);
  if (version === null) return { version: null, supported: false };
  return { version, supported: version === TEMPLATE_VERSION };
}

/** 是否为当前/受支持模板工作簿（存在填写说明且版本受支持）。 */
export async function isSupportedTemplateWorkbook(buffer: Buffer): Promise<boolean> {
  return (await readTemplateVersionFromBuffer(buffer)).supported;
}

/** 是否为模板工作簿（存在填写说明 sheet；版本是否受支持另查）。 */
export async function isTemplateWorkbook(buffer: Buffer): Promise<boolean> {
  return (await parseTemplateVersion(buffer)) !== null;
}

async function parseTemplateVersion(buffer: Buffer): Promise<number | null> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
    if (!sheet) return null;
    const cell = sheet.getCell('B2');
    const raw = cell.value;
    if (raw === null || raw === undefined) return null;
    const text =
      typeof raw === 'object' && raw !== null && 'text' in raw && typeof (raw as { text: unknown }).text === 'string'
        ? (raw as { text: string }).text
        : String(raw);
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return Number(trimmed);
  } catch {
    return null;
  }
}
