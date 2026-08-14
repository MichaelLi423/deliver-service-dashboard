import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../../core/errors';
import type {
  CreateProjectTagGroupRequestDto,
  CreateProjectTagRequestDto,
  ProjectTagCatalogDto,
  ProjectTagGroupDto,
  ProjectTagGroupSummaryDto,
  ProjectTagDto,
} from '../../../shared/ipc';

const trimRequired = (value: string, code: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new ValidationError(code, `${label}不能为空`);
  return result;
};

/** 独立项目分类标签目录与关联仓储；不依赖 lifecycle 或 projects 写模型。 */
export class SqliteProjectTagRepository {
  constructor(private readonly db: DatabaseSync) {}

  catalog(projectId?: string | null): ProjectTagCatalogDto {
    return this.withReadSnapshot(() => {
      if (projectId != null && !this.projectExists(projectId)) {
        throw new ValidationError('PROJECT_TAG_UNKNOWN_PROJECT', `项目不存在: ${projectId}`);
      }
      const groups = this.groups();
      return { businessRevision: this.revision(), groups, selectedTagIds: projectId == null ? [] : this.tagIdsFor(projectId) };
    });
  }

  createGroup(input: CreateProjectTagGroupRequestDto): ProjectTagGroupDto {
    const name = trimRequired(input.name, 'PROJECT_TAG_GROUP_NAME_EMPTY', '标签分组名称');
    if (this.db.prepare('SELECT 1 FROM project_tag_groups WHERE name = ?').get(name)) {
      throw new ValidationError('PROJECT_TAG_GROUP_NAME_DUPLICATE', `标签分组名称已存在: ${name}`);
    }
    const sortOrder = input.sortOrder ?? this.nextOrder('project_tag_groups', '');
    const group = { id: randomUUID(), name, sortOrder, tags: [] as readonly ProjectTagDto[] };
    this.db.prepare('INSERT INTO project_tag_groups (id,name,sort_order) VALUES (?,?,?)').run(group.id, name, sortOrder);
    return group;
  }

  createTag(input: CreateProjectTagRequestDto): { group: ProjectTagGroupDto; tag: ProjectTagDto } {
    const group = this.group(input.groupId);
    if (!group) throw new ValidationError('PROJECT_TAG_UNKNOWN_GROUP', `标签分组不存在: ${input.groupId}`);
    const name = trimRequired(input.name, 'PROJECT_TAG_NAME_EMPTY', '标签名称');
    if (this.db.prepare('SELECT 1 FROM project_tag_definitions WHERE group_id = ? AND name = ?').get(input.groupId, name)) {
      throw new ValidationError('PROJECT_TAG_NAME_DUPLICATE', `标签名称已存在: ${name}`);
    }
    const tag: ProjectTagDto = { id: randomUUID(), groupId: input.groupId, name, sortOrder: input.sortOrder ?? this.nextOrder('project_tag_definitions', input.groupId) };
    this.db.prepare('INSERT INTO project_tag_definitions (id,group_id,name,sort_order) VALUES (?,?,?,?)').run(tag.id, tag.groupId, tag.name, tag.sortOrder);
    return { group: { ...group, tags: [] }, tag };
  }

  renameGroup(id: string, input: { name: string }): ProjectTagGroupDto {
    const group = this.group(id);
    if (!group) throw new ValidationError('PROJECT_TAG_UNKNOWN_GROUP', `标签分组不存在: ${id}`);
    const name = trimRequired(input.name, 'PROJECT_TAG_GROUP_NAME_EMPTY', '标签分组名称');
    if (this.db.prepare('SELECT 1 FROM project_tag_groups WHERE name = ? AND id <> ?').get(name, id)) {
      throw new ValidationError('PROJECT_TAG_GROUP_NAME_DUPLICATE', `标签分组名称已存在: ${name}`);
    }
    this.db.prepare('UPDATE project_tag_groups SET name = ? WHERE id = ?').run(name, id);
    return { ...group, name, tags: [] };
  }

  renameTag(id: string, input: { name: string }): ProjectTagDto {
    const tag = this.db.prepare('SELECT id,group_id,name,sort_order FROM project_tag_definitions WHERE id = ?').get(id) as
      { id: string; group_id: string; name: string; sort_order: number } | undefined;
    if (!tag) throw new ValidationError('PROJECT_TAG_UNKNOWN_TAG', `标签不存在: ${id}`);
    const name = trimRequired(input.name, 'PROJECT_TAG_NAME_EMPTY', '标签名称');
    if (this.db.prepare('SELECT 1 FROM project_tag_definitions WHERE group_id = ? AND name = ? AND id <> ?').get(tag.group_id, name, id)) {
      throw new ValidationError('PROJECT_TAG_NAME_DUPLICATE', `标签名称已存在: ${name}`);
    }
    this.db.prepare('UPDATE project_tag_definitions SET name = ? WHERE id = ?').run(name, id);
    return { id: tag.id, groupId: tag.group_id, name, sortOrder: tag.sort_order };
  }

