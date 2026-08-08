import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  LocalAccountService,
  SecondAccountForbiddenError,
  deriveSecret,
  generateRecoveryCode,
  normalizeRecoveryCode,
  verifySecret,
  SCRYPT_DEFAULTS,
  type Account,
  type AccountRepository,
} from '../../src/domain/capabilities/workbench-access';
import { FixedClock } from '../../src/domain/core/time';
import { ValidationError, createFactMeta, validateFactMeta } from '../../src/domain/core/source';

/**
 * workbench-access 能力领域测试（tasks 2.8 实现 + 2.10 场景验证）。
 * 覆盖 workbench-access spec 全部 ADDED Requirements 场景。
 */

const T0 = '2026-08-07T09:00:00+08:00';
const USERNAME = '负责人甲';
const PASSWORD = '初始密码-1';
const NEW_PASSWORD = '重置后密码-2';

class InMemoryAccountRepository implements AccountRepository {
  private readonly rows = new Map<string, Account>();

  findFirst(): Account | undefined {
    return this.rows.values().next().value;
  }

  findByUsername(username: string): Account | undefined {
    for (const account of this.rows.values()) {
      if (account.username === username) return account;
    }
    return undefined;
  }

  save(account: Account): void {
    if (this.rows.has(account.id)) throw new Error('duplicate account id');
    this.rows.set(account.id, account);
  }

  update(account: Account): void {
    this.rows.set(account.id, account);
  }

  count(): number {
    return this.rows.size;
  }

  all(): Account[] {
    return [...this.rows.values()];
  }
}

function makeService(repo = new InMemoryAccountRepository()) {
  return { repo, service: new LocalAccountService(repo, new FixedClock(T0)) };
}

