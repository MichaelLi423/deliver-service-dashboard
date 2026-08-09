import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PersistenceError, ValidationError } from '../../core/errors';
import {
  CLEAN_ALL_CONFIRM_TEXT,
  CLEAN_REJECTION_CODES,
  type CleanableTable,
  type DataCleanConfirmRequestDto,
  type DataCleanConfirmResultDto,
  type DataCleanPrepareDto,
} from '../../../shared/ipc';
import { readDatabaseIdentity, rotateContentGeneration } from './identity';

/**
 * 「清理全部业务数据」两阶段服务（prepare → confirm）。
 *
 * - prepare：返回各业务表计数、短期 token、过期时间与当前业务修订；token 以
 *   database_metadata 的 identity/generation/revision 绑定，持久化于 app_settings
 *   （app_settings 为保留表，且不参与业务修订，prepare 不改变业务修订）。
 * - confirm：必须携带 token + 固定确认文本「清理全部业务数据」。
 *   流程（TOCTOU 安全）：
 *   1) 静态校验：文本 / token / 过期（不依赖事务锁的廉价预检）；
 *   2) 执行前创建安全备份（复用现有备份机制；任何后续失败都保留备份、不清数据）；
 *   3) BEGIN IMMEDIATE 内重新核验 instance/generation/revision 与 token（期间业务
 *      写入或恢复会使 revision 变化而拒绝 → 回滚、数据不动、备份保留）；
 *   4) 同事务内：删除全部业务表与导入审计 → 目标表清零核验 → PRAGMA
 *      foreign_key_check 外键核验 → 轮换 content_generation_id（绝不 COMMIT 后轮换）
 *      → 消费清理 token（app_settings 保留但 data-clean.* 键失效）→ COMMIT。
 *   任一失败整体回滚（含轮换失败），数据不动、备份保留。
 *   保留 accounts / app_settings / database_metadata / 备份 / 独立导入工作区。
 *
 * 本模块只供主进程 / node 环境（测试）使用；渲染层不导入 local-data-persistence。
 */

export const CLEAN_TOKEN_TTL_MS = 10 * 60 * 1000;
export const CLEAN_SETTINGS_PREFIX = 'data-clean.';

/** 可清理业务表（与 schema-v10 BUSINESS_TABLES 同清单；顺序为删除依赖安全序）。
 *  contracts↔projects 环：删除前先置空 projects.contract_id（外键 ON 下安全）。 */
export const CLEAN_DELETION_ORDER: readonly string[] = [
  'activity_damage_links',
  'activity_engineers',
  'work_facts',
  'activities',
  'logistics_fees',
  'batch_change_history',
  'invoices',
  'service_orders',
  'damage_repair_items',
  'serial_address_updates',
  'qr_request_types',
  'qr_requests',
  'ship_to_requests',
  'instruments',
  'batches',
  'ship_tos',
  'contracts',
  'projects',
  'customers',
];

/** 计入清理/清零核验的导入审计表（非业务表，无业务修订触发器）。 */
export const CLEAN_AUDIT_TABLES: readonly string[] = ['migration_audit', 'import_record_audit', 'import_run'];

