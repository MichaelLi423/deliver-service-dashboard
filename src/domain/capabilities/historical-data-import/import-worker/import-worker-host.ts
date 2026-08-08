import { Worker } from 'worker_threads';
import {
  ImportCancelledError,
  PasteOverlayError,
  type ChunkWritePort,
  type ImportFileTaskResult,
  type ImportPasteTaskResult,
  type ImportProgress,
} from '../import-tasks';
import { XlsxPreflightError, type XlsxPreflightResult } from '../zip-preflight';
import type { PasteOverlayVerdict } from '../paste-parser';
import type {
  FileWorkerRunParams,
  ImportWorkerErrorEvent,
  ImportWorkerEvent,
  ImportWorkerRequest,
  ImportWorkerRunRequest,
  PasteWorkerRunParams,
} from './import-worker-protocol';

/**
 * import worker 宿主（tasks 8.20 真实工作线程）。
 *
 * - 文件读取与规范化在 worker 线程执行；主进程只接收 progress / chunk，
 *   由调用方提供的 ChunkWritePort 分块写入工作区，并把新修订号回执给 worker；
 * - AbortSignal 可同时取消 worker（postMessage cancel + terminate）与输入读取
 *   （worker 内 AbortController 协作式中止）；
 * - 取消/失败抛 ImportCancelledError / ImportWorkerError，已写入块保留在
 *   最后一次已保存修订，由 workspace 重启恢复回到最后稳定草稿修订（不形成部分 merge）；
 * - worker 工厂可注入：默认 `new Worker(new URL('./import-worker-entry', import.meta.url))`
 *   为 webpack 5 原生 worker chunk 模式（Electron Forge 打包无需修改 webpack 配置）；
 *   测试/打包适配可注入自定义工厂（如 esbuild 打包后的真实 Worker）。
 */

