import type { DatabaseSync } from 'node:sqlite';

/**
 * 导入工作区 schema（design D20 / tasks 8.9）。
 *
 * app-private 独立数据库，与正式业务库物理隔离。覆盖：草稿、修订、
 * 七类规范化行/单元格、来源、列映射、冲突决定、问题、operation 进度、
 * validation seal。成功/取消后清除敏感行（rows/cells），仅保留摘要。
 */

export const WORKSPACE_SCHEMA_VERSION = 6;

export const WORKSPACE_TABLES: readonly string[] = [
  'workspace_drafts',
  'workspace_draft_revisions',
  'workspace_sources',
  'workspace_rows',
  'workspace_cells',
  'workspace_mappings',
  'workspace_conflict_decisions',
  'workspace_issues',
  'workspace_operations',
  'workspace_seals',
  'workspace_checkpoints',
  'workspace_category_modes',
  'workspace_sheet_classifications',
];

export function applyWorkspaceInitialSchema(db: DatabaseSync): void {
  db.exec(`
  -- 草稿（design D20：app-private 导入工作区，与正式业务库物理隔离）
  CREATE TABLE IF NOT EXISTS workspace_drafts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('draft','parsing','needs_review','validating','sealed','committing','succeeded','cancelled')),
    revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_by_username TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_saved_at TEXT NOT NULL,
    pending_outcome INTEGER NOT NULL DEFAULT 0,
    row_count_summary TEXT NOT NULL DEFAULT '{}'
  ) STRICT;

  -- 草稿修订（乐观并发：每个保存点一条修订，运行态重启恢复到最后稳定修订）
  CREATE TABLE IF NOT EXISTS workspace_draft_revisions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    note TEXT,
    UNIQUE (draft_id, revision)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_revisions_draft ON workspace_draft_revisions(draft_id, revision);

  -- 输入来源（文件/粘贴元数据：文件、sheet、摘要、行数，不含业务值）
  CREATE TABLE IF NOT EXISTS workspace_sources (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('file','paste')),
    source_file TEXT NOT NULL,
    sheet TEXT,
    source_hash TEXT,
    row_count INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_sources_draft ON workspace_sources(draft_id);

  -- 七类规范化行（project/service_order/invoice/logistics_fee/serial_address_update/qr_request/ship_to_request）
  CREATE TABLE IF NOT EXISTS workspace_rows (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('project','service_order','invoice','logistics_fee','serial_address_update','qr_request','ship_to_request')),
    sort_key INTEGER NOT NULL,
    source_row_id TEXT,
    business_key TEXT,
    source_file TEXT,
    source_sheet TEXT,
    source_row INTEGER,
    paste_batch TEXT,
    grid_row INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_rows_draft_category ON workspace_rows(draft_id, category, sort_key);
  CREATE INDEX IF NOT EXISTS idx_ws_rows_business ON workspace_rows(draft_id, business_key);

  -- 规范化单元格（稀疏 cell patch 落点；值以字符串精确保存，前导零标识符不转数值）
  CREATE TABLE IF NOT EXISTS workspace_cells (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    row_id TEXT NOT NULL REFERENCES workspace_rows(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    UNIQUE (draft_id, row_id, field)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_cells_row ON workspace_cells(row_id);

  -- 列映射（模板/文件/粘贴共用目标字段；无相似名称模糊猜测）
  CREATE TABLE IF NOT EXISTS workspace_mappings (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    source_column TEXT NOT NULL,
    target_field TEXT,
    mapping_state TEXT NOT NULL CHECK (mapping_state IN ('exact','alias','pending','ignored')),
    sample_value TEXT,
    priority INTEGER,
    source_priority TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_mappings_draft ON workspace_mappings(draft_id);

  -- 冲突决定（design D24：只能选择合法候选/修正/排除，不能绕过领域规则）
  CREATE TABLE IF NOT EXISTS workspace_conflict_decisions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    row_id TEXT,
    field TEXT NOT NULL,
    decision_type TEXT NOT NULL CHECK (decision_type IN ('choose_candidate','fix_value','exclude')),
    chosen_value TEXT,
    resolved_by TEXT,
    resolved_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_decisions_draft ON workspace_conflict_decisions(draft_id);

  -- 校验问题（error/conflict/warning，design D24：统一可定位问题模型）
  CREATE TABLE IF NOT EXISTS workspace_issues (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('error','conflict','warning')),
    issue_code TEXT NOT NULL,
    category TEXT,
    row_id TEXT,
    field TEXT,
    business_key TEXT,
    grid_row INTEGER,
    source_position TEXT,
    message TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_issues_draft ON workspace_issues(draft_id, severity, resolved);

  -- operation 进度（解析/完整校验/提交；支持进度订阅与取消，design D23）
  CREATE TABLE IF NOT EXISTS workspace_operations (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('parsing','validating','committing')),
    state TEXT NOT NULL CHECK (state IN ('running','cancelled','completed','failed')),
    stage TEXT,
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    result TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_ops_draft ON workspace_operations(draft_id);

  -- 校验封存（design D25：绑定 plan digest、模板/映射/校验版本、冲突决定摘要、
  -- 目标 schema 版本与业务修订；任一输入/规则/目标变化使 seal 失效）
  CREATE TABLE IF NOT EXISTS workspace_seals (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
    plan_digest TEXT NOT NULL,
    template_version TEXT,
    mapping_version TEXT,
    validation_version TEXT,
    conflict_decision_digest TEXT,
    target_schema_version INTEGER,
    target_business_revision TEXT,
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid')),
    created_at TEXT NOT NULL,
    invalidated_at TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_ws_seals_draft ON workspace_seals(draft_id);
  `);
}

