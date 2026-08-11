import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
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

function wizard(overrides: Partial<ProjectWizardPayload> & Record<string, unknown> = {}): ProjectWizardPayload {
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
  } as ProjectWizardPayload;
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
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ intent: 'pre_entry_execution', customerName: '先执行带合同金额', managerApproved: true, contractAmount: '10000' }) }),
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
    // 0810：批复原因被 managerApproved 替代、不再收集 → 有值即稳定拒绝（绝不静默忽略）。
    expectRejected(
      () => facade.v2Mutate({ op: 'create_project', payload: wizard({ intent: 'pre_entry_execution', customerName: '废弃字段客户3', approvalReason: '经理批复' }) }),
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

  it('旧址/新址建档留空后可补录：不改变状态，关闭重开后保留', async () => {
    const dir = makeTempDir('project-addresses-reopen-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade1 = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade1.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '后补地址客户',
        ecc: 'ECC-ADDRESS-001',
        contractAmount: '1000',
        oldSiteAddress: undefined,
        newSiteAddress: undefined,
        instrumentCount: null,
      }),
    });
    const projectId = projectIdOf(created);
    const before = facade1.v2ProjectDetail(projectId);
    expect(before.detail).toMatchObject({ oldSiteAddress: null, newSiteAddress: null });
    expect(before.project!.status).toBe('pending_execution');

    facade1.v2Mutate({
      op: 'update_project',
      payload: { projectId, oldSiteAddress: '补录旧址', newSiteAddress: '补录新址' },
    });
    expect(facade1.v2ProjectDetail(projectId)).toMatchObject({
      project: { status: 'pending_execution' },
      detail: { oldSiteAddress: '补录旧址', newSiteAddress: '补录新址' },
    });
    closeDatabase(db);

    const reopened = bootstrapDatabase({ dataDir: dir });
    const facade2 = new WorkbenchFacade(reopened.db, () => ({ accountId: account.id, username: account.username }));
    expect(facade2.v2ProjectDetail(projectId)).toMatchObject({
      project: { status: 'pending_execution' },
      detail: { oldSiteAddress: '补录旧址', newSiteAddress: '补录新址' },
    });
    closeDatabase(reopened.db);
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

  it('pre_entry_execution 不再要求批复原因：managerApproved 可空、以 boolean 事实为准', async () => {
    const { facade } = await makeFacade();
    // 0810：未进单先执行以「是否批复」boolean 事实为准，不再收集批复原因/缺失资料；
    // 未提供 managerApproved 时标签仍生效（boolean 事实为「未填写」）。
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', customerName: '无批复事实客户', region: 'North' }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.project!.status).toBe('pending_entry');
    expect(detail.project!.preEntryExecution).toBe(true);
    expect(detail.project!.formallyEntered).toBe(false);
    expect(detail.detail!.managerApproved).toBeNull();
    expect(facade.v2Overview().metrics.totalProjects).toBe(1);
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

  it('无 ECC + pre_entry_execution + managerApproved=true：pending_entry、preEntryExecution=true、formallyEntered=false', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '未进单先执行客户',
        region: 'South',
        managerApproved: true,
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('pending_entry');
    expect(detail.preEntryExecution).toBe(true);
    expect(detail.formallyEntered).toBe(false);
    expect(detail.entryAt).toBeNull();
  });

  it('建档新字段持久化与回显：项目备注/暂存地址/是否暂存/是否批复 + 计划装机日期（plannedInstallAt）', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '新字段客户',
        region: 'West',
        projectNote: '  客户要求周末作业  ',
        temporaryStorageAddress: '临时仓 3 号',
        isTemporaryStorage: true,
        managerApproved: true,
        plannedInstallAt: '2026-09-01',
      }),
    });
    const projectId = projectIdOf(created);
    // detail DTO 回显最新值（项目备注 trim 后保存）。
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.projectNote).toBe('客户要求周末作业');
    expect(detail.temporaryStorageAddress).toBe('临时仓 3 号');
    expect(detail.isTemporaryStorage).toBe(true);
    expect(detail.managerApproved).toBe(true);
    // 「计划装机日期」公开字段与兼容 alias 同值。
    expect(detail.plannedInstallAt).toBe('2026-09-01');
    expect(detail.plannedInstallDoneAt).toBe('2026-09-01');
    // 物理列复用既有 planned_install_done_at，未新增 schema 列。
    const row = db
      .prepare(
        `SELECT project_note, temporary_storage_address, is_temporary_storage, manager_approved,
                planned_install_done_at FROM projects WHERE id = ?`,
      )
      .get(projectId) as Record<string, unknown>;
    expect(row.project_note).toBe('客户要求周末作业');
    expect(row.temporary_storage_address).toBe('临时仓 3 号');
    expect(row.is_temporary_storage).toBe(1);
    expect(row.manager_approved).toBe(1);
    expect(row.planned_install_done_at).toBe('2026-09-01');
  });

  it('v15 新字段建档后更新并关闭重开：region 受控枚举及 null/false 语义均持久化', async () => {
    const dir = makeTempDir('v15-fields-reopen-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade1 = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade1.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'draft',
        customerName: 'v15 重开字段客户',
        instrumentCount: null,
        region: 'East',
        projectNote: '建档备注',
        temporaryStorageAddress: '建档暂存地址',
        isTemporaryStorage: true,
        managerApproved: true,
        plannedInstallAt: '2026-09-01',
      }),
    });
    const projectId = projectIdOf(created);
    facade1.v2Mutate({
      op: 'update_project',
      payload: {
        projectId,
        region: 'South',
        projectNote: null,
        temporaryStorageAddress: '更新暂存地址',
        isTemporaryStorage: false,
        managerApproved: false,
        plannedInstallAt: '2026-10-02',
      },
    });
    closeDatabase(db);

    const reopened = bootstrapDatabase({ dataDir: dir });
    const facade2 = new WorkbenchFacade(reopened.db, () => ({ accountId: account.id, username: account.username }));
    const detail = facade2.v2ProjectDetail(projectId);
    expect(detail.project!.region).toBe('South');
    expect(detail.detail).toMatchObject({
      projectNote: null,
      temporaryStorageAddress: '更新暂存地址',
      isTemporaryStorage: false,
      managerApproved: false,
      plannedInstallAt: '2026-10-02',
    });
    closeDatabase(reopened.db);
  });

  it('项目备注/暂存地址留空保存：可空字段不因缺失拒绝建档', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '留空客户', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.projectNote).toBeNull();
    expect(detail.temporaryStorageAddress).toBeNull();
    expect(detail.isTemporaryStorage).toBeNull();
    expect(detail.managerApproved).toBeNull();
  });

  it('暂存地址/是否暂存为手工维护执行事实：建档后修改不影响主状态', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '暂存维护客户', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    const before = facade.v2ProjectDetail(projectId).project!.status;
    facade.v2Mutate({
      op: 'update_project',
      payload: { projectId, temporaryStorageAddress: '新临时仓', isTemporaryStorage: false },
    });
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.detail!.temporaryStorageAddress).toBe('新临时仓');
    expect(detail.detail!.isTemporaryStorage).toBe(false);
    expect(detail.project!.status).toBe(before); // 主状态不因暂存信息改变
  });

  it('暂定数量经 update_project 查看/留空/补录/调整回显最新值，不建仪器、不改状态', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '暂定数量客户', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    // 查看：初始为空（留空）。
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBeNull();
    // 补录 3。
    facade.v2Mutate({ op: 'update_project', payload: { projectId, temporaryInstrumentCount: 3 } });
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBe(3);
    // 调整 5。
    facade.v2Mutate({ op: 'update_project', payload: { projectId, temporaryInstrumentCount: 5 } });
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBe(5);
    // 留空（null 清除）。
    facade.v2Mutate({ op: 'update_project', payload: { projectId, temporaryInstrumentCount: null } });
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBeNull();
    // 不创建/删除/修改任何仪器记录，不触发主状态流转。
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
    const project = facade.v2ProjectDetail(projectId).project!;
    expect(project.status).toBe('pending_entry');
    expect(project.formallyEntered).toBe(false);
  });

  it('暂定数量非法值沿用既有校验（负数/非整数拒绝，INVALID_TEMP_COUNT）', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '非法数量客户2', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    for (const bad of [-1, 1.5]) {
      try {
        facade.v2Mutate({ op: 'update_project', payload: { projectId, temporaryInstrumentCount: bad } });
      } catch (err) {
        expect((err as { code?: string }).code).toBe('INVALID_TEMP_COUNT');
        continue;
      }
      expect.unreachable('应当抛出拒绝错误');
    }
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBeNull();
  });

  it('legacy 非枚举区域原文保留并显式标记 regionNeedsAdjustment（不猜测、不置空）', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: 'legacy区域客户', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    // 模拟升级前已存在的 legacy 非枚举区域文本（直接落库，不经写边界）。
    db.prepare('UPDATE projects SET region = ? WHERE id = ?').run('华东', projectId);
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.project!.region).toBe('华东'); // 原文保留
    expect(detail.project!.regionNeedsAdjustment).toBe(true); // 显式「待调整」标记
    // 五个枚举区域不标记。
    facade.v2Mutate({ op: 'update_project', payload: { projectId, region: 'North' } });
    const fixed = facade.v2ProjectDetail(projectId).project!;
    expect(fixed.region).toBe('North');
    expect(fixed.regionNeedsAdjustment).toBe(false);
  });

  it('项目备注建档后补充/修改不影响主状态', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'formal', customerName: '备注维护客户', ecc: 'ECC-NOTE-001', contractAmount: '1000' }),
    });
    const projectId = projectIdOf(created);
    const statusBefore = facade.v2ProjectDetail(projectId).project!.status;
    facade.v2Mutate({ op: 'update_project', payload: { projectId, projectNote: '补充备注' } });
    const after = facade.v2ProjectDetail(projectId);
    expect(after.detail!.projectNote).toBe('补充备注');
    expect(after.project!.status).toBe(statusBefore);
    // 清空备注。
    facade.v2Mutate({ op: 'update_project', payload: { projectId, projectNote: null } });
    expect(facade.v2ProjectDetail(projectId).detail!.projectNote).toBeNull();
  });
});

