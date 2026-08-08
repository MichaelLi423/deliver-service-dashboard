import { MoneyParseError } from './errors';

/** 金额解析错误类型随金额 API 一并导出（由本模块抛出的错误）。 */
export { MoneyParseError } from './errors';

/**
 * 金额值对象（design D7 / tasks 1.3）。
 *
 * - 物理表示：分整数（bigint），两位小数，十进制定点，全程不使用二进制浮点参与金额计算。
 * - 解析：十进制字符串 → 分，四舍五入（HALF_UP），仅允许非负值（0 允许，负数拒绝）。
 * - 值对象允许表达 0（仅合同 USD 含税金额允许为 0）与差异（sub 可产生负值，
 *   用于「成交价格 vs 实际物流费用」等差异展示）。
 * - 正数校验（有值必须 > 0）属于业务函数/录入校验，不属于 Money 本身。
 * - 折算：RMB → USD 固定汇率 1 USD = 7.2 RMB。
 * - 占比：numerator / denominator，返回百分比（以百分之一为单位的 bigint），
 *   分母为 0/空时返回 null 表示「不可计算」。
 */

export const RMB_TO_USD_RATE = '7.2';

const CENTS_PER_UNIT = 100n;

/** 分整数 → 字符串，保留两位小数，支持负值（差异展示）。 */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const units = abs / CENTS_PER_UNIT;
  const frac = abs % CENTS_PER_UNIT;
  const body = `${units}.${String(frac).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/**
 * 十进制字符串 → 分（HALF_UP 四舍五入到分）。
 * 支持形如 "1234"、"1234.5"、"1234.567"、"0"；拒绝负数、空串与非法格式。
 * 不使用浮点：整数部分与小数部分均以字符串/bigint 处理。
 */
export function parseDecimalToCents(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new MoneyParseError('金额不能为空');
  }
  if (trimmed.startsWith('-')) {
    throw new MoneyParseError('金额不得为负数');
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyParseError(`金额格式非法: ${input}`);
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const intCents = BigInt(intPart) * CENTS_PER_UNIT;

  let fracCents = 0n;
  if (fracPart !== '') {
    // 取前两位作为分；若有多余位，按第三位判断是否进位（HALF_UP）。
    const firstTwo = fracPart.slice(0, 2);
    fracCents = BigInt(firstTwo.padEnd(2, '0'));
    if (fracPart.length > 2) {
      const thirdDigit = fracPart.charCodeAt(2) - 48; // '0'..'9'
      if (thirdDigit >= 5) {
        fracCents += 1n;
      }
    }
  }
  return intCents + fracCents;
}

export class Money {
  private constructor(readonly cents: bigint) {}

  static zero(): Money {
    return new Money(0n);
  }

  /** 由分整数构造（允许 0 与负值；负值仅用于内部差异表达）。 */
  static fromCents(cents: bigint | number): Money {
    return new Money(BigInt(cents));
  }

  /** 由十进制字符串解析（HALF_UP 舍入到分），拒绝负数。 */
  static parse(input: string): Money {
    return new Money(parseDecimalToCents(input));
  }

  get isZero(): boolean {
    return this.cents === 0n;
  }

  get isPositive(): boolean {
    return this.cents > 0n;
  }

  get isNegative(): boolean {
    return this.cents < 0n;
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  sub(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  /** 返回值：负数/零/正数。 */
  compare(other: Money): number {
    if (this.cents < other.cents) return -1;
    if (this.cents > other.cents) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  /** 人民币按固定汇率 1 USD = 7.2 RMB 折算为 USD（分整数，HALF_UP）。 */
  toUsd(): Money {
    // usdCents = rmbCents / 7.2 = rmbCents * 10 / 72
    return new Money(divRoundHALF_UP(this.cents * 10n, 72n));
  }

  /** 输出两位小数字符串，如 "1234.57"、"0.00"、"-12.34"。 */
  format(): string {
    return formatCents(this.cents);
  }

  toString(): string {
    return this.format();
  }
}

/**
 * 有符号 bigint 除法（HALF_UP 四舍五入）。denominator 必须非零。
 */
export function divRoundHALF_UP(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyParseError('除以零');
  }
  const sign = (numerator < 0n ? -1n : 1n) * (denominator < 0n ? -1n : 1n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const q = a / b;
  const r = a % b;
  // HALF_UP：余数 >= b/2 时进位
  if (r * 2n >= b) {
    return sign * (q + 1n);
  }
  return sign * q;
}

/**
 * 百分比（占比）。以「百分之一」为单位存储：5.00% = 500n，105.50% = 10550n。
 * 分母为 0（合同金额为空或 0）时 of() 返回 null，表示「不可计算并提示」。
 */
export class Ratio {
  private constructor(readonly hundredths: bigint) {}

  /** numerator / denominator × 100%，分母为空/0 返回 null（不可计算）。 */
  static of(numerator: Money, denominator: Money): Ratio | null {
    if (denominator.isZero) return null;
    // hundredths = numerator / denominator * 10000
    return new Ratio(divRoundHALF_UP(numerator.cents * 10000n, denominator.cents));
  }

  /** 占比超过 100% 时允许如实显示并给出警告（业务层判断）。 */
  get isOverHundred(): boolean {
    return this.hundredths > 10000n;
  }

  /** 两位小数百分比数字，如 "5.00"、"105.50"、"0.00"。 */
  format(): string {
    const negative = this.hundredths < 0n;
    const abs = negative ? -this.hundredths : this.hundredths;
    const units = abs / 100n;
    const frac = abs % 100n;
    const body = `${units}.${String(frac).padStart(2, '0')}`;
    return negative ? `-${body}` : body;
  }

  equalsPercent(percentHundredths: bigint): boolean {
    return this.hundredths === percentHundredths;
  }

  toString(): string {
    return `${this.format()}%`;
  }
}
