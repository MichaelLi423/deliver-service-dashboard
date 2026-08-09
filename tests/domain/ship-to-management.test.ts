import { describe, expect, it } from 'vitest';
import { ShipToService } from '../../src/domain/capabilities/ship-to-management/ship-to-service';
import { UniquenessError } from '../../src/domain/core/errors';
import { FixedClock } from '../../src/domain/core/time';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';
import {
  InMemoryShipToAddressReader,
  InMemoryShipToRepository,
  InMemoryShipToRequestRepository,
} from '../helpers/capability-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * ship-to-management 领域场景测试（tasks 4.1~4.2 实现，4.11 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const shipTos = new InMemoryShipToRepository();
  const requests = new InMemoryShipToRequestRepository();
  const reader = new InMemoryShipToAddressReader([]);
  const service = new ShipToService(shipTos, requests, reader, CLOCK);
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const projectService = new ProjectService(projects, contracts, undefined, CLOCK);
  return { shipTos, requests, reader, service, projects, projectService };
}

describe('Ship-to 不可变主数据与 Account ID（4.1）', () => {
  it('创建后不可修改：服务不提供任何修改 Ship-to 的方法', () => {
    const { shipTos, service } = setup();
    service.createShipTo('ACC-001', '华东医药', '新址A');
    expect(shipTos.all).toHaveLength(1);
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of ['updateShipTo', 'editShipTo', 'changeAddress']) {
      expect(name in proto).toBe(false);
    }
    expect(shipTos.all[0].newSiteAddress).toBe('新址A');
  });

  it('Account ID 唯一标识：重复创建被拒，已引用 Ship-to 不因新申请而改变', () => {
    const { shipTos, service } = setup();
    service.createShipTo('ACC-001', '华东医药', '新址A');
    expect(() => service.createShipTo('ACC-001', '华东医药', '新址B')).toThrow(UniquenessError);
    // 被仪器引用的 Ship-to 保持原值
    expect(shipTos.findByAccountId('ACC-001')!.newSiteAddress).toBe('新址A');
  });
});

describe('Ship-to 申请按客户与新址地址创建（4.2）', () => {
  it('同客户同新址一条申请，客户或新址不同分别创建', () => {
    const { service, requests } = setup();
    const r1 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    const r2 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址B' }, ACTOR);
    const r3 = service.createRequest({ customerName: '华北医药', newSiteAddress: '新址A' }, ACTOR);
    expect(requests.all).toHaveLength(3);
    expect(r1.customerName).toBe('华东医药');
    expect(r1.newSiteAddress).toBe('新址A');
    expect(r2.newSiteAddress).toBe('新址B');
    expect(r3.customerName).toBe('华北医药');
  });

  it('申请不关联仪器、不保存地址快照：仅客户名称与新址地址', () => {
    const { service } = setup();
    const request = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    const keys = Object.keys(request).sort();
    // 无 instrument 关联、无结构化地址快照字段
    expect(keys.some((k) => k.includes('instrument'))).toBe(false);
    expect(keys.some((k) => k.includes('snapshot'))).toBe(false);
    expect(request.customerName).toBe('华东医药');
    expect(request.newSiteAddress).toBe('新址A');
  });

  it('客户名称与新址地址去除首尾空白后保存（Oracle 修复：规范化 trim）', () => {
    const { service, requests } = setup();
    const request = service.createRequest({ customerName: '  华东医药  ', newSiteAddress: '  新址A  ' }, ACTOR);
    expect(request.customerName).toBe('华东医药');
    expect(request.newSiteAddress).toBe('新址A');
    expect(requests.findById(request.id)!.customerName).toBe('华东医药');
    expect(requests.findById(request.id)!.newSiteAddress).toBe('新址A');
  });

  it('同客户同新址只创建一条申请：任一状态（待提交/处理中/已完成）已存在时返回既有申请', () => {
    const { service, requests } = setup();
    const r1 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    // 待提交状态重复申请 → 返回既有，不新建
    const r1again = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    expect(r1again.id).toBe(r1.id);
    expect(requests.all).toHaveLength(1);

    // 处理中状态重复申请 → 仍返回既有
    service.submit(r1.id, ACTOR);
    const r1processing = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    expect(r1processing.id).toBe(r1.id);
    expect(requests.all).toHaveLength(1);

    // 已完成状态重复申请 → 仍返回既有（含其产生的 Ship-to 不重复创建）
    service.complete(r1.id, 'ACC-500', ACTOR);
    const r1completed = service.createRequest({ customerName: ' 华东医药 ', newSiteAddress: ' 新址A ' }, ACTOR);
    expect(r1completed.id).toBe(r1.id);
    expect(requests.all).toHaveLength(1);
  });

  it('客户或新址不同仍分别创建申请（trim 后比较）', () => {
    const { service, requests } = setup();
    const r1 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    const r2 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址B' }, ACTOR);
    const r3 = service.createRequest({ customerName: '华北医药', newSiteAddress: '新址A' }, ACTOR);
    // 首尾空白不影响同值判定；真实不同仍分别创建
    const r4 = service.createRequest({ customerName: ' 华东医药 ', newSiteAddress: ' 新址C ' }, ACTOR);
    expect(requests.all).toHaveLength(4);
    expect(r1.id).not.toBe(r2.id);
    expect(r2.id).not.toBe(r3.id);
    expect(r4.id).not.toBe(r1.id);
  });
});

