import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SystemClock, type Clock } from '../domain/core/time';
import type { AccountSessionInfo, ImportWizardCategory, ImportWizardCategoryMode, ImportWizardDraftDto, ImportWizardEccDto, ImportWizardFinalSummaryDto, ImportWizardGridIssueDto, ImportWizardGridWindowDto, ImportWizardIssueDto, ImportWizardMappingDto, ImportWizardOperationDto, ImportWizardProgressEventDto, ImportWizardRecoverDto, ImportWizardRowWindowRequestDto, ImportWizardSheetDto, ImportWizardStepDto, ImportWizardStepId, ImportWizardSubmitResultDto, ImportWizardValidationCategoryDto, ImportWizardWorkspaceDto } from '../shared/ipc';
import type { OpenDialogOptions, OpenDialogResult, SaveDialogOptions, SaveDialogResult } from './ipc-handlers';
import { WorkspaceRepository, WorkspaceNotFoundError, WorkspaceStateError, decodeSheetId, encodeSheetId } from '../domain/capabilities/historical-data-import/workspace';
import type { ImportCategory, IssueInput } from '../domain/capabilities/historical-data-import/workspace';
import { IMPORT_CATEGORIES } from '../domain/capabilities/historical-data-import/workspace';
import type { NormalizedRow } from '../domain/capabilities/historical-data-import/normalized-row';
import type { AppendRowInput, CellPatch, ConflictDecisionInput, OperationKind, RowQuery } from '../domain/capabilities/historical-data-import/workspace';
import { fieldCatalogFor } from '../domain/capabilities/historical-data-import/field-catalog';
import { TEMPLATE_VERSION, generateTemplateWorkbook } from '../domain/capabilities/historical-data-import/template';
import { buildPlanFromRows } from '../domain/capabilities/historical-data-import/validation-kernel';
import { validatePlan, validateAffected } from '../domain/capabilities/historical-data-import/validation';
import type { ImportProblem } from '../domain/capabilities/historical-data-import/validation-model';
import { generateValidationSeal, toNormalizedRows } from '../domain/capabilities/historical-data-import/seal';
import { TargetConflictReader } from '../domain/capabilities/historical-data-import/target-reader';
import { BusinessWriteCoordinator, type CommitInput } from '../domain/capabilities/historical-data-import/commit-coordinator';
import { isImportCancelled, type ChunkWritePort, type ImportProgress } from '../domain/capabilities/historical-data-import/import-tasks';
import { preflightBatch, preflightXlsx, XlsxPreflightError, DEFAULT_XLSX_BATCH_LIMITS, type XlsxPreflightResult } from '../domain/capabilities/historical-data-import/zip-preflight';
import type { ImportWorkerLike, ImportWorkerTaskOptions } from '../domain/capabilities/historical-data-import/import-worker/import-worker-host';
import type { FileWorkerRunParams, PasteWorkerRunParams } from '../domain/capabilities/historical-data-import/import-worker/import-worker-protocol';
import { parsePasteText, confirmFirstRowAsHeader } from '../domain/capabilities/historical-data-import/paste-parser';
import { formatCents } from '../domain/core/money';

/**
 * 历史数据导入向导主进程编排（tasks 8.49/8.51/8.52/8.53）。
 *
 * - 编排工作区（WorkspaceRepository）、worker（文件/粘贴规范化）、校验/seal、
 *   commit coordinator；所有入口由 ipc-handlers 统一 requireSessionAndSender 守卫；
 * - 草稿访问校验：不存在 / 终态草稿拒绝；
 * - dialog 只返回展示元数据/结果，不回传可复用路径；金额一律十进制字符串；
 * - 进度经受信窗口事件（emitProgress）；operation id 去重，解析/校验可取消并回滚
 *   到最后稳定修订，提交不可取消成部分业务状态；
 * - 会话失效：取消活动读取、保留最后修订、invalidate seal（重登录须完整校验）。
 */

/** 领域 7 类 → 渲染层类别。 */
export const RENDERER_CATEGORY: Record<ImportCategory, ImportWizardCategory> = {
  project: 'projects',
  service_order: 'serviceOrders',
  invoice: 'invoices',
  logistics_fee: 'logistics',
  serial_address_update: 'serialAddresses',
  qr_request: 'qrRequests',
  ship_to_request: 'shipToRequests',
};

export const DOMAIN_CATEGORY: Record<ImportWizardCategory, ImportCategory> = {
  projects: 'project',
  serviceOrders: 'service_order',
  invoices: 'invoice',
  logistics: 'logistics_fee',
  serialAddresses: 'serial_address_update',
  qrRequests: 'qr_request',
  shipToRequests: 'ship_to_request',
};

const STEP_CATEGORIES: Record<ImportWizardStepId, readonly ImportCategory[]> = {
  prepare: [],
  projects: ['project'],
  orders: ['service_order'],
  finance: ['invoice', 'logistics_fee'],
  serials: ['serial_address_update'],
  requests: ['qr_request', 'ship_to_request'],
  review: [],
};

const STEP_OF_CATEGORY: Record<ImportCategory, ImportWizardStepId> = {
  project: 'projects',
  service_order: 'orders',
  invoice: 'finance',
  logistics_fee: 'finance',
  serial_address_update: 'serials',
  qr_request: 'requests',
  ship_to_request: 'requests',
};

const OPERATION_KIND_TO_RENDERER: Record<OperationKind, 'reading' | 'normalizing' | 'validating' | 'submitting'> = {
  parsing: 'normalizing',
  validating: 'validating',
  committing: 'submitting',
};

export interface ImportWizardFacadeDeps {
  workspaceDir: string;
  /** 打开（或重连）工作区数据库；损坏/不兼容时抛 WorkspaceError（仅禁用导入）。 */
  workspaceDb(): DatabaseSync;
  businessDb(): DatabaseSync;
  /** 提交前安全快照目录。 */
  snapshotDir(): string;
  session(): AccountSessionInfo | null;
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
  readFile(filePath: string): Promise<Buffer>;
  /** 文件大小 stat（Oracle 最终复核 #4：readFile 前累计实际大小，超限零 readFile）。 */
  statFile(filePath: string): Promise<{ size: number }>;
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>;
  /** 主进程剪贴板纯文本（无渲染层剪贴板/路径能力）。 */
  clipboardText(): string;
  /** 文件/粘贴规范化任务（默认 worker；测试可注入进程内实现）。
   *  params 只携带可跨线程克隆字段（FileWorkerRunParams/PasteWorkerRunParams）；
   *  writer / onProgress / signal 经第三参 options 由宿主持有，禁止进入 params
   *  （否则真实打包 postMessage 触发 DataCloneError）。 */
  runFileTask(params: FileWorkerRunParams, writer: ChunkWritePort, options: ImportWorkerTaskOptions): Promise<import('../domain/capabilities/historical-data-import/import-tasks').ImportFileTaskResult>;
  runPasteTask(params: PasteWorkerRunParams, writer: ChunkWritePort, options: ImportWorkerTaskOptions): Promise<import('../domain/capabilities/historical-data-import/import-tasks').ImportPasteTaskResult>;
  createWorker?(): ImportWorkerLike;
  /** 进度事件（经受信窗口 webContents.send 推送）。 */
  emitProgress(event: ImportWizardProgressEventDto): void;
}

interface ActiveTask {
  operationId: string;
  kind: OperationKind;
  abort: AbortController;
  promise: Promise<unknown>;
}

interface DraftProgress {
  step?: ImportWizardStepId;
}

