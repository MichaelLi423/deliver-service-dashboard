import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { DataCleanupService } from '../../src/domain/capabilities/local-data-persistence/data-cleanup';
import { readDatabaseIdentity } from '../../src/domain/capabilities/local-data-persistence/identity';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import { CLEAN_ALL_CONFIRM_TEXT, CLEAN_REJECTION_CODES } from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 「清理全部业务数据」两阶段 API：
 * - prepare 返回计数/短期 token/过期时间/revision；token 绑定 DB identity/generation/revision；
 * - confirm 必须 token + 固定文本；revision/token 变化拒绝；执行前备份、BEGIN IMMEDIATE
 *   原子清理业务表与导入审计、保留 accounts/app_settings/database_metadata、轮换 generation；
 * - 原子性：清理中途失败整体回滚。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function seedDb(dir: string): Promise<{ db: DatabaseSync; accountId: string }> {
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  return { db, accountId: account.id };
}

function seedBusinessData(db: DatabaseSync, facade: WorkbenchFacade): { projectId: string } {
  const created = facade.v2Mutate({
    op: 'create_project',
    payload: { intent: 'formal', customerName: '清理测试客户', ecc: 'ECC-CLEAN-001', region: 'East', instrumentCount: 1, contractAmount: '10000' },
  });
  const projectId = created.changed!.projectId!;
  facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A'] } } });
  facade.createShipToRequest({ customerName: 'ShipTo 客户', newSiteAddress: '新址' });
  // 导入审计
  db.prepare(
    "INSERT INTO migration_audit (id, batch_key, status, imported_count, imported_at) VALUES ('ma-1', 'b1', 'success', 1, '2026-08-01T00:00:00+08:00')",
  ).run();
  db.prepare(
    "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('ira-1', 'k1', 'service_orders', 'so-x', 'h', 'h', '2026-08-01T00:00:00+08:00')",
  ).run();
  return { projectId };
}

/** confirm 为 async 路径：断言 Promise 拒绝（稳定错误码或 message 匹配）。 */
async function expectRejectedAsync(fn: () => Promise<unknown>, codeOrPattern: string | RegExp): Promise<void> {
  try {
    await fn();
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

describe('清理全部业务数据：prepare', () => {
  it('prepare 返回计数/短期 token/过期时间/revision，且不改变业务修订', async () => {
    const dir = makeTempDir('clean-prepare-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => Promise.resolve('/tmp/fake-backup.db'),
    });
    seedBusinessData(db, facade);
    const before = readDatabaseIdentity(db).businessRevision;

    const prepared = facade.cleanPrepare();
    expect(typeof prepared.token).toBe('string');
    expect(prepared.token.length).toBeGreaterThan(16);
    expect(prepared.expiresAt).toBeGreaterThan(Date.now());
    expect(prepared.revision).toBe(before);
    expect(prepared.counts.projects).toBe(1);
    expect(prepared.counts.qr_requests).toBe(1);
    expect(prepared.counts.customers).toBe(1);
    expect(prepared.auditCounts.migrationAudit).toBe(1);
    expect(prepared.auditCounts.importRecordAudit).toBe(1);
    // prepare 不改变业务修订
    expect(readDatabaseIdentity(db).businessRevision).toBe(before);
  });
});

describe('清理全部业务数据：confirm 拒绝路径（稳定错误码）', () => {
  it('确认文本不匹配拒绝；未 prepare 拒绝；token 不匹配拒绝；token 过期拒绝', async () => {
    const dir = makeTempDir('clean-reject-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => Promise.resolve('/tmp/fake-backup.db'),
    });
    seedBusinessData(db, facade);

    // 未 prepare
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: 'x', confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      CLEAN_REJECTION_CODES.NOT_PREPARED,
    );

    const prepared = facade.cleanPrepare();
    // 确认文本不匹配
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: prepared.token, confirmText: '我确定要清理' }),
      CLEAN_REJECTION_CODES.CONFIRM_TEXT,
    );
    // token 不匹配
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: 'wrong-token', confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      CLEAN_REJECTION_CODES.TOKEN_MISMATCH,
    );
    // token 过期（注入过期 now）
    const expired = new DataCleanupService(db, {
      backup: () => Promise.resolve('/tmp/fake-backup.db'),
      now: () => prepared.expiresAt + 1,
    });
    await expectRejectedAsync(
      () => expired.confirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      CLEAN_REJECTION_CODES.TOKEN_EXPIRED,
    );
  });

  it('revision 在 prepare 后变化（业务写入）→ confirm 拒绝：备份已创建、数据未清理', async () => {
    const dir = makeTempDir('clean-revision-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    let backupCalled = false;
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => {
        backupCalled = true;
        return Promise.resolve('/tmp/clean-revision-backup.db');
      },
    });
    seedBusinessData(db, facade);
    const prepared = facade.cleanPrepare();
    // prepare 后业务写入 → revision 变化（TOCTOU：备份与 BEGIN IMMEDIATE 之间发生的写入也被事务内核验捕获）
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '新申请', requestedAt: '2026-08-11', types: ['B'] } } });
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      CLEAN_REJECTION_CODES.REVISION_CHANGED,
    );
    // 备份保留但数据未清理（revision 变化不清数据）
    expect(backupCalled).toBe(true);
    expect(facade.v2Overview().metrics.totalProjects).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(2);
    // token 未被消费（可重新 prepare 覆盖）
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'data-clean.token'").get()!.n).toBe(1);
    expect(readDatabaseIdentity(db).contentGenerationId).toBe(prepared.contentGenerationId); // generation 未轮换
  });
});

