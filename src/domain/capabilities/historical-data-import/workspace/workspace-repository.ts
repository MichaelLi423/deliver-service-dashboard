import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SystemClock, type Clock } from '../../../core/time';
import {
  IMPORT_CATEGORIES,
  type AppendRowInput,
  type CellPatch,
  type CheckpointInput,
  type CheckpointKind,
  type CheckpointRestoreResult,
  type CheckpointState,
  type CheckpointSummary,
  type ColumnMapping,
  type ConflictDecision,
  type ConflictDecisionInput,
  type CreateDraftInput,
  type DraftDetail,
  type DraftSummary,
  type ImportCategory,
  type ImportIssue,
  type IssueInput,
  type IssueQuery,
  type OperationKind,
  type OperationProgress,
  type OperationState,
  type OperationUpdate,
  type RecoveryReport,
  type RowQuery,
  type RowWindow,
  type SourceInput,
  type ValidationSealInput,
  type ValidationSealRecord,
  type WorkspaceRow,
  type WorkspaceSource,
} from './workspace-model';
import { transitionState as applyTransition } from './workspace-state';
import type { WorkspaceDraftEvent, WorkspaceDraftState } from './workspace-state';
import {
  mapWorkspaceDbError,
  RevisionConflictError,
  WorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceStateError,
} from './workspace-errors';

/**
 * 草稿仓储（design D23 / tasks 8.12~8.14）。
 *
 * - 创建/列出/读取/删除草稿；
 * - 乐观修订号：每次保存（patch/追加/状态转换/问题/seal）都使修订号单调递增，
 *   提交方携带期望修订号，不匹配时抛 RevisionConflictError（禁止覆盖较新草稿）；
 * - 稀疏 cell patch：只更新变更单元格，返回新修订号作为自动保存结果；
 * - 按类别窗口分页/筛选：renderer 不持有整份大草稿；
 * - 运行态重启恢复（parsing/validating 回到最后稳定修订，committing 标记待核对结果）。
 * 本仓储只操作工作区连接，绝不接触正式业务库。
 */

interface WorkspaceDraftRow {
  id: string;
  name: string;
  state: WorkspaceDraftState;
  revision: number;
  created_by: string | null;
  created_by_username: string | null;
  created_at: string;
  updated_at: string;
  last_saved_at: string;
  pending_outcome: number;
  row_count_summary: string;
}

interface RowDbRow {
  id: string;
  revision: number;
  category: ImportCategory;
  sort_key: number;
  grid_row: number;
  source_row_id: string | null;
  business_key: string | null;
  source_file: string | null;
  source_sheet: string | null;
  source_row: number | null;
  paste_batch: string | null;
  excluded: number;
}

interface IssueRow {
  id: string;
  draft_id: string;
  revision: number;
  severity: ImportIssue['severity'];
  issue_code: string;
  category: ImportCategory | null;
  row_id: string | null;
  field: string | null;
  business_key: string | null;
  grid_row: number | null;
  source_position: string | null;
  message: string;
  resolved: number;
}

interface OperationRow {
  id: string;
  draft_id: string;
  kind: OperationKind;
  state: OperationState;
  stage: string | null;
  progress_current: number;
  progress_total: number | null;
  started_at: string;
  finished_at: string | null;
  result: string | null;
}

interface SealRow {
  id: string;
  draft_id: string;
  plan_digest: string;
  draft_revision: number;
  template_version: string | null;
  mapping_version: string | null;
  validation_version: string | null;
  conflict_decision_digest: string | null;
  target_schema_version: number | null;
  target_business_revision: string | null;
  database_instance_id: string | null;
  content_generation_id: string | null;
  status: 'valid' | 'invalid';
  created_at: string;
  invalidated_at: string | null;
}

interface CheckpointRow {
  id: string;
  draft_id: string;
  base_revision: number;
  kind: CheckpointKind;
  pair_id: string | null;
  label: string | null;
  snapshot: string;
  state: CheckpointState;
  undone_at: string | null;
  undo_seq: number | null;
  created_at: string;
}

/** checkpoint 快照（磁盘 JSON；原子保存草稿可变状态与 base revision）。 */
interface CheckpointSnapshot {
  baseRevision: number;
  modes: Record<ImportCategory, 'data' | 'none'>;
  rows: Array<{
    rowId: string;
    category: ImportCategory;
    sortKey: number;
    gridRow: number;
    sourceRowId: string | null;
    businessKey: string | null;
    sourceFile: string | null;
    sourceSheet: string | null;
    sourceRow: number | null;
    pasteBatch: string | null;
    excluded: boolean;
    cells: Record<string, string | null>;
  }>;
  sources: Array<{
    sourceKind: 'file' | 'paste';
    sourceFile: string;
    sheet: string | null;
    sourceHash: string | null;
    rowCount: number;
    addedAt: string;
  }>;
  mappings: ColumnMapping[];
  conflictDecisions: ConflictDecision[];
  issues: Array<Omit<ImportIssue, 'revision'>>;
  sheetClassifications: Array<{ file: string; sheet: string; classification: ImportCategory | 'excluded' }>;
}

/** 每草稿 checkpoint 有界保留份数（超出清理最旧；敏感快照不长期膨胀）。 */
export const MAX_CHECKPOINTS_PER_DRAFT = 20;

/** 规范 sheet 标识：百分号编码后以 '#' 连接（文件/表名含 '#' 也不会歧义）。 */
export function encodeSheetId(file: string, sheet: string): string {
  return `${encodeURIComponent(file)}#${encodeURIComponent(sheet ?? '')}`;
}

/** 解码规范 sheet 标识 → [file, sheet]。 */
export function decodeSheetId(sheetId: string): [string, string] {
  const separator = sheetId.indexOf('#');
  if (separator === -1) return [decodeURIComponent(sheetId), ''];
  return [decodeURIComponent(sheetId.slice(0, separator)), decodeURIComponent(sheetId.slice(separator + 1))];
}

/** 内存 Map 键：结构化 (file, sheet) 精确匹配（不解析字符串）。 */
function sourceKeyOf(file: string, sheet: string): string {
  return JSON.stringify([file, sheet ?? '']);
}

function emptyRowCounts(): Record<ImportCategory, number> {
  const counts = {} as Record<ImportCategory, number>;
  for (const c of IMPORT_CATEGORIES) counts[c] = 0;
  return counts;
}

