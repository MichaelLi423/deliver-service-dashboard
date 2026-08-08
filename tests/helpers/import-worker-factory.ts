import { buildSync } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * import worker 测试工厂（tasks 8.20 真实工作线程）。
 *
 * vitest 直接执行 TS 源文件，`new Worker(new URL(...))` 无法加载未打包的
 * import-worker-entry.ts（Node 类型剥离不支持扩展名省略的导入图）。因此测试
 * 用 esbuild 把 worker 入口（含 exceljs/yauzl 依赖）打包为独立 CJS 文件，
 * 再以真实的 node:worker_threads.Worker 运行 —— 与 Electron Forge 生产路径
 * （webpack 原生 worker chunk）等价，证明文件读取/规范化确实在独立线程执行。
 *
 * 打包仅做一次并缓存；打包目录位于系统临时目录，不进入工作区。
 */

const WORKER_ENTRY = fileURLToPath(
  new URL('../../src/domain/capabilities/historical-data-import/import-worker/import-worker-entry.ts', import.meta.url),
);

let bundlePath: string | null = null;

function buildImportWorkerBundle(): string {
  if (bundlePath === null) {
    const dir = mkdtempSync(join(tmpdir(), 'import-worker-'));
    bundlePath = join(dir, 'import-worker-entry.cjs');
    const result = buildSync({
      entryPoints: [WORKER_ENTRY],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile: bundlePath,
      logLevel: 'silent',
    });
    if (result.errors.length > 0) {
      throw new Error(`import worker 打包失败: ${result.errors.map((e) => e.text).join('; ')}`);
    }
  }
  return bundlePath;
}

export interface ImportWorkerFactory {
  /** 创建真实工作线程 worker（宿主每次运行独占一个）。 */
  factory: () => Worker;
  /** 已创建的 worker 引用（供断言 threadId 不同于主线程等）。 */
  workers: Worker[];
}

/** 创建使用 esbuild 打包入口的真实 worker 工厂。 */
export function createImportWorkerFactory(): ImportWorkerFactory {
  const path = buildImportWorkerBundle();
  const workers: Worker[] = [];
  return {
    factory: () => {
      const worker = new Worker(path);
      workers.push(worker);
      return worker;
    },
    workers,
  };
}
