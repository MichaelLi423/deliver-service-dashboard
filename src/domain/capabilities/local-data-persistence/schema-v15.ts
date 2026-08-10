import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v15：搬迁工作台 0810 现场反馈新增字段（design D1）+ 后续 Tasks
 * 3.2/4.4/5.1/5.4 的最小持久化支撑（只建结构，不写业务数据、不改写存量值）。
 *
 * 一、搬迁工作台新增字段（design D1）：
 * - projects.project_note：项目备注（可空）。
 * - projects.temporary_storage_address：暂存地址（可空）。
 * - projects.is_temporary_storage：是否暂存（可空 INTEGER；空表示"未填写"而非推断"否"）。
 * - projects.manager_approved：是否批复（可空 INTEGER；承接既有 manager_approval_reason/
 *   manager_approval_missing 的"是否批复"语义，legacy 批复原因/缺失资料列保留可读不改）。
 * - "计划装机日期"复用既有 planned_install_done_at（v14 已建），只改领域/UI 标签为
 *   "计划装机日期"，不新建计划装机列。
 *
 * 二、后续任务的最小持久化支撑（只建结构，任务实现时再写入）：
 * - project_status_transition_audit：项目状态转换审计表（Tasks 3.2 自动推进幂等/审计；
 *   每行一次真实转换：from/to、reason、生效业务日期、source 与操作者快照）。
 * - record_deletion_audit：通用记录删除 tombstone/审计表（Tasks 5.1 删除分发原子审计；
 *   只存 record_type/id、operation、操作者、时间与原子清理的关联子记录计数，
 *   不复制客户值）。
 * - financial_integrity_cleanup_audit：财务完整性治理清理审计表（Tasks 4.4；
 *   备份/确认前置后的结果审计，仅计数不存值：before/after 五类诊断计数、
 *   治理撤销数、unresolved 数、backup_id、操作者、时间与结果）。
 * - import_record_audit 追加可空 deleted marker 字段（target_deleted_at、
 *   target_delete_operation_id；Tasks 5.1：import-source 审计保留并标记指向已删除
 *   记录而非擦除，target_delete_operation_id 对应 record_deletion_audit.operation_id）。
 * - ship_tos.origin_request_id：可空来源字段（Tasks 5.4 Ship-to 申请删除策略；
 *   引用 ship_to_requests(id)，部分唯一索引；legacy 保持 null、不按 Account ID 猜测回填）。
 *
 * 区域枚举（East|South|West|Central|North）在领域写边界落实（design D1：存量非枚举
 * region 原文保留、不猜测映射、不置空），本迁移不追加库级 region 约束，legacy region
 * 文本原样保留。
 *
 * 全部为新增可空列/新表/索引，不重建表、不改写存量业务值；存量行不受影响。
 */

export const RELOCATION_WORKBENCH_MIGRATION_VERSION = 15;

/** v15 新增且不参与 business_revision 的审计表。 */
export const RELOCATION_WORKBENCH_NON_BUSINESS_TABLES = [
  'project_status_transition_audit',
  'record_deletion_audit',
  'financial_integrity_cleanup_audit',
] as const;

