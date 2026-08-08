import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import type { AccountSessionInfo } from '../../src/shared/ipc';
import { ImportWizardFacade, type ImportWizardFacadeDeps } from '../../src/main/import-wizard-facade';
import {
  ImportWorkerError,
  runImportFileTaskInWorker,
  runImportPasteTaskInWorker,
} from '../../src/domain/capabilities/historical-data-import/import-worker/import-worker-host';
import type { FileWorkerRunParams } from '../../src/domain/capabilities/historical-data-import/import-worker/import-worker-protocol';
import { createImportWorkerFactory } from '../helpers/import-worker-factory';
import { buildTemplateBuffer, projectPasteText, projectRow } from '../helpers/import-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 真实打包 DataCloneError 回归（tasks 8.20 worker 接线）。
 *
 * 故障形态：ImportWizardFacade 把 writer（函数）、onProgress（函数）、signal
 * （AbortSignal）运行时属性塞进 params 后经 worker host `postMessage` →
 * 结构化克隆失败 → 真实打包 DataCloneError。
 *
 * 本文件在「真实 worker seam」验证三层修复：
 * 1) host 对 facade 形态 params（含宿主专属字段）给出明确协议错误，而非裸 DataCloneError；
 * 2) facade 传给 deps.runFileTask/runPasteTask 的 params 只含可克隆字段（structuredClone 必须成功）；
 * 3) 经真实 worker 的文件 + 粘贴真正成功（不允许 fallback 到进程内实现）。
 */

// ---------------------------------------------------------------------------
// 1) 真实 worker seam：facade 形态 params 必须被 host 明确拒绝（非裸 DataCloneError）
// ---------------------------------------------------------------------------

describe('8.20 真实 worker seam：params 携带宿主专属字段（writer/onProgress/signal）', () => {
  it('host 白名单拒绝并给明确协议错误，不得把 DataCloneError 直接抛给调用方', async () => {
    const { factory } = createImportWorkerFactory();
    const controller = new AbortController();
    const writer = { append: (_draftId: string, expectedRevision: number) => expectedRevision + 1 };
    // 模拟 ImportWizardFacade 修复前形态：宿主专属字段运行时存在（类型层面 Omit 不会移除）。
    const facadeShaped = {
      draftId: 'd-regression',
      expectedRevision: 1,
      buffer: Buffer.from('not-a-zip'),
      fileName: '回归.xlsx',
      writer,
      onProgress: () => undefined,
      signal: controller.signal,
    } as unknown as FileWorkerRunParams;

    const run = runImportFileTaskInWorker(facadeShaped, writer, {
      createWorker: factory,
      signal: controller.signal,
      onProgress: () => undefined,
    });
    await expect(run).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // 修复后：ImportWorkerError + 消息指明宿主专属字段 / 不可序列化。
      const protocolError =
        err instanceof ImportWorkerError && /writer|onProgress|signal|宿主|不可序列化|postMessage/.test(message);
      // 裸 DataCloneError（V8 抛出的消息以 DataCloneError/function...could not be cloned 开头），
      // 与协议错误中「说明文案包含 DataCloneError 字样」区分。
      const rawCloneError = /^DataCloneError[:：]|^function .* could not be cloned/.test(message);
      expect(rawCloneError, `不允许把裸克隆错误抛给调用方，实际: ${message}`).toBe(false);
      expect(protocolError, `应给出明确协议错误而非裸克隆错误，实际: ${message}`).toBe(true);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// 2) facade 接线：deps.runFileTask/runPasteTask 只收到可克隆字段
// ---------------------------------------------------------------------------

describe('8.20 facade 接线：传给 worker 的 params 只含可克隆字段', () => {
  it('selectFiles / pasteIntoCategory 传出的 params 可结构化克隆且不含 writer/signal/onProgress', async () => {
    const dir = makeTempDir();
    try {
      const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
      const business = bootstrapDatabase({ dataDir: join(dir, 'data') });
      const session: AccountSessionInfo = { accountId: 'acc-reg', username: '回归账号' };
      const templateBuffer = await buildTemplateBuffer({ project: [projectRow(1)] });
      const pasteText = projectPasteText([projectRow(1)]);
      const receivedFileParams: unknown[] = [];
      const receivedPasteParams: unknown[] = [];

      const { factory } = createImportWorkerFactory();
      const deps: ImportWizardFacadeDeps = {
        workspaceDir: join(dir, 'ws'),
        workspaceDb: () => ws.db,
        businessDb: () => business.db,
        snapshotDir: () => join(dir, 'snap'),
        session: () => session,
        showOpenDialog: async () => ({ canceled: false, filePaths: [join(dir, 'import.xlsx')] }),
        showSaveDialog: async () => ({ canceled: true }),
        readFile: async () => templateBuffer,
        statFile: async () => ({ size: 1024 }),
        writeFile: async () => undefined,
        clipboardText: () => pasteText,
        createWorker: factory,
        runFileTask: (params, writer, options) => {
          receivedFileParams.push(params);
          // params 必须可结构化克隆（否则真实打包 postMessage 抛 DataCloneError）。
          structuredClone(params);
          return runImportFileTaskInWorker(params, writer, { ...options, createWorker: factory });
        },
        runPasteTask: (params, writer, options) => {
          receivedPasteParams.push(params);
          structuredClone(params);
          return runImportPasteTaskInWorker(params, writer, { ...options, createWorker: factory });
        },
        emitProgress: () => undefined,
      };
      const facade = new ImportWizardFacade(deps);

      const d = facade.createDraft();
      const afterFile = await facade.selectFiles(d.draft.id);
      expect(afterFile.categories.find((c) => c.category === 'projects')!.count).toBeGreaterThan(0);
      const afterPaste = await facade.pasteIntoCategory(d.draft.id, 'projects', true);
      expect(afterPaste.categories.find((c) => c.category === 'projects')!.count).toBeGreaterThan(1);

      // 传出的 params 不含宿主专属字段（运行时断言，不依赖 Omit 类型）。
      for (const params of [...receivedFileParams, ...receivedPasteParams]) {
        expect(params).not.toHaveProperty('writer');
        expect(params).not.toHaveProperty('signal');
        expect(params).not.toHaveProperty('onProgress');
      }
      // 全程真正成功（未 fallback 到进程内实现）：
      expect(receivedFileParams).toHaveLength(1);
      expect(receivedPasteParams).toHaveLength(1);

      closeDatabase(business.db);
      closeWorkspaceDatabase(ws.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
