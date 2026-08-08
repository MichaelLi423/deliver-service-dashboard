import { describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { isFormallyEntered } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { ValidationError } from '../../src/domain/core/errors';
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

  it('合同开始与截止日期必填：缺失拒绝保存', () => {
    const { service } = setup();
    const projectId = service.createPendingProject().id;
    expect(() =>
      service.updateBasicInfo(projectId, { contractStartDate: '2026-07-01' } as never),
    ).toThrow(ValidationError);
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
    expect(projects.findById(projectId)!.contractStartDate).toBeNull();
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

describe('项目区域（2.7 / TBD-12）', () => {
  it('区域为自由文本：去除首尾空白后精确分组', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setRegion(projectId, ' 华东 ');
    expect(projects.findById(projectId)!.region).toBe('华东');
  });

  it('区域修改后按最新值实时重算分组（不保存快照）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setRegion(projectId, '华东');
    expect(projects.findById(projectId)!.region).toBe('华东');
    service.setRegion(projectId, ' 华南 ');
    expect(projects.findById(projectId)!.region).toBe('华南');
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
