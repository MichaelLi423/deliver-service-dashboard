import { describe, expect, it } from 'vitest';
import { ExecutionService } from '../../src/domain/capabilities/relocation-execution/execution-service';
import type { ExecutionLifecycleGateway } from '../../src/domain/capabilities/relocation-execution/execution-service';
import { ValidationError, UniquenessError } from '../../src/domain/core/errors';
import { FixedClock } from '../../src/domain/core/time';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';
import {
  InMemoryActivityEngineerRepository,
  InMemoryActivityRepository,
  InMemoryBatchChangeHistoryRepository,
  InMemoryBatchRepository,
  InMemoryInstrumentRepository,
  InMemoryLogisticsFeeRepository,
  InMemoryWorkFactRepository,
} from '../helpers/execution-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * relocation-execution 领域场景测试（tasks 3.1~3.7 实现，3.11 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

class RecordingGateway implements ExecutionLifecycleGateway {
  calls: string[] = [];
  onExecutionStarted(projectId: string): void {
    this.calls.push(projectId);
  }
}

function setup() {
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const projectService = new ProjectService(projects, contracts, undefined, CLOCK);
  const batches = new InMemoryBatchRepository();
  const instruments = new InMemoryInstrumentRepository();
  const batchChanges = new InMemoryBatchChangeHistoryRepository();
  const activities = new InMemoryActivityRepository();
  const engineers = new InMemoryActivityEngineerRepository();
  const workFacts = new InMemoryWorkFactRepository();
  const fees = new InMemoryLogisticsFeeRepository();
  const gateway = new RecordingGateway();
  const service = new ExecutionService(
    batches,
    instruments,
    batchChanges,
    activities,
    engineers,
    workFacts,
    fees,
    gateway,
    CLOCK,
  );
  return {
    projects,
    contracts,
    projectService,
    batches,
    instruments,
    batchChanges,
    activities,
    engineers,
    workFacts,
    fees,
    gateway,
    service,
  };
}

describe('暂定数量登记（3.1）', () => {
  it('只记暂定数量不建仪器：保存数量信息且不创建任何仪器记录', () => {
    const { projects, projectService, instruments } = setup();
    const project = projectService.createPendingProject();

    projectService.setTemporaryInstrumentCount(project.id, 12);

    expect(projects.findById(project.id)!.temporaryInstrumentCount).toBe(12);
    // 不生成虚拟仪器
    expect(instruments.all).toHaveLength(0);
  });

  it('暂定数量为负或非整数时拒绝', () => {
    const { projectService } = setup();
    const project = projectService.createPendingProject();
    expect(() => projectService.setTemporaryInstrumentCount(project.id, -1)).toThrow(
      ValidationError,
    );
    expect(() => projectService.setTemporaryInstrumentCount(project.id, 1.5)).toThrow(
      ValidationError,
    );
  });
});

describe('占位仪器与序列号唯一性（3.1 / TBD-02）', () => {
  it('建立无序列号占位仪器：序列号可空', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const placeholder = service.registerInstrument(
      project.id,
      { name: '占位仪器A', model: 'M-100' },
      ACTOR,
    );
    expect(placeholder.serialNo).toBeNull();
    expect(placeholder.name).toBe('占位仪器A');
    expect(placeholder.model).toBe('M-100');
  });

  it('合同/项目内序列号重复被拒', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    service.registerInstrument(project.id, { name: '仪器A', serialNo: 'SN-100' }, ACTOR);
    expect(() =>
      service.registerInstrument(project.id, { name: '仪器B', serialNo: 'SN-100' }, ACTOR),
    ).toThrow(UniquenessError);
  });

  it('跨合同序列号可重复', () => {
    const { service, projectService } = setup();
    const projectA = projectService.createPendingProject();
    const projectB = projectService.createPendingProject();
    service.registerInstrument(projectA.id, { name: '仪器A', serialNo: 'SN-100' }, ACTOR);
    const sameSerial = service.registerInstrument(
      projectB.id,
      { name: '仪器B', serialNo: 'SN-100' },
      ACTOR,
    );
    expect(sameSerial.serialNo).toBe('SN-100');
  });
});

