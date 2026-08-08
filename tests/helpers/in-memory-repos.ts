import type {
  Contract,
  ContractRepository,
  Project,
  ProjectRepository,
} from '../../src/domain/capabilities/relocation-project-lifecycle';

/**
 * 内存仓储（领域测试；tasks 1.4/2.9）。
 * SQLite 实现见 src/domain/capabilities/local-data-persistence/repositories.ts。
 */

export class InMemoryProjectRepository implements ProjectRepository {
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

  get all(): Project[] {
    return [...this.store.values()];
  }
}

export class InMemoryContractRepository implements ContractRepository {
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

  get all(): Contract[] {
    return [...this.store.values()];
  }
}
