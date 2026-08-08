import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersistenceError } from '../../core/errors';
import { SystemClock, type Clock } from '../../core/time';
import { nodeFsLike, type FsLike } from './fs-utils';

/**
 * 从本地备份恢复（design D18 / tasks 1.12）。
 *
 * 状态机（Oracle 恢复风险 3）：
 *   prepared ──close──▶ closed ──rename──▶ swapped ──open──▶ restored
 *       │                  │                 │
 *       └──失败：连接未关    │（rename 失败：原文件   │（open 失败：用恢复前
 *         闭，原数据不动      │  完好则重开原库，临时    │   安全快照原子回滚后重开）
 *                            │  文件消失则用快照回滚）  │
 *                            └────────── recovered ◀────┘
 *   recovered：失败后已尽力回滚原文件并重开连接，本次运行仍可继续读写旧库。
 *   fatal（recoverable=false）：连接不可用，错误明确提示需人工处理，绝不静默成功。
 *
 * 流程：
 * 1. 校验备份文件存在。
 * 2. 将备份复制到目标数据库同目录的临时文件（同目录保证 rename 原子性）。
 * 3. 以只读方式打开临时副本执行 PRAGMA integrity_check，验证备份可读。
 * 4. 创建恢复前安全快照（VACUUM INTO 生成一致快照，包含 WAL 数据）。
 * 5. 关闭当前数据库连接，清理 -wal/-shm 残留。
 * 6. 临时文件原子 rename 替换目标数据库文件。
 * 7. 重新打开连接。
 *
 * 失败保护（Oracle 恢复风险 3，重点修复）：
 * - close 之后（rename / 重开 / 回滚 rename）任何一步失败，都尽力把原库恢复回
 *   dbPath 并重新 openConnection；恢复成功则本次运行可继续读写旧库（旧数据）。
 * - rename 失败时先判断临时文件是否仍在：仍在 → 原文件未被触碰，直接重开原库；
 *   已消失（rename 半完成/状态不确定）→ 用恢复前安全快照原子回滚（同目录副本 +
 *   rename），绝不用 copy 直接覆盖 dbPath 以免中途损坏。
 * - 回滚 rename 失败 / 重开也失败 → 明确 fatal（RestoreError.recoverable=false），
 *   不静默视为成功、不留下 db=null 的静默状态：错误消息明确指出需人工处理。
 * - 临时文件清理只删 .restore 前缀临时文件，绝不影响 dbPath 与快照。
 * - 连接管理收敛到可注入的 ConnectionHolder，便于测试注入 rename/回滚/重开失败。
 */

/** 恢复状态机阶段（终态 restored；失败阶段携带于 RestoreError.failure）。 */
export type RestorePhase =
  | 'prepared' // 备份复制/校验/快照完成，连接尚未关闭
  | 'closed' // 连接已关闭，原文件尚未被替换
  | 'swapped' // 原文件已被备份替换，连接尚未重开
  | 'recovered' // 失败后已回滚原文件并重开连接（本次运行可继续读写）
  | 'restored'; // 成功终态

/** 失败时的状态机信息。 */
export interface RestoreFailureState {
  /** 失败发生/终态时的阶段。 */
  phase: Exclude<RestorePhase, 'restored'>;
  /** true: 已尽力回滚并重开原库，应用可继续读写；false: fatal，需人工处理。 */
  recoverable: boolean;
  /** 失败原因（供提示）。 */
  reason: string;
}

/**
 * 连接持有者：把「当前连接 / 关闭 / 重建」收敛为可注入、可断言的状态，
 * 使恢复流程在 close 后仍能重开原库（失败保护），并可直接测试连接状态。
 */
export interface ConnectionHolder {
  /** 当前连接；关闭后为 null（恢复成功后为重建的新连接）。 */
  readonly current: DatabaseSync | null;
  /** 关闭当前连接并置空 current。 */
  close(): void;
  /** 重建连接并更新 current（成功恢复 / 失败回滚后重开时调用）。 */
  open(): void;
}

/** 可变连接持有者标准实现：包装外部连接变量（main / 测试均可注入）。 */
export class MutableConnectionHolder implements ConnectionHolder {
  private conn: DatabaseSync | null;

