import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import type { ExcelDateSystem } from './excel-date';

/**
 * `.xlsx` 有界预检（design D22 / tasks 8.19）。
 *
 * 使用直接声明的有界 ZIP 读取依赖（yauzl）检查中央目录：
 * - 文件大小、entry 数、单 entry 声明大小、累计展开量、单 entry 压缩比；
 * - 拒绝路径异常（绝对路径 / 穿越 / 反斜杠 / 非法字符）；
 * - 拒绝宏（vba）、外部链接（xl/externalLinks）、非法压缩方法；
 * - 再以流式 XML 扫描限制 sheet 数、行数、列数与单元格数；
 * - 展开量受硬上限约束后才进入 exceljs 解析，不依赖解析库碰巧拒绝压缩炸弹。
 *
 * 预检不读取任何业务值，只统计结构与体积。
 */

export interface XlsxPreflightLimits {
  /** 单文件字节上限（默认 100 MiB）。 */
  maxFileBytes: number;
  /** ZIP entry（含目录）总数上限。 */
  maxEntries: number;
  /** 单 entry 声明展开字节上限。 */
  maxUncompressedBytesPerEntry: number;
  /** 单文件累计展开字节上限（D22：展开合计 1 GiB）。 */
  maxTotalUncompressedBytes: number;
  /** 单 entry 压缩比上限（uncompressed / compressed）。 */
  maxCompressionRatio: number;
  /** sheet 数上限（D22：100）。 */
  maxSheets: number;
  /** 单 sheet 行数上限（D22：总行数上限 500,000）。 */
  maxRowsPerSheet: number;
  /** 单 sheet 列数上限（D22：200 列）。 */
  maxColumnsPerSheet: number;
  /** 单 sheet 单元格数上限（防御性硬限制）。 */
  maxCellsPerSheet: number;
}

export const DEFAULT_XLSX_PREFLIGHT_LIMITS: XlsxPreflightLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxEntries: 4096,
  maxUncompressedBytesPerEntry: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxSheets: 100,
  maxRowsPerSheet: 500_000,
  maxColumnsPerSheet: 200,
  maxCellsPerSheet: 20_000_000,
};