interface ProgressFile {
  drafts: Record<string, DraftProgress>;
}

export class ImportWizardFacade {
  private readonly coordinator = new BusinessWriteCoordinator();
  /** 进行中的草稿操作（解析/校验/提交）；key = draftId。 */
  private readonly active = new Map<string, ActiveTask>();
  private progressFileCache: ProgressFile | null = null;
  /** 当前会话 token（Oracle 复审 #5）：会话失效/登出时置空，使提交资格失效。 */
  private sessionToken: string | null = null;

  constructor(
    private readonly deps: ImportWizardFacadeDeps,
    private readonly now: Clock = new SystemClock(),
  ) {}

  // ------------------------------------------------------------------ 草稿生命周期

  listDrafts(): ImportWizardDraftDto[] {
    return this.repo().listDrafts().map((d) => this.toDraftDto(d.id, d.totalRows));
  }

  createDraft(): ImportWizardWorkspaceDto {
    const session = this.requireSession();
    const draft = this.repo().createDraft({
      name: `历史导入 ${this.now.today()}`,
      createdBy: session.accountId,
      createdByUsername: session.username,
    });
    this.setDraftProgress(draft.id, { step: 'prepare' });
    return this.workspace(draft.id);
  }

  openDraft(draftId: string): ImportWizardWorkspaceDto {
    const draft = this.requireDraft(draftId);
    if (draft.state === 'succeeded' || draft.state === 'cancelled') {
      throw new Error(`草稿已${draft.state === 'succeeded' ? '导入成功' : '取消'}，不可继续编辑`);
    }
    return this.workspace(draftId);
  }

  deleteDraft(draftId: string): void {
    this.requireDraft(draftId);
    const active = this.active.get(draftId);
    if (active) active.abort.abort();
    this.active.delete(draftId);
    this.repo().deleteDraft(draftId);
    this.clearDraftProgress(draftId);
  }

  saveStep(draftId: string, step: ImportWizardStepId): ImportWizardWorkspaceDto {
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    this.setDraftProgress(draftId, { step });
    return this.workspace(draftId);
  }

  // ------------------------------------------------------------------ 输入：模板 / 文件 / 粘贴

