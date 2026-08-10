import { ValidationError } from '../../core/errors';
import { type BusinessDate } from '../../core/time';

/**
 * workbench-todos 能力（项目提醒，手工维护）。
 *
 * 项目提醒是搬迁项目聚合内的手工维护字段（当前提醒时间 + 备注），由负责人创建/
 * 编辑/清除，不保存完成历史，系统不根据任何缺失字段自动生成提醒（TBD-23）。
 * 到期分类（临期/今日到期/已逾期）与临期窗口配置（默认未来 7 个自然日）规则见
 * tasks 6.x / design D9。本模块只消费 lifecycle 的项目提醒字段与当前日期，不拥有
 * 业务状态。
 */

/** 临期窗口默认值：未来 7 个自然日（未配置时生效）。 */
export const DEFAULT_UPCOMING_WINDOW_DAYS = 7;

/** 提醒到期分类。 */
export const REMINDER_DUE_CLASSES = ['upcoming', 'today', 'overdue'] as const;
export type ReminderDueClass = (typeof REMINDER_DUE_CLASSES)[number];

/**
 * 项目提醒字段（落在项目聚合内，见 relocation-project-lifecycle Project）。
 * 提醒日期与备注均可空；仅当两者均为空时项目无当前提醒。
 * operator* 为最近一次创建/编辑/清除操作绑定的登录账号快照（手工事实归属，
 * design D12；历史统计不因以后改名变化）。
 */
export interface ProjectReminder {
  projectId: string;
  /** 当前提醒日期（业务日期 yyyy-mm-dd），可空；为空时不参与到期分类。 */
  at: BusinessDate | null;
  /** 备注内容，可空（去除首尾空白后为空按无备注处理）。 */
  note: string | null;
  /** 操作绑定账号内部 ID（可空：历史数据/无归属场景）。 */
  operatorAccountId: string | null;
  /** 操作绑定录入时用户名快照（可空）。 */
  operatorUsername: string | null;
}

/** 提醒维护输入：提醒日期与备注均可选（可空），至少一项非空方可创建/编辑。 */
export interface ReminderInput {
  at?: BusinessDate | null;
  note?: string | null;
}

/** 业务日期增加自然天数（yyyy-mm-dd，纯函数，本机日期口径）。
 *  对 4 位年 yyyy-mm-dd 范围做确定性饱和：正向超出返回 9999-12-31，
 *  负向超出返回 0000-01-01（避免 Date 溢出产生 NaN-NaN-NaN）。
 *  classifyReminder 与 workbench-read-repository 的 upcoming SQL 边界共用本函数。 */
const DAY_MS = 86_400_000;
const MAX_BUSINESS_DATE_MS = new Date('9999-12-31T00:00:00Z').getTime();
const MIN_BUSINESS_DATE_MS = new Date('0000-01-01T00:00:00Z').getTime();
export function addBusinessDays(date: BusinessDate, days: number): BusinessDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new ValidationError('INVALID_DATE', `非法业务日期: ${date}`);
  }
  // 入口守卫：days 必须是安全整数（负安全整数仍允许）；NaN/Infinity/非整数/不安全整数
  // 明确拒绝，保证 classifyReminder 直接以非法 windowDays 调用时也不会生成 NaN 日期。
  if (!Number.isSafeInteger(days)) {
    throw new ValidationError('INVALID_WINDOW_DAYS', `天数必须为安全整数: ${String(days)}`);
  }
  const baseMs = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(baseMs)) {
    throw new ValidationError('INVALID_DATE', `非法业务日期: ${date}`);
  }
  const targetMs = baseMs + days * DAY_MS;
  if (targetMs > MAX_BUSINESS_DATE_MS) return '9999-12-31';
  if (targetMs < MIN_BUSINESS_DATE_MS) return '0000-01-01';
  const target = new Date(targetMs);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(target.getUTCFullYear(), 4)}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
}

/**
 * 到期分类纯函数（spec「提醒到期分类」/「临期窗口可配置」）：
 * - 无提醒日期（null/空）→ null（无当前提醒的项目不分类）；
 * - 提醒日期 == 今天 → today（截止日当天）；
 * - 提醒日期 < 今天 → overdue（超过截止日）；
 * - 今天 < 提醒日期 ≤ 今天 + 临期窗口 → upcoming（临期窗口内且未到期）；
 * - 超出临期窗口（未来天数 > windowDays）→ null（不进入任何到期分类）。
 * 使用本机业务日期（调用方提供 today），提醒日期为 yyyy-mm-dd 直接按字符串比较。
 */
export function classifyReminder(
  reminderAt: BusinessDate | null,
  today: BusinessDate,
  windowDays: number,
): ReminderDueClass | null {
  if (reminderAt === null || reminderAt === '') {
    return null;
  }
  const dueDate = reminderAt;
  if (dueDate === today) {
    return 'today';
  }
  if (dueDate < today) {
    return 'overdue';
  }
  if (dueDate <= addBusinessDays(today, windowDays)) {
    return 'upcoming';
  }
  return null;
}
