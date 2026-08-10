import { describe, expect, it } from 'vitest';
import { DamageRepairService } from '../../src/domain/capabilities/damage-repair-tracking/damage-repair-service';
import { FixedClock } from '../../src/domain/core/time';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';
import {
  InMemoryActivityRepository,
  InMemoryInstrumentRepository,
  InMemoryWorkFactRepository,
} from '../helpers/execution-in-memory';
import {
  InMemoryActivityDamageLinkRepository,
  InMemoryContractAmountReader,
  InMemoryDamageRepairItemRepository,
  InMemoryRepairActivityReader,
} from '../helpers/capability-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * damage-repair-tracking 领域场景测试（tasks 4.4~4.8 实现，4.13 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup(contractUsdCents: bigint | null = null) {
  const instruments = new InMemoryInstrumentRepository();
  const items = new InMemoryDamageRepairItemRepository();
  const links = new InMemoryActivityDamageLinkRepository();
  const activities = new InMemoryActivityRepository();
  const workFacts = new InMemoryWorkFactRepository();
  const contractReader = new InMemoryContractAmountReader();
  if (contractUsdCents !== null) contractReader.set('p1', contractUsdCents);
  const activityReader = new InMemoryRepairActivityReader(activities, workFacts);
  const service = new DamageRepairService(
    items,
    links,
    instruments,
    activityReader,
    contractReader,
    CLOCK,
  );
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const projectService = new ProjectService(projects, contracts, undefined, CLOCK);
  return { instruments, items, links, activities, workFacts, contractReader, activityReader, service, projects, projectService };
}

function addInstrument(ctx: ReturnType<typeof setup>, id: string, projectId = 'p1'): string {
  ctx.instruments.save({
    id,
    projectId,
    batchId: null,
    name: `仪器-${id}`,
    model: null,
    manufacturer: null,
    serviceLevel: null,
    serialNo: `SN-${id}`,
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

function partInput(overrides: Record<string, unknown> = {}) {
  return {
    damageReason: '运输碰撞',
    partNumber: 'PART-001',
    partQuantity: 1,
    partAmountCents: 10000n, // 100 USD
    partCurrency: 'USD' as const,
    ...overrides,
  };
}

describe('损坏/维修事项与单备件约束（4.4）', () => {
  it('一次损坏一条事项并关联仪器', () => {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    expect(item.instrumentId).toBe(i1);
    expect(item.partNumber).toBe('PART-001');
    expect(ctx.items.all).toHaveLength(1);
  });

  it('多个备件多条事项：每条事项只含一个备件', () => {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'i1');
    ctx.service.registerItem(i1, partInput({ partNumber: 'PART-001' }), ACTOR);
    ctx.service.registerItem(i1, partInput({ partNumber: 'PART-002' }), ACTOR);
    expect(ctx.items.all).toHaveLength(2);
    expect(ctx.items.all.map((i) => i.partNumber).sort()).toEqual(['PART-001', 'PART-002']);
  });
});

describe('事项字段与处理状态（4.5）', () => {
  it('字段完整记录并保存', () => {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(
      i1,
      partInput({
        damageReason: '运输碰撞导致面板破损',
        partRequestedAt: '2026-08-02',
        partStatus: 'pending_submit',
        repairNote: '已安排上门',
      }),
      ACTOR,
    );
    expect(item.damageReason).toBe('运输碰撞导致面板破损');
    expect(item.partRequestedAt).toBe('2026-08-02');
    expect(item.partStatus).toBe('pending_submit');
    expect(item.repairNote).toBe('已安排上门');
    expect(ctx.items.findById(item.id)!.issueStatus).toBe('untreated');
  });

  it('已关闭未修复必须记录原因', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    expect(() => ctx.service.updateIssueStatus(item.id, 'closed_unrepaired', null, ACTOR)).toThrow(/关闭原因/);
    const closed = ctx.service.updateIssueStatus(item.id, 'closed_unrepaired', '无法修复', ACTOR);
    expect(closed.issueStatus).toBe('closed_unrepaired');
    expect(closed.closeReason).toBe('无法修复');
  });
});

describe('备件申请时间与备件处理状态（4.5 / TBD-13）', () => {
  it('记录备件申请时间到事项内，不建立独立备件申请对象', () => {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput({ partRequestedAt: '2026-08-02' }), ACTOR);
    expect(item.partRequestedAt).toBe('2026-08-02');
    const proto = Object.getPrototypeOf(ctx.service) as Record<string, unknown>;
    expect('createPartRequest' in proto).toBe(false);
  });

  it('备件处理状态仅限四值流转', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput({ partStatus: 'pending_submit' }), ACTOR);
    ctx.service.setPartStatus(item.id, 'processing', ACTOR);
    ctx.service.setPartStatus(item.id, 'arrived', ACTOR);
    const used = ctx.service.setPartStatus(item.id, 'used', ACTOR);
    expect(used.partStatus).toBe('used');
    expect(() => ctx.service.setPartStatus(item.id, 'illegal' as never, ACTOR)).toThrow(/仅限/);
  });

  it('仅已使用备件计入维修费用', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const arrived = ctx.service.registerItem(i1, partInput({ partNumber: 'P1', partStatus: 'arrived', partAmountCents: 30000n }), ACTOR);
    const used = ctx.service.registerItem(i1, partInput({ partNumber: 'P2', partStatus: 'used', partAmountCents: 10000n }), ACTOR);
    expect(ctx.service.usedPartUsdCents(arrived)).toBe(0n); // 已到件不计入
    expect(ctx.service.usedPartUsdCents(used)).toBe(10000n); // 已使用计入
  });
});