  async downloadTemplate(): Promise<{ saved: boolean; version: string }> {
    const buffer = await generateTemplateWorkbook();
    const result = await this.deps.showSaveDialog({
      title: '保存空白模板',
      defaultPath: `搬迁服务历史数据导入模板-v${TEMPLATE_VERSION}.xlsx`,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false, version: String(TEMPLATE_VERSION) };
    await this.deps.writeFile(result.filePath, buffer);
    return { saved: true, version: String(TEMPLATE_VERSION) };
  }

  async selectFiles(draftId: string): Promise<ImportWizardWorkspaceDto> {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    this.rejectBusy(draftId, '已有文件读取/校验在处理中');
    const result = await this.deps.showOpenDialog({
      title: '选择一个或多个 Excel 文件',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return this.workspace(draftId);
    }
    const files = result.filePaths;
    // Oracle 二次复审 #5：读取前先拒绝超过 20 个文件（零 readFile）。
    if (files.length > DEFAULT_XLSX_BATCH_LIMITS.maxFiles) {
      throw new XlsxPreflightError(
        { ok: false, violations: [{ code: 'TOO_MANY_ENTRIES', message: `输入文件数 ${files.length} 超过上限 ${DEFAULT_XLSX_BATCH_LIMITS.maxFiles}` }], entries: 0, fileBytes: 0, totalCompressedBytes: 0, totalUncompressedBytes: 0, sheetCount: 0, dateSystem: '1900' },
        '跨文件批次超过文件数上限',
      );
    }
    // Oracle 最终复核 #4：readFile 前逐文件 stat 并累计实际大小，超限立即拒绝（零 readFile）。
    let declaredBytes = 0;
    for (const filePath of files) {
      declaredBytes += (await this.deps.statFile(filePath)).size;
      if (declaredBytes > DEFAULT_XLSX_BATCH_LIMITS.maxTotalCompressedBytes) {
        throw new XlsxPreflightError(
          { ok: false, violations: [{ code: 'ZIP_TOO_LARGE', message: `文件 stat 大小合计 ${declaredBytes} 字节超过上限 ${DEFAULT_XLSX_BATCH_LIMITS.maxTotalCompressedBytes}` }], entries: 0, fileBytes: declaredBytes, totalCompressedBytes: declaredBytes, totalUncompressedBytes: 0, sheetCount: 0, dateSystem: '1900' },
          '跨文件 stat 大小超过合计上限，未读取任何文件',
        );
      }
    }
    // 顺序读取 + 增量预检：按实际 buffer.byteLength 累计压缩输入 250MiB；
    // 每份 preflight 后累计展开 1GiB；任一起过立即停止且不再 readFile（读取后二次校验）。
    const buffers: Buffer[] = [];
    const preflights: XlsxPreflightResult[] = [];
    let totalInputBytes = 0;
    let totalUncompressed = 0;
    for (const filePath of files) {
      const buffer = await this.deps.readFile(filePath);
      totalInputBytes += buffer.byteLength;
      if (totalInputBytes > DEFAULT_XLSX_BATCH_LIMITS.maxTotalCompressedBytes) {
        throw new XlsxPreflightError(
          { ok: false, violations: [{ code: 'ZIP_TOO_LARGE', message: `压缩输入合计 ${totalInputBytes} 字节超过上限 ${DEFAULT_XLSX_BATCH_LIMITS.maxTotalCompressedBytes}` }], entries: 0, fileBytes: totalInputBytes, totalCompressedBytes: totalInputBytes, totalUncompressedBytes: 0, sheetCount: 0, dateSystem: '1900' },
          '跨文件压缩输入超过合计上限，立即停止',
        );
      }
      const pre = await preflightXlsx(buffer);
      if (!pre.ok) {
        throw new XlsxPreflightError(pre, `文件「${filePath}」未通过有界预检`);
      }
      preflights.push(pre);
      totalUncompressed += pre.totalUncompressedBytes;
      if (totalUncompressed > DEFAULT_XLSX_BATCH_LIMITS.maxTotalUncompressedBytes) {
        throw new XlsxPreflightError(
          { ok: false, violations: [{ code: 'TOTAL_UNCOMPRESSED_TOO_LARGE', message: `展开合计 ${totalUncompressed} 字节超过上限 ${DEFAULT_XLSX_BATCH_LIMITS.maxTotalUncompressedBytes}` }], entries: 0, fileBytes: totalInputBytes, totalCompressedBytes: totalInputBytes, totalUncompressedBytes: totalUncompressed, sheetCount: 0, dateSystem: '1900' },
          '跨文件展开量超过合计上限，立即停止',
        );
      }
      buffers.push(buffer);
    }
    // preflightBatch 使用实际 fileBytes（byteLength）与每份 preflight 展开量。
    const batchViolations = preflightBatch(
      buffers.map((buffer, index) => ({
        fileName: files[index]!,
        fileBytes: buffer.byteLength,
        totalCompressedBytes: buffer.byteLength,
        totalUncompressedBytes: preflights[index]!.totalUncompressedBytes,
      })),
    );
    if (batchViolations.length > 0) {
      throw new XlsxPreflightError(
        { ok: false, violations: batchViolations, entries: 0, fileBytes: totalInputBytes, totalCompressedBytes: totalInputBytes, totalUncompressedBytes: totalUncompressed, sheetCount: 0, dateSystem: '1900' },
        '跨文件批次超过合计上限，拒绝读取',
      );
    }
    // 进入 parsing 运行态：取消时 recoverRuntimeStates 回滚到最后稳定修订。
    const revision = this.enterParsing(repo, draftId, repo.getDraft(draftId)!.revision);
    const op = repo.createOperation(draftId, 'parsing');
    const abort = new AbortController();
    const promise = this.runFileSelection(draftId, op.id, files, buffers, abort.signal, revision);
    this.active.set(draftId, { operationId: op.id, kind: 'parsing', abort, promise });
    try {
      await promise;
      this.active.delete(draftId);
    } catch (error) {
      this.active.delete(draftId);
      this.finishOperation(draftId, op.id, isImportCancelled(error) ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
      // 解析失败/取消：回滚部分写入到最后稳定修订（不形成部分 merge）。
      this.repo().recoverRuntimeStates();
      throw error;
    }
    return this.workspace(draftId);
  }

  private async runFileSelection(
    draftId: string,
    operationId: string,
    files: string[],
    buffers: Buffer[],
    signal: AbortSignal,
    initialRevision: number,
  ): Promise<void> {
    let revision = initialRevision;
    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index]!;
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
      const buffer = buffers[index]!;
      const writer = this.chunkWriter();
      // 只构造可跨线程克隆字段；writer/onProgress/signal 经 options 由宿主持有。
      const params: FileWorkerRunParams = {
        draftId,
        expectedRevision: revision,
        buffer,
        fileName,
      };
      const task = await this.deps.runFileTask(params, writer, {
        signal,
        createWorker: this.deps.createWorker,
        onProgress: (p) => this.reportTaskProgress(draftId, operationId, p),
      });
      revision = this.repo().getDraft(draftId)?.revision ?? task.newRevision;
      this.repo().addSource(draftId, {
        sourceKind: 'file',
        sourceFile: fileName,
        sourceHash: task.rawDigest,
        rowCount: task.fileRows,
      });
    }
    // 解析完成 → needs_review（可编辑/校验）。
    this.repo().transitionState(draftId, this.repo().getDraft(draftId)!.revision, 'parsing_finished');
    this.finishOperation(draftId, operationId, 'completed', '文件读取完成');
  }

  async pasteIntoCategory(draftId: string, category: ImportWizardCategory, headerConfirmed: boolean): Promise<ImportWizardWorkspaceDto> {
    this.requireDraft(draftId);
    this.rejectBusy(draftId, '已有文件读取/校验在处理中');
    const text = this.deps.clipboardText();
    if (!text || text.trim() === '') {
      throw new Error('剪贴板没有可粘贴的纯文本内容');
    }
    const domainCategory = DOMAIN_CATEGORY[category];
    const existing = this.repo().queryRows(draftId, { category: domainCategory, offset: 0, limit: 10_000_000 });
    // 粘贴前建立 pre checkpoint（整体 undo/redo；含类别模式）。
    const repo = this.repo();
    const pairId = `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const preRevision = repo.getDraft(draftId)!.revision;
    repo.createCheckpoint(draftId, preRevision, {
      kind: 'pre',
      pairId,
      label: '粘贴',
      modes: this.declaredModes(draftId),
    });
    // 进入 parsing 运行态：取消时回滚到最后稳定修订。
    const revision = this.enterParsing(repo, draftId, repo.getDraft(draftId)!.revision);
    const op = repo.createOperation(draftId, 'parsing');
    const abort = new AbortController();
    const promise = this.runPasteTask(draftId, op.id, domainCategory, text, headerConfirmed, existing.total, abort.signal, revision);
    this.active.set(draftId, { operationId: op.id, kind: 'parsing', abort, promise });
    try {
      await promise;
      this.active.delete(draftId);
      // 成功后建立 post checkpoint（redo 目标）。
      const postRev = repo.getDraft(draftId)!.revision;
      repo.createCheckpoint(draftId, postRev, {
        kind: 'post',
        pairId,
        label: '粘贴',
        modes: this.declaredModes(draftId),
      });
    } catch (error) {
      this.active.delete(draftId);
      this.finishOperation(draftId, op.id, isImportCancelled(error) ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
      // 解析失败/取消：回滚到最后稳定修订（不形成部分 merge），pre checkpoint 随之无效。
      this.repo().recoverRuntimeStates();
      throw error;
    }
    return this.workspace(draftId);
  }

  private async runPasteTask(
    draftId: string,
    operationId: string,
    category: ImportCategory,
    text: string,
    headerConfirmed: boolean,
    existingRows: number,
    signal: AbortSignal,
    initialRevision: number,
  ): Promise<void> {
    const parsed = parsePasteText(text);
    const withHeader = confirmFirstRowAsHeader(parsed, headerConfirmed);
    let revision = initialRevision;
    const writer = this.chunkWriter();
    // 只构造可跨线程克隆字段；writer/onProgress/signal 经 options 由宿主持有。
    const params: PasteWorkerRunParams = {
      draftId,
      expectedRevision: revision,
      category,
      text,
      headerConfirmed,
      append: true,
      existingRows,
      existingColumns: 0,
    };
    const task = await this.deps.runPasteTask(params, writer, {
      signal,
      createWorker: this.deps.createWorker,
      onProgress: (p) => this.reportTaskProgress(draftId, operationId, p),
    });
    revision = this.repo().getDraft(draftId)?.revision ?? task.newRevision;
    void withHeader;
    this.repo().addSource(draftId, {
      sourceKind: 'paste',
      sourceFile: '粘贴',
      sheet: null,
      sourceHash: task.rawDigest,
      rowCount: task.normalizedRows,
    });
    this.repo().transitionState(draftId, this.repo().getDraft(draftId)!.revision, 'parsing_finished');
    this.finishOperation(draftId, operationId, 'completed', '粘贴完成');
  }

  // ------------------------------------------------------------------ 归类 / 模式 / 映射

  classifySheet(draftId: string, sheetId: string, category: ImportWizardCategory | 'excluded'): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    // Oracle 最终复核 #1：sheet 标识为规范百分号编码（文件/表名含 '#' 也不歧义），解码为独立 file/sheet。
    const [file, sheet] = decodeSheetId(sheetId);
    // 归类前建立 pre checkpoint（Oracle 复审 #4：sheet 归类也可整体 undo/redo）。
    const pairId = this.newPairId();
    repo.createCheckpoint(draftId, draft.revision, { kind: 'pre', pairId, label: 'sheet 归类', modes: repo.getCategoryModes(draftId) });
    const classification = category === 'excluded' ? 'excluded' : DOMAIN_CATEGORY[category];
    const after = repo.setSheetClassification(draftId, draft.revision, file, sheet, classification);
    repo.createCheckpoint(draftId, after, { kind: 'post', pairId, label: 'sheet 归类', modes: repo.getCategoryModes(draftId) });
    return this.workspace(draftId);
  }

  setCategoryMode(draftId: string, category: ImportWizardCategory, mode: 'data' | 'none'): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    const domainCategory = DOMAIN_CATEGORY[category];
    // Oracle 复审 #2：mode=none 但该类别存在 rows 必须阻断（先明确删除或改为有数据）。
    if (mode === 'none' && draft.rowCounts[domainCategory] > 0) {
      throw new Error(`类别「${category}」存在 ${draft.rowCounts[domainCategory]} 行数据，不能声明为本次不导入；请先删除该类行或改为「有数据」`);
    }
    // 模式修改纳入 undo（Oracle 复审 #4：pre/post checkpoint + 同一事务恢复）。
    const pairId = this.newPairId();
    repo.createCheckpoint(draftId, draft.revision, { kind: 'pre', pairId, label: '类别模式', modes: repo.getCategoryModes(draftId) });
    const after = repo.setCategoryMode(draftId, draft.revision, domainCategory, mode);
    repo.createCheckpoint(draftId, after, { kind: 'post', pairId, label: '类别模式', modes: repo.getCategoryModes(draftId) });
    return this.workspace(draftId);
  }

  updateMapping(draftId: string, mappingId: string, target: string | null): ImportWizardWorkspaceDto {
    this.requireDraft(draftId);
    const repo = this.repo();
    const existing = repo.listMappings(draftId).find((m) => `${draftId}:${m.category}:${m.sourceColumn}` === mappingId);
    if (!existing) throw new WorkspaceNotFoundError(`列映射不存在: ${mappingId}`);
    const next: import('../domain/capabilities/historical-data-import/workspace').ColumnMapping = {
      category: existing.category,
      sourceColumn: existing.sourceColumn,
      targetField: target,
      mappingState: target === null ? 'ignored' : 'exact',
      sampleValue: existing.sampleValue,
      priority: existing.priority,
      sourcePriority: existing.sourcePriority,
    };
    this.withEditCheckpoints(draftId, '列映射', (revision) => {
      repo.saveMappings(draftId, revision, [
        ...repo.listMappings(draftId)
          .filter((m) => `${draftId}:${m.category}:${m.sourceColumn}` !== mappingId)
          .map((m) => ({
          category: m.category,
          sourceColumn: m.sourceColumn,
          targetField: m.targetField,
          mappingState: m.mappingState,
          sampleValue: m.sampleValue,
          priority: m.priority,
          sourcePriority: m.sourcePriority,
        })),
        next,
      ]);
      return revision;
    });
    return this.workspace(draftId);
  }

  private newPairId(): string {
    return `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ------------------------------------------------------------------ 网格窗口 / 编辑

  queryRows(request: ImportWizardRowWindowRequestDto): ImportWizardGridWindowDto {
    this.requireDraft(request.draftId);
    const query: RowQuery = {
      category: DOMAIN_CATEGORY[request.category],
      businessKey: request.businessKey ?? null,
      issueSeverity: request.issueSeverity ?? null,
      offset: request.offset,
      limit: request.limit,
    };
    const window = this.repo().queryRows(request.draftId, query);
    const issues = this.repo().listIssues(request.draftId);
    const issuesByRow = new Map<string, ImportWizardGridIssueDto[]>();
    for (const issue of issues) {
      if (!issue.rowId) continue;
      const list = issuesByRow.get(issue.rowId) ?? [];
      list.push({
        id: issue.id,
        kind: issue.severity,
        message: issue.message,
        rowIndex: Math.max(0, (issue.gridRow ?? 1) - 1),
        columnId: issue.field ?? '',
        source: issue.sourcePosition ?? undefined,
      });
      issuesByRow.set(issue.rowId, list);
    }
    return {
      rows: window.rows.map((row) => ({
        id: row.rowId,
        values: { ...row.cells },
        issues: issuesByRow.get(row.rowId),
      })),
      total: window.total,
      offset: window.offset,
      limit: window.limit,
    };
  }

  /** 统一编辑 checkpoints（Oracle 复审 #4）：所有可变操作（cell/mapping/add/delete/
   *  paste/category/sheet）都在后端建立 pre/post checkpoint，undo/redo 严格最后操作优先。 */
  private withEditCheckpoints<T>(draftId: string, label: string, fn: (revision: number) => T): T {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    const pairId = this.newPairId();
    repo.createCheckpoint(draftId, draft.revision, { kind: 'pre', pairId, label, modes: repo.getCategoryModes(draftId) });
    const result = fn(draft.revision);
    const after = repo.getDraft(draftId)!.revision;
    repo.createCheckpoint(draftId, after, { kind: 'post', pairId, label, modes: repo.getCategoryModes(draftId) });
    return result;
  }

  patchCells(draftId: string, category: ImportWizardCategory, patches: readonly { rowIndex: number; rowId?: string; columnId: string; value: string }[]): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    const window = repo.queryRows(draftId, { category: DOMAIN_CATEGORY[category], offset: 0, limit: 10_000_000 });
    const byGridRow = new Map(window.rows.map((r) => [r.gridRow, r]));
    const cellPatches: CellPatch[] = [];
    for (const patch of patches) {
      const row = patch.rowId ? window.rows.find((r) => r.rowId === patch.rowId) : byGridRow.get(patch.rowIndex + 1);
      if (!row) throw new WorkspaceNotFoundError(`网格行不存在: 第 ${patch.rowIndex + 1} 行`);
      cellPatches.push({ rowId: row.rowId, field: patch.columnId, value: patch.value === '' ? null : patch.value });
    }
    this.withEditCheckpoints(draftId, '单元格编辑', (revision) => {
      const newRev = repo.patchCells(draftId, revision, cellPatches);
      this.revalidateAffected(draftId, newRev, cellPatches.map((p) => p.rowId));
      return newRev;
    });
    return this.workspace(draftId);
  }

  addRow(draftId: string, category: ImportWizardCategory): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const blank: AppendRowInput = { rowId: `blank-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, cells: {} };
    this.withEditCheckpoints(draftId, '新增行', (revision) =>
      repo.appendRows(draftId, revision, DOMAIN_CATEGORY[category], [blank]),
    );
    return this.workspace(draftId);
  }

  deleteRows(draftId: string, _category: ImportWizardCategory, rowIds: readonly string[]): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    if (rowIds.length === 0) return this.workspace(draftId);
    // 删除既有来源行前建立 pre checkpoint（可整体 undo/redo；含原位置/来源/只读元数据）。
    const pairId = `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    repo.createCheckpoint(draftId, draft.revision, {
      kind: 'pre',
      pairId,
      label: '删除行',
      modes: this.declaredModes(draftId),
    });
    const afterDelete = repo.deleteRows(draftId, draft.revision, [...rowIds]);
    repo.createCheckpoint(draftId, afterDelete, {
      kind: 'post',
      pairId,
      label: '删除行',
      modes: this.declaredModes(draftId),
    });
    return this.workspace(draftId);
  }

  // ------------------------------------------------------------------ 校验 / 封存 / 冲突决定

  async validate(draftId: string): Promise<ImportWizardWorkspaceDto> {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    this.rejectBusy(draftId, '已有校验/读取在处理中');
    const rows = this.normalizedRows(draftId);
    const declared = this.declaredModes(draftId);
    const op = repo.createOperation(draftId, 'validating');
    const abort = new AbortController();
    const promise = this.runFullValidation(draftId, op.id, rows, declared, abort.signal);
    this.active.set(draftId, { operationId: op.id, kind: 'validating', abort, promise });
    try {
      await promise;
      this.active.delete(draftId);
    } catch (error) {
      this.active.delete(draftId);
      if (isImportCancelled(error)) {
        this.finishOperation(draftId, op.id, 'cancelled', '校验已取消');
        this.repo().recoverRuntimeStates();
      } else {
        this.finishOperation(draftId, op.id, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    return this.workspace(draftId);
  }

  private async runFullValidation(
    draftId: string,
    operationId: string,
    rows: NormalizedRow[],
    declared: Partial<Record<ImportCategory, 'data' | 'none'>>,
    signal: AbortSignal,
  ): Promise<void> {
    const repo = this.repo();
    const reportProgress = (processed: number, total: number | null, stage: string): void => {
      repo.updateOperationProgress(operationId, { stage, progressCurrent: processed, progressTotal: total });
      this.deps.emitProgress({
        draftId,
        operationId,
        kind: 'validating',
        stage,
        processed,
        total,
        state: 'running',
      });
    };
    reportProgress(0, rows.length, '校验准备');
    const draft = repo.getDraft(draftId)!;
    let revision = draft.revision;
    // 未经过文件/粘贴解析的手工行：先按工作区状态机进入 needs_review 再开始校验。
    revision = this.ensureReviewable(repo, draftId, revision);
    revision = repo.transitionState(draftId, revision, 'start_validating');
    const result = validatePlan(rows, { declared, target: new TargetConflictReader(this.deps.businessDb()) });
    signal.throwIfAborted();
    reportProgress(rows.length, rows.length, '校验完成');
    const issueInputs = result.problems.map((p) => this.toIssueInput(p));
    revision = repo.replaceIssues(draftId, revision, issueInputs);
    if (result.eligible && rows.length > 0) {
      generateValidationSeal(repo, {
        draftId,
        expectedRevision: revision,
        planDigest: result.plan.planDigest,
        problems: result.problems,
        targetDb: this.deps.businessDb(),
      });
      this.finishOperation(draftId, operationId, 'completed', '完整校验通过并封存');
    } else {
      repo.transitionState(draftId, revision, 'validation_finished');
      this.finishOperation(draftId, operationId, 'completed', '完整校验未通过');
    }
  }

  saveConflictDecision(draftId: string, issueId: string, value: string): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    const issue = repo.listIssues(draftId).find((i) => i.id === issueId);
    if (!issue) throw new WorkspaceNotFoundError(`校验问题不存在: ${issueId}`);
    const decision: ConflictDecisionInput = {
      rowId: issue.rowId ?? undefined,
      field: issue.field ?? '',
      decisionType: 'fix_value',
      chosenValue: value,
      resolvedBy: this.requireSession().username,
    };
    this.withEditCheckpoints(draftId, '冲突决定', (revision) => {
      let next = repo.saveConflictDecision(draftId, revision, decision);
      if (issue.rowId && issue.field && issue.field !== '') {
        const patch: CellPatch = { rowId: issue.rowId, field: issue.field, value };
        next = repo.patchCells(draftId, next, [patch]);
        this.revalidateAffected(draftId, next, [issue.rowId]);
      }
      return next;
    });
    return this.workspace(draftId);
  }

  // ------------------------------------------------------------------ 撤销 / 重做（tasks 8.59/8.66）

  checkpoints(draftId: string): import('../shared/ipc').ImportWizardCheckpointDto[] {
    this.requireDraft(draftId);
    return this.repo().listCheckpoints(draftId).map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      baseRevision: c.baseRevision,
      state: c.state,
      createdAt: c.createdAt,
    }));
  }

