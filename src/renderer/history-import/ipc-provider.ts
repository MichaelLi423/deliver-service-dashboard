import type {
  ImportWizardApi,
  ImportWizardProgressEventDto,
  ImportWizardSubmitResultDto,
  ImportWizardWorkspaceDto,
} from '../../shared/ipc';
import type {
  ColumnMapping,
  EccSummary,
  FinalImportSummary,
  HistoryImportCategory,
  HistoryImportDraftSummary,
  HistoryImportProgressEvent,
  HistoryImportRecoveryState,
  HistoryImportSubmitResult,
  HistoryImportWizardProvider,
  HistoryImportWorkspace,
  ImportCategorySummary,
  ImportIssue,
  ImportOperation,
  ImportSheetSummary,
  ImportStepSummary,
  WizardStepId,
} from './provider';
import type { GridWindowRequest, GridWindowResult, VirtualGridRow, VirtualGridWindowProvider } from './virtual-grid';

/**
 * 纯 IPC provider adapter（tasks 8.50：renderer 只经 preload 的最小语义 API 访问）。
 *
 * - 所有数据操作经 window.workbench.importWizard IPC 通道，由主进程编排工作区/worker/校验/封存/提交；
 * - 不暴露任何文件系统路径、数据库连接、worker 或内部路径能力；
 * - 金额/摘要一律为十进制字符串（DTO 与 renderer 类型结构一致，直接透传，不参与金额运算）；
 * - 网格窗口经 queryRows 分页（renderer 不持有整份大草稿）；
 * - Oracle 复审 #4：undo/redo 完全由后端磁盘 checkpoint 提供（所有可变操作 pre/post 成对），
 *   renderer 不保存任何敏感旧值。
 */

type WorkbenchWindow = { workbench: { importWizard: ImportWizardApi } };

function api(): ImportWizardApi {
  return (window as unknown as WorkbenchWindow).workbench.importWizard;
}

const WORKSPACE_KEYS = [
  'draft', 'username', 'templateVersion', 'currentStep', 'steps', 'categories',
  'sheets', 'mappings', 'issues', 'ecc', 'summary', 'operation',
] as const;

/** DTO 与 renderer 类型结构一致：做一次受约束的运行时形状校验后直接透传。 */
function assertShape<T>(value: unknown, keys: readonly string[], label: string): T {
  if (value === null || typeof value !== 'object') {
    throw new Error(`IPC DTO 形状异常：${label} 不是对象`);
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in record)) throw new Error(`IPC DTO 形状异常：${label} 缺少字段 ${key}`);
  }
  return value as T;
}

function draftFromDto(dto: ImportWizardWorkspaceDto['draft']): HistoryImportDraftSummary {
  return dto as unknown as HistoryImportDraftSummary;
}

function workspaceFromDto(dto: ImportWizardWorkspaceDto): HistoryImportWorkspace {
  assertShape(dto, WORKSPACE_KEYS, 'workspace');
  return {
    draft: draftFromDto(dto.draft),
    username: dto.username,
    templateVersion: dto.templateVersion,
    currentStep: dto.currentStep as WizardStepId,
    steps: dto.steps as readonly ImportStepSummary[],
    categories: dto.categories as readonly ImportCategorySummary[],
    sheets: dto.sheets as readonly ImportSheetSummary[],
    mappings: dto.mappings as readonly ColumnMapping[],
    issues: dto.issues as readonly ImportIssue[],
    ecc: dto.ecc as readonly EccSummary[],
    summary: dto.summary as FinalImportSummary | null,
    operation: dto.operation as ImportOperation | null,
  };
}

function submitFromDto(dto: ImportWizardSubmitResultDto): HistoryImportSubmitResult {
  return {
    status: dto.status,
    title: dto.title,
    message: dto.message,
    importedCounts: dto.importedCounts,
  };
}

/**
 * 历史数据导入向导纯 IPC provider（不经任何领域/数据库/worker 直连）。
 * 会话失效时主进程抛「登录状态已失效」错误，由 wizard 转为 HistoryImportSessionExpiredError 语义。
 */