export class WorkspaceRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: Clock = new SystemClock(),
  ) {}

  // ---------------------------------------------------------------- 草稿生命周期

  createDraft(input: CreateDraftInput): DraftSummary {
    const id = randomUUID();
    const nowIso = this.now.nowIso();
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspace_drafts (
             id, name, state, revision, created_by, created_by_username,
             created_at, updated_at, last_saved_at, pending_outcome, row_count_summary
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.name, 'draft', 1, input.createdBy, input.createdByUsername, nowIso, nowIso, nowIso, 0, '{}');
      this.insertRevisionRow(id, 1, 'draft', '创建草稿', nowIso);
    });
    return this.getDraft(id) as DraftSummary;
  }

  listDrafts(): DraftSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_drafts ORDER BY updated_at DESC, id')
      .all() as unknown as WorkspaceDraftRow[];
    return rows.map((r) => this.toSummary(r));
  }

  getDraft(id: string): DraftDetail | undefined {
    const row = this.selectDraftRow(id);
    return row ? this.toDetail(row) : undefined;
  }

  deleteDraft(id: string): void {
    this.inTransaction(() => {
      // 级联删除全部工作区内容（rows/cells/来源/映射/冲突/问题/operation/seal/修订）。
      this.db.prepare('DELETE FROM workspace_drafts WHERE id = ?').run(id);
    });
  }

  updateDraftName(id: string, expectedRevision: number, name: string): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(id);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.db.prepare('UPDATE workspace_drafts SET name = ? WHERE id = ?').run(name, id);
      if (invalidateSeal) this.invalidateSealRows(id, nowIso);
      this.writeRevision(id, newRev, newState, `重命名草稿为「${name}」`, nowIso);
      return newRev;
    });
  }

  // ---------------------------------------------------------------- 规范化行

  appendRows(draftId: string, expectedRevision: number, category: ImportCategory, rows: AppendRowInput[]): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      const startKey = (
        this.db
          .prepare('SELECT COALESCE(MAX(sort_key),0) AS k FROM workspace_rows WHERE draft_id=? AND category=?')
          .get(draftId, category) as { k: number }
      ).k;
      const startGrid = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM workspace_rows WHERE draft_id=? AND category=?')
          .get(draftId, category) as { n: number }
      ).n;
      const rowInsert = this.db.prepare(
        `INSERT INTO workspace_rows (
           id, draft_id, revision, category, sort_key, source_row_id, business_key,
           source_file, source_sheet, source_row, paste_batch, grid_row, excluded
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const cellInsert = this.db.prepare(
        'INSERT INTO workspace_cells (id, draft_id, row_id, revision, field, value) VALUES (?,?,?,?,?,?)',
      );
      // Oracle 最终复核 #1：excluded 约束同一 (sourceFile, sourceSheet) 的后续追加行。
      const excludedSources = this.excludedSourceKeys(draftId);
      let sortKey = startKey;
      let gridRow = startGrid;
      for (const row of rows) {
        sortKey += 1;
        gridRow += 1;
        rowInsert.run(
          row.rowId,
          draftId,
          newRev,
          category,
          sortKey,
          row.sourceRowId ?? null,
          row.businessKey ?? null,
          row.sourceFile ?? null,
          row.sourceSheet ?? null,
          row.sourceRow ?? null,
          row.pasteBatch ?? null,
          gridRow,
          excludedSources.has(sourceKeyOf(row.sourceFile ?? '', row.sourceSheet ?? '')) ? 1 : 0,
        );
        for (const [field, value] of Object.entries(row.cells ?? {})) {
          cellInsert.run(randomUUID(), draftId, row.rowId, newRev, field, value);
        }
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `按块追加 ${rows.length} 行 ${category}`, nowIso);
      return newRev;
    });
  }

  /** 稀疏 cell patch：乐观修订检查 + 仅更新变更单元格。 */
  patchCells(draftId: string, expectedRevision: number, patches: CellPatch[]): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      const upsert = this.db.prepare(
        `INSERT INTO workspace_cells (id, draft_id, row_id, revision, field, value) VALUES (?,?,?,?,?,?)
         ON CONFLICT(draft_id, row_id, field) DO UPDATE SET value=excluded.value, revision=excluded.revision`,
      );
      for (const patch of patches) {
        this.assertRowBelongs(draftId, patch.rowId);
        upsert.run(randomUUID(), draftId, patch.rowId, newRev, patch.field, patch.value);
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `稀疏 cell patch ${patches.length} 个单元格`, nowIso);
      return newRev;
    });
  }

  deleteRows(draftId: string, expectedRevision: number, rowIds: string[]): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      for (const rowId of rowIds) {
        this.assertRowBelongs(draftId, rowId);
        this.db.prepare('DELETE FROM workspace_cells WHERE row_id = ?').run(rowId);
        this.db.prepare('DELETE FROM workspace_issues WHERE row_id = ?').run(rowId);
        this.db.prepare('DELETE FROM workspace_conflict_decisions WHERE row_id = ?').run(rowId);
        this.db.prepare('DELETE FROM workspace_rows WHERE id = ?').run(rowId);
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `删除 ${rowIds.length} 行`, nowIso);
      return newRev;
    });
  }

  /** 按类别窗口分页/筛选（design D23：renderer 只取可见窗口）。 */
  queryRows(draftId: string, query: RowQuery): RowWindow {
    const conditions = ['r.draft_id = ?'];
    const params: (string | number)[] = [draftId];
    if (query.category) {
      conditions.push('r.category = ?');
      params.push(query.category);
    }
    if (query.businessKey) {
      conditions.push('r.business_key = ?');
      params.push(query.businessKey);
    }
    if (query.issueSeverity) {
      conditions.push(
        'EXISTS (SELECT 1 FROM workspace_issues i WHERE i.row_id = r.id AND i.severity = ? AND i.resolved = 0)',
      );
      params.push(query.issueSeverity);
    }
    const where = conditions.join(' AND ');
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM workspace_rows r WHERE ${where}`).get(...params) as { n: number }
    ).n;
    const rows = this.db.prepare(
      `SELECT r.id, r.revision, r.category, r.sort_key, r.grid_row, r.source_row_id, r.business_key,
              r.source_file, r.source_sheet, r.source_row, r.paste_batch, r.excluded
         FROM workspace_rows r
        WHERE ${where}
        ORDER BY r.category, r.sort_key
        LIMIT ? OFFSET ?`,
    ).all(...params, query.limit, query.offset) as unknown as RowDbRow[];
    const cellsByRow = new Map<string, Record<string, string | null>>();
    if (rows.length > 0) {
      const placeholders = rows.map(() => '?').join(',');
      const cellRows = this.db
        .prepare(
          `SELECT row_id, field, value FROM workspace_cells
            WHERE draft_id = ? AND row_id IN (${placeholders})
            ORDER BY row_id, field`,
        )
        .all(draftId, ...rows.map((r) => r.id)) as unknown as Array<{
        row_id: string;
        field: string;
        value: string | null;
      }>;
      for (const c of cellRows) {
        let cells = cellsByRow.get(c.row_id);
        if (!cells) {
          cells = {};
          cellsByRow.set(c.row_id, cells);
        }
        cells[c.field] = c.value;
      }
    }
    return {
      total,
      offset: query.offset,
      limit: query.limit,
      rows: rows.map((r) => this.toRowView(r, cellsByRow.get(r.id))),
    };
  }

  // ---------------------------------------------------------------- 来源 / 映射 / 冲突决定 / 问题

  addSource(draftId: string, input: SourceInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO workspace_sources (id, draft_id, source_kind, source_file, sheet, source_hash, row_count, added_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, draftId, input.sourceKind, input.sourceFile, input.sheet ?? null, input.sourceHash ?? null, input.rowCount ?? 0, this.now.nowIso());
    return id;
  }

  listSources(draftId: string): WorkspaceSource[] {
    return (
      this.db
        .prepare('SELECT * FROM workspace_sources WHERE draft_id=? ORDER BY rowid')
        .all(draftId) as unknown as Array<{
        id: string;
        draft_id: string;
        source_kind: 'file' | 'paste';
        source_file: string;
        sheet: string | null;
        source_hash: string | null;
        row_count: number;
        added_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      draftId: r.draft_id,
      sourceKind: r.source_kind,
      sourceFile: r.source_file,
      sheet: r.sheet,
      sourceHash: r.source_hash,
      rowCount: r.row_count,
      addedAt: r.added_at,
    }));
  }

  saveMappings(draftId: string, expectedRevision: number, mappings: ColumnMapping[]): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.db.prepare('DELETE FROM workspace_mappings WHERE draft_id = ?').run(draftId);
      const insert = this.db.prepare(
        `INSERT INTO workspace_mappings (
           id, draft_id, category, source_column, target_field, mapping_state,
           sample_value, priority, source_priority, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const m of mappings) {
        insert.run(
          randomUUID(),
          draftId,
          m.category,
          m.sourceColumn,
          m.targetField,
          m.mappingState,
          m.sampleValue ?? null,
          m.priority ?? null,
          m.sourcePriority ?? null,
          nowIso,
        );
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `保存 ${mappings.length} 条列映射`, nowIso);
      return newRev;
    });
  }

  listMappings(draftId: string): ColumnMapping[] {
    return (
      this.db
        .prepare('SELECT * FROM workspace_mappings WHERE draft_id=? ORDER BY category, source_column')
        .all(draftId) as unknown as Array<{
        category: ImportCategory;
        source_column: string;
        target_field: string | null;
        mapping_state: ColumnMapping['mappingState'];
        sample_value: string | null;
        priority: number | null;
        source_priority: string | null;
      }>
    ).map((r) => ({
      category: r.category,
      sourceColumn: r.source_column,
      targetField: r.target_field,
      mappingState: r.mapping_state,
      sampleValue: r.sample_value,
      priority: r.priority,
      sourcePriority: r.source_priority,
    }));
  }

  saveConflictDecision(draftId: string, expectedRevision: number, decision: ConflictDecisionInput): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.db
        .prepare(
          `INSERT INTO workspace_conflict_decisions (
             id, draft_id, revision, row_id, field, decision_type, chosen_value, resolved_by, resolved_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          draftId,
          newRev,
          decision.rowId ?? null,
          decision.field,
          decision.decisionType,
          decision.chosenValue ?? null,
          decision.resolvedBy ?? null,
          nowIso,
        );
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, '保存冲突决定', nowIso);
      return newRev;
    });
  }

  listConflictDecisions(draftId: string): ConflictDecision[] {
    return (
      this.db
        .prepare('SELECT * FROM workspace_conflict_decisions WHERE draft_id=? ORDER BY resolved_at, field')
        .all(draftId) as unknown as Array<{
        id: string;
        row_id: string | null;
        field: string;
        decision_type: ConflictDecision['decisionType'];
        chosen_value: string | null;
        resolved_by: string | null;
        resolved_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      rowId: r.row_id,
      field: r.field,
      decisionType: r.decision_type,
      chosenValue: r.chosen_value,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
    }));
  }

  /** 局部/完整校验统一以「替换全部问题」表达（design D24）。 */
  replaceIssues(draftId: string, expectedRevision: number, issues: IssueInput[]): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.db.prepare('DELETE FROM workspace_issues WHERE draft_id = ?').run(draftId);
      const insert = this.db.prepare(
        `INSERT INTO workspace_issues (
           id, draft_id, revision, severity, issue_code, category, row_id, field,
           business_key, grid_row, source_position, message, resolved
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const issue of issues) {
        insert.run(
          randomUUID(),
          draftId,
          newRev,
          issue.severity,
          issue.issueCode,
          issue.category ?? null,
          issue.rowId ?? null,
          issue.field ?? null,
          issue.businessKey ?? null,
          issue.gridRow ?? null,
          issue.sourcePosition ?? null,
          issue.message,
          issue.resolved ? 1 : 0,
        );
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `写入 ${issues.length} 条校验问题`, nowIso);
      return newRev;
    });
  }

  listIssues(draftId: string, filter?: IssueQuery): ImportIssue[] {
    const conditions = ['draft_id = ?'];
    const params: (string | number)[] = [draftId];
    if (filter?.severity) {
      conditions.push('severity = ?');
      params.push(filter.severity);
    }
    if (filter?.category) {
      conditions.push('category = ?');
      params.push(filter.category);
    }
    if (filter?.resolved !== undefined) {
      conditions.push('resolved = ?');
      params.push(filter.resolved ? 1 : 0);
    }
    const severityOrder = `CASE severity WHEN 'error' THEN 0 WHEN 'conflict' THEN 1 ELSE 2 END`;
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_issues WHERE ${conditions.join(' AND ')}
          ORDER BY ${severityOrder}, category, grid_row`,
      )
      .all(...params) as unknown as IssueRow[];
    return rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      severity: r.severity,
      issueCode: r.issue_code,
      category: r.category,
      rowId: r.row_id,
      field: r.field,
      businessKey: r.business_key,
      gridRow: r.grid_row,
      sourcePosition: r.source_position,
      message: r.message,
      resolved: r.resolved === 1,
    }));
  }

  resolveIssue(draftId: string, expectedRevision: number, issueId: string): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      const updated = this.db
        .prepare('UPDATE workspace_issues SET resolved = 1 WHERE id = ? AND draft_id = ?')
        .run(issueId, draftId);
      if (updated.changes === 0) {
        throw new WorkspaceNotFoundError(`校验问题不存在: ${issueId}`);
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, '标记问题已解决', nowIso);
      return newRev;
    });
  }

  // ---------------------------------------------------------------- 校验封存

  /** 完整校验通过后生成 validation seal；要求当前处于 validating 状态。 */
  saveSeal(draftId: string, expectedRevision: number, seal: ValidationSealInput): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      if (draft.state !== 'validating') {
        throw new WorkspaceStateError(`校验封存仅允许在 validating 状态生成，当前状态: ${draft.state}`);
      }
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.db.prepare('DELETE FROM workspace_seals WHERE draft_id = ?').run(draftId);
      this.db
        .prepare(
          `INSERT INTO workspace_seals (
             id, draft_id, plan_digest, draft_revision, template_version, mapping_version, validation_version,
             conflict_decision_digest, target_schema_version, target_business_revision,
             database_instance_id, content_generation_id,
             status, created_at, invalidated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          draftId,
          seal.planDigest,
          draft.revision,
          seal.templateVersion ?? null,
          seal.mappingVersion ?? null,
          seal.validationVersion ?? null,
          seal.conflictDecisionDigest ?? null,
          seal.targetSchemaVersion ?? null,
          seal.targetBusinessRevision ?? null,
          seal.databaseInstanceId ?? null,
          seal.contentGenerationId ?? null,
          'valid',
          nowIso,
          null,
        );
      this.writeRevision(draftId, newRev, 'sealed', '完整校验通过：生成校验封存', nowIso);
      return newRev;
    });
  }

  getSeal(draftId: string): ValidationSealRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspace_seals WHERE draft_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(draftId) as SealRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      draftId: row.draft_id,
      draftRevision: row.draft_revision,
      status: row.status,
      planDigest: row.plan_digest,
      templateVersion: row.template_version,
      mappingVersion: row.mapping_version,
      validationVersion: row.validation_version,
      conflictDecisionDigest: row.conflict_decision_digest,
      targetSchemaVersion: row.target_schema_version,
      targetBusinessRevision: row.target_business_revision,
      databaseInstanceId: row.database_instance_id,
      contentGenerationId: row.content_generation_id,
      createdAt: row.created_at,
      invalidatedAt: row.invalidated_at,
    };
  }

  /** 显式失效 seal（sealed → needs_review）。数据修改会自动触发失效。 */
  invalidateSeal(draftId: string, expectedRevision: number): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      if (draft.state !== 'sealed') {
        throw new WorkspaceStateError(`仅 sealed 草稿可显式失效 seal，当前状态: ${draft.state}`);
      }
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, 'needs_review', '校验封存失效：需重新完整校验', nowIso);
      return newRev;
    });
  }

  // ---------------------------------------------------------------- 磁盘型 undo checkpoint（tasks 8.59/8.66）

  /**
   * 原子保存草稿可变状态为磁盘 checkpoint（rows/cells/sources/mappings/
   * conflict_decisions/issues + 传入的 category modes + base revision）。
   * 快照由仓库从工作区数据库捕获，renderer 不保存全量。
   * 有界保留：每草稿最多 MAX_CHECKPOINTS_PER_DRAFT 份，超出清理最旧；
   * 新建 'pre'（新一轮编辑）会清空已 undo 的 checkpoint（redo 历史失效）。
   */
  createCheckpoint(draftId: string, expectedRevision: number, input: CheckpointInput = {}): CheckpointSummary {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      const nowIso = this.now.nowIso();
      const id = randomUUID();
      const kind: CheckpointKind = input.kind ?? 'manual';
      if (kind === 'pre') {
        // 新一轮编辑使旧 redo 历史失效（标准 undo/redo 语义）。
        this.db.prepare('DELETE FROM workspace_checkpoints WHERE draft_id = ? AND state = ?').run(draftId, 'undone');
      }
      const snapshot = this.captureSnapshot(draftId, input.modes ?? {});
      this.db
        .prepare(
          `INSERT INTO workspace_checkpoints (
             id, draft_id, base_revision, kind, pair_id, label, snapshot, state, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          draftId,
          draft.revision,
          kind,
          input.pairId ?? null,
          input.label ?? null,
          JSON.stringify(snapshot),
          'active',
          nowIso,
        );
      this.enforceCheckpointRetention(draftId);
      return this.readCheckpoint(id);
    });
  }

  listCheckpoints(draftId: string): CheckpointSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_checkpoints WHERE draft_id = ? ORDER BY base_revision, created_at')
      .all(draftId) as unknown as CheckpointRow[];
    return rows.map((r) => this.toCheckpointSummary(r));
  }

  checkpointCount(draftId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM workspace_checkpoints WHERE draft_id = ?')
      .get(draftId) as { n: number };
    return row.n;
  }

  /** 恢复指定 checkpoint（manual/任意类型均可）；以 expected revision 并发保护，产生新修订并失效 seal。 */
  restoreCheckpoint(draftId: string, expectedRevision: number, checkpointId: string): CheckpointRestoreResult | null {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const checkpoint = this.db
        .prepare('SELECT * FROM workspace_checkpoints WHERE id = ? AND draft_id = ?')
        .get(checkpointId, draftId) as CheckpointRow | undefined;
      if (!checkpoint) return null;
      this.restoreCheckpointState(draft, checkpoint);
      return {
        newRevision: draft.revision + 1,
        checkpointId: checkpoint.id,
        kind: checkpoint.kind,
        label: checkpoint.label,
        modes: this.snapshotModes(checkpoint.snapshot),
      };
    });
  }

  /** 撤销：恢复最近一个 active 的 pre checkpoint（成对 pre/post 标记为 undone，记录撤销时间序）。 */
  undo(draftId: string, expectedRevision: number): CheckpointRestoreResult | null {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const nowIso = this.now.nowIso();
      const pre = this.db
        .prepare(
          `SELECT * FROM workspace_checkpoints
            WHERE draft_id = ? AND kind = 'pre' AND state = 'active'
            ORDER BY base_revision DESC, created_at DESC LIMIT 1`,
        )
        .get(draftId) as CheckpointRow | undefined;
      if (!pre) return null;
      this.restoreCheckpointState(draft, pre);
      // 撤销时间序：每草稿单调递增 undo_seq（严格 last-op-first，避免时钟同毫秒并列）。
      const undoSeq = this.nextUndoSequence(draftId);
      if (pre.pair_id) {
        this.db
          .prepare("UPDATE workspace_checkpoints SET state='undone', undone_at=?, undo_seq=? WHERE draft_id = ? AND pair_id = ?")
          .run(nowIso, undoSeq, draftId, pre.pair_id);
      } else {
        this.db.prepare("UPDATE workspace_checkpoints SET state='undone', undone_at=?, undo_seq=? WHERE id = ?").run(nowIso, undoSeq, pre.id);
      }
      return {
        newRevision: draft.revision + 1,
        checkpointId: pre.id,
        kind: pre.kind,
        label: pre.label,
        modes: this.snapshotModes(pre.snapshot),
      };
    });
  }

  /** 重做：恢复最近撤销的 pre checkpoint 的成对 post 快照（按撤销时间序 undone_at，标记回 active）。
   *  A/B → undo B → undo A → redo A → redo B 严格成立。 */
  redo(draftId: string, expectedRevision: number): CheckpointRestoreResult | null {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const pre = this.db
        .prepare(
          `SELECT * FROM workspace_checkpoints
            WHERE draft_id = ? AND kind = 'pre' AND state = 'undone'
            ORDER BY undo_seq DESC, base_revision DESC LIMIT 1`,
        )
        .get(draftId) as CheckpointRow | undefined;
      if (!pre) return null;
      const post = pre.pair_id
        ? (this.db
            .prepare("SELECT * FROM workspace_checkpoints WHERE draft_id = ? AND pair_id = ? AND kind = 'post' LIMIT 1")
            .get(draftId, pre.pair_id) as CheckpointRow | undefined)
        : undefined;
      const target = post ?? pre;
      this.restoreCheckpointState(draft, target);
      if (pre.pair_id) {
        this.db
          .prepare("UPDATE workspace_checkpoints SET state='active', undone_at=NULL WHERE draft_id = ? AND pair_id = ?")
          .run(draftId, pre.pair_id);
      } else {
        this.db.prepare("UPDATE workspace_checkpoints SET state='active', undone_at=NULL WHERE id = ?").run(pre.id);
      }
      return {
        newRevision: draft.revision + 1,
        checkpointId: target.id,
        kind: target.kind,
        label: target.label,
        modes: this.snapshotModes(target.snapshot),
      };
    });
  }

  /** 删除指定 checkpoint（consume）。 */
  consumeCheckpoint(draftId: string, checkpointId: string): void {
    this.db.prepare('DELETE FROM workspace_checkpoints WHERE draft_id = ? AND id = ?').run(draftId, checkpointId);
  }

  /** 清理全部 checkpoint（成功/取消/删除草稿时清除敏感值）。 */
  clearCheckpoints(draftId: string): void {
    this.db.prepare('DELETE FROM workspace_checkpoints WHERE draft_id = ?').run(draftId);
  }

  // ---------------------------------------------------------------- category modes / sheet classifications（Oracle 复审 #2）

  /**
   * 设置类别模式（data/none）：推进草稿修订、invalidate seal（sealed → needs_review），
   * 并纳入 checkpoint 快照 / conflict digest / seal。
   */
  setCategoryMode(draftId: string, expectedRevision: number, category: ImportCategory, mode: 'data' | 'none'): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.db
        .prepare(
          `INSERT INTO workspace_category_modes (draft_id, category, mode, revision, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(draft_id, category) DO UPDATE SET mode=excluded.mode, revision=excluded.revision, updated_at=excluded.updated_at`,
        )
        .run(draftId, category, mode, newRev, nowIso);
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `设置类别模式 ${category}=${mode}`, nowIso);
      return newRev;
    });
  }

  getCategoryModes(draftId: string): Partial<Record<ImportCategory, 'data' | 'none'>> {
    const rows = this.db
      .prepare('SELECT category, mode FROM workspace_category_modes WHERE draft_id = ?')
      .all(draftId) as unknown as Array<{ category: ImportCategory; mode: 'data' | 'none' }>;
    const modes = {} as Partial<Record<ImportCategory, 'data' | 'none'>>;
    for (const row of rows) modes[row.category] = row.mode;
    return modes;
  }

  /** 设置 sheet 归类（目标类别或明确排除）：推进修订 + invalidate seal。
   *  Oracle 最终复核 #1：使用独立 file/sheet 结构化来源身份（不依赖未转义 `file#sheet` 拆分），
   *  且 excluded 约束同一 (file, sheet) 的后续 appendRows。 */
  setSheetClassification(
    draftId: string,
    expectedRevision: number,
    file: string,
    sheet: string,
    classification: ImportCategory | 'excluded',
  ): number {
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      this.assertMutable(draft);
      const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      // 规范化：null sheet 视为 ''（与 appendRows 的来源列一致）。
      const normalizedSheet = sheet ?? '';
      const safeKey = encodeSheetId(file, normalizedSheet);
      // Oracle 二次复审 #2：sheet 归类必须真实影响 rows——excluded 标记源行排除；
      // 重新归类到不同目标类别且存在既有源行时阻断（无法安全重映射字段）。
      const sourceRows = this.db
        .prepare('SELECT id, category FROM workspace_rows WHERE draft_id=? AND source_file=? AND source_sheet=?')
        .all(draftId, file, normalizedSheet) as Array<{ id: string; category: ImportCategory }>;
      if (classification !== 'excluded') {
        if (sourceRows.length > 0 && sourceRows.some((row) => row.category !== classification)) {
          throw new WorkspaceStateError(
            `来源（file「${file}」sheet「${normalizedSheet}」）已存在 ${sourceRows.length} 行且目标类别与既有行类别不一致，无法安全重映射；请保持原类别或排除`,
          );
        }
      }
      const excluded = classification === 'excluded' ? 1 : 0;
      this.db
        .prepare(
          `INSERT INTO workspace_sheet_classifications (draft_id, sheet_key, file, sheet, category, excluded, revision, updated_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(draft_id, sheet_key) DO UPDATE SET
             file=excluded.file, sheet=excluded.sheet, category=excluded.category,
             excluded=excluded.excluded, revision=excluded.revision, updated_at=excluded.updated_at`,
        )
        .run(
          draftId,
          safeKey,
          file,
          normalizedSheet,
          classification === 'excluded' ? 'project' : classification,
          excluded,
          newRev,
          nowIso,
        );
      if (sourceRows.length > 0) {
        // 原子：归类变化同步到全部对应源行（excluded 行不进入计划）。
        this.db.prepare('UPDATE workspace_rows SET excluded=? WHERE draft_id=? AND source_file=? AND source_sheet=?').run(
          excluded,
          draftId,
          file,
          normalizedSheet,
        );
      }
      if (invalidateSeal) this.invalidateSealRows(draftId, nowIso);
      this.writeRevision(draftId, newRev, newState, `设置 sheet 归类 ${safeKey}`, nowIso);
      return newRev;
    });
  }

  getSheetClassifications(draftId: string): Array<{ file: string; sheet: string; classification: ImportCategory | 'excluded' }> {
    const rows = this.db
      .prepare('SELECT file, sheet, category, excluded FROM workspace_sheet_classifications WHERE draft_id = ?')
      .all(draftId) as unknown as Array<{ file: string | null; sheet: string | null; category: ImportCategory; excluded: number }>;
    return rows.map((row) => ({
      file: row.file ?? '',
      sheet: row.sheet ?? '',
      classification: row.excluded === 1 ? 'excluded' : row.category,
    }));
  }

  /** 该草稿的 excluded 来源集合（appendRows 约束同一 (file, sheet) 的后续追加）。 */
  private excludedSourceKeys(draftId: string): Set<string> {
    const keys = new Set<string>();
    for (const c of this.getSheetClassifications(draftId)) {
      if (c.classification === 'excluded') keys.add(sourceKeyOf(c.file, c.sheet));
    }
    return keys;
  }

  /** 每草稿单调递增的撤销序号（redo 按撤销时间序，严格 last-op-first）。 */
  private nextUndoSequence(draftId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(undo_seq),0) + 1 AS seq FROM workspace_checkpoints WHERE draft_id = ?')
      .get(draftId) as { seq: number };
    return row.seq;
  }

  private enforceCheckpointRetention(draftId: string): void {
    const rows = this.db
      .prepare('SELECT id FROM workspace_checkpoints WHERE draft_id = ? ORDER BY base_revision DESC')
      .all(draftId) as Array<{ id: string }>;
    if (rows.length <= MAX_CHECKPOINTS_PER_DRAFT) return;
    for (const row of rows.slice(MAX_CHECKPOINTS_PER_DRAFT)) {
      this.db.prepare('DELETE FROM workspace_checkpoints WHERE id = ?').run(row.id);
    }
  }

  private captureSnapshot(draftId: string, modes: Partial<Record<ImportCategory, 'data' | 'none'>>): CheckpointSnapshot {
    const rows = this.db
      .prepare('SELECT * FROM workspace_rows WHERE draft_id = ? ORDER BY category, sort_key')
      .all(draftId) as unknown as RowDbRow[];
    const cells = this.db
      .prepare('SELECT row_id, field, value FROM workspace_cells WHERE draft_id = ? ORDER BY row_id, field')
      .all(draftId) as unknown as Array<{ row_id: string; field: string; value: string | null }>;
    const cellsByRow = new Map<string, Record<string, string | null>>();
    for (const cell of cells) {
      const map = cellsByRow.get(cell.row_id) ?? {};
      map[cell.field] = cell.value;
      cellsByRow.set(cell.row_id, map);
    }
    const sources = this.db
      .prepare('SELECT * FROM workspace_sources WHERE draft_id = ? ORDER BY rowid')
      .all(draftId) as unknown as Array<{
      source_kind: 'file' | 'paste'; source_file: string; sheet: string | null;
      source_hash: string | null; row_count: number; added_at: string;
    }>;
    const mappings = this.db
      .prepare('SELECT * FROM workspace_mappings WHERE draft_id = ? ORDER BY category, source_column')
      .all(draftId) as unknown as Array<{
      category: ImportCategory; source_column: string; target_field: string | null;
      mapping_state: ColumnMapping['mappingState']; sample_value: string | null;
      priority: number | null; source_priority: string | null;
    }>;
    const decisions = this.db
      .prepare('SELECT * FROM workspace_conflict_decisions WHERE draft_id = ? ORDER BY resolved_at, field')
      .all(draftId) as unknown as Array<{
      id: string; row_id: string | null; field: string; decision_type: ConflictDecision['decisionType'];
      chosen_value: string | null; resolved_by: string | null; resolved_at: string;
    }>;
    const issues = this.db
      .prepare('SELECT * FROM workspace_issues WHERE draft_id = ? ORDER BY rowid')
      .all(draftId) as unknown as Array<{
      id: string; severity: ImportIssue['severity']; issue_code: string; category: ImportCategory | null;
      row_id: string | null; field: string | null; business_key: string | null; grid_row: number | null;
      source_position: string | null; message: string; resolved: number;
    }>;
    return {
      baseRevision: this.requireDraftRow(draftId).revision,
      modes: modes as Record<ImportCategory, 'data' | 'none'>,
      rows: rows.map((r) => ({
        rowId: r.id,
        category: r.category,
        sortKey: r.sort_key,
        gridRow: r.grid_row,
        sourceRowId: r.source_row_id,
        businessKey: r.business_key,
        sourceFile: r.source_file,
        sourceSheet: r.source_sheet,
        sourceRow: r.source_row,
        pasteBatch: r.paste_batch,
        excluded: r.excluded === 1,
        cells: cellsByRow.get(r.id) ?? {},
      })),
      sources: sources.map((s) => ({
        sourceKind: s.source_kind,
        sourceFile: s.source_file,
        sheet: s.sheet,
        sourceHash: s.source_hash,
        rowCount: s.row_count,
        addedAt: s.added_at,
      })),
      mappings: mappings.map((m) => ({
        category: m.category,
        sourceColumn: m.source_column,
        targetField: m.target_field,
        mappingState: m.mapping_state,
        sampleValue: m.sample_value,
        priority: m.priority,
        sourcePriority: m.source_priority,
      })),
      conflictDecisions: decisions.map((d) => ({
        id: d.id,
        rowId: d.row_id,
        field: d.field,
        decisionType: d.decision_type,
        chosenValue: d.chosen_value,
        resolvedBy: d.resolved_by,
        resolvedAt: d.resolved_at,
      })),
      issues: issues.map((i) => ({
        id: i.id,
        severity: i.severity,
        issueCode: i.issue_code,
        category: i.category,
        rowId: i.row_id,
        field: i.field,
        businessKey: i.business_key,
        gridRow: i.grid_row,
        sourcePosition: i.source_position,
        message: i.message,
        resolved: i.resolved === 1,
      })),
      sheetClassifications: this.getSheetClassifications(draftId),
    };
  }

  private restoreCheckpointState(draft: WorkspaceDraftRow, checkpoint: CheckpointRow): void {
    const snapshot = this.parseSnapshot(checkpoint.snapshot);
    const nowIso = this.now.nowIso();
    const { state: newState, invalidateSeal } = this.nextStateForMutation(draft.state);
    const newRev = draft.revision + 1;
    // 清空当前可变状态并整体重建（原子：同一事务内）。
    this.db.prepare('DELETE FROM workspace_cells WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_rows WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_sources WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_mappings WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_conflict_decisions WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_issues WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_category_modes WHERE draft_id = ?').run(draft.id);
    this.db.prepare('DELETE FROM workspace_sheet_classifications WHERE draft_id = ?').run(draft.id);
    const rowInsert = this.db.prepare(
      `INSERT INTO workspace_rows (
         id, draft_id, revision, category, sort_key, source_row_id, business_key,
         source_file, source_sheet, source_row, paste_batch, grid_row, excluded
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const cellInsert = this.db.prepare(
      'INSERT INTO workspace_cells (id, draft_id, row_id, revision, field, value) VALUES (?,?,?,?,?,?)',
    );
    for (const row of snapshot.rows) {
      rowInsert.run(
        row.rowId, draft.id, newRev, row.category, row.sortKey, row.sourceRowId,
        row.businessKey, row.sourceFile, row.sourceSheet, row.sourceRow, row.pasteBatch, row.gridRow,
        row.excluded ? 1 : 0,
      );
      for (const [field, value] of Object.entries(row.cells)) {
        cellInsert.run(randomUUID(), draft.id, row.rowId, newRev, field, value);
      }
    }
    const sourceInsert = this.db.prepare(
      `INSERT INTO workspace_sources (id, draft_id, source_kind, source_file, sheet, source_hash, row_count, added_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const source of snapshot.sources) {
      sourceInsert.run(randomUUID(), draft.id, source.sourceKind, source.sourceFile, source.sheet, source.sourceHash, source.rowCount, source.addedAt);
    }
    const mappingInsert = this.db.prepare(
      `INSERT INTO workspace_mappings (
         id, draft_id, category, source_column, target_field, mapping_state,
         sample_value, priority, source_priority, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const mapping of snapshot.mappings) {
      mappingInsert.run(
        randomUUID(), draft.id, mapping.category, mapping.sourceColumn, mapping.targetField,
        mapping.mappingState, mapping.sampleValue ?? null, mapping.priority ?? null,
        mapping.sourcePriority ?? null, nowIso,
      );
    }
    const decisionInsert = this.db.prepare(
      `INSERT INTO workspace_conflict_decisions (
         id, draft_id, revision, row_id, field, decision_type, chosen_value, resolved_by, resolved_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const decision of snapshot.conflictDecisions) {
      decisionInsert.run(
        decision.id ?? randomUUID(), draft.id, newRev, decision.rowId ?? null, decision.field,
        decision.decisionType, decision.chosenValue ?? null, decision.resolvedBy ?? null,
        decision.resolvedAt ?? nowIso,
      );
    }
    const issueInsert = this.db.prepare(
      `INSERT INTO workspace_issues (
         id, draft_id, revision, severity, issue_code, category, row_id, field,
         business_key, grid_row, source_position, message, resolved
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const issue of snapshot.issues) {
      issueInsert.run(
        issue.id ?? randomUUID(), draft.id, newRev, issue.severity, issue.issueCode,
        issue.category ?? null, issue.rowId ?? null, issue.field ?? null, issue.businessKey ?? null,
        issue.gridRow ?? null, issue.sourcePosition ?? null, issue.message, issue.resolved ? 1 : 0,
      );
    }
    // 类别模式与 sheet 归类随 checkpoint 同一事务恢复。
    const modeInsert = this.db.prepare(
      `INSERT INTO workspace_category_modes (draft_id, category, mode, revision, updated_at)
       VALUES (?,?,?,?,?)`,
    );
    for (const [category, mode] of Object.entries(snapshot.modes ?? {})) {
      modeInsert.run(draft.id, category, mode, newRev, nowIso);
    }
    const sheetInsert = this.db.prepare(
      `INSERT INTO workspace_sheet_classifications (draft_id, sheet_key, file, sheet, category, excluded, revision, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const entry of snapshot.sheetClassifications ?? []) {
      sheetInsert.run(
        draft.id,
        encodeSheetId(entry.file, entry.sheet),
        entry.file,
        entry.sheet,
        entry.classification === 'excluded' ? 'project' : entry.classification,
        entry.classification === 'excluded' ? 1 : 0,
        newRev,
        nowIso,
      );
    }
    if (invalidateSeal) this.invalidateSealRows(draft.id, nowIso);
    this.writeRevision(draft.id, newRev, newState, `恢复 checkpoint（${checkpoint.label ?? checkpoint.kind}）`, nowIso);
  }

  private parseSnapshot(json: string): CheckpointSnapshot {
    try {
      const parsed = JSON.parse(json) as CheckpointSnapshot;
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) {
        throw new Error('checkpoint 快照损坏');
      }
      return parsed;
    } catch (err) {
      throw new WorkspaceError('WORKSPACE_CHECKPOINT_CORRUPT', `checkpoint 快照损坏: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private snapshotModes(json: string): Partial<Record<ImportCategory, 'data' | 'none'>> {
    try {
      return this.parseSnapshot(json).modes ?? {};
    } catch {
      return {};
    }
  }

  private readCheckpoint(id: string): CheckpointSummary {
    const row = this.db.prepare('SELECT * FROM workspace_checkpoints WHERE id = ?').get(id) as CheckpointRow | undefined;
    if (!row) throw new WorkspaceNotFoundError(`checkpoint 不存在: ${id}`);
    return this.toCheckpointSummary(row);
  }

  private toCheckpointSummary(r: CheckpointRow): CheckpointSummary {
    return {
      id: r.id,
      draftId: r.draft_id,
      kind: r.kind,
      pairId: r.pair_id,
      label: r.label,
      baseRevision: r.base_revision,
      state: r.state,
      createdAt: r.created_at,
    };
  }

  // ---------------------------------------------------------------- operation 进度

  createOperation(draftId: string, kind: OperationKind): OperationProgress {
    const id = randomUUID();
    const startedAt = this.now.nowIso();
    this.db
      .prepare(
        `INSERT INTO workspace_operations (
           id, draft_id, kind, state, stage, progress_current, progress_total, started_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, draftId, kind, 'running', null, 0, null, startedAt);
    return this.readOperation(id);
  }

  updateOperationProgress(operationId: string, update: OperationUpdate): OperationProgress {
    const current = this.readOperation(operationId);
    const stage = update.stage !== undefined ? update.stage : current.stage;
    const progressCurrent = update.progressCurrent !== undefined ? update.progressCurrent : current.progressCurrent;
    const progressTotal = update.progressTotal !== undefined ? update.progressTotal : current.progressTotal;
    this.db
      .prepare('UPDATE workspace_operations SET stage=?, progress_current=?, progress_total=? WHERE id=?')
      .run(stage, progressCurrent, progressTotal, operationId);
    return this.readOperation(operationId);
  }

  finishOperation(operationId: string, state: OperationState, result?: string | null): OperationProgress {
    this.db
      .prepare('UPDATE workspace_operations SET state=?, finished_at=?, result=? WHERE id=?')
      .run(state, this.now.nowIso(), result ?? null, operationId);
    return this.readOperation(operationId);
  }

  listOperations(draftId: string): OperationProgress[] {
    return (
      this.db
        .prepare('SELECT * FROM workspace_operations WHERE draft_id=? ORDER BY started_at, id')
        .all(draftId) as unknown as OperationRow[]
    ).map((r) => this.toOperation(r));
  }

  // ---------------------------------------------------------------- 状态机

  /** 按事件执行合法状态转换；非法转换抛 WorkspaceStateError。 */
  transitionState(draftId: string, expectedRevision: number, event: WorkspaceDraftEvent): number {
    if (event === 'commit_verified' || event === 'commit_failed') {
      throw new WorkspaceStateError('commit 结果判定必须通过 settleCommit 进行（需先核对正式成功审计）');
    }
    return this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      const to = applyTransition(draft.state, event);
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      this.writeRevision(draftId, newRev, to, `状态转换 ${draft.state} → ${to}`, nowIso);
      return newRev;
    });
  }

  // ---------------------------------------------------------------- 运行态恢复与 commit 结果判定

  /**
   * 运行态重启恢复（design D20 / tasks 8.11）：
   * - parsing / validating → 回到最后稳定草稿修订，删除运行期写入的行/单元格/问题；
   * - committing → 标记 pendingOutcome，等待 settleCommit 核对正式成功审计。
   */
  recoverRuntimeStates(): RecoveryReport {
    const report: RecoveryReport = { recovered: [], pendingOutcome: [] };
    const drafts = this.db
      .prepare('SELECT id, state, revision FROM workspace_drafts')
      .all() as unknown as Array<{ id: string; state: WorkspaceDraftState; revision: number }>;
    for (const draft of drafts) {
      if (draft.state === 'parsing' || draft.state === 'validating') {
        const stable = this.db
          .prepare(
            `SELECT revision, state FROM workspace_draft_revisions
              WHERE draft_id = ? AND state IN ('draft','needs_review','sealed')
              ORDER BY revision DESC LIMIT 1`,
          )
          .get(draft.id) as { revision: number; state: WorkspaceDraftState } | undefined;
        const target = stable ?? { revision: 1, state: 'draft' as const };
        this.inTransaction(() => {
          const nowIso = this.now.nowIso();
          this.db.prepare('DELETE FROM workspace_rows WHERE draft_id=? AND revision > ?').run(draft.id, target.revision);
          this.db.prepare('DELETE FROM workspace_cells WHERE draft_id=? AND revision > ?').run(draft.id, target.revision);
          this.db.prepare('DELETE FROM workspace_issues WHERE draft_id=? AND revision > ?').run(draft.id, target.revision);
          this.db.prepare('DELETE FROM workspace_draft_revisions WHERE draft_id=? AND revision > ?').run(draft.id, target.revision);
          this.db
            .prepare("UPDATE workspace_operations SET state='cancelled', finished_at=? WHERE draft_id=? AND state='running'")
            .run(nowIso, draft.id);
          this.db
            .prepare('UPDATE workspace_drafts SET state=?, revision=?, updated_at=?, last_saved_at=? WHERE id=?')
            .run(target.state, target.revision, nowIso, nowIso, draft.id);
        });
        report.recovered.push({
          draftId: draft.id,
          from: draft.state,
          to: target.state,
          note: '运行态重启恢复：回到最后稳定草稿修订',
        });
      } else if (draft.state === 'committing') {
        this.db.prepare('UPDATE workspace_drafts SET pending_outcome=1 WHERE id=?').run(draft.id);
        report.pendingOutcome.push(draft.id);
      }
    }
    return report;
  }

  /**
   * committing 中断后的结果判定：调用方先核对正式成功审计与事务结果，
   * verified=true → succeeded（清除敏感行、保留摘要）；false → needs_review（seal 失效）。
   */
  settleCommit(draftId: string, verified: boolean): number {
    const newRev = this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      if (draft.state !== 'committing') {
        throw new WorkspaceStateError(`commit 结果判定仅允许在 committing 状态进行，当前状态: ${draft.state}`);
      }
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      if (verified) {
        const summary = this.captureRowSummary(draftId);
        this.clearSensitiveRows(draftId);
        this.db
          .prepare('UPDATE workspace_drafts SET row_count_summary=? WHERE id=?')
          .run(JSON.stringify(summary), draftId);
        this.writeRevision(draftId, newRev, 'succeeded', '提交核对成功：succeeded，敏感行已清除，保留摘要', nowIso);
      } else {
        this.invalidateSealRows(draftId, nowIso);
        this.db.prepare('UPDATE workspace_drafts SET pending_outcome=0 WHERE id=?').run(draftId);
        this.writeRevision(draftId, newRev, 'needs_review', '提交未成功：整体回滚，seal 已失效，需重新完整校验', nowIso);
      }
      return newRev;
    });
    this.compactWorkspaceStorage();
    return newRev;
  }

  /** 取消草稿（draft/needs_review → cancelled）：清除敏感行、保留摘要。 */
  cancelDraft(draftId: string, expectedRevision: number): number {
    const newRev = this.inTransaction(() => {
      const draft = this.requireDraftRow(draftId);
      this.assertRevision(draft, expectedRevision);
      const to = applyTransition(draft.state, 'cancel_draft');
      const newRev = draft.revision + 1;
      const nowIso = this.now.nowIso();
      const summary = this.captureRowSummary(draftId);
      this.clearSensitiveRows(draftId);
      this.db.prepare('UPDATE workspace_drafts SET row_count_summary=? WHERE id=?').run(JSON.stringify(summary), draftId);
      this.writeRevision(draftId, newRev, to, '草稿已取消：敏感行已清除，保留摘要', nowIso);
      return newRev;
    });
    this.compactWorkspaceStorage();
    return newRev;
  }

  /**
   * 终态清理后的 WAL checkpoint 安全策略（Oracle 复审 #4）：清空 WAL 释放敏感页；
   * 事务外调用（VACUUM/WAL checkpoint 不可在事务内执行）。
   */
  private compactWorkspaceStorage(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // checkpoint 失败不影响主流程（secure_delete 已保证落盘即擦除）
    }
  }

  // ---------------------------------------------------------------- 异常遗留草稿策略

  /**
   * 可见的异常遗留草稿（tasks 8.13）：运行态草稿（重启未恢复）或
   * 超过截止时间未更新的非终态稳定草稿。返回摘要供用户查看后再清理。
   */
  listAbandonedDrafts(cutoffIso: string): DraftSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_drafts
          WHERE state IN ('parsing','validating','committing')
             OR (state IN ('draft','needs_review') AND last_saved_at < ?)
          ORDER BY last_saved_at, id`,
      )
      .all(cutoffIso) as unknown as WorkspaceDraftRow[];
    return rows.map((r) => this.toSummary(r));
  }

  /** 清理异常遗留草稿（先列出、由负责人确认后删除）。 */
  cleanupAbandonedDrafts(cutoffIso: string): { deleted: number; drafts: DraftSummary[] } {
    const drafts = this.listAbandonedDrafts(cutoffIso);
    for (const draft of drafts) {
      this.deleteDraft(draft.id);
    }
    return { deleted: drafts.length, drafts };
  }

  // ---------------------------------------------------------------- 内部辅助

  private inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败不影响主错误上报
      }
      throw mapWorkspaceDbError(err);
    }
  }

  private selectDraftRow(id: string): WorkspaceDraftRow | undefined {
    return this.db.prepare('SELECT * FROM workspace_drafts WHERE id = ?').get(id) as WorkspaceDraftRow | undefined;
  }

  private requireDraftRow(id: string): WorkspaceDraftRow {
    const row = this.selectDraftRow(id);
    if (!row) throw new WorkspaceNotFoundError(`导入草稿不存在: ${id}`);
    return row;
  }

  private assertRevision(draft: WorkspaceDraftRow, expectedRevision: number): void {
    if (draft.revision !== expectedRevision) {
      throw new RevisionConflictError(
        `草稿修订冲突：当前修订 ${draft.revision}，期望 ${expectedRevision}；请刷新为最新修订，禁止覆盖较新草稿`,
      );
    }
  }

  private assertMutable(draft: WorkspaceDraftRow): void {
    if (draft.state === 'committing') {
      throw new WorkspaceStateError('草稿正在提交，禁止修改');
    }
    if (draft.state === 'succeeded') {
      throw new WorkspaceStateError('草稿已导入成功，禁止修改');
    }
    if (draft.state === 'cancelled') {
      throw new WorkspaceStateError('草稿已取消，禁止修改');
    }
  }

  private assertRowBelongs(draftId: string, rowId: string): void {
    const row = this.db.prepare('SELECT id FROM workspace_rows WHERE id=? AND draft_id=?').get(rowId, draftId);
    if (!row) throw new WorkspaceNotFoundError(`网格行不存在于草稿 ${draftId}: ${rowId}`);
  }

  private nextStateForMutation(state: WorkspaceDraftState): { state: WorkspaceDraftState; invalidateSeal: boolean } {
    if (state === 'sealed') return { state: 'needs_review', invalidateSeal: true };
    return { state, invalidateSeal: false };
  }

  private insertRevisionRow(draftId: string, revision: number, state: WorkspaceDraftState, note: string, nowIso: string): void {
    this.db
      .prepare(
        'INSERT INTO workspace_draft_revisions (id, draft_id, revision, state, saved_at, note) VALUES (?,?,?,?,?,?)',
      )
      .run(randomUUID(), draftId, revision, state, nowIso, note);
  }

  /** 写入一条修订并推进草稿的 state/revision/last_saved_at（自动保存点）。 */
  private writeRevision(draftId: string, newRev: number, state: WorkspaceDraftState, note: string, nowIso: string): void {
    this.insertRevisionRow(draftId, newRev, state, note, nowIso);
    this.db
      .prepare('UPDATE workspace_drafts SET state=?, revision=?, updated_at=?, last_saved_at=?, pending_outcome=0 WHERE id=?')
      .run(state, newRev, nowIso, nowIso, draftId);
  }

  private invalidateSealRows(draftId: string, nowIso: string): void {
    this.db
      .prepare("UPDATE workspace_seals SET status='invalid', invalidated_at=? WHERE draft_id=? AND status='valid'")
      .run(nowIso, draftId);
  }

  private captureRowSummary(draftId: string): Record<ImportCategory, number> {
    return this.rowCounts(draftId);
  }

  /** 清除敏感内容（原始值/规范化行/单元格/问题/冲突决定/checkpoint），仅保留摘要。 */
  private clearSensitiveRows(draftId: string): void {
    this.db.prepare('DELETE FROM workspace_conflict_decisions WHERE draft_id=?').run(draftId);
    this.db.prepare('DELETE FROM workspace_issues WHERE draft_id=?').run(draftId);
    this.db.prepare('DELETE FROM workspace_cells WHERE draft_id=?').run(draftId);
    this.db.prepare('DELETE FROM workspace_rows WHERE draft_id=?').run(draftId);
    this.db.prepare('UPDATE workspace_mappings SET sample_value=NULL WHERE draft_id=?').run(draftId);
    // 成功/取消/删除草稿时清理 checkpoint 敏感快照（有界保留 + 终态清零）。
    this.db.prepare('DELETE FROM workspace_checkpoints WHERE draft_id=?').run(draftId);
  }

  private rowCounts(draftId: string): Record<ImportCategory, number> {
    const counts = emptyRowCounts();
    const rows = this.db
      .prepare('SELECT category, COUNT(*) AS n FROM workspace_rows WHERE draft_id=? AND excluded=0 GROUP BY category')
      .all(draftId) as unknown as Array<{ category: ImportCategory; n: number }>;
    for (const r of rows) counts[r.category] = r.n;
    return counts;
  }

  private toSummary(row: WorkspaceDraftRow): DraftSummary {
    const rowCounts =
      row.state === 'succeeded' || row.state === 'cancelled' ? this.storedSummary(row) : this.rowCounts(row.id);
    const totalRows = IMPORT_CATEGORIES.reduce((sum, c) => sum + (rowCounts[c] ?? 0), 0);
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSavedAt: row.last_saved_at,
      rowCounts,
      totalRows,
    };
  }

  private toDetail(row: WorkspaceDraftRow): DraftDetail {
    return {
      ...this.toSummary(row),
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      pendingOutcome: row.pending_outcome === 1,
      rowCountSummary: this.storedSummary(row),
    };
  }

  private storedSummary(row: WorkspaceDraftRow): Record<ImportCategory, number> {
    const counts = emptyRowCounts();
    try {
      const parsed = JSON.parse(row.row_count_summary) as Partial<Record<ImportCategory, number>>;
      for (const c of IMPORT_CATEGORIES) {
        if (typeof parsed[c] === 'number') counts[c] = parsed[c];
      }
    } catch {
      // 摘要 JSON 损坏时返回零计数，不影响草稿读取
    }
    return counts;
  }

  private toRowView(r: RowDbRow, cells?: Record<string, string | null>): WorkspaceRow {
    return {
      rowId: r.id,
      revision: r.revision,
      category: r.category,
      sortKey: r.sort_key,
      gridRow: r.grid_row,
      sourceRowId: r.source_row_id,
      businessKey: r.business_key,
      sourceFile: r.source_file,
      sourceSheet: r.source_sheet,
      sourceRow: r.source_row,
      pasteBatch: r.paste_batch,
      excluded: r.excluded === 1,
      cells: cells ?? {},
    };
  }

  private readOperation(id: string): OperationProgress {
    const row = this.db.prepare('SELECT * FROM workspace_operations WHERE id=?').get(id) as OperationRow | undefined;
    if (!row) throw new WorkspaceNotFoundError(`操作不存在: ${id}`);
    return this.toOperation(row);
  }

  private toOperation(r: OperationRow): OperationProgress {
    return {
      id: r.id,
      draftId: r.draft_id,
      kind: r.kind,
      state: r.state,
      stage: r.stage,
      progressCurrent: r.progress_current,
      progressTotal: r.progress_total,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      result: r.result,
    };
  }
}
