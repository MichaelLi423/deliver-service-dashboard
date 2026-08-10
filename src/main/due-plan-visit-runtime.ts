import { type BusinessDate, type Clock } from '../domain/core/time';
import type { DuePlanVisitAdvanceResult } from '../domain/capabilities/local-data-persistence/due-plan-visit-advancer';

/**
 * 计划上门日期到期自动推进触发接线（Tasks 3.3）。
 *
 * 触发点：
 * - 启动补跑（迁移后、首个工作台读取前）：由接线层在应用启动路径显式调用 runCatchUp()；
 * - app activate / powerMonitor resume：由接线层注入事件订阅（本模块不依赖 electron）；
 * - 运行中跨本地业务日期边界：按距下一个本地午夜的精确毫秒数调度定时器（非固定 24h），
 *   触发后补跑并重新调度；再次 activate/resume/边界均幂等补跑（<= 漏跑回溯）。
 *
 * clock / timer / 事件订阅均可注入：测试用虚拟定时器与拨动时钟断言可观察触发语义；
 * dispose 移除事件订阅并清除定时器，不承诺桌面关闭期间的任何后台运行。
 */
export interface DuePlanVisitTimer {
  set: (fn: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface DuePlanVisitRuntimeDeps {
  /** 当前业务日期来源（可注入，便于测试固定/拨动日期）。 */
  clock: Clock;
  /** 推进执行器（产品接线为 SqliteDuePlanVisitAdvancer；测试注入以观察/隔离）。 */
  advance: (today: BusinessDate) => DuePlanVisitAdvanceResult;
  /** 当前墙钟（用于计算距下一个本地午夜毫秒数；默认 new Date()）。 */
  now?: () => Date;
  /** 定时器注入（默认 setTimeout/clearTimeout；测试注入虚拟调度）。 */
  timer?: DuePlanVisitTimer;
  /** 事件订阅注入（缺省即不订阅 activate/resume；main 接线注入 electron 事件）。 */
  events?: {
    onActivate: (fn: () => void) => () => void;
    onResume: (fn: () => void) => () => void;
  };
}

const defaultTimer: DuePlanVisitTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class DuePlanVisitRuntime {
  private readonly clock: Clock;
  private readonly advance: (today: BusinessDate) => DuePlanVisitAdvanceResult;
  private readonly now: () => Date;
  private readonly timer: DuePlanVisitTimer;
  private readonly depsEvents: DuePlanVisitRuntimeDeps['events'];
  private readonly unsubs: Array<() => void> = [];
  private timerHandle: unknown = null;
  private disposed = false;

  constructor(deps: DuePlanVisitRuntimeDeps) {
    this.clock = deps.clock;
    this.advance = deps.advance;
    this.now = deps.now ?? (() => new Date());
    this.timer = deps.timer ?? defaultTimer;
    this.depsEvents = deps.events;
  }

  /** 立即补跑（迁移后/首个工作台读取前、activate、resume 共用；<= 漏跑回溯）。 */
  runCatchUp(): DuePlanVisitAdvanceResult {
    return this.advance(this.clock.today());
  }

  /** 开始触发接线：订阅 activate/resume 并调度下一个本地业务日期边界定时器。 */
  start(): void {
    if (this.unsubs.length === 0 && this.depsEvents) {
      this.unsubs.push(this.depsEvents.onActivate(() => this.runCatchUp()));
      this.unsubs.push(this.depsEvents.onResume(() => this.runCatchUp()));
    }
    this.scheduleBoundary();
  }

  /** 释放：移除事件订阅并清除边界定时器（dispose 后不再调度/触发）。 */
  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubs.splice(0)) unsub();
    if (this.timerHandle !== null) {
      this.timer.clear(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private scheduleBoundary(): void {
    if (this.disposed) return;
    if (this.timerHandle !== null) this.timer.clear(this.timerHandle);
    const delayMs = msUntilNextLocalMidnight(this.now());
    this.timerHandle = this.timer.set(() => {
      if (this.disposed) return; // dispose 后（含已入队回调竞态）不再推进/重调度
      this.timerHandle = null;
      this.runCatchUp();
      this.scheduleBoundary();
    }, delayMs);
  }
}

/** 距下一个本地午夜（业务日期边界）的精确毫秒数，至少 1ms（避免固定 24h 漂移）。 */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}
