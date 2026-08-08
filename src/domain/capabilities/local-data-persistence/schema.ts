import type { DatabaseSync } from 'node:sqlite';

/**
 * 初始 schema（v1）（tasks 1.9）。
 *
 * 覆盖 14 个能力的核心主数据表与事实表：
 * 账号（workbench-access）、客户/合同/项目（relocation-project-lifecycle）、
 * 批次/改批历史/仪器/上门活动与工作事实（relocation-execution）、
 * 开单（service-order-recording）、Ship-to/申请（ship-to-management）、
 * 序列号地址更新（serial-address-update）、损坏维修事项（damage-repair-tracking）、
 * 二维码申请/类型（qr-request-tracking）、项目提醒字段（workbench-todos）、
 * 掉票（project-financial-closure）、迁移审计（historical-data-import）、
 * 物流费用、系统设置（local-data-persistence）。
 *
 * 关键 ID 规则以唯一/部分唯一索引表达：
 * - 客户名称 trim 后全局唯一：customers.name UNIQUE（写前由领域服务 trim）。
 * - ECC 全局唯一（可空，待进单阶段无 ECC）：contracts.ecc 唯一索引。
 * - 非空服务单号全局唯一、四类共用唯一空间：service_orders(service_order_no)
 *   部分唯一索引（WHERE service_order_no IS NOT NULL）。
 * - 非空序列号在同一合同/其唯一搬迁项目内唯一、跨合同可重复：
 *   instruments(project_id, serial_no) 部分唯一索引。
 * - Account ID 全局唯一（Ship-to 创建后不可修改）：ship_tos.account_id 唯一索引。
 * - 每批次仅一笔实际物流费用：logistics_fees.batch_id UNIQUE。
 *
 * 金额一律以分整数（INTEGER）物理表示；时间以带偏移 ISO 字符串（TEXT）表示。
 * 可空的外键在导入/占位场景（如迁移导入、账号归属缺失）允许为 NULL。
 */
