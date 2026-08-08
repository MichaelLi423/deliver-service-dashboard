/**
 * 单一本地账号访问门槛服务（tasks 2.8 / design D12）。
 *
 * - 首次启动初始化：创建用户名与密码，生成一次性恢复码（仅返回一次）；
 *   创建后禁止新增第二个账号，不提供注册/自助新增用户/角色与权限管理。
 * - 后续启动登录：用户名 + 密码校验通过返回访问会话（账号内部 ID +
 *   登录时用户名快照）；无远程认证、外部身份源与账号同步。
 * - 忘记密码：凭一次性恢复码校验通过后重置密码；使用后原恢复码失效并生成
 *   新的恢复码（再次仅展示一次）。
 * - 安全语义：密码/恢复码比较恒定时间；登录与恢复码校验失败返回统一错误，
 *   不泄露密码或恢复码有效性的可观测信息（单一账号下用户名枚举不构成威胁）。
 * - 会话仅存于调用方（主进程内存），本服务为无状态领域服务。
 */

import { DomainError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import { SystemClock, type Clock } from '../../core/time';
import type { AccessSession, Account, AccountRepository } from './account';
import { deriveSecret, verifySecret } from './password';
import { generateRecoveryCode, normalizeRecoveryCode } from './recovery-code';

/** 初始化后尝试新增第二个账号。 */
export class SecondAccountForbiddenError extends DomainError {
  constructor() {
    super('SECOND_ACCOUNT_FORBIDDEN', '本地账号已初始化，禁止新增第二个账号');
    this.name = 'SecondAccountForbiddenError';
  }
}

/** 登录或恢复码校验失败（统一错误语义，不泄露有效性信息）。 */
export class AccessDeniedError extends DomainError {
  constructor(message: string) {
    super('ACCESS_DENIED', message);
    this.name = 'AccessDeniedError';
  }
}

export interface InitializeInput {
  username: string;
  password: string;
}

export interface InitializeResult {
  account: Account;
  /** 一次性恢复码（明文），仅本次展示一次，由用户离线保存。 */
  recoveryCode: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface LoginResult {
  session: AccessSession;
}

export interface ResetPasswordInput {
  recoveryCode: string;
  newPassword: string;
}

export interface ResetPasswordResult {
  account: Account;
  /** 新的恢复码（明文），原恢复码已失效，本码仅展示一次。 */
  newRecoveryCode: string;
}

const LOGIN_DENIED_MESSAGE = '用户名或密码错误';
const RECOVERY_DENIED_MESSAGE = '恢复码错误或已失效';

// 账号不存在或无恢复码时的占位校验：执行一次真实 scrypt + 恒定时间比较，
// 使"账号存在与否/恢复码是否存在"不产生可观测的时序差异。
let dummySaltHex = '';
let dummyHashHex = '';
let dummyReady: Promise<void> | null = null;

function ensureDummy(): Promise<void> {
  dummyReady ??= deriveSecret('__dummy__').then((d) => {
    dummySaltHex = d.saltHex;
    dummyHashHex = d.hashHex;
  });
  return dummyReady;
}

async function verifyAgainstDummy(secret: string): Promise<boolean> {
  await ensureDummy();
  return verifySecret(secret, dummyHashHex, dummySaltHex);
}

export class LocalAccountService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /** 账号初始化状态：本地账号是否存在（决定首次初始化界面或登录界面）。 */
  getStatus(): { initialized: boolean } {
    return { initialized: this.repo.findFirst() !== undefined };
  }

  /**
   * 首次启动初始化单一本地账号。
   * 已完成初始化时拒绝新增第二个账号。
   */
  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const username = assertRequiredText(input.username, '用户名');
    const password = assertRequiredText(input.password, '密码');
    if (this.repo.findFirst() !== undefined) {
      throw new SecondAccountForbiddenError();
    }
    const now = this.clock.nowIso();
    const passwordSecret = await deriveSecret(password);
    const recoveryCode = generateRecoveryCode();
    // 恢复码以归一化形式（无分隔符、大写）派生存储；校验时同样先归一化。
    const recoverySecret = await deriveSecret(normalizeRecoveryCode(recoveryCode));
    const account: Account = {
      id: newInternalId(),
      username,
      passwordHash: passwordSecret.hashHex,
      passwordSalt: passwordSecret.saltHex,
      recoveryCodeHash: recoverySecret.hashHex,
      recoveryCodeSalt: recoverySecret.saltHex,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.save(account);
    return { account, recoveryCode };
  }

  /** 后续启动登录：校验通过返回访问会话；失败统一拒绝、不泄露有效性。 */
  async login(input: LoginInput): Promise<LoginResult> {
    const username = assertRequiredText(input.username, '用户名');
    const password = assertRequiredText(input.password, '密码');
    const account = this.repo.findByUsername(username);
    if (account === undefined) {
      await verifyAgainstDummy(password);
      throw new AccessDeniedError(LOGIN_DENIED_MESSAGE);
    }
    const ok = await verifySecret(password, account.passwordHash, account.passwordSalt);
    if (!ok) {
      throw new AccessDeniedError(LOGIN_DENIED_MESSAGE);
    }
    return {
      session: {
        accountId: account.id,
        username: account.username,
        loggedInAt: this.clock.nowIso(),
      },
    };
  }

  /**
   * 忘记密码：凭一次性恢复码重置密码。
   * 校验通过后：重置密码、原恢复码失效并生成新恢复码（仅展示一次）；
   * 校验失败统一拒绝，不泄露恢复码有效性。
   */
  async resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
    const normalizedCode = normalizeRecoveryCode(
      assertRequiredText(input.recoveryCode, '恢复码'),
    );
    const newPassword = assertRequiredText(input.newPassword, '新密码');
    const account = this.repo.findFirst();
    if (
      account === undefined ||
      account.recoveryCodeHash === null ||
      account.recoveryCodeSalt === null
    ) {
      await verifyAgainstDummy(normalizedCode);
      throw new AccessDeniedError(RECOVERY_DENIED_MESSAGE);
    }
    const ok = await verifySecret(normalizedCode, account.recoveryCodeHash, account.recoveryCodeSalt);
    if (!ok) {
      throw new AccessDeniedError(RECOVERY_DENIED_MESSAGE);
    }
    const now = this.clock.nowIso();
    const passwordSecret = await deriveSecret(newPassword);
    const newRecoveryCode = generateRecoveryCode();
    const recoverySecret = await deriveSecret(normalizeRecoveryCode(newRecoveryCode));
    const updated: Account = {
      ...account,
      passwordHash: passwordSecret.hashHex,
      passwordSalt: passwordSecret.saltHex,
      recoveryCodeHash: recoverySecret.hashHex,
      recoveryCodeSalt: recoverySecret.saltHex,
      updatedAt: now,
    };
    this.repo.update(updated);
    return { account: updated, newRecoveryCode };
  }
}