  /** 撤销：恢复最近一个 pre checkpoint（新修订 + seal 失效；无可撤销返回 null）。
   *  modes/sheet 归类随 checkpoint 快照在同一工作区事务内恢复（Oracle 复审 #4）。 */
  async undo(draftId: string): Promise<ImportWizardWorkspaceDto | null> {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    const result = repo.undo(draftId, draft.revision);
    if (!result) return null;
    return this.workspace(draftId);
  }

  /** 重做：恢复成对 post checkpoint（新修订 + seal 失效；无可重做返回 null）。 */
  async redo(draftId: string): Promise<ImportWizardWorkspaceDto | null> {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    this.requireMutable(draft.state);
    const result = repo.redo(draftId, draft.revision);
    if (!result) return null;
    return this.workspace(draftId);
  }

  // ------------------------------------------------------------------ 提交 / 中断 / 恢复

  /**
   * 取消进行中的解析/校验（operation id 去重）：中止 worker/校验并把草稿回滚到
   * 最后一次稳定修订；提交（committing）不可取消，避免形成部分业务状态。
   */
  async cancelOperation(draftId: string, operationId: string): Promise<ImportWizardWorkspaceDto> {
    const active = this.active.get(draftId);
    if (!active || active.operationId !== operationId) {
      return this.workspace(draftId);
    }
    if (active.kind === 'committing') {
      throw new Error('提交不可取消（避免形成部分业务状态）');
    }
    active.abort.abort();
    await active.promise.catch(() => undefined);
    this.active.delete(draftId);
    this.finishOperation(draftId, operationId, 'cancelled', '已取消');
    this.repo().recoverRuntimeStates();
    return this.workspace(draftId);
  }

