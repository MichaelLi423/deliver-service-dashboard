import {
  createFactMeta,
  type ActorSnapshot,
  type FactMeta,
  type FactMetaInput,
} from '../../src/domain/core/source';
import { FixedClock, type Clock, type IsoDateTime } from '../../src/domain/core/time';

/**
 * 事实集合构造工具（tasks 1.4）。
 * 为各能力场景提供事实来源元信息构造辅助。
 */

export function makeAccount(accountId = 'account-1', username = '负责人甲'): ActorSnapshot {
  return { accountId, username };
}

export function manualFact(
  overrides: Partial<Omit<FactMetaInput, 'source'>> = {},
  actor: ActorSnapshot = makeAccount(),
): FactMeta {
  return createFactMeta({ source: 'manual', actor, ...overrides });
}

export function systemFact(overrides: Partial<Omit<FactMetaInput, 'source'>> = {}): FactMeta {
  return createFactMeta({ source: 'system', ...overrides });
}

/** 迁移导入事实：不归属本地账号（workbench-access「迁移数据不计手工录入」）。 */
export function importFact(overrides: Partial<Omit<FactMetaInput, 'source'>> = {}): FactMeta {
  return createFactMeta({ source: 'import', ...overrides });
}

export function fixedClock(iso: IsoDateTime): Clock {
  return new FixedClock(iso);
}

export const EXAMPLE_BUSINESS_TIME: IsoDateTime = '2026-07-15T10:30:00+08:00';
export const EXAMPLE_AUDIT_TIME: IsoDateTime = '2026-07-15T11:00:00+08:00';
