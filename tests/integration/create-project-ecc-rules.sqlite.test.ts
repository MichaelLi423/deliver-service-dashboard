import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import type { ProjectWizardPayload, WorkbenchV2MutationResult } from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 创建项目回归：ECC 是是否正式进单的唯一依据（后端/领域状态规则）。
 *
 * - 有非空 ECC：创建结果必须正式进单（entryAt 有值、formallyEntered=true），
 *   并把主状态推进为 pending_execution，不得仍为 pending_entry；与 intent 无关，
 *   pre_entry_execution/draft 兼容入口携带 ECC 同样按 ECC 规则正式进单且不保留
 *   未进单先执行标签；
 * - 无 ECC：普通 draft 创建被安全明确拒绝（不静默创建待进单项目）；只允许
 *   intent=pre_entry_execution（经理批复原因必填，沿用既有校验），结果
 *   status=pending_entry、preEntryExecution=true、formallyEntered=false；
 * - intent=formal 无 ECC 继续报 ECC_REQUIRED。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function projectIdOf(result: WorkbenchV2MutationResult): string {
  return result.changed!.projectId!;
}

function wizard(overrides: Partial<ProjectWizardPayload> = {}): ProjectWizardPayload {
  return {
    intent: 'formal',
    customerName: '客户',
    region: '华东',
    contractStartDate: '2026-08-01',
    contractEndDate: '2027-07-31',
    oldSiteAddress: '旧址',
    newSiteAddress: '新址',
    instrumentName: '仪器',
    ups: false,
    siteConfirmed: false,
    ...overrides,
  };
}

async function makeFacade(): Promise<{ facade: WorkbenchFacade; db: import('node:sqlite').DatabaseSync }> {
  const dir = makeTempDir('create-project-ecc-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
  return { facade, db };
}

describe('创建项目：ECC 是是否正式进单的唯一依据', () => {
  it('draft 兼容入口携带非空 ECC：必须正式进单并推进主状态为待执行（不得仍为待进单）', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'draft',
        customerName: '草稿带 ECC 客户',
        ecc: 'ECC-DRAFT-001',
        contractAmount: '10000',
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.ecc).toBe('ECC-DRAFT-001');
    expect(detail.formallyEntered).toBe(true);
    expect(detail.entryAt).toBeTruthy();
    expect(detail.status).toBe('pending_execution');
    expect(detail.preEntryExecution).toBe(false);
  });

  it('pre_entry_execution 携带 ECC：按 ECC 规则正式进单且不保留 pre-entry 标签', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '先执行带 ECC 客户',
        ecc: 'ECC-PRE-001',
        contractAmount: '10000',
        approvalReason: '已取得 ECC，不应保留未进单先执行标签',
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.ecc).toBe('ECC-PRE-001');
    expect(detail.formallyEntered).toBe(true);
    expect(detail.entryAt).toBeTruthy();
    expect(detail.status).toBe('pending_execution');
    expect(detail.preEntryExecution).toBe(false);
  });

  it('无 ECC 的普通 draft 创建被安全明确拒绝，不静默创建待进单项目', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({
        op: 'create_project',
        payload: wizard({ intent: 'draft', customerName: '纯草稿客户', region: '华北' }),
      }),
    ).toThrow(/草稿创建已停用|未进单先执行/);
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('无 ECC 的 pre_entry_execution 缺少经理批复原因被拒（沿用既有校验）', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({
        op: 'create_project',
        payload: wizard({ intent: 'pre_entry_execution', customerName: '缺批复客户', region: '华北' }),
      }),
    ).toThrow(/经理批复原因/);
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('无 ECC + pre_entry_execution + 经理批复原因：pending_entry、preEntryExecution=true、formallyEntered=false', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '未进单先执行客户',
        region: '华南',
        approvalReason: '客户进度紧急，经理已批复优先执行',
        missingItems: '合同尚未签署',
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('pending_entry');
    expect(detail.preEntryExecution).toBe(true);
    expect(detail.formallyEntered).toBe(false);
    expect(detail.entryAt).toBeNull();
  });

  it('intent=formal 无 ECC 继续报 ECC_REQUIRED', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({
        op: 'create_project',
        payload: wizard({ customerName: '缺 ECC 客户', region: '华东' }),
      }),
    ).toThrow(/缺少 ECC/);
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('intent=formal + 非空 ECC：正式进单并把主状态推进为待执行', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '正式进单客户',
        ecc: 'ECC-FORMAL-001',
        contractAmount: '10000',
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.ecc).toBe('ECC-FORMAL-001');
    expect(detail.formallyEntered).toBe(true);
    expect(detail.entryAt).toBeTruthy();
    expect(detail.status).toBe('pending_execution');
    expect(detail.preEntryExecution).toBe(false);
  });
});