export function applyInitialSchema(db: DatabaseSync): void {
  db.exec(`
  -- workbench-access：单一本地账号（密码/恢复码均为 scrypt 派生值 + 独立随机盐）
  -- singleton=1 CHECK + 唯一索引在数据库层落实"禁止新增第二个账号"
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    recovery_code_hash TEXT,
    recovery_code_salt TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    singleton INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_singleton ON accounts(singleton);

  -- relocation-project-lifecycle：客户主数据（客户名称为 trim 后唯一业务标识）
  -- name_key 为 trim(name) 的生成列 + 唯一索引，在数据库层落实"去除首尾空白后全局唯一"
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL GENERATED ALWAYS AS (trim(name)) STORED UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- relocation-project-lifecycle：项目（待进单阶段合同可空，不强制合同草稿）
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    temp_no TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN (
      'pending_entry','pending_execution','executing','pending_acceptance','pending_invoice','completed','cancelled'
    )),
    pre_entry_execution INTEGER NOT NULL DEFAULT 0,
    scope_confirmed INTEGER NOT NULL DEFAULT 0,
    customer_id TEXT REFERENCES customers(id),
    contract_id TEXT REFERENCES contracts(id),
    entry_at TEXT,
    region TEXT,
    old_site_contact TEXT,
    new_site_contact TEXT,
    old_site_address TEXT,
    new_site_address TEXT,
    contract_start_date TEXT,
    contract_end_date TEXT,
    plan_visit_at TEXT,
    plan_transport_at TEXT,
    site_confirmed INTEGER NOT NULL DEFAULT 0,
    actual_install_done_at TEXT,
    acceptance_report INTEGER NOT NULL DEFAULT 0,
    acceptance_report_date TEXT,
    cancelled_at TEXT,
    cancel_reason TEXT,
    reminder_at TEXT,
    reminder_note TEXT,
    temporary_instrument_count INTEGER,
    manager_approval_reason TEXT,
    manager_approval_missing TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- relocation-project-lifecycle：合同（与项目 1:1；正式进单前必须补齐）
  CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
    temp_number TEXT NOT NULL,
    ecc TEXT,
    ecc_last_modified_at TEXT,
    usd_tax_amount_cents INTEGER,
    entry_amount_snapshot_cents INTEGER,
    final_confirmable_amount_cents INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_ecc ON contracts(ecc) WHERE ecc IS NOT NULL;

  -- relocation-execution：搬迁批次（报价层：计划运输日期、运输公司、人民币原价/折后价）
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    plan_transport_date TEXT,
    transport_company TEXT,
    original_price_cents INTEGER,
    discounted_price_cents INTEGER,
    started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- relocation-execution：搬迁仪器
  CREATE TABLE IF NOT EXISTS instruments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    batch_id TEXT REFERENCES batches(id),
    name TEXT NOT NULL,
    model TEXT,
    serial_no TEXT,
    ups INTEGER NOT NULL DEFAULT 0,
    qr_requested INTEGER NOT NULL DEFAULT 0,
    destination_ship_to_id TEXT REFERENCES ship_tos(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_instruments_project_serial
    ON instruments(project_id, serial_no) WHERE serial_no IS NOT NULL;

  -- relocation-execution：改批历史（运输开始前改批，TBD-03）
  CREATE TABLE IF NOT EXISTS batch_change_history (
    id TEXT PRIMARY KEY,
    instrument_id TEXT NOT NULL REFERENCES instruments(id),
    from_batch_id TEXT REFERENCES batches(id),
    to_batch_id TEXT REFERENCES batches(id),
    changed_at TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(id),
    username_snapshot TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  -- relocation-execution：上门活动与参与工程师
  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    visit_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS activity_engineers (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities(id),
    engineer TEXT NOT NULL
  ) STRICT;

  -- relocation-execution：活动 × 仪器 × 工作类型事实行（TBD-05）
  CREATE TABLE IF NOT EXISTS work_facts (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities(id),
    instrument_id TEXT NOT NULL REFERENCES instruments(id),
    work_type TEXT NOT NULL CHECK (work_type IN ('teardown','install','repair','other')),
    status TEXT NOT NULL CHECK (status IN ('in_progress','done')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (activity_id, instrument_id, work_type)
  ) STRICT;

  -- service-order-recording：四类开单（搬迁/认证/单寄备件/PM）
  CREATE TABLE IF NOT EXISTS service_orders (
    id TEXT PRIMARY KEY,
    order_type TEXT NOT NULL CHECK (order_type IN ('relocation','certification','parts_by_mail','pm')),
    service_order_no TEXT,
    ordered_at TEXT NOT NULL,
    engineer TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id),
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_no
    ON service_orders(service_order_no) WHERE service_order_no IS NOT NULL;

  -- ship-to-management：不可变 Ship-to 主数据（Account ID 唯一，创建后不可修改）
  CREATE TABLE IF NOT EXISTS ship_tos (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    new_site_address TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  -- ship-to-management：Ship-to 申请（线性状态，不支持退回或取消）
  CREATE TABLE IF NOT EXISTS ship_to_requests (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    new_site_address TEXT NOT NULL,
    account_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending_submit','processing','completed')),
    submitted_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ship_to_requests_account
    ON ship_to_requests(account_id) WHERE account_id IS NOT NULL;

  -- serial-address-update：序列号地址更新事实（逐台登记）
  CREATE TABLE IF NOT EXISTS serial_address_updates (
    id TEXT PRIMARY KEY,
    instrument_id TEXT REFERENCES instruments(id),
    customer_name TEXT NOT NULL,
    new_site_address TEXT NOT NULL,
    serial_no TEXT NOT NULL,
    account_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  -- damage-repair-tracking：损坏/维修事项（单备件，含备件申请时间与处理状态）
  CREATE TABLE IF NOT EXISTS damage_repair_items (
    id TEXT PRIMARY KEY,
    instrument_id TEXT NOT NULL REFERENCES instruments(id),
    damage_reason TEXT,
    issue_status TEXT NOT NULL CHECK (issue_status IN ('untreated','processing','repaired','closed_unrepaired')),
    close_reason TEXT,
    part_number TEXT,
    part_quantity INTEGER,
    part_amount_cents INTEGER,
    part_currency TEXT CHECK (part_currency IN ('USD','RMB')),
    part_requested_at TEXT,
    part_status TEXT CHECK (part_status IN ('pending_submit','processing','arrived','used')),
    repair_note TEXT,
    registered_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- damage-repair-tracking：维修上门活动 × 损坏/维修事项多对多关联（TBD-24）
  CREATE TABLE IF NOT EXISTS activity_damage_links (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities(id),
    damage_item_id TEXT NOT NULL REFERENCES damage_repair_items(id),
    created_at TEXT NOT NULL,
    UNIQUE (activity_id, damage_item_id)
  ) STRICT;

  -- qr-request-tracking：二维码申请（独立模块，不关联仪器/项目，不设状态）
  CREATE TABLE IF NOT EXISTS qr_requests (
    id TEXT PRIMARY KEY,
    applicant TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS qr_request_types (
    id TEXT PRIMARY KEY,
    qr_request_id TEXT NOT NULL REFERENCES qr_requests(id),
    type_code TEXT NOT NULL,
    UNIQUE (qr_request_id, type_code)
  ) STRICT;

  -- relocation-execution：实际物流费用（每批次仅一笔；三项人民币金额必填且 > 0）
  CREATE TABLE IF NOT EXISTS logistics_fees (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id),
    applied_at TEXT NOT NULL,
    budget_price_cents INTEGER NOT NULL,
    deal_price_cents INTEGER NOT NULL,
    logistics_cost_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- project-financial-closure：掉票记录（不可物理删除；撤销后为终态）
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    amount_cents INTEGER NOT NULL,
    invoiced_at TEXT NOT NULL,
    revoked_at TEXT,
    revoke_reason TEXT,
    last_modified_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  -- workbench-todos：临期窗口等可配置项（默认 7 个自然日，规则见 6.3）
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- historical-data-import：迁移审计（导入时间只作审计字段，绝不替代源业务时间）
  CREATE TABLE IF NOT EXISTS migration_audit (
    id TEXT PRIMARY KEY,
    batch_key TEXT NOT NULL,
    file_name TEXT,
    sheet TEXT,
    row_number INTEGER,
    ecc TEXT,
    status TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
    imported_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    error_details TEXT,
    operator TEXT,
    imported_at TEXT NOT NULL
  ) STRICT;
  `);
}

/** 初始 schema 版本（PRAGMA user_version）。 */
export const INITIAL_SCHEMA_VERSION = 1;

export function schemaTableNames(): string[] {
  return [
    'accounts',
    'customers',
    'projects',
    'contracts',
    'batches',
    'instruments',
    'batch_change_history',
    'activities',
    'activity_engineers',
    'work_facts',
    'service_orders',
    'ship_tos',
    'ship_to_requests',
    'serial_address_updates',
    'damage_repair_items',
    'activity_damage_links',
    'qr_requests',
    'qr_request_types',
    'logistics_fees',
    'invoices',
    'app_settings',
    'migration_audit',
  ];
}
