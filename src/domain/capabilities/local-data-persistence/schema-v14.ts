import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v14：补齐资料/批量导入新增字段（已确认语义批次）。
 *
 * - projects.planned_install_done_at：计划装机完成日期（业务日期 yyyy-mm-dd）。
 *   独立字段，仅作计划展示，绝不触发生命周期流转（与 actual_install_done_at
 *   自动待验收区分）。
 * - instruments.manufacturer / instruments.service_level：仪器厂商与服务级别。
 *   仪器批量导入（.xlsx）保存 5 列：仪器名称/厂商/型号/序列号/服务级别，
 *   只有仪器名称必填。
 *
 * 只新增列，不改业务数据、不重建表；列可空，存量行不受影响。
 */

export const SUPPLEMENT_FIELDS_MIGRATION_VERSION = 14;

export function applySupplementFieldsMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE projects ADD COLUMN planned_install_done_at TEXT;
    ALTER TABLE instruments ADD COLUMN manufacturer TEXT;
    ALTER TABLE instruments ADD COLUMN service_level TEXT;
  `);
}
