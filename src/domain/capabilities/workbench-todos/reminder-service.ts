import { ValidationError } from '../../core/errors';
import type { ActorSnapshot } from '../../core/source';
import { assertValidIso, SystemClock, type Clock } from '../../core/time';
import type { Project, ProjectRepository } from '../relocation-project-lifecycle';
import {
  classifyReminder,
  DEFAULT_UPCOMING_WINDOW_DAYS,
  type ProjectReminder,
  type ReminderDueClass,
  type ReminderInput,
} from './reminder';
import type { ReminderSettingsRepository } from './reminder-repositories';

/**
 * workbench-todos 领域服务（tasks 6.1~6.4 / design D9）。
 *
 * 项目提醒为手工维护：负责人创建、编辑或清除，不保存完成历史；系统绝不根据
 * 任何缺失字段自动生成提醒（TBD-23，原七类自动标准待办与自定义待办整体删除）。
 * 到期分类为纯函数（提醒时间 vs 本机业务日期），临期窗口可配置、默认未来 7 个
 * 自然日、配置立即生效。项目提醒仅在工作台内展示、无外部消息渠道。
 *
 * 提醒字段落在项目聚合内（lifecycle 拥有），本模块经 ProjectRepository 读写
 * 提醒字段与当前登录账号归属快照（design D12：手工录入事实绑定账号内部 ID 与
 * 录入时用户名快照），不触碰主状态、不拥有业务状态。
 */
export class ReminderService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly settings: ReminderSettingsRepository,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * 创建或编辑当前提醒：设置提醒时间与备注（均可空，但至少一项非空）。
   * 编辑时直接覆盖为新的当前提醒，不保存旧的提醒内容或完成历史（spec 6.1）。
   * 操作绑定当前登录账号归属快照。
   */
  setReminder(projectId: string, input: ReminderInput, actor: ActorSnapshot): ProjectReminder {
    const project = this.requireProject(projectId);
    const at = input.at ?? null;
    if (at !== null) {
      assertValidIso(at, '提醒时间');
    }
    const note = (input.note ?? '').trim();
    if (at === null && note === '') {
      throw new ValidationError(
        'REMINDER_EMPTY',
        '提醒时间与备注至少填写一项；如需移除提醒请使用清除操作',
      );
    }
    project.reminderAt = at;
    project.reminderNote = note === '' ? null : note;
    project.reminderAccountId = actor.accountId;
    project.reminderUsernameSnapshot = actor.username;
    project.updatedAt = this.now();
    this.projects.save(project);
    return this.toReminder(project);
  }

  /** 清除当前提醒：项目不再显示任何提醒（不保存完成历史）。 */
  clearReminder(projectId: string, actor: ActorSnapshot): ProjectReminder {
    const project = this.requireProject(projectId);
    project.reminderAt = null;
    project.reminderNote = null;
    project.reminderAccountId = actor.accountId;
    project.reminderUsernameSnapshot = actor.username;
    project.updatedAt = this.now();
    this.projects.save(project);
    return this.toReminder(project);
  }

  /** 当前提醒（含归属快照）；无提醒时返回 at/note 均为 null 的占位。 */
  getReminder(projectId: string): ProjectReminder {
    const project = this.requireProject(projectId);
    return this.toReminder(project);
  }

  /**
   * 到期分类（spec 6.2）：按当前提醒时间分类为临期/今日到期/已逾期，
   * 使用本机业务日期；无当前提醒的项目不分类。提醒时间可空——为空时返回 null。
   */
  classifyProject(project: Project): ReminderDueClass | null {
    return classifyReminder(project.reminderAt, this.clock.today(), this.getUpcomingWindowDays());
  }

  /** 按提醒时间直接分类（纯函数经服务聚合窗口配置）。 */
  classifyAt(at: string | null): ReminderDueClass | null {
    return classifyReminder(at, this.clock.today(), this.getUpcomingWindowDays());
  }

  /** 临期窗口配置：未配置返回默认未来 7 个自然日（spec 6.3）。 */
  getUpcomingWindowDays(): number {
    return this.settings.getUpcomingWindowDays() ?? DEFAULT_UPCOMING_WINDOW_DAYS;
  }

  /** 配置临期窗口：立即生效于后续到期分类（spec 6.3）。 */
  setUpcomingWindowDays(days: number): void {
    if (!Number.isInteger(days) || days < 0) {
      throw new ValidationError('INVALID_WINDOW_DAYS', '临期窗口必须为不小于 0 的整数天');
    }
    this.settings.setUpcomingWindowDays(days);
  }

  /**
   * 全部带当前提醒的项目及其到期分类（工作台「项目提醒快速处理」数据来源；
   * 提醒仅在工作台内展示，本服务不提供任何外部发送能力）。
   */
  listReminders(): { project: Project; reminder: ProjectReminder; dueClass: ReminderDueClass | null }[] {
    const today = this.clock.today();
    const windowDays = this.getUpcomingWindowDays();
    return this.projects
      .listAll()
      .filter((p) => p.reminderAt !== null || p.reminderNote !== null)
      .map((project) => ({
        project,
        reminder: this.toReminder(project),
        dueClass: classifyReminder(project.reminderAt, today, windowDays),
      }));
  }

  private toReminder(project: Project): ProjectReminder {
    return {
      projectId: project.id,
      at: project.reminderAt,
      note: project.reminderNote,
      operatorAccountId: project.reminderAccountId,
      operatorUsername: project.reminderUsernameSnapshot,
    };
  }

  private requireProject(projectId: string): Project {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    return project;
  }

  private now(): string {
    return this.clock.nowIso();
  }
}
