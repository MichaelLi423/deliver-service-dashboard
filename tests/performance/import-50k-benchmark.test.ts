import { join } from 'node:path';
import { threadId as mainThreadId } from 'node:worker_threads';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapWorkspaceDatabase,
  closeWorkspaceDatabase,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { isImportCancelled, type ChunkWritePort, type ImportProgress } from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { runImportFileTaskInWorker, runImportPasteTaskInWorker } from '../../src/domain/capabilities/historical-data-import/import-worker/import-worker-host';
import {
  buildLargeTemplateBuffer,
  LARGE_FIXTURE_CELLS_PER_ROW,
  LARGE_FIXTURE_COLUMNS,
  LARGE_FIXTURE_ROWS,
  projectPasteText,
} from '../helpers/import-fixtures';
import { createImportWorkerFactory } from '../helpers/import-worker-factory';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 8.69 50,000 行文件与粘贴基准（真实工作线程）。
 *
 * 固定夹具：project 类别 50k 行 × 13 列（含 source_row_id；每行填充 9 个数据
 * 单元格）。字节数由构建后实际测量并在断言中记录（确定性合成数据，无随机）。
 *
 * 验证：读取/规范化/写入显示可观察进度（首个 progress 立即到达）、可取消且
 * 取消后 workspace 无部分 merge（重启恢复最后稳定修订）、worker 重负载期间
 * 主线程保持可响应（事件循环定时器不被 worker 阻塞）。
 */

const CHUNK = 2000;
const LARGE_CANCEL_AT = 20_000;

function openWorkspace(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
}

function workspaceWriter(repo: WorkspaceRepository): ChunkWritePort {
  return {
    append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
  };
}

function newDraftInParsing(repo: WorkspaceRepository): { id: string; rev: number } {
  const d = repo.createDraft({ name: '50k 基准草稿', createdBy: 'acc-bench', createdByUsername: '基准账号' });
  return { id: d.id, rev: repo.transitionState(d.id, 1, 'start_parsing') };
}