  async commit(draftId: string, sealId: string): Promise<ImportWizardSubmitResultDto> {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    if (draft.state !== 'sealed') {
      throw new WorkspaceStateError(`仅已封存草稿可提交，当前状态: ${draft.state}`);
    }
    this.rejectBusy(draftId, '已有提交在处理中');
    const rows = this.normalizedRows(draftId);
    const declared = this.declaredModes(draftId);
    const planDigest = buildPlanFromRows(rows).planDigest;
    // Oracle 复审 #2：commit 请求必须携带用户确认的 seal ID 并严格匹配（ID + plan digest + draft revision），不能忽略。
    const seal = repo.getSeal(draftId);
    if (!seal || seal.id !== sealId || seal.status !== 'valid') {
      throw new WorkspaceStateError('提交携带的校验封存 ID 与当前封存不一致或已失效，请重新完整校验');
    }
    if (seal.planDigest !== planDigest) {
      throw new WorkspaceStateError('提交计划摘要与封存摘要不一致，请重新完整校验');
    }
    if (seal.draftRevision !== undefined && draft.revision !== seal.draftRevision + 1) {
      throw new WorkspaceStateError('提交草稿修订与封存修订不一致，请重新完整校验');
    }
    const result = validatePlan(rows, { declared, target: new TargetConflictReader(this.deps.businessDb()) });
    // Oracle 二次复审 #1：提交前阻断（mode=none 但存在源行 / 其它错误与未解决冲突）。
    if (!result.eligible) {
      throw new WorkspaceStateError(`完整校验未通过：${result.blockingReasons[0] ?? '存在错误或未解决冲突'}，禁止提交`);
    }
    const session = this.requireSession();
    const sessionToken = this.currentSessionToken();
    const input: CommitInput = {
      draftId,
      expectedRevision: draft.revision,
      planDigest,
      rows,
      problems: result.problems,
      declared,
      actor: { accountId: session.accountId, username: session.username },
      sessionToken,
      verifySessionToken: (token) => this.sessionToken !== null && this.sessionToken === token,
      snapshotDir: this.deps.snapshotDir(),
      now: this.now,
    };
    const op = repo.createOperation(draftId, 'committing');
    this.deps.emitProgress({ draftId, operationId: op.id, kind: 'submitting', stage: '提交', processed: 0, total: null, state: 'running' });
    try {
      const outcome = await this.coordinator.commitSealedPlanAtomically(this.deps.businessDb(), repo, input);
      repo.finishOperation(op.id, outcome.status === 'committed' ? 'completed' : 'failed', outcome.status);
      if (outcome.status === 'committed' || outcome.status === 'already_committed') {
        const counts: Partial<Record<ImportWizardCategory, number>> = {};
        if (outcome.run) {
          for (const c of IMPORT_CATEGORIES) counts[RENDERER_CATEGORY[c]] = outcome.run.writtenCounts[c];
        }
        return {
          status: 'success',
          title: '导入完成',
          message: '七类数据已整体写入，未产生部分导入。',
          importedCounts: counts,
        };
      }
      if (outcome.status === 'busy') {
        return { status: 'unknown', title: '提交进行中', message: outcome.error ?? '已有提交任务在处理，请稍候。' };
      }
      return { status: 'failed', title: '导入未完成', message: outcome.error ?? '提交失败，本次没有产生部分导入，草稿已保留。' };
    } catch (error) {
      repo.finishOperation(op.id, 'failed', error instanceof Error ? error.message : String(error));
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', title: '导入未完成', message: `${message}。本次没有产生部分导入，草稿已保留。` };
    }
  }

