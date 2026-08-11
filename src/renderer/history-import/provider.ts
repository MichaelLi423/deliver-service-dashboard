import type {
  GridCellPatch,
  GridColumn,
  VirtualGridWindowProvider,
} from './virtual-grid';

export type HistoryImportCategory =
  | 'projects'
  | 'serviceOrders'
  | 'invoices'
  | 'logistics'
  | 'serialAddresses'
  | 'qrRequests'
  | 'shipToRequests';

export type WizardStepId = 'prepare' | 'projects' | 'orders' | 'finance' | 'serials' | 'requests' | 'review';
export type StepState = 'not_started' | 'processing' | 'passed' | 'warning' | 'blocked';
export type SaveState = 'saving' | 'saved' | 'failed';
export type IssueKind = 'error' | 'conflict' | 'warning';

export interface HistoryImportDraftSummary {
  id: string;
  name: string;
  updatedAt: string;
  currentStep: WizardStepId;
  totalRows: number;
  issueCount: number;
  saveState: SaveState;
}

export interface ImportCategorySummary {
  category: HistoryImportCategory;
  mode: 'data' | 'none' | 'undecided';
  count: number;
  columns: readonly GridColumn[];
}

export interface ImportStepSummary {
  id: WizardStepId;
  state: StepState;
  errorCount: number;
}

export interface ImportSheetSummary {
  id: string;
  fileName: string;
  sheetName: string;
  rowCount: number;
  category: HistoryImportCategory | null;
  status: 'recognized' | 'unknown' | 'empty' | 'excluded';
}

export interface ColumnMapping {
  id: string;
  category: HistoryImportCategory;
  source: string;
  target: string | null;
  targetOptions: readonly { id: string; label: string }[];
  match: 'exact' | 'alias' | 'manual' | 'unused';
  sample: string;
  priority?: number;
  affectedRows?: number;
}

export interface ImportIssue {
  id: string;
  kind: IssueKind;
  category: HistoryImportCategory;
  step: WizardStepId;
  rowIndex: number;
  columnId: string;
  field: string;
  message: string;
  source: string;
  candidates?: readonly { value: string; source: string }[];
}

export interface EccSummary {
  ecc: string;
  projects: number;
  serviceOrders: number;
  invoices: number;
  logistics: number;
  sources: number;
}

export interface ValidationCategorySummary {
  category: HistoryImportCategory;
  add: number;
  match: number;
  correct: number;
  skip: number;
  warning: number;
  blocked: number;
}

export interface FinalImportSummary {
  categories: readonly ValidationCategorySummary[];
  eccProjects: number;
  independentRecords: number;
  amountTotals: readonly { label: string; value: string }[];
  excludedSources: number;
  confirmedBy: string;
  seal: string | null;
  sealValid: boolean;
  validationComplete: boolean;
  warningCount: number;
  blockingCount: number;
}

export interface ImportOperation {
  id: string;
  kind: 'reading' | 'normalizing' | 'validating' | 'submitting';
  label: string;
  processed: number;
  total: number | null;
  cancelable: boolean;
}

export interface HistoryImportProgressEvent {
  draftId: string;
  operationId: string;
  kind: ImportOperation['kind'];
  stage: string | null;
  processed: number;
  total: number | null;
  state: 'running' | 'cancelled' | 'completed' | 'failed';
}

export interface HistoryImportRecoveryState {
  recovered: readonly { draftId: string; from: string; to: string }[];
  pendingOutcome: readonly string[];
}

export interface HistoryImportWorkspace {
  draft: HistoryImportDraftSummary;
  username: string;
  templateVersion: string;
  currentStep: WizardStepId;
  steps: readonly ImportStepSummary[];
  categories: readonly ImportCategorySummary[];
  sheets: readonly ImportSheetSummary[];
  mappings: readonly ColumnMapping[];
  issues: readonly ImportIssue[];
  ecc: readonly EccSummary[];
  summary: FinalImportSummary | null;
  operation: ImportOperation | null;
}

export interface HistoryImportSubmitResult {
  status: 'success' | 'failed' | 'unknown';
  title: string;
  message: string;
  importedCounts?: Partial<Record<HistoryImportCategory, number>>;
}

export interface HistoryImportWizardProvider {
  listDrafts(): Promise<readonly HistoryImportDraftSummary[]>;
  createDraft(): Promise<HistoryImportWorkspace>;
  openDraft(draftId: string): Promise<HistoryImportWorkspace>;
  deleteDraft(draftId: string): Promise<void>;
  saveDraft(draftId: string, currentStep: WizardStepId): Promise<HistoryImportWorkspace>;
  downloadTemplate(): Promise<{ saved: boolean; version: string }>;
  selectFiles(draftId: string): Promise<HistoryImportWorkspace>;
  pasteIntoCategory(draftId: string, category: HistoryImportCategory, headerConfirmed: boolean): Promise<HistoryImportWorkspace>;
  classifySheet(draftId: string, sheetId: string, category: HistoryImportCategory | 'excluded'): Promise<HistoryImportWorkspace>;
  setCategoryMode(draftId: string, category: HistoryImportCategory, mode: 'data' | 'none'): Promise<HistoryImportWorkspace>;
  updateMapping(draftId: string, mappingId: string, target: string | null): Promise<HistoryImportWorkspace>;
  getGridProvider(draftId: string, category: HistoryImportCategory): VirtualGridWindowProvider;
  patchGrid(draftId: string, category: HistoryImportCategory, patches: readonly GridCellPatch[]): Promise<HistoryImportWorkspace>;
  addGridRow(draftId: string, category: HistoryImportCategory): Promise<HistoryImportWorkspace>;
  deleteRows(draftId: string, category: HistoryImportCategory, selection: { startRow: number; endRow: number }): Promise<HistoryImportWorkspace>;
  undo(draftId: string): Promise<HistoryImportWorkspace>;
  redo(draftId: string): Promise<HistoryImportWorkspace>;
  validate(draftId: string): Promise<HistoryImportWorkspace>;
  cancelOperation(draftId: string, operationId: string): Promise<HistoryImportWorkspace>;
  resolveConflict(draftId: string, issueId: string, value: string): Promise<HistoryImportWorkspace>;
  submit(draftId: string, seal: string): Promise<HistoryImportSubmitResult>;
  recover?(): Promise<HistoryImportRecoveryState>;
  settleInterrupted?(draftId: string): Promise<HistoryImportSubmitResult>;
  subscribeProgress?(listener: (event: HistoryImportProgressEvent) => void): () => void;
}

export class HistoryImportSessionExpiredError extends Error {
  constructor(message = '本地访问会话已失效，请返回工作台后重新打开历史数据导入') {
    super(message);
    this.name = 'HistoryImportSessionExpiredError';
  }
}
