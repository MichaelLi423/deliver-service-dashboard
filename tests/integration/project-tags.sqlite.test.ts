import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { createManualBackup } from '../../src/domain/capabilities/local-data-persistence/backup';
import { restoreFromBackup } from '../../src/domain/capabilities/local-data-persistence/restore';
import { FixedClock } from '../../src/domain/core/time';
import { join } from 'node:path';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanupTempDir(dir); });
function expectCode(run: () => unknown, code: string): void { try { run(); throw new Error('expected failure'); } catch (error) { expect((error as { code?: string }).code).toBe(code); } }

async function setup() {
  const dir = makeTempDir('project-tags-'); dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
  return { db, facade: new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username })) };
}

describe('项目分类标签 SQLite 集成', () => {
  it('目录稳定排序、trim 校验、replace-set 去重且不触发生命周期', async () => {
    const { facade } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '客户', region: 'East' } }).changed!.projectId!;
    const before = facade.v2ProjectDetail(projectId).project!;
    const groupResult = facade.v2TagMutate({ command: 'create_group', payload: { name: ' 自定义 ', sortOrder: 5 } });
    if (!('group' in groupResult)) throw new Error('expected group');
    const group = groupResult.group;
    const tagResult = facade.v2TagMutate({ command: 'create_tag', payload: { groupId: group.id, name: ' A ' } });
    if (!('tag' in tagResult)) throw new Error('expected tag');
    const tag = tagResult.tag;
    const assigned = facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [tag.id, tag.id] } });
    expect('projectId' in assigned && assigned.tagIds).toEqual([tag.id]);
    expect(facade.v2TagCatalog({ projectId }).groups[0].name).toBe('自定义');
    const after = facade.v2ProjectDetail(projectId).project!;
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.groupedTags).toEqual([{ groupId: group.id, groupName: '自定义', tagIds: [tag.id], tagNames: ['A'] }]);
    expectCode(() => facade.v2TagMutate({ command: 'create_group', payload: { name: '   ' } }), 'PROJECT_TAG_GROUP_NAME_EMPTY');
    expectCode(() => facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: ['missing'] } }), 'PROJECT_TAG_UNKNOWN_TAG');
  });

  it('设置和清空标签不改变项目状态、提醒、执行事实或状态转换审计', async () => {
    const { facade, db } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '副作用客户', region: 'East' } }).changed!.projectId!;
    facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2026-08-10', reminderNote: '既有提醒' });
    facade.v2Mutate({ op: 'instrument_bulk_import', payload: { projectId, rows: [{ name: '既有仪器' }] } });
    const tag = facade.v2TagCatalog().groups[0].tags[0];
    const beforeProject = db.prepare('SELECT status,updated_at,reminder_at,reminder_note FROM projects WHERE id=?').get(projectId);
    const beforeFacts = db.prepare('SELECT COUNT(*) n FROM instruments WHERE project_id=?').get(projectId);
    const beforeAudit = db.prepare('SELECT COUNT(*) n FROM project_status_transition_audit WHERE project_id=?').get(projectId);
    facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [tag.id] } });
    facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [] } });
    expect(db.prepare('SELECT status,updated_at,reminder_at,reminder_note FROM projects WHERE id=?').get(projectId)).toEqual(beforeProject);
    expect(db.prepare('SELECT COUNT(*) n FROM instruments WHERE project_id=?').get(projectId)).toEqual(beforeFacts);
    expect(db.prepare('SELECT COUNT(*) n FROM project_status_transition_audit WHERE project_id=?').get(projectId)).toEqual(beforeAudit);
  });

  it('update_project tag-only 在已到期计划下只替换标签，不改项目执行状态或事实', async () => {
    const { facade, db } = await setup();
    const tag = facade.v2TagCatalog().groups[0].tags[0];
    const pendingEntryId = facade.v2Mutate({
      op: 'create_project',
      payload: { intent: 'draft', customerName: '待进单标签客户', region: 'East', planVisitAt: '2099-01-01' },
    }).changed!.projectId!;
    const pendingExecutionId = facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal', customerName: '待执行标签客户', region: 'East', planVisitAt: '2099-01-01',
        ecc: 'TAG-ONLY-DUE', instrumentCount: 1, contractAmount: '1000',
      },
    }).changed!.projectId!;
    expect(db.prepare('SELECT status FROM projects WHERE id=?').get(pendingEntryId)).toEqual({ status: 'pending_entry' });
    expect(db.prepare('SELECT status FROM projects WHERE id=?').get(pendingExecutionId)).toEqual({ status: 'pending_execution' });
    db.prepare("UPDATE projects SET plan_visit_at='2000-01-01' WHERE id IN (?,?)").run(pendingEntryId, pendingExecutionId);

    for (const projectId of [pendingEntryId, pendingExecutionId]) {
      facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2026-08-10', reminderNote: '既有提醒' });
      const beforeProject = db.prepare('SELECT status,updated_at,plan_visit_at,plan_transport_at,site_confirmed,pre_entry_execution,reminder_at,reminder_note FROM projects WHERE id=?').get(projectId);
      const beforeFacts = db.prepare('SELECT COUNT(*) n FROM instruments WHERE project_id=?').get(projectId);
      const beforeAudit = db.prepare('SELECT COUNT(*) n FROM project_status_transition_audit WHERE project_id=?').get(projectId);

      facade.v2Mutate({ op: 'update_project', payload: { projectId, tagIds: [tag.id] } });

      expect(facade.v2TagCatalog({ projectId }).selectedTagIds).toEqual([tag.id]);
      expect(db.prepare('SELECT status,updated_at,plan_visit_at,plan_transport_at,site_confirmed,pre_entry_execution,reminder_at,reminder_note FROM projects WHERE id=?').get(projectId)).toEqual(beforeProject);
      expect(db.prepare('SELECT COUNT(*) n FROM instruments WHERE project_id=?').get(projectId)).toEqual(beforeFacts);
      expect(db.prepare('SELECT COUNT(*) n FROM project_status_transition_audit WHERE project_id=?').get(projectId)).toEqual(beforeAudit);
    }
  });

  it('创建与 update_project 标签关联均为原子写入，已取消项目仅允许 tag-only', async () => {
    const { facade, db } = await setup();
    const tag = facade.v2TagCatalog().groups[0].tags[0];
    expectCode(() => facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '回滚客户', region: 'East', tagIds: ['missing'] } }), 'PROJECT_TAG_UNKNOWN_TAG');
    expect(db.prepare("SELECT COUNT(*) n FROM projects WHERE temp_no IS NOT NULL").get()).toMatchObject({ n: 0 });
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '客户', region: 'East', tagIds: [tag.id] } }).changed!.projectId!;
    const beforeNoop = db.prepare('SELECT updated_at FROM projects WHERE id=?').get(projectId);
    const revisionBeforeNoop = db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get();
    facade.v2Mutate({ op: 'update_project', payload: { projectId, tagIds: undefined } });
    expect(db.prepare('SELECT updated_at FROM projects WHERE id=?').get(projectId)).toEqual(beforeNoop);
    expect(db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get()).toEqual(revisionBeforeNoop);
    facade.v2Mutate({ op: 'cancel_project', projectId, time: '2026-01-01', reason: '取消' });
    facade.v2Mutate({ op: 'update_project', payload: { projectId, tagIds: [] } });
    expect(facade.v2TagCatalog({ projectId }).selectedTagIds).toEqual([]);
    expectCode(() => facade.v2Mutate({ op: 'update_project', payload: { projectId, tagIds: [tag.id], region: 'North' } }), 'CANCELLED_PROJECT');
    expectCode(() => facade.v2Mutate({ op: 'update_project', payload: { projectId, tagIds: ['missing'] } }), 'PROJECT_TAG_UNKNOWN_TAG');
    expect(facade.v2TagCatalog({ projectId }).selectedTagIds).toEqual([]);
    closeDatabase(db);
  });

  it('catalog 在 WAL 并发写入后不会混合目录、已选标签与 businessRevision', async () => {
    const { facade, db } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '快照客户', region: 'East' } }).changed!.projectId!;
    const oldTag = facade.v2TagCatalog().groups[0].tags[0];
    facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [oldTag.id] } });
    const oldRevision = Number((db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get() as { business_revision: number }).business_revision);
    const dbPath = String((db.prepare('PRAGMA database_list').all() as Array<{ file: string }>)[0].file);
    const writer = openDatabase({ path: dbPath });
    const originalPrepare = db.prepare.bind(db);
    let injected = false;

    // 项目存在性读取是 catalog 的首次查询。写者在该读取后提交，未包住整个 catalog
    // 时后续目录、selected tag 或 revision 会读到新修订。
    (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql !== 'SELECT 1 FROM projects WHERE id=?') return statement;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== 'get') return Reflect.get(target, property, receiver);
          return (...args: Parameters<typeof target.get>) => {
            const row = target.get(...args);
            writer.exec('BEGIN');
            try {
              writer.prepare('INSERT INTO project_tag_groups (id,name,sort_order) VALUES (?,?,?)').run('wal-group', '并发分组', 999);
              writer.prepare('INSERT INTO project_tag_definitions (id,group_id,name,sort_order) VALUES (?,?,?,?)').run('wal-tag', 'wal-group', '并发标签', 10);
              writer.prepare('INSERT INTO project_tag_assignments (project_id,tag_id) VALUES (?,?)').run(projectId, 'wal-tag');
              writer.exec('COMMIT');
            } catch (error) {
              writer.exec('ROLLBACK');
              throw error;
            }
            injected = true;
            return row;
          };
        },
      });
    }) as typeof db.prepare;

    try {
      const catalog = facade.v2TagCatalog({ projectId });
      expect(injected).toBe(true);
      expect(catalog.groups.flatMap((group) => group.tags).map((tag) => tag.id)).not.toContain('wal-tag');
      expect(catalog.selectedTagIds).toEqual([oldTag.id]);
      expect(catalog.businessRevision).toBe(oldRevision);
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = originalPrepare;
      closeDatabase(writer);
    }
    expect(Number((db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get() as { business_revision: number }).business_revision)).toBeGreaterThan(oldRevision);
  });

  it('重开 SQLite 后保留自定义目录与项目关联', async () => {
    const { facade, db } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '重开客户', region: 'East' } }).changed!.projectId!;
    const created = facade.v2TagMutate({ command: 'create_group', payload: { name: '重开分组' } });
    if (!('group' in created)) throw new Error('expected group');
    const tagged = facade.v2TagMutate({ command: 'create_tag', payload: { groupId: created.group.id, name: '重开标签' } });
    if (!('tag' in tagged)) throw new Error('expected tag');
    facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [tagged.tag.id] } });
    const path = String((db.prepare('PRAGMA database_list').all() as Array<{ file: string }>)[0].file);
    closeDatabase(db);
    const reopened = bootstrapDatabase({ dataDir: path.slice(0, path.lastIndexOf('/')) }).db;
    const reread = new WorkbenchFacade(reopened, () => ({ accountId: 'unused', username: '负责人' }));
    expect(reread.v2TagCatalog({ projectId }).selectedTagIds).toEqual([tagged.tag.id]);
    closeDatabase(reopened);
  });

  it('真实手动备份与恢复保留自定义标签和项目关联', async () => {
    const { facade, db } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '备份客户', region: 'East' } }).changed!.projectId!;
    const group = facade.v2TagMutate({ command: 'create_group', payload: { name: '备份分组' } }); if (!('group' in group)) throw new Error('expected group');
    const tag = facade.v2TagMutate({ command: 'create_tag', payload: { groupId: group.group.id, name: '备份标签' } }); if (!('tag' in tag)) throw new Error('expected tag');
    facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [tag.tag.id] } });
    const path = String((db.prepare('PRAGMA database_list').all() as Array<{ file: string }>)[0].file);
    const dir = path.slice(0, path.lastIndexOf('/'));
    const backupPath = await createManualBackup(db, join(dir, 'backups'), { clock: new FixedClock('2026-08-07T10:00:00+08:00') });
    db.prepare('DELETE FROM project_tag_assignments WHERE project_id=?').run(projectId);
    let restoredDb = db;
    const result = restoreFromBackup({ backupPath, dbPath: path, snapshotDir: join(dir, 'snapshots'), currentDb: db, closeConnection: () => closeDatabase(restoredDb), openConnection: () => { restoredDb = bootstrapDatabase({ dataDir: dir }).db; } });
    expect(result.restored).toBe(true);
    expect(new WorkbenchFacade(restoredDb, () => ({ accountId: 'unused', username: '负责人' })).v2TagCatalog({ projectId }).selectedTagIds).toEqual([tag.tag.id]);
    closeDatabase(restoredDb);
  });
});