describe('数量与金额必填且大于零（4.6）', () => {
  it('数量或金额为空、为 0 或为负数拒绝保存', () => {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'i1');
    expect(() => ctx.service.registerItem(i1, partInput({ partQuantity: 0 }), ACTOR)).toThrow(/大于 0/);
    expect(() => ctx.service.registerItem(i1, partInput({ partQuantity: -1 }), ACTOR)).toThrow(/大于 0/);
    expect(() => ctx.service.registerItem(i1, partInput({ partAmountCents: 0n }), ACTOR)).toThrow(/大于 0/);
    expect(() => ctx.service.registerItem(i1, partInput({ partAmountCents: -5n }), ACTOR)).toThrow(/大于 0/);
    expect(ctx.items.all).toHaveLength(0);
    expect(ctx.service.registerItem(i1, partInput(), ACTOR).partAmountCents).toBe(10000n);
  });
});

describe('备件金额币种与固定汇率折算（4.6）', () => {
  it('RMB 按固定汇率 1 USD = 7.2 RMB 折算为 USD', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(
      i1,
      partInput({ partCurrency: 'RMB', partAmountCents: 72000n, partStatus: 'used' }),
      ACTOR,
    );
    expect(item.partCurrency).toBe('RMB');
    expect(ctx.service.usedPartUsdCents(item)).toBe(10000n); // 720 RMB → 100 USD
  });

  it('币种边界：仅限 USD 与 RMB', () => {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'i1');
    expect(() => ctx.service.registerItem(i1, partInput({ partCurrency: 'EUR' as never }), ACTOR)).toThrow(
      /仅限 USD/,
    );
  });
});

