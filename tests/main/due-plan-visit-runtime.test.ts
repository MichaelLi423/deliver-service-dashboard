import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  type BusinessDate,
  type Clock,
} from '../../src/domain/core/time';
import type { DuePlanVisitAdvanceResult } from '../../src/domain/capabilities/local-data-persistence';
import {
  DuePlanVisitRuntime,
  msUntilNextLocalMidnight,
  type DuePlanVisitTimer,
} from '../../src/main/due-plan-visit-runtime';

/**
 * 计划上门日期到期自动推进触发接线（Tasks 3.3）：
 * 用可注入 clock / timer / 事件订阅验证可观察触发语义（不依赖 electron 与真实定时器）：
 * - runCatchUp：迁移后/首个工作台读取前补跑（startup）；
 * - app activate / powerMonitor resume 触发补跑；
 * - 运行中跨本地业务日期边界：按精确毫秒调度，触发后以新业务日期补跑并重新调度；
 * - dispose 移除事件订阅并清除定时器。
 */

/** 可拨动业务日期的测试时钟。 */
class MutableClock implements Clock {
  private iso: string;
  constructor(iso: string) {
    this.iso = iso;
  }
  setIso(iso: string): void {
    this.iso = iso;
  }
  nowIso(): string {
    return this.iso;
  }
  today(): BusinessDate {
    return this.iso.slice(0, 10);
  }
}

interface ScheduledTask {
  fn: () => void;
  delayMs: number;
  handle: unknown;
}

/** 虚拟定时器：捕获调度/清除调用，由测试手动触发。 */
function fakeTimer(): { timer: DuePlanVisitTimer; scheduled: ScheduledTask[]; cleared: unknown[] } {
  const scheduled: ScheduledTask[] = [];
  const cleared: unknown[] = [];
  const timer: DuePlanVisitTimer = {
    set: (fn, delayMs) => {
      const handle = { id: scheduled.length };
      scheduled.push({ fn, delayMs, handle });
      return handle;
    },
    clear: (handle) => {
      cleared.push(handle);
    },
  };
  return { timer, scheduled, cleared };
}

function noopAdvance(): DuePlanVisitAdvanceResult {
  return { scanned: 0, advanced: 0 };
}

describe('计划上门日期到期自动推进触发接线（tasks 3.3）', () => {
  it('runCatchUp（迁移后/首个工作台读取前补跑）以注入时钟的当前业务日期执行推进', () => {
    const clock = new FixedClock('2026-08-10T08:00:00+08:00');
    const advanced: BusinessDate[] = [];
    const runtime = new DuePlanVisitRuntime({
      clock,
      advance: (today) => {
        advanced.push(today);
        return { scanned: 1, advanced: 1 };
      },
    });
    const result = runtime.runCatchUp();
    expect(result).toEqual({ scanned: 1, advanced: 1 });
    expect(advanced).toEqual(['2026-08-10']);
    runtime.dispose();
  });

  it('app activate / powerMonitor resume 触发补跑；dispose 移除订阅', () => {
    const clock = new FixedClock('2026-08-10T10:00:00+08:00');
    const advanced: BusinessDate[] = [];
    // 对象属性捕获事件处理器（避免 let 变量被 TS 收窄为 null 的调用限制）
    const handlers: { activate?: () => void; resume?: () => void } = {};
    const runtime = new DuePlanVisitRuntime({
      clock,
      advance: (today) => {
        advanced.push(today);
        return { scanned: 1, advanced: 1 };
      },
      timer: { set: () => 0, clear: () => undefined }, // 本用例只验证事件订阅
      events: {
        onActivate: (fn) => {
          handlers.activate = fn;
          return () => {
            handlers.activate = undefined;
          };
        },
        onResume: (fn) => {
          handlers.resume = fn;
          return () => {
            handlers.resume = undefined;
          };
        },
      },
    });
    runtime.start();
    expect(advanced).toHaveLength(0); // start 不主动补跑（启动补跑由接线层显式调用）
    expect(handlers.activate).toBeDefined();
    expect(handlers.resume).toBeDefined();

    handlers.activate?.();
    expect(advanced).toEqual(['2026-08-10']);
    handlers.resume?.();
    expect(advanced).toEqual(['2026-08-10', '2026-08-10']);

    runtime.dispose();
    expect(handlers.activate).toBeUndefined(); // 订阅已移除
    expect(handlers.resume).toBeUndefined();
  });

  it('运行中跨本地业务日期边界：按距下一个午夜精确毫秒调度，触发后以新业务日期补跑并重新调度', () => {
    const clock = new MutableClock('2026-08-10T23:59:00+08:00');
    let now = new Date(2026, 7, 10, 23, 59, 0); // 2026-08-10 23:59:00 本地时间
    const { timer, scheduled, cleared } = fakeTimer();
    const advanced: BusinessDate[] = [];
    const runtime = new DuePlanVisitRuntime({
      clock,
      advance: (today) => {
        advanced.push(today);
        return { scanned: 1, advanced: 1 };
      },
      now: () => now,
      timer,
    });
    runtime.start();
    expect(scheduled).toHaveLength(1);
    // 精确到下一个本地午夜（60s），而非固定 24h
    expect(scheduled[0].delayMs).toBe(60_000);

    // 拨动时钟跨过业务日期边界后触发定时器 → 以新业务日期补跑并重新调度
    clock.setIso('2026-08-11T00:05:00+08:00');
    now = new Date(2026, 7, 11, 0, 5, 0);
    scheduled[0].fn();
    expect(advanced).toEqual(['2026-08-11']);
    expect(scheduled).toHaveLength(2); // 触发后重新调度下一个边界

    runtime.dispose();
    expect(cleared).toEqual([scheduled[1].handle]); // 只清除最新定时器句柄
  });

  it('dispose 后定时器触发不再推进（已清除且不再调度）', () => {
    const clock = new FixedClock('2026-08-10T12:00:00+08:00');
    const { timer, scheduled, cleared } = fakeTimer();
    const advanced: BusinessDate[] = [];
    const runtime = new DuePlanVisitRuntime({
      clock,
      advance: (today) => {
        advanced.push(today);
        return { scanned: 1, advanced: 1 };
      },
      now: () => new Date(2026, 7, 10, 12, 0, 0),
      timer,
    });
    runtime.start();
    expect(scheduled).toHaveLength(1);
    const boundaryHandle = scheduled[0].handle;

    runtime.dispose();
    expect(cleared).toContain(boundaryHandle);
    scheduled[0].fn(); // 模拟已清除定时器回调（dispose 竞态）仍被触发
    expect(advanced).toHaveLength(0); // dispose 后不再推进
    expect(scheduled).toHaveLength(1); // 不再重新调度
  });

  it('msUntilNextLocalMidnight：午夜整点 → 24h；临近午夜 → 1ms；绝不返回 0', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 10, 0, 0, 0, 0))).toBe(24 * 60 * 60 * 1000);
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 10, 23, 59, 59, 999))).toBe(1);
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 10, 12, 30, 0, 0))).toBe(11 * 60 * 60 * 1000 + 30 * 60 * 1000);
  });

  it('默认接线（无事件订阅）也能补跑与释放', () => {
    const runtime = new DuePlanVisitRuntime({
      clock: new FixedClock('2026-08-10T09:00:00+08:00'),
      advance: noopAdvance,
      timer: { set: () => 0, clear: () => undefined },
    });
    runtime.start();
    expect(runtime.runCatchUp()).toEqual({ scanned: 0, advanced: 0 });
    runtime.dispose();
  });
});
