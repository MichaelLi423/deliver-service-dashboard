import { createHash } from 'node:crypto';
import type { NormalizedRow } from './normalized-row';
import { stableRowIdentity } from './normalized-row';

/**
 * 原始输入摘要与规范化计划摘要（design D21 / tasks 8.25）。
 *
 * - 原始输入摘要：文件按字节、粘贴按规范化矩形文本；绑定具体输入来源；
 * - 稳定源行身份：业务键 → source_row_id → 物理位置兜底（兜底时重排行会改变身份）；
 * - 规范化计划摘要：对七类规范化记录做稳定排序后计算，排除文件/粘贴物理差异
 *   （sourceKind、文件名、sheet、物理行、pasteBatch），使相同语义的文件与粘贴、
 *   不同物理顺序得到同一计划摘要；计划摘要用于幂等重跑与 validation seal。
 */

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 原始输入摘要：文件 = 字节摘要；粘贴 = 规范化矩形文本摘要。 */
export function rawInputDigest(input: Buffer | string, _kind: 'file' | 'paste'): string {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return sha256Hex(data);
}

/** 规范化粘贴矩形的规范文本（供原始摘要与日志脱敏复用；不含任何业务值校验）。 */
export function canonicalPasteText(rows: readonly string[][]): string {
  return rows.map((r) => r.join('\t')).join('\n');
}

/** 单个规范化行的规范序列化（不含来源物理细节；行身份 + 类别 + 排序单元格）。 */
export function canonicalNormalizedRow(row: NormalizedRow): string {
  const { identity } = stableRowIdentity(row);
  const cellKeys = Object.keys(row.cells).sort();
  const cells = cellKeys.map((k) => `${k}=${row.cells[k] ?? ''}`).join('|');
  return JSON.stringify({ category: row.category, identity, cells });
}

/** 单个规范化行的稳定哈希（用于大规模计划的增量摘要）。 */
export function normalizedRowHash(row: NormalizedRow): string {
  return sha256Hex(canonicalNormalizedRow(row));
}

/**
 * 规范化计划摘要：对每行哈希做稳定排序后整体摘要。
 * 相同语义内容（不同输入顺序 / 文件 vs 粘贴）得到同一摘要。
 */
export function planDigestFromRowHashes(rowHashes: readonly string[]): string {
  const canonical = [...rowHashes].sort().join('\n');
  return sha256Hex(canonical);
}

/** 由规范化行集合直接计算计划摘要（测试与对照使用）。 */
export function planDigestFromRows(rows: readonly NormalizedRow[]): string {
  return planDigestFromRowHashes(rows.map((r) => normalizedRowHash(r)));
}

/** 稳定源行身份（供幂等键与提示展示）。 */
export function sourceIdentityOf(row: NormalizedRow): string {
  return stableRowIdentity(row).identity;
}

/** 行身份是否回退到物理位置（最终确认前需提示重排行风险）。 */
export function hasPositionOnlyIdentity(row: NormalizedRow): boolean {
  return stableRowIdentity(row).positionOnly;
}
