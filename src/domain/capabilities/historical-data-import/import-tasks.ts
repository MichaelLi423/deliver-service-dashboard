import type { AppendRowInput, ImportCategory } from './workspace/workspace-model';
import { IMPORT_CATEGORIES } from './workspace/workspace-model';
import {
  DEFAULT_XLSX_PREFLIGHT_LIMITS,
  XlsxPreflightError,
  preflightXlsx,
  type XlsxPreflightLimits,
  type XlsxPreflightResult,
} from './zip-preflight';
import { readTemplateVersionFromBuffer, categoryByTemplateSheet, SOURCE_ROW_ID_COLUMN, TEMPLATE_INSTRUCTIONS_SHEET } from './template';
import { recognizeLegacySheet, type ColumnRecognition, type SheetRecognition } from './legacy-sources';
import type { ExcelDateSystem } from './excel-date';
import {
  assertNotAborted,
  inspectFormula,
  rawCellToFieldString,
  readWorkbookGrid,
  ReadAbortedError,
  type RawSheetGrid,
} from './excel-source';
import {
  businessKeyFromCells,
  normalizeCellsForCategory,
  normalizeCellValue,
  toAppendRowInput,
  type NormalizedRow,
} from './normalized-row';
import { fieldCatalogFor, findFieldByHeader } from './field-catalog';
import { normalizedRowHash, planDigestFromRowHashes, rawInputDigest } from './digest';
import { parsePasteText, confirmFirstRowAsHeader, preflightPasteOverlay, type PasteOverlayVerdict } from './paste-parser';

/**
 * 文件 / 粘贴统一规范化任务（design D21/D23 / tasks 8.20、8.22、8.23、8.25）。
 *
 * - runImportFileTask：有界 ZIP 预检 → 模板/旧五源识别 → 可中止 exceljs 读取 →
 *   逐 sheet 规范化 → 分块写入工作区，持续报告阶段与行数；
 * - runImportPasteTask：矩形粘贴解析 → 表头确认 → 覆盖预检 → 分块写入工作区；
 * - 两者共用同一规范化行模型、目标字段映射与空值规则（文件/粘贴等价）；
 * - 取消抛 ImportCancelledError，不形成部分草稿合并：已写入的块保留在
 *   最后一次已保存修订，运行态重启恢复回到最后稳定草稿修订（workspace 8.11）。
 *
 * 本模块不依赖具体线程实现：任务函数可测试，由主进程决定是否在线程内执行
 * （tasks 8.20「工作线程或可测试的 worker 任务」）。真实工作线程执行见
 * `./import-worker/import-worker-host.ts`（主进程宿主 + 可注入 worker 工厂）：
 * worker 内完成读取与规范化，主进程接收 progress / chunk 分块写入工作区。
 */

/** 工作区分块写入端口（由 WorkspaceRepository 适配或测试注入）。 */
export interface ChunkWritePort {
  /** 追加规范化行，返回新草稿修订号；worker 内实现为异步往返（发块回主进程后等待回执）。 */
  append(draftId: string, expectedRevision: number, category: ImportCategory, rows: AppendRowInput[]): number | Promise<number>;
}

export class ImportCancelledError extends Error {
  constructor(message = '导入任务已取消') {
    super(message);
    this.name = 'ImportCancelledError';
  }
}

export class PasteOverlayError extends Error {
  constructor(
    readonly verdict: PasteOverlayVerdict,
    message = '粘贴未通过覆盖预检，未写入任何行',
  ) {
    super(message);
    this.name = 'PasteOverlayError';
  }
}

export type NormalizationIssueCode =
  | 'UNKNOWN_SHEET'
  | 'UNKNOWN_COLUMN'
  | 'FORMULA_NO_CACHED_VALUE'
  | 'DDE_FORMULA'
  | 'EXTERNAL_REFERENCE'
  | 'UNSUPPORTED_TEMPLATE_VERSION';

export interface NormalizationIssue {
  code: NormalizationIssueCode;
  sheet: string | null;
  sourceRow: number | null;
  sourceColumn: string | null;
  message: string;
}

