import { describe, expect, it } from 'vitest';
import * as workbenchTodos from '../../src/domain/capabilities/workbench-todos';
import {
  addBusinessDays,
  classifyReminder,
  DEFAULT_UPCOMING_WINDOW_DAYS,
  ReminderService,
  type ReminderDueClass,
} from '../../src/domain/capabilities/workbench-todos';
import { createPendingProject } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryProjectRepository } from '../helpers/in-memory-repos';
import { InMemoryReminderSettingsRepository } from '../helpers/capability-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * workbench-todos 领域场景测试（tasks 6.1~6.4 实现，6.5 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景：项目提醒手工维护、到期分类、
 * 临期窗口可配置、仅工作台内展示、不自动创建提醒的场景，以及所有权边界。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const projects = new InMemoryProjectRepository();
  const settings = new InMemoryReminderSettingsRepository();
  const service = new ReminderService(projects, settings, CLOCK);
  return { projects, settings, service };
}

/** 在当前上下文中创建并落库一个待进单项目。 */
function addProject(ctx: ReturnType<typeof setup>, id = 'p1'): void {
  const project = createPendingProject({ id });
  ctx.projects.save(project);
}

describe('项目提醒手工维护（6.1）', () => {
  it('手工创建项目提醒：保存当前提醒并显示在项目上', () => {
    const ctx = setup();
    addProject(ctx);
    const reminder = ctx.service.setReminder(
      'p1',
      { at: '2026-08-10T09:00:00+08:00', note: '补齐搬迁范围资料' },
      ACTOR,
    );
    expect(reminder.at).toBe('2026-08-10T09:00:00+08:00');
    expect(reminder.note).toBe('补齐搬迁范围资料');
    expect(ctx.projects.findById('p1')!.reminderAt).toBe('2026-08-10T09:00:00+08:00');
    expect(ctx.projects.findById('p1')!.reminderNote).toBe('补齐搬迁范围资料');
  });

  it('编辑当前提醒：覆盖为新的当前提醒，不保存旧内容或完成历史', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '旧备注' }, ACTOR);
    const edited = ctx.service.setReminder(
      'p1',
      { at: '2026-08-12T09:00:00+08:00', note: '新备注' },
      ACTOR,
    );
    expect(edited.at).toBe('2026-08-12T09:00:00+08:00');
    expect(edited.note).toBe('新备注');
    // 无完成历史/历史提醒表：仅当前字段，旧内容不可再取到
    const stored = ctx.projects.findById('p1')!;
    expect(stored.reminderAt).toBe('2026-08-12T09:00:00+08:00');
    expect(stored.reminderNote).toBe('新备注');
    expect('reminderHistory' in stored).toBe(false);
    expect('reminderDoneAt' in stored).toBe(false);
  });

  it('清除项目提醒：项目不再显示任何提醒', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '跟进' }, ACTOR);
    const cleared = ctx.service.clearReminder('p1', ACTOR);
    expect(cleared.at).toBeNull();
    expect(cleared.note).toBeNull();
    expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();
    expect(ctx.projects.findById('p1')!.reminderNote).toBeNull();
  });

  it('提醒时间可空：仅填备注可保存提醒，提醒时间为空时不参与到期分类', () => {
    const ctx = setup();
    addProject(ctx);
    const reminder = ctx.service.setReminder('p1', { note: '仅备注提醒' }, ACTOR);
    expect(reminder.at).toBeNull();
    expect(reminder.note).toBe('仅备注提醒');
    expect(ctx.service.classifyProject(ctx.projects.findById('p1')!)).toBeNull();
  });

  it('提醒备注可空：仅填提醒时间可保存提醒', () => {
    const ctx = setup();
    addProject(ctx);
    const reminder = ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00' }, ACTOR);
    expect(reminder.at).toBe('2026-08-10T09:00:00+08:00');
    expect(reminder.note).toBeNull();
  });

  it('创建/编辑提醒时提醒时间与备注均为空则拒绝（应使用清除操作）', () => {
    const ctx = setup();
    addProject(ctx);
    expect(() => ctx.service.setReminder('p1', { at: null, note: '' }, ACTOR)).toThrow(/至少填写一项/);
    expect(() => ctx.service.setReminder('p1', {}, ACTOR)).toThrow(/至少填写一项/);
  });

  it('提醒时间格式非法时拒绝保存', () => {
    const ctx = setup();
    addProject(ctx);
    expect(() =>
      ctx.service.setReminder('p1', { at: '2026-08-10', note: 'x' }, ACTOR),
    ).toThrow(/格式非法/);
  });

  it('操作绑定当前登录账号归属快照（D12：手工事实归属当前账号）', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '跟进' }, ACTOR);
    const stored = ctx.projects.findById('p1')!;
    expect(stored.reminderAccountId).toBe('account-1');
    expect(stored.reminderUsernameSnapshot).toBe('负责人甲');
  });

  it('系统不自动生成提醒：服务无任何自动派生规则，提醒仅由手工维护产生', () => {
    const ctx = setup();
    addProject(ctx);
    addProject(ctx, 'p2');
    // 无自动评估/自动创建入口
    const proto = Object.getPrototypeOf(ctx.service) as Record<string, unknown>;
    for (const name of ['autoGenerate', 'evaluateReminders', 'deriveReminders', 'autoCreate']) {
      expect(name in proto).toBe(false);
    }
    // 创建项目后提醒保持为空，直到负责人手工维护
    expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();
    expect(ctx.projects.findById('p2')!.reminderNote).toBeNull();
    expect(ctx.service.listReminders()).toHaveLength(0);
    // 负责人手工维护后才产生提醒
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00' }, ACTOR);
    expect(ctx.service.listReminders()).toHaveLength(1);
  });
});