  constructor(
    initial: DatabaseSync | null,
    private readonly onClose: (db: DatabaseSync) => void,
    private readonly onOpen: () => DatabaseSync,
  ) {
    this.conn = initial;
  }

  get current(): DatabaseSync | null {
    return this.conn;
  }

  close(): void {
    if (this.conn === null) return;
    this.onClose(this.conn);
    this.conn = null;
  }

  open(): void {
    this.conn = this.onOpen();
  }
}

export interface RestoreOptions {
  /** 所选本地备份文件。 */
  backupPath: string;
  /** 目标数据库文件路径。 */
  dbPath: string;
  /** 恢复前安全快照目录。 */
  snapshotDir: string;
  /**
   * 连接持有者（推荐，测试友好）：统一管理 current/close/open；
   * 提供后忽略 currentDb/closeConnection/openConnection。
   */
  holder?: ConnectionHolder;
  /**
   * 恢复成功后、连接已重开时回调（接线层挂接：如轮换 content_generation_id，
   * 使基于旧库内容的 validation seal 必失效）。仅在恢复成功路径调用；
   * 失败恢复不会进入该回调，原库 generation 保持不变。
   * 回调不传连接：接线层使用自己的连接引用（holder.current 或外部 db 变量）。
   */
  onRestored?: () => void;
  /** 当前数据库连接（用于生成一致快照；原库不存在时为 null）。 */
  currentDb?: DatabaseSync | null;
  /** 关闭当前数据库连接（应用注入）。 */
  closeConnection?: () => void;
  /** 替换完成后重新打开数据库连接（应用注入）。 */
  openConnection?: () => void;
  fs?: FsLike;
  clock?: Clock;
}

export interface RestoreResult {
  restored: boolean;
  integrityVerified: boolean;
  /** 恢复前安全快照路径（原库不存在时为空）。 */
  preRestoreSnapshotPath: string | null;
  /** 终态：成功恢复后固定为 'restored'。 */
  phase: 'restored';
}

export class RestoreError extends PersistenceError {
  /** 失败时的状态机阶段与可恢复性（recoverable=false 即 fatal）。 */
  readonly failure: RestoreFailureState;

  constructor(code: string, message: string, failure: RestoreFailureState) {
    super(code, message);
    this.name = 'RestoreError';
    this.failure = failure;
  }
}

/** 以只读连接执行 integrity_check，返回是否 'ok'。 */
export function checkIntegrity(dbPath: string): boolean {
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = ro.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return row.integrity_check === 'ok';
  } finally {
    ro.close();
  }
}

/** 计算目标数据库所在目录（用于同目录临时文件，保证原子 rename）。 */
export function dirOf(filePath: string): string {
  return dirname(filePath);
}