  settleInterrupted(draftId: string): ImportWizardSubmitResultDto {
    const repo = this.repo();
    const draft = this.requireDraft(draftId);
    if (draft.state !== 'committing') {
      return { status: 'unknown', title: '无需核对', message: '草稿不在提交中状态，无需中断核对' };
    }
    const outcome = this.coordinator.settleInterruptedCommit(this.deps.businessDb(), repo, draftId);
    if (outcome.status === 'succeeded') {
      return { status: 'success', title: '提交成功', message: '成功审计与完整事务同时存在，判定完整成功。' };
    }
    return { status: 'failed', title: '完整回滚', message: '未找到成功审计，判定完整回滚；请重新完整校验后再提交。' };
  }

  recover(): ImportWizardRecoverDto {
    const report = this.repo().recoverRuntimeStates();
    return {
      recovered: report.recovered.map((r) => ({ draftId: r.draftId, from: r.from, to: r.to })),
      pendingOutcome: report.pendingOutcome,
    };
  }

  // ------------------------------------------------------------------ 会话失效

  /**
   * 会话失效/登出/恢复后：取消活动读取、保留最后草稿修订、invalidate 全部 seal，
   * 重新登录后必须重新完整校验。
   */
  onSessionInvalidated(): void {
    // 会话 token 置空：提交资格取消（coordinator 在快照后/BEGIN 前/事务内复核会零写拒绝）。
    this.sessionToken = null;
    for (const active of this.active.values()) {
      active.abort.abort();
    }
    this.active.clear();
    const repo = this.repo();
    for (const draft of repo.listDrafts()) {
      if (draft.state === 'sealed') {
        try {
          repo.invalidateSeal(draft.id, draft.revision);
        } catch {
          // 状态已变化时跳过
        }
      }
    }
  }

