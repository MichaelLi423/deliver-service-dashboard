import { describe, expect, it } from 'vitest';
import {
  Money,
  MoneyParseError,
  Ratio,
  RMB_TO_USD_RATE,
} from '../../src/domain/core/money';

describe('金额值对象（tasks 1.3 / D7）', () => {
  it('十进制字符串解析为分整数（HALF_UP 四舍五入）', () => {
    expect(Money.parse('1234.567').cents).toBe(123457n); // 1234.57
    expect(Money.parse('1234.567').format()).toBe('1234.57');
    expect(Money.parse('0.1').cents).toBe(10n);
    expect(Money.parse('0').cents).toBe(0n);
    expect(Money.parse('1234').format()).toBe('1234.00');
    expect(Money.parse('1234.5').format()).toBe('1234.50');
  });

  it('1234.567 按两位小数四舍五入为 1234.57（spec 场景）', () => {
    const m = Money.parse('1234.567');
    expect(m.format()).toBe('1234.57');
  });

  it('非法格式与负数拒绝解析', () => {
    expect(() => Money.parse('')).toThrow(MoneyParseError);
    expect(() => Money.parse('abc')).toThrow(MoneyParseError);
    expect(() => Money.parse('-5.00')).toThrow(MoneyParseError);
    expect(() => Money.parse('1.2.3')).toThrow(MoneyParseError);
  });

  it('零值边界：0 允许表达（仅合同 USD 含税金额允许为 0）', () => {
    expect(Money.parse('0').isZero).toBe(true);
    expect(Money.zero().isZero).toBe(true);
    expect(Money.parse('0.00').isZero).toBe(true);
  });

  it('值对象允许差异表达：sub 可产生正/负差异（成交 vs 实际费用差异展示）', () => {
    const deal = Money.parse('12000.00');
    const actual = Money.parse('11500.50');
    const diff = deal.sub(actual);
    expect(diff.isNegative).toBe(false);
    expect(diff.isPositive).toBe(true);
    expect(diff.format()).toBe('499.50');
    const rev = actual.sub(deal);
    expect(rev.isNegative).toBe(true);
    expect(rev.format()).toBe('-499.50');
  });

  it('加减与比较不使用浮点', () => {
    const a = Money.parse('0.1');
    const b = Money.parse('0.2');
    expect(a.add(b).format()).toBe('0.30');
    expect(a.compare(b)).toBeLessThan(0);
    expect(b.compare(a)).toBeGreaterThan(0);
    expect(a.equals(Money.parse('0.10'))).toBe(true);
  });

  it('RMB 按固定汇率 1 USD = 7.2 RMB 折算为 USD', () => {
    expect(RMB_TO_USD_RATE).toBe('7.2');
    expect(Money.parse('720').toUsd().format()).toBe('100.00'); // 720 RMB → 100 USD
    expect(Money.parse('7200').toUsd().format()).toBe('1000.00'); // 7200 RMB → 1000 USD
  });

  it('占比：numerator/denominator 返回百分比（两位小数），分母 0/空 时不可计算', () => {
    const ratio = Ratio.of(Money.parse('100'), Money.parse('2000'));
    expect(ratio).not.toBeNull();
    expect(ratio!.format()).toBe('5.00');
    expect(ratio!.equalsPercent(500n)).toBe(true);

    const logisticsRatio = Ratio.of(Money.parse('7200').toUsd(), Money.parse('10000'));
    expect(logisticsRatio!.format()).toBe('10.00');

    // 合同金额为空或 0 时不可计算并提示
    expect(Ratio.of(Money.parse('100'), Money.zero())).toBeNull();
  });

  it('占比超过 100% 允许如实显示并给出警告依据', () => {
    const over = Ratio.of(Money.parse('300'), Money.parse('100'));
    expect(over!.format()).toBe('300.00');
    expect(over!.isOverHundred).toBe(true);
  });

  it('分整数构造与格式化', () => {
    expect(Money.fromCents(123457n).format()).toBe('1234.57');
    expect(Money.fromCents(0).isZero).toBe(true);
  });
});