describe('提醒到期分类（6.2）', () => {
  it('截止日当天归为今日到期', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-07T18:00:00+08:00', note: '今天截止' }, ACTOR);
    expect(ctx.service.classifyProject(ctx.projects.findById('p1')!)).toBe('today');
  });

  it('超过截止日归为已逾期', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-06T09:00:00+08:00', note: '已超期' }, ACTOR);
    expect(ctx.service.classifyProject(ctx.projects.findById('p1')!)).toBe('overdue');
  });

  it('临期窗口内且未到期的提醒归为临期', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '临期跟进' }, ACTOR);
    expect(ctx.service.classifyProject(ctx.projects.findById('p1')!)).toBe('upcoming');
  });

  it('无当前提醒的项目不进入任何到期分类', () => {
    const ctx = setup();
    addProject(ctx);
    expect(ctx.service.classifyProject(ctx.projects.findById('p1')!)).toBeNull();
  });

  it('分类纯函数边界：恰好未来 7 天为临期，第 8 天起不分类', () => {
    const today = '2026-08-07';
    expect(classifyReminder('2026-08-07T23:59:00+08:00', today, 7)).toBe('today');
    expect(classifyReminder('2026-08-14T00:00:00+08:00', today, 7)).toBe('upcoming');
    expect(classifyReminder('2026-08-15T00:00:00+08:00', today, 7)).toBeNull();
    expect(classifyReminder(null, today, 7)).toBeNull();
    expect(classifyReminder('', today, 7)).toBeNull();
  });

  it('addBusinessDays 为纯日期运算（自然日）', () => {
    expect(addBusinessDays('2026-08-07', 7)).toBe('2026-08-14');
    expect(addBusinessDays('2026-08-07', 0)).toBe('2026-08-07');
    expect(addBusinessDays('2026-08-07', -1)).toBe('2026-08-06');
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addBusinessDays('2024-02-28', 1)).toBe('2024-02-29'); // 闰年
  });
});

describe('临期窗口可配置、默认 7 个自然日（6.3）', () => {
  it('未配置时默认未来 7 个自然日', () => {
    const ctx = setup();
    addProject(ctx);
    expect(ctx.service.getUpcomingWindowDays()).toBe(DEFAULT_UPCOMING_WINDOW_DAYS);
    expect(ctx.service.getUpcomingWindowDays()).toBe(7);
    // 第 7 天临期、第 8 天不临期（默认窗口）
    expect(ctx.service.classifyAt('2026-08-14T00:00:00+08:00')).toBe('upcoming');
    expect(ctx.service.classifyAt('2026-08-15T00:00:00+08:00')).toBeNull();
  });

  it('配置临期窗口后立即生效于后续到期分类', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setUpcomingWindowDays(3);
    expect(ctx.service.getUpcomingWindowDays()).toBe(3);
    // 仅未来 3 天内的提醒进入临期
    expect(ctx.service.classifyAt('2026-08-10T00:00:00+08:00')).toBe('upcoming');
    expect(ctx.service.classifyAt('2026-08-11T00:00:00+08:00')).toBeNull();
    // 再次配置立即生效
    ctx.service.setUpcomingWindowDays(1);
    expect(ctx.service.classifyAt('2026-08-08T00:00:00+08:00')).toBe('upcoming');
    expect(ctx.service.classifyAt('2026-08-09T00:00:00+08:00')).toBeNull();
  });

  it('配置非法值（负数/非整数）被拒绝', () => {
    const ctx = setup();
    expect(() => ctx.service.setUpcomingWindowDays(-1)).toThrow(/不小于 0 的整数/);
    expect(() => ctx.service.setUpcomingWindowDays(2.5)).toThrow(/不小于 0 的整数/);
  });
});

