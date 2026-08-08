import ExcelJS from 'exceljs';
import type { SourceRow } from './source-model';
import { serializeExcelSerial, utcDateToBusinessDate, utcDateToIsoLocal, type DateSemantics, type ExcelDateSystem } from './excel-date';

/**
 * 源 Excel 读取（tasks 8.1/8.6 兼容入口）与可中止原始单元格读取
 * （tasks 8.20：exceljs 解析可 Abort，主进程/worker 分块消费）。
 *
 * - 每个 sheet 的「首个非空行」作为表头（列名），其后非空行为数据行；
 * - 数据行报告 Excel 物理行号（physical row），不报告数据序号；
 * - 空白行跳过；公式取缓存结果；Excel 日期转换为稳定本地格式字符串；
 * - 读取过程不产生任何写入（dry-run 数据零变更的输入侧保证）。
 * - readWorkbookGrid：原始单元格读取，协作式 Abort（sheet/行边界检查），
 *   供统一规范化管线按字段目录转换，不在此层猜测业务值。
 */

export interface ReadSourceOptions {
  /** 每个 sheet 数据行数上限（防御异常文件，0/缺省不限）。 */
  maxRowsPerSheet?: number;
}

/** 原始单元格值（未做字段级规范化；保留类型以便按字段目录转换）。 */
export type RawCellValue =
  | { kind: 'empty' }
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: Date }
  | { kind: 'formula'; formula: string; cached: RawCellValue | null };

/** 工作表原始网格（rows[0] = Excel 第 1 行）。 */
export interface RawSheetGrid {
  name: string;
  rows: RawCellValue[][];
}

export interface WorkbookGrid {
  sheets: RawSheetGrid[];
  /** 工作簿日期系统（exceljs 按 date1904 解析单元格，此处供规范化复读）。 */
  date1904: boolean;
}

export interface ReadWorkbookGridOptions {
  signal?: AbortSignal;
  /** 每个 sheet 读取行数上限（防御异常文件；缺省不限）。 */
  maxRowsPerSheet?: number;
}

/** 读取被取消（协作式中止）：调用方恢复操作前最后一次已保存修订。 */
export class ReadAbortedError extends Error {
  constructor(message = 'Excel 读取已取消') {
    super(message);
    this.name = 'ReadAbortedError';
  }
}

/** 协作式中止检查：signal.aborted 时抛 ReadAbortedError。 */
export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ReadAbortedError();
  }
}

/** 读取单个 Excel 文件为源行集合。 */
export async function readExcelFile(filePath: string, options: ReadSourceOptions = {}): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const rows: SourceRow[] = [];
  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const maxRows = options.maxRowsPerSheet ?? Number.POSITIVE_INFINITY;
    const values = worksheet.getSheetValues();

    // 表头 = 首个非空行（列索引 → 列名）；其后非空行为数据行。
    let header: Record<number, string> = {};
    let headerRow = -1;
    for (let r = 1; r < values.length; r++) {
      const rowValues = values[r];
      if (rowValues == null) continue;
      if (!Array.isArray(rowValues)) continue;
      const textMap = rowToTextMap(rowValues);
      if (Object.keys(textMap).length === 0) continue;
      header = textMap;
      headerRow = r;
      break;
    }
    if (headerRow === -1) continue; // 空 sheet：无表头，跳过

    let dataCount = 0;
    for (let r = headerRow + 1; r < values.length; r++) {
      const rowValues = values[r];
      if (rowValues == null) continue;
      if (!Array.isArray(rowValues)) continue;
      const cells: Record<string, string | null> = {};
      let nonEmpty = 0;
      for (const c of Object.keys(header)) {
        const colIndex = Number(c);
        const text = cellToText(rowValues[colIndex]);
        cells[header[colIndex]] = text;
        if (text !== null) nonEmpty += 1;
      }
      if (nonEmpty === 0) continue; // 空白行跳过
      dataCount += 1;
      if (dataCount > maxRows) break;
      // physical row：Excel 行号（r）
      rows.push({ file: filePath, sheet: sheetName, rowNumber: r, cells });
    }
  }
  return rows;
}

/** 行值 → 非空列名映射（用于表头识别）。 */
function rowToTextMap(rowValues: unknown[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (let c = 1; c < rowValues.length; c++) {
    const name = cellToText(rowValues[c]);
    if (name !== null) map[c] = name;
  }
  return map;
}

/** 单元格 → 文本（null 表示空）；公式取缓存结果；Excel 日期转稳定本地格式。 */
function cellToText(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  // 直接 Date 值（exceljs 对日期单元格可能直接返回 Date 对象）
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return formatLocalDate(cell);
  }
  if (typeof cell === 'object') {
    const c = cell as { result?: unknown; text?: unknown; value?: unknown };
    // 公式单元格：优先取缓存结果
    if (c.result !== undefined && c.result !== null) {
      const resultText = valueToText(c.result);
      if (resultText !== null) return resultText;
    }
    // 格式化文本（日期/数字按单元格格式）
    if (c.text !== undefined && c.text !== null) {
      const text = String(c.text).trim();
      if (text !== '') return text;
    }
    if (c.value !== undefined && c.value !== null) return valueToText(c.value);
    return null;
  }
  return valueToText(cell);
}

