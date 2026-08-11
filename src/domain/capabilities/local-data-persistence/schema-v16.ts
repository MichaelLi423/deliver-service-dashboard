import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v16：项目暂定仪器范围字段（用户确认的 v16 项目暂定仪器范围）。
 *
 * - projects.temporary_instrument_name：暂定仪器名称（可空 TEXT；trim 后保存，空串统一 null）。
 * - projects.temporary_instrument_model：暂定仪器型号（可空 TEXT；trim 后保存，空串统一 null）。
 * - projects.temporary_has_ups：暂定仪器是否配备 UPS（可空 INTEGER；null=未填写、
 *   0=否、1=是）。
 *
 * 这些是「项目级暂定仪器范围」手工维护标量事实，建档与编辑资料均可填写：
 * - 保存/修改/清空仅更新项目标量，绝不创建/修改/删除任何 instruments 行；
 * - 不触发生命周期/主状态流转（无 lifecycle 副作用；正常 project 标量
 *   UPDATE 的 business_revision 可变化，与既有 projectNote/temporaryStorage 一致）；
 * - 暂定仪器数量仍独立复用既有字段 projects.temporary_instrument_count，不因本迁移改变。
 *
 * 全部为新增可空列，不重建表、不改写存量业务值；存量行不受影响。
 */

export const TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION = 16;

export function applyTemporaryInstrumentFieldsMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE projects ADD COLUMN temporary_instrument_name TEXT;
    ALTER TABLE projects ADD COLUMN temporary_instrument_model TEXT;
    ALTER TABLE projects ADD COLUMN temporary_has_ups INTEGER;
  `);
}
