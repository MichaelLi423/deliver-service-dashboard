import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v11：正式迁移运行审计（tasks 8.16 / design D27，Gate2 Lane B）。
 *
 * - import_run：每次「封存计划正式提交」一条运行记录（审计，非业务表，无业务修订触发器）；
 *   - operation_id 唯一：双击/重复 IPC/恢复后的相同请求只能产生一个成功运行（8.38）；
 *   - plan_digest + 模板/映射/校验规则版本 + 七类计划/写入数：与 validation seal 同源，
 *     提交前核验、提交后对账；
 *   - actor account id + 确认时用户名快照：用户名以后修改不改变历史审计；
 *   - started/confirmed/committed 时间与 result、pre/post business_revision：
 *     判定「成功审计 + 完整事务同时存在才成功」；
 * - 该表写入不参与业务修订（审计/元数据，同 migration_audit / import_record_audit）。
 */

export const IMPORT_RUN_AUDIT_MIGRATION_VERSION = 11;

export const IMPORT_RUN_STATUSES = [
  'running',
  'confirmed',
  'succeeded',
  'rolled_back',
  'unknown',
] as const;

export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];

export function applyImportRunAuditMigration(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_run (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      draft_id TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      template_version TEXT,
      mapping_version TEXT,
      validation_version TEXT,
      account_id TEXT,
      username_snapshot TEXT,
      started_at TEXT NOT NULL,
      confirmed_at TEXT,
      committed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','confirmed','succeeded','rolled_back','unknown')),
      plan_project INTEGER NOT NULL DEFAULT 0,
      plan_service_order INTEGER NOT NULL DEFAULT 0,
      plan_invoice INTEGER NOT NULL DEFAULT 0,
      plan_logistics_fee INTEGER NOT NULL DEFAULT 0,
      plan_serial_address_update INTEGER NOT NULL DEFAULT 0,
      plan_qr_request INTEGER NOT NULL DEFAULT 0,
      plan_ship_to_request INTEGER NOT NULL DEFAULT 0,
      written_project INTEGER NOT NULL DEFAULT 0,
      written_service_order INTEGER NOT NULL DEFAULT 0,
      written_invoice INTEGER NOT NULL DEFAULT 0,
      written_logistics_fee INTEGER NOT NULL DEFAULT 0,
      written_serial_address_update INTEGER NOT NULL DEFAULT 0,
      written_qr_request INTEGER NOT NULL DEFAULT 0,
      written_ship_to_request INTEGER NOT NULL DEFAULT 0,
      pre_business_revision INTEGER NOT NULL DEFAULT 0,
      post_business_revision INTEGER,
      result TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_import_run_draft ON import_run(draft_id);
    CREATE INDEX IF NOT EXISTS idx_import_run_status ON import_run(status);
  `);
}
