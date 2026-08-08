/**
 * 口令派生与校验（tasks 2.8 / design D12）。
 *
 * - 使用 Node 内置 crypto.scrypt（异步）+ 每条记录独立随机盐；
 * - 校验使用 timingSafeEqual 恒定时间比较；
 * - 不引入任何原生密码依赖（node:crypto 为 Node 内置模块）。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { SCRYPT_DEFAULTS } from './account';

function scryptDerive(
  secret: string,
  salt: Buffer,
  keyLength: number,
  options: { maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, keyLength, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export interface DerivedSecret {
  /** scrypt 派生值（十六进制，keyLength 字节）。 */
  hashHex: string;
  /** 独立随机盐（十六进制，16 字节）；不传时自动生成。 */
  saltHex: string;
}

/** 用 Node 内置 scrypt + 独立随机盐派生口令。 */
export async function deriveSecret(secret: string, saltHex?: string): Promise<DerivedSecret> {
  const salt = saltHex === undefined ? randomBytes(16) : Buffer.from(saltHex, 'hex');
  const key = await scryptDerive(secret, salt, SCRYPT_DEFAULTS.keyLength, {
    maxmem: SCRYPT_DEFAULTS.maxmem,
  });
  return { hashHex: key.toString('hex'), saltHex: salt.toString('hex') };
}

/**
 * 恒定时间校验：候选口令以存储盐重新派生后，与存储派生值 timingSafeEqual 比较。
 * 派生值长度不一致（存储损坏等）直接返回 false，不做比较。
 */
export async function verifySecret(
  secret: string,
  hashHex: string,
  saltHex: string,
): Promise<boolean> {
  const { hashHex: candidateHex } = await deriveSecret(secret, saltHex);
  const candidate = Buffer.from(candidateHex, 'hex');
  const stored = Buffer.from(hashHex, 'hex');
  if (candidate.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(candidate, stored);
}
