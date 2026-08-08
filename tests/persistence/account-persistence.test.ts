import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  AccessDeniedError,
  LocalAccountService,
  SecondAccountForbiddenError,
} from '../../src/domain/capabilities/workbench-access';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * workbench-access 持久化集成（tasks 2.8/2.10）。
 * 真实 SQLite：初始化→关闭重开→登录、账号不加密 SQLite、无明文落库、
 * 数据库层单一账号约束。
 */

const T0 = '2026-08-07T09:00:00+08:00';
const USERNAME = '负责人甲';
const PASSWORD = '集成密码-1';
const NEW_PASSWORD = '集成密码-2';

function openService(dir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir: dir });
  return {
    db,
    dbPath,
    repo: new SqliteAccountRepository(db),
    service: new LocalAccountService(new SqliteAccountRepository(db), new FixedClock(T0)),
  };
}

describe('账号持久化集成（tasks 2.8/2.10 / local-data-persistence 联动）', () => {
  it('关闭重开后数据保留：仍需登录本地账号才能获得会话', async () => {
    const dir = makeTempDir();
    try {
      let state = openService(dir);
      await state.service.initialize({ username: USERNAME, password: PASSWORD });
      expect(state.service.getStatus()).toEqual({ initialized: true });
      closeDatabase(state.db);

      // 重新打开：账号仍在，未初始化状态消失
      state = openService(dir);
      expect(state.service.getStatus()).toEqual({ initialized: true });
      // 登录成功前无会话（需登录）
      await expect(state.service.login({ username: USERNAME, password: '错误' })).rejects.toThrow(
        AccessDeniedError,
      );
      const { session } = await state.service.login({ username: USERNAME, password: PASSWORD });
      expect(session.username).toBe(USERNAME);
      expect(session.accountId).toBeTruthy();
      closeDatabase(state.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('本地账号不加密 SQLite：数据库文件为普通 SQLite 且账号数据直接可读', async () => {
    const dir = makeTempDir();
    try {
      const { db, dbPath, service } = openService(dir);
      await service.initialize({ username: USERNAME, password: PASSWORD });
      closeDatabase(db);

      // 文件头为 SQLite 魔数（未因本地账号而加密）
      const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
      expect(header.startsWith('SQLite format 3')).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('密码与恢复码不以明文落库：数据库行只有 scrypt 派生值（十六进制）与盐', async () => {
    const dir = makeTempDir();
    try {
      const { db, service } = openService(dir);
      const { recoveryCode } = await service.initialize({ username: USERNAME, password: PASSWORD });

      const row = db
        .prepare(
          `SELECT password_hash, password_salt, recovery_code_hash, recovery_code_salt,
                  created_at, updated_at, singleton FROM accounts`,
        )
        .get() as Record<string, unknown>;

      expect(String(row.password_hash)).not.toContain(PASSWORD);
      expect(String(row.password_hash)).toMatch(/^[0-9a-f]{128}$/);
      expect(String(row.password_salt)).toMatch(/^[0-9a-f]{32}$/);
      expect(String(row.recovery_code_hash)).not.toContain(recoveryCode);
      expect(String(row.recovery_code_hash)).toMatch(/^[0-9a-f]{128}$/);
      expect(String(row.recovery_code_salt)).toMatch(/^[0-9a-f]{32}$/);
      // 单一账号数据库层守卫存在
      expect(Number(row.singleton)).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('数据库层禁止新增第二个账号（singleton 唯一约束）', async () => {
    const dir = makeTempDir();
    try {
      const { db, service } = openService(dir);
      await service.initialize({ username: USERNAME, password: PASSWORD });
      closeDatabase(db);

      // 绕过领域服务直接写入第二行：不同用户名同样被唯一约束拒绝
      const { db: db2 } = openService(dir);
      expect(() =>
        db2
          .prepare(
            `INSERT INTO accounts (
               id, username, password_hash, password_salt, recovery_code_hash,
               recovery_code_salt, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(
            'acc-second',
            '第二账号',
            'a'.repeat(128),
            'b'.repeat(32),
            null,
            null,
            T0,
            T0,
          ),
      ).toThrow();
      closeDatabase(db2);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('领域服务拒绝第二账号，即使数据库被直接绕过也由唯一约束兜底', async () => {
    const dir = makeTempDir();
    try {
      const { db, repo, service } = openService(dir);
      await service.initialize({ username: USERNAME, password: PASSWORD });
      await expect(
        service.initialize({ username: '第二账号', password: '别的密码' }),
      ).rejects.toThrow(SecondAccountForbiddenError);
      expect(repo.findFirst()?.username).toBe(USERNAME);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('持久化重置密码全流程：重开后新密码可登录、旧密码与原恢复码失效、新恢复码可用', async () => {
    const dir = makeTempDir();
    try {
      let state = openService(dir);
      const { recoveryCode } = await state.service.initialize({
        username: USERNAME,
        password: PASSWORD,
      });
      closeDatabase(state.db);

      // 重开后凭恢复码重置
      state = openService(dir);
      const reset = await state.service.resetPassword({
        recoveryCode,
        newPassword: NEW_PASSWORD,
      });
      expect(reset.account.username).toBe(USERNAME);
      closeDatabase(state.db);

      // 再次重开：新密码可登录、旧密码拒绝、原恢复码失效、新恢复码可用
      state = openService(dir);
      const { session } = await state.service.login({
        username: USERNAME,
        password: NEW_PASSWORD,
      });
      expect(session.accountId).toBe(reset.account.id);
      await expect(
        state.service.login({ username: USERNAME, password: PASSWORD }),
      ).rejects.toThrow(AccessDeniedError);
      await expect(
        state.service.resetPassword({ recoveryCode, newPassword: '无效' }),
      ).rejects.toThrow(AccessDeniedError);
      await expect(
        state.service.resetPassword({
          recoveryCode: reset.newRecoveryCode,
          newPassword: '再重置',
        }),
      ).resolves.toBeTruthy();
      closeDatabase(state.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号表不设角色/权限列（无角色与权限管理）', async () => {
    const dir = makeTempDir();
    try {
      const { db } = openService(dir);
      const columns = db
        .prepare(`PRAGMA table_info(accounts)`)
        .all() as { name: string }[];
      const names = columns.map((c) => c.name);
      for (const forbidden of ['role', 'roles', 'permissions', 'is_admin']) {
        expect(names).not.toContain(forbidden);
      }
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