/** 任意值 → 稳定文本（Date 转本地 YYYY-MM-DDTHH:mm:ss，避免 locale 差异）。 */
function valueToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDate(value);
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Excel 日期 → 稳定本地格式（与领域时间表示一致，无时区歧义）。 */
function formatLocalDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// 可中止原始单元格读取（tasks 8.20）
// ---------------------------------------------------------------------------

/** exceljs 单元格值对象 → 原始单元格值（递归处理公式缓存值）。 */
export function convertExcelJsCell(value: unknown): RawCellValue {
  if (value === null || value === undefined) return { kind: 'empty' };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? { kind: 'empty' } : { kind: 'date', value };
  }
  if (typeof value === 'string') return { kind: 'text', value };
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'object') {
    const obj = value as {
      formula?: unknown;
      result?: unknown;
      error?: unknown;
      text?: unknown;
      hyperlink?: unknown;
      richText?: unknown;
    };
    if (typeof obj.formula === 'string') {
      let cached: RawCellValue | null = null;
      if (obj.result !== undefined && obj.result !== null && typeof obj.result !== 'object') {
        const converted = convertExcelJsCell(obj.result);
        if (converted.kind !== 'empty') cached = converted;
      } else if (obj.result instanceof Date) {
        cached = { kind: 'date', value: obj.result };
      }
      // 错误结果（{ error: ... }）视为无可信静态值。
      return { kind: 'formula', formula: obj.formula, cached };
    }
    if (typeof obj.error === 'string') return { kind: 'text', value: obj.error };
    if (obj.hyperlink !== undefined && obj.text !== undefined) {
      return { kind: 'text', value: String(obj.text) };
    }
    if (obj.richText !== undefined && Array.isArray(obj.richText)) {
      const text = obj.richText
        .map((part: { text?: unknown }) => (part && typeof part.text === 'string' ? part.text : ''))
        .join('');
      return { kind: 'text', value: text };
    }
    if (obj.text !== undefined && obj.text !== null) {
      return { kind: 'text', value: String(obj.text) };
    }
    return { kind: 'empty' };
  }
  return { kind: 'empty' };
}

/** 原始单元格 → 字段级可规范化的文本（日期按业务本地口径；公式无缓存值返回 null）。 */
export function rawCellToFieldString(
  raw: RawCellValue,
  semantics: DateSemantics | null,
  dateSystem: ExcelDateSystem,
): string | null {
  switch (raw.kind) {
    case 'empty':
      return null;
    case 'text':
      return raw.value;
    case 'boolean':
      return raw.value ? 'TRUE' : 'FALSE';
    case 'number':
      // 数字单元格按文本输出；标识符类字段由调用方决定是否接受（前导零只存在于文本存储）。
      return String(raw.value);
    case 'date':
      if (semantics === null) {
        return utcDateToBusinessDate(raw.value);
      }
      return semantics === 'date' ? utcDateToBusinessDate(raw.value) : utcDateToIsoLocal(raw.value);
    case 'formula': {
      if (raw.cached === null) return null;
      return rawCellToFieldString(raw.cached, semantics, dateSystem);
    }
  }
}

/** 公式单元格的安全性判定：DDE / 外部工作簿引用。 */
export interface FormulaSafety {
  dde: boolean;
  externalReference: boolean;
}

/** DDE 公式（含 | 语法）或外部工作簿引用（[ 或 .xls 扩展名）为不可安全读取。 */
export function inspectFormula(formula: string): FormulaSafety {
  const normalized = formula.trim();
  return {
    dde: normalized.includes('|'),
    externalReference: normalized.includes('[') || /\.xls[msx]?/i.test(normalized),
  };
}

/** 读取工作簿原始网格（协作式 Abort；保留物理行号）。 */
export async function readWorkbookGrid(buffer: Buffer, options: ReadWorkbookGridOptions = {}): Promise<WorkbookGrid> {
  const { signal, maxRowsPerSheet } = options;
  const workbook = new ExcelJS.Workbook();
  assertNotAborted(signal);
  await workbook.xlsx.load(buffer as never);
  assertNotAborted(signal);

  const sheets: RawSheetGrid[] = [];
  for (const worksheet of workbook.worksheets) {
    assertNotAborted(signal);
    const values = worksheet.getSheetValues();
    const rows: RawCellValue[][] = [];
    const rowLimit = maxRowsPerSheet ?? Number.POSITIVE_INFINITY;
    let dataRows = 0;
    for (let r = 1; r < values.length; r += 1) {
      if (r % 200 === 0) assertNotAborted(signal);
      const rowValues = values[r];
      const cells: RawCellValue[] = [];
      if (Array.isArray(rowValues)) {
        let nonEmpty = 0;
        for (let c = 1; c < rowValues.length; c += 1) {
          const raw = convertExcelJsCell(rowValues[c]);
          cells.push(raw);
          if (raw.kind !== 'empty') nonEmpty += 1;
        }
        if (nonEmpty > 0) dataRows += 1;
      }
      rows.push(cells);
      if (dataRows > rowLimit) break;
    }
    sheets.push({ name: worksheet.name, rows });
  }
  return { sheets, date1904: workbook.properties.date1904 === true };
}

/** 与 readWorkbookGrid 一致：serial 单元格按日期系统确定性转换（纯日期）。 */
export function serialToBusinessDate(serial: number, dateSystem: ExcelDateSystem): string | null {
  return serializeExcelSerial(serial, dateSystem, 'date');
}
