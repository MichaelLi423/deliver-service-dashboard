import { describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { isFormallyEntered } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { Money } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';

/**
 * tasks 2.6 项目基础字段与合同日期、2.7 项目区域、
 * TBD-08 未进单/已进单视觉区分的判定事实。
 */

function setup(iso = '2026-08-07T10:00:00+08:00') {
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const service = new ProjectService(projects, contracts, undefined, new FixedClock(iso));
  return { projects, contracts, service };
}

describe('项目基础字段与合同日期（2.6）', () => {
  it('记录旧址与新址联系人（手工文本）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.updateBasicInfo(projectId, {
      oldSiteContact: '王工',
      newSiteContact: '李工',
      contractStartDate: '2026-07-01',
      contractEndDate: '2026-08-31',
    });
    const project = projects.findById(projectId)!;
    expect(project.oldSiteContact).toBe('王工');
    expect(project.newSiteContact).toBe('李工');
  });

  it('记录项目默认旧址与新址', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.updateBasicInfo(projectId, {
      oldSiteAddress: '旧址路 1 号',
      newSiteAddress: '新址路 2 号',
      contractStartDate: '2026-07-01',
      contractEndDate: '2026-08-31',
    });
    const project = projects.findById(projectId)!;
    expect(project.oldSiteAddress).toBe('旧址路 1 号');
    expect(project.newSiteAddress).toBe('新址路 2 号');
  });

  it('合同起止日期可空/可清除（补齐资料语义），缺省保持现值', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    // 仅填开始日期：截止保持为空，不要求成对必填。
    service.updateBasicInfo(projectId, { contractStartDate: '2026-07-01' });
    const partial = projects.findById(projectId)!;
    expect(partial.contractStartDate).toBe('2026-07-01');
    expect(partial.contractEndDate).toBeNull();
    // 后补截止日期。
    service.updateBasicInfo(projectId, { contractEndDate: '2026-08-31' });
    expect(projects.findById(projectId)!.contractEndDate).toBe('2026-08-31');
    // 显式清空（null/空串）：可空字段可清除。
    service.updateBasicInfo(projectId, { contractStartDate: null, contractEndDate: '' });
    const cleared = projects.findById(projectId)!;
    expect(cleared.contractStartDate).toBeNull();
    expect(cleared.contractEndDate).toBeNull();
  });

  it('合同截止日期早于开始日期时拒绝保存并提示', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    expect(() =>
      service.updateBasicInfo(projectId, {
        contractStartDate: '2026-08-01',
        contractEndDate: '2026-07-31',
      }),
    ).toThrow(/合同截止日期不得早于合同开始日期/);
    // 校验先于落库：拒绝后不产生部分写入。
    const project = projects.findById(projectId)!;
    expect(project.contractStartDate).toBeNull();
    expect(project.contractEndDate).toBeNull();
  });

  it('合同截止日期等于开始日期允许保存', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.updateBasicInfo(projectId, {
      contractStartDate: '2026-08-01',
      contractEndDate: '2026-08-01',
    });
    expect(projects.findById(projectId)!.contractEndDate).toBe('2026-08-01');
  });
});

