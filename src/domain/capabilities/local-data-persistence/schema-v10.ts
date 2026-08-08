import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * schema v10：正式库业务修订值 + 数据库身份（design D25 / tasks 8.15，Gate1 Lane A）。
 *
 * - database_metadata 单行元数据表（singleton id=1，模式同 accounts 的 singleton CHECK）：
 *   - database_instance_id：首次建库生成、此后稳定（关闭重开/迁移升级均不变）；
 *   - content_generation_id：首次建库生成；成功从备份恢复后轮换（rotateContentGeneration），
 *     使基于旧库内容的 validation seal 必失效；失败恢复不调用轮换、保持原值；
 *   - business_revision：相关业务表 INSERT/UPDATE/DELETE 经触发器单调递增。
 * - 相关业务表触发器：facade、仓储与迁移写入全部经 SQL 落库，因此任何业务写入都不可能
 *   漏记（R9：允许保守失效，不允许漏报）。
 * - 账号（accounts）、审计（migration_audit/import_record_audit）、系统设置/元数据
 *   （app_settings/database_metadata）不挂触发器：账号/审计/元数据写入不使 seal 失效。
 *
 * 避免「海量触发器方案」的明显错误：
 * 1) SQLite 3.37+ 不再支持 AFTER INSERT OR UPDATE OR DELETE 多事件触发器，
 *   也从不支持 FOR EACH STATEMENT 触发器（3.51.3 实测均语法错误）——因此为每张业务表
 *   创建 3 个单事件触发器（insert/update/delete），不使用不存在的语法以免迁移期报错。
 * 2) 触发器体为单行计数器 UPDATE，不依赖 OLD/NEW 行数据；元数据表自身无触发器，
 *   无递归风险；每张表仅 3 个触发器、总数 57，无「每行/每格一个触发器」的膨胀。
 * 3) 计数器单调性由「单行 UPDATE business_revision+1」保证（SQLite 单写者串行化）；
 *   任何语句（含 bulk 写入、直接仓储写入、迁移写入）都按行触发递增。
 *   相同值重写的 exact no-op 检测不在本 lane 处理（AFTER 触发器对每条语句均计数）。
 * 4) 相关表清单以 BUSINESS_TABLES 单一来源维护；迁移测试对 sqlite_master 全表核对
 *   「业务表必有全部 3 个触发器、非业务表必无触发器」，防遗漏（R9 防漏报）。
 */

/** 参与业务修订的相关业务表（触发器维护清单的唯一来源，迁移测试据此核对无遗漏）。 */
export const BUSINESS_TABLES = [
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
] as const;

export type BusinessTable = (typeof BUSINESS_TABLES)[number];

/** 不参与业务修订的账号/审计/元数据表（写入不递增 business_revision）。 */
export const NON_BUSINESS_TABLES = [
  'accounts',
  'app_settings',
  'migration_audit',
  'import_record_audit',
  'import_run',
  'database_metadata',
] as const;

export type BusinessRevisionEvent = 'insert' | 'update' | 'delete';

/** 业务修订触发器名：trg_business_revision_{table}_{insert|update|delete}。 */
export function businessRevisionTriggerName(
  table: BusinessTable,
  event: BusinessRevisionEvent,
): string {
  return `trg_business_revision_${table}_${event}`;
}

export function applyBusinessRevisionMigration(db: DatabaseSync): void {
  // 正式库元数据（单行，singleton id=1）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      database_instance_id TEXT NOT NULL,
      content_generation_id TEXT NOT NULL,
      business_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  // 首次（含 v9 存量库升级到 v10）建立元数据：生成稳定 instance/generation，修订从 0 起。
  const existing = db.prepare('SELECT id FROM database_metadata WHERE id = 1').get();
  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO database_metadata (id, database_instance_id, content_generation_id, business_revision, created_at, updated_at)
       VALUES (1, ?, ?, 0, ?, ?)`,
    ).run(randomUUID(), randomUUID(), now, now);
  }

  // 每张业务表 3 个单事件 AFTER 触发器，各自使 business_revision 单调 +1。
  for (const table of BUSINESS_TABLES) {
    for (const event of ['insert', 'update', 'delete'] as const) {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS ${businessRevisionTriggerName(table, event)}
         AFTER ${event.toUpperCase()} ON ${table}
         BEGIN
           UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1;
         END;`,
      );
    }
  }
}

/** schema v10 版本号。 */
export const BUSINESS_REVISION_MIGRATION_VERSION = 10;
