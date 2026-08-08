import { DomainError } from '../../../core/errors';

/**
 * 导入工作区错误边界（design D20 / tasks 8.9~8.14）。
 *
 * 工作区是 app-private 的独立 SQLite 数据库，与正式业务库物理隔离；
 * 本模块绝不接收正式业务库连接，因此任何工作区失败都只会禁用导入功能，
 * 不会影响正常业务库的读写。所有工作区失败统一以 WorkspaceError 子类表达，
 * 主进程可捕获后仅禁用导入入口。
 */
export class WorkspaceError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'WorkspaceError';
  }
}

/** 工作区文件损坏或不可读（导入功能禁用，正式业务库不受影响）。 */
export class WorkspaceCorruptionError extends WorkspaceError {
  constructor(message: string) {
    super('WORKSPACE_CORRUPTED', message);
    this.name = 'WorkspaceCorruptionError';
  }
}

/** 工作区 schema 版本不兼容（数据库版本高于当前应用支持的版本）。 */
export class WorkspaceVersionError extends WorkspaceError {
  constructor(message: string) {
    super('WORKSPACE_VERSION_INCOMPATIBLE', message);
    this.name = 'WorkspaceVersionError';
  }
}

/** 工作区 schema 迁移失败（原库与迁移前备份保留，可恢复；正式业务库不受影响）。 */
export class WorkspaceMigrationError extends WorkspaceError {
  constructor(message: string) {
    super('WORKSPACE_MIGRATION_FAILED', message);
    this.name = 'WorkspaceMigrationError';
  }
}

/** 乐观修订冲突：草稿已被较新修订修改，禁止覆盖较新草稿。 */
export class RevisionConflictError extends WorkspaceError {
  constructor(message: string) {
    super('REVISION_CONFLICT', message);
    this.name = 'RevisionConflictError';
  }
}

/** 非法状态转换。 */
export class WorkspaceStateError extends WorkspaceError {
  constructor(message: string) {
    super('WORKSPACE_STATE_ILLEGAL', message);
    this.name = 'WorkspaceStateError';
  }
}

/** 草稿或引用行不存在。 */
export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(message: string) {
    super('WORKSPACE_NOT_FOUND', message);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** 将底层 SQLite 错误映射为工作区错误（唯一约束等）。 */
export function mapWorkspaceDbError(err: unknown): Error {
  if (err instanceof WorkspaceError) return err;
  if (err instanceof Error) {
    const e = err as { errcode?: number; message?: string };
    if (e?.errcode === 2067) {
      return new WorkspaceError('WORKSPACE_UNIQUE_VIOLATION', `工作区唯一约束冲突: ${e?.message ?? ''}`);
    }
    return new WorkspaceError('WORKSPACE_DB_ERROR', e?.message ?? String(err));
  }
  return new WorkspaceError('WORKSPACE_DB_ERROR', String(err));
}