describe('合同金额为 0 时的维修限制（4.7 / TBD-15）', () => {
  it('合同金额为 0 时仍可登记损坏，事项进入未处理', () => {
    const ctx = setup(null); // 合同金额为空
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    expect(item.issueStatus).toBe('untreated');
  });

  it('合同金额为 0 时禁止开始/完成维修', () => {
    const ctx = setup(null);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    expect(() => ctx.service.updateIssueStatus(item.id, 'processing', null, ACTOR)).toThrow(/补齐正数合同金额/);
    expect(() => ctx.service.updateIssueStatus(item.id, 'repaired', null, ACTOR)).toThrow(/补齐正数合同金额/);
    expect(() => ctx.service.updateIssueStatus(item.id, 'closed_unrepaired', '原因', ACTOR)).toThrow(/补齐正数合同金额/);
  });

  it('合同金额为 0 时禁止备件标记已使用', () => {
    const ctx = setup(null);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput({ partStatus: 'arrived' }), ACTOR);
    expect(() => ctx.service.setPartStatus(item.id, 'used', ACTOR)).toThrow(/补齐正数合同金额/);
  });

  it('登记时备件直接标记已使用：合同金额为空/0 时拒绝登记（Oracle 修复）', () => {
    const ctx = setup(null);
    const i1 = addInstrument(ctx, 'i1');
    expect(() => ctx.service.registerItem(i1, partInput({ partStatus: 'used' }), ACTOR)).toThrow(/补齐正数合同金额/);
    expect(ctx.items.all).toHaveLength(0);
    ctx.contractReader.set('p1', 0n);
    expect(() => ctx.service.registerItem(i1, partInput({ partStatus: 'used' }), ACTOR)).toThrow(/补齐正数合同金额/);
    expect(ctx.items.all).toHaveLength(0);
  });

  it('登记时事项状态直接处理中/已修复：合同金额为空/0 时拒绝，补齐后允许（Oracle 修复）', () => {
    const ctx = setup(null);
    const i1 = addInstrument(ctx, 'i1');
    expect(() => ctx.service.registerItem(i1, partInput({ issueStatus: 'processing' }), ACTOR)).toThrow(/补齐正数合同金额/);
    expect(() => ctx.service.registerItem(i1, partInput({ issueStatus: 'repaired' }), ACTOR)).toThrow(/补齐正数合同金额/);
    expect(() => ctx.service.registerItem(i1, partInput({ issueStatus: 'closed_unrepaired', closeReason: '无法修复' }), ACTOR)).toThrow(/补齐正数合同金额/);
    expect(ctx.items.all).toHaveLength(0);

    ctx.contractReader.set('p1', 200000n);
    const direct = ctx.service.registerItem(i1, partInput({ issueStatus: 'repaired' }), ACTOR);
    expect(direct.issueStatus).toBe('repaired');
    const closed = ctx.service.registerItem(i1, partInput({ issueStatus: 'closed_unrepaired', closeReason: '无法修复' }), ACTOR);
    expect(closed.issueStatus).toBe('closed_unrepaired');
    expect(closed.closeReason).toBe('无法修复');
  });

  it('登记为已关闭未修复必须记录原因（Oracle 修复补充约束）', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    expect(() => ctx.service.registerItem(i1, partInput({ issueStatus: 'closed_unrepaired' }), ACTOR)).toThrow(/关闭原因/);
    expect(ctx.items.all).toHaveLength(0);
  });

  it('补齐正数合同金额后允许开始/完成维修与标记已使用', () => {
    const ctx = setup(null);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput({ partStatus: 'arrived' }), ACTOR);
    ctx.contractReader.set('p1', 200000n); // 补齐正数合同金额
    expect(ctx.service.updateIssueStatus(item.id, 'processing', null, ACTOR).issueStatus).toBe('processing');
    expect(ctx.service.setPartStatus(item.id, 'used', ACTOR).partStatus).toBe('used');
  });
});

