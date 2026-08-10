import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { formatCents } from '../../core/money';
import { ValidationError } from '../../core/errors';
import { assertValidBusinessDate, type BusinessDate } from '../../core/time';
import type { ProjectStatus } from '../../../shared/ipc';
import { isProjectRegion } from '../../../shared/project-fields';
import type {
  WorkbenchProjectRow,
  WorkbenchV2HistoryKind,
  WorkbenchV2HistoryPageDto,
  WorkbenchV2HistoryPageRequest,
  WorkbenchV2HistoryRow,
  WorkbenchV2IndependentKind,
  WorkbenchV2IndependentPageDto,
  WorkbenchV2IndependentPageRequest,
  WorkbenchV2IndependentRow,
  WorkbenchV2LookupKind,
  WorkbenchV2LookupPageDto,
  WorkbenchV2LookupPageRequest,
  WorkbenchV2LookupRow,
  WorkbenchV2OverviewDto,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2ProjectPageRequest,
  WorkbenchV2SectionKind,
  WorkbenchV2SectionPageDto,
  WorkbenchV2SectionPageRequest,
  WorkbenchV2SectionRow,
} from '../../../shared/ipc';
import { addBusinessDays, classifyReminder } from '../workbench-todos/reminder';
import { readBusinessRevision } from './identity';
import { prepareReadBigInt } from './connection';
import { toBigInt } from './repositories';

/**
 * 工作台 v2 有界读取仓储（Oracle #10）。
 *
 * 全部读取为 SQL 有界实现：
 * - 首页/概览：聚合指标（COUNT/SUM/AVG GROUP BY）+ 提醒预览（最多 6 条）+ total；
 * - 项目 keyset 分页：默认 50、最大 100，稳定 id 游标，返回 total；
 * - 单项目详情 + 计数；单当前 tab 子记录分页；独立模块分页；lookup 分页；
 * - 禁止全量 listAll 与 JS P×C：计数经 IN(页内 id) 的有界聚合，金额经 BigInt 读取。
 *
 * 提醒到期分类与现有纯函数 classifyReminder 完全同口径：每条仅 O(1) 计算，
 * 过滤/排序在 SQL 中按 reminder_at 的日期部分（业务日期 yyyy-mm-dd，D30）完成。
 */

const STAGE_STATUSES: ProjectStatus[] = [
  'pending_entry',
  'pending_execution',
  'executing',
  'pending_acceptance',
  'pending_invoice',
  'completed',
];

export const V2_PROJECT_PAGE_DEFAULT_LIMIT = 50;
export const V2_PROJECT_PAGE_MAX_LIMIT = 100;

/** keyset 游标：[sortKey, id]，JSON 编码；sortKey 可为 null（提醒/COALESCE 场景）。 */
interface Cursor {
  sortKey: string | null;
  id: string;
}

export function encodeCursor(sortKey: string | null, id: string): string {
  return JSON.stringify([sortKey, id]);
}

export function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (parsed[0] === null || typeof parsed[0] === 'string') &&
      typeof parsed[1] === 'string'
    ) {
      return { sortKey: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to error
  }
  throw new Error(`非法分页游标: ${cursor}`);
}

export interface WorkbenchReadOptions {
  today: BusinessDate;
  windowDays: number;
}

const centsString = (cents: bigint | null): string | null => (cents === null ? null : formatCents(cents));

/** 模糊查询转义：保留字面量 % / _ / \（配合 ESCAPE '\'）。 */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * 统一 WHERE 子句构建：clauses 非空时输出 ` WHERE (c1 AND c2)`，空时输出空串。
 * 供 independent/lookup 两个 kind 共用，保证首页/后续页 SQL 结构一致且安全。
 */
function buildWhereClause(clauses: string[]): string {
  return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * 往期/时间筛选子句构建（业务日期 yyyy-mm-dd，含边界）。
 * column 为带表名/别名的日期列（如 s.updated_at）；from > to 时抛 RANGE_ORDER。
 * 返回不带 AND 前缀的裸子句（由 buildWhereClause / 调用方统一拼接），
 * 缺省（均未提供）返回空串，完全兼容现有行为。
 */
function dateRangeClause(
  range: { from?: string | null; to?: string | null },
  column: string,
): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const from = range.from;
  const to = range.to;
  if (from !== undefined && from !== null && from !== '') {
    assertValidBusinessDate(from, '起始日期');
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to !== undefined && to !== null && to !== '') {
    assertValidBusinessDate(to, '截止日期');
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
  if (from && to && from > to) {
    throw new ValidationError('RANGE_ORDER', '起始日期不得晚于截止日期');
  }
  return { sql: clauses.join(' AND '), params };
}

/**
 * 统一 keyset 游标子句构建（游标列一律带表别名，避免 JOIN 后歧义/缺列）。
 * - desc：`(<alias>.<col>, <alias>.id) < (?, ?)`（ORDER BY col DESC, id DESC 的后续页）；
 * - asc：`(<alias>.<col>, <alias>.id) > (?, ?)`（ORDER BY col ASC, id ASC 的后续页）。
 * 返回裸子句（不含 WHERE/AND 前缀），由 buildWhereClause 统一拼接，保证首页/后续页
 * 在无 query 过滤时仍生成合法 `WHERE <cursor>`（不会把 AND 错接到 JOIN ON 或裸 AND）。
 */
function buildKeysetClause(
  alias: string,
  cursorColumn: string,
  order: 'asc' | 'desc',
  cursor: string | null | undefined,
): { clause: string; params: SQLInputValue[] } {
  if (!cursor) return { clause: '', params: [] };
  const parsed = decodeCursor(cursor);
  const op = order === 'asc' ? '>' : '<';
  return {
    clause: `(${alias}.${cursorColumn}, ${alias}.id) ${op} (?, ?)`,
    params: [parsed.sortKey ?? '', parsed.id],
  };
}

/** 统一页码：默认 50、上限 100。 */
function pageLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return V2_PROJECT_PAGE_DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return V2_PROJECT_PAGE_DEFAULT_LIMIT;
  return Math.min(n, V2_PROJECT_PAGE_MAX_LIMIT);
}

type Row = Record<string, unknown>;