  /** 启动/恢复时由 main 调用：工作区损坏仅禁用导入，不影响普通工作台。 */
  getRuntimeState(): { enabled: boolean; error: string | null } {
    try {
      this.repo().listDrafts();
      return { enabled: true, error: null };
    } catch (error) {
      return { enabled: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ------------------------------------------------------------------ 工作区 DTO 构建

  workspace(draftId: string): ImportWizardWorkspaceDto {
    const repo = this.repo();
    const detail = repo.getDraft(draftId);
    if (!detail) throw new WorkspaceNotFoundError(`导入草稿不存在: ${draftId}`);
    const progress = this.draftProgress(draftId);
    const session = this.sessionSafe();
    const allIssues = repo.listIssues(draftId);
    const categoryModes = repo.getCategoryModes(draftId);
    const sheetClassifications = repo.getSheetClassifications(draftId);
    const steps: ImportWizardStepDto[] = (Object.keys(STEP_CATEGORIES) as ImportWizardStepId[]).map((step) => {
      const stepCategories = STEP_CATEGORIES[step];
      const stepIssues = allIssues.filter((i) => i.category != null && stepCategories.includes(i.category));
      const blocking = stepIssues.filter((i) => i.severity === 'error' || i.severity === 'conflict').length;
      const warnings = stepIssues.filter((i) => i.severity === 'warning').length;
      const state: ImportWizardStepDto['state'] =
        step === progress.step
          ? this.active.get(draftId)
            ? 'processing'
            : 'not_started'
          : blocking > 0
            ? 'blocked'
            : warnings > 0
              ? 'warning'
              : 'passed';
      return { id: step, state, errorCount: stepIssues.length };
    });
    const categories: ImportWizardWorkspaceDto['categories'] = IMPORT_CATEGORIES.map((domainCategory) => {
      const renderer = RENDERER_CATEGORY[domainCategory];
      return {
        category: renderer,
        mode: (categoryModes[domainCategory] as ImportWizardCategoryMode | undefined) ?? 'undecided',
        count: detail.rowCounts[domainCategory],
        columns: fieldCatalogFor(domainCategory).map((field) => ({
          id: field.field,
          label: field.label,
          businessKey: field.businessKey,
          readOnly: !field.editable,
          frozen: field.businessKey,
        })),
      };
    });
    const operation = this.activeOperation(draftId);
    return {
      draft: this.toDraftDto(draftId, detail.totalRows),
      username: session?.username ?? '',
      templateVersion: String(TEMPLATE_VERSION),
      currentStep: progress.step ?? 'prepare',
      steps,
      categories,
      sheets: this.toSheets(draftId, sheetClassifications),
      mappings: this.toMappings(draftId),
      issues: this.toIssues(allIssues),
      ecc: this.toEcc(draftId),
      summary: this.buildSummary(draftId, allIssues, operation),
      operation,
    };
  }

  private toDraftDto(draftId: string, totalRows: number): ImportWizardDraftDto {
    const detail = this.repo().getDraft(draftId);
    if (!detail) throw new WorkspaceNotFoundError(`导入草稿不存在: ${draftId}`);
    const progress = this.draftProgress(draftId);
    const issues = this.repo().listIssues(draftId);
    const running = this.active.has(draftId);
    return {
      id: draftId,
      name: detail.name,
      currentStep: progress.step ?? 'prepare',
      totalRows,
      issueCount: issues.length,
      saveState: running ? 'saving' : 'saved',
      updatedAt: detail.updatedAt,
    };
  }

  private toSheets(draftId: string, sheetClassifications: Array<{ file: string; sheet: string; classification: ImportCategory | 'excluded' }>): ImportWizardSheetDto[] {
    const repo = this.repo();
    // Oracle 最终复核 #1：sheet DTO id 使用规范百分号编码（文件/表名含 '#' 也不歧义）。
    const classificationByKey = new Map<string, ImportCategory | 'excluded'>();
    for (const entry of sheetClassifications) {
      classificationByKey.set(encodeSheetId(entry.file, entry.sheet), entry.classification);
    }
    const rendererClassification = (key: string): ImportWizardCategory | 'excluded' | null => {
      const value = classificationByKey.get(key);
      if (value === undefined) return null;
      return value === 'excluded' ? 'excluded' : RENDERER_CATEGORY[value];
    };
    const sources = repo.listSources(draftId);
    const rows = repo.queryRows(draftId, { offset: 0, limit: 10_000_000 }).rows;
    const bySource = new Map<string, { fileName: string; sheet: string; category: ImportCategory | null; count: number }>();
    for (const row of rows) {
      const key = encodeSheetId(row.sourceFile ?? '', row.sourceSheet ?? '');
      const existing = bySource.get(key) ?? { fileName: row.sourceFile ?? '粘贴', sheet: row.sourceSheet ?? '粘贴', category: row.category, count: 0 };
      existing.count += 1;
      bySource.set(key, existing);
    }
    const sheets: ImportWizardSheetDto[] = [];
    for (const [key, entry] of bySource) {
      const classification = rendererClassification(key);
      const excluded = classification === 'excluded';
      sheets.push({
        id: key,
        fileName: entry.fileName,
        sheetName: entry.sheet,
        rowCount: entry.count,
        category: excluded ? null : classification ?? RENDERER_CATEGORY[entry.category ?? 'project'],
        status: excluded ? 'excluded' : 'recognized',
      });
    }
    for (const source of sources) {
      const key = encodeSheetId(source.sourceFile, source.sheet ?? '');
      if (!bySource.has(key) && source.sourceKind === 'file') {
        const classification = rendererClassification(key);
        const excluded = classification === 'excluded';
        sheets.push({
          id: key,
          fileName: source.sourceFile,
          sheetName: source.sheet ?? '',
          rowCount: 0,
          category: excluded ? null : classification ?? null,
          status: excluded ? 'excluded' : classification ? 'unknown' : 'empty',
        });
      }
    }
    return sheets;
  }

  private toMappings(draftId: string): ImportWizardMappingDto[] {
    const repo = this.repo();
    return repo.listMappings(draftId).map((mapping) => {
      const renderer = RENDERER_CATEGORY[mapping.category];
      const match: ImportWizardMappingDto['match'] =
        mapping.mappingState === 'exact' ? 'exact' : mapping.mappingState === 'alias' ? 'alias' : mapping.mappingState === 'pending' ? 'manual' : 'unused';
      return {
        id: `${draftId}:${mapping.category}:${mapping.sourceColumn}`,
        category: renderer,
        source: mapping.sourceColumn,
        target: mapping.targetField,
        targetOptions: fieldCatalogFor(mapping.category).map((f) => ({ id: f.field, label: f.label })),
        match,
        sample: mapping.sampleValue ?? '',
        priority: mapping.priority ?? undefined,
        affectedRows: mapping.priority !== null ? undefined : undefined,
      };
    });
  }

  private toIssues(issues: readonly import('../domain/capabilities/historical-data-import/workspace').ImportIssue[]): ImportWizardIssueDto[] {
    return issues.map((issue) => {
      const category = issue.category ?? 'project';
      return {
        id: issue.id,
        kind: issue.severity,
        category: RENDERER_CATEGORY[category],
        step: STEP_OF_CATEGORY[category],
        rowIndex: Math.max(0, (issue.gridRow ?? 1) - 1),
        columnId: issue.field ?? '',
        field: issue.field ?? '',
        message: issue.message,
        source: issue.sourcePosition ?? '',
        candidates: undefined,
      };
    });
  }

  private toEcc(draftId: string): ImportWizardEccDto[] {
    const rows = this.repo().queryRows(draftId, { offset: 0, limit: 10_000_000 }).rows;
    const eccMap = new Map<string, { ecc: string; invoices: number; logistics: number; sources: number }>();
    for (const row of rows) {
      if (row.category === 'project') {
        const key = row.businessKey;
        if (!key) continue;
        const entry = eccMap.get(key) ?? { ecc: key, invoices: 0, logistics: 0, sources: 0 };
        entry.sources += 1;
        eccMap.set(key, entry);
      } else if (row.category === 'invoice' && row.businessKey) {
        const entry = eccMap.get(row.businessKey) ?? { ecc: row.businessKey, invoices: 0, logistics: 0, sources: 0 };
        entry.invoices += 1;
        eccMap.set(row.businessKey, entry);
      } else if (row.category === 'logistics_fee' && row.businessKey) {
        const entry = eccMap.get(row.businessKey) ?? { ecc: row.businessKey, invoices: 0, logistics: 0, sources: 0 };
        entry.logistics += 1;
        eccMap.set(row.businessKey, entry);
      }
    }
    return [...eccMap.values()].map((entry) => ({
      ecc: entry.ecc,
      projects: 1,
      serviceOrders: 0,
      invoices: entry.invoices,
      logistics: entry.logistics,
      sources: entry.sources,
    }));
  }

  private buildSummary(
    draftId: string,
    issues: readonly import('../domain/capabilities/historical-data-import/workspace').ImportIssue[],
    operation: ImportWizardOperationDto | null,
  ): ImportWizardFinalSummaryDto | null {
    const repo = this.repo();
    const seal = repo.getSeal(draftId);
    if (!seal || seal.status !== 'valid') {
      return {
        categories: [],
        eccProjects: 0,
        independentRecords: 0,
        amountTotals: [],
        excludedSources: 0,
        confirmedBy: this.sessionSafe()?.username ?? '',
        seal: seal?.id ?? null,
        sealValid: seal !== undefined && seal.status === 'valid',
        validationComplete: false,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
        blockingCount: issues.filter((i) => i.severity === 'error' || i.severity === 'conflict').length,
      };
    }
    const rows = this.normalizedRows(draftId);
    const plan = buildPlanFromRows(rows);
    const categories: ImportWizardValidationCategoryDto[] = IMPORT_CATEGORIES.map((domainCategory) => {
      const renderer = RENDERER_CATEGORY[domainCategory];
      const categoryIssues = issues.filter((i) => i.category === domainCategory);
      return {
        category: renderer,
        add: domainCategory === 'project' ? plan.projects.length : plan.recordCounts[domainCategory],
        match: 0,
        correct: 0,
        skip: 0,
        warning: categoryIssues.filter((i) => i.severity === 'warning').length,
        blocked: categoryIssues.filter((i) => i.severity === 'error' || i.severity === 'conflict').length,
      };
    });
    const contractTotal = plan.projects.reduce((sum, p) => sum + (p.usdTaxAmountCents ?? 0n), 0n);
    const logisticsTotal = plan.logisticsFees.reduce((sum, f) => sum + (f.logisticsCostCents ?? 0n), 0n);
    const totalRows = plan.recordCounts.project + plan.recordCounts.service_order + plan.recordCounts.invoice + plan.recordCounts.logistics_fee + plan.recordCounts.serial_address_update + plan.recordCounts.qr_request + plan.recordCounts.ship_to_request;
    return {
      categories,
      eccProjects: plan.projects.length,
      independentRecords: totalRows - plan.projects.length,
      amountTotals: [
        { label: '合同金额合计（USD）', value: formatCents(contractTotal) },
        { label: '物流费用合计（RMB）', value: formatCents(logisticsTotal) },
      ],
      excludedSources: 0,
      confirmedBy: this.sessionSafe()?.username ?? '',
      seal: seal.id,
      sealValid: seal.status === 'valid',
      validationComplete: true,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
      blockingCount: issues.filter((i) => i.severity === 'error' || i.severity === 'conflict').length,
    };
    void operation;
  }

  private activeOperation(draftId: string): ImportWizardOperationDto | null {
    const active = this.active.get(draftId);
    if (active) {
      const op = this.repo().listOperations(draftId).find((o) => o.id === active.operationId);
      return {
        id: active.operationId,
        kind: OPERATION_KIND_TO_RENDERER[active.kind],
        label: active.kind === 'parsing' ? '读取并规范化来源数据' : active.kind === 'validating' ? '完整校验' : '整体提交',
        processed: op?.progressCurrent ?? 0,
        total: op?.progressTotal ?? null,
        cancelable: active.kind !== 'committing',
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ 内部辅助

  private requireSession(): AccountSessionInfo {
    const session = this.deps.session();
    if (!session) throw new Error('登录状态已失效，请重新登录');
    return session;
  }

  /** 当前会话 token（惰性生成；会话失效后置空，提交资格取消）。 */
  private currentSessionToken(): string {
    const session = this.deps.session();
    if (!session) throw new Error('登录状态已失效，请重新登录');
    if (this.sessionToken === null) {
      this.sessionToken = randomUUID();
    }
    return this.sessionToken;
  }

  private sessionSafe(): AccountSessionInfo | null {
    return this.deps.session();
  }
  private requireDraft(draftId: string): import('../domain/capabilities/historical-data-import/workspace').DraftDetail {
    const draft = this.repo().getDraft(draftId);
    if (!draft) throw new WorkspaceNotFoundError(`导入草稿不存在: ${draftId}`);
    return draft;
  }

  private requireMutable(state: string): void {
    if (state === 'committing') throw new WorkspaceStateError('草稿正在提交，禁止修改');
    if (state === 'succeeded') throw new WorkspaceStateError('草稿已导入成功，禁止修改');
    if (state === 'cancelled') throw new WorkspaceStateError('草稿已取消，禁止修改');
  }

  private rejectBusy(draftId: string, message: string): void {
    if (this.active.has(draftId)) {
      throw new Error(`${message}（operation id 去重：重复触发被抑制）`);
    }
  }

  private repo(): WorkspaceRepository {
    return new WorkspaceRepository(this.deps.workspaceDb(), this.now);
  }

  /** 把草稿从 draft 推进到 needs_review（手工行未经过解析时，按状态机补齐解析转换）。 */
  private ensureReviewable(repo: WorkspaceRepository, draftId: string, revision: number): number {
    const state = repo.getDraft(draftId)?.state;
    if (state === 'draft') {
      let rev = repo.transitionState(draftId, revision, 'start_parsing');
      rev = repo.transitionState(draftId, rev, 'parsing_finished');
      return rev;
    }
    return revision;
  }

  /** 进入 parsing 运行态（文件/粘贴读取；取消时回滚到最后稳定修订）。 */
  private enterParsing(repo: WorkspaceRepository, draftId: string, revision: number): number {
    const state = repo.getDraft(draftId)?.state;
    if (state === 'draft' || state === 'needs_review') {
      return repo.transitionState(draftId, revision, 'start_parsing');
    }
    return revision;
  }

  private chunkWriter(): ChunkWritePort {
    const now = this.now;
    return {
      append: (draftId, expectedRevision, category, rows) =>
        new WorkspaceRepository(this.deps.workspaceDb(), now).appendRows(draftId, expectedRevision, category, rows),
    };
  }

  private normalizedRows(draftId: string): NormalizedRow[] {
    const window = this.repo().queryRows(draftId, { offset: 0, limit: 10_000_000 });
    // Oracle 二次复审 #2：excluded 源行不进入 normalizedRows（从而不进 plan/seal/commit）。
    return toNormalizedRows(window.rows.filter((row) => !row.excluded));
  }

  private declaredModes(draftId: string): Partial<Record<ImportCategory, 'data' | 'none'>> {
    // Oracle 复审 #2：类别模式已迁入 workspace revisioned 表。
    return this.repo().getCategoryModes(draftId);
  }

  private finishOperation(draftId: string, operationId: string, state: 'completed' | 'cancelled' | 'failed', result: string): void {
    this.repo().finishOperation(operationId, state, result);
    this.deps.emitProgress({
      draftId,
      operationId,
      kind: 'normalizing',
      stage: state,
      processed: 0,
      total: null,
      state,
    });
  }

  private reportTaskProgress(draftId: string, operationId: string, progress: ImportProgress): void {
    const repo = this.repo();
    repo.updateOperationProgress(operationId, { stage: progress.stage, progressCurrent: progress.currentRows, progressTotal: progress.totalRows });
    const kind: 'reading' | 'normalizing' = progress.stage === 'preflight' || progress.stage === 'reading' ? 'reading' : 'normalizing';
    this.deps.emitProgress({
      draftId,
      operationId,
      kind,
      stage: progress.stage,
      processed: progress.currentRows,
      total: progress.totalRows,
      state: 'running',
    });
  }

  private revalidateAffected(draftId: string, revision: number, rowIds: string[]): void {
    const repo = this.repo();
    const rows = this.normalizedRows(draftId);
    const affected = rows.filter((r) => rowIds.includes(r.rowId));
    const eccs = [...new Set(affected.map((r) => r.businessKey).filter((k): k is string => k !== null))];
    const problems = validateAffected(rows, { rowIds, eccs }, { declared: this.declaredModes(draftId), target: new TargetConflictReader(this.deps.businessDb()) });
    const existing = repo.listIssues(draftId);
    const kept = existing.filter((issue) => {
      const touchedRow = issue.rowId != null && rowIds.includes(issue.rowId);
      const touchedEcc = issue.businessKey != null && eccs.includes(issue.businessKey);
      return !touchedRow && !touchedEcc;
    });
    repo.replaceIssues(draftId, revision, [...kept.map((i) => this.toIssueInputFromRecord(i)), ...problems.map((p) => this.toIssueInput(p))]);
  }

  private toIssueInput(problem: ImportProblem): IssueInput {
    return {
      severity: problem.severity,
      issueCode: problem.code as string,
      category: problem.category ?? undefined,
      rowId: problem.recordKey ?? undefined,
      field: problem.field ?? undefined,
      businessKey: problem.businessKey ?? undefined,
      gridRow: problem.gridRow ?? undefined,
      sourcePosition: problem.sourcePosition ?? undefined,
      message: problem.message,
      resolved: false,
    };
  }

  private toIssueInputFromRecord(issue: import('../domain/capabilities/historical-data-import/workspace').ImportIssue): IssueInput {
    return {
      severity: issue.severity,
      issueCode: issue.issueCode,
      category: issue.category ?? undefined,
      rowId: issue.rowId ?? undefined,
      field: issue.field ?? undefined,
      businessKey: issue.businessKey ?? undefined,
      gridRow: issue.gridRow ?? undefined,
      sourcePosition: issue.sourcePosition ?? undefined,
      message: issue.message,
      resolved: issue.resolved,
    };
  }

  // ------------------------------------------------------------------ 侧边持久化（step / modes / sheet 归类）

  private progressFilePath(): string {
    return join(this.deps.workspaceDir, 'wizard-progress.json');
  }

  private readProgressFile(): ProgressFile {
    if (this.progressFileCache) return this.progressFileCache;
    try {
      if (existsSync(this.progressFilePath())) {
        const parsed = JSON.parse(readFileSync(this.progressFilePath(), 'utf-8')) as ProgressFile;
        this.progressFileCache = { drafts: parsed.drafts ?? {} };
      } else {
        this.progressFileCache = { drafts: {} };
      }
    } catch {
      this.progressFileCache = { drafts: {} };
    }
    return this.progressFileCache;
  }

  private writeProgressFile(): void {
    try {
      writeFileSync(this.progressFilePath(), JSON.stringify(this.progressFileCache ?? { drafts: {} }), 'utf-8');
    } catch {
      // 侧边状态保存失败不影响导入主流程
    }
  }

  private draftProgress(draftId: string): DraftProgress {
    return this.readProgressFile().drafts[draftId] ?? {};
  }

  private setDraftProgress(draftId: string, patch: DraftProgress): void {
    const file = this.readProgressFile();
    file.drafts[draftId] = { ...(file.drafts[draftId] ?? {}), ...patch };
    this.writeProgressFile();
  }

  private clearDraftProgress(draftId: string): void {
    const file = this.readProgressFile();
    delete file.drafts[draftId];
    this.writeProgressFile();
  }
}