export function restoreFromBackup(options: RestoreOptions): RestoreResult {
  const fs = options.fs ?? nodeFsLike;
  const clock = options.clock ?? new SystemClock();
  const { backupPath, dbPath, snapshotDir } = options;
  const holder = resolveHolder(options);

  // 1. 校验备份文件存在。
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    throw new RestoreError(
      'RESTORE_BACKUP_NOT_FOUND',
      `所选备份不存在: ${backupPath}`,
      failureOf('prepared', true, `所选备份不存在: ${backupPath}`),
    );
  }

  // 2. 复制到目标数据库同目录临时文件（同卷保证原子 rename）。
  const tempPath = join(dirOf(dbPath), `.restore-${randomUUID()}.tmp`);
  let preRestoreSnapshotPath: string | null = null;

  try {
    try {
      fs.copyFileSync(backupPath, tempPath);
    } catch (err) {
      throw new RestoreError(
        'RESTORE_COPY_FAILED',
        `复制备份到临时文件失败: ${(err as Error).message}`,
        failureOf('prepared', true, `复制备份到临时文件失败: ${(err as Error).message}`),
      );
    }

    // 3. 只读验证备份副本可读（integrity_check）。
    let integrityOk = false;
    try {
      integrityOk = checkIntegrity(tempPath);
    } catch (err) {
      throw new RestoreError(
        'RESTORE_UNREADABLE',
        `备份不可读（${backupPath}）: ${(err as Error).message}`,
        failureOf('prepared', true, `备份不可读: ${(err as Error).message}`),
      );
    }
    if (!integrityOk) {
      throw new RestoreError(
        'RESTORE_INTEGRITY_FAILED',
        `备份校验失败（integrity_check 未通过），已停止恢复并保留当前数据: ${backupPath}`,
        failureOf('prepared', true, '备份完整性校验未通过'),
      );
    }

    // 4. 创建恢复前安全快照（仅当当前数据库存在且连接可用）。
    if (holder.current !== null && fs.existsSync(dbPath)) {
      if (!fs.existsSync(snapshotDir)) {
        try {
          fs.mkdirSync(snapshotDir, { recursive: true });
        } catch (err) {
          throw new RestoreError(
            'RESTORE_SNAPSHOT_FAILED',
            `创建快照目录失败: ${(err as Error).message}`,
            failureOf('prepared', true, `创建快照目录失败: ${(err as Error).message}`),
          );
        }
      }
      const stamp = clock.nowIso().replace(/[-:T.]/g, '').slice(0, 14);
      preRestoreSnapshotPath = join(
        snapshotDir,
        `pre-restore-${stamp}-${randomUUID().slice(0, 4)}.db`,
      );
      try {
        // 一致快照（VACUUM INTO 包含 WAL 数据）。
        holder.current.exec(`VACUUM INTO '${preRestoreSnapshotPath.replaceAll("'", "''")}'`);
      } catch (err) {
        throw new RestoreError(
          'RESTORE_SNAPSHOT_FAILED',
          `创建恢复前安全快照失败: ${(err as Error).message}`,
          failureOf('prepared', true, `创建恢复前安全快照失败: ${(err as Error).message}`),
        );
      }
    }

    // 5. 关闭当前连接并清理 WAL/SHM 残留。
    try {
      holder.close();
    } catch (err) {
      // 关闭失败：连接状态未知，尽力重开保证本次运行可继续读写。
      const recovered = reopenOriginal(holder);
      throw new RestoreError(
        'RESTORE_CLOSE_FAILED',
        `关闭当前数据库连接失败${recovered ? '，已重新打开原数据库' : '，且无法重新打开原数据库，需人工处理'}: ${(err as Error).message}`,
        failureOf('closed', recovered, `关闭当前数据库连接失败: ${(err as Error).message}`),
      );
    }
    removeWalShm(fs, dbPath);

    // 6. 原子替换；失败时尽力恢复原库后重开连接。
    try {
      fs.renameSync(tempPath, dbPath);
    } catch (err) {
      // rename 失败后判断原文件是否完好：临时文件仍在 → 未替换；消失 → 状态不确定，
      // 用恢复前安全快照原子回滚（覆盖「rename 已移动一半/临时文件/Windows 文件锁」）。
      const tempMoved = !fs.existsSync(tempPath);
      const recovery = recoverDatabase(fs, holder, dbPath, preRestoreSnapshotPath, tempMoved);
      throw new RestoreError(
        'RESTORE_REPLACE_FAILED',
        `替换数据库文件失败，当前数据未被覆盖${recovery.note}: ${(err as Error).message}`,
        failureOf(
          recovery.recoverable ? 'recovered' : 'closed',
          recovery.recoverable,
          `替换数据库文件失败: ${(err as Error).message}`,
        ),
      );
    }

    // 7. 重新打开连接；失败时用恢复前安全快照回滚。
    try {
      holder.open();
    } catch (err) {
      const recovery = recoverDatabase(fs, holder, dbPath, preRestoreSnapshotPath, true);
      throw new RestoreError(
        'RESTORE_REOPEN_FAILED',
        `恢复后重新打开数据库失败${recovery.note}: ${(err as Error).message}`,
        failureOf(
          recovery.recoverable ? 'recovered' : 'swapped',
          recovery.recoverable,
          `恢复后重新打开数据库失败: ${(err as Error).message}`,
        ),
      );
    }

    // 8. 恢复成功：通知接线层（轮换 content_generation_id 等）。仅在成功路径调用，
    //    失败恢复不进入此处，原库 generation 保持不变。
    options.onRestored?.();

    return {
      restored: true,
      integrityVerified: true,
      preRestoreSnapshotPath,
      phase: 'restored',
    };
  } finally {
    cleanupTempFile(fs, tempPath);
  }
}