export class WorkbenchReadRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: WorkbenchReadOptions,
  ) {}

  // ---- 首页 / 概览 ----

  overview(): WorkbenchV2OverviewDto {
    const { today, windowDays } = this.options;
    const count = (sql: string, ...params: SQLInputValue[]): number => {
      const row = this.db.prepare(sql).get(...params) as { n: number };
      return row.n;
    };

    // 任务4.1：totalProjects 与待掉票金额在同一聚合查询（单一 SQLite 语句）内计算。
    // SQLite 单条语句在自身事务内读取一致快照，二者必然来自同一业务修订，消除
    // 「分别读取的修订之间可观察不一致」（design D2）；财务公式本身（final − 有效未撤销掉票、
    // 仅仍存在且非 cancelled 的已进单项目、JOIN contracts）保持不变。
    const aggregateRow = prepareReadBigInt(
      this.db,
      `SELECT
         (SELECT COUNT(*) FROM projects) AS total_projects,
         (SELECT COALESCE(SUM(
            CASE WHEN COALESCE(inv.total, 0) < c.final_confirmable_amount_cents
                 THEN c.final_confirmable_amount_cents - COALESCE(inv.total, 0)
                 ELSE 0 END
          ), 0) AS pending_cents
          FROM projects p
          JOIN contracts c ON c.project_id = p.id
          LEFT JOIN (SELECT project_id, SUM(amount_cents) AS total FROM invoices WHERE revoked_at IS NULL GROUP BY project_id) inv ON inv.project_id = p.id
          WHERE p.entry_at IS NOT NULL AND c.final_confirmable_amount_cents IS NOT NULL
            AND p.status <> 'cancelled') AS pending_cents`,
    ).get() as { total_projects: number | bigint; pending_cents: bigint | string | number };

    const metrics = {
      totalProjects: Number(aggregateRow.total_projects),
      activeProjects: count("SELECT COUNT(*) AS n FROM projects WHERE status NOT IN ('completed','cancelled')"),
      reminderCount: count('SELECT COUNT(*) AS n FROM projects WHERE reminder_at IS NOT NULL OR reminder_note IS NOT NULL'),
      reminderOverdue: count('SELECT COUNT(*) AS n FROM projects WHERE reminder_at IS NOT NULL AND substr(reminder_at,1,10) < ?', today),
      reminderToday: count('SELECT COUNT(*) AS n FROM projects WHERE reminder_at IS NOT NULL AND substr(reminder_at,1,10) = ?', today),
      pendingAcceptance: count("SELECT COUNT(*) AS n FROM projects WHERE status = 'pending_acceptance'"),
      pendingInvoice: count("SELECT COUNT(*) AS n FROM projects WHERE status = 'pending_invoice'"),
      // 开放维修项目数：与项目行 repairsPending 同口径（EXISTS：存在事项状态未修复且未关闭未修复）。
      openRepairProjects: count(
        `SELECT COUNT(*) AS n FROM projects p
         WHERE EXISTS (
           SELECT 1 FROM damage_repair_items d
           WHERE d.project_id = p.id AND d.issue_status NOT IN ('repaired','closed_unrepaired')
         )`,
      ),
      pendingAmount: formatCents(BigInt(String(aggregateRow.pending_cents))),
    };

    const stageRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c,
                COALESCE(ROUND(AVG(MAX(0, (unixepoch() - unixepoch(updated_at)) / 86400.0))), 0) AS avg_days
         FROM projects GROUP BY status`,
      )
      .all() as Array<{ status: string; c: number; avg_days: number }>;
    const stageByStatus = new Map(stageRows.map((r) => [r.status, r]));
    const stages = STAGE_STATUSES.map((status) => {
      const row = stageByStatus.get(status);
      return {
        status,
        count: row?.c ?? 0,
        averageDays: row ? Number(row.avg_days) : 0,
      };
    });

    const previewRows = prepareReadBigInt(
      this.db,
      `SELECT p.id, p.temp_no, p.reminder_at, p.reminder_note, c.ecc, cu.name AS customer_name
       FROM projects p
       LEFT JOIN contracts c ON c.project_id = p.id
       LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.reminder_at IS NOT NULL OR p.reminder_note IS NOT NULL
       ORDER BY p.reminder_at IS NOT NULL ASC, p.reminder_at ASC, p.id ASC
       LIMIT 6`,
    ).all() as Row[];

    const reminderPreview = previewRows.map((r) => ({
      projectId: String(r.id),
      customerName: r.customer_name === null || r.customer_name === undefined ? '客户名称待补' : String(r.customer_name),
      ecc: r.ecc === null ? null : String(r.ecc),
      tempNo: String(r.temp_no),
      reminderAt: r.reminder_at === null ? null : String(r.reminder_at),
      reminderNote: r.reminder_note === null ? null : String(r.reminder_note),
      reminderDueClass: classifyReminder(r.reminder_at === null ? null : String(r.reminder_at), today, windowDays),
    }));

    return {
      businessRevision: readBusinessRevision(this.db),
      generatedAt: new Date().toISOString(),
      metrics,
      stages,
      reminderPreview,
      reminderTotal: metrics.reminderCount,
      reminderWindowDays: windowDays,
    };
  }

  // ---- 项目 keyset 分页 ----

  projectPage(request: WorkbenchV2ProjectPageRequest): WorkbenchV2ProjectPageDto {
    const limit = pageLimit(request.limit);
    const sort = request.sort ?? 'updated';
    const where = this.buildProjectWhere(request);
    const order = this.projectOrder(sort);
    const params: SQLInputValue[] = [...where.params];
    let cursorSql = '';
    if (request.cursor) {
      const cursor = decodeCursor(request.cursor);
      const cursorPred = this.projectCursorPredicate(sort);
      cursorSql = ` AND ${cursorPred.sql}`;
      params.push(...cursorPred.params(cursor));
    }
    params.push(limit);

    const sql = `
      ${PROJECT_BASE_SELECT}
      WHERE 1=1 ${where.sql} ${cursorSql}
      ${order.sql}
      LIMIT ?`;
    const rows = prepareReadBigInt(this.db, sql).all(...params) as Row[];

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM projects p
         LEFT JOIN contracts c ON c.project_id = p.id
         LEFT JOIN customers cu ON cu.id = p.customer_id
         WHERE 1=1 ${where.sql}`,
      )
      .all(...where.params) as Array<{ n: number }>;
    const total = totalRow[0]?.n ?? 0;

    const projects = this.enrichProjects(rows);

    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? this.projectCursor(sort, last) : null;

    return {
      businessRevision: readBusinessRevision(this.db),
      projects,
      total,
      nextCursor,
      limit,
    };
  }

  // ---- 单项目详情 + 计数 ----

  projectDetail(projectId: string): WorkbenchV2ProjectDetailDto {
    const row = prepareReadBigInt(
      this.db,
      `${PROJECT_BASE_SELECT} WHERE p.id = ? LIMIT 1`,
    ).get(projectId) as Row | undefined;

    if (!row) {
      return {
        businessRevision: readBusinessRevision(this.db),
        project: null,
        detail: null,
      };
    }

    const counts = this.countsFor([String(row.id)]);
    const pendingShipTo = this.pendingShipToFor([this.customerNameOf(row)]);
    const project = this.toProjectRow(row, counts.get(String(row.id)), pendingShipTo.get(this.customerNameOf(row)) ?? 0);

    return {
      businessRevision: readBusinessRevision(this.db),
      project,
      detail: {
        managerApprovalReason: nullString(row.manager_approval_reason),
        managerApprovalMissing: nullString(row.manager_approval_missing),
        managerApproved: toNullableBool(row.manager_approved),
        projectNote: nullString(row.project_note),
        temporaryStorageAddress: nullString(row.temporary_storage_address),
        isTemporaryStorage: toNullableBool(row.is_temporary_storage),
        oldSiteContact: nullString(row.old_site_contact),
        newSiteContact: nullString(row.new_site_contact),
        oldSiteAddress: nullString(row.old_site_address),
        newSiteAddress: nullString(row.new_site_address),
        contractStartDate: nullString(row.contract_start_date),
        contractEndDate: nullString(row.contract_end_date),
        planVisitAt: nullString(row.plan_visit_at),
        planTransportAt: nullString(row.plan_transport_at),
        plannedInstallAt: nullString(row.planned_install_done_at),
        plannedInstallDoneAt: nullString(row.planned_install_done_at),
        siteConfirmed: toBool(row.site_confirmed),
        actualInstallDoneAt: nullString(row.actual_install_done_at),
        acceptanceReport: toBool(row.acceptance_report),
        acceptanceReportDate: nullString(row.acceptance_report_date),
        cancelledAt: nullString(row.cancelled_at),
        cancelReason: nullString(row.cancel_reason),
        temporaryInstrumentCount: row.temporary_instrument_count === null ? null : Number(row.temporary_instrument_count),
        createdAt: String(row.created_at),
        customerId: nullString(row.customer_id),
        contractId: nullString(row.contract_id),
      },
    };
  }

  // ---- 单当前 tab 子记录分页 ----

  sectionPage(request: WorkbenchV2SectionPageRequest): WorkbenchV2SectionPageDto {
    const limit = pageLimit(request.limit);
    const spec = SECTION_SPECS[request.kind];
    // 往期/时间筛选：行查询用表别名、count 查询用表名（SQLite 不允许引用已别名表的原名）。
    // created_at 类（instruments）按日期部分比较，保证 to 截止日期包含当天。
    const rangeRows = dateRangeClause(request, spec.dateAliasExpr);
    const rangeCount = dateRangeClause(request, spec.dateTableExpr);
    const rowsRangeSql = rangeRows.sql === '' ? '' : ` AND ${rangeRows.sql}`;
    const countRangeSql = rangeCount.sql === '' ? '' : ` AND ${rangeCount.sql}`;
    let cursorSql = '';
    const cursorParams: SQLInputValue[] = [];
    if (request.cursor) {
      const cursor = decodeCursor(request.cursor);
      cursorSql = ` AND ${spec.cursorSql}`;
      cursorParams.push(cursor.sortKey ?? '', cursor.id);
    }
    const params: SQLInputValue[] = [request.projectId, ...rangeRows.params, ...cursorParams, limit];

    const rows = prepareReadBigInt(
      this.db,
      `${spec.baseSql} ${rowsRangeSql} ${cursorSql} ${spec.orderSql} LIMIT ?`,
    ).all(...params) as Row[];

    const totalRow = this.db
      .prepare(`${spec.countSql} ${countRangeSql}`)
      .get(request.projectId, ...rangeCount.params) as { n: number };
    const total = totalRow.n;

    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? encodeCursor(String(last[spec.timeColumn] ?? ''), String(last.id)) : null;

    return {
      businessRevision: readBusinessRevision(this.db),
      kind: request.kind,
      projectId: request.projectId,
      rows: rows.map((r) => this.toSectionRow(request.kind, r)),
      total,
      nextCursor,
      limit,
    };
  }

  // ---- 独立模块分页 ----

  independentPage(request: WorkbenchV2IndependentPageRequest): WorkbenchV2IndependentPageDto {
    const limit = pageLimit(request.limit);
    const query = request.query?.trim();

    if (request.kind === 'serial_address') {
      const where: string[] = [];
      const whereParams: SQLInputValue[] = [];
      if (query) {
        const pattern = likePattern(query);
        where.push("(s.customer_name LIKE ? ESCAPE '\\' OR s.serial_no LIKE ? ESCAPE '\\' OR s.new_site_address LIKE ? ESCAPE '\\' OR s.account_id LIKE ? ESCAPE '\\')");
        whereParams.push(pattern, pattern, pattern, pattern);
      }
      // 往期/时间筛选：按业务更新日期（updated_at）。
      const range = dateRangeClause(request, 's.updated_at');
      if (range.sql !== '') where.push(range.sql);
      const { clause: cursorClause, params: cursorParams } = buildKeysetClause('s', 'created_at', 'desc', request.cursor);
      const rowWhere = buildWhereClause(cursorClause ? [...where, cursorClause] : where);
      const countWhere = buildWhereClause(where);
      const rows = prepareReadBigInt(
        this.db,
        `SELECT s.id, s.instrument_id, s.customer_name, s.new_site_address, s.serial_no, s.account_id, s.updated_at, s.created_at,
                i.name AS instrument_name
         FROM serial_address_updates s
         LEFT JOIN instruments i ON i.id = s.instrument_id
         ${rowWhere}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ?`,
      ).all(...whereParams, ...range.params, ...cursorParams, limit) as Row[];
      const totalRow = this.db
        .prepare(`SELECT COUNT(*) AS n FROM serial_address_updates s ${countWhere}`)
        .get(...whereParams, ...range.params) as { n: number };
      const total = totalRow.n;
      const last = rows[rows.length - 1];
      const nextCursor = rows.length === limit && last ? encodeCursor(String(last.created_at), String(last.id)) : null;
      return {
        businessRevision: readBusinessRevision(this.db),
        kind: request.kind,
        rows: rows.map(
          (r): WorkbenchV2IndependentRow => ({
            kind: 'serial_address',
            id: String(r.id),
            instrumentId: r.instrument_id === null || r.instrument_id === undefined ? null : String(r.instrument_id),
            instrumentName: r.instrument_name === null || r.instrument_name === undefined ? '' : String(r.instrument_name),
            serialNo: String(r.serial_no),
            customerName: String(r.customer_name),
            newSiteAddress: String(r.new_site_address),
            accountId: String(r.account_id),
            updatedAt: String(r.updated_at),
            createdAt: String(r.created_at),
          }),
        ),
        total,
        nextCursor,
        limit,
      };
    }

    const where: string[] = [];
    const whereParams: SQLInputValue[] = [];
    if (query) {
      const pattern = likePattern(query);
      where.push("q.applicant LIKE ? ESCAPE '\\'");
      whereParams.push(pattern);
    }
    // 往期/时间筛选：按业务申请日期（requested_at）。
    const range = dateRangeClause(request, 'q.requested_at');
    if (range.sql !== '') where.push(range.sql);
    const { clause: cursorClause, params: cursorParams } = buildKeysetClause('q', 'created_at', 'desc', request.cursor);
    const rowWhere = buildWhereClause(cursorClause ? [...where, cursorClause] : where);
    const countWhere = buildWhereClause(where);
    const rows = this.db
      .prepare(
        `SELECT q.id, q.applicant, q.requested_at, q.created_at FROM qr_requests q ${rowWhere}
         ORDER BY q.created_at DESC, q.id DESC
         LIMIT ?`,
      )
      .all(...whereParams, ...range.params, ...cursorParams, limit) as Row[];
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM qr_requests q ${countWhere}`)
      .get(...whereParams, ...range.params) as { n: number };
    const total = totalRow.n;
    const typesByRequest = this.qrTypesFor(rows.map((r) => String(r.id)));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? encodeCursor(String(last.created_at), String(last.id)) : null;
    return {
      businessRevision: readBusinessRevision(this.db),
      kind: request.kind,
      rows: rows.map(
        (r): WorkbenchV2IndependentRow => {
          const types = typesByRequest.get(String(r.id)) ?? [];
          return {
            kind: 'qr_request',
            id: String(r.id),
            applicant: String(r.applicant),
            requestedAt: String(r.requested_at),
            types,
            workload: types.length,
            createdAt: String(r.created_at),
          };
        },
      ),
      total,
      nextCursor,
      limit,
    };
  }

  // ---- lookup 分页 ----

  lookupPage(request: WorkbenchV2LookupPageRequest): WorkbenchV2LookupPageDto {
    const limit = pageLimit(request.limit);
    const query = request.query?.trim();

    if (request.kind === 'ship_to_requests') {
      const where: string[] = [];
      const whereParams: SQLInputValue[] = [];
      if (query) {
        const pattern = likePattern(query);
        where.push("(trim(r.customer_name) LIKE ? ESCAPE '\\' OR trim(r.new_site_address) LIKE ? ESCAPE '\\')");
        whereParams.push(pattern, pattern);
      }
      // 往期/时间筛选：按首次实际提交日期（submitted_at，业务日期）。
      const range = dateRangeClause(request, 'r.submitted_at');
      if (range.sql !== '') where.push(range.sql);
      const { clause: cursorClause, params: cursorParams } = buildKeysetClause('r', 'created_at', 'desc', request.cursor);
      const rowWhere = buildWhereClause(cursorClause ? [...where, cursorClause] : where);
      const countWhere = buildWhereClause(where);
      const rows = prepareReadBigInt(
        this.db,
        `SELECT r.id, r.customer_name, r.new_site_address, r.account_id, r.status, r.submitted_at, r.completed_at, r.created_at
         FROM ship_to_requests r ${rowWhere}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ?`,
      ).all(...whereParams, ...range.params, ...cursorParams, limit) as Row[];
      const totalRow = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ship_to_requests r ${countWhere}`)
        .get(...whereParams, ...range.params) as { n: number };
      const total = totalRow.n;
      const last = rows[rows.length - 1];
      const nextCursor = rows.length === limit && last ? encodeCursor(String(last.created_at), String(last.id)) : null;
      return {
        businessRevision: readBusinessRevision(this.db),
        kind: request.kind,
        rows: rows.map(
          (r): WorkbenchV2LookupRow => ({
            kind: 'ship_to_requests',
            id: String(r.id),
            customerName: String(r.customer_name),
            newSiteAddress: String(r.new_site_address),
            accountId: r.account_id === null ? null : String(r.account_id),
            status: r.status as 'pending_submit' | 'processing' | 'completed',
            submittedAt: r.submitted_at === null ? null : String(r.submitted_at),
            completedAt: r.completed_at === null ? null : String(r.completed_at),
            createdAt: String(r.created_at),
          }),
        ),
        total,
        nextCursor,
        limit,
      };
    }

    // customers：稳定 name+id 升序 keyset
    const where: string[] = [];
    const whereParams: SQLInputValue[] = [];
    if (query) {
      const pattern = likePattern(query);
      where.push("c.name LIKE ? ESCAPE '\\'");
      whereParams.push(pattern);
    }
    // 往期/时间筛选：按登记时间（created_at，审计技术时间；客户无独立业务日期）。
    const range = dateRangeClause(request, 'c.created_at');
    if (range.sql !== '') where.push(range.sql);
    const { clause: cursorClause, params: cursorParams } = buildKeysetClause('c', 'name', 'asc', request.cursor);
    const rowWhere = buildWhereClause(cursorClause ? [...where, cursorClause] : where);
    const countWhere = buildWhereClause(where);
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.created_at FROM customers c ${rowWhere}
         ORDER BY c.name ASC, c.id ASC
         LIMIT ?`,
      )
      .all(...whereParams, ...range.params, ...cursorParams, limit) as Row[];
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM customers c ${countWhere}`)
      .get(...whereParams, ...range.params) as { n: number };
    const total = totalRow.n;
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? encodeCursor(String(last.name), String(last.id)) : null;
    return {
      businessRevision: readBusinessRevision(this.db),
      kind: request.kind,
      rows: rows.map(
        (r): WorkbenchV2LookupRow => ({
          kind: 'customers',
          id: String(r.id),
          name: String(r.name),
          createdAt: String(r.created_at),
        }),
      ),
      total,
      nextCursor,
      limit,
    };
  }

  // ---- 跨项目历史有界分页（ora-1：#6） ----

  historyPage(request: WorkbenchV2HistoryPageRequest): WorkbenchV2HistoryPageDto {
    const limit = pageLimit(request.limit);
    const spec = HISTORY_SPECS[request.kind];
    // 往期/时间筛选：按各 kind 业务日期表达式（created_at 类用 substr 取日期部分，
    // 保证 to 截止日期包含当天）。
    const range = dateRangeClause(request, spec.dateExpr);
    const conditions = [
      spec.extraWhere ? ` AND ${spec.extraWhere}` : '',
      range.sql !== '' ? ` AND ${range.sql}` : '',
    ].join('');
    const whereSql = ` WHERE 1=1 ${conditions}`;
    const orderSql = ` ORDER BY COALESCE(${spec.dateExpr}, '') DESC, ${spec.idExpr} DESC`;
    let cursorSql = '';
    let cursorParams: SQLInputValue[] = [];
    if (request.cursor) {
      const cursor = decodeCursor(request.cursor);
      cursorSql = ` AND (COALESCE(${spec.dateExpr}, ''), ${spec.idExpr}) < (?, ?)`;
      cursorParams = [cursor.sortKey ?? '', cursor.id];
    }
    const rows = prepareReadBigInt(
      this.db,
      `SELECT ${spec.selectSql}, COALESCE(${spec.dateExpr}, '') AS __business_date
       ${spec.fromSql}
       ${whereSql} ${cursorSql} ${orderSql} LIMIT ?`,
    ).all(...range.params, ...cursorParams, limit) as Row[];
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n ${spec.fromSql} ${whereSql}`)
      .get(...range.params) as { n: number };
    const total = totalRow.n;
    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last
        ? encodeCursor(String(last.__business_date ?? ''), String(last.id))
        : null;
    return {
      businessRevision: readBusinessRevision(this.db),
      kind: request.kind,
      rows: rows.map((r) => this.toHistoryRow(request.kind, r)),
      total,
      nextCursor,
      limit,
    };
  }

  private toHistoryRow(kind: WorkbenchV2HistoryKind, r: Row): WorkbenchV2HistoryRow {
    const ctx = (): { projectId: string; customerName: string; ecc: string | null; tempNo: string } => ({
      projectId: String(r.project_id),
      customerName: r.customer_name === null || r.customer_name === undefined ? '' : String(r.customer_name),
      ecc: nullString(r.ecc),
      tempNo: String(r.temp_no ?? ''),
    });
    switch (kind) {
      case 'batch':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          planTransportDate: nullString(r.plan_transport_date),
          transportCompany: nullString(r.transport_company),
          startedAt: nullString(r.started_at),
          businessDate: nullString(r.plan_transport_date),
          createdAt: String(r.created_at),
        };
      case 'instrument':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          name: String(r.name),
          model: nullString(r.model),
          serialNo: nullString(r.serial_no),
          businessDate: String(r.created_at).slice(0, 10),
          createdAt: String(r.created_at),
        };
      case 'activity':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          visitAt: nullString(r.visit_at),
          engineers: r.engineers === null || r.engineers === undefined ? '' : String(r.engineers),
          businessDate: nullString(r.visit_at),
          createdAt: String(r.created_at),
        };
      case 'service_order':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          orderType: r.order_type as 'relocation' | 'certification' | 'parts_by_mail' | 'pm',
          serviceOrderNo: nullString(r.service_order_no),
          orderedAt: String(r.ordered_at),
          engineer: String(r.engineer),
          businessDate: String(r.ordered_at),
          createdAt: String(r.created_at),
        };
      case 'invoice':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          amount: formatCents(toBigInt(r.amount_cents) ?? 0n),
          invoicedAt: String(r.invoiced_at),
          active: r.revoked_at === null,
          businessDate: String(r.invoiced_at),
          createdAt: String(r.created_at),
        };
      case 'damage':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          instrumentName: r.instrument_name === null || r.instrument_name === undefined ? '' : String(r.instrument_name),
          issueStatus: String(r.issue_status),
          registeredAt: String(r.registered_at),
          businessDate: String(r.registered_at),
          createdAt: String(r.created_at),
        };
      case 'acceptance':
        return {
          kind,
          id: String(r.id),
          ...ctx(),
          acceptanceReportDate: String(r.acceptance_report_date),
          businessDate: String(r.acceptance_report_date),
          createdAt: String(r.created_at),
        };
      case 'ship_to_request':
        return {
          kind,
          id: String(r.id),
          projectId: null,
          customerName: String(r.customer_name),
          ecc: null,
          tempNo: '',
          newSiteAddress: String(r.new_site_address),
          status: r.status as 'pending_submit' | 'processing' | 'completed',
          submittedAt: nullString(r.submitted_at),
          businessDate: nullString(r.submitted_at),
          createdAt: String(r.created_at),
        };
    }
  }

  // ---- 内部：项目行构建与有界计数 ----

  private buildProjectWhere(request: WorkbenchV2ProjectPageRequest): { sql: string; params: SQLInputValue[] } {
    const { today, windowDays } = this.options;
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (request.status) {
      clauses.push('p.status = ?');
      params.push(request.status);
    }
    if (request.region && request.region.trim()) {
      clauses.push('p.region = ?');
      params.push(request.region.trim());
    }
    if (request.query && request.query.trim()) {
      const pattern = likePattern(request.query.trim());
      clauses.push("(cu.name LIKE ? ESCAPE '\\' OR p.temp_no LIKE ? ESCAPE '\\' OR c.ecc LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    if (request.reminder) {
      switch (request.reminder) {
        case 'any':
          clauses.push('(p.reminder_at IS NOT NULL OR p.reminder_note IS NOT NULL)');
          break;
        case 'overdue':
          clauses.push('p.reminder_at IS NOT NULL AND substr(p.reminder_at,1,10) < ?');
          params.push(today);
          break;
        case 'today':
          clauses.push('p.reminder_at IS NOT NULL AND substr(p.reminder_at,1,10) = ?');
          params.push(today);
          break;
        case 'upcoming':
          clauses.push(
            'p.reminder_at IS NOT NULL AND substr(p.reminder_at,1,10) > ? AND substr(p.reminder_at,1,10) <= ?',
          );
          params.push(today, addBusinessDays(today, windowDays));
          break;
      }
    }
    // 维修伪筛选：open=存在开放维修事项（与 repairsPending 同口径），非项目主状态。
    if (request.repair === 'open') {
      clauses.push(
        `EXISTS (
           SELECT 1 FROM damage_repair_items dr
           WHERE dr.project_id = p.id AND dr.issue_status NOT IN ('repaired','closed_unrepaired')
         )`,
      );
    }
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
  }

  private projectOrder(sort: string): { sql: string } {
    switch (sort) {
      case 'created':
        return { sql: 'ORDER BY p.created_at DESC, p.id DESC' };
      case 'temp':
        return { sql: 'ORDER BY p.temp_no ASC, p.id ASC' };
      case 'reminder':
        return { sql: "ORDER BY COALESCE(p.reminder_at, '') ASC, p.id ASC" };
      case 'updated':
      default:
        return { sql: 'ORDER BY p.updated_at DESC, p.id DESC' };
    }
  }

  private projectCursorPredicate(sort: string): { sql: string; params: (c: Cursor) => SQLInputValue[] } {
    switch (sort) {
      case 'created':
        return { sql: '(p.created_at, p.id) < (?, ?)', params: (c) => [c.sortKey ?? '', c.id] };
      case 'temp':
        return { sql: '(p.temp_no, p.id) > (?, ?)', params: (c) => [c.sortKey ?? '', c.id] };
      case 'reminder':
        return { sql: "(COALESCE(p.reminder_at, ''), p.id) > (?, ?)", params: (c) => [c.sortKey ?? '', c.id] };
      case 'updated':
      default:
        return { sql: '(p.updated_at, p.id) < (?, ?)', params: (c) => [c.sortKey ?? '', c.id] };
    }
  }

  private projectCursor(sort: string, row: Row): string {
    switch (sort) {
      case 'created':
        return encodeCursor(String(row.created_at), String(row.id));
      case 'temp':
        return encodeCursor(String(row.temp_no), String(row.id));
      case 'reminder':
        return encodeCursor(row.reminder_at === null ? '' : String(row.reminder_at), String(row.id));
      case 'updated':
      default:
        return encodeCursor(String(row.updated_at), String(row.id));
    }
  }

  private customerNameOf(row: Row): string {
    return row.customer_name === null || row.customer_name === undefined ? '客户名称待补' : String(row.customer_name);
  }

  private toProjectRow(row: Row, counts: Counts | undefined, pendingShipTo: number): WorkbenchProjectRow {
    const c = counts ?? EMPTY_COUNTS;
    return {
      id: String(row.id),
      tempNo: String(row.temp_no),
      ecc: row.ecc === null ? null : String(row.ecc),
      customerName: this.customerNameOf(row),
      status: row.status as ProjectStatus,
      formallyEntered: row.entry_at !== null && row.entry_at !== undefined,
      preEntryExecution: toBool(row.pre_entry_execution),
      region: row.region === null ? null : String(row.region),
      regionNeedsAdjustment:
        row.region !== null && row.region !== undefined && !isProjectRegion(String(row.region)),
      entryAt: row.entry_at === null ? null : String(row.entry_at),
      reminderAt: row.reminder_at === null ? null : String(row.reminder_at),
      reminderNote: row.reminder_note === null ? null : String(row.reminder_note),
      reminderDueClass: classifyReminder(
        row.reminder_at === null ? null : String(row.reminder_at),
        this.options.today,
        this.options.windowDays,
      ),
      finalAmount: centsString(toBigInt(row.final_confirmable_amount_cents)),
      invoicedAmount: formatCents(toBigInt(row.invoiced_cents) ?? 0n),
      contractAmount: centsString(toBigInt(row.usd_tax_amount_cents)),
      counts: {
        batches: c.batches,
        instruments: c.instruments,
        activities: c.activities,
        orders: c.orders,
        repairs: c.repairs,
      },
      nonBlocking: {
        pendingShipTo,
        qrUnmarked: c.qrUnmarked,
        repairs: c.repairsPending,
      },
      updatedAt: String(row.updated_at),
    };
  }

  /** 页内项目的有界计数（IN(页内 id) GROUP BY，禁止全量扫描）。 */
  private countsFor(projectIds: string[]): Map<string, Counts> {
    const map = new Map<string, Counts>();
    if (projectIds.length === 0) return map;
    const placeholders = projectIds.map(() => '?').join(',');
    const init = (id: string): Counts => {
      const existing = map.get(id);
      if (existing) return existing;
      const next = { batches: 0, instruments: 0, activities: 0, orders: 0, repairs: 0, qrUnmarked: 0, repairsPending: 0 };
      map.set(id, next);
      return next;
    };

    const batches = this.db
      .prepare(`SELECT project_id, COUNT(*) AS n FROM batches WHERE project_id IN (${placeholders}) GROUP BY project_id`)
      .all(...projectIds) as Array<{ project_id: string; n: number }>;
    for (const r of batches) init(r.project_id).batches = r.n;

    const instruments = this.db
      .prepare(
        `SELECT project_id, COUNT(*) AS n, SUM(CASE WHEN qr_requested = 0 THEN 1 ELSE 0 END) AS qr
         FROM instruments WHERE project_id IN (${placeholders}) GROUP BY project_id`,
      )
      .all(...projectIds) as Array<{ project_id: string; n: number; qr: number | null }>;
    for (const r of instruments) {
      const c = init(r.project_id);
      c.instruments = r.n;
      c.qrUnmarked = r.qr ?? 0;
    }

    const activities = this.db
      .prepare(`SELECT project_id, COUNT(*) AS n FROM activities WHERE project_id IN (${placeholders}) GROUP BY project_id`)
      .all(...projectIds) as Array<{ project_id: string; n: number }>;
    for (const r of activities) init(r.project_id).activities = r.n;

    const orders = this.db
      .prepare(`SELECT project_id, COUNT(*) AS n FROM service_orders WHERE project_id IN (${placeholders}) GROUP BY project_id`)
      .all(...projectIds) as Array<{ project_id: string; n: number }>;
    for (const r of orders) init(r.project_id).orders = r.n;

    const repairs = this.db
      .prepare(
        `SELECT project_id, COUNT(*) AS n, SUM(CASE WHEN issue_status NOT IN ('repaired','closed_unrepaired') THEN 1 ELSE 0 END) AS pending
         FROM damage_repair_items WHERE project_id IN (${placeholders}) GROUP BY project_id`,
      )
      .all(...projectIds) as Array<{ project_id: string; n: number; pending: number | null }>;
    for (const r of repairs) {
      const c = init(r.project_id);
      c.repairs = r.n;
      c.repairsPending = r.pending ?? 0;
    }
    return map;
  }

  /** 页内客户名的非完成 Ship-to 申请计数（有界 IN 查询）。 */
  private pendingShipToFor(customerNames: string[]): Map<string, number> {
    const map = new Map<string, number>();
    const distinct = [...new Set(customerNames.filter((n) => n && n !== '客户名称待补'))];
    if (distinct.length === 0) return map;
    const placeholders = distinct.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT customer_name, COUNT(*) AS n FROM ship_to_requests
         WHERE customer_name IN (${placeholders}) AND status != 'completed'
         GROUP BY customer_name`,
      )
      .all(...distinct) as Array<{ customer_name: string; n: number }>;
    for (const r of rows) map.set(r.customer_name, r.n);
    return map;
  }

  private enrichProjects(rows: Row[]): WorkbenchProjectRow[] {
    if (rows.length === 0) return [];
    const projectIds = rows.map((r) => String(r.id));
    const counts = this.countsFor(projectIds);
    const pendingShipTo = this.pendingShipToFor(rows.map((r) => this.customerNameOf(r)));
    return rows.map((r) =>
      this.toProjectRow(r, counts.get(String(r.id)), pendingShipTo.get(this.customerNameOf(r)) ?? 0),
    );
  }

  private qrTypesFor(requestIds: string[]): Map<string, readonly string[]> {
    const map = new Map<string, readonly string[]>();
    if (requestIds.length === 0) return map;
    const placeholders = requestIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT qr_request_id, type_code FROM qr_request_types
         WHERE qr_request_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...requestIds) as Array<{ qr_request_id: string; type_code: string }>;
    const grouped = new Map<string, string[]>();
    for (const r of rows) {
      const list = grouped.get(r.qr_request_id) ?? [];
      list.push(r.type_code);
      grouped.set(r.qr_request_id, list);
    }
    for (const [id, types] of grouped) map.set(id, types);
    return map;
  }

  private toSectionRow(kind: WorkbenchV2SectionKind, r: Row): WorkbenchV2SectionRow {
    switch (kind) {
      case 'batches':
        return {
          kind,
          id: String(r.id),
          projectId: String(r.project_id),
          planTransportDate: nullString(r.plan_transport_date),
          transportCompany: nullString(r.transport_company),
          originalPrice: centsString(toBigInt(r.original_price_cents)),
          discountedPrice: centsString(toBigInt(r.discounted_price_cents)),
          startedAt: nullString(r.started_at),
          createdAt: String(r.created_at),
        };
      case 'instruments':
        return {
          kind,
          id: String(r.id),
          projectId: String(r.project_id),
          batchId: nullString(r.batch_id),
          name: String(r.name),
          model: nullString(r.model),
          manufacturer: nullString(r.manufacturer),
          serviceLevel: nullString(r.service_level),
          serialNo: nullString(r.serial_no),
          ups: toBool(r.ups),
          qrRequested: toBool(r.qr_requested),
          destinationShipToId: nullString(r.destination_ship_to_id),
          createdAt: String(r.created_at),
        };
      case 'activities':
        return {
          kind,
          id: String(r.id),
          projectId: String(r.project_id),
          visitAt: nullString(r.visit_at),
          engineers: r.engineers === null || r.engineers === undefined ? '' : String(r.engineers),
          createdAt: String(r.created_at),
        };
      case 'orders':
        return {
          kind,
          id: String(r.id),
          projectId: nullString(r.project_id),
          orderType: r.order_type as 'relocation' | 'certification' | 'parts_by_mail' | 'pm',
          serviceOrderNo: nullString(r.service_order_no),
          orderedAt: String(r.ordered_at),
          engineer: String(r.engineer),
          customerName: String(r.customer_name),
          note: nullString(r.note),
          createdAt: String(r.created_at),
        };
      case 'invoices':
        return {
          kind,
          id: String(r.id),
          projectId: String(r.project_id),
          amount: formatCents(toBigInt(r.amount_cents) ?? 0n),
          invoicedAt: String(r.invoiced_at),
          active: r.revoked_at === null,
          revokedAt: nullString(r.revoked_at),
          revokeReason: nullString(r.revoke_reason),
          lastModifiedAt: String(r.last_modified_at),
          createdAt: String(r.created_at),
        };
      case 'damage_items':
        return {
          kind,
          id: String(r.id),
          projectId: String(r.project_id),
          instrumentId: String(r.instrument_id),
          instrumentName: r.instrument_name === null || r.instrument_name === undefined ? '' : String(r.instrument_name),
          serialNo: nullString(r.serial_no),
          damageReason: nullString(r.damage_reason),
          issueStatus: String(r.issue_status),
          partNumber: r.part_number === null || r.part_number === undefined ? '' : String(r.part_number),
          partQuantity: r.part_quantity === null ? 0 : Number(r.part_quantity),
          partAmount: formatCents(toBigInt(r.part_amount_cents) ?? 0n),
          partCurrency: nullString(r.part_currency),
          partStatus: nullString(r.part_status),
          registeredAt: String(r.registered_at),
          repairNote: nullString(r.repair_note),
          createdAt: String(r.created_at),
        };
    }
  }
}