export class IpcHistoryImportProvider implements HistoryImportWizardProvider {
  private readonly importWizard: ImportWizardApi;
  /** 主进程进度事件订阅（operation id 去重；经受信窗口事件）。 */
  private readonly progressListeners = new Set<(event: ImportWizardProgressEventDto) => void>();
  private recovered = false;
  private recoveryState: HistoryImportRecoveryState = { recovered: [], pendingOutcome: [] };
  private readonly gridQueries = new Map<string, { businessKey: string | null; issueSeverity: 'error' | 'conflict' | 'warning' | null }>();

  constructor() {
    this.importWizard = api();
    this.importWizard.onProgress((event) => {
      for (const listener of this.progressListeners) listener(event);
    });
  }

  private async workspaceFrom(action: Promise<ImportWizardWorkspaceDto>): Promise<HistoryImportWorkspace> {
    const workspace = workspaceFromDto(await action);
    this.lastWorkspace = workspace;
    return workspace;
  }

  async listDrafts(): Promise<readonly HistoryImportDraftSummary[]> {
    if (!this.recovered) {
      await this.recover();
    }
    const drafts = await this.importWizard.listDrafts();
    return drafts.map((d) => d as unknown as HistoryImportDraftSummary);
  }

  async recover(): Promise<HistoryImportRecoveryState> {
    if (!this.recovered) {
      const result = await this.importWizard.recover();
      this.recoveryState = { recovered: result.recovered, pendingOutcome: result.pendingOutcome };
      this.recovered = true;
    }
    return this.recoveryState;
  }

  settleInterrupted(draftId: string): Promise<HistoryImportSubmitResult> {
    return this.importWizard.settleInterrupted(draftId).then((dto) => {
      this.recoveryState = { ...this.recoveryState, pendingOutcome: this.recoveryState.pendingOutcome.filter((id) => id !== draftId) };
      return submitFromDto(dto);
    });
  }