describe('不阻塞项目生命周期（4.7 / TBD-07）', () => {
  it('未完成处理不阻塞全流程流转，可在此后继续处理', () => {
    const ctx = setup();
    const projectId = ctx.projectService.createPendingProject().id;
    ctx.contractReader.set(projectId, 200000n);
    const i1 = addInstrument(ctx, 'i1', projectId);
    const itemA = ctx.service.registerItem(i1, partInput(), ACTOR);
    const itemB = ctx.service.registerItem(i1, partInput({ partNumber: 'P2' }), ACTOR);
    ctx.service.updateIssueStatus(itemB.id, 'processing', null, ACTOR);

    ctx.projectService.adjustStatus(projectId, 'executing');
    ctx.projectService.adjustStatus(projectId, 'pending_acceptance');
    ctx.projectService.adjustStatus(projectId, 'pending_invoice');
    expect(ctx.projects.findById(projectId)!.status).toBe('pending_invoice');

    // 流转后继续处理事项
    expect(ctx.service.updateIssueStatus(itemA.id, 'processing', null, ACTOR).issueStatus).toBe('processing');
  });

  it('验收后仍允许登记与继续维修，不影响验收/待掉票/完成状态', () => {
    const ctx = setup();
    const projectId = ctx.projectService.createPendingProject().id;
    ctx.contractReader.set(projectId, 200000n);
    ctx.projectService.adjustStatus(projectId, 'pending_invoice');
    const i1 = addInstrument(ctx, 'i1', projectId);
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    ctx.service.updateIssueStatus(item.id, 'repaired', null, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('pending_invoice');
  });
});

describe('损坏/维修事项删除（5.2）', () => {
  function repairActivity(ctx: ReturnType<typeof setup>, activityId: string, instrumentIds: string[]) {
    ctx.activities.save({
      id: activityId,
      projectId: 'p1',
      visitAt: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    for (const instrumentId of instrumentIds) {
      ctx.workFacts.save({
        id: `wf-${activityId}-${instrumentId}`,
        activityId,
        instrumentId,
        workType: 'repair',
        status: 'done',
        startedAt: 't',
        completedAt: 't',
        accountId: null,
        usernameSnapshot: null,
        createdAt: 't',
        updatedAt: 't',
      });
    }
  }

  it('确认后删除：事项从 countItems 统计消失，且仅指向该事项的维修上门关联被清理', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const i2 = addInstrument(ctx, 'i2');
    const removed = ctx.service.registerItem(i1, partInput({ partNumber: 'P1' }), ACTOR);
    const kept = ctx.service.registerItem(i2, partInput({ partNumber: 'P2' }), ACTOR);
    repairActivity(ctx, 'act-1', [i1, i2]);
    ctx.service.linkRepairActivity('act-1', removed.id, ACTOR);
    ctx.service.linkRepairActivity('act-1', kept.id, ACTOR);

    ctx.service.deleteItem(removed.id);
    expect(ctx.items.findById(removed.id)).toBeUndefined();
    expect(ctx.service.countItems('p1')).toBe(1); // 仅剩 kept
    // 仅指向被删事项的关联被清理；活动与其他事项的关联保留
    expect(ctx.links.listByDamageItem(removed.id)).toHaveLength(0);
    expect(ctx.links.listByDamageItem(kept.id)).toHaveLength(1);
    expect(ctx.links.listByActivity('act-1')).toHaveLength(1);
    expect(ctx.activities.findById('act-1')).toBeDefined(); // 活动本身保留
  });

  it('删除不影响关联仪器与搬迁项目', () => {
    const ctx = setup(200000n);
    const projectId = ctx.projectService.createPendingProject().id;
    ctx.contractReader.set(projectId, 200000n);
    const i1 = addInstrument(ctx, 'i1', projectId);
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    ctx.projectService.adjustStatus(projectId, 'executing');
    const statusBefore = ctx.projects.findById(projectId)!.status;
    ctx.service.deleteItem(item.id);
    expect(ctx.instruments.findById(i1)).toBeDefined(); // 仪器保留
    expect(ctx.projects.findById(projectId)!.status).toBe(statusBefore); // 项目生命周期不变
  });

  it('已处理/备件已使用的事项同样可确认后删除（spec 新口径：不因状态拒绝）', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const processed = ctx.service.registerItem(
      i1,
      partInput({ partNumber: 'P1', issueStatus: 'processing', partStatus: 'used' }),
      ACTOR,
    );
    expect(processed.issueStatus).toBe('processing');
    expect(ctx.service.countItems('p1')).toBe(1);
    ctx.service.deleteItem(processed.id);
    expect(ctx.items.findById(processed.id)).toBeUndefined();
    expect(ctx.service.countItems('p1')).toBe(0);
    expect(ctx.links.all).toHaveLength(0); // 无孤立关联
  });

  it('未确认（不存在）不删除：记录不存在时拒绝且无副作用', () => {
    const ctx = setup();
    expect(() => ctx.service.deleteItem('no-such-item')).toThrow(/损坏\/维修事项不存在/);
    expect(ctx.items.all).toHaveLength(0);
  });
});

describe('维修报表统计口径（4.7）', () => {
  it('按事项记录数量与单条金额统计（仅已使用计入）', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const used = ctx.service.registerItem(i1, partInput({ partNumber: 'P1', partStatus: 'used', partAmountCents: 10000n }), ACTOR);
    const arrived = ctx.service.registerItem(i1, partInput({ partNumber: 'P2', partStatus: 'arrived', partAmountCents: 30000n }), ACTOR);
    expect(ctx.service.countItems('p1')).toBe(2);
    expect(ctx.service.usedPartUsdCents(used)).toBe(10000n);
    expect(ctx.service.usedPartUsdCents(arrived)).toBe(0n);
  });

  it('合同占比计算：100 ÷ 2000 = 5%', () => {
    const ctx = setup(200000n); // 2000 USD
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput({ partStatus: 'used', partAmountCents: 10000n }), ACTOR);
    expect(ctx.service.contractRatioHundredths(item, 200000n)).toBe(500n); // 5.00%
    expect(ctx.service.contractRatioHundredths(item, null)).toBeNull(); // 合同空 → 不可计算
    expect(ctx.service.contractRatioHundredths(item, 0n)).toBeNull(); // 合同 0 → 不可计算
  });

  it('占比超过 100% 允许如实显示并给出警告', () => {
    const ctx = setup(50000n); // 500 USD
    const i1 = addInstrument(ctx, 'i1');
    ctx.service.registerItem(i1, partInput({ partStatus: 'used', partAmountCents: 10000n }), ACTOR);
    const item2 = ctx.service.registerItem(i1, partInput({ partNumber: 'P2', partStatus: 'used', partAmountCents: 20000n }), ACTOR);
    const ratio = ctx.service.contractRatioHundredths(item2, 10000n)!; // 200 USD vs 100 USD → 200%
    expect(ratio).toBe(20000n);
    expect(ratio > 10000n).toBe(true); // 超过 100% → 可提示警告
  });
});

