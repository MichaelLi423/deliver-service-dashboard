import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  bootstrapWorkspaceDatabase,
  closeWorkspaceDatabase,
} from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import {
  isImportCancelled,
  runImportFileTask,
  runImportPasteTask,
  type ChunkWritePort,
} from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { fieldCatalogFor } from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { TEMPLATE_INSTRUCTIONS_SHEET } from '../../src/domain/capabilities/historical-data-import/template';
import { IMPORT_CATEGORY_LABELS, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 8.20 可取消 worker 任务分块写入工作区；取消后恢复操作前最后一次已保存修订；
 * 运行态重启恢复回到最后稳定草稿修订（与 8.11 联动）。
 */

function openWorkspace(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
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

describe('8.20 分块写入工作区与取消恢复', () => {
  it('分块写入：每次 append 推进草稿修订，行数据落入工作区并保留来源定位', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '分块草稿', createdBy: null, createdByUsername: null });
      let rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const writer: ChunkWritePort = {
        append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
      };
      const buffer = await buildTemplateWithRows(10, 5);
      const result = await runImportFileTask({
        draftId: d.id,
        expectedRevision: rev,
        buffer,
        fileName: '模板导入.xlsx',
        chunkSize: 3,
        writer,
      });
      expect(result.newRevision).toBeGreaterThan(rev); // 多个分块 → 多次修订
      rev = result.newRevision;
      expect(rev).toBe(2 + 6); // project 4 块（10 行，chunkSize 3）+ service_order 2 块（5 行）

      const projectRows = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 });
      expect(projectRows.total).toBe(10);
      const first = projectRows.rows[0];
      expect(first.businessKey).toBe('E-0000');
      expect(first.sourceRowId).toBe('sid-project-0');
      expect(first.sourceSheet).toBe(IMPORT_CATEGORY_LABELS.project);
      const soRows = repo.queryRows(d.id, { category: 'service_order', offset: 0, limit: 100 });
      expect(soRows.total).toBe(5);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('取消：任务抛 ImportCancelledError，已写入块保留在最后一次已保存修订', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '取消草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const writer: ChunkWritePort = {
        append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
      };
      const buffer = await buildTemplateWithRows(150, 200);
      const controller = new AbortController();
      const task = runImportFileTask({
        draftId: d.id,
        expectedRevision: rev,
        buffer,
        fileName: '模板导入.xlsx',
        chunkSize: 50,
        signal: controller.signal,
        onProgress: (p) => {
          // project 3 块写完后（150 行）立即取消：service_order 首个分块在写入前被中止。
          if (p.stage === 'writing' && p.currentRows >= 150) controller.abort();
        },
        writer,
      });
      await expect(task).rejects.toSatisfy((err: unknown) => isImportCancelled(err));

      // 取消后保留最后一次已保存修订：project 全部 150 行已写入，service_order 未写入。
      const draft = repo.getDraft(d.id)!;
      expect(draft.state).toBe('parsing');
      expect(draft.revision).toBe(rev + 3);
      const projectRows = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 1000 });
      expect(projectRows.total).toBe(150);
      const soRows = repo.queryRows(d.id, { category: 'service_order', offset: 0, limit: 1000 });
      expect(soRows.total).toBe(0);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('运行态重启恢复：取消后重开回到最后稳定草稿修订，运行期行被清除', async () => {
    const dir = makeTempDir();
    const { repo, close } = openWorkspace(dir);
    const d = repo.createDraft({ name: '恢复草稿', createdBy: null, createdByUsername: null });
    const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
    const writer: ChunkWritePort = {
      append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
    };
    const buffer = await buildTemplateWithRows(150, 0);
    const controller = new AbortController();
    await runImportFileTask({
      draftId: d.id,
      expectedRevision: rev,
      buffer,
      fileName: '模板导入.xlsx',
      chunkSize: 50,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.stage === 'writing' && p.currentRows >= 150) controller.abort();
      },
      writer,
    }).catch((err: unknown) => {
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

  it('粘贴任务分块写入工作区并保持来源定位（pasteBatch / gridRow）', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '粘贴草稿', createdBy: null, createdByUsername: null });
      const rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const writer: ChunkWritePort = {
        append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
      };
      const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
      const lines = [headers.join('\t')];
      for (let i = 0; i < 7; i += 1) {
        const vals: Record<string, string> = { 'source_row_id': `p-${i}`, ECC: `PE-${i}`, 客户名称: `客户${i}` };
        lines.push(headers.map((h) => vals[h] ?? '').join('\t'));
      }
      const result = await runImportPasteTask({
        draftId: d.id,
        expectedRevision: rev,
        category: 'project',
        text: lines.join('\n'),
        headerConfirmed: true,
        append: true,
        existingRows: 0,
        existingColumns: headers.length,
        chunkSize: 3,
        writer,
      });
      expect(result.normalizedRows).toBe(7);
      const rows = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 100 });
      expect(rows.total).toBe(7);
      expect(rows.rows[0].businessKey).toBe('PE-0');
      expect(rows.rows[0].pasteBatch).toBe(result.pasteBatch);
      expect(rows.rows[0].sourceRow).toBe(2); // 表头占第 1 行
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('8.87 文件与粘贴数据在同一网格合并', () => {
  it('同一草稿先文件后粘贴：两种来源的行在同一类别网格共存，来源定位（sourceFile / pasteBatch）可区分', async () => {
    const dir = makeTempDir();
    try {
      const { repo, close } = openWorkspace(dir);
      const d = repo.createDraft({ name: '合并网格草稿', createdBy: null, createdByUsername: null });
      let rev = repo.transitionState(d.id, 1, 'start_parsing'); // rev 2
      const writer: ChunkWritePort = {
        append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows),
      };
      // ① 文件：1 行 project（source_file = 模板导入.xlsx）
      const buffer = await buildTemplateWithRows(1, 0);
      const fileResult = await runImportFileTask({
        draftId: d.id, expectedRevision: rev, buffer, fileName: '模板导入.xlsx',
        writer,
      });
      rev = fileResult.newRevision;
      // ② 粘贴：同类别 1 行（pasteBatch 区分）
      const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
      const text = [headers.join('\t'), ['p-1', 'PE-1', '客户粘贴', '', ...Array(headers.length - 4).fill('')].join('\t')].join('\n');
      const pasteResult = await runImportPasteTask({
        draftId: d.id, expectedRevision: rev, category: 'project', text,
        headerConfirmed: true, append: true, existingRows: 1, existingColumns: headers.length,
        writer,
      });
      rev = pasteResult.newRevision;

      // ③ 同一类别网格合并：2 行共存，来源定位可区分
      const window = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 10 });
      expect(window.total).toBe(2);
      expect(window.rows.some((r) => r.sourceFile === '模板导入.xlsx' && r.pasteBatch === null)).toBe(true);
      expect(window.rows.some((r) => r.sourceFile === null && r.pasteBatch === pasteResult.pasteBatch)).toBe(true);
      expect(window.rows.some((r) => r.businessKey === 'E-0000')).toBe(true);
      expect(window.rows.some((r) => r.businessKey === 'PE-1')).toBe(true);
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});
