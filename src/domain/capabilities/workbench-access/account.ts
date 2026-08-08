/**
 * workbench-access 能力（单一本地应用账号访问门槛，tasks 2.8 / design D12）。
 *
 * 首版为个人使用，但提供单一本地应用账号作为应用访问门槛：首次启动初始化、
 * 后续登录、忘记密码恢复码重置；无多账号、注册、角色与权限管理，无远程认证、
 * 外部身份源与账号同步。
 *
 * - 密码与恢复码以 Node 内置 scrypt + 每条记录独立随机盐存储，校验使用
 *   timingSafeEqual 恒定时间比较，不引入原生密码依赖（实现见 password.ts）。
 * - 恢复码只展示一次、由用户离线保存，使用后失效并生成新的恢复码。
 * - 本地账号仅为访问门槛、不加密 SQLite；Windows 操作系统账户仍是本机数据
 *   文件与备份的主要保护边界。
 * - 手工录入事实归属当前已登录账号：动作记录持久化账号内部 ID 与当时用户名
 *   快照（见 AccessSession / src/domain/core/source.ts 的 ActorSnapshot），
 *   历史统计不因以后用户名修改而动态变化；迁移导入的数据不归属本地账号。
 */

import type { IsoDateTime } from '../../core/time';

/** 本地账号内部模型。 */
export interface Account {
  /** 稳定内部 ID（技术引用，D1）。 */
  id: string;
  /** 用户名（去除首尾空白后存储；历史事实按动作记录中的用户名快照归属）。 */
  username: string;
  /** 密码的 scrypt 派生值（十六进制）与独立随机盐。 */
  passwordHash: string;
  passwordSalt: string;
  /** 一次性恢复码的 scrypt 派生值与独立随机盐（仅展示一次，使用后失效）。 */
  recoveryCodeHash: string | null;
  recoveryCodeSalt: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** 登录成功后的访问会话：账号内部 ID + 登录时用户名快照。 */
export interface AccessSession {
  accountId: string;
  /** 登录时用户名快照；历史统计依据该快照，不因以后改名动态变化。 */
  username: string;
  loggedInAt: IsoDateTime;
}

/**
 * 账号仓储（SQLite 实现见 local-data-persistence/repositories.ts）。
 * 账号唯一性（单一本地账号）由领域服务与数据库约束共同落实。
 */
export interface AccountRepository {
  findFirst(): Account | undefined;
  findByUsername(username: string): Account | undefined;
  /** 仅用于首次初始化（插入）。 */
  save(account: Account): void;
  /** 更新（重置密码/生成新恢复码/改名等），不改变 id 与 created_at。 */
  update(account: Account): void;
}

/** scrypt 参数：keyLength 64 字节（与 timingSafeEqual 等长比较兼容）。 */
export const SCRYPT_DEFAULTS = {
  keyLength: 64,
  maxmem: 64 * 1024 * 1024,
} as const;
