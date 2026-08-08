import { describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { isFormallyEntered } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { UniquenessError, ValidationError } from '../../src/domain/core/errors';
import { Money } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';

/**
 * tasks 2.1 正式进单 + 合同可空、编号与 ECC（relocation-project-lifecycle spec）。
 */

function setup(iso = '2026-08-07T10:00:00+08:00') {
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const service = new ProjectService(projects, contracts, undefined, new FixedClock(iso));
  return { projects, contracts, service };
}

/** 构造一个满足正式进单前置条件的项目（合同已补建、金额已录、范围明确、客户已关联）。 */
function prepareEnterableProject(
  service: ProjectService,
  amount = '10000',
  customerId = 'customer-1',
): { projectId: string; contractId: string } {
  const project = service.createPendingProject();
  const contract = service.attachContract(project.id);
  new ContractService().setUsdTaxAmount(contract, Money.parse(amount));
  service.linkCustomer(project.id, customerId);
  service.confirmScope(project.id);
  return { projectId: project.id, contractId: contract.id };
}

describe('合同可空、编号与 ECC（2.1 / TBD-01）', () => {
  it('待进单分配稳定内部编号且合同可空（不强制合同草稿）', () => {
    const { service } = setup();
    const project = service.createPendingProject();
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.tempNo).toMatch(/^TP-\d{8}-/);
    expect(project.contractId).toBeNull();
    expect(project.entryAt).toBeNull();
  });

  it('正式进单前必须补齐合同：未关联合同拒绝进单', () => {
    const { service } = setup();
    const project = service.createPendingProject();
    service.linkCustomer(project.id, 'customer-1');
    service.confirmScope(project.id);
    expect(() => service.formalEntry(project.id, { ecc: 'ECC-001' })).toThrow(
      /正式进单前必须补齐合同/,
    );
  });

  it('正式进单补充唯一 ECC，原内部 ID 与临时编号继续保留', () => {
    const { service } = setup();
    const { projectId } = prepareEnterableProject(service);
    const entered = service.formalEntry(projectId, { ecc: ' ECC-001 ' });
    expect(entered.id).toBe(projectId);
    expect(entered.tempNo).toMatch(/^TP-\d{8}-/);
    expect(isFormallyEntered(entered)).toBe(true);
  });

  it('缺少 ECC 拒绝正式进单', () => {
    const { service } = setup();
    const { projectId } = prepareEnterableProject(service);
    expect(() => service.formalEntry(projectId, { ecc: '   ' })).toThrow(/缺少 ECC/);
  });

  it('ECC 全局唯一：两个项目使用相同 ECC 拒绝', () => {
    const { service } = setup();
    const a = prepareEnterableProject(service);
    service.formalEntry(a.projectId, { ecc: 'ECC-001' });
    const b = prepareEnterableProject(service);
    expect(() => service.formalEntry(b.projectId, { ecc: 'ECC-001' })).toThrow(UniquenessError);
  });

  it('进单后 ECC 纠错：唯一性校验通过后保存新值并自动记录最后修改时间', () => {
    const { contracts, service } = setup('2026-08-07T10:00:00+08:00');
    const { projectId, contractId } = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });

    const corrected = service.updateEcc(projectId, 'ECC-002');
    expect(corrected.id).toBe(contractId);
    expect(corrected.ecc).toBe('ECC-002');
    expect(corrected.eccLastModifiedAt).toBe('2026-08-07T10:00:00+08:00');
    expect(contracts.findByProjectId(projectId)?.ecc).toBe('ECC-002');
  });

  it('进单后 ECC 纠错仍受全局唯一约束', () => {
    const { service } = setup();
    const a = prepareEnterableProject(service);
    service.formalEntry(a.projectId, { ecc: 'ECC-A' });
    const b = prepareEnterableProject(service);
    service.formalEntry(b.projectId, { ecc: 'ECC-B' });
    expect(() => service.updateEcc(a.projectId, 'ECC-B')).toThrow(UniquenessError);
  });
});