describe('搬迁仪器字段（3.2）', () => {
  it('仪器名称必填、型号选填', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    expect(() => service.registerInstrument(project.id, { name: '  ' }, ACTOR)).toThrow(
      /仪器名称.*必填/,
    );
    const ok = service.registerInstrument(project.id, { name: '仪器C', model: undefined }, ACTOR);
    expect(ok.model).toBeNull();
  });

  it('UPS 标记为是或否（仅限两值）', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const yes = service.registerInstrument(project.id, { name: 'UPS仪器', ups: true }, ACTOR);
    const no = service.registerInstrument(project.id, { name: '普通仪器', ups: false }, ACTOR);
    expect(yes.ups).toBe(true);
    expect(no.ups).toBe(false);
  });

  it('二维码是否申请为手工字段：默认未申请、不由申请记录推导', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const notRequested = service.registerInstrument(
      project.id,
      { name: '仪器D' },
      ACTOR,
    );
    expect(notRequested.qrRequested).toBe(false);
    const requested = service.registerInstrument(
      project.id,
      { name: '仪器E', qrRequested: true },
      ACTOR,
    );
    expect(requested.qrRequested).toBe(true);
    // 手工标记后保存原值，不发生自动改写
    expect(notRequested.qrRequested).toBe(false);

    // 负责人可手工维护：由未申请改为已申请，再改回
    const toggled = service.updateInstrumentFields(notRequested.id, { qrRequested: true }, ACTOR);
    expect(toggled.qrRequested).toBe(true);
    const toggledBack = service.updateInstrumentFields(notRequested.id, { qrRequested: false }, ACTOR);
    expect(toggledBack.qrRequested).toBe(false);
    expect(toggledBack.name).toBe('仪器D');
  });
});

describe('批次归属与改批（3.3 / TBD-03）', () => {
  it('运输开始前改批保留改批历史（原批次、新批次、变更时间、登录账号归属）', () => {
    const { service, projectService, batches, batchChanges, instruments } = setup();
    const project = projectService.createPendingProject();
    const batchA = service.createBatch(project.id, ACTOR);
    const batchB = service.createBatch(project.id, ACTOR);
    const instrument = service.registerInstrument(project.id, { name: '仪器X' }, ACTOR);

    service.setInstrumentBatch(instrument.id, batchA.id, ACTOR);
    service.setInstrumentBatch(instrument.id, batchB.id, ACTOR);

    const history = batchChanges.listByInstrument(instrument.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      instrumentId: instrument.id,
      fromBatchId: null,
      toBatchId: batchA.id,
      accountId: 'account-1',
      usernameSnapshot: '负责人甲',
    });
    expect(history[1]).toMatchObject({
      fromBatchId: batchA.id,
      toBatchId: batchB.id,
      changedAt: '2026-08-07',
    });
    expect(instruments.findById(instrument.id)?.batchId).toBe(batchB.id);
    expect(batches.all).toHaveLength(2);
  });

  it('运输开始后禁止直接改批', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const batchA = service.createBatch(project.id, ACTOR);
    const instrument = service.registerInstrument(project.id, { name: '仪器Y' }, ACTOR);
    service.setInstrumentBatch(instrument.id, batchA.id, ACTOR);
    service.startBatchTransport(batchA.id, ACTOR);

    expect(() => service.setInstrumentBatch(instrument.id, null, ACTOR)).toThrow(
      /运输开始后禁止直接改批/,
    );
  });

  it('空批次不能开始运输：至少需要一台归属仪器', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const batch = service.createBatch(project.id, ACTOR);
    expect(() => service.startBatchTransport(batch.id, ACTOR)).toThrow(
      /该批次至少需要一台归属仪器/,
    );
  });

  it('运输仪器均归属该批次：开始运输确认运输集合与批次归属一致', () => {
    const { service, projectService, instruments, gateway } = setup();
    const project = projectService.createPendingProject();
    const batch = service.createBatch(project.id, ACTOR);
    for (const name of ['仪器1', '仪器2', '仪器3']) {
      const i = service.registerInstrument(project.id, { name }, ACTOR);
      service.setInstrumentBatch(i.id, batch.id, ACTOR);
    }
    const started = service.startBatchTransport(batch.id, ACTOR);
    expect(started.startedAt).toBe('2026-08-07');
    // 该批次涉及运输的仪器集合 = 批次归属仪器集合（三台）
    expect(instruments.listByBatch(batch.id)).toHaveLength(3);
    // 运输开始触发 lifecycle「首个搬迁批次开始运输 → 执行中」
    expect(gateway.calls).toEqual([project.id]);
  });
});

