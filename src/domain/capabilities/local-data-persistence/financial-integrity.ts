import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PersistenceError, ValidationError } from '../../core/errors';
import { newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import {
  assertValidBusinessDate,
  SystemClock,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import { readDatabaseIdentity } from './identity';

/**
 * 财务完整性：孤立财务数据只读诊断 + 治理清理两阶段服务（design D2 / Tasks 2.3 / 4.3 / 4.4）。
 *
 * 一、只读诊断（4.3 / 2.3 同源实现）：
 * - 单条 SELECT 同时计算五类固定计数（单条语句即一致性快照，等价「同一只读事务」）：
 *   孤立合同、孤立掉票、孤立最终可确认金额事实、断裂 project/contract 链接、
 *   PRAGMA foreign_key_check 违规数（仅计数，不返回/打印 ID、客户名、金额或原始行）。
 * - 孤立最终可确认金额事实 = 孤立合同且 final_confirmable_amount_cents 非空；
 *   projects.contract_id 为 NULL 不视为断裂链接。
 * - 默认只读、不删除任何财务记录；结构性外键违规（含治理撤销后的保留行）以
 *   foreignKeyViolations / unresolved count 持续报告，不宣称 foreign_key_check 归零。
 *
 * 二、治理清理（4.4，防复发）：
 * - prepare → confirm 两阶段，token 绑定 database identity/generation/revision 与计数；
 * - confirm 前置：负责人固定确认文本 + 执行前安全备份（失败即拒绝、数据未受影响）；
 * - BEGIN IMMEDIATE 内复核 token/identity/generation/revision/counts（TOCTOU 安全）；
 * - 仅治理撤销活跃孤立掉票（保留原行、写固定治理原因/日期/actor、经既有撤销语义进入
 *   撤销终态）；已撤销孤立掉票保持不动；孤立合同/断裂链接不可靠修复时保留 unresolved；
 * - 写 financial_integrity_cleanup_audit（仅计数）；任一失败整体回滚、备份保留。
 *
 * 本模块只供主进程 / node 环境（测试）使用；渲染层不导入 local-data-persistence。
 */

/** 治理确认固定文本（负责人显式确认；不匹配即拒绝）。 */
export const FINANCIAL_INTEGRITY_CONFIRM_TEXT = '执行财务完整性治理清理';

/** 治理撤销固定原因（孤立掉票治理撤销一律写入，保留原行）。 */
export const GOVERNANCE_REVOKE_REASON =
  '孤立掉票治理撤销：所引用项目不存在，经备份与负责人显式确认后按既有撤销语义撤销，保留原行';

export const FINANCIAL_INTEGRITY_TOKEN_TTL_MS = 10 * 60 * 1000;
export const FINANCIAL_INTEGRITY_SETTINGS_PREFIX = 'financial-integrity.';

/** 治理 confirm 拒绝稳定错误码（本服务未接入 IPC，测试直接按 code 断言）。 */
export const FINANCIAL_INTEGRITY_REJECTION_CODES = {
  CONFIRM_TEXT: 'FINANCIAL_INTEGRITY_CONFIRM_TEXT_REQUIRED',
  NOT_PREPARED: 'FINANCIAL_INTEGRITY_NOT_PREPARED',
  TOKEN_MISMATCH: 'FINANCIAL_INTEGRITY_TOKEN_MISMATCH',
  TOKEN_EXPIRED: 'FINANCIAL_INTEGRITY_TOKEN_EXPIRED',
  REVISION_CHANGED: 'FINANCIAL_INTEGRITY_REVISION_CHANGED',
  COUNTS_CHANGED: 'FINANCIAL_INTEGRITY_COUNTS_CHANGED',
  BACKUP_FAILED: 'FINANCIAL_INTEGRITY_BACKUP_FAILED',
} as const;

export type FinancialIntegrityRejectionCode =
  (typeof FINANCIAL_INTEGRITY_REJECTION_CODES)[keyof typeof FINANCIAL_INTEGRITY_REJECTION_CODES];

/** 五类固定只读诊断计数（仅计数，不携带任何客户值）。 */
export interface FinancialIntegrityCounts {
  /** 孤立合同：合同引用的项目不存在。 */
  orphanContracts: number;
  /** 孤立掉票：掉票引用的项目不存在（含已撤销孤立掉票；撤销后行保留仍被计数）。 */
  orphanInvoices: number;
  /** 孤立最终可确认金额事实：孤立合同且 final_confirmable_amount_cents 非空。 */
  orphanFinalConfirmableFacts: number;
  /** 断裂 project/contract 链接：projects.contract_id 非空但指向不存在的合同。 */
  brokenProjectContractLinks: number;
  /** 结构性外键违规总数（PRAGMA foreign_key_check 行数；仅计数，不返回原始行）。 */
  foreignKeyViolations: number;
}

/** 五类计数单条聚合 SELECT：单条语句在 SQLite 中即一致性快照（等价同一只读事务）。 */
const FINANCIAL_INTEGRITY_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM contracts c
       WHERE c.project_id NOT IN (SELECT id FROM projects)) AS orphan_contracts,
    (SELECT COUNT(*) FROM invoices i
       WHERE i.project_id NOT IN (SELECT id FROM projects)) AS orphan_invoices,
    (SELECT COUNT(*) FROM contracts c
       WHERE c.project_id NOT IN (SELECT id FROM projects)
         AND c.final_confirmable_amount_cents IS NOT NULL) AS orphan_final_confirmable,
    (SELECT COUNT(*) FROM projects p
       WHERE p.contract_id IS NOT NULL
         AND p.contract_id NOT IN (SELECT id FROM contracts)) AS broken_project_links,
    (SELECT COUNT(*) FROM pragma_foreign_key_check) AS fk_violations
`;

/**
 * 计算五类只读计数（单条 SELECT 即一致性快照）。
 * 调用方负责事务上下文：只读诊断直接调用；治理 confirm 在 BEGIN IMMEDIATE 内调用。
 */
export function computeFinancialIntegrityCounts(db: DatabaseSync): FinancialIntegrityCounts {
  const row = db.prepare(FINANCIAL_INTEGRITY_COUNTS_SQL).get() as {
    orphan_contracts: number;
    orphan_invoices: number;
    orphan_final_confirmable: number;
    broken_project_links: number;
    fk_violations: number;
  };
  return {
    orphanContracts: Number(row.orphan_contracts),
    orphanInvoices: Number(row.orphan_invoices),
    orphanFinalConfirmableFacts: Number(row.orphan_final_confirmable),
    brokenProjectContractLinks: Number(row.broken_project_links),
    foreignKeyViolations: Number(row.fk_violations),
  };
}

/**
 * 只读孤立财务数据诊断：BEGIN 读事务内计算五类固定计数。
 * 默认只读、不删除任何财务记录；不返回/打印任何客户值或 foreign_key_check 原始行。
 * 结构性外键违规（含治理撤销后的保留行）以 foreignKeyViolations 持续报告，不宣称归零。
 */
export function readFinancialIntegrityCounts(db: DatabaseSync): FinancialIntegrityCounts {
  db.exec('BEGIN');
  try {
    const counts = computeFinancialIntegrityCounts(db);
    db.exec('COMMIT');
    return counts;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时原库仍未被修改；继续抛出主错误。
    }
    throw err;
  }
}

/** 全零判断：用于 bootstrap 是否输出治理提示。 */
export function hasAnyFinancialIntegrityIssue(counts: FinancialIntegrityCounts): boolean {
  return (
    counts.orphanContracts > 0 ||
    counts.orphanInvoices > 0 ||
    counts.orphanFinalConfirmableFacts > 0 ||
    counts.brokenProjectContractLinks > 0 ||
    counts.foreignKeyViolations > 0
  );
}

/**
 * 治理清理路径提示（固定文本 + 本次计数；不包含任何客户值、不宣称 FK 归零）。
 * 全部计数为 0 时返回 null（无提示）。
 */
export function buildFinancialIntegrityHint(counts: FinancialIntegrityCounts): string | null {
  if (!hasAnyFinancialIntegrityIssue(counts)) return null;
  return (
    `孤立财务数据诊断（仅计数，未删除任何记录）：孤立合同=${counts.orphanContracts}，` +
    `孤立掉票=${counts.orphanInvoices}，孤立最终可确认金额事实=${counts.orphanFinalConfirmableFacts}，` +
    `断裂项目/合同链接=${counts.brokenProjectContractLinks}，结构性外键违规=${counts.foreignKeyViolations}。` +
    `治理路径：活跃孤立掉票可经「备份 + 负责人显式确认 + 审计结果记录」的两阶段治理撤销进入撤销终态` +
    `并保留原行；孤立合同与断裂链接无法可靠自动修复，需人工恢复/治理。` +
    `因掉票等项目外键非空且治理撤销保留原行，结构性外键违规以 unresolved count 持续报告，` +
    `不宣称 foreign_key_check 已归零。`
  );
}

export interface FinancialIntegrityCleanupOptions {
  /** 治理前安全备份执行器（复用项目备份机制）。必须返回备份文件路径；失败抛出错误即拒绝治理。 */
  backup: (db: DatabaseSync) => Promise<string>;
  /** token 有效期（毫秒），缺省 10 分钟。 */
  tokenTtlMs?: number;
  /** 当前时间（epoch 毫秒）来源，测试可注入。 */
  now?: () => number;
  /** 负责人会话快照（治理撤销与审计行写入的 actor）。 */
  session: () => ActorSnapshot;
  /** 时钟（治理撤销默认业务日期与审计时间），测试可注入。 */
  clock?: Clock;
}

export interface FinancialIntegrityPrepareDto {
  token: string;
  expiresAt: number;
  databaseInstanceId: string;
  contentGenerationId: string;
  revision: number;
  counts: FinancialIntegrityCounts;
}

export interface FinancialIntegrityConfirmRequestDto {
  token: string;
  /** 必须等于固定确认文本，否则拒绝。 */
  confirmText: string;
  /** 治理撤销业务日期（yyyy-mm-dd）；缺省取时钟今天。 */
  revokedAt?: BusinessDate;
}

export interface FinancialIntegrityConfirmResultDto {
  backupId: string;
  auditId: string;
  operationId: string;
  countsBefore: FinancialIntegrityCounts;
  countsAfter: FinancialIntegrityCounts;
  governanceRevokedCount: number;
  unresolvedCount: number;
  businessRevision: number;
  contentGenerationId: string;
}

function settingsGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function settingsPut(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

function countsEqual(a: FinancialIntegrityCounts, b: FinancialIntegrityCounts): boolean {
  return (
    a.orphanContracts === b.orphanContracts &&
    a.orphanInvoices === b.orphanInvoices &&
    a.orphanFinalConfirmableFacts === b.orphanFinalConfirmableFacts &&
    a.brokenProjectContractLinks === b.brokenProjectContractLinks &&
    a.foreignKeyViolations === b.foreignKeyViolations
  );
}

/**
 * 财务完整性治理清理服务（两阶段 prepare → confirm）。
 * - prepare：返回五类计数、短期 token、过期时间、DB identity/generation/revision；
 *   token 与计数一并绑定并持久化于 app_settings（app_settings 不参与业务修订）。
 * - confirm：固定确认文本 + token + 可选治理撤销日期；流程（TOCTOU 安全）：
 *   1) 静态校验（文本/token/过期/撤销日期）；
 *   2) 执行前创建安全备份（任何后续失败都保留备份、数据不动）；
 *   3) BEGIN IMMEDIATE 内复核 instance/generation/revision/token/counts；
 *   4) 同事务内仅治理撤销活跃孤立掉票（保留原行、写固定治理原因/日期/actor、
 *      已撤销保持不动）→ 治理后复核计数 → 写 financial_integrity_cleanup_audit（仅计数）
 *      → 消费治理 token → COMMIT。
 *   任一失败整体回滚、数据不动、备份保留；孤立合同/断裂链接无法可靠自动修复时
 *   保留为 unresolved（foreignKeyViolations 持续报告，不宣称 foreign_key_check 归零）。
 */
export class FinancialIntegrityCleanupService {
  private readonly clock: Clock;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: FinancialIntegrityCleanupOptions,
  ) {
    this.clock = options.clock ?? new SystemClock();
  }

  /** prepare：返回五类计数 / 短期 token / 过期时间 / revision（token 绑定 DB identity 与计数）。 */
  prepare(): FinancialIntegrityPrepareDto {
    const identity = readDatabaseIdentity(this.db);
    const token = randomBytes(24).toString('hex');
    const now = this.options.now?.() ?? Date.now();
    const expiresAt = now + (this.options.tokenTtlMs ?? FINANCIAL_INTEGRITY_TOKEN_TTL_MS);
    const counts = computeFinancialIntegrityCounts(this.db);

    settingsPut(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}token`, token);
    settingsPut(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}expires-at`, String(expiresAt));
    settingsPut(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}revision`, String(identity.businessRevision));
    settingsPut(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}database-instance-id`, identity.databaseInstanceId);
    settingsPut(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}content-generation-id`, identity.contentGenerationId);
    settingsPut(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}counts`, JSON.stringify(counts));

    return {
      token,
      expiresAt,
      databaseInstanceId: identity.databaseInstanceId,
      contentGenerationId: identity.contentGenerationId,
      revision: identity.businessRevision,
      counts,
    };
  }

  /**
   * confirm：静态校验 → 备份 → BEGIN IMMEDIATE 内复核（TOCTOU 安全）→ 治理撤销 → 复核
   * → 审计 → 消费 token → COMMIT。任何失败整体回滚、数据不动、备份保留。
   */
  async confirm(request: FinancialIntegrityConfirmRequestDto): Promise<FinancialIntegrityConfirmResultDto> {
    // 1) 静态预检（不依赖事务锁的廉价校验）。
    if (request.confirmText !== FINANCIAL_INTEGRITY_CONFIRM_TEXT) {
      throw new ValidationError(
        FINANCIAL_INTEGRITY_REJECTION_CODES.CONFIRM_TEXT,
        `确认文本不匹配：必须输入固定文本「${FINANCIAL_INTEGRITY_CONFIRM_TEXT}」`,
      );
    }
    const storedToken = settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}token`);
    if (storedToken === null) {
      throw new ValidationError(
        FINANCIAL_INTEGRITY_REJECTION_CODES.NOT_PREPARED,
        '尚未执行治理准备（prepare），请先调用 prepare',
      );
    }
    if (storedToken !== request.token) {
      throw new ValidationError(FINANCIAL_INTEGRITY_REJECTION_CODES.TOKEN_MISMATCH, '治理 token 不匹配，拒绝执行');
    }
    const expiresAt = Number(settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}expires-at`) ?? '0');
    const now = this.options.now?.() ?? Date.now();
    if (now > expiresAt) {
      throw new ValidationError(
        FINANCIAL_INTEGRITY_REJECTION_CODES.TOKEN_EXPIRED,
        '治理 token 已过期，请重新执行准备',
      );
    }
    const revokedAt = request.revokedAt ?? this.clock.today();
    assertValidBusinessDate(revokedAt, '治理撤销日期');

    // 2) 执行前安全备份（复用现有备份机制；备份失败即拒绝，不触碰业务数据）。
    let backupId: string;
    try {
      backupId = await this.options.backup(this.db);
    } catch (err) {
      throw new ValidationError(
        FINANCIAL_INTEGRITY_REJECTION_CODES.BACKUP_FAILED,
        `治理前安全备份失败，已取消治理（数据未受影响）: ${(err as Error).message}`,
      );
    }

    // 3) BEGIN IMMEDIATE：事务内复核 → 治理撤销 → 复核 → 审计 → 消费 token。
    let countsBefore: FinancialIntegrityCounts;
    let countsAfter: FinancialIntegrityCounts;
    let governanceRevokedCount = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const identity = readDatabaseIdentity(this.db);
      const preparedInstance = settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}database-instance-id`) ?? '';
      const preparedGeneration = settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}content-generation-id`) ?? '';
      const preparedRevision = Number(settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}revision`) ?? '-1');
      if (
        identity.databaseInstanceId !== preparedInstance ||
        identity.contentGenerationId !== preparedGeneration ||
        identity.businessRevision !== preparedRevision
      ) {
        throw new ValidationError(
          FINANCIAL_INTEGRITY_REJECTION_CODES.REVISION_CHANGED,
          '数据库身份/业务修订在准备后已变化（期间存在业务写入或恢复），治理被拒绝；数据未受影响，请重新准备',
        );
      }
      // 事务内再次核验 token（BEGIN IMMEDIATE 串行化下与静态校验一致；防御性复核）。
      const tokenInside = settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}token`);
      if (tokenInside !== request.token) {
        throw new ValidationError(
          FINANCIAL_INTEGRITY_REJECTION_CODES.TOKEN_MISMATCH,
          '治理 token 在事务内复核不匹配，拒绝执行',
        );
      }
      // 事务内复核计数（prepared 计数绑定于 token；数据变化即拒绝）。
      const preparedCounts = this.readPreparedCounts();
      countsBefore = computeFinancialIntegrityCounts(this.db);
      if (!countsEqual(countsBefore, preparedCounts)) {
        throw new ValidationError(
          FINANCIAL_INTEGRITY_REJECTION_CODES.COUNTS_CHANGED,
          '孤立数据计数在准备后已变化，治理被拒绝；数据未受影响，请重新准备',
        );
      }

      // 4) 仅治理撤销活跃孤立掉票（保留原行、写固定治理原因/日期/actor；已撤销保持不动）。
      const actor = this.options.session();
      const nowIso = this.clock.nowIso();
      const revokeResult = this.db
        .prepare(
          `UPDATE invoices
           SET revoked_at = ?, revoke_reason = ?, last_modified_at = ?, account_id = ?, username_snapshot = ?
           WHERE revoked_at IS NULL AND project_id NOT IN (SELECT id FROM projects)`,
        )
        .run(revokedAt, GOVERNANCE_REVOKE_REASON, nowIso, actor.accountId, actor.username);
      governanceRevokedCount = Number(revokeResult.changes);

      // 5) 治理后复核：结构性外键违规（含保留的已撤销孤立掉票行）以 unresolved 持续报告。
      countsAfter = computeFinancialIntegrityCounts(this.db);
      const unresolvedCount = countsAfter.foreignKeyViolations;

      // 6) 写 financial_integrity_cleanup_audit（仅计数，不存任何客户值）。
      const auditId = newInternalId();
      const operationId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO financial_integrity_cleanup_audit (
             id, operation_id, backup_id,
             orphan_contracts_before_count, orphan_contracts_after_count,
             orphan_invoices_before_count, orphan_invoices_after_count,
             orphan_final_confirmable_facts_before_count, orphan_final_confirmable_facts_after_count,
             broken_project_links_before_count, broken_project_links_after_count,
             foreign_key_violations_before_count, foreign_key_violations_after_count,
             governance_revoked_count, unresolved_count,
             actor_id, actor_username_snapshot, result, cleaned_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          auditId,
          operationId,
          backupId,
          countsBefore.orphanContracts,
          countsAfter.orphanContracts,
          countsBefore.orphanInvoices,
          countsAfter.orphanInvoices,
          countsBefore.orphanFinalConfirmableFacts,
          countsAfter.orphanFinalConfirmableFacts,
          countsBefore.brokenProjectContractLinks,
          countsAfter.brokenProjectContractLinks,
          countsBefore.foreignKeyViolations,
          countsAfter.foreignKeyViolations,
          governanceRevokedCount,
          unresolvedCount,
          actor.accountId,
          actor.username,
          'succeeded',
          nowIso,
        );

      // 7) 消费治理 token（app_settings 保留，但一次性 token 失效）。
      this.db.prepare('DELETE FROM app_settings WHERE key LIKE ?').run(`${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}%`);
      this.db.exec('COMMIT');

      return {
        backupId,
        auditId,
        operationId,
        countsBefore,
        countsAfter,
        governanceRevokedCount,
        unresolvedCount,
        businessRevision: readDatabaseIdentity(this.db).businessRevision,
        contentGenerationId: readDatabaseIdentity(this.db).contentGenerationId,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败时原数据仍未被修改；继续抛出主错误。
      }
      throw err;
    }
  }

  /** 读取 prepare 持久化的计数绑定；缺失/损坏视为未正确准备。 */
  private readPreparedCounts(): FinancialIntegrityCounts {
    const raw = settingsGet(this.db, `${FINANCIAL_INTEGRITY_SETTINGS_PREFIX}counts`);
    if (raw === null) {
      throw new ValidationError(
        FINANCIAL_INTEGRITY_REJECTION_CODES.COUNTS_CHANGED,
        '治理准备时未记录计数绑定，请重新执行 prepare',
      );
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FinancialIntegrityCounts>;
      return {
        orphanContracts: Number(parsed.orphanContracts ?? -1),
        orphanInvoices: Number(parsed.orphanInvoices ?? -1),
        orphanFinalConfirmableFacts: Number(parsed.orphanFinalConfirmableFacts ?? -1),
        brokenProjectContractLinks: Number(parsed.brokenProjectContractLinks ?? -1),
        foreignKeyViolations: Number(parsed.foreignKeyViolations ?? -1),
      };
    } catch {
      throw new PersistenceError('FINANCIAL_INTEGRITY_COUNTS_CORRUPT', '治理准备的计数绑定损坏，请重新执行 prepare');
    }
  }
}