describe('8.69 50,000 行文件与粘贴基准（worker）', () => {
  let largeBuffer: Buffer;
  let fileBytes: number;
  let pasteText: string;
  let pasteBytes: number;

  beforeAll(async () => {
    largeBuffer = await buildLargeTemplateBuffer(LARGE_FIXTURE_ROWS);
    fileBytes = largeBuffer.byteLength;
    pasteText = projectPasteText(Array.from({ length: LARGE_FIXTURE_ROWS }, (_, i) => ({
      source_row_id: `sid-ECC-${String(i).padStart(6, '0')}`,
      ECC: `ECC-${String(i).padStart(6, '0')}`,
      客户名称: `客户${i}`,
      区域: '华东',
      合同开始日期: '2025-01-01',
      合同截止日期: '2025-12-31',
      仪器名称: `仪器${i}`,
      序列号: `SN-${String(i).padStart(6, '0')}`,
      合同USD含税金额: '10000.00',
    })));
    pasteBytes = Buffer.byteLength(pasteText, 'utf8');
  }, 120_000);

  it('夹具定义固定：50k 行、13 列（含 source_row_id）、每行 9 个数据单元格，字节数在声明范围内', () => {
    expect(LARGE_FIXTURE_ROWS).toBe(50_000);
    expect(LARGE_FIXTURE_COLUMNS).toBe(13);
    expect(LARGE_FIXTURE_CELLS_PER_ROW).toBe(9);
    // 确定性合成内容：字节数应稳定落在声明区间（每行约 40~90 字节）。
    expect(fileBytes).toBeGreaterThan(50_000 * 30);
    expect(fileBytes).toBeLessThan(50_000 * 200);
    expect(pasteBytes).toBeGreaterThan(50_000 * 30);
    expect(pasteBytes).toBeLessThan(50_000 * 300);
    // 记录实测指标（断言失败时在报告中体现）。
    // fileBytes= 50k 行 × ~55 字节/行
    expect(fileBytes / LARGE_FIXTURE_ROWS).toBeGreaterThan(30);
    expect(fileBytes / LARGE_FIXTURE_ROWS).toBeLessThan(200);
    // 记录实测指标
    console.log(`[8.69 metric] fileBytes=${fileBytes} bytes=${(fileBytes / 1024 / 1024).toFixed(2)} MiB bytesPerRow=${(fileBytes / LARGE_FIXTURE_ROWS).toFixed(1)} pasteBytes=${pasteBytes} pasteMiB=${(pasteBytes / 1024 / 1024).toFixed(2)}`);
  });

  it('50k 文件 worker：首个 progress 立即到达、持续阶段、done 行数与 workspace 全量一致', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const { id, rev } = newDraftInParsing(repo);
      const { factory, workers } = createImportWorkerFactory();
      const progress: ImportProgress[] = [];
      const fileRunStart = performance.now();
      const result = await runImportFileTaskInWorker(
        { draftId: id, expectedRevision: rev, buffer: largeBuffer, fileName: '50k基准.xlsx', chunkSize: CHUNK },
        workspaceWriter(repo),
        {
          createWorker: factory,
          onProgress: (p) => progress.push(p),
        },
      );
      const fileWorker50kMs = performance.now() - fileRunStart;

      expect(workers[0].threadId).not.toBe(mainThreadId);
      console.log(`[8.69 metric] fileWorker50kMs=${Math.round(fileWorker50kMs)} firstProgressImmediate=${progress[0]?.stage === 'preflight'}`);
      expect(result.normalizedRows).toBe(LARGE_FIXTURE_ROWS);
      expect(result.categories.project).toBe(LARGE_FIXTURE_ROWS);
      // 首个进度为 preflight（写入任何行之前即可观察）
      expect(progress[0].stage).toBe('preflight');
      expect(progress.some((p) => p.stage === 'reading')).toBe(true);
      const done = progress[progress.length - 1];
      expect(done.stage).toBe('done');
      expect(done.currentRows).toBe(LARGE_FIXTURE_ROWS);
      expect(done.totalRows).toBe(LARGE_FIXTURE_ROWS);
      // workspace 全量写入：50k 行 / chunk 2000 = 25 次修订推进
      expect(repo.getDraft(id)!.revision).toBe(rev + Math.ceil(LARGE_FIXTURE_ROWS / CHUNK));
      expect(repo.queryRows(id, { category: 'project', offset: 0, limit: 1 }).total).toBe(LARGE_FIXTURE_ROWS);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  }, 120_000);

  it('50k 文件 worker 中途取消：抛 ImportCancelledError、workspace 保留最后已保存修订、重启恢复稳定修订（无部分 merge）', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const { id, rev } = newDraftInParsing(repo);
      const controller = new AbortController();
      const { factory } = createImportWorkerFactory();
      const task = runImportFileTaskInWorker(
        { draftId: id, expectedRevision: rev, buffer: largeBuffer, fileName: '50k基准.xlsx', chunkSize: CHUNK },
        workspaceWriter(repo),
        {
          createWorker: factory,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.stage === 'writing' && p.currentRows >= LARGE_CANCEL_AT) controller.abort();
          },
        },
      );
      await expect(task).rejects.toSatisfy((err: unknown) => isImportCancelled(err));

      // 已写入块保留在最后一次已保存修订：20k/2000 = 10 块。
      const draft = repo.getDraft(id)!;
      expect(draft.state).toBe('parsing');
      expect(draft.revision).toBe(rev + LARGE_CANCEL_AT / CHUNK);
      const written = repo.queryRows(id, { category: 'project', offset: 0, limit: 1 }).total;
      expect(written).toBe(LARGE_CANCEL_AT);
      expect(written).toBeLessThan(LARGE_FIXTURE_ROWS);
      close();

      // 重启恢复：回到最后稳定草稿修订，取消期行清除（不形成部分 merge）。
      const ws2 = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
      try {
        const repo2 = new WorkspaceRepository(ws2.db);
        const report = repo2.recoverRuntimeStates();
        expect(report.recovered.some((r) => r.draftId === id && r.to === 'draft')).toBe(true);
        const draft2 = repo2.getDraft(id)!;
        expect(draft2.state).toBe('draft');
        expect(draft2.revision).toBe(1);
        expect(repo2.queryRows(id, { category: 'project', offset: 0, limit: 1 }).total).toBe(0);
      } finally {
        closeWorkspaceDatabase(ws2.db);
      }
    } finally {
      cleanupTempDir(dir);
    }
  }, 120_000);

  it('50k worker 重负载期间主线程保持可响应（事件循环定时器与工作区查询不被阻塞）', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const { id, rev } = newDraftInParsing(repo);
      const { factory } = createImportWorkerFactory();
      let resolveFirst: () => void;
      const firstProgress = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const task = runImportFileTaskInWorker(
        { draftId: id, expectedRevision: rev, buffer: largeBuffer, fileName: '50k基准.xlsx', chunkSize: CHUNK },
        workspaceWriter(repo),
        { createWorker: factory, onProgress: () => resolveFirst() },
      );
      await firstProgress;

      // worker 正在独立线程重负载解析；主线程定时器与 SQLite 查询应即时响应。
      const t0 = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const timerLatencyMs = performance.now() - t0;

      const q0 = performance.now();
      const probe = repo.queryRows(id, { category: 'project', offset: 0, limit: 10 });
      const queryMs = performance.now() - q0;
      expect(probe.total).toBeGreaterThanOrEqual(0); // 主线程查询可用（未阻塞）

      await task; // 最终完成（主线程未挂起）
      expect(repo.getDraft(id)!.revision).toBe(rev + Math.ceil(LARGE_FIXTURE_ROWS / CHUNK));

      // 记录实测指标：主线程 100ms 定时器延迟应远小于 worker 解析总时长。
      console.log(`[8.69 metric] mainThreadTimer100msLatencyMs=${Math.round(timerLatencyMs)} workspaceQueryMs=${Math.round(queryMs)}`);
      expect(timerLatencyMs).toBeLessThan(1000);
      expect(queryMs).toBeLessThan(200);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  }, 120_000);

  it('50k 粘贴 worker：持续进度、done 行数、workspace 全量写入，且计划摘要与同内容文件一致', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const { id, rev } = newDraftInParsing(repo);
      const { factory, workers } = createImportWorkerFactory();
      const progress: ImportProgress[] = [];
      const pasteRunStart = performance.now();
      const result = await runImportPasteTaskInWorker(
        {
          draftId: id,
          expectedRevision: rev,
          category: 'project',
          text: pasteText,
          headerConfirmed: true,
          append: true,
          existingRows: 0,
          existingColumns: LARGE_FIXTURE_COLUMNS,
          chunkSize: CHUNK,
        },
        workspaceWriter(repo),
        { createWorker: factory, onProgress: (p) => progress.push(p) },
      );

      const pasteWorker50kMs = performance.now() - pasteRunStart;
      console.log(`[8.69 metric] pasteWorker50kMs=${Math.round(pasteWorker50kMs)}`);
      expect(workers[0].threadId).not.toBe(mainThreadId);
      expect(result.normalizedRows).toBe(LARGE_FIXTURE_ROWS);
      expect(result.overlay.allowed).toBe(true);
      const done = progress[progress.length - 1];
      expect(done.stage).toBe('done');
      expect(done.currentRows).toBe(LARGE_FIXTURE_ROWS);
      expect(repo.getDraft(id)!.revision).toBe(rev + Math.ceil(LARGE_FIXTURE_ROWS / CHUNK));
      expect(repo.queryRows(id, { category: 'project', offset: 0, limit: 1 }).total).toBe(LARGE_FIXTURE_ROWS);

      // 50k 规模文件/粘贴同内容 → 相同规范化计划摘要（design D21 等价性）
      const fileResult = await runImportFileTaskInWorker(
        { draftId: id, expectedRevision: repo.getDraft(id)!.revision, buffer: largeBuffer, fileName: '50k基准.xlsx', chunkSize: CHUNK },
        { append: (_draftId, expectedRevision) => expectedRevision + 1 },
        { createWorker: factory },
      );
      expect(result.planDigest).toBe(fileResult.planDigest);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  }, 120_000);
});
