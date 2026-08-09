import { describe, expect, it } from 'vitest';
import { SerialAddressUpdateService } from '../../src/domain/capabilities/serial-address-update/serial-address-update-service';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryInstrumentRepository } from '../helpers/execution-in-memory';
import { InMemorySerialAddressUpdateRepository } from '../helpers/capability-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * serial-address-update 领域场景测试（tasks 4.3 实现，4.12 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const instruments = new InMemoryInstrumentRepository();
  const updates = new InMemorySerialAddressUpdateRepository();
  const service = new SerialAddressUpdateService(updates, instruments, CLOCK);
  return { instruments, updates, service };
}

/** 在当前测试上下文中登记一台带序列号的搬迁仪器。 */
function addInstrument(ctx: ReturnType<typeof setup>, serialNo = 'SN-100', projectId = 'p1'): string {
  const id = `i-${serialNo}`;
  ctx.instruments.save({
    id,
    projectId,
    batchId: null,
    name: `仪器-${serialNo}`,
    model: null,
    serialNo,
    ups: false,
    qrRequested: false,
    destinationShipToId: null,
    accountId: null,
    usernameSnapshot: null,
    createdAt: 't',
    updatedAt: 't',
  });
  return id;
}

const BASE = { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-100', accountId: 'ACC-001' };

describe('序列号地址更新事实逐台登记（4.3）', () => {
  it('逐台创建更新事实：记录客户名称、新址地址、序列号、Account ID 与更新时间', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(
      instrumentId,
      { ...BASE, updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(update.instrumentId).toBe(instrumentId);
    expect(update.customerName).toBe('华东医药');
    expect(update.newSiteAddress).toBe('新址A');
    expect(update.serialNo).toBe('SN-100');
    expect(update.accountId).toBe('ACC-001');
    expect(update.updatedAt).toBe('2026-08-01');
    expect(ctx.updates.all).toHaveLength(1);
  });

  it('一台仪器多次地址变化：每次登记各创建一条，按更新时间保留可追溯', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '新址A', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '新址B', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(ctx.updates.all).toHaveLength(2);
    expect(ctx.updates.all.map((u) => u.newSiteAddress).sort()).toEqual(['新址A', '新址B']);
  });
});

describe('项目新址为默认计划、更新事实表达实际关联（4.3）', () => {
  it('项目新址仅作默认计划：不自动成为仪器实际关联新址', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    // 项目级新址（project.newSiteAddress）不作为本服务输入，未登记更新事实 → 未关联
    expect(ctx.service.getActualAddress(instrumentId)).toBeNull();
  });

  it('更新事实表达实际关联：以最近一条更新事实的新址为准', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '旧地址', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '实际新址', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(ctx.service.getActualAddress(instrumentId)!.newSiteAddress).toBe('实际新址');
    expect(ctx.service.getActualAddress(instrumentId)!.accountId).toBe('ACC-002');
  });

  it('未登记更新事实不视为已关联新址', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    expect(ctx.service.getActualAddress(instrumentId)).toBeNull();
  });
});

describe('不修改不可变 Ship-to（4.3）', () => {
  it('更新事实不创建、不修改也不删除任何 Ship-to 主数据', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    // 服务签名不依赖任何 Ship-to 仓储，注册只写更新事实
    const proto = Object.getPrototypeOf(ctx.service) as Record<string, unknown>;
    for (const name of ['createShipTo', 'updateShipTo', 'deleteShipTo']) {
      expect(name in proto).toBe(false);
    }
    const update = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(update.accountId).toBe('ACC-001');
    // 仪器记录未被触碰
    expect(ctx.instruments.findById(instrumentId)!.destinationShipToId).toBeNull();
  });
});

describe('更新时间必填、默认当前、可补录（4.3）', () => {
  it('创建时默认当前时间', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(update.updatedAt).toBe('2026-08-07');
  });

  it('补录历史时间：按所填历史时间保存并归属该月份', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(instrumentId, { ...BASE, updatedAt: '2026-03-15' }, ACTOR);
    expect(update.updatedAt).toBe('2026-03-15');
    expect(ctx.service.countByMonth()).toEqual([{ month: '2026-03', count: 1 }]);
  });
});

describe('更新事实列表、筛选与按更新时间计数（4.3）', () => {
  function seed() {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'SN-100');
    const i2 = addInstrument(ctx, 'SN-200');
    ctx.service.register(
      i1,
      { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-100', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      i2,
      { customerName: '华北医药', newSiteAddress: '新址B', serialNo: 'SN-200', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    return ctx;
  }

  it('列表展示与筛选：按客户、新址地址、序列号、Account ID 或更新时间', () => {
    const ctx = seed();
    expect(ctx.service.list()).toHaveLength(2);
    expect(ctx.service.list({ customerName: '华东' })).toHaveLength(1);
    expect(ctx.service.list({ newSiteAddress: '新址B' })).toHaveLength(1);
    expect(ctx.service.list({ serialNo: 'SN-200' })).toHaveLength(1);
    expect(ctx.service.list({ accountId: 'ACC-001' })).toHaveLength(1);
    expect(ctx.service.list({ updatedAt: '2026-08' })).toHaveLength(1);
    expect(ctx.service.list({ updatedAt: '2026-07-01' })).toHaveLength(1);
  });

  it('按更新时间所属月份计数', () => {
    const ctx = seed();
    expect(ctx.service.countByMonth()).toEqual([
      { month: '2026-07', count: 1 },
      { month: '2026-08', count: 1 },
    ]);
  });
});

describe('非空字段与序列号校验（4.3）', () => {
  it('非空字段缺失拒绝保存', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, customerName: '  ' }, ACTOR),
    ).toThrow(/客户名称/);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, newSiteAddress: '  ' }, ACTOR),
    ).toThrow(/新址地址/);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, serialNo: '  ' }, ACTOR),
    ).toThrow(/序列号/);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, accountId: '  ' }, ACTOR),
    ).toThrow(/Account ID/);
    // 不产生部分保存的更新事实
    expect(ctx.service.list()).toHaveLength(0);
  });

  it('序列号与登记仪器一致：不一致拒绝保存', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx, 'SN-100');
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, serialNo: 'SN-999' }, ACTOR),
    ).toThrow(/不一致/);
    expect(ctx.updates.all).toHaveLength(0);
    // 一致才允许保存
    const ok = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(ok.serialNo).toBe('SN-100');
  });

  it('不引入未确认的序列号格式约束：仅非空与仪器一致', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx, 'SN-100-XYZ/01');
    const update = ctx.service.register(
      instrumentId,
      { ...BASE, serialNo: 'SN-100-XYZ/01' },
      ACTOR,
    );
    expect(update.serialNo).toBe('SN-100-XYZ/01');
  });

  it('占位仪器（无序列号）无法登记序列号地址更新', () => {
    const ctx = setup();
    ctx.instruments.save({
      id: 'i-ph',
      projectId: 'p1',
      batchId: null,
      name: '占位仪器',
      model: null,
      serialNo: null,
      ups: false,
      qrRequested: false,
      destinationShipToId: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    expect(() =>
      ctx.service.register('i-ph', { ...BASE, serialNo: 'SN-X' }, ACTOR),
    ).toThrow(/尚无序列号/);
  });
});
