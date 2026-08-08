import { randomUUID } from 'node:crypto';
import type { AppendRowInput, ImportCategory } from './workspace/workspace-model';
import { findFieldByTarget, fieldCatalogFor, type TargetFieldDef } from './field-catalog';
import { normalizeDateValue, tryNormalizeMoneyToCentsString, type ExcelDateSystem } from './excel-date';

/**
 * 文件与粘贴共用的统一规范化行模型（design D21 / tasks 8.23）。
 *
 * - 文件与粘贴进入同一 NormalizedRow 结构、同一目标字段映射与同一空值规则；
 * - ECC、服务单号、Account ID、序列号始终按文本处理（前导零保留，不转数值）；
 * - 金额规范化为两位小数字符串（分整数，无精度损失）；日期按 1900/1904 与
 *   本机业务时区确定性转换；
 * - 稳定行身份：业务键 → 模板 source_row_id → 物理位置兜底（并标记身份风险）；
 * - 规范化行不含 source 的物理细节差异，保证文件与粘贴语义等价时产生同一计划摘要。
 */

export interface NormalizedRow {
  category: ImportCategory;
  /** 稳定行身份（业务键 / source_row_id / 物理位置兜底）。 */
  rowId: string;
  /** 模板提供的稳定源行 ID（source_row_id 列）。 */
  sourceRowId: string | null;
  /** 业务键（ECC / 服务单号 / Account ID / 序列号）。 */
  businessKey: string | null;
  sourceKind: 'file' | 'paste';
  sourceFile: string | null;
  sourceSheet: string | null;
  /** 文件：Excel 物理行号；粘贴：矩形内行序（含表头偏移）。 */
  sourceRow: number | null;
  pasteBatch: string | null;
  /** 目标字段（field.field）→ 规范化值（null=空）。 */
  cells: Record<string, string | null>;
  /** 行身份回退到物理位置（重排行会改变其身份，需在最终确认前提示）。 */
  positionOnlyIdentity: boolean;
}

/** 各类别业务键字段（优先级顺序：取首个非空值）。 */
export const CATEGORY_BUSINESS_KEY_FIELDS: Record<ImportCategory, readonly string[]> = {
  project: ['contract.ecc'],
  service_order: ['service_order.service_order_no'],
  invoice: ['invoice.ecc'],
  logistics_fee: ['logistics_fee.ecc'],
  serial_address_update: ['serial_address_update.serial_no'],
  qr_request: [],
  ship_to_request: ['ship_to_request.account_id'],
};

/**
 * 稳定行身份：业务键 → source_row_id → 物理位置兜底。
 * 返回 { identity, positionOnly }。
 */
export function stableRowIdentity(row: NormalizedRow): { identity: string; positionOnly: boolean } {
  if (row.businessKey !== null && row.businessKey !== '') {
    return { identity: `bk:${row.businessKey}`, positionOnly: false };
  }
  if (row.sourceRowId !== null && row.sourceRowId !== '') {
    return { identity: `sid:${row.sourceRowId}`, positionOnly: false };
  }
  const location = row.sourceKind === 'file' ? row.sourceFile : `paste:${row.pasteBatch ?? '?'}`;
  return {
    identity: `pos:${location}:${row.sourceSheet ?? '-'}:${row.sourceRow ?? 0}`,
    positionOnly: true,
  };
}

/** 规范化单个单元格：空值规则 + 类型规则（标识符前导零保留、金额/日期确定性转换）。 */
export function normalizeCellValue(field: TargetFieldDef, raw: string | null, dateSystem: ExcelDateSystem): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  switch (field.type) {
    case 'money': {
      const canonical = tryNormalizeMoneyToCentsString(trimmed);
      // 合法金额规范化；非法值保留原文由校验阶段定位金额错误，不猜测。
      return canonical ?? trimmed;
    }
    case 'date':
    case 'datetime': {
      const semantics = field.dateSemantics ?? (field.type === 'date' ? 'date' : 'datetime');
      const canonical = normalizeDateValue(trimmed, dateSystem, semantics);
      return canonical ?? trimmed;
    }
    default:
      // text / number：trim 后原样保留（标识符不转数值，前导零不丢失）。
      return trimmed;
  }
}

/** 按目标字段目录规范化「已按 target field 键控」的原始单元格。 */
export function normalizeCellsForCategory(
  category: ImportCategory,
  mappedRaw: Record<string, string | null>,
  dateSystem: ExcelDateSystem,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of fieldCatalogFor(category)) {
    const raw = mappedRaw[field.field] ?? null;
    out[field.field] = normalizeCellValue(field, raw, dateSystem);
  }
  return out;
}

/** 从已规范化的单元格中提取业务键（按类别优先级）。 */
export function businessKeyFromCells(category: ImportCategory, cells: Record<string, string | null>): string | null {
  for (const fieldName of CATEGORY_BUSINESS_KEY_FIELDS[category]) {
    const value = cells[fieldName];
    if (value !== null && value !== '') return value;
  }
  return null;
}

/** 查找某目标字段（供映射步骤校验别名目标存在）。 */
export function resolveField(category: ImportCategory, field: string): TargetFieldDef | undefined {
  return findFieldByTarget(category, field);
}

/**
 * 转工作区追加输入：rowId 使用随机内部 ID（工作区 PK 全局唯一），
 * 稳定行身份落入 business_key / source_row_id / 来源位置列。
 */
export function toAppendRowInput(row: NormalizedRow): AppendRowInput {
  const identity = stableRowIdentity(row);
  return {
    rowId: randomUUID(),
    businessKey: row.businessKey,
    sourceRowId: row.sourceRowId,
    sourceFile: row.sourceFile,
    sourceSheet: row.sourceSheet,
    sourceRow: row.sourceRow,
    pasteBatch: row.pasteBatch,
    cells: row.cells,
    // 物理位置兜底身份写入 businessKey，使身份可查询（并标记 positionOnly）。
    ...(identity.positionOnly ? { businessKey: identity.identity } : {}),
  };
}
