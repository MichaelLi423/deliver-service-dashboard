import { MAPPING_V1, fieldByTarget, type MigrationMapping } from './mapping';

/**
 * 源数据模型（tasks 8.3 业务键与源行键识别）。
 *
 * 每行源记录以「源文件 + sheet + 行号」为源行键，用于幂等与冲突处理；
 * 业务键（ECC、服务单号、Account ID、序列号）用于子记录识别与聚合：
 * - ECC 为项目/合同聚合主键：同一 ECC 下一个合同的全部执行数据聚合为一个搬迁项目（TBD-18）；
 * - 服务单号、Account ID、序列号用于子记录识别与冲突处理，不与 ECC 同级匹配项目。
 */

/** 源 Excel 单行记录。 */
export interface SourceRow {
  /** 源文件名（如 合同信息表.xlsx）。 */
  file: string;
  /** sheet 名。 */
  sheet: string;
  /** Excel 物理行号（1 起，表头行不计入数据，但行号指原始 Excel 行号）。 */
  rowNumber: number;
  /** 列名 → 单元格值（缺失列为 null）。 */
  cells: Record<string, string | null>;
}

/** 源行键：源文件 + sheet + 行号。 */
export function sourceRowKey(row: Pick<SourceRow, 'file' | 'sheet' | 'rowNumber'>): string {
  return `${row.file}#${row.sheet}#${row.rowNumber}`;
}

/** 幂等键：源行键 + 业务键（8.7「（源文件、sheet、行号）+业务键」）。 */
export function idempotencyKey(row: SourceRow, businessKey: string | null): string {
  return businessKey ? `${sourceRowKey(row)}|${businessKey}` : sourceRowKey(row);
}

/**
 * 单元格取值：去首尾空白；空串 / 全空白视为 null。
 */
export function cellValue(row: SourceRow, column: string): string | null {
  const raw = row.cells[column];
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** 取映射字段在给定源行上的高优先级来源值（含列别名；来源优先级升序，取首个非空）。 */
export function mappedValue(
  row: SourceRow,
  target: string,
  mapping: MigrationMapping = MAPPING_V1,
): string | null {
  const field = fieldByTarget(mapping, target);
  if (!field) return null;
  const sorted = [...field.sources].sort((a, b) => a.priority - b.priority);
  for (const ref of sorted) {
    const candidates = [ref.column, ...(ref.aliases ?? [])];
    for (const column of candidates) {
      const value = cellValue(row, column);
      if (value !== null) return value;
    }
  }
  return null;
}

/** 收集映射字段在某一行上的全部来源值（含别名，供多来源冲突判断）。 */
export function collectMappedValues(
  row: SourceRow,
  target: string,
  mapping: MigrationMapping = MAPPING_V1,
): string[] {
  const field = fieldByTarget(mapping, target);
  if (!field) return [];
  const values: string[] = [];
  for (const ref of field.sources) {
    const candidates = [ref.column, ...(ref.aliases ?? [])];
    for (const column of candidates) {
      const value = cellValue(row, column);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

/** 提取业务键：按目标字段映射读取（ECC 聚合主键等）。 */
export function businessKeyOf(
  row: SourceRow,
  targets: readonly string[],
  mapping: MigrationMapping = MAPPING_V1,
): string | null {
  for (const target of targets) {
    const value = mappedValue(row, target, mapping);
    if (value !== null) return value;
  }
  return null;
}
