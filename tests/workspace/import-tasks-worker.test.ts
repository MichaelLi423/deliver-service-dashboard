import { join } from 'node:path';
import { threadId as mainThreadId, Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  bootstrapWorkspaceDatabase,
  closeWorkspaceDatabase,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import {
  ImportWorkerError,
  runImportFileTaskInWorker,
  runImportPasteTaskInWorker,
} from '../../src/domain/capabilities/historical-data-import/import-worker/import-worker-host';
import {
  ImportCancelledError,
  isImportCancelled,
  PasteOverlayError,
  runImportPasteTask,
  type ChunkWritePort,
  type ImportProgress,
} from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { fieldCatalogFor } from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { TEMPLATE_INSTRUCTIONS_SHEET } from '../../src/domain/capabilities/historical-data-import/template';
import { XlsxPreflightError } from '../../src/domain/capabilities/historical-data-import/zip-preflight';
import { IMPORT_CATEGORY_LABELS, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { createImportWorkerFactory } from '../helpers/import-worker-factory';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 8.20 真实工作线程：worker host + worker entry/protocol。
 *
 * - 文件读取与规范化在 worker 线程执行（threadId 不同于主线程）；
 * - 主进程接收 progress / chunk，分块写入工作区并回执修订号；
 * - AbortSignal 取消 worker 与输入读取；取消/worker 失败恢复操作前最后成功
 *   草稿修订、不形成部分 merge；运行态重启恢复回到最后稳定草稿修订。
 */

function openWorkspace(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
}

function workspaceWriter(repo: WorkspaceRepository): ChunkWritePort {
  return {
    append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
  };
}

/** 构造带数据行的模板工作簿（project N 行 + service_order M 行）。 */
async function buildTemplateWithRows(projectCount: number, serviceOrderCount: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
  instructions.getCell('A2').value = '模板版本';
  instructions.getCell('B2').value = '1';
  const categories: Array<[ImportCategory, number]> = [
    ['project', projectCount],
    ['service_order', serviceOrderCount],
  ];
  for (const [category, count] of categories) {
    const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS[category]);
    const headers = ['source_row_id', ...fieldCatalogFor(category).map((f) => f.label)];
    ws.addRow(headers);
    for (let i = 0; i < count; i += 1) {
      const row: (string | number)[] = headers.map((h) => {
        switch (h) {
          case 'source_row_id':
            return `sid-${category}-${i}`;
          case 'ECC':
            return `E-${i.toString().padStart(4, '0')}`;
          case '服务单号':
            return `SO-${i.toString().padStart(4, '0')}`;
          case '客户名称':
          case '客户单位':
            return `客户${i}`;
          case '开单类型':
            return 'pm';
          case '开单时间':
            return '2026-07-01';
          case '工程师':
            return '甲';
          default:
            return '';
        }
      });
      ws.addRow(row);
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('8.20 import worker 真实工作线程', () => {
  it('worker 线程执行文件读取/规范化：threadId 不同于主线程，结果与主进程内执行一致，分块写入工作区', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: 'worker 草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const writer = workspaceWriter(repo);
      const buffer = await buildTemplateWithRows(10, 5);
      const { factory, workers } = createImportWorkerFactory();
      const result = await runImportFileTaskInWorker(
        { draftId: d.id, expectedRevision: rev, buffer, fileName: '模板导入.xlsx', chunkSize: 3 },
        writer,
        { createWorker: factory },
      );

      // 真实工作线程：threadId 不同于主线程
      expect(workers).toHaveLength(1);
      expect(workers[0].threadId).not.toBe(mainThreadId);
      // 结果与主进程内执行一致
      expect(result.normalizedRows).toBe(15);
      expect(result.categories.project).toBe(10);
      expect(result.categories.service_order).toBe(5);
      expect(result.templateMode).toBe(true);
      // 分块写入：project 4 块（10 行，chunkSize 3）+ service_order 2 块（5 行）= 6 次修订推进
      expect(repo.getDraft(d.id)!.revision).toBe(rev + 6);
      const projectRows = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 });
      expect(projectRows.total).toBe(10);
      expect(projectRows.rows[0].businessKey).toBe('E-0000');
      expect(repo.queryRows(d.id, { category: 'service_order', offset: 0, limit: 100 }).total).toBe(5);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('worker 持续报告阶段与行数：writing 单调递增，done 等于规范化总行数', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '进度草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing');
      const buffer = await buildTemplateWithRows(10, 5);
      const { factory } = createImportWorkerFactory();
      const events: ImportProgress[] = [];
      await runImportFileTaskInWorker(
        { draftId: d.id, expectedRevision: rev, buffer, fileName: '模板导入.xlsx', chunkSize: 3 },
        workspaceWriter(repo),
        { createWorker: factory, onProgress: (p) => events.push(p) },
      );

      expect(events[0].stage).toBe('preflight');
      expect(events.some((e) => e.stage === 'reading')).toBe(true);
      const writing = events.filter((e) => e.stage === 'writing');
      expect(writing.length).toBeGreaterThan(1); // 分块写入多次报告进度
      const done = events[events.length - 1];
      expect(done.stage).toBe('done');
      expect(done.currentRows).toBe(15);
      expect(done.totalRows).toBe(15);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('AbortSignal 取消 worker：抛 ImportCancelledError，保留最后已保存修订，不形成部分 merge', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '取消草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const buffer = await buildTemplateWithRows(150, 200);
      const controller = new AbortController();
      const { factory } = createImportWorkerFactory();
      const task = runImportFileTaskInWorker(
        { draftId: d.id, expectedRevision: rev, buffer, fileName: '模板导入.xlsx', chunkSize: 50 },
        workspaceWriter(repo),
        {
          createWorker: factory,
          signal: controller.signal,
          onProgress: (p) => {
            // project 3 块写完后（150 行）立即取消：service_order 首个分块不会写入。
            if (p.stage === 'writing' && p.currentRows >= 150) controller.abort();
          },
        },
      );
      await expect(task).rejects.toSatisfy((err: unknown) => isImportCancelled(err));
      expect(controller.signal.aborted).toBe(true);

      // 取消后保留最后一次已保存修订：project 全部 150 行已写入，service_order 未写入。
      const draft = repo.getDraft(d.id)!;
      expect(draft.state).toBe('parsing');
      expect(draft.revision).toBe(rev + 3);
      expect(repo.queryRows(d.id, { category: 'project', offset: 0, limit: 1000 }).total).toBe(150);
      expect(repo.queryRows(d.id, { category: 'service_order', offset: 0, limit: 1000 }).total).toBe(0);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('已中止信号在创建 worker 前直接取消', async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory, workers } = createImportWorkerFactory();
    await expect(
      runImportFileTaskInWorker(
        { draftId: 'd1', expectedRevision: 1, buffer: Buffer.from('x'), fileName: 'x.xlsx' },
        { append: () => 1 },
        { createWorker: factory, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ImportCancelledError);
    // 未启动 worker 线程
    expect(workers).toHaveLength(0);
  });

  it('取消后运行态重启恢复：回到最后稳定草稿修订，worker 运行期行被清除', async () => {
    const dir = makeTempDir();
    const { repo, close } = openWorkspace(dir);
    const d = repo.createDraft({ name: '恢复草稿', createdBy: null, createdByUsername: null });
    const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
    const buffer = await buildTemplateWithRows(150, 0);
    const controller = new AbortController();
    const { factory } = createImportWorkerFactory();
    await runImportFileTaskInWorker(
      { draftId: d.id, expectedRevision: rev, buffer, fileName: '模板导入.xlsx', chunkSize: 50 },
      workspaceWriter(repo),
      {
        createWorker: factory,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.stage === 'writing' && p.currentRows >= 150) controller.abort();
        },
      },
    ).catch((err: unknown) => {
      expect(isImportCancelled(err)).toBe(true);
    });
    close();

    // 重新打开工作区（模拟重启）：parsing → 回到最后稳定修订（draft/rev 1），运行期行清除。
    const ws2 = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
    try {
      const repo2 = new WorkspaceRepository(ws2.db);
      const report = repo2.recoverRuntimeStates();
      expect(report.recovered.some((r) => r.draftId === d.id && r.to === 'draft')).toBe(true);
      const draft2 = repo2.getDraft(d.id)!;
      expect(draft2.state).toBe('draft');
      expect(draft2.revision).toBe(1);
      expect(repo2.queryRows(d.id, { category: 'project', offset: 0, limit: 1000 }).total).toBe(0);
    } finally {
      closeWorkspaceDatabase(ws2.db);
      cleanupTempDir(dir);
    }
  });

  it('worker 崩溃（未返回结果）：抛 ImportWorkerError，部分块保留在最后已保存修订，重启恢复稳定修订', async () => {
    // 模拟 worker 中途崩溃：先写一个块，收到修订回执后抛未捕获异常（线程异常终止）。
    const crashWorkerScript = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ type: 'ready' });
      parentPort.on('message', (msg) => {
        if (msg.type === 'run-file') {
          parentPort.postMessage({
            type: 'chunk',
            chunkId: 1,
            draftId: msg.params.draftId,
            expectedRevision: msg.params.expectedRevision,
            category: 'project',
            rows: [{
              rowId: 'crash-row',
              businessKey: 'E-CRASH',
              sourceFile: msg.params.fileName,
              sourceSheet: '项目与合同',
              sourceRow: 2,
              cells: { 'contract.ecc': 'E-CRASH' },
            }],
          });
        } else if (msg.type === 'revision') {
          throw new Error('模拟 worker 崩溃');
        }
      });
    `;
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '崩溃草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const task = runImportFileTaskInWorker(
        { draftId: d.id, expectedRevision: rev, buffer: Buffer.from('ignored'), fileName: '崩溃导入.xlsx' },
        workspaceWriter(repo),
        { createWorker: () => new Worker(crashWorkerScript, { eval: true }) },
      );
      await expect(task).rejects.toBeInstanceOf(ImportWorkerError);

      // 崩溃前已写入的块保留在最后一次已保存修订（rev + 1），草稿保持 parsing（不形成部分 merge）。
      const draft = repo.getDraft(d.id)!;
      expect(draft.state).toBe('parsing');
      expect(draft.revision).toBe(rev + 1);
      expect(repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 }).total).toBe(1);
      close();

      // 重启恢复：回到最后稳定草稿修订，崩溃期行被清除。
      const ws2 = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
      try {
        const repo2 = new WorkspaceRepository(ws2.db);
        const report = repo2.recoverRuntimeStates();
        expect(report.recovered.some((r) => r.draftId === d.id && r.to === 'draft')).toBe(true);
        const draft2 = repo2.getDraft(d.id)!;
        expect(draft2.state).toBe('draft');
        expect(draft2.revision).toBe(1);
        expect(repo2.queryRows(d.id, { category: 'project', offset: 0, limit: 100 }).total).toBe(0);
      } finally {
        closeWorkspaceDatabase(ws2.db);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('粘贴任务在 worker 内执行：计划摘要与主进程内执行一致，并分块写入工作区', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '粘贴草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
      const lines = [headers.join('\t')];
      for (let i = 0; i < 7; i += 1) {
        const vals: Record<string, string> = { 'source_row_id': `p-${i}`, ECC: `PE-${i}`, 客户名称: `客户${i}`, 区域: '华东' };
        lines.push(headers.map((h) => vals[h] ?? '').join('\t'));
      }
      const text = lines.join('\n');

      // 主进程内执行（内存 writer）作为摘要基准
      const inProcess = await runImportPasteTask({
        draftId: d.id,
        expectedRevision: rev,
        category: 'project',
        text,
        headerConfirmed: true,
        append: true,
        existingRows: 0,
        existingColumns: headers.length,
        chunkSize: 3,
        writer: { append: (_draftId, expectedRevision) => expectedRevision + 1 },
      });
      // worker 内执行（写入工作区）
      const { factory, workers } = createImportWorkerFactory();
      const events: ImportProgress[] = [];
      const result = await runImportPasteTaskInWorker(
        {
          draftId: d.id,
          expectedRevision: rev,
          category: 'project',
          text,
          headerConfirmed: true,
          append: true,
          existingRows: 0,
          existingColumns: headers.length,
          chunkSize: 3,
        },
        workspaceWriter(repo),
        { createWorker: factory, onProgress: (p) => events.push(p) },
      );

      expect(workers[0].threadId).not.toBe(mainThreadId);
      expect(result.normalizedRows).toBe(7);
      expect(result.overlay.allowed).toBe(true);
      expect(result.planDigest).toBe(inProcess.planDigest); // worker 与主进程内执行同一规范化管线
      expect(repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 }).total).toBe(7);
      expect(events.some((e) => e.stage === 'writing')).toBe(true);
      expect(events[events.length - 1].stage).toBe('done');
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('worker 内未通过预检：宿主还原 XlsxPreflightError（跨线程错误类型协议）', async () => {
    const { factory } = createImportWorkerFactory();
    await expect(
      runImportFileTaskInWorker(
        { draftId: 'd1', expectedRevision: 1, buffer: Buffer.from('not-a-zip'), fileName: '非法文件.xlsx' },
        { append: () => 1 },
        { createWorker: factory },
      ),
    ).rejects.toBeInstanceOf(XlsxPreflightError);
  });

  it('worker 内覆盖预检不通过：宿主还原 PasteOverlayError（跨线程错误类型协议）', async () => {
    const { factory } = createImportWorkerFactory();
    const text = 'ECC\t客户名称\nE-1\t华东';
    await expect(
      runImportPasteTaskInWorker(
        {
          draftId: 'd1',
          expectedRevision: 1,
          category: 'project',
          text,
          headerConfirmed: true,
          append: false,
          existingRows: 0,
          existingColumns: 0,
        },
        { append: () => 1 },
        { createWorker: factory },
      ),
    ).rejects.toBeInstanceOf(PasteOverlayError);
  });
});