describe('清理全部业务数据：confirm 成功（原子清理 + 保留系统表 + 轮换 generation）', () => {
  it('业务表与导入审计清空、accounts/app_settings/database_metadata 保留、备份执行、generation 轮换', async () => {
    const dir = makeTempDir('clean-success-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    let backupCalled = false;
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => {
        backupCalled = true;
        return Promise.resolve('/tmp/clean-backup.db');
      },
    });
    const { projectId } = seedBusinessData(db, facade);
    facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2026-08-09', reminderNote: 'x' });
    // 预留非清理 token 系统设置
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('reminder.window.days', '7', 't')").run();

    const beforeIdentity = readDatabaseIdentity(db);
    const prepared = facade.cleanPrepare();
    const result = await facade.cleanConfirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT });

    expect(backupCalled).toBe(true);
    expect(result.backupPath).toBe('/tmp/clean-backup.db');
    expect(result.clearedBusinessRows).toBeGreaterThan(0);
    expect(result.clearedAuditRows).toBe(2); // migration_audit + import_record_audit

    // 业务数据全部清空
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(0);
    expect(facade.v2LookupPage({ kind: 'customers' }).total).toBe(0);

    // 导入审计清空
    expect(db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit').get()!.n).toBe(0);

    // 系统表保留
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'reminder.window.days'").get()!.n).toBe(1);
    // 清理 token 已被消费（app_settings 保留但 data-clean.* 键清除）
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'data-clean.%'").get()!.n).toBe(0);
    const afterIdentity = readDatabaseIdentity(db);
    expect(afterIdentity.databaseInstanceId).toBe(beforeIdentity.databaseInstanceId); // 实例 ID 不变
    expect(afterIdentity.contentGenerationId).not.toBe(beforeIdentity.contentGenerationId); // generation 轮换
    expect(result.contentGenerationId).toBe(afterIdentity.contentGenerationId);

    // 清理后旧 token 已消费：再次 confirm 报 NOT_PREPARED
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      CLEAN_REJECTION_CODES.NOT_PREPARED,
    );
  });

  it('原子性（清零核验失败）：事务内核验目标表非空 → 整体回滚、数据与备份前状态一致', async () => {
    const dir = makeTempDir('clean-zero-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => Promise.resolve('/tmp/fake-backup.db'),
      cleanupHooks: {
        // 测试钩子：删除完成后插入一行 → 清零核验失败（模拟并发写入/漏删）
        onAfterDeletes: (conn) => {
          conn.prepare("INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES ('z-1', '漏删', '2026-08-01', 't')").run();
        },
      },
    });
    seedBusinessData(db, facade);
    const prepared = facade.cleanPrepare();
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      /仍非空/,
    );
    // 全部业务数据原样保留（回滚含测试钩子插入行）
    expect(facade.v2Overview().metrics.totalProjects).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM qr_requests WHERE id = 'z-1'").get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n).toBe(1);
    expect(readDatabaseIdentity(db).contentGenerationId).toBe(prepared.contentGenerationId); // generation 未轮换
  });

  it('外键保护：清理事务内出现悬空引用 → 外键约束拒绝、整体回滚（PRAGMA foreign_key_check 亦在同事务核验）', async () => {
    const dir = makeTempDir('clean-fk-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => Promise.resolve('/tmp/fake-backup.db'),
      cleanupHooks: {
        // 测试钩子：清零核验后尝试写入悬空外键行 → 外键约束（foreign_keys=ON）拒绝 → 整体回滚。
        // （SQLite 事务内无法关闭 foreign_keys，该插入直接触发 FK 约束；成功路径上
        //   PRAGMA foreign_key_check 同样在同事务内全表核验并放行。）
        onBeforeForeignKeys: (conn) => {
          conn.prepare(
            `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at)
             VALUES ('fk-1', 'no-such-instrument', 'c', 'a', 's', 'acc', '2026-08-01', 't')`,
          ).run();
        },
      },
    });
    seedBusinessData(db, facade);
    const prepared = facade.cleanPrepare();
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      /FOREIGN KEY constraint failed/,
    );
    // 全部业务数据原样保留（回滚）
    expect(facade.v2Overview().metrics.totalProjects).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM serial_address_updates WHERE id = 'fk-1'").get()!.n).toBe(0);
    expect(readDatabaseIdentity(db).contentGenerationId).toBe(prepared.contentGenerationId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n).toBe(1);
  });

  it('原子性（generation 轮换失败）：轮换在事务内 → 失败整体回滚、数据不动、generation 不变', async () => {
    const dir = makeTempDir('clean-rotate-');
    dirs.push(dir);
    const { db, accountId } = await seedDb(dir);
    const facade = new WorkbenchFacade(db, () => ({ accountId, username: '负责人' }), {
      cleanupBackup: () => Promise.resolve('/tmp/fake-backup.db'),
      cleanupHooks: {
        rotateGeneration: () => {
          throw new Error('injected-rotation-failure');
        },
      },
    });
    seedBusinessData(db, facade);
    const prepared = facade.cleanPrepare();
    await expectRejectedAsync(
      () => facade.cleanConfirm({ token: prepared.token, confirmText: CLEAN_ALL_CONFIRM_TEXT }),
      /injected-rotation-failure/,
    );
    // 数据未清理（轮换失败 → 回滚，绝不 COMMIT 后轮换）
    expect(facade.v2Overview().metrics.totalProjects).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(1);
    expect(readDatabaseIdentity(db).contentGenerationId).toBe(prepared.contentGenerationId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n).toBe(1);
    // token 未被消费
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'data-clean.token'").get()!.n).toBe(1);
  });
});
