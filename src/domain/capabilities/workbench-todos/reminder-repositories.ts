import type { Project } from '../relocation-project-lifecycle';

/**
 * workbench-todos 仓储接口（领域服务依赖）。
 *
 * 项目提醒字段落在项目聚合内（design D3/D9），本模块经 lifecycle 的
 * ProjectRepository 读写项目提醒字段与当前登录账号归属快照，不复制项目状态。
 * 临期窗口配置经 app_settings 持久化（SQLite 实现见
 * local-data-persistence/reminder-settings-repositories.ts）。
 */

/** 项目只读/写入口（consume lifecycle ProjectRepository；含全量列表供工作台展示）。 */
export interface ProjectReminderRepository {
  findById(id: string): Project | undefined;
  /** 全部项目（工作台项目提醒快速处理数据源）。 */
  listAll(): Project[];
  save(project: Project): void;
}

/** 临期窗口配置仓储（未配置返回 null，默认 7 个自然日）。 */
export interface ReminderSettingsRepository {
  getUpcomingWindowDays(): number | null;
  setUpcomingWindowDays(days: number): void;
}