describe('上门活动与工作事实（3.4 / TBD-05）', () => {
  it('一次活动多类型多仪器同页记录', () => {
    const { service, projectService, workFacts } = setup();
    const project = projectService.createPendingProject();
    const i1 = service.registerInstrument(project.id, { name: '仪器A' }, ACTOR);
    const i2 = service.registerInstrument(project.id, { name: '仪器B' }, ACTOR);
    const activity = service.createActivity(project.id, null, ['工程师甲'], ACTOR);

    service.startWorkFact(activity.id, i1.id, 'teardown', ACTOR);
    service.startWorkFact(activity.id, i2.id, 'install', ACTOR);
    service.startWorkFact(activity.id, i1.id, 'other', ACTOR);

    // 按活动、仪器、工作类型分别保存，且全部在同一活动页
    expect(workFacts.listByActivity(activity.id)).toHaveLength(3);
    expect(workFacts.listByInstrument(i1.id)).toHaveLength(2);
  });

  it('拆机事实记录拆机状态及拆机开始/完成时间', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const i = service.registerInstrument(project.id, { name: '仪器C' }, ACTOR);
    const activity = service.createActivity(project.id, null, ['工程师甲'], ACTOR);

    const started = service.startWorkFact(activity.id, i.id, 'teardown', ACTOR);
    expect(started.status).toBe('in_progress');
    expect(started.startedAt).toBe('2026-08-07');
    expect(started.completedAt).toBeNull();

    const done = service.completeWorkFact(activity.id, i.id, 'teardown', ACTOR);
    expect(done.status).toBe('done');
    expect(done.completedAt).toBe('2026-08-07');
    expect(done.startedAt).toBe('2026-08-07');
  });

  it('其他工作类型记录各自状态与时间（装机/维修/其他）', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    const i = service.registerInstrument(project.id, { name: '仪器D' }, ACTOR);
    const activity = service.createActivity(project.id, null, ['工程师乙'], ACTOR);

    const install = service.startWorkFact(activity.id, i.id, 'install', ACTOR);
    expect(install.status).toBe('in_progress');
    const repair = service.startWorkFact(activity.id, i.id, 'repair', ACTOR);
    const other = service.startWorkFact(activity.id, i.id, 'other', ACTOR);
    service.completeWorkFact(activity.id, i.id, 'other', ACTOR);

    expect(install.completedAt).toBeNull();
    expect(repair.completedAt).toBeNull();
    expect(other.completedAt).toBe('2026-08-07');
  });

  it('多名工程师参与同一活动：保存全部参与工程师', () => {
    const { service, projectService, engineers } = setup();
    const project = projectService.createPendingProject();
    const activity = service.createActivity(project.id, null, ['工程师甲', '工程师乙', '工程师丙'], ACTOR);
    expect(engineers.listByActivity(activity.id)).toEqual(['工程师甲', '工程师乙', '工程师丙']);
  });

  it('活动至少需要一名参与工程师', () => {
    const { service, projectService } = setup();
    const project = projectService.createPendingProject();
    expect(() => service.createActivity(project.id, null, [], ACTOR)).toThrow(/至少需要一名/);
  });

  it('仪器不属于该活动所在项目时拒绝记录工作事实', () => {
    const { service, projectService } = setup();
    const projectA = projectService.createPendingProject();
    const projectB = projectService.createPendingProject();
    const i = service.registerInstrument(projectB.id, { name: '仪器E' }, ACTOR);
    const activity = service.createActivity(projectA.id, null, ['工程师甲'], ACTOR);
    expect(() => service.startWorkFact(activity.id, i.id, 'teardown', ACTOR)).toThrow(
      /不属于此上门活动所在搬迁项目/,
    );
  });
});

describe('拆装进度推导（3.5）', () => {
  function instrumentWithFacts() {
    const ctx = setup();
    const project = ctx.projectService.createPendingProject();
    const i = ctx.service.registerInstrument(project.id, { name: '仪器P' }, ACTOR);
    const activity = ctx.service.createActivity(project.id, null, ['工程师甲'], ACTOR);
    return { ...ctx, i, activity };
  }

  it('不存在工作事实即进度未开始', () => {
    const { service, i } = instrumentWithFacts();
    const progress = service.getInstrumentProgress(i.id);
    expect(progress.teardown).toBe('not_started');
    expect(progress.install).toBe('not_started');
  });

  it('进行中的拆机事实不算完成', () => {
    const { service, i, activity } = instrumentWithFacts();
    service.startWorkFact(activity.id, i.id, 'teardown', ACTOR);
    const progress = service.getInstrumentProgress(i.id);
    expect(progress.teardown).toBe('in_progress');
    expect(progress.teardownCompletedAt).toBeNull();
  });

  it('已完成的拆机事实判定拆机完成、装机未完成', () => {
    const { service, i, activity } = instrumentWithFacts();
    service.startWorkFact(activity.id, i.id, 'teardown', ACTOR);
    service.completeWorkFact(activity.id, i.id, 'teardown', ACTOR);
    const progress = service.getInstrumentProgress(i.id);
    expect(progress.teardown).toBe('done');
    expect(progress.install).toBe('not_started');
  });

  it('装机工作事实完成后进度更新', () => {
    const { service, i, activity } = instrumentWithFacts();
    service.startWorkFact(activity.id, i.id, 'teardown', ACTOR);
    service.completeWorkFact(activity.id, i.id, 'teardown', ACTOR);
    service.startWorkFact(activity.id, i.id, 'install', ACTOR);
    service.completeWorkFact(activity.id, i.id, 'install', ACTOR);
    const progress = service.getInstrumentProgress(i.id);
    expect(progress.teardown).toBe('done');
    expect(progress.install).toBe('done');
  });

  it('进度不可手工维护：不存在手工设置进度的方法', () => {
    const service = setup().service;
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    expect('setProgress' in proto).toBe(false);
    expect('setInstallProgress' in proto).toBe(false);
  });
});

