import { ValidationError } from '../../core/errors';
import { toBusinessDate, type BusinessDate, type IsoDateTime } from '../../core/time';

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
 * 提醒时间与备注均可空；仅当两者均为空时项目无当前提醒。
 * operator* 为最近一次创建/编辑/清除操作绑定的登录账号快照（手工事实归属，
 * design D12；历史统计不因以后改名变化）。
 */
export interface ProjectReminder {
  projectId: string;
  /** 当前提醒时间（业务时间），可空；为空时不参与到期分类。 */
  at: string | null;
  /** 备注内容，可空（去除首尾空白后为空按无备注处理）。 */
  note: string | null;
  /** 操作绑定账号内部 ID（可空：历史数据/无归属场景）。 */
  operatorAccountId: string | null;
  /** 操作绑定录入时用户名快照（可空）。 */
  operatorUsername: string | null;
}

/** 提醒维护输入：提醒时间与备注均可选（可空），至少一项非空方可创建/编辑。 */
export interface ReminderInput {
  at?: string | null;
  note?: string | null;
}

/** 业务日期增加自然天数（yyyy-mm-dd，纯函数，本机日期口径）。 */
export function addBusinessDays(date: BusinessDate, days: number): BusinessDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new ValidationError('INVALID_DATE', `非法业务日期: ${date}`);
  }
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

/**
 * 到期分类纯函数（spec「提醒到期分类」/「临期窗口可配置」）：
 * - 无提醒时间（null/空）→ null（无当前提醒的项目不分类）；
 * - 提醒时间业务日期 == 今天 → today（截止日当天）；
 * - 提醒时间业务日期 < 今天 → overdue（超过截止日）；
 * - 今天 < 提醒时间业务日期 ≤ 今天 + 临期窗口 → upcoming（临期窗口内且未到期）；
 * - 超出临期窗口（未来天数 > windowDays）→ null（不进入任何到期分类）。
 * 使用本机业务日期（调用方提供 today），与 0.2「带偏移 ISO 时间/业务日期」口径一致。
 */
export function classifyReminder(
  reminderAt: string | null,
  today: BusinessDate,
  windowDays: number,
): ReminderDueClass | null {
  if (reminderAt === null || reminderAt === '') {
    return null;
  }
  const dueDate = toBusinessDate(reminderAt as IsoDateTime);
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
