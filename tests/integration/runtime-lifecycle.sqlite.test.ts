import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository, SqliteCustomerRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  AUTO_BACKUP_PREFIX,
  createAutoBackupIfNeeded,
  createManualBackup,
  listAutoBackupFiles,
} from '../../src/domain/capabilities/local-data-persistence/backup';
import { restoreFromBackup } from '../../src/domain/capabilities/local-data-persistence/restore';
import {
  readDatabaseIdentity,
  rotateContentGeneration,
} from '../../src/domain/capabilities/local-data-persistence/identity';
import {
  AccessDeniedError,
  LocalAccountService,
} from '../../src/domain/capabilities/workbench-access';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 运行与持久化应用级演练（tasks 10.5，main facade 集成级）。
 *
 * 按 Electron 主进程真实启动/运行序列（src/main/index.ts 同款函数）演练：
 *   启动(bootstrap + 每日自动备份) → 初始化本地账号 → 录入业务数据 →
 *   关闭并重开 → 登录 → 数据保留 → 手动备份 → 从备份恢复 → 恢复码重置密码。
 *
 * 边界（诚实声明）：本组为 macOS 开发机上的 main facade 集成证据；Windows 安装包、
 * Windows 操作系统账户保护（数据文件与备份的主要保护边界）未在 Windows 上验证，
 * 因此 tasks.md 10.5 保持 [ ]。
 */

const T0 = '2026-08-07T09:00:00+08:00';

interface AppState {
  db: import('node:sqlite').DatabaseSync;
  dbPath: string;
  service: LocalAccountService;
}

function openApp(dataDir: string, clock: FixedClock): AppState {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  return { db, dbPath, service: new LocalAccountService(new SqliteAccountRepository(db), clock) };
}

describe('运行与持久化应用级演练（tasks 10.5，main facade 集成）', () => {
  it('启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置', async () => {
    const dir = makeTempDir('runtime-lifecycle-');
    try {
      const autoBackupDir = join(dir, 'userData', 'backups', 'auto');
      const manualBackupDir = join(dir, 'backups', 'manual');
      const clock = new FixedClock(T0);

      // ① 首次启动：bootstrap + 每日首次使用自动备份（主进程 ready 时同款调用）
      let app = openApp(dir, clock);
      const firstBackup = await createAutoBackupIfNeeded(app.db, autoBackupDir, { clock });
      expect(firstBackup.created).toBe(true);
      expect(existsSync(firstBackup.path!)).toBe(true);

      // ② 首次启动初始化本地账号（用户名 + 密码 → 一次性恢复码）
      const { account, recoveryCode } = await app.service.initialize({ username: '负责人', password: 'password-1' });
      expect(account.username).toBe('负责人');
      expect(recoveryCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);

      // ③ 录入业务数据（真实 SQLite 落库）
      new CustomerService(new SqliteCustomerRepository(app.db)).register('重开保留客户');

      // ④ 关闭并重开应用：账号仍在、需登录、业务数据保留
      closeDatabase(app.db);
      app = openApp(dir, clock);
      expect(app.service.getStatus()).toEqual({ initialized: true });
      await expect(app.service.login({ username: '负责人', password: '错误密码' })).rejects.toThrow(AccessDeniedError);
      const { session } = await app.service.login({ username: '负责人', password: 'password-1' });
      expect(session.username).toBe('负责人');
      const row = app.db.prepare('SELECT name FROM customers').get() as { name: string };
      expect(row.name).toBe('重开保留客户');

      // ⑤ 同日重开不再重复创建自动备份（当日已有备份）
      const again = await createAutoBackupIfNeeded(app.db, autoBackupDir, { clock });
      expect(again.created).toBe(false);
      expect(listAutoBackupFiles(autoBackupDir)).toHaveLength(1);

      // ⑥ 手动备份到所选目录（不受自动轮转数量限制）
      const manualPath = await createManualBackup(app.db, manualBackupDir, { clock });
      expect(existsSync(manualPath)).toBe(true);

      // ⑦ 从备份恢复：先改当前库再恢复，恢复后与备份一致、完整性校验通过；
      //    成功恢复后轮换 content_generation_id（main 恢复接线同款），旧 seal 必失效
      const genBeforeRestore = readDatabaseIdentity(app.db).contentGenerationId;
      app.db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'after-backup',
        '恢复前新增（将被覆盖）',
        't',
        't',
      );
      const restoreResult = restoreFromBackup({
        backupPath: manualPath,
        dbPath: app.dbPath,
        snapshotDir: join(dir, 'restore-snapshots'),
        currentDb: app.db,
        closeConnection: () => closeDatabase(app.db),
        openConnection: () => {
          app.db = bootstrapDatabase({ dataDir: dir }).db;
        },
        onRestored: () => {
          rotateContentGeneration(app.db);
        },
        clock: new FixedClock('2026-08-07T11:00:00+08:00'),
      });
      expect(restoreResult.restored).toBe(true);
      expect(restoreResult.integrityVerified).toBe(true);
      const afterRestore = app.db.prepare('SELECT name FROM customers').all() as Array<{ name: string }>;
      expect(afterRestore.some((r) => r.name === '重开保留客户')).toBe(true);
      expect(afterRestore.some((r) => r.name === '恢复前新增（将被覆盖）')).toBe(false);
      // 恢复后 generation 已轮换（与恢复前不同），旧 seal 必失效
      expect(readDatabaseIdentity(app.db).contentGenerationId).not.toBe(genBeforeRestore);

      // ⑧ 忘记密码：凭一次性恢复码重置 → 新密码登录、旧密码失效
      // （恢复后数据库已重开，重建服务引用以绑定新连接）
      app.service = new LocalAccountService(new SqliteAccountRepository(app.db), clock);
      const reset = await app.service.resetPassword({ recoveryCode, newPassword: 'password-2' });
      await expect(app.service.login({ username: '负责人', password: 'password-1' })).rejects.toThrow(AccessDeniedError);
      const { session: session2 } = await app.service.login({ username: '负责人', password: 'password-2' });
      expect(session2.accountId).toBe(account.id);
      // 原恢复码失效、新恢复码可用
      await expect(app.service.resetPassword({ recoveryCode, newPassword: '无效' })).rejects.toThrow(AccessDeniedError);
      await expect(app.service.resetPassword({ recoveryCode: reset.newRecoveryCode, newPassword: '再重置' })).resolves.toBeTruthy();

      closeDatabase(app.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('每日自动备份轮转保留最近 7 份，手动备份不被轮转清理', async () => {
    const dir = makeTempDir('runtime-rotate-');
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const autoDir = join(dir, 'backups', 'auto');
      mkdirSync(autoDir, { recursive: true });
      // 预置 7 份较早自动备份 + 触发第 8 份 → 清理最早 1 份
      for (let d = 1; d <= 7; d++) {
        const day = String(d).padStart(2, '0');
        writeFileSync(join(autoDir, `${AUTO_BACKUP_PREFIX}2026-07-${day}.db`), 'x');
      }
      const clock = new FixedClock('2026-08-07T09:30:00+08:00');
      const manualPath = await createManualBackup(db, join(dir, 'backups', 'manual'), { clock });
      const result = await createAutoBackupIfNeeded(db, autoDir, { clock });
      expect(result.created).toBe(true);
      const remaining = listAutoBackupFiles(autoDir);
      expect(remaining).toHaveLength(7);
      expect(remaining).not.toContain('auto-2026-07-01.db');
      expect(existsSync(manualPath)).toBe(true); // 手动备份不受轮转影响
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