describe('项目区域（2.7 / 2.4 / TBD-12）', () => {
  it('五个固定取值均可保存：去除首尾空白后保存规范化值', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    for (const [raw, expected] of [
      ['East', 'East'],
      [' South ', 'South'],
      ['West', 'West'],
      ['Central', 'Central'],
      ['North', 'North'],
    ]) {
      service.setRegion(projectId, raw);
      expect(projects.findById(projectId)!.region).toBe(expected);
    }
  });

  it('非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setRegion(projectId, 'East');
    for (const invalid of ['华东', '华南', 'East区域', 'Northeast', 'East West']) {
      expect(() => service.setRegion(projectId, invalid)).toThrow(
        /区域仅允许 East、South、West、Central、North 五个固定选项/,
      );
      // 校验先于落库：拒绝后原值保持，不产生部分写入。
      expect(projects.findById(projectId)!.region).toBe('East');
    }
  });

  it('非枚举区域值被拒的稳定错误码（INVALID_PROJECT_REGION，供程序化识别）', () => {
    const { service } = setup();
    const projectId = service.createPendingProject().id;
    try {
      service.setRegion(projectId, '华东');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_PROJECT_REGION');
      return;
    }
    expect.unreachable('应当抛出拒绝错误');
  });

  it('空串/纯空白 = 清空区域（保持既有清空语义）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setRegion(projectId, 'East');
    service.setRegion(projectId, '   ');
    expect(projects.findById(projectId)!.region).toBeNull();
  });

  it('存量 legacy 非枚举区域原值保留：普通资料编辑不触碰区域、不置空不丢弃', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    // 模拟升级前已存在 legacy 区域文本（直接落库，不经写边界）。
    const project = projects.findById(projectId)!;
    project.region = '华东';
    // 编辑其他资料不触及区域，原值原样保留。
    service.updateBasicInfo(projectId, { oldSiteContact: '王工', contractStartDate: '2026-07-01' });
    expect(projects.findById(projectId)!.region).toBe('华东');
    // legacy 值不允许重新写回（写边界拒绝），只能改为固定枚举。
    expect(() => service.setRegion(projectId, '华东')).toThrow(/五个固定选项/);
    service.setRegion(projectId, 'West');
    expect(projects.findById(projectId)!.region).toBe('West');
  });

  it('区域修改后按最新值实时重算分组（不保存快照）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setRegion(projectId, 'East');
    expect(projects.findById(projectId)!.region).toBe('East');
    service.setRegion(projectId, '  West ');
    expect(projects.findById(projectId)!.region).toBe('West');
  });
});

describe('项目备注 / 暂存信息 / 是否批复（0810 现场反馈）', () => {
  it('项目备注可空：建档后补充/修改/清空，不触发主状态流转', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    expect(projects.findById(projectId)!.projectNote).toBeNull();
    // 补充备注（trim 后保存）。
    service.setProjectNote(projectId, '  客户要求周末作业  ');
    expect(projects.findById(projectId)!.projectNote).toBe('客户要求周末作业');
    expect(projects.findById(projectId)!.status).toBe('pending_entry');
    // 修改备注。
    service.setProjectNote(projectId, '改为夜间作业');
    expect(projects.findById(projectId)!.projectNote).toBe('改为夜间作业');
    // 清空（显式 null / 空串）。
    service.setProjectNote(projectId, null);
    expect(projects.findById(projectId)!.projectNote).toBeNull();
  });

  it('暂存地址/是否暂存为手工维护执行事实：修改不影响主状态', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.updateTemporaryStorage(projectId, { temporaryStorageAddress: '临时仓 3 号', isTemporaryStorage: true });
    const project = projects.findById(projectId)!;
    expect(project.temporaryStorageAddress).toBe('临时仓 3 号');
    expect(project.isTemporaryStorage).toBe(true);
    expect(project.status).toBe('pending_entry');
    // 修改与清空。
    service.updateTemporaryStorage(projectId, { temporaryStorageAddress: null, isTemporaryStorage: null });
    const cleared = projects.findById(projectId)!;
    expect(cleared.temporaryStorageAddress).toBeNull();
    expect(cleared.isTemporaryStorage).toBeNull(); // 空 = 未填写，而非推断「否」
    expect(cleared.status).toBe('pending_entry');
  });

  it('是否批复（managerApproved）为可空 boolean 事实：标量保存不触发主状态', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setManagerApproved(projectId, true);
    expect(projects.findById(projectId)!.managerApproved).toBe(true);
    service.setManagerApproved(projectId, false);
    expect(projects.findById(projectId)!.managerApproved).toBe(false);
    service.setManagerApproved(projectId, null);
    expect(projects.findById(projectId)!.managerApproved).toBeNull();
    expect(projects.findById(projectId)!.status).toBe('pending_entry');
  });
});

describe('未进单与已进单判定事实（TBD-08 视觉区分依据）', () => {
  it('提供已进单判定事实：正式进单后为已进单，待进单项目为未进单', () => {
    const { projects, service } = setup();
    const enteredId = service.createPendingProject().id;
    const contract = service.attachContract(enteredId);
    new ContractService().setUsdTaxAmount(contract, Money.parse('10000'));
    service.linkCustomer(enteredId, 'customer-1');
    service.confirmScope(enteredId);
    service.formalEntry(enteredId, { ecc: 'ECC-001' });

    const pendingId = service.createPendingProject().id;

    expect(isFormallyEntered(projects.findById(enteredId)!)).toBe(true);
    expect(isFormallyEntered(projects.findById(pendingId)!)).toBe(false);
  });
});