export interface SheetReadResult {
  sheet: string;
  category: ImportCategory | null;
  /** 模板/旧五源识别状态；'ignored'/'supplier' 为明确排除。 */
  role: SheetRecognition['role'] | 'template';
  header: string[] | null;
  columnMapping: ColumnRecognition[];
  dataRowCount: number;
  unknownColumns: string[];
}

export type ImportTaskStage = 'preflight' | 'reading' | 'writing' | 'done';

export interface ImportProgress {
  stage: ImportTaskStage;
  sheet?: string;
  currentRows: number;
  totalRows: number | null;
}

export interface ImportFileTaskParams {
  draftId: string;
  /** 开始前的草稿修订（首个分块写入使用；成功后返回新修订）。 */
  expectedRevision: number;
  buffer: Buffer;
  fileName: string;
  limits?: XlsxPreflightLimits;
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
  chunkSize?: number;
  writer: ChunkWritePort;
}

export interface ImportFileTaskResult {
  newRevision: number;
  preflight: XlsxPreflightResult;
  dateSystem: ExcelDateSystem;
  templateMode: boolean;
  templateVersionSupported: boolean;
  sheets: SheetReadResult[];
  fileRows: number;
  normalizedRows: number;
  categories: Partial<Record<ImportCategory, number>>;
  issues: NormalizationIssue[];
  rawDigest: string;
  planDigest: string;
}

export interface ImportPasteTaskParams {
  draftId: string;
  expectedRevision: number;
  category: ImportCategory;
  text: string;
  /** 首行是否为表头（由用户确认）。 */
  headerConfirmed: boolean;
  /** true=追加到类别末尾；false=覆盖既有行范围。 */
  append: boolean;
  existingRows: number;
  existingColumns: number;
  dateSystem?: ExcelDateSystem;
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
  chunkSize?: number;
  writer: ChunkWritePort;
}

export interface ImportPasteTaskResult {
  newRevision: number;
  pasteBatch: string;
  columnMapping: ColumnRecognition[];
  overlay: PasteOverlayVerdict;
  width: number;
  header: string[];
  rowCount: number;
  normalizedRows: number;
  issues: NormalizationIssue[];
  rawDigest: string;
  planDigest: string;
}

/** 表头（trim 后）→ 目标字段映射；source_row_id 列特殊处理为稳定源行 ID。
 *  返回的 recs 与 header 逐列对齐（含 source_row_id 占位与空表头占位），
 *  保证数据行按列索引取值时不错位。 */
function mapHeaderToFields(
  category: ImportCategory,
  header: readonly string[],
): { recs: ColumnRecognition[]; sourceRowIdColumn: number } {
  let sourceRowIdColumn = -1;
  const recs: ColumnRecognition[] = [];
  for (let i = 0; i < header.length; i += 1) {
    const key = header[i].trim();
    if (key === '') {
      recs.push({ sourceColumn: '', targetField: null, state: 'pending' });
      continue;
    }
    if (key === SOURCE_ROW_ID_COLUMN) {
      sourceRowIdColumn = i;
      recs.push({ sourceColumn: SOURCE_ROW_ID_COLUMN, targetField: null, state: 'ignored' });
      continue;
    }
    const field = findFieldByHeader(category, key);
    if (field === undefined) {
      recs.push({ sourceColumn: key, targetField: null, state: 'pending' });
    } else {
      recs.push({
        sourceColumn: key,
        targetField: field.field,
        state: field.label === key || field.field === key ? 'exact' : 'alias',
      });
    }
  }
  return { recs, sourceRowIdColumn };
}

function emptyCategories(): Partial<Record<ImportCategory, number>> {
  const counts: Partial<Record<ImportCategory, number>> = {};
  for (const c of IMPORT_CATEGORIES) counts[c] = 0;
  return counts;
}

/**
 * 文件导入任务：预检 → 识别 → 可中止读取 → 分块规范化写入。
 * 取消时抛 ImportCancelledError，已写入块保持在最后一次已保存修订。
 */