describe('维修上门活动 × 损坏/维修事项多对多关联（4.8 / TBD-24）', () => {
  function repairActivity(ctx: ReturnType<typeof setup>, activityId: string, instrumentIds: string[]) {
    ctx.activities.save({
      id: activityId,
      projectId: 'p1',
      visitAt: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    for (const instrumentId of instrumentIds) {
      ctx.workFacts.save({
        id: `wf-${activityId}-${instrumentId}`,
        activityId,
        instrumentId,
        workType: 'repair',
        status: 'done',
        startedAt: 't',
        completedAt: 't',
        accountId: null,
        usernameSnapshot: null,
        createdAt: 't',
        updatedAt: 't',
      });
    }
  }

  it('一次维修上门关联多个事项，关联仅引用、不建立维修上门子记录', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const i2 = addInstrument(ctx, 'i2');
    const itemA = ctx.service.registerItem(i1, partInput({ partNumber: 'P1' }), ACTOR);
    const itemB = ctx.service.registerItem(i2, partInput({ partNumber: 'P2' }), ACTOR);
    repairActivity(ctx, 'act-1', [i1, i2]);

    ctx.service.linkRepairActivity('act-1', itemA.id, ACTOR);
    ctx.service.linkRepairActivity('act-1', itemB.id, ACTOR);

    expect(ctx.links.listByActivity('act-1')).toHaveLength(2);
    const keys = Object.keys(ctx.items.findById(itemA.id)!);
    expect(keys.some((k) => k.includes('visitSub') || k.includes('repairVisit'))).toBe(false);
  });

  it('同一事项被多次维修上门关联', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    repairActivity(ctx, 'act-1', [i1]);
    repairActivity(ctx, 'act-2', [i1]);

    ctx.service.linkRepairActivity('act-1', item.id, ACTOR);
    ctx.service.linkRepairActivity('act-2', item.id, ACTOR);

    expect(ctx.links.listByDamageItem(item.id)).toHaveLength(2);
    expect(ctx.items.findById(item.id)!.id).toBe(item.id); // 不重复建立事项
  });

  it('事项所属仪器不在活动仪器集合时拒绝关联，既有关联保持不变', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const i2 = addInstrument(ctx, 'i2');
    const itemOnY = ctx.service.registerItem(i2, partInput(), ACTOR); // 所属仪器 i2
    repairActivity(ctx, 'act-1', [i1]); // 活动仪器集合不含 i2
    const existing = ctx.service.registerItem(i1, partInput({ partNumber: 'P2' }), ACTOR);
    ctx.service.linkRepairActivity('act-1', existing.id, ACTOR);

    expect(() => ctx.service.linkRepairActivity('act-1', itemOnY.id, ACTOR)).toThrow(/不在该维修上门活动的仪器集合中/);
    expect(ctx.links.listByActivity('act-1')).toHaveLength(1); // 既有关联保持不变
  });

  it('非维修类上门活动不可关联事项', () => {
    const ctx = setup(200000n);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    // 拆机活动（无维修工作事实）
    ctx.activities.save({
      id: 'act-teardown',
      projectId: 'p1',
      visitAt: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    ctx.workFacts.save({
      id: 'wf-td',
      activityId: 'act-teardown',
      instrumentId: i1,
      workType: 'teardown',
      status: 'done',
      startedAt: 't',
      completedAt: 't',
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    expect(() => ctx.service.linkRepairActivity('act-teardown', item.id, ACTOR)).toThrow(/仅类型为维修/);
  });

  it('合同金额为空/0 时禁止维修上门活动与事项关联，补齐正数后允许（Oracle 修复 / TBD-15）', () => {
    const ctx = setup(null);
    const i1 = addInstrument(ctx, 'i1');
    const item = ctx.service.registerItem(i1, partInput(), ACTOR);
    repairActivity(ctx, 'act-1', [i1]);

    expect(() => ctx.service.linkRepairActivity('act-1', item.id, ACTOR)).toThrow(/补齐正数合同金额/);
    expect(ctx.links.all).toHaveLength(0);

    ctx.contractReader.set('p1', 0n);
    expect(() => ctx.service.linkRepairActivity('act-1', item.id, ACTOR)).toThrow(/补齐正数合同金额/);
    expect(ctx.links.all).toHaveLength(0);

    ctx.contractReader.set('p1', 200000n);
    const link = ctx.service.linkRepairActivity('act-1', item.id, ACTOR);
    expect(link.damageItemId).toBe(item.id);
    expect(ctx.links.all).toHaveLength(1);
  });
});