describe('物流报价记录（3.6）', () => {
  it('记录合同预算价与物流成交价：报价阶段不作为客户侧物流收入（仅记录）', () => {
    const { service, projectService, batches } = setup();
    const project = projectService.createPendingProject();
    const batch = service.createBatch(project.id, ACTOR);
    service.updateBatchQuote(batch.id, {
      planTransportDate: '2026-08-10',
      transportCompany: '顺丰',
      originalPriceCents: 100000n,
      discountedPriceCents: 90000n,
    }, ACTOR);
    const saved = batches.findById(batch.id)!;
    expect(saved.planTransportDate).toBe('2026-08-10');
    expect(saved.transportCompany).toBe('顺丰');
    expect(saved.originalPriceCents).toBe(100000n);
    expect(saved.discountedPriceCents).toBe(90000n);
  });

  it('合同预算价/物流成交价有值时必须大于 0，可清空为 null', () => {
    const { service, projectService, batches } = setup();
    const project = projectService.createPendingProject();
    const batch = service.createBatch(project.id, ACTOR);
    expect(() =>
      service.updateBatchQuote(batch.id, { originalPriceCents: 0n }, ACTOR),
    ).toThrow(/大于 0/);
    expect(() =>
      service.updateBatchQuote(batch.id, { discountedPriceCents: -100n }, ACTOR),
    ).toThrow(/大于 0/);
    // 清空报价（null）允许
    service.updateBatchQuote(batch.id, {
      originalPriceCents: 100000n,
      discountedPriceCents: 90000n,
    }, ACTOR);
    service.updateBatchQuote(batch.id, {
      originalPriceCents: null,
      discountedPriceCents: null,
    }, ACTOR);
    expect(batches.findById(batch.id)!.originalPriceCents).toBeNull();
    expect(batches.findById(batch.id)!.discountedPriceCents).toBeNull();
  });

  it('不同批次不同运输公司', () => {
    const { service, projectService, batches } = setup();
    const project = projectService.createPendingProject();
    const batchA = service.createBatch(project.id, ACTOR);
    const batchB = service.createBatch(project.id, ACTOR);
    service.updateBatchQuote(batchA.id, { transportCompany: '顺丰' }, ACTOR);
    service.updateBatchQuote(batchB.id, { transportCompany: '德邦' }, ACTOR);
    expect(batches.findById(batchA.id)!.transportCompany).toBe('顺丰');
    expect(batches.findById(batchB.id)!.transportCompany).toBe('德邦');
  });
});