/** 与 node:worker_threads.Worker 结构性兼容的最小接口（便于测试注入与打包适配）。 */
export interface ImportWorkerLike {
  readonly threadId: number;
  postMessage(message: ImportWorkerRequest): void;
  on(event: 'message', listener: (value: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  removeListener(event: 'message', listener: (value: unknown) => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'exit', listener: (code: number) => void): void;
  terminate(): Promise<number>;
}

export interface ImportWorkerTaskOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  /** worker 工厂；缺省使用 webpack 可解析的 import-worker-entry。 */
  createWorker?: () => ImportWorkerLike;
}

/** worker 线程内的业务错误还原失败/线程异常（name 为 worker 内原始错误名）。 */
export class ImportWorkerError extends Error {
  readonly workerErrorName: string;
  constructor(workerErrorName: string, message: string) {
    super(message);
    this.name = 'ImportWorkerError';
    this.workerErrorName = workerErrorName;
  }
}

/**
 * 默认 worker 工厂：webpack 5 原生 `new Worker(new URL(..., import.meta.url))`
 * 模式把 import-worker-entry 作为独立 worker chunk 输出，资源路径在主包内可解析。
 */
export function createDefaultImportWorker(): ImportWorkerLike {
  return new Worker(new URL('./import-worker-entry', import.meta.url));
}

/** 在 worker 线程内执行文件导入任务（文件读取/规范化在 worker，分块写入在主进程）。 */
export function runImportFileTaskInWorker(
  params: FileWorkerRunParams,
  writer: ChunkWritePort,
  options: ImportWorkerTaskOptions = {},
): Promise<ImportFileTaskResult> {
  return runImportWorkerTask({ type: 'run-file', params }, writer, options) as Promise<ImportFileTaskResult>;
}

/** 在 worker 线程内执行粘贴导入任务（语义同上）。 */
export function runImportPasteTaskInWorker(
  params: PasteWorkerRunParams,
  writer: ChunkWritePort,
  options: ImportWorkerTaskOptions = {},
): Promise<ImportPasteTaskResult> {
  return runImportWorkerTask({ type: 'run-paste', params }, writer, options) as Promise<ImportPasteTaskResult>;
}

export function runImportWorkerTask(
  request: { type: 'run-file'; params: FileWorkerRunParams } | { type: 'run-paste'; params: PasteWorkerRunParams },
  writer: ChunkWritePort,
  options: ImportWorkerTaskOptions = {},
): Promise<ImportFileTaskResult | ImportPasteTaskResult> {
  const { signal, onProgress, createWorker } = options;

  // 跨线程请求显式白名单序列化：writer/onProgress/signal 只能由宿主持有，
  // 禁止出现在 params 中（Omit 类型不会移除运行时属性，否则真实打包 DataCloneError）。
  let wireRequest: ImportWorkerRunRequest;
  try {
    wireRequest = buildWireRequest(request);
  } catch (error) {
    return Promise.reject(error);
  }

  // 已中止信号在创建 worker 前直接取消（不启动线程、不写任何块）。
  if (signal?.aborted) {
    return Promise.reject(new ImportCancelledError());
  }
  const worker = (createWorker ?? createDefaultImportWorker)();

  return new Promise<ImportFileTaskResult | ImportPasteTaskResult>((resolve, reject) => {
    let settled = false;

    const fail = (error: Error): void => settle(() => reject(error));
    const succeed = (result: ImportFileTaskResult | ImportPasteTaskResult): void => settle(() => resolve(result));

    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      void worker.terminate().catch(() => undefined);
      finish();
    }

    function onAbort(): void {
      try {
        worker.postMessage({ type: 'cancel' });
      } catch {
        // worker 可能已终止
      }
      fail(new ImportCancelledError());
    }

    function onMessage(value: unknown): void {
      const event = value as ImportWorkerEvent;
      switch (event.type) {
        case 'ready':
          worker.postMessage(wireRequest);
          return;
        case 'progress':
          onProgress?.(event.progress);
          return;
        case 'chunk': {
          // 主线程分块写入工作区；写成功后把新修订号回执给 worker 继续下一块。
          let next: number | Promise<number>;
          try {
            next = writer.append(event.draftId, event.expectedRevision, event.category, event.rows);
          } catch (error) {
            fail(error as Error);
            return;
          }
          Promise.resolve(next).then(
            (newRevision) => {
              try {
                worker.postMessage({ type: 'revision', chunkId: event.chunkId, newRevision });
              } catch (error) {
                fail(error as Error);
              }
            },
            (error) => fail(error as Error),
          );
          return;
        }
        case 'result':
          succeed(event.result);
          return;
        case 'error':
          fail(toHostError(event));
          return;
        default:
          return;
      }
    }

    function onError(error: Error): void {
      fail(signal?.aborted ? new ImportCancelledError() : new ImportWorkerError(error.name, `worker 线程异常终止: ${error.message}`));
    }

    function onExit(code: number): void {
      if (!settled) {
        fail(new ImportWorkerError('worker-exit', `worker 提前退出（exit code ${code}），未返回导入结果`));
      }
    }

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 把 worker 结构化错误事件还原为宿主侧错误类型（跨线程错误协议）。 */
function toHostError(event: ImportWorkerErrorEvent): Error {
  switch (event.code) {
    case 'cancelled':
      return new ImportCancelledError(event.message);
    case 'preflight':
      return new XlsxPreflightError(event.detail as XlsxPreflightResult, event.message);
    case 'paste-overlay':
      return new PasteOverlayError(event.detail as PasteOverlayVerdict, event.message);
    case 'worker':
      return new ImportWorkerError(event.name, event.message);
  }
}

// ---------------------------------------------------------------------------
// 跨线程请求白名单序列化（tasks 8.20：真实打包 DataCloneError 修复）
// ---------------------------------------------------------------------------

/** 宿主专属字段：只允许经宿主参数传递，绝不允许出现在跨线程 params 中。 */
const HOST_OWNED_PARAM_KEYS = ['writer', 'onProgress', 'signal'] as const;

/** 文件任务 params 的跨线程白名单字段（与 FileWorkerRunParams 逐字段对齐）。 */
const FILE_WIRE_PARAM_KEYS = ['draftId', 'expectedRevision', 'buffer', 'fileName', 'limits', 'chunkSize'] as const;

/** 粘贴任务 params 的跨线程白名单字段（与 PasteWorkerRunParams 逐字段对齐）。 */
const PASTE_WIRE_PARAM_KEYS = [
  'draftId',
  'expectedRevision',
  'category',
  'text',
  'headerConfirmed',
  'append',
  'existingRows',
  'existingColumns',
  'dateSystem',
  'chunkSize',
] as const;

/**
 * 显式白名单构造 postMessage 请求：
 * 1) 运行时检测宿主专属字段（writer/onProgress/signal），存在即抛明确协议错误——
 *    不信任调用方的 Omit 类型（类型层面移除不改变运行时对象）；
 * 2) 只挑选白名单字段构造 wire params（杜绝未知/函数/AbortSignal 混入）；
 * 3) structuredClone 断言：白名单后的请求必须可跨线程克隆，失败给明确协议错误。
 */
function buildWireRequest(
  request: { type: 'run-file'; params: FileWorkerRunParams } | { type: 'run-paste'; params: PasteWorkerRunParams },
): ImportWorkerRunRequest {
  const params = request.params as Record<string, unknown>;
  const presentForbidden = HOST_OWNED_PARAM_KEYS.filter((key) => key in params);
  if (presentForbidden.length > 0) {
    throw new ImportWorkerError(
      'params-must-not-carry-host-fields',
      `导入任务 params 携带了宿主专属字段 ${presentForbidden.join('、')}：writer/onProgress/signal 必须经宿主参数传递，禁止进入 postMessage（否则真实打包触发 DataCloneError）`,
    );
  }
  const keys = request.type === 'run-file' ? FILE_WIRE_PARAM_KEYS : PASTE_WIRE_PARAM_KEYS;
  const wire: Record<string, unknown> = {};
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined) wire[key] = value;
  }
  try {
    structuredClone(wire);
  } catch (error) {
    throw new ImportWorkerError(
      'params-not-cloneable',
      `导入任务 params 经白名单序列化后仍不可结构化克隆（${error instanceof Error ? error.message : String(error)}），拒绝启动 worker`,
    );
  }
  return request.type === 'run-file'
    ? { type: 'run-file', params: wire as unknown as FileWorkerRunParams }
    : { type: 'run-paste', params: wire as unknown as PasteWorkerRunParams };
}