describe('Account ID 创建时可空、外部完成后补入并进入已完成（4.2）', () => {
  it('创建申请时 Account ID 可空，保持待提交或处理中状态', () => {
    const { service } = setup();
    const request = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    expect(request.accountId).toBeNull();
    expect(request.status).toBe('pending_submit');
  });

  it('外部完成后补入 Account ID 进入已完成并创建不可变 Ship-to', () => {
    const { shipTos, service } = setup();
    const request = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    service.submit(request.id, ACTOR);
    const completed = service.complete(request.id, 'ACC-100', ACTOR);
    expect(completed.status).toBe('completed');
    expect(completed.accountId).toBe('ACC-100');
    expect(completed.completedAt).toBe('2026-08-07');
    // 补入的 Account ID 创建不可变 Ship-to
    expect(shipTos.findByAccountId('ACC-100')?.newSiteAddress).toBe('新址A');
  });

  it('补入重复 Account ID 被拒，申请保持原状态不进入已完成', () => {
    const { requests, service } = setup();
    service.createShipTo('ACC-200', '华北医药', '新址B');
    const request = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    service.submit(request.id, ACTOR);
    expect(() => service.complete(request.id, 'ACC-200', ACTOR)).toThrow(UniquenessError);
    expect(requests.findById(request.id)!.status).toBe('processing');
    expect(requests.findById(request.id)!.completedAt).toBeNull();
  });
});

describe('申请线性状态与首次提交工作量（4.2 / TBD-04）', () => {
  it('首次实际提交计一次工作量，待提交草稿不计', () => {
    const { service } = setup();
    const draft = service.createRequest({ customerName: '客户A', newSiteAddress: '新址A' }, ACTOR);
    expect(service.countWorkloadByMonth()).toHaveLength(0); // 草稿不计

    service.submit(draft.id, ACTOR);
    const workload = service.countWorkloadByMonth();
    expect(workload).toEqual([{ month: '2026-08', count: 1 }]);
  });

  it('状态线性流转不支持退回或取消', () => {
    const { service } = setup();
    const request = service.createRequest({ customerName: '客户A', newSiteAddress: '新址A' }, ACTOR);
    service.submit(request.id, ACTOR);

    // 已提交不可再次提交（不可退回待提交）
    expect(() => service.submit(request.id, ACTOR)).toThrow(/不可退回|已提交/);
    // 未提交不可直接完成（不可跳过处理中）
    const draft = service.createRequest({ customerName: '客户B', newSiteAddress: '新址B' }, ACTOR);
    expect(() => service.complete(draft.id, 'ACC-X', ACTOR)).toThrow(/线性流转/);
    // 不提供取消或退回操作
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of ['cancelRequest', 'revertRequest']) {
      expect(name in proto).toBe(false);
    }
  });

  it('后续状态更新不重复计数', () => {
    const { service } = setup();
    const request = service.createRequest({ customerName: '客户A', newSiteAddress: '新址A' }, ACTOR);
    service.submit(request.id, ACTOR);
    service.complete(request.id, 'ACC-300', ACTOR);
    expect(service.countWorkloadByMonth()).toEqual([{ month: '2026-08', count: 1 }]);
  });
});