describe('项目暂定仪器范围（v16）', () => {
  it('建档持久化与回显：暂定仪器名称/型号/是否 UPS 建档时保存，trim 后回显，不建仪器、不触发状态', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'draft',
        customerName: '暂定仪器范围客户',
        instrumentCount: null,
        temporaryInstrumentName: '  生化分析仪  ',
        temporaryInstrumentModel: ' BS-200 ',
        temporaryHasUps: true,
      }),
    });
    const projectId = projectIdOf(created);
    // detail DTO 回显最新值（trim 后保存）。
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentName).toBe('生化分析仪');
    expect(detail.temporaryInstrumentModel).toBe('BS-200');
    expect(detail.temporaryHasUps).toBe(true);
    // 物理列已持久化。
    const row = db
      .prepare(
        `SELECT temporary_instrument_name, temporary_instrument_model, temporary_has_ups FROM projects WHERE id = ?`,
      )
      .get(projectId) as Record<string, unknown>;
    expect(row.temporary_instrument_name).toBe('生化分析仪');
    expect(row.temporary_instrument_model).toBe('BS-200');
    expect(row.temporary_has_ups).toBe(1);
    // 不创建任何仪器记录，不触发主状态流转。
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_entry');
    expect(facade.v2ProjectDetail(projectId).project!.formallyEntered).toBe(false);
  });

  it('编辑资料回显：update_project 填写/修改/清空范围字段，不建仪器、不改状态', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '暂定范围编辑客户', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    // 初始未填写（三态 null）。
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentName).toBeNull();
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryHasUps).toBeNull();
    // 填写。
    facade.v2Mutate({
      op: 'update_project',
      payload: {
        projectId,
        temporaryInstrumentName: '质谱仪',
        temporaryInstrumentModel: 'Q-TOF',
        temporaryHasUps: true,
      },
    });
    let detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentName).toBe('质谱仪');
    expect(detail.temporaryInstrumentModel).toBe('Q-TOF');
    expect(detail.temporaryHasUps).toBe(true);
    // 显式「否」。
    facade.v2Mutate({ op: 'update_project', payload: { projectId, temporaryHasUps: false } });
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryHasUps).toBe(false);
    // 清空（null / 空串统一 null）。
    facade.v2Mutate({
      op: 'update_project',
      payload: { projectId, temporaryInstrumentName: null, temporaryInstrumentModel: '   ', temporaryHasUps: null },
    });
    detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentName).toBeNull();
    expect(detail.temporaryInstrumentModel).toBeNull();
    expect(detail.temporaryHasUps).toBeNull();
    // 不创建/删除/修改任何仪器记录，不触发主状态流转。
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
    const project = facade.v2ProjectDetail(projectId).project!;
    expect(project.status).toBe('pending_entry');
    expect(project.formallyEntered).toBe(false);
  });

  it('暂定数量与暂定范围独立：update 范围不改变数量，补录数量不改变范围', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '范围数量独立客户', instrumentCount: null }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({
      op: 'update_project',
      payload: { projectId, temporaryInstrumentName: '离心机', temporaryHasUps: false, temporaryInstrumentCount: 3 },
    });
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBe(3);
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentName).toBe('离心机');
    facade.v2Mutate({ op: 'update_project', payload: { projectId, temporaryInstrumentCount: 5 } });
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentCount).toBe(5);
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryInstrumentName).toBe('离心机'); // 范围不受影响
    expect(facade.v2ProjectDetail(projectId).detail!.temporaryHasUps).toBe(false);
  });

  it('关闭重开持久化：建档/编辑的暂定仪器范围字段重开后保留', async () => {
    const dir = makeTempDir('v16-reopen-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade1 = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade1.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'draft',
        customerName: '重开持久化客户',
        instrumentCount: null,
        temporaryInstrumentName: '重开仪器',
        temporaryInstrumentModel: 'RE-1',
        temporaryHasUps: true,
      }),
    });
    const projectId = projectIdOf(created);
    // 编辑后关闭。
    facade1.v2Mutate({
      op: 'update_project',
      payload: { projectId, temporaryInstrumentName: '重开仪器改', temporaryHasUps: false },
    });
    closeDatabase(db);

    // 重开后经新 facade 回读：字段保留（建档与编辑的值均持久化）。
    const reopened = bootstrapDatabase({ dataDir: dir });
    const facade2 = new WorkbenchFacade(reopened.db, () => ({ accountId: account.id, username: account.username }));
    const detail = facade2.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentName).toBe('重开仪器改');
    expect(detail.temporaryInstrumentModel).toBe('RE-1');
    expect(detail.temporaryHasUps).toBe(false);
    closeDatabase(reopened.db);
  });
});
