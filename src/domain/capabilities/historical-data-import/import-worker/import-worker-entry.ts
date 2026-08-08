import { isMainThread, parentPort } from 'node:worker_threads';
import {
  ImportCancelledError,
  PasteOverlayError,
  isImportCancelled,
  runImportFileTask,
  runImportPasteTask,
  type ChunkWritePort,
  type ImportFileTaskResult,
  type ImportPasteTaskResult,
  type ImportProgress,
} from '../import-tasks';
import { XlsxPreflightError } from '../zip-preflight';
import type {
  ImportWorkerErrorEvent,
  ImportWorkerEvent,
  ImportWorkerRequest,
} from './import-worker-protocol';

/**
 * import worker 线程入口（tasks 8.20 真实 node:worker_threads）。
 *
 * 本模块只在工作线程内执行：接收 run-file / run-paste 请求后，在 worker 内
 * 完成 ZIP 预检、模板/旧五源识别、可中止 exceljs 读取与逐行规范化，
 * 规范化行按块发回主进程（chunk），由主进程分块写入工作区并回执修订号。
 *
 * 资源路径（Electron Forge 打包）：
 * - 生产默认由 host 的 `new Worker(new URL('./import-worker-entry', import.meta.url))`
 *   加载，webpack 5 原生把它作为独立 worker chunk 输出（无需修改 webpack 配置）；
 * - 测试通过 esbuild 把本入口打包为独立 CJS 后以真实 Worker 运行（见
 *   tests/helpers/import-worker-factory.ts），与生产路径等价。
 *
 * 取消：主进程发 cancel → 本地 AbortController 中止输入读取（runImportFileTask
 * 协作式检查）；worker 以结构化错误码回传，宿主据此还原 ImportCancelledError。
 */

const port = parentPort;

if (!isMainThread && port) {
  let busy = false;
  let controller: AbortController | null = null;
  let chunkSeq = 0;
  const pendingChunks = new Map<number, { resolve: (revision: number) => void; reject: (error: Error) => void }>();

  // 线程就绪握手：宿主收到 ready 后才发送 run 请求。
  port.postMessage({ type: 'ready' } satisfies ImportWorkerEvent);

  port.on('message', (value: unknown) => {
    const msg = value as ImportWorkerRequest;
    switch (msg.type) {
      case 'cancel':
        controller?.abort();
        return;
      case 'revision': {
        const pending = pendingChunks.get(msg.chunkId);
        if (pending) {
          pendingChunks.delete(msg.chunkId);
          pending.resolve(msg.newRevision);
        }
        return;
      }
      case 'run-file':
      case 'run-paste': {
        if (busy) return; // 单次运行：忽略并发请求（宿主每次运行独占一个 worker）
        busy = true;
        controller = new AbortController();
        void execute(msg, controller.signal)
          .then((result) => port.postMessage({ type: 'result', result } satisfies ImportWorkerEvent))
          .catch((err: unknown) => port.postMessage(toErrorEvent(err) satisfies ImportWorkerEvent));
        return;
      }
    }
  });

  /** 执行一次任务：worker 内做读取/规范化，分块写回主进程。 */
  const execute = async (
    msg: Extract<ImportWorkerRequest, { type: 'run-file' | 'run-paste' }>,
    signal: AbortSignal,
  ): Promise<ImportFileTaskResult | ImportPasteTaskResult> => {
    const onProgress = (progress: ImportProgress): void => {
      port.postMessage({ type: 'progress', progress } satisfies ImportWorkerEvent);
    };
    const writer = workerWriter(signal);
    if (msg.type === 'run-file') {
      return runImportFileTask({
        ...msg.params,
        // postMessage 结构化克隆会把 Buffer 还原为 Uint8Array；yauzl/exceljs 需要 Buffer 方法。
        buffer: toBuffer(msg.params.buffer),
        signal,
        onProgress,
        writer,
      });
    }
    return runImportPasteTask({ ...msg.params, signal, onProgress, writer });
  };

  /** worker 侧写入端口：把规范化块发回主进程，等待主进程分块写入后的修订号回执。 */
  const workerWriter = (signal: AbortSignal): ChunkWritePort => ({
    append: (draftId, expectedRevision, category, rows) =>
      new Promise<number>((resolve, reject) => {
        if (signal.aborted) {
          reject(new ImportCancelledError());
          return;
        }
        chunkSeq += 1;
        const chunkId = chunkSeq;
        pendingChunks.set(chunkId, { resolve, reject });
        port.postMessage({
          type: 'chunk',
          chunkId,
          draftId,
          expectedRevision,
          category,
          rows,
        } satisfies ImportWorkerEvent);
      }),
  });
} else {
  // 主线程引用本模块只用于类型与打包入口，不启动消息循环。
  void 0;
}

/** 统一把 postMessage 还原的 Uint8Array 归一为 Buffer。 */
function toBuffer(value: Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as unknown as Uint8Array);
}

/** 把 worker 内错误映射为结构化错误码（跨线程无法复用 instanceof）。 */
function toErrorEvent(err: unknown): ImportWorkerErrorEvent {
  if (isImportCancelled(err)) {
    return {
      type: 'error',
      code: 'cancelled',
      name: 'ImportCancelledError',
      message: err instanceof Error ? err.message : '导入任务已取消',
    };
  }
  if (err instanceof XlsxPreflightError) {
    return { type: 'error', code: 'preflight', name: err.name, message: err.message, detail: err.result };
  }
  if (err instanceof PasteOverlayError) {
    return { type: 'error', code: 'paste-overlay', name: err.name, message: err.message, detail: err.verdict };
  }
  const error = err instanceof Error ? err : new Error(String(err));
  return { type: 'error', code: 'worker', name: error.name, message: error.message };
}