describe('正式进单（2.1）', () => {
  it('填写进单时间保持填写值，不以当前时间覆盖', () => {
    const { service } = setup('2026-08-07T10:00:00+08:00');
    const { projectId } = prepareEnterableProject(service);
    const entered = service.formalEntry(projectId, {
      ecc: 'ECC-001',
      entryAt: '2026-06-01T09:00:00+08:00',
    });
    expect(entered.entryAt).toBe('2026-06-01T09:00:00+08:00');
  });

  it('进单时间未填写默认取当前时间，并允许进单后补录或修正', () => {
    const { service } = setup('2026-08-07T10:00:00+08:00');
    const { projectId } = prepareEnterableProject(service);
    const entered = service.formalEntry(projectId, { ecc: 'ECC-001' });
    expect(entered.entryAt).toBe('2026-08-07T10:00:00+08:00');

    const corrected = service.setEntryAt(projectId, '2026-07-01T08:00:00+08:00');
    expect(corrected.entryAt).toBe('2026-07-01T08:00:00+08:00');
  });

  it('待进单阶段进单时间可空', () => {
    const { service } = setup();
    const project = service.createPendingProject();
    expect(project.entryAt).toBeNull();
    expect(isFormallyEntered(project)).toBe(false);
  });

  it('核心信息缺失拒绝进单并就地提示缺失项', () => {
    const { service } = setup();

    // 缺客户单位
    const noCustomer = service.createPendingProject();
    service.attachContract(noCustomer.id);
    service.confirmScope(noCustomer.id);
    expect(() => service.formalEntry(noCustomer.id, { ecc: 'ECC-001' })).toThrow(/客户单位/);

    // 缺搬迁范围
    const noScope = service.createPendingProject();
    service.attachContract(noScope.id);
    service.linkCustomer(noScope.id, 'customer-1');
    expect(() => service.formalEntry(noScope.id, { ecc: 'ECC-001' })).toThrow(/搬迁范围/);
  });

  it('缺合同拒绝进单并提示先补齐合同', () => {
    const { service } = setup();
    const project = service.createPendingProject();
    service.linkCustomer(project.id, 'customer-1');
    service.confirmScope(project.id);
    expect(() => service.formalEntry(project.id, { ecc: 'ECC-001' })).toThrow(/补齐合同/);
  });

  it('正式进单锁定进单金额快照（后续合同金额覆盖不改写快照，见 5.2）', () => {
    const { contracts, service } = setup();
    const { projectId, contractId } = prepareEnterableProject(service, '10000');
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    expect(contracts.findByProjectId(projectId)?.entryAmountSnapshotCents).toBe(1000000n);
    void contractId;

    // 后续覆盖合同金额不改写快照（快照仅用于进单金额统计）
    const contract = contracts.findByProjectId(projectId)!;
    new ContractService().setUsdTaxAmount(contract, Money.parse('12000'));
    contracts.save(contract);
    expect(contract.entryAmountSnapshotCents).toBe(1000000n);
  });

  it('最终可确认金额默认取合同 USD 含税金额', () => {
    const { contracts, service } = setup();
    const { projectId } = prepareEnterableProject(service, '10000');
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    expect(contracts.findByProjectId(projectId)?.finalConfirmableAmountCents).toBe(1000000n);
  });

  it('合同金额为 0 时正式进单最终可确认金额必须另行录入大于 0 的值（TBD-11）', () => {
    const { service } = setup();
    const project = service.createPendingProject();
    const contract = service.attachContract(project.id);
    new ContractService().setUsdTaxAmount(contract, Money.parse('0'));
    service.linkCustomer(project.id, 'customer-1');
    service.confirmScope(project.id);

    // 未另行录入 → 拒绝且不能默认为 0
    expect(() => service.formalEntry(project.id, { ecc: 'ECC-001' })).toThrow(
      /最终可确认金额必须另行录入大于 0/,
    );

    // 另行录入 > 0 → 允许
    const entered = service.formalEntry(project.id, {
      ecc: 'ECC-001',
      finalConfirmableAmountCents: 500000n,
    });
    expect(entered.status).toBe('pending_entry');
  });

  it('最终可确认金额有值时必须大于 0，负数或 0 拒绝', () => {
    const { service } = setup();
    const { projectId } = prepareEnterableProject(service, '0');
    expect(() =>
      service.formalEntry(projectId, { ecc: 'ECC-001', finalConfirmableAmountCents: 0n }),
    ).toThrow(ValidationError);
    expect(() =>
      service.formalEntry(projectId, { ecc: 'ECC-001', finalConfirmableAmountCents: -1n }),
    ).toThrow(ValidationError);
  });
});
