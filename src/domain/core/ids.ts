import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors';
import { isProjectRegion, REGION_PENDING_ADJUSTMENT } from '../../shared/project-fields';

// 区域枚举唯一来源为 src/shared/project-fields.ts（tasks 2.4/2.5：renderer、IPC 与
// 领域写边界共用同一枚举）；本模块仅在此透出，避免各自声明导致口径漂移。
export { PROJECT_REGIONS, REGION_PENDING_ADJUSTMENT } from '../../shared/project-fields';
export type { ProjectRegion } from '../../shared/project-fields';

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

/**
 * 项目区域 trim（既有兼容入口，TBD-12）：仅去除首尾空白，不做枚举校验。
 * 保留给读取/筛选等只读口径使用；项目写边界必须走 parseProjectRegion，
 * 不得漏校验（tasks 2.4）。
 */
export function normalizeRegion(raw: string): string {
  return raw.trim();
}

/**
 * 项目区域写边界校验（tasks 2.4）：去除首尾空白后，非空值必须为五个枚举之一，
 * 否则拒绝并给出用户可识别错误；空串/纯空白表示未填写（返回 ''，由调用方决定置空）。
 * 存量 legacy 文本在读取/报表层归入 REGION_PENDING_ADJUSTMENT 分组，此处不做猜测映射。
 */
export function parseProjectRegion(raw: string, fieldName = '区域'): string {
  const trimmed = normalizeRegion(raw);
  if (trimmed !== '' && !isProjectRegion(trimmed)) {
    throw new ValidationError(
      'INVALID_PROJECT_REGION',
      `${fieldName}仅允许 East、South、West、Central、North 五个固定选项`,
    );
  }
  return trimmed;
}

/**
 * 区域分组键（读取/报表消费口径）：空 → ''（无区域分组）；
 * 五个枚举 → 规范化原值；存量非空非枚举文本 → REGION_PENDING_ADJUSTMENT。
 */
export function regionGroupKey(raw: string | null | undefined): string {
  const trimmed = normalizeRegion(raw ?? '');
  if (trimmed === '') return '';
  return isProjectRegion(trimmed) ? trimmed : REGION_PENDING_ADJUSTMENT;
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
