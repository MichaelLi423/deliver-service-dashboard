import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IMPORT_WIZARD_CHANNELS,
  IPC_CHANNELS,
  type ImportWizardProgressEventDto,
  type WorkbenchApi,
} from '../shared/ipc';

/**
 * preload 脚本：仅暴露最小化语义 API（tasks 1.1 工程骨架 + 8.48 导入向导边界）。
 * 渲染层无 Node 访问（contextIsolation: true, nodeIntegration: false, sandbox: true）。
 * 导入向导只暴露语义方法：不暴露任意文件系统路径、数据库连接、worker 或内部路径能力；
 * 进度经受信窗口事件（onProgress 订阅），dialog 只返回展示元数据/结果。
 */
const api: WorkbenchApi = {
  getCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.capabilitiesList),
  getAccountStatus: () => ipcRenderer.invoke(IPC_CHANNELS.accountGetStatus),
  initializeAccount: (username, password) =>
    ipcRenderer.invoke(IPC_CHANNELS.accountInitialize, username, password),
  login: (username, password) => ipcRenderer.invoke(IPC_CHANNELS.accountLogin, username, password),
  resetPassword: (recoveryCode, newPassword) =>
    ipcRenderer.invoke(IPC_CHANNELS.accountResetPassword, recoveryCode, newPassword),
  getSession: () => ipcRenderer.invoke(IPC_CHANNELS.accountGetSession),
  // Oracle #10：工作台 v2 有界读取 / mutation（旧 snapshot 通道已删除，仅此入口）。
  v2Overview: () => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2Overview),
  v2ProjectPage: (request) => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2ProjectPage, request),
  v2ProjectDetail: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, projectId),
  v2SectionPage: (request) => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2SectionPage, request),
  v2IndependentPage: (request) => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2IndependentPage, request),
  v2LookupPage: (request) => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2LookupPage, request),
  v2Mutate: (request) => ipcRenderer.invoke(IPC_CHANNELS.workbenchV2Mutate, request),
  createShipToRequest: (input) => ipcRenderer.invoke(IPC_CHANNELS.shipToCreateRequest, input),
  submitShipToRequest: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.shipToSubmitRequest, requestId),
  buildReport: (filter) => ipcRenderer.invoke(IPC_CHANNELS.reportBuild, filter),
  drillDown: (metricKey, filter) => ipcRenderer.invoke(IPC_CHANNELS.reportDrillDown, metricKey, filter),
  exportReport: (format, filter) => ipcRenderer.invoke(IPC_CHANNELS.reportExport, format, filter),
  backupManual: () => ipcRenderer.invoke(IPC_CHANNELS.backupManual),
  restoreFromBackup: () => ipcRenderer.invoke(IPC_CHANNELS.restoreFromBackup),
  importWizard: {
    listDrafts: () => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.listDrafts),
    createDraft: () => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.createDraft),
    openDraft: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.openDraft, draftId),
    deleteDraft: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.deleteDraft, draftId),
    saveStep: (draftId, step) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.saveStep, draftId, step),
    downloadTemplate: () => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.downloadTemplate),
    selectFiles: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.selectFiles, draftId),
    pasteIntoCategory: (draftId, category, headerConfirmed) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.pasteIntoCategory, draftId, category, headerConfirmed),
    classifySheet: (draftId, sheetId, category) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.classifySheet, draftId, sheetId, category),
    setCategoryMode: (draftId, category, mode) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.setCategoryMode, draftId, category, mode),
    updateMapping: (draftId, mappingId, target) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.updateMapping, draftId, mappingId, target),
    queryRows: (request) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.queryRows, request),
    patchCells: (draftId, category, patches) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.patchCells, draftId, category, patches),
    addRow: (draftId, category) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.addRow, draftId, category),
    deleteRows: (draftId, category, rowIds) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.deleteRows, draftId, category, rowIds),
    validate: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.validate, draftId),
    saveConflictDecision: (draftId, issueId, value) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.saveConflictDecision, draftId, issueId, value),
    cancelOperation: (draftId, operationId) =>
      ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.cancelOperation, draftId, operationId),
    summary: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.summary, draftId),
    commit: (draftId, seal) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.commit, draftId, seal),
    settleInterrupted: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.settleInterrupted, draftId),
    recover: () => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.recover),
    checkpoints: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.checkpoints, draftId),
    undo: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.undo, draftId),
    redo: (draftId) => ipcRenderer.invoke(IMPORT_WIZARD_CHANNELS.redo, draftId),
    onProgress: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: ImportWizardProgressEventDto): void => {
        callback(payload);
      };
      ipcRenderer.on(IMPORT_WIZARD_CHANNELS.progressEvent, listener);
      return () => {
        ipcRenderer.removeListener(IMPORT_WIZARD_CHANNELS.progressEvent, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('workbench', api);
