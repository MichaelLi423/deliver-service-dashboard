import { ValidationError } from './errors';

/**
 * 时间表示（tasks 0.2 决策：带偏移 ISO 时间 / 业务日期）。
 *
 * - 业务时间：业务事件实际发生时间（用户录入/源数据/推导），带时区偏移的 ISO 字符串。
 * - 审计时间：系统记录该事实的时间，与业务时间分开保存（tasks 1.5）。
 * - 业务日期：由业务时间在本地口径下推导出的 yyyy-mm-dd，用于按月归属统计。
 * - Clock 可注入，便于测试固定时间（备份轮转、恢复等按日期/时间的行为）。
 */

/** 带偏移 ISO 时间，如 "2026-08-07T10:30:00+08:00"。 */
export type IsoDateTime = string;

/** 业务日期，如 "2026-08-07"。 */
export type BusinessDate = string;

/** 月份键，如 "2026-08"。 */
export type MonthKey = string;

/** 可注入的时钟。 */
export interface Clock {
  /** 当前带偏移 ISO 时间。 */
  nowIso(): IsoDateTime;
  /** 当前业务日期（本地口径）。 */
  today(): BusinessDate;
}

/** 系统时钟：基于本机时间并携带本地时区偏移。 */
export class SystemClock implements Clock {
  nowIso(): IsoDateTime {
    return toIsoWithOffset(new Date());
  }

  today(): BusinessDate {
    return toBusinessDate(this.nowIso());
  }
}

/** 固定时钟：用于测试。 */
export class FixedClock implements Clock {
  constructor(private readonly iso: IsoDateTime) {}

  nowIso(): IsoDateTime {
    return this.iso;
  }

  today(): BusinessDate {
    return toBusinessDate(this.iso);
  }
}

/** 将 Date 转为带本地时区偏移的 ISO 时间。 */
export function toIsoWithOffset(date: Date): IsoDateTime {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = pad(Math.floor(absMin / 60));
  const mm = pad(absMin % 60);
  return `${base}${sign}${hh}:${mm}`;
}

/**
 * 由带偏移 ISO 时间推导业务日期：取字符串内的日历日期部分
 * （该时间已含本地偏移，其日期即本地口径的业务日期）。
 */
export function toBusinessDate(iso: IsoDateTime): BusinessDate {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) {
    throw new ValidationError('INVALID_ISO', `非法 ISO 时间: ${iso}`);
  }
  return iso.slice(0, 10);
}

/** 月份键：业务日期 → "yyyy-mm"。 */
export function toMonthKey(date: BusinessDate): MonthKey {
  return date.slice(0, 7);
}

/** 由 ISO 时间直接取月份键。 */
export function monthOfIso(iso: IsoDateTime): MonthKey {
  return toMonthKey(toBusinessDate(iso));
}

/** 校验 ISO 时间非空且格式合法（业务时间必填校验辅助）。 */
export function assertValidIso(iso: string | null | undefined, fieldName: string): void {
  if (iso === null || iso === undefined || iso === '') {
    throw new ValidationError('REQUIRED_FIELD', `${fieldName} 必填`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/.test(iso)) {
    throw new ValidationError('INVALID_ISO', `${fieldName} 格式非法: ${iso}`);
  }
}

/** 校验日期字段（合同起止日期等，yyyy-mm-dd）。 */
export function assertValidDateOnly(value: string | null | undefined, fieldName: string): void {
  if (value === null || value === undefined || value === '') {
    throw new ValidationError('REQUIRED_FIELD', `${fieldName} 必填`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('INVALID_DATE', `${fieldName} 格式非法: ${value}`);
  }
}
