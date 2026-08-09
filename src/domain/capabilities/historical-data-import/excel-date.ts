import { formatCents, parseDecimalToCents } from '../../core/money';
import { toIsoWithOffset } from '../../core/time';
import { normalizeBusinessDateText } from '../local-data-persistence/business-date';

/**
 * Excel 日期系统与金额的确定性转换（design D7/D21 / tasks 8.24）。
 *
 * - 1900 日期系统：serial 1 = 1900-01-01（1900-02-29 不存在，serial 60 视为非法）；
 * - 1904 日期系统：serial 0 = 1904-01-01；
 * - **业务时间统一视为业务日期（date 语义）**：接受 Excel serial、纯日期、
 *   带 Z/显式偏移 ISO、无偏移本地 datetime，一律输出 yyyy-mm-dd（design D30）；
 * - datetime 语义（审计等精确时间）仍按本机业务时区携带偏移输出 ISO；
 * - 金额：十进制字符串 → 分整数（BigInt，HALF_UP），再规范化为两位小数字符串；
 *   全程不使用二进制浮点。
 */

export type ExcelDateSystem = '1900' | '1904';
export type DateSemantics = 'date' | 'datetime';

const MS_PER_DAY = 86_400_000;
/** 1900 系统 epoch：1899-12-31（serial 1 = 1900-01-01）。 */
const EPOCH_1900 = Date.UTC(1899, 11, 31);
/** 1904 系统 epoch：1904-01-01（serial 0 = 1904-01-01）。 */
const EPOCH_1904 = Date.UTC(1904, 0, 1);

export const EXCEL_DATE_SYSTEMS: readonly ExcelDateSystem[] = ['1900', '1904'];

/**
 * Excel serial → Date（UTC 时点）。非法输入（NaN/负值/1900 系统的 serial 60）
 * 返回 null，调用方应把该单元格标记为日期错误而非猜测。
 *
 * 1900 系统修正：Excel 把 1900 年误判为闰年（幻影 1900-02-29），serial 61 起
 * 的日期实际日历比声明少 1 天；因此 serial > 60 时先减 1 再映射到真实日历。
 * serial 1 = 1900-01-01，serial 45292 = 2024-01-01。
 */
export function excelSerialToUtcDate(serial: number, dateSystem: ExcelDateSystem): Date | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  if (dateSystem === '1900') {
    if (serial === 60) return null; // 1900-02-29 不存在
    const adjusted = serial > 60 ? serial - 1 : serial;
    const ms = EPOCH_1900 + adjusted * MS_PER_DAY;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const ms = EPOCH_1904 + serial * MS_PER_DAY;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 把 UTC 时点按「业务本地墙钟」拆分为字段（本机业务时区确定性口径：
 * Excel serial 的墙钟字段即为业务本地时间，与 time.ts 的本地口径一致）。
 */
function utcPartsAsLocal(date: Date): { y: number; m: number; d: number; h: number; min: number; s: number } {
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    min: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

function localPartsToIso(parts: { y: number; m: number; d: number; h: number; min: number; s: number }): string {
  // 以本机时区构造 Date（墙钟字段即业务本地时间），再携带本机偏移输出。
  const local = new Date(parts.y, parts.m - 1, parts.d, parts.h, parts.min, parts.s);
  return toIsoWithOffset(local);
}

/** 由 UTC 时点按业务本地口径输出纯业务日期（yyyy-mm-dd）。 */
export function utcDateToBusinessDate(date: Date): string {
  const p = utcPartsAsLocal(date);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** 由 UTC 时点按业务本地口径输出带偏移 ISO 业务时间。 */
export function utcDateToIsoLocal(date: Date): string {
  return localPartsToIso(utcPartsAsLocal(date));
}

/** 由 Excel serial 按日期系统 + 语义确定性输出规范值；非法返回 null。 */
export function serializeExcelSerial(serial: number, dateSystem: ExcelDateSystem, semantics: DateSemantics): string | null {
  const date = excelSerialToUtcDate(serial, dateSystem);
  if (date === null) return null;
  return semantics === 'date' ? utcDateToBusinessDate(date) : utcDateToIsoLocal(date);
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 无偏移的本地墙钟文本：yyyy-m-d[ T]HH:mm[:ss]。 */
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const SERIAL_RE = /^\d+(\.\d+)?$/;

/**
 * 文本/数值单元格 → 规范日期值。
 *
 * date 语义（目标业务时间统一视为业务日期，design D30）：
 * - 纯日期 yyyy-mm-dd → 原样返回；
 * - 带 Z/显式偏移 ISO → 按冻结本机 IANA 时区转 yyyy-mm-dd；
 * - 无偏移本地墙钟文本 → 视为本地墙钟取日期部分；
 * - 纯数值 → 视为 Excel serial，按 dateSystem 转换；
 * - 其余 → null（调用方保留原文，由校验阶段报日期错误，不猜测）。
 *
 * datetime 语义（审计/精确时间）：原行为不变——已带偏移 ISO 原样返回、
 * 无偏移本地墙钟按本机业务时区携带偏移、纯日期拒绝。
 */
export function normalizeDateValue(
  value: string,
  dateSystem: ExcelDateSystem,
  semantics: DateSemantics,
): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (semantics === 'date') {
    const businessDate = normalizeBusinessDateText(trimmed);
    if (businessDate !== null) return businessDate;
    if (SERIAL_RE.test(trimmed)) {
      return serializeExcelSerial(Number(trimmed), dateSystem, 'date');
    }
    return null;
  }
  if (DATE_ONLY_RE.test(trimmed)) {
    return null;
  }
  if (ISO_DATETIME_RE.test(trimmed)) {
    return trimmed;
  }
  const local = LOCAL_DATETIME_RE.exec(trimmed);
  if (local !== null) {
    const y = Number(local[1]);
    const m = Number(local[2]);
    const d = Number(local[3]);
    const h = Number(local[4]);
    const min = Number(local[5]);
    const s = local[6] === undefined ? 0 : Number(local[6]);
    const date = new Date(y, m - 1, d, h, min, s);
    if (Number.isNaN(date.getTime())) return null;
    return toIsoWithOffset(date);
  }
  if (SERIAL_RE.test(trimmed)) {
    return serializeExcelSerial(Number(trimmed), dateSystem, 'datetime');
  }
  return null;
}

/**
 * 金额十进制字符串 → 两位小数字符串（分整数，HALF_UP，无精度损失）。
 * 空值返回 null；非法金额抛 MoneyParseError（校验阶段以金额错误定位）。
 */
export function normalizeMoneyToCentsString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return formatCents(parseDecimalToCents(trimmed));
}

/**
 * 尝试规范化金额；失败返回 null（由调用方保留原文，校验阶段报金额错误）。
 */
export function tryNormalizeMoneyToCentsString(value: string): string | null {
  try {
    return normalizeMoneyToCentsString(value);
  } catch {
    return null;
  }
}