describe('首次启动初始化单一本地账号（tasks 2.8 / spec）', () => {
  it('首次启动必须创建账号：无账号时状态为未初始化，创建后为已初始化', async () => {
    const { repo, service } = makeService();
    expect(service.getStatus()).toEqual({ initialized: false });

    const result = await service.initialize({ username: USERNAME, password: PASSWORD });

    expect(service.getStatus()).toEqual({ initialized: true });
    expect(result.account.username).toBe(USERNAME);
    expect(repo.count()).toBe(1);
    expect(result.recoveryCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('用户名与密码去除首尾空白后必填', async () => {
    const { service } = makeService();
    await expect(
      service.initialize({ username: '  ', password: PASSWORD }),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.initialize({ username: USERNAME, password: '' }),
    ).rejects.toThrow(ValidationError);
    const ok = await service.initialize({ username: `  ${USERNAME}  `, password: PASSWORD });
    expect(ok.account.username).toBe(USERNAME);
  });

  it('初始化后禁止新增第二个账号：第二次初始化被拒绝且不产生第二行', async () => {
    const { repo, service } = makeService();
    await service.initialize({ username: USERNAME, password: PASSWORD });

    await expect(
      service.initialize({ username: '第二账号', password: '别的密码' }),
    ).rejects.toThrow(SecondAccountForbiddenError);
    await expect(
      service.initialize({ username: USERNAME, password: PASSWORD }),
    ).rejects.toThrow(SecondAccountForbiddenError);
    expect(repo.count()).toBe(1);
  });

  it('不提供注册/自助新增用户/角色与权限管理 API', () => {
    const { service } = makeService();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort();
    expect(methods).toEqual(['constructor', 'getStatus', 'initialize', 'login', 'resetPassword']);
  });
});

describe('后续启动需登录本地账号（tasks 2.8 / spec）', () => {
  it('登录成功：返回访问会话（账号内部 ID + 登录时用户名快照）', async () => {
    const { service } = makeService();
    const { account } = await service.initialize({ username: USERNAME, password: PASSWORD });

    const { session } = await service.login({ username: USERNAME, password: PASSWORD });

    expect(session.accountId).toBe(account.id);
    expect(session.username).toBe(USERNAME);
    expect(session.loggedInAt).toBe(T0);
  });

  it('登录失败：错误密码与错误用户名统一拒绝、不泄露有效性信息', async () => {
    const { service } = makeService();
    await service.initialize({ username: USERNAME, password: PASSWORD });

    await expect(service.login({ username: USERNAME, password: '错误密码' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(service.login({ username: '不存在', password: PASSWORD })).rejects.toThrow(
      AccessDeniedError,
    );
    const err = await service.login({ username: USERNAME, password: '错误密码' }).catch((e) => e);
    const err2 = await service.login({ username: '不存在', password: PASSWORD }).catch((e) => e);
    // 统一错误语义（单一账号下用户名枚举不构成威胁，但不泄露密码有效性）
    expect((err as Error).message).toBe((err2 as Error).message);
    expect((err as Error).message).toBe('用户名或密码错误');
  });

  it('未初始化时登录被拒绝（未完成创建前不进入工作台）', async () => {
    const { service } = makeService();
    await expect(service.login({ username: USERNAME, password: PASSWORD })).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('无远程认证、外部身份源与账号同步：服务不暴露任何同步/导入账号能力', async () => {
    const service = new LocalAccountService(new InMemoryAccountRepository());
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of ['sync', 'importAccount', 'federate', 'registerRemote']) {
      expect(name in proto).toBe(false);
    }
  });
});

describe('密码与恢复码安全存储（tasks 2.8 / spec）', () => {
  it('密码与恢复码不以明文存储：落库为 scrypt 派生值 + 独立随机盐', async () => {
    const { repo, service } = makeService();
    const { recoveryCode } = await service.initialize({ username: USERNAME, password: PASSWORD });
    const stored = repo.findFirst()!;

    expect(stored.passwordHash).not.toContain(PASSWORD);
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.passwordHash).toHaveLength(SCRYPT_DEFAULTS.keyLength * 2);
    expect(stored.passwordSalt).toHaveLength(32);
    expect(stored.recoveryCodeHash).not.toContain(recoveryCode);
    expect(stored.recoveryCodeHash).toHaveLength(SCRYPT_DEFAULTS.keyLength * 2);
    expect(stored.recoveryCodeSalt).toHaveLength(32);
    expect(stored.passwordHash).not.toBe(stored.recoveryCodeHash);
  });

  it('每条记录独立随机盐：同一口令两次派生得到不同值', async () => {
    const a = await deriveSecret(PASSWORD);
    const b = await deriveSecret(PASSWORD);
    expect(a.saltHex).not.toBe(b.saltHex);
    expect(a.hashHex).not.toBe(b.hashHex);
  });

  it('校验使用恒定时间比较：正确口令通过、错误口令恒定返回 false', async () => {
    const { hashHex, saltHex } = await deriveSecret(PASSWORD);
    expect(await verifySecret(PASSWORD, hashHex, saltHex)).toBe(true);
    expect(await verifySecret('错误口令', hashHex, saltHex)).toBe(false);
    expect(await verifySecret('', hashHex, saltHex)).toBe(false);
  });

  it('恢复码归一化：忽略分隔符与大小写', () => {
    const code = generateRecoveryCode();
    const normalized = normalizeRecoveryCode(code);
    expect(normalized).toHaveLength(16);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ''))).toBe(normalized);
    expect(normalizeRecoveryCode('ab12-cd34-ef56-7890')).toBe('AB12CD34EF567890');
  });
});

describe('一次性恢复码重置密码（tasks 2.8 / spec）', () => {
  it('恢复码仅展示一次：初始化返回明文一次，此后无任何途径再次读取明文', async () => {
    const { repo, service } = makeService();
    const { recoveryCode } = await service.initialize({ username: USERNAME, password: PASSWORD });
    expect(recoveryCode).toBeTruthy();

    // 仓库只保存恢复码的 scrypt 派生值，明文无从再次展示
    const stored = repo.findFirst()!;
    expect(stored.recoveryCodeHash).not.toBe(recoveryCode);
    const serviceProto = Object.getPrototypeOf(service) as Record<string, unknown>;
    expect('getRecoveryCode' in serviceProto).toBe(false);
  });

  it('凭恢复码重置密码：旧密码失效、新密码可用，原恢复码失效并生成新恢复码', async () => {
    const { service } = makeService();
    const { recoveryCode } = await service.initialize({ username: USERNAME, password: PASSWORD });

    const reset = await service.resetPassword({ recoveryCode, newPassword: NEW_PASSWORD });

    expect(reset.newRecoveryCode).toBeTruthy();
    expect(reset.newRecoveryCode).not.toBe(recoveryCode);
    // 新密码可登录
    await expect(
      service.login({ username: USERNAME, password: NEW_PASSWORD }),
    ).resolves.toMatchObject({ session: { username: USERNAME } });
    // 旧密码失效
    await expect(service.login({ username: USERNAME, password: PASSWORD })).rejects.toThrow(
      AccessDeniedError,
    );
    // 原恢复码失效
    await expect(
      service.resetPassword({ recoveryCode, newPassword: '再一次' }),
    ).rejects.toThrow(AccessDeniedError);
    // 新恢复码可再次重置
    await expect(
      service.resetPassword({ recoveryCode: reset.newRecoveryCode, newPassword: '再再一次' }),
    ).resolves.toBeTruthy();
  });

  it('恢复码校验失败拒绝重置：密码保持不变，不泄露有效性信息', async () => {
    const { service } = makeService();
    await service.initialize({ username: USERNAME, password: PASSWORD });

    await expect(
      service.resetPassword({ recoveryCode: '0000-0000-0000-0000', newPassword: NEW_PASSWORD }),
    ).rejects.toThrow(AccessDeniedError);
    // 原密码仍可登录（本次重置未生效）
    await expect(
      service.login({ username: USERNAME, password: PASSWORD }),
    ).resolves.toBeTruthy();
  });
});

describe('手工录入事实归属当前登录账号（tasks 2.8 / spec，联动 1.5）', () => {
  it('负责人录入外部事实归属当前登录账号：会话快照作为动作记录归属', async () => {
    const { service } = makeService();
    await service.initialize({ username: USERNAME, password: PASSWORD });
    const { session } = await service.login({ username: USERNAME, password: PASSWORD });

    const meta = createFactMeta({
      source: 'manual',
      actor: { accountId: session.accountId, username: session.username },
    });
    expect(meta.actor).toEqual({ accountId: session.accountId, username: USERNAME });
  });

  it('历史统计不因用户名修改变化：动作记录持久化当时用户名快照', async () => {
    const { repo, service } = makeService();
    const { account } = await service.initialize({ username: '老用户名', password: PASSWORD });
    const { session } = await service.login({ username: '老用户名', password: PASSWORD });

    // 录入事实：归属会话快照（内部 ID + 当时用户名）
    const factActor = { accountId: session.accountId, username: session.username };
    const fact = createFactMeta({ source: 'manual', actor: factActor });

    // 用户名修改（仓库层直接改名，模拟后续改名能力）
    repo.update({ ...account, username: '新用户名', updatedAt: T0 });

    // 历史统计仍按动作记录中的用户名快照归属，不动态变化
    expect(fact.actor!.username).toBe('老用户名');
    expect(fact.actor!.accountId).toBe(account.id);
    expect(fact.actor!.username).not.toBe('新用户名');
  });

  it('迁移数据不计手工录入：迁移导入事实不归属本地账号', () => {
    const importMeta = createFactMeta({ source: 'import', businessAt: T0 });
    expect(importMeta.actor).toBeNull();
    expect(() =>
      validateFactMeta({
        source: 'import',
        businessAt: T0,
        auditAt: T0,
        actor: { accountId: 'acc', username: '负责人甲' },
      }),
    ).toThrow(ValidationError);
  });

  it('系统自动记录的事实不归属账号', () => {
    const systemMeta = createFactMeta({ source: 'system' });
    expect(systemMeta.actor).toBeNull();
  });
});
