import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import {
  DELETE_REJECTION_CODES,
  type ProjectWizardPayload,
  type WorkbenchV2DeleteRequest,
  type WorkbenchV2MutationResult,
} from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 受保护登记记录删除（v2Delete，ora-1 严格守卫）：
 * - BEGIN IMMEDIATE 事务内核验 expectedRevision（防 TOCTOU）；
 * - batch 仅未开始运输/无当前仪器/无改批历史；activity 存在工作事实或维修关联拒绝
 *   （不级联清事实）；damage 仅未处理、备件未使用、无活动关联；completed ship-to 禁止；
 *   instrument 所属批次已开始运输也禁止、且保留其他依赖检查；
 * - acceptance 真正实现：有 invoice 历史拒绝，否则清空验收事实并按事实确定性回退状态；
 * - invoice 映射为撤销（不可物理删除）；全部删除联动导入审计。
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
    customerName: '删除测试客户',
    region: '华东',
    oldSiteAddress: '旧址',
    newSiteAddress: '新址',
    instrumentCount: 1,
    siteConfirmed: false,
    ...overrides,
  };
}

async function makeCtx(): Promise<{ facade: WorkbenchFacade; db: DatabaseSync; projectId: string }> {
  const dir = makeTempDir('workbench-delete-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
  const created = facade.v2Mutate({
    op: 'create_project',
    payload: wizard({ customerName: '删除测试客户', ecc: 'ECC-DEL-001', contractAmount: '100000' }),
  });
  const projectId = projectIdOf(created);
  // instrumentCount 只记录数量不生成仪器：显式登记一台仪器供子记录/删除测试使用。
  facade.v2Mutate({
    op: 'submit_action',
    projectId,
    action: { type: 'instrument', projectId, values: { name: '删除测试仪器', serialNo: 'SN-DEL-001', ups: false, qrRequested: false } },
  });
  return { facade, db, projectId };
}

/** 断言抛出 DomainError 且 code 为稳定拒绝码（或 message 匹配 RegExp）。 */
function expectRejected(fn: () => unknown, codeOrPattern: string | RegExp): void {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (codeOrPattern instanceof RegExp) {
      expect(e.message ?? '').toMatch(codeOrPattern);
    } else {
      expect(e.code).toBe(codeOrPattern);
    }
    return;
  }
  expect.unreachable('应当抛出拒绝错误');
}

