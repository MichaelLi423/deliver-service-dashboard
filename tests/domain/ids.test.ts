import { describe, expect, it } from 'vitest';
import {
  newInternalId,
  newTempNumber,
  normalizeCustomerName,
  normalizeRegion,
} from '../../src/domain/core/ids';

describe('稳定内部 ID 与业务 ID（tasks 1.2 / D1）', () => {
  it('内部 ID 创建时生成、全局唯一、格式为 UUID', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newInternalId());
    }
    expect(ids.size).toBe(1000);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(newInternalId())).toBe(
      true,
    );
  });

  it('客户名称去除首尾空白（trim 后唯一业务标识）', () => {
    expect(normalizeCustomerName(' 华东医药 ')).toBe('华东医药');
    expect(normalizeCustomerName('华东医药')).toBe('华东医药');
  });

  it('区域去除首尾空白后精确分组', () => {
    expect(normalizeRegion(' 华东 ')).toBe('华东');
  });

  it('系统临时编号形如 TP-yyyymmdd-XXXX 且不重复', () => {
    const a = newTempNumber(new Date('2026-08-07T10:00:00+08:00'));
    const b = newTempNumber(new Date('2026-08-07T10:00:00+08:00'));
    expect(a).toMatch(/^TP-\d{8}-[0-9A-F]{8}$/);
    expect(a).not.toBe(b);
  });
});
