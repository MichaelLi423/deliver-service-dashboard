import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../../core/errors';
import type { ProjectRepository } from './project-service';
import { ProjectService } from './project-service';

/** 验收事实的受保护删除入口；状态重算始终委派 ProjectService/lifecycle。 */
export class ProtectedProjectDeletionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly projects: ProjectRepository,
    private readonly projectService: ProjectService,
  ) {}

  clearAcceptance(projectId: string): { fromStatus: string; toStatus: string } {
    const project = this.projects.findById(projectId);
    if (!project) throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    if (this.hasInvoiceHistory(projectId)) {
      throw new ValidationError('ACCEPTANCE_DELETE_DEPENDENCIES', '该项目存在掉票历史（含已撤销），验收报告不可删除；掉票闭环事实不可逆回退');
    }
    const fromStatus = project.status;
    this.projectService.clearAcceptance(projectId, {
      hasAnyInvoiceHistory: false,
      executionStarted: this.executionStarted(projectId),
    });
    return { fromStatus, toStatus: this.projects.findById(projectId)!.status };
  }

  private hasInvoiceHistory(projectId: string): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?').get(projectId) as { n: number }).n > 0;
  }

  private executionStarted(projectId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM batches WHERE project_id = ? AND started_at IS NOT NULL LIMIT 1').get(projectId)) return true;
    return this.db.prepare('SELECT 1 FROM work_facts wf JOIN activities a ON a.id = wf.activity_id WHERE a.project_id = ? LIMIT 1').get(projectId) !== undefined;
  }
}