export function applyRelocationWorkbenchFieldsMigration(db: DatabaseSync): void {
  db.exec(`
    -- 一、搬迁工作台 0810 新增字段（design D1；只新增可空列，存量行不受影响）
    ALTER TABLE projects ADD COLUMN project_note TEXT;
    ALTER TABLE projects ADD COLUMN temporary_storage_address TEXT;
    ALTER TABLE projects ADD COLUMN is_temporary_storage INTEGER;
    ALTER TABLE projects ADD COLUMN manager_approved INTEGER;

    -- 二、Tasks 3.2：项目状态转换审计表
    -- 仅真实转换写入一行；from_status 可空表示无前状态（如首次建档），状态枚举与
    -- projects.status 一致；effective_business_date 为转换生效业务日期 yyyy-mm-dd，
    -- created_at 为审计 ISO。
    CREATE TABLE IF NOT EXISTS project_status_transition_audit (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      from_status TEXT CHECK (from_status IN (
        'pending_entry','pending_execution','executing','pending_acceptance','pending_invoice','completed','cancelled'
      )),
      to_status TEXT NOT NULL CHECK (to_status IN (
        'pending_entry','pending_execution','executing','pending_acceptance','pending_invoice','completed','cancelled'
      )),
      reason TEXT,
      effective_business_date TEXT,
      source TEXT,
      actor_id TEXT REFERENCES accounts(id),
      actor_username_snapshot TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_project_status_transition_project_time
      ON project_status_transition_audit(project_id, created_at, id);

    -- 二、Tasks 5.1：通用记录删除 tombstone/审计表
    -- 最小事实：record type/id、operation、操作者、时间与原子清理的关联子记录计数；
    -- 不复制任何客户值。
    CREATE TABLE IF NOT EXISTS record_deletion_audit (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      owned_child_count INTEGER NOT NULL DEFAULT 0,
      actor_id TEXT REFERENCES accounts(id),
      actor_username_snapshot TEXT,
      deleted_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_record_deletion_audit_record
      ON record_deletion_audit(record_type, record_id);
    CREATE INDEX IF NOT EXISTS idx_record_deletion_audit_operation
      ON record_deletion_audit(operation_id);

    -- 二、Tasks 4.4：财务完整性治理清理审计表
    -- 仅计数不存值：before/after 五类诊断计数（孤立合同/孤立掉票/孤立最终可确认金额
    -- 事实/断裂 project-contract 链接/foreign_key_check 违规）、治理撤销数、
    -- unresolved 数、backup_id、操作者、时间与结果。
    CREATE TABLE IF NOT EXISTS financial_integrity_cleanup_audit (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      backup_id TEXT,
      orphan_contracts_before_count INTEGER NOT NULL DEFAULT 0,
      orphan_contracts_after_count INTEGER NOT NULL DEFAULT 0,
      orphan_invoices_before_count INTEGER NOT NULL DEFAULT 0,
      orphan_invoices_after_count INTEGER NOT NULL DEFAULT 0,
      orphan_final_confirmable_facts_before_count INTEGER NOT NULL DEFAULT 0,
      orphan_final_confirmable_facts_after_count INTEGER NOT NULL DEFAULT 0,
      broken_project_links_before_count INTEGER NOT NULL DEFAULT 0,
      broken_project_links_after_count INTEGER NOT NULL DEFAULT 0,
      foreign_key_violations_before_count INTEGER NOT NULL DEFAULT 0,
      foreign_key_violations_after_count INTEGER NOT NULL DEFAULT 0,
      governance_revoked_count INTEGER NOT NULL DEFAULT 0,
      unresolved_count INTEGER NOT NULL DEFAULT 0,
      actor_id TEXT REFERENCES accounts(id),
      actor_username_snapshot TEXT,
      result TEXT NOT NULL CHECK (result IN ('succeeded','failed')),
      cleaned_at TEXT NOT NULL
    ) STRICT;

    -- 二、Tasks 5.1：import_record_audit 可空 deleted marker
    -- import-source 审计保留，标记目标已删除而非擦除；
    -- target_delete_operation_id 对应 record_deletion_audit.operation_id。
    ALTER TABLE import_record_audit ADD COLUMN target_deleted_at TEXT;
    ALTER TABLE import_record_audit ADD COLUMN target_delete_operation_id TEXT;

    -- 二、Tasks 5.4：ship_tos 可空来源字段
    -- 仅由 Ship-to 申请产生时回填；legacy 保持 null、不按 Account ID 猜测；
    -- 部分唯一索引允许多个 NULL 存量行。
    ALTER TABLE ship_tos ADD COLUMN origin_request_id TEXT REFERENCES ship_to_requests(id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ship_tos_origin_request
      ON ship_tos(origin_request_id) WHERE origin_request_id IS NOT NULL;
  `);
}
