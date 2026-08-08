import { join } from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';
import { PersistenceError } from '../../core/errors';
import type { BusinessDate, Clock } from '../../core/time';
import { nodeFsLike, type FsLike } from './fs-utils';

/**
 * 本地备份服务（design D18 / tasks 1.11~1.12）。
 *
 * - 每日首次使用时，若当天尚无自动备份则创建一份自动备份；当天已存在则跳过。
 * - 自动备份仅保留最近 7 份，更旧的自动备份被清理；手动备份不受数量限制。
 * - 备份使用 node:sqlite 在线 backup API（源库可继续正常使用）。
 * - 路径 / 时钟 / 文件系统均可注入，便于测试。
 */

export const AUTO_BACKUP_KEEP = 7;
export const AUTO_BACKUP_PREFIX = 'auto-';
export const MANUAL_BACKUP_PREFIX = 'manual-';
export const AUTO_BACKUP_SUFFIX = '.db';

export interface AutoBackupResult {
  created: boolean;
  /** 本次或当日已存在的自动备份路径；未创建时为 null。 */
  path: string | null;
}

export interface BackupServiceOptions {
  /** 业务日期与时间的来源（每日去重、文件名时间戳）。 */
  clock: Clock;
  fs?: FsLike;
}

export function autoBackupFileName(date: BusinessDate): string {
  return `${AUTO_BACKUP_PREFIX}${date}${AUTO_BACKUP_SUFFIX}`;
}

/** 列出目录中的自动备份文件名（按名称排序，名称按日期可字典序比较）。 */
export function listAutoBackupFiles(dir: string, fs: FsLike = nodeFsLike): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(AUTO_BACKUP_PREFIX) && name.endsWith(AUTO_BACKUP_SUFFIX))
    .sort();
}

/**
 * 每日首次使用自动备份：
 * 当日尚无自动备份时创建一份；已存在时不重复创建。
 */
export async function createAutoBackupIfNeeded(
  db: DatabaseSync,
  autoBackupDir: string,
  options: BackupServiceOptions,
): Promise<AutoBackupResult> {
  const fs = options.fs ?? nodeFsLike;
  if (!fs.existsSync(autoBackupDir)) {
    fs.mkdirSync(autoBackupDir, { recursive: true });
  }
  const today = options.clock.today();
  const target = autoBackupFileName(today);
  const targetPath = pathJoinOf(autoBackupDir, target);

  if (fs.existsSync(targetPath)) {
    // 当日已存在自动备份，不重复创建（spec：当日已有备份不重复创建）。
    return { created: false, path: targetPath };
  }

  await runOnlineBackup(db, targetPath);
  rotateAutoBackups(autoBackupDir, options);
  return { created: true, path: targetPath };
}

/**
 * 自动备份轮转：仅保留最近 keep 份自动备份，清理更旧的；
 * 手动备份（manual- 前缀）不受数量限制。
 * 返回被清理的完整路径列表。
 */
export function rotateAutoBackups(
  autoBackupDir: string,
  options: Pick<BackupServiceOptions, 'fs'> & { keep?: number },
): string[] {
  const fs = options.fs ?? nodeFsLike;
  const keep = options.keep ?? AUTO_BACKUP_KEEP;
  const files = listAutoBackupFiles(autoBackupDir, fs);
  const removed: string[] = [];
  if (files.length > keep) {
    for (const name of files.slice(0, files.length - keep)) {
      const target = pathJoinOf(autoBackupDir, name);
      fs.unlinkSync(target);
      removed.push(target);
    }
  }
  return removed;
}

/**
 * 手动备份到所选本地目录：不受最近 7 份数量限制、不参与自动轮转。
 * 文件名 `manual-yyyymmdd-HHMMSS-XXXX.db`。
 */
export async function createManualBackup(
  db: DatabaseSync,
  targetDir: string,
  options: BackupServiceOptions,
): Promise<string> {
  const fs = options.fs ?? nodeFsLike;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const now = options.clock.nowIso();
  const stamp = now.replace(/[-:T.]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const file = `${MANUAL_BACKUP_PREFIX}${stamp}-${rand}${AUTO_BACKUP_SUFFIX}`;
  const target = pathJoinOf(targetDir, file);
  await runOnlineBackup(db, target);
  return target;
}

/** node:sqlite 在线备份（async）。失败抛出明确错误，不静默视为成功。 */
export async function runOnlineBackup(db: DatabaseSync, targetPath: string): Promise<void> {
  try {
    await backup(db, targetPath);
  } catch (err) {
    throw new PersistenceError(
      'BACKUP_FAILED',
      `备份失败（目标: ${targetPath}）: ${(err as Error).message}`,
    );
  }
}

/** 与 fs 实现解耦的路径拼接（默认使用 node:path）。 */
function pathJoinOf(dir: string, file: string): string {
  return join(dir, file);
}
