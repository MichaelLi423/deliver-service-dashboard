import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { PersistenceError } from '../../core/errors';

/**
 * 本地 SQLite 连接（design D17 / tasks 1.9）。
 *
 * - 访问库：Node 内置 node:sqlite（DatabaseSync），无原生依赖。
 * - 连接配置：WAL、foreign_keys=ON、busy_timeout（tasks 0.2 决策）。
 * - 路径注入：便于测试使用真实临时 SQLite 文件。
 */

export interface OpenDatabaseOptions {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  /** 建库前确保目录存在（测试/主进程均可注入）。 */
  ensureDirectory?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  if (options.ensureDirectory !== false && !options.readOnly) {
    try {
      mkdirSync(dirname(options.path), { recursive: true });
    } catch (err) {
      throw new PersistenceError(
        'DB_DIR_CREATE_FAILED',
        `无法创建数据目录 ${dirname(options.path)}: ${(err as Error).message}`,
      );
    }
  }
  let db: DatabaseSync;
  try {
    db = options.readOnly
      ? new DatabaseSync(options.path, { readOnly: true })
      : new DatabaseSync(options.path);
  } catch (err) {
    throw new PersistenceError('DB_OPEN_FAILED', `无法打开数据库 ${options.path}: ${(err as Error).message}`);
  }
  try {
    if (!options.readOnly) {
      // WAL 模式：在线备份、并发读写与崩溃安全。
      db.exec(`PRAGMA journal_mode = WAL;`);
    }
    db.exec(`PRAGMA foreign_keys = ON;`);
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
  } catch (err) {
    db.close();
    throw new PersistenceError('DB_PRAGMA_FAILED', `数据库连接配置失败: ${(err as Error).message}`);
  }
  return db;
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch (err) {
    throw new PersistenceError('DB_CLOSE_FAILED', `关闭数据库失败: ${(err as Error).message}`);
  }
}

/** 读取当前 PRAGMA user_version。 */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** 设置 PRAGMA user_version（迁移事务内调用）。 */
export function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version};`);
}

/**
 * 准备一条 SQL 语句并启用「整数以 BigInt 读取」（Oracle 高风险：金额精度）。
 *
 * node:sqlite 默认把 INTEGER 读为 JS number；超过 Number.MAX_SAFE_INTEGER 的值会
 * 抛 RangeError，安全范围内的值也可能在后续 Number 运算中丢精度。金额/分整数一律
 * 经本 helper 读取为 BigInt，由调用方 toBigInt/BigInt 继续处理。
 * 非金额计数（COUNT、行数等）不适用本 helper，保持 Number 读取。
 */
export function prepareReadBigInt(db: DatabaseSync, sql: string): StatementSync {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt;
}
