import { describe, expect, it } from 'vitest';
import {
  excelSerialToUtcDate,
  normalizeDateValue,
  normalizeMoneyToCentsString,
  serializeExcelSerial,
  tryNormalizeMoneyToCentsString,
  utcDateToBusinessDate,
  utcDateToIsoLocal,
} from '../../src/domain/capabilities/historical-data-import/excel-date';

/**
 * 8.24 Excel 1900/1904 日期系统、纯日期与本机业务时区的确定性转换，
 * 以及十进制字符串到 BigInt 分值的无精度损失金额转换（design D7/D21）。
 */

describe('8.24 Excel 日期系统确定性转换', () => {
  it('1900 系统：serial 1 = 1900-01-01，serial 59 = 1900-02-28，serial 60 非法', () => {
    expect(excelSerialToUtcDate(1, '1900')!.getTime()).toBe(Date.UTC(1900, 0, 1));
    expect(excelSerialToUtcDate(59, '1900')!.getTime()).toBe(Date.UTC(1900, 1, 28));
    expect(excelSerialToUtcDate(60, '1900')).toBeNull(); // 1900-02-29 不存在
    expect(excelSerialToUtcDate(61, '1900')!.getTime()).toBe(Date.UTC(1900, 2, 1));
    expect(serializeExcelSerial(45292, '1900', 'date')).toBe('2024-01-01');
    expect(serializeExcelSerial(1, '1900', 'date')).toBe('1900-01-01');
  });

  it('1904 系统：serial 0 = 1904-01-01，与 1900 系统相差 1462 天', () => {
    expect(excelSerialToUtcDate(0, '1904')!.getTime()).toBe(Date.UTC(1904, 0, 1));
    expect(serializeExcelSerial(0, '1904', 'date')).toBe('1904-01-01');
    // 同一 serial 在两个系统下日期不同
    expect(serializeExcelSerial(100, '1900', 'date')).not.toBe(serializeExcelSerial(100, '1904', 'date'));
  });

  it('非法 serial（负值/NaN/无穷）返回 null，不猜测', () => {
    expect(excelSerialToUtcDate(-1, '1900')).toBeNull();
    expect(excelSerialToUtcDate(Number.NaN, '1900')).toBeNull();
    expect(excelSerialToUtcDate(Number.POSITIVE_INFINITY, '1900')).toBeNull();
  });

  it('纯日期（date 语义）输出 yyyy-mm-dd 业务日期', () => {
    expect(utcDateToBusinessDate(new Date(Date.UTC(2024, 0, 1)))).toBe('2024-01-01');
    expect(normalizeDateValue('2026-08-07', '1900', 'date')).toBe('2026-08-07');
    expect(normalizeDateValue('45292', '1900', 'date')).toBe('2024-01-01'); // serial 文本
    expect(normalizeDateValue('45292.5', '1900', 'date')).toBe('2024-01-01'); // 时间部分在纯日期口径下舍去
  });

  it('日期时间（datetime 语义）按本机业务时区携带偏移输出', () => {
    const iso = serializeExcelSerial(45292.5, '1900', 'datetime');
    // 45292.5 = 2024-01-01 12:00（墙钟为业务本地时间），输出带本机偏移。
    expect(iso).toMatch(/^2024-01-01T12:00:00[+-]\d{2}:\d{2}$/);
    expect(utcDateToIsoLocal(new Date(Date.UTC(2024, 0, 1, 12, 0, 0)))).toMatch(/^2024-01-01T12:00:00[+-]\d{2}:\d{2}$/);
    // 带偏移 ISO 原样保留
    expect(normalizeDateValue('2026-08-07T10:30:00+08:00', '1900', 'datetime')).toBe('2026-08-07T10:30:00+08:00');
  });

  it('无偏移本地墙钟文本按本机业务时区携带偏移', () => {
    const iso = normalizeDateValue('2026-08-07 10:30:00', '1900', 'datetime')!;
    expect(iso).toMatch(/^2026-08-07T10:30:00[+-]\d{2}:\d{2}$/);
    expect(normalizeDateValue('2026-08-07 10:30', '1900', 'datetime')).toMatch(/^2026-08-07T10:30:00[+-]\d{2}:\d{2}$/);
  });

  it('无法解析的日期保持为空值语义并拒绝猜测（返回 null 由调用方保留原文）', () => {
    expect(normalizeDateValue('仅月份', '1900', 'datetime')).toBeNull();
    expect(normalizeDateValue('2026/08/07', '1900', 'date')).toBeNull(); // 非规范格式不猜测
  });

  it('date 语义拒绝带时间的 ISO；datetime 语义拒绝纯日期', () => {
    expect(normalizeDateValue('2026-08-07T10:30:00+08:00', '1900', 'date')).toBeNull();
    expect(normalizeDateValue('2026-08-07', '1900', 'datetime')).toBeNull();
  });
});

describe('8.24 十进制字符串 → BigInt 分值（无精度损失）', () => {
  it('整数、小数与多精度输入均精确规范化为两位小数', () => {
    expect(normalizeMoneyToCentsString('1234')).toBe('1234.00');
    expect(normalizeMoneyToCentsString('1234.5')).toBe('1234.50');
    expect(normalizeMoneyToCentsString('1234.567')).toBe('1234.57'); // HALF_UP
    expect(normalizeMoneyToCentsString('0')).toBe('0.00'); // 合同金额允许 0
    expect(normalizeMoneyToCentsString('0.999')).toBe('1.00');
    expect(normalizeMoneyToCentsString(' 100.00 ')).toBe('100.00');
    expect(normalizeMoneyToCentsString('')).toBeNull();
    expect(normalizeMoneyToCentsString('   ')).toBeNull();
  });

  it('大金额无精度损失（BigInt 分值）', () => {
    expect(normalizeMoneyToCentsString('999999999999.99')).toBe('999999999999.99');
    expect(normalizeMoneyToCentsString('12345678901234.56')).toBe('12345678901234.56');
  });

  it('非法金额返回 null（不抛错，由校验阶段定位金额错误）', () => {
    expect(tryNormalizeMoneyToCentsString('-5')).toBeNull();
    expect(tryNormalizeMoneyToCentsString('abc')).toBeNull();
    expect(tryNormalizeMoneyToCentsString('1,000')).toBeNull();
  });
});
