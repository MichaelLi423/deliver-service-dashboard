import { ValidationError } from './errors';
import {
  assertValidBusinessDate,
  assertValidIso,
  SystemClock,
  type BusinessDate,
  type Clock,
  type IsoDateTime,
} from './time';

/** 事实来源归属校验错误类型随本模块 API 一并导出。 */
export { ValidationError } from './errors';

/**
 * 事实来源标记（tasks 1.5 / design D4/D11 / workbench-access「迁移数据不计手工录入」）。
 *
 * - source: manual（负责人手工录入）/ system（系统自动记录）/ import（存量迁移导入）。
 * - manual 事实必须携带当前已登录本地账号的内部 ID 与录入时用户名快照（归属快照）；
 *   历史统计按快照归属，不因以后改名变化。
 * - system / import 事实不得归属本地账号（迁移数据不视为手工录入）。
 * - 业务时间 businessAt 与审计时间 auditAt 分离保存。
 */

export type FactSource = 'manual' | 'system' | 'import';

/** 账号归属快照：内部 ID + 录入时用户名。 */
export interface ActorSnapshot {
  accountId: string;
  username: string;
}

/** 事实元信息：来源 + 业务时间 + 审计时间 + 账号归属快照。 */
export interface FactMeta {
  source: FactSource;
  /** 业务时间（yyyy-mm-dd）：业务事件实际发生日期。 */
  businessAt: BusinessDate;
  /** 审计时间（带偏移 ISO）：系统记录该事实的时间，与业务时间分开保存。 */
  auditAt: IsoDateTime;
  /** 账号归属快照；仅 manual 事实非空。 */
  actor: ActorSnapshot | null;
}

export interface FactMetaInput {
  source: FactSource;
  /** 缺省取时钟当前业务日期（today()）。 */
  businessAt?: BusinessDate;
  /** 缺省取时钟当前时间（nowIso()）。 */
  auditAt?: IsoDateTime;
  actor?: ActorSnapshot | null;
  clock?: Clock;
}

export function createFactMeta(input: FactMetaInput): FactMeta {
  const clock = input.clock ?? new SystemClock();
  const meta: FactMeta = {
    source: input.source,
    businessAt: input.businessAt ?? clock.today(),
    auditAt: input.auditAt ?? clock.nowIso(),
    actor: input.actor ?? null,
  };
  validateFactMeta(meta);
  return meta;
}

/** 校验事实来源归属规则：manual 必须有账号快照，非 manual 不得有。 */
export function validateFactMeta(meta: FactMeta): void {
  assertValidBusinessDate(meta.businessAt, '业务时间');
  assertValidIso(meta.auditAt, '审计时间');
  if (meta.source === 'manual' && meta.actor === null) {
    throw new ValidationError(
      'MANUAL_FACT_NEEDS_ACTOR',
      '负责人手工录入的事实必须记录当前登录账号的内部 ID 与用户名快照',
    );
  }
  if (meta.source !== 'manual' && meta.actor !== null) {
    throw new ValidationError(
      'NON_MANUAL_FACT_NO_ACTOR',
      '系统自动记录或迁移导入的事实不得归属本地应用账号',
    );
  }
}

export function isManual(meta: FactMeta): boolean {
  return meta.source === 'manual';
}
