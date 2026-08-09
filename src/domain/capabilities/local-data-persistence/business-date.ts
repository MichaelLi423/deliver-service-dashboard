import type { BusinessDate } from '../../core/time';

/**
 * 业务日期（yyyy-mm-dd）统一语义（schema v13 业务日期化 / 导入业务时间 date 化）。
 *
 * 存量与导入中的目标业务日期字段统一收口为 yyyy-mm-dd，接受四种输入：
 * - 纯日期 yyyy-mm-dd → 原样保留；
 * - 带 Z / 显式偏移 ISO 时间 → 先按「冻结的本机 IANA 时区」换算为本地日历日；
 * - 无偏移 datetime（yyyy-m-d[ T]HH:mm[:ss]）→ 视为本地墙钟，取日期部分；
 * - Excel serial 由 excel-date 负责（本模块不处理数值）。
 *
 * 「冻结的本机 IANA 时区」：以执行机的本机时区（Windows 部署机上即本机 IANA 时区）
 * 为唯一换算口径，一次性换算并落库；结果一经写入即冻结，不再随环境/运行变化。
 * 审计技术字段（created_at/updated_at/imported_at 等）绝不走本模块换算。
 */

export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 带 Z 或显式偏移的 ISO 时间（偏移必填：无偏移 ISO 属于本地墙钟，不匹配此正则）。 */
export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
/** 无偏移本地墙钟 datetime：yyyy-m-d[ T]HH:mm[:ss]（月/日可为 1~2 位）。 */
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 按本机时区（冻结本机 IANA 时区）取 Date 的日历日 yyyy-mm-dd。 */
export function localCalendarDateOf(date: Date): BusinessDate {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 是否为真实日历日期（yyyy-mm-dd，含闰年/大小月校验）。 */
export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/**
 * 文本 → 业务日期（yyyy-mm-dd）；非法返回 null（导入路径保留原文、由校验阶段定位）。
 * 接受：纯日期、带 Z/显式偏移 ISO、无偏移本地 datetime；必须是真实日历日期。
 */
export function normalizeBusinessDateText(value: string): BusinessDate | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (DATE_ONLY_RE.test(trimmed)) {
    return isRealCalendarDate(trimmed) ? trimmed : null;
  }
  if (ISO_DATETIME_RE.test(trimmed)) {
    // 带 Z/显式偏移：解析为时刻，再按冻结本机 IANA 时区取本地日历日。
    const instant = new Date(trimmed);
    if (Number.isNaN(instant.getTime())) return null;
    return localCalendarDateOf(instant);
  }
  const local = LOCAL_DATETIME_RE.exec(trimmed);
  if (local !== null) {
    // 无偏移：墙钟字段即业务本地时间，直接取日期部分（不做跨时区换算）。
    const y = Number(local[1]);
    const m = Number(local[2]);
    const d = Number(local[3]);
    if (m < 1 || m > 12 || d < 1) return null;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > daysInMonth) return null;
    return `${local[1]}-${pad2(m)}-${pad2(d)}`;
  }
  return null;
}

/**
 * v13 迁移口径：非法值抛错（调用方补报 table/id/column，并依赖外层迁移事务整体回滚）。
 */
export function normalizeBusinessDateStored(value: string): BusinessDate {
  const result = normalizeBusinessDateText(value);
  if (result === null) {
    throw new Error(
      `值「${value}」无法解释为业务日期：仅接受 yyyy-mm-dd、带 Z/显式偏移 ISO 或本地无偏移日期时间`,
    );
  }
  return result;
}