export interface DataCleanupOptions {
  /**
   * 清理前安全备份执行器（复用项目备份机制，如 createManualBackup）。
   * 必须返回备份文件路径；失败抛出错误即拒绝清理（数据未受影响）。
   */
  backup: (db: DatabaseSync) => Promise<string>;
  /** token 有效期（毫秒），缺省 10 分钟。 */
  tokenTtlMs?: number;
  /** 当前时间（epoch 毫秒）来源，测试可注入。 */
  now?: () => number;
  /**
   * content_generation_id 轮换执行器（缺省 rotateContentGeneration）。
   * 仅测试注入（如注入失败钩子验证事务回滚）；产品接线不配置。
   */
  rotateGeneration?: (db: DatabaseSync) => string;
  /**
   * 测试钩子（仅测试注入；产品接线不配置）：在事务内全部删除完成后、
   * 目标表清零核验前执行。用于注入清零核验失败场景。
   */
  onAfterDeletes?: (db: DatabaseSync) => void;
  /**
   * 测试钩子（仅测试注入；产品接线不配置）：在清零核验后、外键核验前执行。
   * 用于注入外键违规场景。
   */
  onBeforeForeignKeys?: (db: DatabaseSync) => void;
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

export class DataCleanupService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: DataCleanupOptions,
  ) {}

  /** prepare：返回计数 / 短期 token / 过期时间 / revision（token 绑定 DB identity）。 */
  prepare(): DataCleanPrepareDto {
    const identity = readDatabaseIdentity(this.db);
    const token = randomBytes(24).toString('hex');
    const now = this.options.now?.() ?? Date.now();
    const expiresAt = now + (this.options.tokenTtlMs ?? CLEAN_TOKEN_TTL_MS);

    const counts = {} as Record<CleanableTable, number>;
    for (const table of CLEAN_DELETION_ORDER) {
      counts[table as CleanableTable] = this.countOf(table);
    }
    const auditCounts = {
      migrationAudit: this.countOf('migration_audit'),
      importRecordAudit: this.countOf('import_record_audit'),
      importRun: this.countOf('import_run'),
    };

    settingsPut(this.db, `${CLEAN_SETTINGS_PREFIX}token`, token);
    settingsPut(this.db, `${CLEAN_SETTINGS_PREFIX}expires-at`, String(expiresAt));
    settingsPut(this.db, `${CLEAN_SETTINGS_PREFIX}revision`, String(identity.businessRevision));
    settingsPut(this.db, `${CLEAN_SETTINGS_PREFIX}database-instance-id`, identity.databaseInstanceId);
    settingsPut(this.db, `${CLEAN_SETTINGS_PREFIX}content-generation-id`, identity.contentGenerationId);

    return {
      token,
      expiresAt,
      databaseInstanceId: identity.databaseInstanceId,
      contentGenerationId: identity.contentGenerationId,
      revision: identity.businessRevision,
      counts,
      auditCounts,
    };
  }

  /**
   * confirm：静态校验 → 备份 → BEGIN IMMEDIATE 内重新核验（TOCTOU 安全）→
   * 原子清理 + 清零/外键核验 + 轮换 generation + 消费 token → COMMIT。
   * 任何失败整体回滚、数据不动、备份保留；绝不在 COMMIT 后轮换 generation。
   */
  async confirm(request: DataCleanConfirmRequestDto): Promise<DataCleanConfirmResultDto> {
    // 1) 静态预检（不依赖事务锁的廉价校验）。
    if (request.confirmText !== CLEAN_ALL_CONFIRM_TEXT) {
      throw new ValidationError(
        CLEAN_REJECTION_CODES.CONFIRM_TEXT,
        `确认文本不匹配：必须输入固定文本「${CLEAN_ALL_CONFIRM_TEXT}」`,
      );
    }
    const storedToken = settingsGet(this.db, `${CLEAN_SETTINGS_PREFIX}token`);
    if (storedToken === null) {
      throw new ValidationError(CLEAN_REJECTION_CODES.NOT_PREPARED, '尚未执行清理准备（prepare），请先调用 prepare');
    }
    if (storedToken !== request.token) {
      throw new ValidationError(CLEAN_REJECTION_CODES.TOKEN_MISMATCH, '清理 token 不匹配，拒绝执行');
    }
    const expiresAt = Number(settingsGet(this.db, `${CLEAN_SETTINGS_PREFIX}expires-at`) ?? '0');
    const now = this.options.now?.() ?? Date.now();
    if (now > expiresAt) {
      throw new ValidationError(CLEAN_REJECTION_CODES.TOKEN_EXPIRED, '清理 token 已过期，请重新执行准备');
    }
    const preparedRevision = Number(settingsGet(this.db, `${CLEAN_SETTINGS_PREFIX}revision`) ?? '-1');
    const preparedInstance = settingsGet(this.db, `${CLEAN_SETTINGS_PREFIX}database-instance-id`) ?? '';
    const preparedGeneration = settingsGet(this.db, `${CLEAN_SETTINGS_PREFIX}content-generation-id`) ?? '';

    // 2) 执行前安全备份（复用现有备份机制；备份失败即拒绝，不触碰业务数据）。
    let backupPath: string;
    try {
      backupPath = await this.options.backup(this.db);
    } catch (err) {
      throw new ValidationError(
        CLEAN_REJECTION_CODES.BACKUP_FAILED,
        `清理前安全备份失败，已取消清理（数据未受影响）: ${(err as Error).message}`,
      );
    }

    // 3) BEGIN IMMEDIATE：事务内重新核验（TOCTOU 安全）→ 原子清理 → 核验 → 轮换 → 消费 token。
    let clearedBusinessRows = 0;
    let clearedAuditRows = 0;
    let contentGenerationId = '';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 事务内重新核验 instance/generation/revision：备份与 BEGIN IMMEDIATE 之间
      // 任何业务写入/恢复都会使 revision 或 generation 变化 → 回滚、数据不动、备份保留。
      const identity = readDatabaseIdentity(this.db);
      if (
        identity.databaseInstanceId !== preparedInstance ||
        identity.contentGenerationId !== preparedGeneration ||
        identity.businessRevision !== preparedRevision
      ) {
        throw new ValidationError(
          CLEAN_REJECTION_CODES.REVISION_CHANGED,
          '数据库身份/业务修订在准备后已变化（期间存在业务写入或恢复），清理被拒绝；数据未受影响，请重新准备',
        );
      }
      // 事务内再次核验 token（BEGIN IMMEDIATE 串行化下与静态校验一致；防御性复核）。
      const tokenInside = settingsGet(this.db, `${CLEAN_SETTINGS_PREFIX}token`);
      if (tokenInside !== request.token) {
        throw new ValidationError(CLEAN_REJECTION_CODES.TOKEN_MISMATCH, '清理 token 在事务内复核不匹配，拒绝执行');
      }

      // contracts↔projects 循环外键：先置空 projects.contract_id。
      this.db.exec('UPDATE projects SET contract_id = NULL');
      for (const table of CLEAN_DELETION_ORDER) {
        clearedBusinessRows += this.deleteAllOf(table);
      }
      for (const table of CLEAN_AUDIT_TABLES) {
        clearedAuditRows += this.deleteAllOf(table);
      }
      this.options.onAfterDeletes?.(this.db);

      // 目标表清零核验：任一表仍非空即整体回滚。
      for (const table of [...CLEAN_DELETION_ORDER, ...CLEAN_AUDIT_TABLES]) {
        if (this.countOf(table) !== 0) {
          throw new PersistenceError(
            'CLEAN_VERIFY_NOT_EMPTY',
            `清理后目标表 ${table} 仍非空（count=${this.countOf(table)}），已整体回滚`,
          );
        }
      }
      this.options.onBeforeForeignKeys?.(this.db);

      // 外键核验：保留表（accounts/app_settings/database_metadata）与清空后业务表
      // 之间不得残留悬空引用（PRAGMA foreign_key_check 全表扫描）。
      const fkViolations = this.db.prepare('PRAGMA foreign_key_check').all();
      if (fkViolations.length > 0) {
        throw new PersistenceError(
          'CLEAN_FOREIGN_KEY_VIOLATION',
          `外键核验失败：${fkViolations.length} 处违规，已整体回滚`,
        );
      }

      // 事务内轮换 content_generation_id（使基于旧库内容的 validation seal 必失效；
      // 绝不 COMMIT 后轮换——轮换失败同样整体回滚）。
      const rotate = this.options.rotateGeneration ?? rotateContentGeneration;
      contentGenerationId = rotate(this.db);

      // 消费清理 token（app_settings 保留，但一次性 token 必须失效）。
      this.db.prepare(`DELETE FROM app_settings WHERE key LIKE ?`).run(`${CLEAN_SETTINGS_PREFIX}%`);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败时原数据仍未被修改；继续抛出主错误。
      }
      throw err;
    }

    return {
      clearedBusinessRows,
      clearedAuditRows,
      backupPath,
      contentGenerationId,
      businessRevision: readDatabaseIdentity(this.db).businessRevision,
    };
  }

  private countOf(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  private deleteAllOf(table: string): number {
    const result = this.db.prepare(`DELETE FROM ${table}`).run();
    return Number(result.changes);
  }
}
