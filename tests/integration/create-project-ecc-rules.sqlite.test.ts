import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import { WIZARD_REJECTION_CODES, type ProjectWizardPayload, type WorkbenchV2MutationResult } from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 创建项目回归：intent 决定是否正式进单（不再由 ECC 推断）。
 *
 * - intent='formal'：正式进单（ECC/合同/客户/进单日期必填，缺任一拒绝）；
 *   旧址/新址/仪器数量可空、有值才确认范围；合同金额为空/0 时 final 保持 null；
 *   进单后基线 pending_execution。
 * - intent='draft'：创建待进单草稿（不补建合同、不设置 ECC、不正式进单），
 *   formallyEntered=false、entryAt=null。
 * - intent='pre_entry_execution'：待进单 + 未进单先执行（经理批复原因必填），
 *   status=pending_entry、preEntryExecution=true、formallyEntered=false。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function projectIdOf(result: WorkbenchV2MutationResult): string {
  return result.changed!.projectId!;
}

/** 断言抛出 DomainError 且 code 为稳定拒绝码。 */
function expectRejected(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  expect.unreachable('应当抛出拒绝错误');
}

function wizard(overrides: Partial<ProjectWizardPayload> = {}): ProjectWizardPayload {
  return {
    intent: 'formal',
    customerName: '客户',
    region: 'East',
    contractStartDate: '2026-08-01',
    contractEndDate: '2027-07-31',
    oldSiteAddress: '旧址',
    newSiteAddress: '新址',
    instrumentCount: 1,
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

describe('创建项目：intent 决定是否正式进单（不再由 ECC 推断）', () => {
  it('intent=draft 无 ECC：创建待进单草稿项目（formallyEntered=false、entryAt=null、不建合同）', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '草稿客户', ecc: undefined, instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.ecc).toBeNull();
    expect(detail.formallyEntered).toBe(false);
    expect(detail.entryAt).toBeNull();
    expect(detail.status).toBe('pending_entry');
    expect(detail.preEntryExecution).toBe(false);
  });

  it('intent=draft 携带 ECC：稳定拒绝（WIZARD_ECC_ONLY_FORMAL，绝不静默丢弃）', async () => {
    const { facade } = await makeFacade();
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ intent: 'draft', customerName: '草稿带 ECC 客户', ecc: 'ECC-DRAFT-001' }) }),
      WIZARD_REJECTION_CODES.ECC_ONLY_FORMAL,
    );
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('非 formal（draft/pre_entry_execution）携带进单日期/合同金额：稳定拒绝', async () => {
    const { facade } = await makeFacade();
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ intent: 'draft', customerName: '草稿带进单日期', entryAt: '2026-08-01' }) }),
      WIZARD_REJECTION_CODES.ENTRY_AT_ONLY_FORMAL,
    );
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ intent: 'pre_entry_execution', customerName: '先执行带合同金额', approvalReason: '经理批复', contractAmount: '10000' }) }),
      WIZARD_REJECTION_CODES.CONTRACT_AMOUNT_ONLY_FORMAL,
    );
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('废弃字段（finalAmount/serviceOrderNo 等）有值：稳定拒绝（WIZARD_DEPRECATED_FIELD，不静默忽略）', async () => {
    const { facade } = await makeFacade();
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '废弃字段客户', ecc: 'ECC-DEP-001', finalAmount: '1000' }) }),
      WIZARD_REJECTION_CODES.DEPRECATED_FIELD,
    );
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '废弃字段客户2', ecc: 'ECC-DEP-002', serviceOrderNo: 'SO-X' }) }),
      WIZARD_REJECTION_CODES.DEPRECATED_FIELD,
    );
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

  it('intent=formal 无 ECC：报 ECC_REQUIRED（合同/客户/ECC/进单日期仍必填）', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({
        op: 'create_project',
        payload: wizard({ customerName: '缺 ECC 客户', region: 'East', ecc: undefined }),
      }),
    ).toThrow(/缺少 ECC/);
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('intent=formal 合同金额为空：contractAmount 保持 null（optional money parser，不虚构 0），final 保持 null', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '零合同客户', ecc: 'ECC-ZERO-001', contractAmount: '', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.formallyEntered).toBe(true);
    expect(detail.status).toBe('pending_execution');
    expect(detail.contractAmount).toBeNull(); // 空串 → 未录入（null），绝不虚构 0
    expect(detail.finalAmount).toBeNull(); // final 保持 null（不再强制另行录入）
  });

  it('intent=formal 旧址/新址/仪器数量可空：有值才确认范围、无值不生成虚拟仪器', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '可空客户',
        ecc: 'ECC-NULL-001',
        contractAmount: '10000',
        oldSiteAddress: undefined,
        newSiteAddress: undefined,
        instrumentCount: undefined,
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.detail?.oldSiteAddress).toBeNull();
    expect(detail.detail?.newSiteAddress).toBeNull();
    expect(detail.detail?.temporaryInstrumentCount).toBeNull();
    // 不生成虚拟仪器
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
    // 已正式进单（正式进单不再要求搬迁范围）
    expect(detail.project!.formallyEntered).toBe(true);
    expect(db.prepare('SELECT scope_confirmed AS s FROM projects WHERE id = ?').get(projectId)).toMatchObject({ s: 0 });
  });

  it('instrumentCount 提供非正整数被拒且不落库', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({
        op: 'create_project',
        payload: wizard({ intent: 'draft', customerName: '非法数量客户', instrumentCount: 0 }),
      }),
    ).toThrow(/大于 0 的整数/);
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('无 ECC 的 pre_entry_execution 缺少经理批复原因被拒（沿用既有校验）', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({
        op: 'create_project',
        payload: wizard({ intent: 'pre_entry_execution', customerName: '缺批复客户', region: 'North' }),
      }),
    ).toThrow(/经理批复原因/);
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('非枚举区域值创建项目被拒（INVALID_PROJECT_REGION，legacy 文本不得再写入）', async () => {
    const { facade } = await makeFacade();
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '非法区域客户', region: '华东' }) }),
      'INVALID_PROJECT_REGION',
    );
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '非法区域客户2', region: 'Northeast' }) }),
      'INVALID_PROJECT_REGION',
    );
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
  });

  it('无 ECC + pre_entry_execution + 经理批复原因：pending_entry、preEntryExecution=true、formallyEntered=false', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '未进单先执行客户',
        region: 'South',
        approvalReason: '客户进度紧急，经理已批复优先执行',
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('pending_entry');
    expect(detail.preEntryExecution).toBe(true);
    expect(detail.formallyEntered).toBe(false);
    expect(detail.entryAt).toBeNull();
  });
});