  createDraft(): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.createDraft());
  }

  openDraft(draftId: string): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.openDraft(draftId));
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.importWizard.deleteDraft(draftId);
  }

  saveDraft(draftId: string, currentStep: WizardStepId): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.saveStep(draftId, currentStep));
  }

  downloadTemplate(): Promise<{ saved: boolean; version: string }> {
    return this.importWizard.downloadTemplate();
  }

  selectFiles(draftId: string): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.selectFiles(draftId));
  }

  pasteIntoCategory(draftId: string, category: HistoryImportCategory, headerConfirmed: boolean): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.pasteIntoCategory(draftId, category, headerConfirmed));
  }

  classifySheet(draftId: string, sheetId: string, category: HistoryImportCategory | 'excluded'): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.classifySheet(draftId, sheetId, category));
  }

  setCategoryMode(draftId: string, category: HistoryImportCategory, mode: 'data' | 'none'): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.setCategoryMode(draftId, category, mode));
  }

  async updateMapping(draftId: string, mappingId: string, target: string | null): Promise<HistoryImportWorkspace> {
    // 后端以 pre/post checkpoint 覆盖列映射编辑（renderer 不保存敏感旧值）。
    return this.workspaceFrom(this.importWizard.updateMapping(draftId, mappingId, target));
  }

  getGridProvider(draftId: string, category: HistoryImportCategory): VirtualGridWindowProvider {
    return {
      readWindow: async (request: GridWindowRequest): Promise<GridWindowResult> => {
        const query = {
          businessKey: request.search || request.filter.ecc || null,
          issueSeverity: request.filter.issueKind && request.filter.issueKind !== 'all' ? request.filter.issueKind : null,
        };
        this.gridQueries.set(`${draftId}:${category}`, query);
        const windowDto = await this.importWizard.queryRows({
          draftId,
          category,
          offset: request.offset,
          limit: request.limit,
          businessKey: query.businessKey,
          issueSeverity: query.issueSeverity,
        });
        const rows: VirtualGridRow[] = windowDto.rows.map((row) => ({
          id: row.id,
          values: { ...row.values },
          issues: row.issues?.map((issue) => ({
            id: issue.id,
            kind: issue.kind,
            message: issue.message,
            rowIndex: issue.rowIndex,
            columnId: issue.columnId,
            source: issue.source,
          })),
          readOnlyColumns: row.readOnlyColumns,
        }));
        return { rows, total: windowDto.total };
      },
      search: async (query) => {
        const result = await this.importWizard.queryRows({ draftId, category, offset: 0, limit: 1, businessKey: query || null, issueSeverity: null });
        if (!result.rows.length) return null;
        const key = result.rows[0]?.values.ecc !== undefined ? 'ecc' : undefined;
        return { rowIndex: 0, columnId: key };
      },
      locateIssue: async (issueId) => {
        const issue = this.lastWorkspace?.draft.id === draftId ? this.lastWorkspace.issues.find((item) => item.id === issueId && item.category === category) : undefined;
        return issue ? { rowIndex: issue.rowIndex, columnId: issue.columnId } : null;
      },
    };
  }

  private lastWorkspace: HistoryImportWorkspace | null = null;

  async patchGrid(
    draftId: string,
    category: HistoryImportCategory,
    patches: readonly { rowIndex: number; rowId?: string; columnId: string; value: string }[],
  ): Promise<HistoryImportWorkspace> {
    // 后端以 pre/post checkpoint 覆盖单元格编辑（renderer 不保存敏感旧值）。
    return this.workspaceFrom(this.importWizard.patchCells(draftId, category, patches));
  }

  async addGridRow(draftId: string, category: HistoryImportCategory): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.addRow(draftId, category));
  }

  async deleteRows(draftId: string, category: HistoryImportCategory, selection: { startRow: number; endRow: number }): Promise<HistoryImportWorkspace> {
    const start = Math.max(0, Math.min(selection.startRow, selection.endRow));
    const end = Math.max(start, Math.max(selection.startRow, selection.endRow));
    const ids: string[] = [];
    const query = this.gridQueries.get(`${draftId}:${category}`) ?? { businessKey: null, issueSeverity: null };
    for (let offset = start; offset <= end; offset += 200) {
      const result = await this.importWizard.queryRows({ draftId, category, offset, limit: Math.min(200, end - offset + 1), ...query });
      ids.push(...result.rows.map((row) => row.id));
    }
    // 删除既有来源行前 backend 已建立磁盘 checkpoint（含原位置/来源/只读元数据），可整体 undo/redo。
    return this.workspaceFrom(this.importWizard.deleteRows(draftId, category, ids));
  }

  async undo(draftId: string): Promise<HistoryImportWorkspace> {
    // Oracle 复审 #4：所有可变操作均由后端 pre/post checkpoint 覆盖，undo 严格最后操作优先；
    // renderer 不保存敏感旧值。无可撤销时返回当前工作区。
    const backend = await this.importWizard.undo(draftId);
    if (backend) return workspaceFromDto(backend);
    return this.workspaceFrom(this.importWizard.summary(draftId));
  }

  async redo(draftId: string): Promise<HistoryImportWorkspace> {
    const backend = await this.importWizard.redo(draftId);
    if (backend) return workspaceFromDto(backend);
    return this.workspaceFrom(this.importWizard.summary(draftId));
  }

  validate(draftId: string): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.validate(draftId));
  }

  cancelOperation(draftId: string, operationId: string): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.cancelOperation(draftId, operationId));
  }

  resolveConflict(draftId: string, issueId: string, value: string): Promise<HistoryImportWorkspace> {
    return this.workspaceFrom(this.importWizard.saveConflictDecision(draftId, issueId, value));
  }

  submit(draftId: string, _seal: string): Promise<HistoryImportSubmitResult> {
    return this.importWizard.commit(draftId, _seal).then((dto) => submitFromDto(dto));
  }

  /** 订阅主进程进度事件（经受信窗口事件；返回取消订阅函数）。 */
  subscribeProgress(listener: (event: HistoryImportProgressEvent) => void): () => void {
    const ipcListener = listener as (event: ImportWizardProgressEventDto) => void;
    this.progressListeners.add(ipcListener);
    return () => {
      this.progressListeners.delete(ipcListener);
    };
  }
}
