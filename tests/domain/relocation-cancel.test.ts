import { describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { FixedClock } from '../../src/domain/core/time';
import { Money } from '../../src/domain/core/money';
import { ValidationError } from '../../src/domain/core/errors';
import { expectRejected } from '../helpers/state-assert';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';

/**
 * tasks 2.5 取消（relocation-project-lifecycle spec / TBD-10）。
 */

function setup(iso = '2026-08-07T10:00:00+08:00') {
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const service = new ProjectService(projects, contracts, undefined, new FixedClock(iso));
  return { projects, contracts, service };
}

function prepareEnterableProject(service: ProjectService): string {
  const project = service.createPendingProject();
  const contract = service.attachContract(project.id);
  new ContractService().setUsdTaxAmount(contract, Money.parse('10000'));
  service.linkCustomer(project.id, 'customer-1');
  service.confirmScope(project.id);
  return project.id;
}

describe('取消（2.5 / TBD-10）', () => {
  it('任一未取消主状态且无掉票历史可取消，并记录取消时间与原因', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    service.adjustStatus(projectId, 'executing');

    const cancelled = service.cancelProject(projectId, {
      time: '2026-08-07',
      reason: '客户取消搬迁计划',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBe('2026-08-07');
    expect(cancelled.cancelReason).toBe('客户取消搬迁计划');
    expect(projects.findById(projectId)!.status).toBe('cancelled');
  });

  it('取消必须记录取消时间与原因：缺少原因拒绝', () => {
    const { service } = setup();
    const projectId = service.createPendingProject().id;
    expect(() =>
      service.cancelProject(projectId, {
        time: '2026-08-07',
        reason: '   ',
      }),
    ).toThrow(ValidationError);
  });

  it('存在任何掉票历史（含已撤销掉票）的项目禁止取消', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    service.adjustStatus(projectId, 'executing');

    // 有掉票历史（含已撤销）→ 取消被拒
    const rejected = service.adjustStatus(projectId, 'cancelled', {
      hasAnyInvoiceHistory: true,
    });
    expectRejected(rejected, '掉票历史');
    expect(() =>
      service.cancelProject(
        projectId,
        { time: '2026-08-07', reason: '客户取消搬迁计划' },
        { hasAnyInvoiceHistory: true },
      ),
    ).toThrow(/掉票历史/);
    expect(projects.findById(projectId)!.status).not.toBe('cancelled');
  });

  it('已取消项目不可恢复，继续工作需重新新增项目（TBD-10）', () => {
    const { service } = setup();
    const projectId = service.createPendingProject().id;
    service.cancelProject(projectId, { time: '2026-08-07', reason: '计划变更' });

    // 已取消不可恢复：任何状态调整被拒
    const reopen = service.adjustStatus(projectId, 'pending_execution');
    expectRejected(reopen, '不可恢复');

    // 继续工作需重新新增项目
    const fresh = service.createPendingProject();
    expect(fresh.id).not.toBe(projectId);
    expect(fresh.status).toBe('pending_entry');
    expect(fresh.contractId).toBeNull();
  });

  it('取消保留已发生的上门活动、物流与费用记录（取消只改变项目状态）', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    service.adjustStatus(projectId, 'executing');

    // 领域取消操作只写项目聚合；上门活动/物流/费用记录属于独立聚合，不受影响。
    // （SQLite 集成测试验证真实记录在取消后仍存在。）
    service.cancelProject(projectId, { time: '2026-08-07', reason: '计划变更' });
    const project = projects.findById(projectId)!;
    expect(project.status).toBe('cancelled');
    expect(project.cancelledAt).not.toBeNull();
    expect(project.cancelReason).not.toBeNull();
  });
});