  replaceSet(projectId: string, inputTagIds: readonly string[]): { tagIds: readonly string[]; groupedTags: readonly ProjectTagGroupSummaryDto[] } {
    if (!this.projectExists(projectId)) throw new ValidationError('PROJECT_TAG_UNKNOWN_PROJECT', `项目不存在: ${projectId}`);
    const tagIds = [...new Set(inputTagIds)];
    for (const id of tagIds) {
      if (!this.db.prepare('SELECT 1 FROM project_tag_definitions WHERE id = ?').get(id)) {
        throw new ValidationError('PROJECT_TAG_UNKNOWN_TAG', `标签不存在: ${id}`);
      }
    }
    this.db.prepare('DELETE FROM project_tag_assignments WHERE project_id = ?').run(projectId);
    const insert = this.db.prepare('INSERT INTO project_tag_assignments (project_id,tag_id) VALUES (?,?)');
    for (const id of tagIds) insert.run(projectId, id);
    return { tagIds: this.tagIdsFor(projectId), groupedTags: this.groupedTagsFor(projectId) };
  }

  tagIdsFor(projectId: string): readonly string[] {
    return (this.db.prepare(`SELECT d.id FROM project_tag_assignments a JOIN project_tag_definitions d ON d.id=a.tag_id JOIN project_tag_groups g ON g.id=d.group_id WHERE a.project_id=? ORDER BY g.sort_order,g.id,d.sort_order,d.id`).all(projectId) as Array<{ id: string }>).map((r) => r.id);
  }

  groupedTagsFor(projectId: string): readonly ProjectTagGroupSummaryDto[] {
    const rows = this.db.prepare(`SELECT g.id group_id,g.name group_name,d.id tag_id,d.name tag_name FROM project_tag_assignments a JOIN project_tag_definitions d ON d.id=a.tag_id JOIN project_tag_groups g ON g.id=d.group_id WHERE a.project_id=? ORDER BY g.sort_order,g.id,d.sort_order,d.id`).all(projectId) as Array<{ group_id:string; group_name:string; tag_id:string; tag_name:string }>;
    const result: ProjectTagGroupSummaryDto[] = [];
    for (const row of rows) {
      let group = result.at(-1);
      if (!group || group.groupId !== row.group_id) { group = { groupId: row.group_id, groupName: row.group_name, tagIds: [], tagNames: [] }; result.push(group); }
      (group.tagIds as string[]).push(row.tag_id); (group.tagNames as string[]).push(row.tag_name);
    }
    return result;
  }

  private groups(): readonly ProjectTagGroupDto[] {
    const groups = (this.db.prepare('SELECT id,name,sort_order FROM project_tag_groups ORDER BY sort_order,id').all() as Array<{id:string;name:string;sort_order:number}>).map((r) => ({ id:r.id, name:r.name, sortOrder:r.sort_order, tags: [] as readonly ProjectTagDto[] }));
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const row of this.db.prepare('SELECT id,group_id,name,sort_order FROM project_tag_definitions ORDER BY group_id,sort_order,id').all() as Array<{id:string;group_id:string;name:string;sort_order:number}>) {
      const group = byId.get(row.group_id); if (group) (group.tags as ProjectTagDto[]).push({ id:row.id, groupId:row.group_id, name:row.name, sortOrder:row.sort_order });
    }
    return groups;
  }
  private group(id: string): Omit<ProjectTagGroupDto, 'tags'> | undefined { const r=this.db.prepare('SELECT id,name,sort_order FROM project_tag_groups WHERE id=?').get(id) as {id:string;name:string;sort_order:number}|undefined; return r && {id:r.id,name:r.name,sortOrder:r.sort_order}; }
  private projectExists(id: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)); }
  private nextOrder(table: 'project_tag_groups' | 'project_tag_definitions', groupId: string): number { const sql=table === 'project_tag_groups' ? 'SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM project_tag_groups' : 'SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM project_tag_definitions WHERE group_id=?'; return Number((this.db.prepare(sql).get(...(groupId ? [groupId] : [])) as {n:number}).n); }
  private revision(): number { return Number((this.db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get() as {business_revision:number}).business_revision); }

  /** 已有事务时复用它；否则用本地读事务将 catalog 的多次查询固定在同一 WAL 快照。 */
  private withReadSnapshot<T>(read: () => T): T {
    if (this.db.isTransaction) return read();
    this.db.exec('BEGIN');
    try {
      const result = read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original read error.
      }
      throw error;
    }
  }
}
