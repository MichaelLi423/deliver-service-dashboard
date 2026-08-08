import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { createManualBackup } from '../../src/domain/capabilities/local-data-persistence/backup';
import { nodeFsLike, type FsLike } from '../../src/domain/capabilities/local-data-persistence/fs-utils';
import {
  MutableConnectionHolder,
  RestoreError,
  restoreFromBackup,
} from '../../src/domain/capabilities/local-data-persistence/restore';
import {
  readDatabaseIdentity,
  rotateContentGeneration,
} from '../../src/domain/capabilities/local-data-persistence/identity';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir, makeTempDbPath } from '../helpers/tmp-db';

/** 注入失败/覆盖部分文件系统行为的 FsLike（其余委托真实 node:fs）。 */
function makeRestoreFs(overrides: Partial<FsLike>): FsLike {
  return { ...nodeFsLike, ...overrides };
}

/** 构造含「旧数据」的原库与含「备份数据」的备份，返回两者路径。 */
async function setupDbAndBackup(dir: string) {
  const dbPath = join(dir, 'workbench.db');
  let db = bootstrapDatabase({ dataDir: dir }).db;
  db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
    'keep',
    '旧数据',
    't',
    't',
  );
  closeDatabase(db);

  const backupSrcDir = join(dir, 'backup-src');
  const backupDb = bootstrapDatabase({ dataDir: backupSrcDir });
  backupDb.db
    .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
    .run('bk', '备份数据', 't', 't');
  const backupPath = await createManualBackup(backupDb.db, join(dir, 'backup'), {
    clock: new FixedClock('2026-08-07T10:00:00+08:00'),
  });
  closeDatabase(backupDb.db);

  return { dbPath, backupPath };
}