describe('受保护登记记录删除（v2Delete，ora-1 严格守卫）', () => {
  it('expectedRevision 不匹配当前业务修订时整体拒绝且不写库（事务内核验）', async () => {
    const ctx = await makeCtx();
    const revision = readBusinessRevision(ctx.db);
    // 写一次改变 revision
    ctx.facade.v2Mutate({ op: 'set_reminder', projectId: ctx.projectId, reminderAt: '2026-08-09', reminderNote: 'x' });
    const after = readBusinessRevision(ctx.db);
    expect(after).toBeGreaterThan(revision);
    expectRejected(
      () => ctx.facade.v2Delete({ kind: 'qr_request', id: 'whatever', expectedRevision: revision }),
      DELETE_REJECTION_CODES.REVISION_MISMATCH,
    );
    expect(readBusinessRevision(ctx.db)).toBe(after);
  });

  it('service_order 删除成功：行删除 + 导入审计联动 + invalidate 标签', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-DEL-001', orderedAt: '2026-08-11', engineer: '工程师甲' } },
    });
    const orderId = String(db.prepare('SELECT id FROM service_orders WHERE service_order_no = ?').get('SO-DEL-001')!.id);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-so', 'so-1', 'service_orders', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(orderId);

    const revision = readBusinessRevision(db);
    const result = facade.v2Delete({ kind: 'service_order', id: orderId, expectedRevision: revision });
    expect(result.changed).toMatchObject({ kind: 'service_order', id: orderId, projectId });
    expect(result.invalidated).toContain(`project:${projectId}`);
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).total).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE target_table = ?').get('service_orders')!.n).toBe(0);
  });

  it('activity：存在工作事实 → 拒绝（不级联清事实）；空活动（无事实/无维修关联）→ 删除成功', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 有工作事实的活动 → 拒绝
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-12', engineers: '工程师甲', status: 'done', instrumentIds: [instrumentId], workTypes: ['teardown'] } } });
    const factActivityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ?').get(projectId)!.id);
    expectRejected(
      () => facade.v2Delete({ kind: 'activity', id: factActivityId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 工作事实未被级联删除
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_facts WHERE activity_id = ?').get(factActivityId)!.n).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'activities' }).total).toBe(1);

    // 空活动（无工作事实、无维修关联）→ 删除成功（参与工程师属活动记录，随活动删除）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-13', engineers: '工程师甲、工程师乙' } } });
    const emptyActivityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ? AND id <> ?').get(projectId, factActivityId)!.id);
    const result = facade.v2Delete({ kind: 'activity', id: emptyActivityId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('activity');
    expect(facade.v2SectionPage({ projectId, kind: 'activities' }).total).toBe(1); // 仅剩有工作事实的活动
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_engineers WHERE activity_id = ?').get(emptyActivityId)!.n).toBe(0);
  });

  it('acceptance：有 invoice 历史拒绝；无 invoice 时清空验收事实并按事实确定性回退状态', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // 无掉票历史 → 删除验收 → 回退到正式进单基线（pending_execution）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-15' } } });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_invoice');
    const result = facade.v2Delete({ kind: 'acceptance', projectId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed).toMatchObject({ kind: 'acceptance', id: projectId, projectId });
    let detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.acceptanceReport).toBe(false);
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_execution'); // 无实际装机/执行事实 → 正式进单基线

    // 已实际装机完成 → 回退到待验收
    const ctx2 = await makeCtx();
    const p2 = ctx2.projectId;
    ctx2.facade.v2Mutate({ op: 'submit_action', projectId: p2, action: { type: 'acceptance', projectId: p2, values: { reportDate: '2026-08-15' } } });
    ctx2.db.prepare('UPDATE projects SET actual_install_done_at = ? WHERE id = ?').run('2026-08-10', p2);
    ctx2.facade.v2Delete({ kind: 'acceptance', projectId: p2, expectedRevision: readBusinessRevision(ctx2.db) });
    expect(ctx2.facade.v2ProjectDetail(p2).project!.status).toBe('pending_acceptance');

    // 有掉票历史（含已撤销）→ 拒绝，验收事实保留
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-20' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-21', amount: '1000' } } });
    expectRejected(
      () => facade.v2Delete({ kind: 'acceptance', projectId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    expect(facade.v2ProjectDetail(projectId).detail!.acceptanceReport).toBe(true);
  });

  it('damage：已处理/备件已使用/有活动关联 → 拒绝；未处理且无关联 → 删除成功', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 已处理（processing）→ 拒绝
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-1', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'arrived', issueStatus: 'processing', registeredAt: '2026-08-12' } },
    });
    const processedDamageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE project_id = ?').get(projectId)!.id);
    expectRejected(
      () => facade.v2Delete({ kind: 'damage_repair_item', id: processedDamageId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );

    // 未处理 → 删除成功
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '运输磕碰', partNumber: 'P-2', partQuantity: '1', partAmount: '50', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-13' } },
    });
    const untreatedDamageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE project_id = ? AND id <> ?').get(projectId, processedDamageId)!.id);
    const result = facade.v2Delete({ kind: 'damage_repair_item', id: untreatedDamageId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('damage_repair_item');
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(1); // 仅剩已处理事项
  });

  it('serial_address 独立记录删除成功（instrumentId 为 null）', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-del', null, '独立客户', '新址', 'SN-DEL', 'ACC-DEL', '2026-08-10', 't');
    const result = facade.v2Delete({ kind: 'serial_address', id: 'sa-del', expectedRevision: readBusinessRevision(db) });
    expect(result.invalidated).toContain('independent:serial_address');
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(0);
  });

  it('qr_request 删除成功：多选类型一并清理', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    const qrId = String(db.prepare('SELECT id FROM qr_requests LIMIT 1').get()!.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM qr_request_types WHERE qr_request_id = ?').get(qrId)!.n).toBe(2);
    const result = facade.v2Delete({ kind: 'qr_request', id: qrId, expectedRevision: readBusinessRevision(db) });
    expect(result.invalidated).toContain('independent:qr_request');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qr_request_types WHERE qr_request_id = ?').get(qrId)!.n).toBe(0);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
  });

  it('batch：已开始运输/有当前仪器/有改批历史 → 拒绝；空批次（未开始、无仪器、无历史）→ 删除成功（含唯一物流费用）', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // 空批次（未开始、无仪器、无历史，但带唯一物流费用）→ 删除成功（费用随批次删除）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    const batchId = String(db.prepare('SELECT id FROM batches WHERE project_id = ?').get(projectId)!.id);
    const feeId = String(db.prepare('SELECT id FROM logistics_fees WHERE batch_id = ?').get(batchId)!.id);
    const result = facade.v2Delete({ kind: 'batch', id: batchId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('batch');
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE batch_id = ?').get(batchId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE id = ?').get(feeId)!.n).toBe(0);

    // 已绑定仪器 → 拒绝
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-11', transportCompany: 'T', appliedAt: '2026-08-09', budgetPrice: '1000', dealPrice: '1000' } } });
    const batch2 = String(db.prepare('SELECT id FROM batches WHERE project_id = ? AND id <> ?').get(projectId, batchId)!.id);
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    db.prepare('UPDATE instruments SET batch_id = ? WHERE id = ?').run(batch2, instrumentId);
    expectRejected(
      () => facade.v2Delete({ kind: 'batch', id: batch2, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    db.prepare('UPDATE instruments SET batch_id = NULL WHERE id = ?').run(instrumentId);

    // 已开始运输 → 拒绝
    db.prepare('UPDATE batches SET started_at = ? WHERE id = ?').run('2026-08-12', batch2);
    expectRejected(
      () => facade.v2Delete({ kind: 'batch', id: batch2, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
  });

  it('instrument：所属批次已开始运输/存在依赖记录 → 拒绝；无依赖 → 删除成功', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 有损坏事项 → 拒绝
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-1', partQuantity: '1', partAmount: '10', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-12' } },
    });
    expectRejected(
      () => facade.v2Delete({ kind: 'instrument', id: instrumentId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(1);

    // 无依赖 → 删除成功
    const cleanCtx = await makeCtx();
    const cleanInstrumentId = String(cleanCtx.db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(cleanCtx.projectId)!.id);
    const result = cleanCtx.facade.v2Delete({ kind: 'instrument', id: cleanInstrumentId, expectedRevision: readBusinessRevision(cleanCtx.db) });
    expect(result.changed?.kind).toBe('instrument');
    expect(cleanCtx.facade.v2SectionPage({ projectId: cleanCtx.projectId, kind: 'instruments' }).total).toBe(0);

    // 所属批次已开始运输 → 拒绝
    const ctx2 = await makeCtx();
    const { db: db2, projectId: p2 } = ctx2;
    const i2 = String(db2.prepare('SELECT id FROM instruments WHERE project_id = ?').get(p2)!.id);
    ctx2.facade.v2Mutate({ op: 'submit_action', projectId: p2, action: { type: 'batch', projectId: p2, values: { planTransportDate: '2026-08-10', transportCompany: 'T', appliedAt: '2026-08-09', budgetPrice: '1000', dealPrice: '1000' } } });
    const b2 = String(db2.prepare('SELECT id FROM batches WHERE project_id = ?').get(p2)!.id);
    db2.prepare('UPDATE instruments SET batch_id = ? WHERE id = ?').run(b2, i2);
    db2.prepare('UPDATE batches SET started_at = ? WHERE id = ?').run('2026-08-12', b2);
    expectRejected(
      () => ctx2.facade.v2Delete({ kind: 'instrument', id: i2, expectedRevision: readBusinessRevision(db2) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
  });

  it('ship_to_request：已完成禁止；待提交/处理中可删除', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const pending = facade.createShipToRequest({ customerName: 'ShipTo 客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(pending.request.id);
    facade.v2Mutate({ op: 'ship_to_complete', requestId: pending.request.id, accountId: 'ACC-DONE' });
    // 已完成 → 禁止
    expectRejected(
      () => facade.v2Delete({ kind: 'ship_to_request', id: pending.request.id, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 处理中（新申请提交后未完成）→ 可删除
    const processing = facade.createShipToRequest({ customerName: 'ShipTo 客户乙', newSiteAddress: '新址乙' });
    facade.submitShipToRequest(processing.request.id);
    const result = facade.v2Delete({ kind: 'ship_to_request', id: processing.request.id, expectedRevision: readBusinessRevision(db) });
    expect(result.invalidated).toContain('lookup:ship_to_requests');
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1); // 仅剩已完成
  });

  it('invoice 删除映射为撤销：必填撤销日期/原因，行不物理删除', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoiceId = String(db.prepare('SELECT id FROM invoices WHERE project_id = ?').get(projectId)!.id);

    expectRejected(
      () => facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: readBusinessRevision(db), revokedAt: '', revokeReason: '' }),
      DELETE_REJECTION_CODES.INVOICE_REQUIRES_REVOKE,
    );

    const result = facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: readBusinessRevision(db), revokedAt: '2026-08-13', revokeReason: '客户更正' });
    // 删除结果信封：changed 回显 invoice 的 kind/id/projectId，businessRevision 与库一致
    expect(result.changed).toMatchObject({ kind: 'invoice', id: invoiceId, projectId });
    expect(result.invalidated).toContain(`project:${projectId}`);
    expect(result.invalidated).toContain(`sections:${projectId}`);
    expect(result.businessRevision).toBe(readBusinessRevision(db));
    const row = db.prepare('SELECT revoked_at, revoke_reason FROM invoices WHERE id = ?').get(invoiceId) as { revoked_at: string; revoke_reason: string };
    expect(row.revoked_at).toBe('2026-08-13'); // 物理行保留（撤销终态）
    expect(row.revoke_reason).toBe('客户更正');
    // 物理行不删除：掉票记录仅可撤销（撤销终态行仍保留在 invoices 表中）
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE id = ?').get(invoiceId)!.n).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'invoices' }).rows[0]).toMatchObject({ active: false });
  });

  it('删除失败整体回滚：invoice 重复撤销被领域拒绝时事务回滚', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoiceId = String(db.prepare('SELECT id FROM invoices WHERE project_id = ?').get(projectId)!.id);
    const revisionBefore = readBusinessRevision(db);
    facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: revisionBefore, revokedAt: '2026-08-12', revokeReason: '第一次撤销' });
    expectRejected(
      () => facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: readBusinessRevision(db), revokedAt: '2026-08-13', revokeReason: '再次撤销' }),
      /撤销/,
    );
    const row = db.prepare('SELECT revoked_at, revoke_reason FROM invoices WHERE id = ?').get(invoiceId) as { revoked_at: string; revoke_reason: string };
    expect(row.revoked_at).toBe('2026-08-12'); // 保持首次撤销终态
    expect(row.revoke_reason).toBe('第一次撤销');
  });

  it('命令形状：未知 recordType 稳定拒绝（DELETE_UNKNOWN_KIND），expectedRevision 校验先于类型分发', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const revision = readBusinessRevision(db);
    // expectedRevision 在 BEGIN IMMEDIATE 事务内核验、类型分发之前 → 未知 kind 带过期修订仍先报修订不匹配
    expectRejected(
      () =>
        facade.v2Delete({
          kind: 'unknown_kind',
          id: 'whatever',
          expectedRevision: revision - 1,
        } as unknown as WorkbenchV2DeleteRequest),
      DELETE_REJECTION_CODES.REVISION_MISMATCH,
    );
    // 修订一致才进入类型分发：未知 kind 走默认分支拒绝（非稳定码，属程序错误边界，不误伤既有类型）
    expectRejected(
      () =>
        facade.v2Delete({
          kind: 'unknown_kind',
          id: 'whatever',
          expectedRevision: revision,
        } as unknown as WorkbenchV2DeleteRequest),
      'DELETE_UNKNOWN_KIND',
    );
    // 两次拒绝均无副作用：修订不变、无记录被删
    expect(readBusinessRevision(db)).toBe(revision);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
  });

  it('稳定拒绝码：不存在的记录统一返回 NOT_FOUND（acceptance 以 projectId 寻址），且不写库', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const revision = readBusinessRevision(db);
    expectRejected(
      () => facade.v2Delete({ kind: 'service_order', id: 'so-missing', expectedRevision: revision }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    // acceptance 命令形状差异：以 projectId（而非 id）寻址
    expectRejected(
      () => facade.v2Delete({ kind: 'acceptance', projectId: 'proj-missing', expectedRevision: revision }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    // invoice 先校验存在性：即使携带合法撤销字段，记录不存在仍 NOT_FOUND（不落入撤销语义）
    expectRejected(
      () => facade.v2Delete({ kind: 'invoice', id: 'inv-missing', expectedRevision: revision, revokedAt: '2026-08-13', revokeReason: '客户更正' }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    expect(readBusinessRevision(db)).toBe(revision);
  });

  it('删除结果信封：项目关联型成功删除返回 businessRevision/invalidated/changed，修订单调递增且与库一致', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-ENV-001', orderedAt: '2026-08-11', engineer: '工程师甲' } },
    });
    const orderId = String(db.prepare('SELECT id FROM service_orders WHERE service_order_no = ?').get('SO-ENV-001')!.id);
    const revision = readBusinessRevision(db);
    const result = facade.v2Delete({ kind: 'service_order', id: orderId, expectedRevision: revision });
    // 信封仅三个字段
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(revision);
    expect(result.businessRevision).toBe(readBusinessRevision(db));
    // changed 回显请求形状：kind/id/projectId
    expect(result.changed).toEqual({ kind: 'service_order', id: orderId, projectId });
    // invalidated：overview + projects + project:X + sections:X（唯一去重后的精确集合）
    expect(result.invalidated).toEqual(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]);
  });

  it('删除结果信封：独立/查询型 changed 不含 projectId，携带独立/查询失效标签', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;

    // 二维码申请（独立）：changed 无 projectId，失效标签为 independent:qr_request
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    const qrId = String(db.prepare('SELECT id FROM qr_requests LIMIT 1').get()!.id);
    const qrResult = facade.v2Delete({ kind: 'qr_request', id: qrId, expectedRevision: readBusinessRevision(db) });
    expect(qrResult.changed).toEqual({ kind: 'qr_request', id: qrId });
    expect(qrResult.changed?.projectId).toBeUndefined();
    expect(qrResult.invalidated).toEqual(['overview', 'projects', 'independent:qr_request']);

    // 独立序列号地址更新（instrumentId 为 null）：changed 同样无 projectId
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-env', null, '独立客户', '新址', 'SN-ENV', 'ACC-ENV', '2026-08-10', 't');
    const saResult = facade.v2Delete({ kind: 'serial_address', id: 'sa-env', expectedRevision: readBusinessRevision(db) });
    expect(saResult.changed?.projectId).toBeUndefined();
    expect(saResult.invalidated).toEqual(['overview', 'projects', 'independent:serial_address']);

    // Ship-to 申请（查询型）：changed 无 projectId，失效标签为 lookup:ship_to_requests
    const pending = facade.createShipToRequest({ customerName: 'ShipTo 信封客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(pending.request.id);
    const stResult = facade.v2Delete({ kind: 'ship_to_request', id: pending.request.id, expectedRevision: readBusinessRevision(db) });
    expect(stResult.changed).toEqual({ kind: 'ship_to_request', id: pending.request.id });
    expect(stResult.invalidated).toEqual(['overview', 'projects', 'lookup:ship_to_requests']);
  });

  it('原子审计联动：成功删除随行清除目标表审计（批次+唯一物流费用），拒绝路径保留审计', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // 批次 + 唯一物流费用均挂 import_record_audit → 删除时审计随行原子清除
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    const batchId = String(db.prepare('SELECT id FROM batches WHERE project_id = ?').get(projectId)!.id);
    const feeId = String(db.prepare('SELECT id FROM logistics_fees WHERE batch_id = ?').get(batchId)!.id);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-batch', 'b-1', 'batches', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(batchId);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-fee', 'f-1', 'logistics_fees', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(feeId);
    const result = facade.v2Delete({ kind: 'batch', id: batchId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('batch');
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE target_table = ? AND target_id = ?').get('batches', batchId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE target_table = ? AND target_id = ?').get('logistics_fees', feeId)!.n).toBe(0);

    // 拒绝路径：依赖拒绝时目标表审计保留（不误删、不级联清审计）
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-3', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'arrived', issueStatus: 'processing', registeredAt: '2026-08-12' } },
    });
    const damageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE project_id = ?').get(projectId)!.id);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-damage', 'd-1', 'damage_repair_items', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(damageId);
    const revisionAtReject = readBusinessRevision(db);
    expectRejected(
      () => facade.v2Delete({ kind: 'damage_repair_item', id: damageId, expectedRevision: revisionAtReject }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE target_table = ? AND target_id = ?').get('damage_repair_items', damageId)!.n).toBe(1);
    expect(readBusinessRevision(db)).toBe(revisionAtReject);
  });
});
