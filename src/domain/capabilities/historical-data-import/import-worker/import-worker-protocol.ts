import type { AppendRowInput, ImportCategory } from '../workspace/workspace-model';
import type {
  ImportFileTaskParams,
  ImportFileTaskResult,
  ImportPasteTaskParams,
  ImportPasteTaskResult,
  ImportProgress,
} from '../import-tasks';

/**
 * import worker 协议（tasks 8.20 真实工作线程）。
 *
 * 主进程（worker host）与工作线程（worker entry）通过 `postMessage` 交换
 * 可结构化克隆的普通对象：
 * - 主进程 → worker：run-file / run-paste（含完整参数，buffer 经克隆传入）、
 *   cancel（协作式中止输入读取）、revision（分块写入结果回执）；
 * - worker → 主进程：ready（线程就绪握手）、progress（阶段与行数）、
 *   chunk（规范化行块，由主进程分块写入工作区）、result（成功结果）、
 *   error（结构化错误码，供宿主还原跨线程错误类型）。
 *
 * 金额与摘要不经过二进制浮点运算；错误 detail 只携带可克隆的普通对象
 * （如预检结果 / 覆盖预检结论），不携带业务值之外的敏感内容。
 */

/** 文件任务参数（去掉仅主进程持有的 writer / onProgress / signal）。 */
export type FileWorkerRunParams = Omit<ImportFileTaskParams, 'writer' | 'onProgress' | 'signal'>;

/** 粘贴任务参数（同上）。 */
export type PasteWorkerRunParams = Omit<ImportPasteTaskParams, 'writer' | 'onProgress' | 'signal'>;

/** 主进程发起一次运行的请求。 */
export type ImportWorkerRunRequest =
  | { type: 'run-file'; params: FileWorkerRunParams }
  | { type: 'run-paste'; params: PasteWorkerRunParams };

/** 主进程 → worker 的全部消息。 */
export type ImportWorkerRequest = ImportWorkerRunRequest | { type: 'cancel' } | {
  /** 分块写入结果回执：新草稿修订号，驱动 worker 继续下一块。 */
  type: 'revision';
  chunkId: number;
  newRevision: number;
};

/** worker 错误码：取消 / 预检拒绝 / 覆盖预检拒绝 / 其他 worker 内部错误。 */
export type ImportWorkerErrorCode = 'cancelled' | 'preflight' | 'paste-overlay' | 'worker';

export interface ImportWorkerErrorEvent {
  type: 'error';
  code: ImportWorkerErrorCode;
  /** 原始错误名（跨线程不可复用 instanceof，宿主按 code 还原类型）。 */
  name: string;
  message: string;
  /** preflight 结果 / 覆盖预检结论（普通可克隆对象）。 */
  detail?: unknown;
}

/** worker → 主进程 的事件。 */
export type ImportWorkerEvent =
  | { type: 'ready' }
  | { type: 'progress'; progress: ImportProgress }
  | {
      type: 'chunk';
      chunkId: number;
      draftId: string;
      expectedRevision: number;
      category: ImportCategory;
      rows: AppendRowInput[];
    }
  | { type: 'result'; result: ImportFileTaskResult | ImportPasteTaskResult }
  | ImportWorkerErrorEvent;
