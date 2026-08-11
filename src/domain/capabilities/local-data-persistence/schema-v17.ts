import type { DatabaseSync } from 'node:sqlite';

/** schema v17：全局可复用的项目分类标签。 */
export const PROJECT_TAG_MIGRATION_VERSION = 17;

/** 当前最新 schema 版本。 */
export const LATEST_SCHEMA_VERSION = PROJECT_TAG_MIGRATION_VERSION;

export const PROJECT_TAG_BUSINESS_TABLES = [
  'project_tag_groups',
  'project_tag_definitions',
  'project_tag_assignments',
] as const;

export const PROJECT_TAG_BUSINESS_REVISION_EVENTS = ['insert', 'update', 'delete'] as const;

export const projectTagBusinessRevisionTriggerName = (
  table: (typeof PROJECT_TAG_BUSINESS_TABLES)[number],
  event: (typeof PROJECT_TAG_BUSINESS_REVISION_EVENTS)[number],
): string => `trg_business_revision_${table}_${event}`;

/**
 * 标签表将名称以已 trim 的形式存储，UNIQUE 约束据此执行分组全局/组内唯一。
 * 迁移 runner 已在外层提供单事务；本函数不得自行开启事务。
 */
export function applyProjectTagMigration(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE project_tag_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE CHECK (name = trim(name) AND length(name) > 0),
      sort_order INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE project_tag_definitions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES project_tag_groups(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK (name = trim(name) AND length(name) > 0),
      sort_order INTEGER NOT NULL,
      UNIQUE (group_id, name)
    ) STRICT;

    CREATE TABLE project_tag_assignments (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES project_tag_definitions(id) ON DELETE RESTRICT,
      PRIMARY KEY (project_id, tag_id)
    ) STRICT;

    CREATE INDEX idx_project_tag_groups_sort ON project_tag_groups(sort_order, id);
    CREATE INDEX idx_project_tag_definitions_group_sort ON project_tag_definitions(group_id, sort_order, id);
    CREATE INDEX idx_project_tag_assignments_tag_project ON project_tag_assignments(tag_id, project_id);
  `);

  db.exec(`
    INSERT INTO project_tag_groups (id, name, sort_order) VALUES
      ('project-tag-group-project-type', '项目类型', 10),
      ('project-tag-group-service-type', '服务类型', 20),
      ('project-tag-group-special-instrument', '特殊仪器', 30)
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO project_tag_definitions (id, group_id, name, sort_order) VALUES
      ('project-tag-project-type-relocation', 'project-tag-group-project-type', '搬迁', 10),
      ('project-tag-project-type-pm', 'project-tag-group-project-type', 'PM', 20),
      ('project-tag-project-type-certification', 'project-tag-group-project-type', '认证', 30),
      ('project-tag-service-type-storage', 'project-tag-group-service-type', '暂存', 10),
      ('project-tag-special-instrument-lcms-tof-65', 'project-tag-group-special-instrument', 'LCMS TOF（65系列）', 10),
      ('project-tag-special-instrument-bso', 'project-tag-group-special-instrument', 'BSO', 20),
      ('project-tag-special-instrument-icpms', 'project-tag-group-special-instrument', 'ICPMS', 30)
    ON CONFLICT(id) DO NOTHING;
  `);

  for (const table of PROJECT_TAG_BUSINESS_TABLES) {
    for (const event of PROJECT_TAG_BUSINESS_REVISION_EVENTS) {
      db.exec(`
        CREATE TRIGGER ${projectTagBusinessRevisionTriggerName(table, event)}
        AFTER ${event.toUpperCase()} ON ${table}
        BEGIN
          UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1;
        END;
      `);
    }
  }
}