/** 跨文件批次上限（D22：最多 20 个文件、压缩输入合计 250 MiB、展开合计 1 GiB）。 */
export interface XlsxBatchLimits {
  maxFiles: number;
  maxTotalCompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export const DEFAULT_XLSX_BATCH_LIMITS: XlsxBatchLimits = {
  maxFiles: 20,
  maxTotalCompressedBytes: 250 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
};

export type PreflightViolationCode =
  | 'NOT_A_ZIP'
  | 'CORRUPT_ZIP'
  | 'ZIP_TOO_LARGE'
  | 'TOO_MANY_ENTRIES'
  | 'ENTRY_UNCOMPRESSED_TOO_LARGE'
  | 'TOTAL_UNCOMPRESSED_TOO_LARGE'
  | 'COMPRESSION_RATIO_TOO_HIGH'
  | 'PATH_TRAVERSAL'
  | 'ABSOLUTE_PATH'
  | 'BACKSLASH_PATH'
  | 'INVALID_ENTRY_PATH'
  | 'VBA_MACRO'
  | 'EXTERNAL_LINK'
  | 'BAD_COMPRESSION_METHOD'
  | 'MISSING_WORKBOOK_XML'
  | 'TOO_MANY_SHEETS'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_COLUMNS'
  | 'TOO_MANY_CELLS';

export interface PreflightViolation {
  code: PreflightViolationCode;
  message: string;
  entry?: string;
}

export interface XlsxPreflightResult {
  ok: boolean;
  violations: PreflightViolation[];
  /** 检查的 entry 数（含目录）。 */
  entries: number;
  fileBytes: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  sheetCount: number;
  dateSystem: ExcelDateSystem;
}

export class XlsxPreflightError extends Error {
  constructor(
    readonly result: XlsxPreflightResult,
    message = 'Excel 文件未通过有界预检，拒绝读取',
  ) {
    super(message);
    this.name = 'XlsxPreflightError';
  }
}

interface SheetXmlStats {
  rows: number;
  columns: number;
  cells: number;
}

const EMPTY_STATS: SheetXmlStats = { rows: 0, columns: 0, cells: 0 };

/** 累积扫描：行数 <row、单元格数 <c、列数（最大列引用）。 */
function accumulateSheetXml(chunk: Buffer, partial: SheetXmlStats): SheetXmlStats {
  const text = chunk.toString('utf8');
  const rowMatches = text.match(/<row[\s>]/g);
  const cellMatches = text.match(/<c[\s>]/g);
  let maxCol = partial.columns;
  const colRefRe = /r="([A-Z]+)\d+"/g;
  let m: RegExpExecArray | null;
  while ((m = colRefRe.exec(text)) !== null) {
    let col = 0;
    const letters = m[1];
    for (let i = 0; i < letters.length; i += 1) {
      col = col * 26 + (letters.charCodeAt(i) - 64);
    }
    if (col > maxCol) maxCol = col;
  }
  return {
    rows: partial.rows + (rowMatches?.length ?? 0),
    columns: maxCol,
    cells: partial.cells + (cellMatches?.length ?? 0),
  };
}

function isSheetXmlEntry(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return /^sheet\d+\.xml$/.test(base) && name.startsWith('xl/worksheets/');
}

/** 预检结果：ok=false 时拒绝输入；violations 说明超出的上限（不泄露业务值）。 */
export async function preflightXlsx(
  buffer: Buffer,
  limits: XlsxPreflightLimits = DEFAULT_XLSX_PREFLIGHT_LIMITS,
): Promise<XlsxPreflightResult> {
  const fileBytes = buffer.byteLength;
  const violations: PreflightViolation[] = [];
  const push = (v: PreflightViolation): void => {
    violations.push(v);
  };

  if (fileBytes > limits.maxFileBytes) {
    push({ code: 'ZIP_TOO_LARGE', message: `文件大小 ${fileBytes} 字节超过上限 ${limits.maxFileBytes} 字节` });
    return emptyResult(violations, fileBytes);
  }

  let zipfile: ZipFile;
  try {
    zipfile = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      decodeStrings: true,
    });
  } catch (err) {
    push({
      code: 'NOT_A_ZIP',
      message: `无法按 ZIP 打开文件: ${err instanceof Error ? err.message : String(err)}`,
    });
    return emptyResult(violations, fileBytes);
  }

  // lazyEntries 遍历结束后不能再枚举中央目录；此处缓存 entry 供后续按名打开读流。
  const entriesByName = new Map<string, Entry>();
  let entries = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;

  const iterate = (): Promise<void> =>
    new Promise<void>((resolve, _reject) => {
      zipfile.readEntry();
      zipfile.on('entry', (entry: Entry) => {
        entries += 1;
        const name = entry.fileName;
        entriesByName.set(name, entry);
        const fail = (code: PreflightViolationCode, message: string, includeEntry = true): void => {
          // 路径/宏/外链等异常不复制原始 entry 名（可能被注入业务值，8.73 脱敏）。
          push(includeEntry ? { code, entry: name, message } : { code, message });
          zipfile.close();
          resolve();
        };

        if (entries > limits.maxEntries) {
          fail('TOO_MANY_ENTRIES', `ZIP entry 数 ${entries} 超过上限 ${limits.maxEntries}`);
          return;
        }
        if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
          fail('ABSOLUTE_PATH', 'entry 路径为绝对路径，拒绝读取', false);
          return;
        }
        // yauzl 解码时会把 \ 规范为 /；以原始字节检查反斜杠路径异常。
        // 路径异常消息不复制原始 entry 名（可能被注入业务值，见 8.73 脱敏）。
        if (name.includes('\\') || entry.fileNameRaw.includes(0x5c)) {
          fail('BACKSLASH_PATH', `entry 路径包含反斜杠（原始字节 ${entry.fileNameRaw.length} 字节），拒绝读取`, false);
          return;
        }
        if (name.split('/').includes('..')) {
          fail('PATH_TRAVERSAL', 'entry 路径包含穿越段，拒绝读取', false);
          return;
        }
        const pathCheck = yauzl.validateFileName(name);
        if (name === '' || pathCheck !== null) {
          fail('INVALID_ENTRY_PATH', 'entry 路径含非法字符，拒绝读取', false);
          return;
        }
        if (/vba/i.test(name)) {
          fail('VBA_MACRO', 'entry 包含宏（vba）内容，拒绝读取', false);
          return;
        }
        if (/^xl\/externalLinks\//.test(name) || /externalLink/.test(name)) {
          fail('EXTERNAL_LINK', 'entry 为外部链接引用，拒绝读取', false);
          return;
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          fail('BAD_COMPRESSION_METHOD', `entry 压缩方法 ${entry.compressionMethod} 不受支持（仅 store=0 / deflate=8）`, false);
          return;
        }

        totalCompressed += entry.compressedSize;
        totalUncompressed += entry.uncompressedSize;
        if (entry.uncompressedSize > limits.maxUncompressedBytesPerEntry) {
          fail('ENTRY_UNCOMPRESSED_TOO_LARGE', `entry 声明展开 ${entry.uncompressedSize} 字节超过上限 ${limits.maxUncompressedBytesPerEntry}`);
          return;
        }
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
          fail('TOTAL_UNCOMPRESSED_TOO_LARGE', `累计展开 ${totalUncompressed} 字节超过上限 ${limits.maxTotalUncompressedBytes}`);
          return;
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize > entry.compressedSize * limits.maxCompressionRatio) {
          fail('COMPRESSION_RATIO_TOO_HIGH', `entry 压缩比 ${entry.uncompressedSize}/${entry.compressedSize} 超过上限 ${limits.maxCompressionRatio}`);
          return;
        }

        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', (err: Error) => {
        const message = err.message ?? String(err);
        // yauzl 在中央目录遍历时对非法路径先于 entry 事件报错；映射为具体违规码。
        // 路径类消息不复制 yauzl 原文（可能包含被注入的 entry 名，8.73 脱敏）。
        if (/invalid relative path/.test(message)) {
          push({ code: 'PATH_TRAVERSAL', message: 'entry 路径包含穿越段，拒绝读取' });
        } else if (/absolute path/.test(message)) {
          push({ code: 'ABSOLUTE_PATH', message: 'entry 路径为绝对路径，拒绝读取' });
        } else if (/invalid characters in fileName/.test(message)) {
          push({ code: message.includes('\\\\') ? 'BACKSLASH_PATH' : 'INVALID_ENTRY_PATH', message: 'entry 路径含非法字符，拒绝读取' });
        } else {
          push({ code: 'CORRUPT_ZIP', message });
        }
        zipfile.close();
        resolve();
      });
    });

  try {
    await iterate();
  } catch (err) {
    zipfile.close();
    push({ code: 'CORRUPT_ZIP', message: `ZIP 中央目录读取失败: ${err instanceof Error ? err.message : String(err)}` });
    return {
      ok: false,
      violations,
      entries,
      fileBytes,
      totalCompressedBytes: totalCompressed,
      totalUncompressedBytes: totalUncompressed,
      sheetCount: 0,
      dateSystem: '1900',
    };
  }
  if (violations.length > 0 || !zipfile.isOpen) {
    if (zipfile.isOpen) zipfile.close();
    return {
      ok: false,
      violations,
      entries,
      fileBytes,
      totalCompressedBytes: totalCompressed,
      totalUncompressedBytes: totalUncompressed,
      sheetCount: 0,
      dateSystem: '1900',
    };
  }

  // ---- 结构检查：workbook.xml（sheet 数、日期系统）与工作表 XML（行/列/单元格） ----
  if (!entriesByName.has('xl/workbook.xml')) {
    push({ code: 'MISSING_WORKBOOK_XML', message: '缺少 xl/workbook.xml，不是受支持的 .xlsx 结构' });
    zipfile.close();
    return {
      ok: false,
      violations,
      entries,
      fileBytes,
      totalCompressedBytes: totalCompressed,
      totalUncompressedBytes: totalUncompressed,
      sheetCount: 0,
      dateSystem: '1900',
    };
  }

  let sheetCount = 0;
  let dateSystem: ExcelDateSystem = '1900';
  try {
    const workbookXml = await readEntryText(zipfile, entriesByName, 'xl/workbook.xml');
    sheetCount = workbookXml.match(/<sheet[\s>]/g)?.length ?? 0;
    if (sheetCount > limits.maxSheets) {
      push({ code: 'TOO_MANY_SHEETS', message: `sheet 数 ${sheetCount} 超过上限 ${limits.maxSheets}` });
    }
    if (/date1904\s*=\s*["']1["']/.test(workbookXml) || /date1904\s*=\s*["']true["']/i.test(workbookXml)) {
      dateSystem = '1904';
    }

    if (violations.length === 0) {
      for (const [name] of entriesByName) {
        if (!isSheetXmlEntry(name)) continue;
        const stats = await scanEntryStream(zipfile, name, entriesByName, EMPTY_STATS);
        if (stats.rows > limits.maxRowsPerSheet) {
          push({ code: 'TOO_MANY_ROWS', entry: name, message: `sheet「${name}」行数 ${stats.rows} 超过上限 ${limits.maxRowsPerSheet}` });
          break;
        }
        if (stats.columns > limits.maxColumnsPerSheet) {
          push({ code: 'TOO_MANY_COLUMNS', entry: name, message: `sheet「${name}」列数 ${stats.columns} 超过上限 ${limits.maxColumnsPerSheet}` });
          break;
        }
        if (stats.cells > limits.maxCellsPerSheet) {
          push({ code: 'TOO_MANY_CELLS', entry: name, message: `sheet「${name}」单元格数 ${stats.cells} 超过上限 ${limits.maxCellsPerSheet}` });
          break;
        }
      }
    }
  } catch (err) {
    zipfile.close();
    push({ code: 'CORRUPT_ZIP', message: `工作簿结构读取失败: ${err instanceof Error ? err.message : String(err)}` });
    return {
      ok: false,
      violations,
      entries,
      fileBytes,
      totalCompressedBytes: totalCompressed,
      totalUncompressedBytes: totalUncompressed,
      sheetCount,
      dateSystem,
    };
  }

  if (zipfile.isOpen) zipfile.close();
  return {
    ok: violations.length === 0,
    violations,
    entries,
    fileBytes,
    totalCompressedBytes: totalCompressed,
    totalUncompressedBytes: totalUncompressed,
    sheetCount,
    dateSystem,
  };
}

