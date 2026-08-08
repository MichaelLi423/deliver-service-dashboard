import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors';

/**
 * 稳定内部 ID 与业务 ID 分离（design D1 / tasks 1.2）。
 *
 * - 内部 ID：创建时用 crypto.randomUUID() 生成、全局唯一、永不复用，作为全部引用与关联的键。
 * - 业务 ID：ECC、服务单号、Account ID、仪器序列号、客户名称等作为独立字段保存，
 *   各自具备可空与唯一性约束；本文档只提供分配/归一化/校验辅助，
 *   唯一性约束由持久层（SQLite 唯一索引/部分唯一索引）与领域服务共同落实。
 */

/** 分配一个稳定内部 ID（UUID v4，全局唯一、不复用）。 */
export function newInternalId(): string {
  return randomUUID();
}

/** 客户名称为客户唯一业务标识：去除首尾空白后使用（TBD-25 / D13）。 */
export function normalizeCustomerName(raw: string): string {
  return raw.trim();
}

/** 项目区域为手工文本：去除首尾空白后精确分组（TBD-12）。 */
export function normalizeRegion(raw: string): string {
  return raw.trim();
}

/** 非空业务 ID（ECC、服务单号、Account ID 等）去除首尾空白。 */
export function normalizeBusinessId(raw: string): string {
  return raw.trim();
}

/** 校验必填文本去除首尾空白后非空。 */
export function assertRequiredText(value: string | null | undefined, fieldName: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    throw new ValidationError('REQUIRED_FIELD', `${fieldName} 必填`);
  }
  return trimmed;
}

/**
 * 系统临时编号（待进单阶段使用，TBD-01）：`TP-YYYYMMDD-XXXX`。
 * 正式进单后补充唯一 ECC；临时编号保留，不作为项目/合同主键。
 */
export function newTempNumber(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  return `TP-${y}${m}${d}-${suffix}`;
}