/**
 * 工作区 schema v2（tasks 8.35）：校验封存绑定草稿修订与正式库身份。
 *
 * 为 workspace_seals 补充 draft_revision（生成 seal 时的草稿修订）、
 * database_instance_id 与 content_generation_id（正式库身份，恢复/重建后变化），
 * 使 seal 对「任一草稿或目标变化」都可验失效。
 */
export function applyWorkspaceSealBindingMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE workspace_seals ADD COLUMN draft_revision INTEGER;
    ALTER TABLE workspace_seals ADD COLUMN database_instance_id TEXT;
    ALTER TABLE workspace_seals ADD COLUMN content_generation_id TEXT;
  `);
}

/**
 * 工作区 schema v3（tasks 8.59/8.66）：磁盘型 undo checkpoint。
 *
 * - workspace_checkpoints：每次原子保存草稿可变状态（rows/cells/sources/mappings/
 *   conflict_decisions/issues + category modes）与 base revision 的 JSON 快照；
 *   renderer 不保存全量，只经 IPC 触发 checkpoint / undo / redo；
 * - pre/post 成对（pair_id 共享）：编辑前建 pre、成功后建 post，undo 恢复 pre、
 *   redo 恢复 post；恢复以 expected revision 做并发保护、产生新 revision 并失效 seal；
 * - 有界保留：每草稿保留最近 N 份（N 见 workspace-repository 常量），超出清理最旧；
 * - 成功/取消/删除草稿时清除 checkpoint 敏感值（rows/cells 等随快照一并清理）。
 */
export const WORKSPACE_CHECKPOINTS_TABLE = 'workspace_checkpoints';

export function applyWorkspaceCheckpointMigration(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_checkpoints (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
      base_revision INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pre','post','manual')),
      pair_id TEXT,
      label TEXT,
      snapshot TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','undone')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_ws_checkpoints_draft ON workspace_checkpoints(draft_id, base_revision);
  `);
}

/**
 * 工作区 schema v4（Oracle 复审 #2）：category modes 与 sheet classification
 * 从 facade 侧边文件迁入 revisioned 工作区表（每次修改推进草稿修订、invalidate seal、
 * 纳入 checkpoint 快照 / conflict digest / seal）。侧边文件仅保留 UI step。
 */
export function applyWorkspaceModesMigration(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_category_modes (
      draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('project','service_order','invoice','logistics_fee','serial_address_update','qr_request','ship_to_request')),
      mode TEXT NOT NULL CHECK (mode IN ('data','none')),
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (draft_id, category)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workspace_sheet_classifications (
      draft_id TEXT NOT NULL REFERENCES workspace_drafts(id) ON DELETE CASCADE,
      sheet_key TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('project','service_order','invoice','logistics_fee','serial_address_update','qr_request','ship_to_request')),
      excluded INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (draft_id, sheet_key)
    ) STRICT;
  `);
}

/**
 * 工作区 schema v5（Oracle 二次复审 #2/#3）：
 * - workspace_rows.excluded：sheet 归类为 excluded 的源行标记排除（不进入 normalizedRows/计划/seal/commit）；
 * - workspace_checkpoints.undone_at：redo 按「撤销时间序」恢复（undo B → undo A → redo A → redo B）。
 */
export function applyWorkspaceExcludedAndRedoMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE workspace_rows ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE workspace_checkpoints ADD COLUMN undone_at TEXT;
    ALTER TABLE workspace_checkpoints ADD COLUMN undo_seq INTEGER;
    CREATE INDEX IF NOT EXISTS idx_ws_rows_excluded ON workspace_rows(draft_id, excluded);
  `);
  // Oracle 最终复核 #3：为 v4 既有 undone checkpoint 确定性回填 undo_seq（按 base_revision/created_at/rowid
  // 排序，redo 严格按实际撤销顺序）。纯计数不依赖更新顺序，跨运行确定。
  db.exec(`
    UPDATE workspace_checkpoints SET undo_seq = (
      SELECT 1 + COUNT(*) FROM workspace_checkpoints c2
      WHERE c2.state = 'undone'
        AND c2.draft_id = workspace_checkpoints.draft_id
        AND (
          c2.base_revision < workspace_checkpoints.base_revision
          OR (c2.base_revision = workspace_checkpoints.base_revision AND c2.created_at < workspace_checkpoints.created_at)
          OR (c2.base_revision = workspace_checkpoints.base_revision AND c2.created_at = workspace_checkpoints.created_at AND c2.rowid < workspace_checkpoints.rowid)
        )
    ) WHERE state = 'undone' AND undo_seq IS NULL;
  `);
}

/**
 * 工作区 schema v6（Oracle 最终复核 #1）：sheet 来源身份安全化。
 * workspace_sheet_classifications 增加独立 file/sheet 列（不再依赖未转义 `file#sheet` 拆分）；
 * 既有 sheet_key 按首个 '#' 回填（兼容已有草稿/分类），新写入使用百分号编码的规范键。
 */
export function applyWorkspaceSheetIdentityMigration(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE workspace_sheet_classifications ADD COLUMN file TEXT;
    ALTER TABLE workspace_sheet_classifications ADD COLUMN sheet TEXT;
    UPDATE workspace_sheet_classifications SET
      file = CASE WHEN instr(sheet_key, '#') > 0 THEN substr(sheet_key, 1, instr(sheet_key, '#') - 1) ELSE sheet_key END,
      sheet = CASE WHEN instr(sheet_key, '#') > 0 THEN substr(sheet_key, instr(sheet_key, '#') + 1) ELSE '' END
      WHERE file IS NULL;
  `);
}