interface Counts {
  batches: number;
  instruments: number;
  activities: number;
  orders: number;
  repairs: number;
  qrUnmarked: number;
  repairsPending: number;
}

const EMPTY_COUNTS: Counts = {
  batches: 0,
  instruments: 0,
  activities: 0,
  orders: 0,
  repairs: 0,
  qrUnmarked: 0,
  repairsPending: 0,
};

const nullString = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** readBigInts 下 INTEGER 布尔列（0/1）读为 bigint，统一转换。 */
const toBool = (v: unknown): boolean => v === 1 || v === '1' || v === 1n;
/** 可空 INTEGER 布尔（v15 可空列：1/true → true、0/false → false、null → null）。 */
const toNullableBool = (v: unknown): boolean | null =>
  v === null || v === undefined ? null : v === 1 || v === '1' || v === 1n;

/** 项目分页基础 SELECT（金额列经 BigInt 读取）。 */
const PROJECT_BASE_SELECT = `
  SELECT
    p.id, p.temp_no, p.status, p.pre_entry_execution, p.region, p.entry_at,
    p.reminder_at, p.reminder_note, p.updated_at,
    p.manager_approval_reason, p.manager_approval_missing, p.manager_approved,
    p.project_note, p.temporary_storage_address, p.is_temporary_storage,
    p.old_site_contact, p.new_site_contact, p.old_site_address, p.new_site_address,
    p.contract_start_date, p.contract_end_date, p.plan_visit_at, p.plan_transport_at,
    p.planned_install_done_at,
    p.site_confirmed, p.actual_install_done_at, p.acceptance_report, p.acceptance_report_date,
    p.cancelled_at, p.cancel_reason, p.temporary_instrument_count,
    p.created_at, p.customer_id, p.contract_id,
    c.ecc, c.final_confirmable_amount_cents, c.usd_tax_amount_cents,
    cu.name AS customer_name,
    (SELECT COALESCE(SUM(i.amount_cents), 0) FROM invoices i
      WHERE i.project_id = p.id AND i.revoked_at IS NULL) AS invoiced_cents
  FROM projects p
  LEFT JOIN contracts c ON c.project_id = p.id
  LEFT JOIN customers cu ON cu.id = p.customer_id`;