describe('实际物流费用记录（3.7 / TBD-14）', () => {
  function makeBatch() {
    const ctx = setup();
    const project = ctx.projectService.createPendingProject();
    const b = ctx.service.createBatch(project.id, ACTOR);
    return { ...ctx, project, batch: b };
  }

  it('每批次仅一笔实际费用记录', () => {
    const { service, batch } = makeBatch();
    service.recordLogisticsFee(batch.id, {
      appliedAt: '2026-07-15',
      budgetPriceCents: 10000n,
      dealPriceCents: 12000n,
      logisticsCostCents: 11000n,
    }, ACTOR);
    expect(() =>
      service.recordLogisticsFee(batch.id, {
        appliedAt: '2026-08-01',
        budgetPriceCents: 10000n,
        dealPriceCents: 12000n,
        logisticsCostCents: 11000n,
      }, ACTOR),
    ).toThrow(/每批次仅允许一笔/);
  });

  it('申请（登记）时间必填默认当天，归属月份按该时间计算', () => {
    const { service, batch, fees } = makeBatch();
    const { fee } = service.recordLogisticsFee(batch.id, {
      budgetPriceCents: 10000n,
      dealPriceCents: 12000n,
      logisticsCostCents: 11000n,
    }, ACTOR);
    expect(fee.appliedAt).toBe('2026-08-07'); // 默认当天（固定时钟）
    expect(fee.appliedAt.slice(0, 7)).toBe('2026-08'); // 归属月份
    expect(fees.findByBatchId(batch.id)?.appliedAt).toBe('2026-08-07');
  });

  it('三项金额必填且大于 0：未填写/0/负数拒绝', () => {
    const { service, batch } = makeBatch();
    expect(() =>
      service.recordLogisticsFee(batch.id, {
        budgetPriceCents: 0n,
        dealPriceCents: 12000n,
        logisticsCostCents: 11000n,
      }, ACTOR),
    ).toThrow(/大于 0/);
    expect(() =>
      service.recordLogisticsFee(batch.id, {
        budgetPriceCents: 10000n,
        dealPriceCents: 0n,
        logisticsCostCents: 11000n,
      }, ACTOR),
    ).toThrow(/大于 0/);
    expect(() =>
      service.recordLogisticsFee(batch.id, {
        budgetPriceCents: 10000n,
        dealPriceCents: 12000n,
        logisticsCostCents: -1n,
      }, ACTOR),
    ).toThrow(/大于 0/);
  });

  it('物流成交价大于合同预算价仅警告，仍允许保存且不自动创建项目提醒', () => {
    const { service, batch, fees } = makeBatch();
    const { fee, warning } = service.recordLogisticsFee(batch.id, {
      appliedAt: '2026-07-15',
      budgetPriceCents: 10000n,
      dealPriceCents: 12000n,
      logisticsCostCents: 11000n,
    }, ACTOR);
    expect(warning).toContain('物流成交价大于合同预算价');
    expect(fees.findByBatchId(batch.id)?.id).toBe(fee.id); // 保存成功
  });

  it('修改金额不改申请（登记）时间与归属月份', () => {
    const { service, batch } = makeBatch();
    const { fee } = service.recordLogisticsFee(batch.id, {
      appliedAt: '2026-07-15',
      budgetPriceCents: 10000n,
      dealPriceCents: 12000n,
      logisticsCostCents: 11000n,
    }, ACTOR);
    const { fee: updated } = service.updateLogisticsFee(fee.id, {
      budgetPriceCents: 11000n,
      dealPriceCents: 13000n,
      logisticsCostCents: 12000n,
    }, ACTOR);
    expect(updated.appliedAt).toBe('2026-07-15');
    expect(updated.appliedAt.slice(0, 7)).toBe('2026-07');
    expect(updated.budgetPriceCents).toBe(11000n);
    expect(updated.dealPriceCents).toBe(13000n);
  });

  it('getLogisticsFeeDifference（历史兼容：旧三口径成交-实际差异；现行业务与成交同值恒为 0）', () => {
    const { service, batch } = makeBatch();
    const { fee } = service.recordLogisticsFee(batch.id, {
      appliedAt: '2026-07-15',
      budgetPriceCents: 10000n,
      dealPriceCents: 12000n,
      logisticsCostCents: 11000n,
    }, ACTOR);
    expect(service.getLogisticsFeeDifference(fee)).toBe(1000n);
  });
});

describe('首次执行触发 lifecycle 执行中（3.x 联动 / design D4）', () => {
  it('开始首个工作事实触发 onExecutionStarted', () => {
    const { service, projectService, gateway } = setup();
    const project = projectService.createPendingProject();
    const i = service.registerInstrument(project.id, { name: '仪器A' }, ACTOR);
    const activity = service.createActivity(project.id, null, ['工程师甲'], ACTOR);
    expect(gateway.calls).toHaveLength(0); // 仅创建活动/排期不触发

    service.startWorkFact(activity.id, i.id, 'teardown', ACTOR);
    expect(gateway.calls).toEqual([project.id]);

    // 后续工作事实不再重复触发主状态（lifecycle 校验入口幂等）
    service.startWorkFact(activity.id, i.id, 'install', ACTOR);
    expect(gateway.calls).toEqual([project.id, project.id]);
  });

  it('批次开始运输触发 onExecutionStarted', () => {
    const { service, projectService, gateway } = setup();
    const project = projectService.createPendingProject();
    const batch = service.createBatch(project.id, ACTOR);
    const i = service.registerInstrument(project.id, { name: '仪器B' }, ACTOR);
    service.setInstrumentBatch(i.id, batch.id, ACTOR);
    expect(gateway.calls).toHaveLength(0);

    service.startBatchTransport(batch.id, ACTOR);
    expect(gateway.calls).toEqual([project.id]);
  });
});
