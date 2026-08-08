import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PersistenceError } from '../../core/errors';

/**
 * 正式库身份与业务修订读取/轮换 API（design D25 / tasks 8.15，Gate1 Lane A）。
 *
 * - database_instance_id：首次建库生成、此后稳定。
 * - content_generation_id：首次建库生成；成功从备份恢复后由 main 恢复接线调用
 *   rotateContentGeneration 轮换，使旧 validation seal 必失效；失败恢复不轮换。
 * - business_revision：业务表触发器维护的单调递增修订值，供 validation seal 绑定
 *   （tasks 8.35）与提交时目标修订复核（design D26）消费。
 *
 * 本模块只供主进程 / node 环境（测试）使用；渲染层不导入 local-data-persistence。
 */

export interface DatabaseIdentity {
  databaseInstanceId: string;
  contentGenerationId: string;
  businessRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** 读取正式库身份与当前业务修订。schema v10 未应用（元数据缺失）时明确报错。 */
export function readDatabaseIdentity(db: DatabaseSync): DatabaseIdentity {
  const row = db
    .prepare(
      `SELECT database_instance_id, content_generation_id, business_revision, created_at, updated_at
       FROM database_metadata WHERE id = 1`,
    )
    .get() as
    | {
        database_instance_id: string;
        content_generation_id: string;
        business_revision: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) {
    throw new PersistenceError(
      'DB_METADATA_MISSING',
      '正式库元数据缺失：schema v10 未应用，无法读取数据库身份/业务修订',
    );
  }
  return {
    databaseInstanceId: row.database_instance_id,
    contentGenerationId: row.content_generation_id,
    businessRevision: Number(row.business_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 读取当前业务修订值（单调递增计数器）。 */
export function readBusinessRevision(db: DatabaseSync): number {
  return readDatabaseIdentity(db).businessRevision;
}

/**
 * 轮换 content_generation_id（仅成功恢复后调用）：
 * 返回新 generation；元数据缺失时明确报错（恢复后重开必然已迁移到 v10，正常不会发生）。
 * 轮换是元数据写入，database_metadata 无触发器，不递增 business_revision。
 */
export function rotateContentGeneration(db: DatabaseSync): string {
  const next = randomUUID();
  const result = db
    .prepare(
      `UPDATE database_metadata
       SET content_generation_id = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(next, new Date().toISOString());
  if (result.changes !== 1) {
    throw new PersistenceError(
      'DB_METADATA_MISSING',
      '正式库元数据缺失：schema v10 未应用，无法轮换 content_generation_id',
    );
  }
  return next;
}
