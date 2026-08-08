/**
 * 一次性恢复码（tasks 2.8 / design D12）。
 *
 * - 初始化/重置成功时生成，只向用户展示一次，由用户离线保存；
 * - 恢复码本身不以明文落库（存储其 scrypt 派生值，见 access-service.ts）；
 * - 校验前归一化用户输入（去分隔符、统一大写），便于用户手工抄写。
 */

import { randomBytes } from 'node:crypto';

/** 恢复码格式：16 位十六进制，4 位一组（如 "AB12-CD34-EF56-7890"）。 */
export function generateRecoveryCode(): string {
  const hex = randomBytes(8).toString('hex').toUpperCase();
  return hex.match(/.{1,4}/g)!.join('-');
}

/** 归一化用户输入：去除非十六进制字符并统一大写。 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}