/** 各 tab 子记录分页查询（keyset 游标列一律 COALESCE 成可比较字符串）。 */
const SECTION_SPECS: Record<
  WorkbenchV2SectionKind,
  { baseSql: string; countSql: string; orderSql: string; cursorSql: string; timeColumn: string; table: string; alias: string; dateAliasExpr: string; dateTableExpr: string }
> = {
  batches: {
    baseSql:
      'SELECT b.id, b.project_id, b.plan_transport_date, b.transport_company, b.original_price_cents, b.discounted_price_cents, b.started_at, b.created_at FROM batches b WHERE b.project_id = ?',
    countSql: 'SELECT COUNT(*) AS n FROM batches WHERE project_id = ?',
    orderSql: 'ORDER BY b.created_at DESC, b.id DESC',
    cursorSql: '(b.created_at, b.id) < (?, ?)',
    timeColumn: 'created_at',
    table: 'batches',
    alias: 'b',
    dateAliasExpr: 'b.plan_transport_date',
    dateTableExpr: 'batches.plan_transport_date',
  },
  instruments: {
    baseSql:
      'SELECT i.id, i.project_id, i.batch_id, i.name, i.model, i.manufacturer, i.service_level, i.serial_no, i.ups, i.qr_requested, i.destination_ship_to_id, i.created_at FROM instruments i WHERE i.project_id = ?',
    countSql: 'SELECT COUNT(*) AS n FROM instruments WHERE project_id = ?',
    orderSql: 'ORDER BY i.created_at DESC, i.id DESC',
    cursorSql: '(i.created_at, i.id) < (?, ?)',
    timeColumn: 'created_at',
    table: 'instruments',
    alias: 'i',
    dateAliasExpr: 'substr(i.created_at, 1, 10)',
    dateTableExpr: 'substr(instruments.created_at, 1, 10)',
  },
  activities: {
    baseSql: `SELECT a.id, a.project_id, a.visit_at, a.created_at,
                    (SELECT GROUP_CONCAT(ae.engineer, '、') FROM activity_engineers ae WHERE ae.activity_id = a.id) AS engineers
              FROM activities a WHERE a.project_id = ?`,
    countSql: 'SELECT COUNT(*) AS n FROM activities WHERE project_id = ?',
    orderSql: "ORDER BY COALESCE(a.visit_at, '') DESC, a.id DESC",
    cursorSql: "(COALESCE(a.visit_at, ''), a.id) < (?, ?)",
    timeColumn: 'visit_at',
    table: 'activities',
    alias: 'a',
    dateAliasExpr: 'a.visit_at',
    dateTableExpr: 'activities.visit_at',
  },
  orders: {
    baseSql:
      'SELECT o.id, o.project_id, o.order_type, o.service_order_no, o.ordered_at, o.engineer, o.customer_name, o.note, o.created_at FROM service_orders o WHERE o.project_id = ?',
    countSql: 'SELECT COUNT(*) AS n FROM service_orders WHERE project_id = ?',
    orderSql: 'ORDER BY o.created_at DESC, o.id DESC',
    cursorSql: '(o.created_at, o.id) < (?, ?)',
    timeColumn: 'created_at',
    table: 'service_orders',
    alias: 'o',
    dateAliasExpr: 'o.ordered_at',
    dateTableExpr: 'service_orders.ordered_at',
  },
  invoices: {
    baseSql:
      'SELECT v.id, v.project_id, v.amount_cents, v.invoiced_at, v.revoked_at, v.revoke_reason, v.last_modified_at, v.created_at FROM invoices v WHERE v.project_id = ?',
    countSql: 'SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?',
    orderSql: 'ORDER BY v.created_at DESC, v.id DESC',
    cursorSql: '(v.created_at, v.id) < (?, ?)',
    timeColumn: 'created_at',
    table: 'invoices',
    alias: 'v',
    dateAliasExpr: 'v.invoiced_at',
    dateTableExpr: 'invoices.invoiced_at',
  },
  damage_items: {
    baseSql: `SELECT d.id, d.project_id, d.instrument_id, d.damage_reason, d.issue_status,
                     d.part_number, d.part_quantity, d.part_amount_cents, d.part_currency, d.part_status,
                     d.registered_at, d.repair_note, d.created_at,
                     i.name AS instrument_name, i.serial_no
              FROM damage_repair_items d
              LEFT JOIN instruments i ON i.id = d.instrument_id
              WHERE d.project_id = ?`,
    countSql: 'SELECT COUNT(*) AS n FROM damage_repair_items WHERE project_id = ?',
    orderSql: 'ORDER BY d.created_at DESC, d.id DESC',
    cursorSql: '(d.created_at, d.id) < (?, ?)',
    timeColumn: 'created_at',
    table: 'damage_repair_items',
    alias: 'd',
    dateAliasExpr: 'd.registered_at',
    dateTableExpr: 'damage_repair_items.registered_at',
  },
};