describe('提醒仅工作台内展示（6.4）', () => {
  it('提供工作台内到期分类与提醒列表，无任何外部消息渠道能力', () => {
    const ctx = setup();
    addProject(ctx);
    addProject(ctx, 'p2');
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '跟进' }, ACTOR);
    ctx.service.setReminder('p2', { at: '2026-08-06T09:00:00+08:00', note: '已超期' }, ACTOR);

    const reminders = ctx.service.listReminders();
    expect(reminders).toHaveLength(2);
    const dueMap = new Map<string, ReminderDueClass | null>(
      reminders.map((r) => [r.project.id, r.dueClass]),
    );
    expect(dueMap.get('p1')).toBe('upcoming');
    expect(dueMap.get('p2')).toBe('overdue');

    // 无外部渠道：不提供任何发送/推送能力
    const proto = Object.getPrototypeOf(ctx.service) as Record<string, unknown>;
    for (const name of ['sendEmail', 'sendToWeCom', 'notifyExternal', 'push', 'send']) {
      expect(name in proto).toBe(false);
    }
    const modKeys = Object.keys(workbenchTodos).filter((k) =>
      /email|wecom|wechat|push|channel|notify/i.test(k),
    );
    expect(modKeys).toHaveLength(0);
  });
});

describe('不自动创建提醒的场景（6.4 / TBD-23）', () => {
  it('无关事实变动（区域、执行准备等）不改变项目提醒字段', () => {
    const ctx = setup();
    addProject(ctx);
    const project = ctx.projects.findById('p1')!;
    project.region = '华东';
    project.planVisitAt = '2026-08-20T09:00:00+08:00';
    project.siteConfirmed = true;
    project.actualInstallDoneAt = null;
    ctx.projects.save(project);
    expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();
    expect(ctx.projects.findById('p1')!.reminderNote).toBeNull();
    expect(ctx.service.listReminders()).toHaveLength(0);
  });

  it('项目提醒维护不触碰主状态：不调用 lifecycle 转换、状态保持不变', () => {
    const ctx = setup();
    addProject(ctx);
    const before = ctx.projects.findById('p1')!.status;
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '跟进' }, ACTOR);
    ctx.service.clearReminder('p1', ACTOR);
    expect(ctx.projects.findById('p1')!.status).toBe(before);
  });

  it('提醒不存在于除项目字段外的任何记录：无独立提醒表/事件表', () => {
    const ctx = setup();
    addProject(ctx);
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '跟进' }, ACTOR);
    const project = ctx.projects.findById('p1')!;
    // 提醒事实仅落在项目聚合字段上
    const keys = Object.keys(project);
    expect(keys).toContain('reminderAt');
    expect(keys).toContain('reminderNote');
    expect(keys.some((k) => k.includes('event') || k.includes('history'))).toBe(false);
  });
});

describe('所有权边界（design D9 / tasks 6.5）', () => {
  it('workbench-todos 不导出状态转换入口，仅导出提醒规则', () => {
    expect('resolveStatus' in workbenchTodos).toBe(false);
    expect('transition' in workbenchTodos).toBe(false);
    expect('PROJECT_STATUSES' in workbenchTodos).toBe(false);
    expect(typeof workbenchTodos.ReminderService).toBe('function');
    expect(typeof workbenchTodos.classifyReminder).toBe('function');
    expect(workbenchTodos.DEFAULT_UPCOMING_WINDOW_DAYS).toBe(7);
  });

  it('提醒维护只改提醒字段与归属快照，不改动其他项目字段', () => {
    const ctx = setup();
    addProject(ctx);
    const before = ctx.projects.findById('p1')!;
    ctx.service.setReminder('p1', { at: '2026-08-10T09:00:00+08:00', note: '跟进' }, ACTOR);
    const after = ctx.projects.findById('p1')!;
    expect(after.status).toBe(before.status);
    expect(after.entryAt).toBe(before.entryAt);
    expect(after.region).toBe(before.region);
    expect(after.contractId).toBe(before.contractId);
    expect(after.customerId).toBe(before.customerId);
    expect(after.tempNo).toBe(before.tempNo);
  });
});