function emptyResult(violations: PreflightViolation[], fileBytes: number): XlsxPreflightResult {
  return {
    ok: false,
    violations,
    entries: 0,
    fileBytes,
    totalCompressedBytes: 0,
    totalUncompressedBytes: 0,
    sheetCount: 0,
    dateSystem: '1900',
  };
}

/** 读取整个 entry 为文本（仅限小文件，如 workbook.xml；带防御性上限）。 */
async function readEntryText(
  zipfile: ZipFile,
  entriesByName: Map<string, Entry>,
  name: string,
): Promise<string> {
  const entry = entriesByName.get(name);
  if (!entry) return '';
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    total += buf.byteLength;
    if (total > 8 * 1024 * 1024) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 流式扫描 entry（sheet XML），累积行/列/单元格统计。 */
async function scanEntryStream(
  zipfile: ZipFile,
  name: string,
  entriesByName: Map<string, Entry>,
  initial: SheetXmlStats,
): Promise<SheetXmlStats> {
  const entry = entriesByName.get(name);
  if (!entry) return initial;
  const stream = await zipfile.openReadStreamPromise(entry);
  let partial = initial;
  for await (const chunk of stream) {
    partial = accumulateSheetXml(chunk as Buffer, partial);
  }
  return partial;
}

export interface BatchFileSummary {
  fileName: string;
  fileBytes: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
}

/**
 * 跨文件批次合计上限（D22：文件数 ≤ 20、压缩输入合计 ≤ 250 MiB、
 * 展开合计 ≤ 1 GiB）。返回违规清单；空数组表示通过。
 */
export function preflightBatch(
  files: readonly BatchFileSummary[],
  limits: XlsxBatchLimits = DEFAULT_XLSX_BATCH_LIMITS,
): PreflightViolation[] {
  const violations: PreflightViolation[] = [];
  if (files.length > limits.maxFiles) {
    violations.push({
      code: 'TOO_MANY_ENTRIES',
      message: `输入文件数 ${files.length} 超过上限 ${limits.maxFiles}`,
    });
  }
  const compressed = files.reduce((sum, f) => sum + f.totalCompressedBytes, 0);
  const uncompressed = files.reduce((sum, f) => sum + f.totalUncompressedBytes, 0);
  if (compressed > limits.maxTotalCompressedBytes) {
    violations.push({
      code: 'TOTAL_UNCOMPRESSED_TOO_LARGE',
      message: `压缩输入合计 ${compressed} 字节超过上限 ${limits.maxTotalCompressedBytes}`,
    });
  }
  if (uncompressed > limits.maxTotalUncompressedBytes) {
    violations.push({
      code: 'TOTAL_UNCOMPRESSED_TOO_LARGE',
      message: `展开合计 ${uncompressed} 字节超过上限 ${limits.maxTotalUncompressedBytes}`,
    });
  }
  return violations;
}