/** 独立模块分页 kind 合法校验（独立页面查询使用）。 */
export const INDEPENDENT_KINDS: readonly WorkbenchV2IndependentKind[] = ['serial_address', 'qr_request'] as const;
export const LOOKUP_KINDS: readonly WorkbenchV2LookupKind[] = ['ship_to_requests', 'customers'] as const;

/**
 * 跨项目历史分页查询规格（ora-1：#6）。
 * - 项目关联 kind 全部 INNER JOIN projects/customers/contracts（跨项目历史只浏览项目内记录；
 *   service_orders.project_id 可空 → 非搬迁类开单不计入跨项目历史）；
 * - dateExpr：业务日期表达式；instrument 无业务日期字段，按 created_at 日期部分
 *   （substr）过滤与输出，保证 to 截止日期包含当天；
 * - 排序/游标统一按 COALESCE(dateExpr,'') DESC, id DESC（无日期者排在末尾）。
 */
interface HistorySpec {
  fromSql: string;
  selectSql: string;
  idExpr: string;
  dateExpr: string;
  extraWhere?: string;
}

const HISTORY_SPECS: Record<WorkbenchV2HistoryKind, HistorySpec> = {
  batch: {
    fromSql:
      'FROM batches b JOIN projects p ON p.id = b.project_id LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN contracts c ON c.project_id = p.id',
    selectSql:
      'b.id, b.project_id, b.plan_transport_date, b.transport_company, b.started_at, b.created_at, cu.name AS customer_name, c.ecc, p.temp_no',
    idExpr: 'b.id',
    dateExpr: 'b.plan_transport_date',
  },
  instrument: {
    fromSql:
      'FROM instruments i JOIN projects p ON p.id = i.project_id LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN contracts c ON c.project_id = p.id',
    selectSql:
      'i.id, i.project_id, i.name, i.model, i.serial_no, i.created_at, cu.name AS customer_name, c.ecc, p.temp_no',
    idExpr: 'i.id',
    dateExpr: 'substr(i.created_at, 1, 10)',
  },
  activity: {
    fromSql:
      'FROM activities a JOIN projects p ON p.id = a.project_id LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN contracts c ON c.project_id = p.id',
    selectSql: `a.id, a.project_id, a.visit_at, a.created_at,
                (SELECT GROUP_CONCAT(ae.engineer, '、') FROM activity_engineers ae WHERE ae.activity_id = a.id) AS engineers,
                cu.name AS customer_name, c.ecc, p.temp_no`,
    idExpr: 'a.id',
    dateExpr: 'a.visit_at',
  },
  service_order: {
    fromSql:
      'FROM service_orders o JOIN projects p ON p.id = o.project_id LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN contracts c ON c.project_id = p.id',
    selectSql:
      'o.id, o.project_id, o.order_type, o.service_order_no, o.ordered_at, o.engineer, o.created_at, cu.name AS customer_name, c.ecc, p.temp_no',
    idExpr: 'o.id',
    dateExpr: 'o.ordered_at',
  },
  invoice: {
    fromSql:
      'FROM invoices v JOIN projects p ON p.id = v.project_id LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN contracts c ON c.project_id = p.id',
    selectSql:
      'v.id, v.project_id, v.amount_cents, v.invoiced_at, v.revoked_at, v.created_at, cu.name AS customer_name, c.ecc, p.temp_no',
    idExpr: 'v.id',
    dateExpr: 'v.invoiced_at',
  },
  damage: {
    fromSql: `FROM damage_repair_items d
              JOIN projects p ON p.id = d.project_id
              LEFT JOIN customers cu ON cu.id = p.customer_id
              LEFT JOIN contracts c ON c.project_id = p.id
              LEFT JOIN instruments di ON di.id = d.instrument_id`,
    selectSql:
      'd.id, d.project_id, d.issue_status, d.registered_at, d.created_at, di.name AS instrument_name, cu.name AS customer_name, c.ecc, p.temp_no',
    idExpr: 'd.id',
    dateExpr: 'd.registered_at',
  },
  acceptance: {
    fromSql:
      'FROM projects p LEFT JOIN customers cu ON cu.id = p.customer_id LEFT JOIN contracts c ON c.project_id = p.id',
    selectSql: 'p.id, p.id AS project_id, p.temp_no, p.acceptance_report_date, p.created_at, cu.name AS customer_name, c.ecc',
    idExpr: 'p.id',
    dateExpr: 'p.acceptance_report_date',
    extraWhere: 'p.acceptance_report = 1',
  },
  ship_to_request: {
    fromSql: 'FROM ship_to_requests r',
    selectSql:
      "r.id, NULL AS project_id, r.customer_name, r.new_site_address, r.status, r.submitted_at, r.created_at, '' AS temp_no, NULL AS ecc",
    idExpr: 'r.id',
    dateExpr: 'r.submitted_at',
  },
};