describe('手动备份恢复与失败保护（tasks 1.12 / D18）', () => {
  it('确认并验证后恢复成功：恢复后数据与备份一致', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'workbench.db');
      const snapshotDir = join(dir, 'restore-snapshots');
      const backupDir = join(dir, 'backup');

      // 当前库含「当前数据」
      let db = bootstrapDatabase({ dataDir: dir }).db;
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '当前数据',
        't',
        't',
      );
      closeDatabase(db);

      // 在备份库写入「备份数据」
      const backupSrcDir = join(dir, 'backup-src');
      const backupDb = bootstrapDatabase({ dataDir: backupSrcDir });
      backupDb.db
        .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run('c2', '备份数据', 't', 't');
      const backupPath = await createManualBackup(backupDb.db, backupDir, {
        clock: new FixedClock('2026-08-07T10:00:00+08:00'),
      });
      closeDatabase(backupDb.db);

      // 恢复：先复制备份到 dbPath 同目录、只读 integrity_check、安全快照、原子替换、重开连接
      db = openDatabase({ path: dbPath });
      const result = restoreFromBackup({
        backupPath,
        dbPath,
        snapshotDir,
        currentDb: db,
        closeConnection: () => closeDatabase(db),
        openConnection: () => {
          db = openDatabase({ path: dbPath });
        },
        clock: new FixedClock('2026-08-07T11:00:00+08:00'),
      });
      expect(result.restored).toBe(true);
      expect(result.integrityVerified).toBe(true);
      expect(result.preRestoreSnapshotPath).toBeTruthy();
      expect(existsSync(result.preRestoreSnapshotPath!)).toBe(true);

      // 恢复后读取到备份数据
      const row = db.prepare('SELECT * FROM customers').get() as { name: string };
      expect(row.name).toBe('备份数据');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('备份不可读/损坏时停止恢复并保留当前数据（不覆盖）', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'workbench.db');
      const snapshotDir = join(dir, 'restore-snapshots');

      let db = bootstrapDatabase({ dataDir: dir }).db;
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'keep',
        '当前数据不可覆盖',
        't',
        't',
      );
      closeDatabase(db);

      // 伪造损坏备份：非 SQLite 内容
      const corrupt = join(dir, 'corrupt-backup.db');
      writeFileSync(corrupt, 'not a sqlite database at all');

      db = openDatabase({ path: dbPath });
      expect(() =>
        restoreFromBackup({
          backupPath: corrupt,
          dbPath,
          snapshotDir,
          currentDb: db,
          closeConnection: () => closeDatabase(db),
          openConnection: () => {
            db = openDatabase({ path: dbPath });
          },
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        }),
      ).toThrow(RestoreError);

      // 当前数据未被覆盖
      const row = db.prepare('SELECT * FROM customers').get() as { name: string };
      expect(row.name).toBe('当前数据不可覆盖');
      closeDatabase(db);

      // 重开后数据仍在
      const reopened = openDatabase({ path: dbPath });
      const again = reopened.prepare('SELECT * FROM customers').get() as { name: string };
      expect(again.name).toBe('当前数据不可覆盖');
      closeDatabase(reopened);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('所选备份不存在时给出明确错误', () => {
    const dir = makeTempDir();
    try {
      const dbPath = makeTempDbPath(dir);
      const snapshotDir = join(dir, 'snapshots');
      const db = openDatabase({ path: dbPath });
      try {
        expect(() =>
          restoreFromBackup({
            backupPath: join(dir, 'no-such-backup.db'),
            dbPath,
            snapshotDir,
            currentDb: db,
            closeConnection: () => closeDatabase(db),
            openConnection: () => {
              // 不应被调用
            },
            clock: new FixedClock('2026-08-07T11:00:00+08:00'),
          }),
        ).toThrow(/所选备份不存在/);
      } finally {
        closeDatabase(db);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Oracle 恢复风险 3：close 后任何替换/重开失败都必须尽力恢复原库并重开连接', () => {
  it('替换（rename）失败后自动重开原库：旧库立即可查询并写入（核心回归）', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db = openDatabase({ path: dbPath });
      const holder = new MutableConnectionHolder(db, closeDatabase, () => openDatabase({ path: dbPath }));

      // 注入：主替换 rename 失败（回滚 rename 不受影响）
      const failingFs = makeRestoreFs({
        renameSync: (from, to) => {
          if (from.includes('.restore-') && !from.includes('rollback')) {
            throw new Error('模拟替换 rename 失败');
          }
          nodeFsLike.renameSync(from, to);
        },
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          holder,
          fs: failingFs,
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err!.code).toBe('RESTORE_REPLACE_FAILED');
      expect(err!.failure.recoverable).toBe(true); // 可恢复，不是 fatal
      expect(err!.failure.phase).toBe('recovered');

      // 旧库立即可查询
      const conn = holder.current!;
      expect(conn).not.toBeNull();
      const row = conn.prepare('SELECT name FROM customers').get() as { name: string };
      expect(row.name).toBe('旧数据');
      // 立即可写入
      conn
        .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run('w1', '替换失败后写入', 't', 't');
      const written = conn.prepare('SELECT name FROM customers WHERE id = ?').get('w1') as {
        name: string;
      };
      expect(written.name).toBe('替换失败后写入');

      // 临时文件已清理（清理不影响旧库）
      const leftovers = readdirSync(dir).filter((f) => f.includes('.restore-') && f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);

      closeDatabase(conn);
      // 重开后仍是旧数据（未被备份覆盖）
      const reopened = openDatabase({ path: dbPath });
      const again = reopened.prepare('SELECT name FROM customers WHERE id = ?').get('keep') as {
        name: string;
      };
      expect(again.name).toBe('旧数据');
      closeDatabase(reopened);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('兼容旧回调注入（main 接线不变）：rename 失败时同样自动重开原库', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db: ReturnType<typeof openDatabase> | null = openDatabase({ path: dbPath });

      const failingFs = makeRestoreFs({
        renameSync: (from, to) => {
          if (from.includes('.restore-') && !from.includes('rollback')) {
            throw new Error('模拟替换 rename 失败');
          }
          nodeFsLike.renameSync(from, to);
        },
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          currentDb: db,
          closeConnection: () => {
            closeDatabase(db!);
            db = null;
          },
          openConnection: () => {
            db = openDatabase({ path: dbPath });
          },
          fs: failingFs,
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err!.code).toBe('RESTORE_REPLACE_FAILED');
      expect(err!.failure.recoverable).toBe(true);

      // main 风格：openConnection 回调已重建 db，立即可查询并写入
      expect(db).not.toBeNull();
      const row = db!.prepare('SELECT name FROM customers').get() as { name: string };
      expect(row.name).toBe('旧数据');
      db!.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'w2',
        '回调重开后写入',
        't',
        't',
      );
      expect(db!.prepare('SELECT name FROM customers WHERE id = ?').get('w2')).toMatchObject({
        name: '回调重开后写入',
      });
      closeDatabase(db!);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('恢复后重开连接失败时用安全快照回滚并重开原库：旧数据可继续读写', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db = openDatabase({ path: dbPath });
      // 首次重开失败（模拟恢复后打开恢复库失败），回滚重开时成功
      let openCount = 0;
      const holder = new MutableConnectionHolder(db, closeDatabase, () => {
        openCount += 1;
        if (openCount === 1) {
          throw new Error('模拟恢复后打开失败');
        }
        return openDatabase({ path: dbPath });
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          holder,
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err!.code).toBe('RESTORE_REOPEN_FAILED');
      expect(err!.failure.recoverable).toBe(true); // 快照回滚成功 → 可恢复
      expect(err!.failure.phase).toBe('recovered');
      expect(err!.message).toMatch(/安全快照回滚/);

      // 回滚后连接可用，读到的是旧数据（非备份数据）
      const conn = holder.current!;
      expect(conn).not.toBeNull();
      const row = conn.prepare('SELECT name FROM customers').get() as { name: string };
      expect(row.name).toBe('旧数据');
      conn
        .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run('w3', '回滚后写入', 't', 't');
      expect(conn.prepare('SELECT name FROM customers WHERE id = ?').get('w3')).toMatchObject({
        name: '回滚后写入',
      });
      closeDatabase(conn);

      // 磁盘文件已由快照还原为旧数据
      const reopened = openDatabase({ path: dbPath });
      expect(reopened.prepare('SELECT name FROM customers WHERE id = ?').get('keep')).toMatchObject({
        name: '旧数据',
      });
      closeDatabase(reopened);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('rename 半移动（临时文件已消失）时用安全快照原子回滚：旧数据恢复且可写入', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db = openDatabase({ path: dbPath });
      const holder = new MutableConnectionHolder(db, closeDatabase, () => openDatabase({ path: dbPath }));

      // 注入：主替换 rename 抛错，且临时文件查询为已消失（模拟 rename 移动了一半/不确定）
      const halfMovedFs = makeRestoreFs({
        renameSync: (from, to) => {
          if (from.includes('.restore-') && !from.includes('rollback')) {
            throw new Error('模拟 rename 半移动失败');
          }
          nodeFsLike.renameSync(from, to);
        },
        existsSync: (p) => (p.includes('.tmp') ? false : nodeFsLike.existsSync(p)),
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          holder,
          fs: halfMovedFs,
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err!.code).toBe('RESTORE_REPLACE_FAILED');
      expect(err!.failure.recoverable).toBe(true); // 走快照回滚 → 可恢复
      expect(err!.failure.phase).toBe('recovered');
      expect(err!.message).toMatch(/安全快照回滚/);

      // 快照回滚后旧数据恢复且可写入
      const conn = holder.current!;
      expect(conn).not.toBeNull();
      const row = conn.prepare('SELECT name FROM customers').get() as { name: string };
      expect(row.name).toBe('旧数据');
      conn
        .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run('w4', '半移动回滚后写入', 't', 't');
      expect(conn.prepare('SELECT name FROM customers WHERE id = ?').get('w4')).toMatchObject({
        name: '半移动回滚后写入',
      });
      closeDatabase(conn);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('回滚 rename 失败时明确 fatal（recoverable=false）：不静默留下 db=null', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db = openDatabase({ path: dbPath });
      // 重开始终失败；回滚 rename 也失败 → 明确 fatal
      const holder = new MutableConnectionHolder(db, closeDatabase, () => {
        throw new Error('模拟打开始终失败');
      });
      const failingFs = makeRestoreFs({
        renameSync: (from, to) => {
          if (from.includes('rollback')) {
            throw new Error('模拟回滚 rename 失败');
          }
          nodeFsLike.renameSync(from, to);
        },
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          holder,
          fs: failingFs,
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err!.code).toBe('RESTORE_REOPEN_FAILED');
      expect(err!.failure.recoverable).toBe(false); // fatal
      expect(err!.failure.phase).toBe('swapped');
      expect(err!.message).toMatch(/人工处理/);

      // 连接未重开（holder.current 为 null），但错误已明确而非静默 db=null
      expect(holder.current).toBeNull();
      // 快照仍保留，供人工恢复
      expect(err!.message).toMatch(/快照/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('替换失败且重开原库也失败时明确 fatal（recoverable=false）', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db = openDatabase({ path: dbPath });
      const holder = new MutableConnectionHolder(db, closeDatabase, () => {
        throw new Error('模拟重开原库失败');
      });
      const failingFs = makeRestoreFs({
        renameSync: (from, to) => {
          if (from.includes('.restore-') && !from.includes('rollback')) {
            throw new Error('模拟替换 rename 失败');
          }
          nodeFsLike.renameSync(from, to);
        },
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          holder,
          fs: failingFs,
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err!.code).toBe('RESTORE_REPLACE_FAILED');
      expect(err!.failure.recoverable).toBe(false);
      expect(err!.message).toMatch(/人工处理/);
      expect(holder.current).toBeNull();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('恢复与 content_generation_id（Gate1 Lane A / design D25）', () => {
  it('成功恢复后轮换 content_generation_id：旧 generation 必失效、instance 保持备份的', async () => {
    const dir = makeTempDir();
    try {
      // 当前库：身份 instanceA / genA + 业务数据「当前数据」
      const dbPath = join(dir, 'workbench.db');
      let db = bootstrapDatabase({ dataDir: dir }).db;
      const genBefore = readDatabaseIdentity(db).contentGenerationId;
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '当前数据',
        't',
        't',
      );
      closeDatabase(db);

      // 备份源：身份 instanceB / genB + 业务数据「备份数据」
      const backupSrcDir = join(dir, 'backup-src');
      const backupDb = bootstrapDatabase({ dataDir: backupSrcDir });
      const identityB = readDatabaseIdentity(backupDb.db);
      backupDb.db
        .prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run('c2', '备份数据', 't', 't');
      const backupPath = await createManualBackup(backupDb.db, join(dir, 'backup'), {
        clock: new FixedClock('2026-08-07T10:00:00+08:00'),
      });
      closeDatabase(backupDb.db);

      // 恢复（main 恢复接线同款：onRestored → rotateContentGeneration）
      db = openDatabase({ path: dbPath });
      let onRestoredCalled = 0;
      const result = restoreFromBackup({
        backupPath,
        dbPath,
        snapshotDir: join(dir, 'restore-snapshots'),
        currentDb: db,
        closeConnection: () => closeDatabase(db),
        openConnection: () => {
          db = bootstrapDatabase({ dataDir: dir }).db;
        },
        onRestored: () => {
          onRestoredCalled += 1;
          // main 接线同款：恢复后重开的新连接（此处为闭包 db 变量）轮换 generation
          rotateContentGeneration(db);
        },
        clock: new FixedClock('2026-08-07T11:00:00+08:00'),
      });
      expect(result.restored).toBe(true);
      expect(onRestoredCalled).toBe(1);

      // 恢复后：数据为备份数据；generation 已轮换（≠ 备份原 generation，旧 seal 必失效）；
      // instance 保持备份库的（仅 generation 轮换、不新建 instance）
      const after = readDatabaseIdentity(db);
      expect(db.prepare('SELECT name FROM customers').get()).toMatchObject({ name: '备份数据' });
      expect(after.contentGenerationId).not.toBe(identityB.contentGenerationId);
      expect(after.contentGenerationId).not.toBe(genBefore);
      expect(after.databaseInstanceId).toBe(identityB.databaseInstanceId);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('失败恢复（备份损坏）保持原 generation，onRestored 不被调用', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'workbench.db');
      let db = bootstrapDatabase({ dataDir: dir }).db;
      const before = readDatabaseIdentity(db);
      closeDatabase(db);

      const corrupt = join(dir, 'corrupt-backup.db');
      writeFileSync(corrupt, 'not a sqlite database at all');

      db = openDatabase({ path: dbPath });
      let onRestoredCalled = 0;
      expect(() =>
        restoreFromBackup({
          backupPath: corrupt,
          dbPath,
          snapshotDir: join(dir, 'restore-snapshots'),
          currentDb: db,
          closeConnection: () => closeDatabase(db),
          openConnection: () => {
            db = bootstrapDatabase({ dataDir: dir }).db;
          },
          onRestored: () => {
            onRestoredCalled += 1;
          },
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        }),
      ).toThrow(RestoreError);
      expect(onRestoredCalled).toBe(0);

      // 原库 generation/instance 均未变化（失败恢复保持原 generation）
      const after = readDatabaseIdentity(db);
      expect(after.contentGenerationId).toBe(before.contentGenerationId);
      expect(after.databaseInstanceId).toBe(before.databaseInstanceId);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('失败恢复（替换 rename 失败、回滚原库）保持原 generation', async () => {
    const dir = makeTempDir();
    try {
      const { dbPath, backupPath } = await setupDbAndBackup(dir);
      const snapshotDir = join(dir, 'restore-snapshots');
      let db = openDatabase({ path: dbPath });
      const before = readDatabaseIdentity(db);
      const holder = new MutableConnectionHolder(db, closeDatabase, () => openDatabase({ path: dbPath }));

      // 注入：主替换 rename 失败（回滚 rename 不受影响）
      const failingFs = makeRestoreFs({
        renameSync: (from, to) => {
          if (from.includes('.restore-') && !from.includes('rollback')) {
            throw new Error('模拟替换 rename 失败');
          }
          nodeFsLike.renameSync(from, to);
        },
      });

      let err: RestoreError | null = null;
      try {
        restoreFromBackup({
          backupPath,
          dbPath,
          snapshotDir,
          holder,
          fs: failingFs,
          onRestored: () => {
            throw new Error('失败恢复不应轮换 generation');
          },
          clock: new FixedClock('2026-08-07T11:00:00+08:00'),
        });
      } catch (e) {
        err = e as RestoreError;
      }
      expect(err).toBeInstanceOf(RestoreError);
      expect(err!.code).toBe('RESTORE_REPLACE_FAILED');
      expect(err!.failure.recoverable).toBe(true);

      // 回滚重开的原库：generation/instance 保持原值
      const after = readDatabaseIdentity(holder.current!);
      expect(after.contentGenerationId).toBe(before.contentGenerationId);
      expect(after.databaseInstanceId).toBe(before.databaseInstanceId);
      expect(holder.current!.prepare('SELECT name FROM customers').get()).toMatchObject({
        name: '旧数据',
      });
      closeDatabase(holder.current!);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
