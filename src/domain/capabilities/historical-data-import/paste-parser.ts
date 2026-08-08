/**
 * 矩形剪贴板粘贴解析与覆盖预检（design D21/D23 / tasks 8.22）。
 *
 * - 解析 Excel 单元格区域复制文本：行以 \n 分隔、列以 \t 分隔；
 *   短行按首行宽度补齐为矩形，保留行列顺序；
 * - 首行表头由用户确认（confirmFirstRowAsHeader）；
 * - 追加/覆盖预检：在写入工作区前校验目标网格行列与单元格上限，
 *   覆盖会触碰既有行时给出明确结果；
 * - 来源定位：行号 = 粘贴矩形内的行序（含表头行偏移），
 *   批量 = pasteBatch（草稿内唯一）。
 */

export interface ParsedPasteTable {
  /** 去除完全空白行后的全部行（含潜在表头行）。 */
  rows: string[][];
  /** 矩形宽度（列数）。 */
  width: number;
  /** 完全空白的行数（被跳过，不计入 rows）。 */
  skippedEmptyRows: number;
}

/**
 * 解析矩形粘贴文本。每行按 \t 切分；短行补空到最大宽度；
 * 完全空白行跳过（计数返回）。
 */
export function parsePasteText(text: string): ParsedPasteTable {
  if (text.trim() === '') {
    return { rows: [], width: 0, skippedEmptyRows: 0 };
  }
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const rows: string[][] = [];
  let width = 0;
  let skipped = 0;
  for (const line of rawLines) {
    const cells = line.split('\t');
    // 去除行尾空单元格（Excel 复制的矩形尾部通常无多余 tab）
    while (cells.length > 0 && cells[cells.length - 1] === '') {
      cells.pop();
    }
    if (cells.length === 0 || cells.every((c) => c.trim() === '')) {
      if (cells.length === 0) skipped += 1;
      continue;
    }
    rows.push(cells);
    if (cells.length > width) width = cells.length;
  }
  // 补齐为矩形：短行用空串填充到最大宽度
  const padded = rows.map((r) => {
    while (r.length < width) r.push('');
    return r;
  });
  return { rows: padded, width, skippedEmptyRows: skipped };
}

export interface PasteWithHeader {
  /** 表头列名（未确认表头时为空数组）。 */
  header: string[];
  /** 数据行（已去除表头行；未确认表头时包含首行）。 */
  dataRows: string[][];
  /** 数据行数。 */
  rowCount: number;
}

/**
 * 首行表头确认：isHeader=true 时首行作为表头、其余为数据行；
 * false 时无表头、全部行作为数据行（列映射进入待人工映射，不猜测）。
 */
export function confirmFirstRowAsHeader(parsed: ParsedPasteTable, isHeader: boolean): PasteWithHeader {
  if (parsed.rows.length === 0) {
    return { header: [], dataRows: [], rowCount: 0 };
  }
  if (!isHeader) {
    return { header: [], dataRows: parsed.rows, rowCount: parsed.rows.length };
  }
  const header = parsed.rows[0];
  const dataRows = parsed.rows.slice(1);
  return { header, dataRows, rowCount: dataRows.length };
}

export interface PasteOverlayLimits {
  maxRowsPerSheet: number;
  maxColumnsPerSheet: number;
  maxCellsPerSheet: number;
}

export interface PasteOverlayParams {
  /** true=追加到类别末尾；false=覆盖既有行范围。 */
  append: boolean;
  /** 类别中既有行数。 */
  existingRows: number;
  /** 既有网格列数（覆盖模式下校验目标列范围；追加模式取 0 即可）。 */
  existingColumns: number;
  /** 本次数据行数。 */
  dataRowCount: number;
  /** 本次列数。 */
  columnCount: number;
  limits: PasteOverlayLimits;
}

export interface PasteOverlayVerdict {
  allowed: boolean;
  violations: string[];
  /** 数据起始网格行（1 起；追加=existingRows+1，覆盖=1）。 */
  targetStartRow: number;
  /** 数据结束网格行。 */
  targetEndRow: number;
  /** 覆盖模式且目标范围触碰既有行。 */
  wouldOverwrite: boolean;
}

/**
 * 追加/覆盖预检：任何上限违规都拒绝写入（保持既有草稿不变）。
 * 覆盖模式要求目标范围不超出既有网格（行数与列数）。
 */
export function preflightPasteOverlay(params: PasteOverlayParams): PasteOverlayVerdict {
  const violations: string[] = [];
  const { existingRows, existingColumns, dataRowCount, columnCount, limits } = params;

  if (params.append) {
    const endRow = existingRows + dataRowCount;
    if (endRow > limits.maxRowsPerSheet) {
      violations.push(`追加后行数 ${endRow} 超过上限 ${limits.maxRowsPerSheet}`);
    }
    if (columnCount > limits.maxColumnsPerSheet) {
      violations.push(`列数 ${columnCount} 超过上限 ${limits.maxColumnsPerSheet}`);
    }
    if (existingRows * Math.max(existingColumns, columnCount) + dataRowCount * columnCount > limits.maxCellsPerSheet) {
      violations.push(`追加后单元格数超过上限 ${limits.maxCellsPerSheet}`);
    }
    return {
      allowed: violations.length === 0,
      violations,
      targetStartRow: existingRows + 1,
      targetEndRow: endRow,
      wouldOverwrite: false,
    };
  }

  const wouldOverwrite = dataRowCount > 0 && dataRowCount <= existingRows && columnCount <= Math.max(existingColumns, 1);
  if (dataRowCount > existingRows) {
    violations.push(`覆盖数据行数 ${dataRowCount} 超出既有网格行数 ${existingRows}`);
  }
  if (columnCount > Math.max(existingColumns, 1)) {
    violations.push(`覆盖列数 ${columnCount} 超出既有网格列数 ${Math.max(existingColumns, 1)}`);
  }
  if (dataRowCount > limits.maxRowsPerSheet) {
    violations.push(`覆盖数据行数 ${dataRowCount} 超过上限 ${limits.maxRowsPerSheet}`);
  }
  if (columnCount > limits.maxColumnsPerSheet) {
    violations.push(`列数 ${columnCount} 超过上限 ${limits.maxColumnsPerSheet}`);
  }
  return {
    allowed: violations.length === 0,
    violations,
    targetStartRow: 1,
    targetEndRow: dataRowCount,
    wouldOverwrite,
  };
}