describe('目的地址变化重新申请（4.2）', () => {
  it('地址变化新建申请：原记录保持不变，原申请保留，新申请按首次提交计一次', () => {
    const { shipTos, requests, service } = setup();
    const r1 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
    service.submit(r1.id, ACTOR);
    service.complete(r1.id, 'ACC-400', ACTOR);
    const originalShipTo = shipTos.findByAccountId('ACC-400')!;

    // 地址变化：重新申请新 Ship-to，不更新原记录
    const r2 = service.createRequest({ customerName: '华东医药', newSiteAddress: '新址C' }, ACTOR);
    service.submit(r2.id, ACTOR);
    service.complete(r2.id, 'ACC-401', ACTOR);

    expect(shipTos.findByAccountId('ACC-400')!.newSiteAddress).toBe('新址A');
    expect(originalShipTo.id).toBe(shipTos.findByAccountId('ACC-400')!.id);
    expect(requests.findById(r1.id)!.status).toBe('completed'); // 原申请保留
    const workload = service.countWorkloadByMonth();
    expect(workload).toEqual([{ month: '2026-08', count: 2 }]);
  });
});

describe('批次与项目仅汇总展示所涉 Ship-to（4.2）', () => {
  function readerWithInstruments() {
    const reader = new InMemoryShipToAddressReader([
      { id: 'i1', batchId: 'b1', projectId: 'p1', destinationShipToId: 's1' },
      { id: 'i2', batchId: 'b1', projectId: 'p1', destinationShipToId: 's2' },
      { id: 'i3', batchId: 'b2', projectId: 'p1', destinationShipToId: 's1' },
    ]);
    return reader;
  }

  it('批次仅汇总展示所涉 Ship-to，不为批次维护独立唯一地址', () => {
    const shipTos = new InMemoryShipToRepository();
    shipTos.save({ id: 's1', accountId: 'ACC-A', customerName: '客户A', newSiteAddress: '新址A', createdAt: 't' });
    shipTos.save({ id: 's2', accountId: 'ACC-B', customerName: '客户A', newSiteAddress: '新址B', createdAt: 't' });
    const service = new ShipToService(
      shipTos,
      new InMemoryShipToRequestRepository(),
      readerWithInstruments(),
      CLOCK,
    );
    const forBatch = service.listShipTosForBatch('b1');
    expect(forBatch.map((s) => s.accountId).sort()).toEqual(['ACC-A', 'ACC-B']);
    // 不维护批次级独立唯一地址（只汇总展示，无地址写入）
    expect(shipTos.all).toHaveLength(2);
  });

  it('项目仅汇总展示所涉 Ship-to，不为项目维护独立唯一地址', () => {
    const shipTos = new InMemoryShipToRepository();
    shipTos.save({ id: 's1', accountId: 'ACC-A', customerName: '客户A', newSiteAddress: '新址A', createdAt: 't' });
    shipTos.save({ id: 's2', accountId: 'ACC-B', customerName: '客户A', newSiteAddress: '新址B', createdAt: 't' });
    const service = new ShipToService(
      shipTos,
      new InMemoryShipToRequestRepository(),
      readerWithInstruments(),
      CLOCK,
    );
    const forProject = service.listShipTosForProject('p1');
    expect(forProject.map((s) => s.accountId).sort()).toEqual(['ACC-A', 'ACC-B']);
  });
});

describe('申请未完成不阻塞项目（4.2）', () => {
  it('未完成申请不影响项目流转，且不自动创建项目提醒', () => {
    const { projects, service, projectService } = setup();
    // 存在未完成的 Ship-to 申请
    service.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);

    // 项目可正常流转（进单→执行→验收），不受未完成申请阻塞
    const projectId = projectService.createPendingProject().id;
    projectService.adjustStatus(projectId, 'executing');
    projectService.adjustStatus(projectId, 'pending_acceptance');
    expect(projects.findById(projectId)!.status).toBe('pending_acceptance');

    // 模块不拥有项目提醒写入能力（不自动创建"Ship-to 申请未完成"提醒）
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    expect('createReminder' in proto).toBe(false);
  });
});
