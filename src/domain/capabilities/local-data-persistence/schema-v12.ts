import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v12：工作台 v2 有界读取的支撑索引（Oracle #10）。
 *
 * 只新增索引，不重建表、不改业务数据：
 * - projects：keyset 分页（updated_at/id 稳定游标）、状态、区域、提醒过滤；
 * - 子表 project/time：详情计数与当前 tab 子记录分页；
 * - invoices active：待掉票金额聚合 / 每项目活跃掉票子查询（部分索引只含未撤销）；
 * - 独立模块（序列号地址更新 / 二维码申请）与 lookup（Ship-to 申请 / 客户）分页。
 *
 * v2 读取仓储（workbench-read-repository）依赖这些索引把首屏/分页查询限制为
 * 有界行集，禁止全量 listAll 与 JS P×C（Oracle #10 约束）。
 */

export const READ_INDEX_MIGRATION_VERSION = 12;

export function applyReadIndexMigration(db: DatabaseSync): void {
  db.exec(`
    -- projects：默认/状态/区域/提醒的 keyset 分页与过滤
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_region ON projects(region, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_reminder ON projects(reminder_at);

    -- 子表 project/time：详情计数与当前 tab 子记录分页
    CREATE INDEX IF NOT EXISTS idx_batches_project_time ON batches(project_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_instruments_project_time ON instruments(project_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_activities_project_time ON activities(project_id, visit_at, id);
    CREATE INDEX IF NOT EXISTS idx_service_orders_project_time ON service_orders(project_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_damage_repair_project_time ON damage_repair_items(project_id, created_at, id);

    -- invoices：活跃掉票（未撤销）部分索引 + 项目时间分页
    CREATE INDEX IF NOT EXISTS idx_invoices_project_active ON invoices(project_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_invoices_project_time ON invoices(project_id, created_at, id);

    -- 独立模块分页（序列号地址更新 / 二维码申请）
    CREATE INDEX IF NOT EXISTS idx_serial_address_updates_time ON serial_address_updates(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_qr_requests_time ON qr_requests(created_at, id);

    -- lookup 分页（Ship-to 申请按客户 / 客户按名称）
    CREATE INDEX IF NOT EXISTS idx_ship_to_requests_customer_time ON ship_to_requests(customer_name, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
  `);
}