/**
 * 兼容旧注入形式：把 currentDb/closeConnection/openConnection 适配为 ConnectionHolder。
 * 旧回调持有连接在外部（main 的 db 变量），恢复流程只保证「open 被调用」即视为重建成功。
 */
function resolveHolder(options: RestoreOptions): ConnectionHolder {
  if (options.holder) {
    return options.holder;
  }
  return {
    current: options.currentDb ?? null,
    close: () => options.closeConnection?.(),
    open: () => options.openConnection?.(),
  };
}

/**
 * rename 失败 / 重开失败后的尽力恢复：
 * - rename 未发生（临时文件仍在）→ 原文件完好，直接重开原库即可。
 * - rename 已发生或状态不确定（临时文件消失）→ 用恢复前安全快照原子回滚后重开。
 * 返回 { recoverable, note }；recoverable=false 表示连接不可用（fatal，需人工处理）。
 */
function recoverDatabase(
  fs: FsLike,
  holder: ConnectionHolder,
  dbPath: string,
  snapshotPath: string | null,
  originalPossiblyReplaced: boolean,
): { recoverable: boolean; note: string } {
  if (!originalPossiblyReplaced) {
    if (reopenOriginal(holder)) {
      return { recoverable: true, note: '；已重新打开原数据库，当前数据未被覆盖' };
    }
    return { recoverable: false, note: '；且无法重新打开原数据库，需人工处理' };
  }

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    try {
      rollbackFromSnapshot(fs, snapshotPath, dbPath);
    } catch (err) {
      return {
        recoverable: false,
        note: `；恢复前安全快照回滚也失败，请人工处理（快照: ${snapshotPath}）: ${(err as Error).message}`,
      };
    }
    if (reopenOriginal(holder)) {
      return { recoverable: true, note: '；已用恢复前安全快照回滚并重新打开原数据库' };
    }
    return { recoverable: false, note: '；安全快照回滚成功但重新打开失败，请人工处理' };
  }

  if (reopenOriginal(holder)) {
    return { recoverable: true, note: '；已重新打开数据库连接（无恢复前快照可用）' };
  }
  return { recoverable: false, note: '；且无法重开数据库，请人工处理' };
}

/**
 * 用恢复前安全快照原子回滚 dbPath：
 * 快照复制到同目录临时副本后再 rename 替换（绝不用 copyFileSync 直接覆盖 dbPath，
 * 避免回滚中途失败损坏原库），并清理 -wal/-shm。
 */
function rollbackFromSnapshot(fs: FsLike, snapshotPath: string, dbPath: string): void {
  const rollbackTemp = join(dirOf(dbPath), `.restore-rollback-${randomUUID()}.tmp`);
  try {
    fs.copyFileSync(snapshotPath, rollbackTemp);
    removeWalShm(fs, dbPath);
    fs.renameSync(rollbackTemp, dbPath);
  } finally {
    cleanupTempFile(fs, rollbackTemp);
  }
}

/** 尽力重开连接；open 未抛出即视为成功（旧回调形式由外部变量持有连接）。 */
function reopenOriginal(holder: ConnectionHolder): boolean {
  try {
    holder.open();
    return true;
  } catch {
    return false;
  }
}

/** 清理恢复临时文件；只删 .restore 前缀临时文件，绝不影响 dbPath 与快照。 */
function cleanupTempFile(fs: FsLike, tempPath: string): void {
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch {
    // 临时文件清理失败不影响恢复结果。
  }
}

function failureOf(
  phase: Exclude<RestorePhase, 'restored'>,
  recoverable: boolean,
  reason: string,
): RestoreFailureState {
  return { phase, recoverable, reason };
}

function removeWalShm(fs: FsLike, dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // WAL/SHM 清理失败不阻断 rename（新库无 WAL 记录）。
      }
    }
  }
}