export async function runImportFileTask(params: ImportFileTaskParams): Promise<ImportFileTaskResult> {
  try {
    return await runImportFileTaskInner(params);
  } catch (err) {
    if (err instanceof ReadAbortedError) throw new ImportCancelledError();
    throw err;
  }
}

async function runImportFileTaskInner(params: ImportFileTaskParams): Promise<ImportFileTaskResult> {
  const limits = params.limits ?? DEFAULT_XLSX_PREFLIGHT_LIMITS;
  const signal = params.signal;
  const chunkSize = params.chunkSize ?? 500;
  const report = params.onProgress ?? ((): void => undefined);

  report({ stage: 'preflight', currentRows: 0, totalRows: null });
  const preflight = await preflightXlsx(params.buffer, limits);
  if (!preflight.ok) {
    throw new XlsxPreflightError(preflight);
  }
  assertNotAborted(signal);

  const rawDigest = rawInputDigest(params.buffer, 'file');

  const templateInfo = await readTemplateVersionFromBuffer(params.buffer);
  const templateMode = templateInfo.version !== null;
  const templateVersionSupported = templateInfo.supported;
  if (templateMode && !templateVersionSupported) {
    // 旧版本模板：仍按模板结构读取，但记录版本不支持问题（由向导决定是否继续）。
    assertNotAborted(signal);
  }

  report({ stage: 'reading', currentRows: 0, totalRows: null });
  const { sheets, date1904 } = await readWorkbookGrid(params.buffer, { signal });
  const dateSystem: ExcelDateSystem = date1904 ? '1904' : '1900';

  let revision = params.expectedRevision;
  let normalizedRows = 0;
  let fileRows = 0;
  const categories = emptyCategories();
  const rowHashes: string[] = [];
  const issues: NormalizationIssue[] = [];
  const sheetResults: SheetReadResult[] = [];

  for (const sheet of sheets) {
    assertNotAborted(signal);
    if (sheet.name === TEMPLATE_INSTRUCTIONS_SHEET) continue; // 填写说明 sheet 不产生数据

    // ---- sheet 路由（模板精确 / 旧五源冻结 / 未知 → 待人工映射或排除） ----
    let category: ImportCategory | null;
    let role: SheetRecognition['role'] | 'template';
    if (templateMode) {
      category = categoryByTemplateSheet(sheet.name) ?? null;
      role = 'template';
      if (category === null) {
        issues.push({
          code: 'UNKNOWN_SHEET',
          sheet: sheet.name,
          sourceRow: null,
          sourceColumn: null,
          message: `模板工作簿存在未配置的 sheet「${sheet.name}」，待人工映射或明确排除，不猜测映射`,
        });
      }
    } else {
      const rec = recognizeLegacySheet(params.fileName, sheet.name);
      role = rec.role;
      if (rec.role === 'ignored' || rec.role === 'supplier') {
        continue; // 明确忽略/参考来源，不产生记录与问题
      }
      category = rec.category;
      if (rec.state === 'unknown' || rec.role === 'unmappable' || category === null) {
        issues.push({
          code: 'UNKNOWN_SHEET',
          sheet: sheet.name,
          sourceRow: null,
          sourceColumn: null,
          message: `旧来源文件「${params.fileName}」的 sheet「${sheet.name}」未配置冻结映射，待人工映射或排除`,
        });
      }
    }

    // ---- 表头（首个非空行）与列映射 ----
    const headerRowIndex = findHeaderRowIndex(sheet);
    const header = headerRowIndex === -1 ? [] : sheet.rows[headerRowIndex].map(cellToHeaderText);
    let columnMapping: ColumnRecognition[] = [];
    let sourceRowIdColumn = -1;
    const unknownColumns: string[] = [];
    if (category !== null && header.length > 0) {
      const mapped = mapHeaderToFields(category, header);
      columnMapping = mapped.recs;
      sourceRowIdColumn = mapped.sourceRowIdColumn;
      for (let i = 0; i < columnMapping.length; i += 1) {
        const rec = columnMapping[i];
        if (i === sourceRowIdColumn) continue; // source_row_id 列不构成未知列
        if (rec.sourceColumn !== '' && (rec.state === 'pending' || rec.state === 'ignored')) {
          unknownColumns.push(rec.sourceColumn);
          issues.push({
            code: 'UNKNOWN_COLUMN',
            sheet: sheet.name,
            sourceRow: null,
            sourceColumn: rec.sourceColumn,
            message: `sheet「${sheet.name}」的列「${rec.sourceColumn}」未配置目标字段映射，待人工映射或排除`,
          });
        }
      }
    }

    // ---- 数据行规范化 + 分块写入 ----
    const fields = category === null ? [] : fieldCatalogFor(category);
    const pending: AppendRowInput[] = [];
    let dataRowCount = 0;
    let currentRows = 0;
    if (category !== null) {
      for (let r = headerRowIndex + 1; r < sheet.rows.length; r += 1) {
        if (r % 200 === 0) assertNotAborted(signal);
        const rowCells = sheet.rows[r];
        const mappedRaw: Record<string, string | null> = {};
        let nonEmpty = 0;
        for (let c = 0; c < columnMapping.length; c += 1) {
          const rec = columnMapping[c];
          if (rec.targetField === null) continue;
          const raw = rowCells[c] ?? { kind: 'empty' as const };
          const field = fields.find((f) => f.field === rec.targetField);
          if (field === undefined) continue;
          // 公式单元格安全：DDE / 外部引用 / 无缓存值 → 问题 + 置空（不读取不可信内容）。
          if (raw.kind === 'formula') {
            const safety = inspectFormula(raw.formula);
            if (safety.dde) {
              issues.push({
                code: 'DDE_FORMULA',
                sheet: sheet.name,
                sourceRow: r,
                sourceColumn: rec.sourceColumn,
                message: `sheet「${sheet.name}」第 ${r} 行单元格含 DDE 公式，不可安全读取，已置空`,
              });
              continue;
            }
            if (safety.externalReference) {
              issues.push({
                code: 'EXTERNAL_REFERENCE',
                sheet: sheet.name,
                sourceRow: r,
                sourceColumn: rec.sourceColumn,
                message: `sheet「${sheet.name}」第 ${r} 行单元格引用外部工作簿，不可联网解析，已置空`,
              });
              continue;
            }
            if (raw.cached === null) {
              issues.push({
                code: 'FORMULA_NO_CACHED_VALUE',
                sheet: sheet.name,
                sourceRow: r,
                sourceColumn: rec.sourceColumn,
                message: `sheet「${sheet.name}」第 ${r} 行公式无可信静态缓存值，目标字段置空并报错`,
              });
              continue;
            }
          }
          const text = rawCellToFieldString(raw, field.dateSemantics ?? (field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime' : null), dateSystem);
          if (text !== null && text !== '') nonEmpty += 1;
          mappedRaw[rec.targetField] = text;
        }
        if (nonEmpty === 0) continue; // 空白行跳过
        dataRowCount += 1;
        fileRows += 1;

        const cells = normalizeCellsForCategory(category, mappedRaw, dateSystem);
        const sourceRowId = sourceRowIdColumn >= 0 ? trimToNull(cellToHeaderText(rowCells[sourceRowIdColumn] ?? { kind: 'empty' })) : null;
        const businessKey = businessKeyFromCells(category, cells);
        const normalized: NormalizedRow = {
          category,
          rowId: businessKey ?? sourceRowId ?? `${params.fileName}#${sheet.name}#${r}`,
          sourceRowId,
          businessKey,
          sourceKind: 'file',
          sourceFile: params.fileName,
          sourceSheet: sheet.name,
          sourceRow: r,
          pasteBatch: null,
          cells,
          positionOnlyIdentity: businessKey === null && sourceRowId === null,
        };
        rowHashes.push(normalizedRowHash(normalized));
        pending.push(toAppendRowInput(normalized));

        if (pending.length >= chunkSize) {
          revision = await flush(revision, params, category, pending, report, sheet.name, fileRows, signal);
          normalizedRows += pending.length;
          currentRows += pending.length;
          pending.length = 0;
        }
      }
      if (pending.length > 0) {
        revision = await flush(revision, params, category, pending, report, sheet.name, fileRows, signal);
        normalizedRows += pending.length;
        currentRows += pending.length;
      }
      categories[category] = (categories[category] ?? 0) + dataRowCount;
    }

    sheetResults.push({
      sheet: sheet.name,
      category,
      role,
      header: header.length > 0 ? header : null,
      columnMapping,
      dataRowCount,
      unknownColumns,
    });
    report({ stage: 'writing', sheet: sheet.name, currentRows, totalRows: null });
  }

  report({ stage: 'done', currentRows: normalizedRows, totalRows: normalizedRows });
  return {
    newRevision: revision,
    preflight,
    dateSystem,
    templateMode,
    templateVersionSupported,
    sheets: sheetResults,
    fileRows,
    normalizedRows,
    categories,
    issues,
    rawDigest,
    planDigest: planDigestFromRowHashes(rowHashes),
  };
}

/** 粘贴任务：矩形解析 → 表头确认 → 覆盖预检 → 分块规范化写入。 */
export async function runImportPasteTask(params: ImportPasteTaskParams): Promise<ImportPasteTaskResult> {
  try {
    return await runImportPasteTaskInner(params);
  } catch (err) {
    if (err instanceof ReadAbortedError) throw new ImportCancelledError();
    throw err;
  }
}

async function runImportPasteTaskInner(params: ImportPasteTaskParams): Promise<ImportPasteTaskResult> {
  const signal = params.signal;
  const chunkSize = params.chunkSize ?? 500;
  const report = params.onProgress ?? ((): void => undefined);
  const dateSystem: ExcelDateSystem = params.dateSystem ?? '1900';

  const parsed = parsePasteText(params.text);
  const withHeader = confirmFirstRowAsHeader(parsed, params.headerConfirmed);
  const columnCount = parsed.width;

  const verdict = preflightPasteOverlay({
    append: params.append,
    existingRows: params.existingRows,
    existingColumns: params.existingColumns,
    dataRowCount: withHeader.rowCount,
    columnCount,
    limits: {
      maxRowsPerSheet: 500_000,
      maxColumnsPerSheet: 200,
      maxCellsPerSheet: 20_000_000,
    },
  });
  if (!verdict.allowed) {
    throw new PasteOverlayError(verdict);
  }
  assertNotAborted(signal);

  const pasteBatch = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const header = withHeader.header.map((h) => h.trim());
  const mapped = mapHeaderToFields(params.category, header);
  const issues: NormalizationIssue[] = [];
  for (let i = 0; i < mapped.recs.length; i += 1) {
    const rec = mapped.recs[i];
    if (i === mapped.sourceRowIdColumn) continue;
    if (rec.sourceColumn !== '' && (rec.state === 'pending' || rec.state === 'ignored')) {
      issues.push({
        code: 'UNKNOWN_COLUMN',
        sheet: null,
        sourceRow: null,
        sourceColumn: rec.sourceColumn,
        message: `粘贴表头列「${rec.sourceColumn}」未配置目标字段映射，待人工映射或排除`,
      });
    }
  }

  const fields = fieldCatalogFor(params.category);
  const rowHashes: string[] = [];
  const pending: AppendRowInput[] = [];
  let revision = params.expectedRevision;
  let normalizedRows = 0;
  const sourceRowIdColumn = mapped.sourceRowIdColumn;

  for (let i = 0; i < withHeader.dataRows.length; i += 1) {
    assertNotAborted(signal);
    const rowCells = withHeader.dataRows[i];
    const gridRow = params.headerConfirmed ? i + 2 : i + 1; // 表头行占第 1 行
    const mappedRaw: Record<string, string | null> = {};
    let nonEmpty = 0;
    for (let c = 0; c < mapped.recs.length; c += 1) {
      const rec = mapped.recs[c];
      if (rec.targetField === null) continue;
      const field = fields.find((f) => f.field === rec.targetField);
      if (field === undefined) continue;
      const raw = rowCells[c] ?? '';
      const text = normalizeCellValue(field, raw, dateSystem);
      if (text !== null && text !== '') nonEmpty += 1;
      mappedRaw[rec.targetField] = text;
    }
    if (nonEmpty === 0) continue;
    const cells = normalizeCellsForCategory(params.category, mappedRaw, dateSystem);
    const sourceRowId = sourceRowIdColumn >= 0 ? trimToNull(rowCells[sourceRowIdColumn] ?? '') : null;
    const businessKey = businessKeyFromCells(params.category, cells);
    const normalized: NormalizedRow = {
      category: params.category,
      rowId: businessKey ?? sourceRowId ?? `paste:${pasteBatch}#${gridRow}`,
      sourceRowId,
      businessKey,
      sourceKind: 'paste',
      sourceFile: null,
      sourceSheet: null,
      sourceRow: gridRow,
      pasteBatch,
      cells,
      positionOnlyIdentity: businessKey === null && sourceRowId === null,
    };
    rowHashes.push(normalizedRowHash(normalized));
    pending.push(toAppendRowInput(normalized));
    if (pending.length >= chunkSize) {
      assertNotAborted(signal);
      revision = await params.writer.append(params.draftId, revision, params.category, pending);
      normalizedRows += pending.length;
      pending.length = 0;
      report({ stage: 'writing', currentRows: normalizedRows, totalRows: withHeader.rowCount });
    }
  }
  if (pending.length > 0) {
    assertNotAborted(signal);
    revision = await params.writer.append(params.draftId, revision, params.category, pending);
    normalizedRows += pending.length;
  }
  report({ stage: 'done', currentRows: normalizedRows, totalRows: withHeader.rowCount });

  return {
    newRevision: revision,
    pasteBatch,
    columnMapping: mapped.recs,
    overlay: verdict,
    width: columnCount,
    header,
    rowCount: withHeader.rowCount,
    normalizedRows,
    issues,
    rawDigest: rawInputDigest(canonicalPasteText(parsed.rows), 'paste'),
    planDigest: planDigestFromRowHashes(rowHashes),
  };
}

function canonicalPasteText(rows: readonly string[][]): string {
  return rows.map((r) => r.join('\t')).join('\n');
}

/** 分块写入：取消检查 → 调用 writer 推进修订号，并报告进度（worker 内为异步往返）。 */
async function flush(
  revision: number,
  params: ImportFileTaskParams,
  category: ImportCategory,
  pending: AppendRowInput[],
  report: (p: ImportProgress) => void,
  sheet: string,
  currentRows: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  assertNotAborted(signal);
  const next = await params.writer.append(params.draftId, revision, category, pending);
  report({ stage: 'writing', sheet, currentRows, totalRows: null });
  return next;
}

/** 找到首个非空行（表头）。 */
function findHeaderRowIndex(sheet: RawSheetGrid): number {
  for (let r = 0; r < sheet.rows.length; r += 1) {
    const cells = sheet.rows[r];
    if (cells.some((c) => c.kind !== 'empty')) return r;
  }
  return -1;
}

function cellToHeaderText(raw: { kind: string; value?: string | number | boolean | Date }): string {
  if (raw.kind === 'empty') return '';
  if (raw.kind === 'text' && typeof raw.value === 'string') return raw.value;
  if (raw.kind === 'number' && typeof raw.value === 'number') return String(raw.value);
  if (raw.kind === 'boolean' && typeof raw.value === 'boolean') return raw.value ? 'TRUE' : 'FALSE';
  return '';
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 校验读取是否因取消中断（供任务调用方判定是否可恢复）。 */
export function isImportCancelled(err: unknown): boolean {
  return err instanceof ImportCancelledError || err instanceof ReadAbortedError;
}
