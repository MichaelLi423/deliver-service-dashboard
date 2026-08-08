import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  AUTO_BACKUP_PREFIX,
  createAutoBackupIfNeeded,
  createManualBackup,
  listAutoBackupFiles,
} from '../../src/domain/capabilities/local-data-persistence/backup';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

describe('每日自动备份与手动备份（tasks 1.11/1.12 / D18）', () => {
  it('当日首次使用创建自动备份（按本地日期命名）', async () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const autoDir = join(dir, 'backups', 'auto');
      const clock = new FixedClock('2026-08-07T09:30:00+08:00');
      const result = await createAutoBackupIfNeeded(db, autoDir, { clock });
      expect(result.created).toBe(true);
      expect(result.path).toBe(join(autoDir, 'auto-2026-08-07.db'));
      expect(existsSync(result.path!)).toBe(true);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('当日已有自动备份不重复创建', async () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const autoDir = join(dir, 'backups', 'auto');
      const clock = new FixedClock('2026-08-07T09:30:00+08:00');
      await createAutoBackupIfNeeded(db, autoDir, { clock });
      const again = await createAutoBackupIfNeeded(db, autoDir, { clock });
      expect(again.created).toBe(false);
      expect(listAutoBackupFiles(autoDir)).toHaveLength(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('自动备份轮转：创建第 8 份时清理最早 1 份、保留最近 7 份', async () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const autoDir = join(dir, 'backups', 'auto');
      mkdirSync(autoDir, { recursive: true });
      // 预置 7 份较早日期自动备份
      for (let d = 1; d <= 7; d++) {
        const day = String(d).padStart(2, '0');
        writeFileSync(join(autoDir, `${AUTO_BACKUP_PREFIX}2026-07-${day}.db`), 'x');
      }
      const clock = new FixedClock('2026-08-07T09:30:00+08:00');
      const result = await createAutoBackupIfNeeded(db, autoDir, { clock });
      expect(result.created).toBe(true);

      const remaining = listAutoBackupFiles(autoDir);
      expect(remaining).toHaveLength(7);
      expect(remaining).toContain('auto-2026-08-07.db');
      expect(remaining).not.toContain('auto-2026-07-01.db'); // 最早一份被清理
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('手动备份不受数量限制：自动轮转不清除手动备份', async () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const autoDir = join(dir, 'backups', 'auto');
      const manualDir = join(dir, 'backups', 'manual');
      const clock = new FixedClock('2026-08-07T09:30:00+08:00');

      const manualPath = await createManualBackup(db, manualDir, { clock });
      expect(manualPath.endsWith('.db')).toBe(true);
      expect(manualPath).toContain('manual-');

      // 触发自动备份轮转（预置 8 份自动 + 新建 1 份 → 清理最早）
      mkdirSync(autoDir, { recursive: true });
      for (let d = 1; d <= 8; d++) {
        const day = String(d).padStart(2, '0');
        writeFileSync(join(autoDir, `${AUTO_BACKUP_PREFIX}2026-06-${day}.db`), 'x');
      }
      await createAutoBackupIfNeeded(db, autoDir, { clock });

      // 手动备份保留
      expect(existsSync(manualPath)).toBe(true);
      const manualFiles = readdirSync(manualDir).filter((f) => f.startsWith('manual-'));
      expect(manualFiles).toHaveLength(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('自动备份文件可读（在线 backup 生成有效副本）', async () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '备份验证客户',
        't',
        't',
      );
      const autoDir = join(dir, 'backups', 'auto');
      const clock = new FixedClock('2026-08-07T09:30:00+08:00');
      const result = await createAutoBackupIfNeeded(db, autoDir, { clock });

      // 从备份文件只读读取验证
      const ro = new DatabaseSync(result.path!, { readOnly: true });
      const row = ro.prepare('SELECT name FROM customers').get() as { name: string };
      expect(row.name).toBe('备份验证客户');
      const integrity = ro.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe('ok');
      ro.close();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
