import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { createAutoBackupIfNeeded } from '../../src/domain/capabilities/local-data-persistence/backup';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

const SRC_DIR = join(__dirname, '..', '..', 'src');

/** 递归收集 src 下全部 .ts/.tsx 源码路径。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('运行边界（local-data-persistence spec）', () => {
  it('本地账号表存在但 SQLite 不加密：数据库文件为普通 SQLite、账号数据本地可读', () => {
    const dir = makeTempDir();
    try {
      const { db, dbPath } = bootstrapDatabase({ dataDir: dir });
      const repo = new SqliteAccountRepository(db);
      repo.save({
        id: 'acc-1',
        username: '负责人甲',
        passwordHash: 'deadbeef',
        passwordSalt: 'salt',
        recoveryCodeHash: null,
        recoveryCodeSalt: null,
        createdAt: '2026-08-07T00:00:00+08:00',
        updatedAt: '2026-08-07T00:00:00+08:00',
      });
      closeDatabase(db);

      // 文件头为 SQLite 魔数（未加密；本测试只验证数据本地可读，不误称安全）
      const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
      expect(header.startsWith('SQLite format 3')).toBe(true);

      // 直接以标准 SQLite 读取账号数据（证明账号仅为访问门槛，不构成数据文件保护）
      const ro = new DatabaseSync(dbPath, { readOnly: true });
      const row = ro.prepare('SELECT username FROM accounts WHERE id = ?').get('acc-1') as {
        username: string;
      };
      expect(row.username).toBe('负责人甲');
      ro.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('离线无远程依赖：领域与持久化源码不导入任何网络模块', () => {
    // 只匹配 import 语句，避免注释/字符串误报
    const bannedPatterns = [
      /from\s+['"]node:(http|https|net|tls|dns|http2|dgram)['"]/,
      /from\s+['"](ws|axios|node-fetch|undici)['"]/,
      /require\s*\(\s*['"]node:(http|https|net|tls|dns|http2|dgram)['"]\s*\)/,
    ];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of bannedPatterns) {
        expect(content, `${file} 不应导入网络模块（匹配 ${pattern}）`).not.toMatch(pattern);
      }
    }
  });

  it('离线可用：无任何远程服务时本机 SQLite 全流程（写入→备份→关闭→重开）正常', async () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'offline',
        '离线客户',
        't',
        't',
      );
      // 离线备份（不依赖网络）
      const autoDir = join(dir, 'backups', 'auto');
      const result = await createAutoBackupIfNeeded(db, autoDir, {
        clock: new FixedClock('2026-08-07T09:00:00+08:00'),
      });
      expect(result.created).toBe(true);
      closeDatabase(db);

      // 关闭重开后数据保留
      const reopened = bootstrapDatabase({ dataDir: dir });
      const row = reopened.db.prepare('SELECT * FROM customers').get() as { id: string };
      expect(row.id).toBe('offline');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
