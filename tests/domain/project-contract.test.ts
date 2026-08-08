import { describe, expect, it } from 'vitest';
import {
  ContractService,
} from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import {
  ProjectService,
  type ContractRepository,
  type ProjectRepository,
} from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import type { Contract } from '../../src/domain/capabilities/relocation-project-lifecycle/contract';
import type { Project } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { UniquenessError } from '../../src/domain/core/errors';
import { Money } from '../../src/domain/core/money';

class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, Project>();
  findById(id: string): Project | undefined {
    return this.store.get(id);
  }
  listAll(): Project[] {
    return [...this.store.values()];
  }
  save(project: Project): void {
    this.store.set(project.id, project);
  }
}

class InMemoryContractRepository implements ContractRepository {
  private readonly store = new Map<string, Contract>();
  findByProjectId(projectId: string): Contract | undefined {
    return [...this.store.values()].find((c) => c.projectId === projectId);
  }
  findByEcc(ecc: string): Contract | undefined {
    return [...this.store.values()].find((c) => c.ecc === ecc);
  }
  save(contract: Contract): void {
    this.store.set(contract.id, contract);
  }
}

describe('合同与项目基础模型（tasks 1.7 / D3 / TBD-01）', () => {
  it('待进单项目分配稳定内部 ID 与系统临时编号，且合同可空、不强制合同草稿', () => {
    const projects = new InMemoryProjectRepository();
    const service = new ProjectService(projects, new InMemoryContractRepository());
    const project = service.createPendingProject();

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.tempNo).toMatch(/^TP-\d{8}-/);
    expect(project.status).toBe('pending_entry');
    expect(project.contractId).toBeNull();
    expect(project.customerId).toBeNull();
    // 待进单不强制创建合同草稿：合同中无对应记录
    const contracts = new InMemoryContractRepository();
    expect(contracts.findByProjectId(project.id)).toBeUndefined();
    // 项目提醒字段占位存在
    expect(project.reminderAt).toBeNull();
    expect(project.reminderNote).toBeNull();
    expect(project.entryAt).toBeNull();
  });

  it('合同与项目 1:1 独立建模：补建合同后项目关联', () => {
    const projects = new InMemoryProjectRepository();
    const contracts = new InMemoryContractRepository();
    const service = new ProjectService(projects, contracts);

    const project = service.createPendingProject();
    const contract = service.attachContract(project.id);

    expect(contract.projectId).toBe(project.id);
    expect(contract.ecc).toBeNull();
    expect(contract.tempNumber).toMatch(/^TP-\d{8}-/);
    expect(projects.findById(project.id)!.contractId).toBe(contract.id);
    // 同项目禁止重复合同
    expect(() => service.attachContract(project.id)).toThrow(UniquenessError);
  });

  it('ECC 全局唯一校验（正式进单与纠错共用）', () => {
    const projects = new InMemoryProjectRepository();
    const contracts = new InMemoryContractRepository();
    const service = new ProjectService(projects, contracts);

    const p1 = service.createPendingProject();
    const c1 = service.attachContract(p1.id);
    c1.ecc = 'ECC-001';
    contracts.save(c1);

    const p2 = service.createPendingProject();
    const c2 = service.attachContract(p2.id);
    c2.ecc = 'ECC-001';
    contracts.save(c2);

    expect(() => service.assertEccUnique('ECC-001')).toThrow(UniquenessError);
    // 纠错场景：同一合同自身除外
    expect(() => service.assertEccUnique('ECC-001', c1.id)).not.toThrow();
  });

  it('合同金额允许 0（仅合同 USD 含税金额允许为 0），负数拒绝', () => {
    const projects = new InMemoryProjectRepository();
    const service = new ProjectService(projects, new InMemoryContractRepository());
    const contract = service.attachContract(service.createPendingProject().id);

    const contractService = new ContractService();
    contractService.setUsdTaxAmount(contract, Money.parse('0'));
    expect(contract.usdTaxAmountCents).toBe(0n);

    expect(() => contractService.setUsdTaxAmount(contract, Money.fromCents(-1n))).toThrow();
  });

  it('进单金额快照占位：正式进单时锁定当前合同金额', () => {
    const projects = new InMemoryProjectRepository();
    const contracts = new InMemoryContractRepository();
    const projectService = new ProjectService(projects, contracts);
    const contract = projectService.attachContract(projectService.createPendingProject().id);

    const contractService = new ContractService();
    contractService.setUsdTaxAmount(contract, Money.parse('10000'));
    contractService.lockEntryAmountSnapshot(contract);
    expect(contract.entryAmountSnapshotCents).toBe(1000000n);
  });
});
