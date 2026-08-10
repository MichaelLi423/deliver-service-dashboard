/**
 * 共享项目区域字段（tasks 2.4 / 2.5 / TBD-12 / design D1）。
 *
 * 区域枚举的唯一共享来源：renderer（shared/IPC）、主进程 facade 与领域写边界
 * （relocation-project-lifecycle parseProjectRegion）全部消费本模块，
 * 避免在多处各自声明区域枚举导致口径漂移。
 *
 * 写边界：trim 后严格校验五枚举（领域 core/ids.ts parseProjectRegion）。
 * 读取/报表：存量非枚举非空文本保留原值并归入 REGION_PENDING_ADJUSTMENT 分组
 * （regionGroupKey），不猜测映射、不置空、不丢弃。
 */

/** 项目区域固定枚举（仅允许五个取值）。 */
export const PROJECT_REGIONS = ['East', 'South', 'West', 'Central', 'North'] as const;

/** 项目区域类型：五个固定取值之一（写入侧规范化值）。 */
export type ProjectRegion = (typeof PROJECT_REGIONS)[number];

/** 读取/报表的「待调整」独立分组标记：存量非枚举非空区域归入该组。 */
export const REGION_PENDING_ADJUSTMENT = '待调整';

const PROJECT_REGION_SET: ReadonlySet<string> = new Set<string>(PROJECT_REGIONS);

/** 是否为五个固定枚举之一（读取层标记 legacy「待调整」用）。 */
export function isProjectRegion(value: string): boolean {
  return PROJECT_REGION_SET.has(value);
}
