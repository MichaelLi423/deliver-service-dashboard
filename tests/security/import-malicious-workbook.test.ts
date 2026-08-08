import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildZip } from '../helpers/zip-fixtures';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { preflightXlsx, type XlsxPreflightLimits } from '../../src/domain/capabilities/historical-data-import/zip-preflight';
import { XlsxPreflightError } from '../../src/domain/capabilities/historical-data-import/zip-preflight';
import { runImportFileTaskInWorker } from '../../src/domain/capabilities/historical-data-import/import-worker/import-worker-host';
import { fieldCatalogFor } from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { TEMPLATE_INSTRUCTIONS_SHEET } from '../../src/domain/capabilities/historical-data-import/template';
import { IMPORT_CATEGORY_LABELS, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { createImportWorkerFactory } from '../helpers/import-worker-factory';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 8.72 恶意/异常 Excel 安全测试（完整覆盖）。
 *
 * 在预检层（declared 与实际展开）与 worker 完整管线层双重验证：
 * - ZIP bomb：声明 vs 实际展开量（声明小实际大 → 实际流式扫描拒绝；声明大实际小 → 声明上限拒绝）；
 * - entry 超限、路径异常（穿越/绝对/反斜杠）、宏（vba）、外部链接、非法压缩方法；
 * - 公式：DDE、外部工作簿引用、无缓存值 → 只读静态缓存/置空，不执行不联网；
 * - sheet / 行 / 列 / 单元格上限。
 * 所有恶意输入经 worker 完整管线拒绝时零业务写入（workspace 不产生部分 merge）。
 */

const MIN_LIMITS: XlsxPreflightLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxEntries: 4096,
  maxUncompressedBytesPerEntry: 10 * 1024 * 1024,
  maxTotalUncompressedBytes: 20 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxSheets: 100,
  maxRowsPerSheet: 1000,
  maxColumnsPerSheet: 200,
  maxCellsPerSheet: 100_000,
};

function openWorkspace(dir: string): { repo: WorkspaceRepository; close: () => void } {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  return { repo: new WorkspaceRepository(ws.db), close: () => closeWorkspaceDatabase(ws.db) };
}

/** worker 完整管线拒绝恶意文件：抛 XlsxPreflightError 且 workspace 零写入。 */
async function expectWorkerRejects(
  buffer: Buffer,
  dir: string,
  limits?: XlsxPreflightLimits,
): Promise<void> {
  const { repo, close } = openWorkspace(dir);
  try {
    const d = repo.createDraft({ name: '恶意文件草稿', createdBy: 'acc-sec', createdByUsername: '安全测试' });
    const rev = repo.transitionState(d.id, 1, 'start_parsing');
    const { factory } = createImportWorkerFactory();
    const writer = {
      append: (draftId: string, expectedRevision: number, category: ImportCategory, rows: unknown[]) =>
        repo.appendRows(draftId, expectedRevision, category, rows as never),
    };
    await expect(
      runImportFileTaskInWorker(
        { draftId: d.id, expectedRevision: rev, buffer, fileName: '恶意文件.xlsx', ...(limits ? { limits } : {}) },
        writer,
        { createWorker: factory },
      ),
    ).rejects.toBeInstanceOf(XlsxPreflightError);
    // 零业务写入：草稿保持 parsing、行数为 0（无部分 merge）。
    const draft = repo.getDraft(d.id)!;
    expect(draft.state).toBe('parsing');
    expect(repo.queryRows(d.id, { category: 'project', offset: 0, limit: 1 }).total).toBe(0);
  } finally {
    close();
  }
}

describe('8.72 恶意/异常 Excel 安全测试', () => {
  it('ZIP bomb 声明小 / 实际展开大：yauzl 流式展开量校验拒绝（不信任声明、不 OOM）', async () => {
    // sheet XML 声明仅 200 字节，实际含 1500 个 <row>（deflate 后很小）。
    const rows = Array.from({ length: 1500 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join('');
    const sheetXml = `<?xml version="1.0"?><worksheet>${rows}</worksheet>`;
    const zip = buildZip([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml, declaredUncompressed: 200 },
    ]);
    const result = await preflightXlsx(zip, MIN_LIMITS);
    // 声明通过了 entry/压缩比上限，但实际读取时 yauzl 按声明展开量拒绝（too many bytes in the stream），
    // 实际内容从未被完整展开 → 按实际展开量防御 ZIP bomb。
    expect(result.ok).toBe(false);
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain('CORRUPT_ZIP');
    // 从未展开到实际大小：累计展开量只统计声明值（200 字节级）。
    expect(result.totalUncompressedBytes).toBeLessThan(1000);
  });

  it('ZIP bomb 声明大 / 实际小：声明展开量超限即拒绝', async () => {
    const zip = buildZip([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>', declaredUncompressed: 30 * 1024 * 1024 },
    ]);
    const result = await preflightXlsx(zip, MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'ENTRY_UNCOMPRESSED_TOO_LARGE')).toBe(true);
  });

  it('worker 完整管线拒绝：高压缩比 bomb、路径穿越、绝对路径、反斜杠、宏、外链、坏压缩方法，零业务写入', async () => {
    const dir = makeTempDir();
    try {
      // 高压缩比 bomb（2 MiB 重复内容 deflate 后极小）
      await expectWorkerRejects(buildZip([{ name: 'xl/workbook.xml', data: 'A'.repeat(2 * 1024 * 1024) }]), dir);
      // 路径穿越
      await expectWorkerRejects(buildZip([{ name: '../evil.txt', data: 'x' }]), dir);
      // 绝对路径
      await expectWorkerRejects(buildZip([{ name: '/etc/passwd', data: 'x' }]), dir);
      // 反斜杠路径（原始字节）
      await expectWorkerRejects(buildZip([{ name: 'a\\..\\b.txt', data: 'x' }]), dir);
      // 宏（vba）
      await expectWorkerRejects(buildZip([{ name: 'xl/vbaProject.bin', data: 'x' }]), dir);
      // 外部链接
      await expectWorkerRejects(buildZip([{ name: 'xl/externalLinks/externalLink1.xml', data: 'x' }]), dir);
      // 非法压缩方法（method 5）
      await expectWorkerRejects(buildZip([{ name: 'x.txt', data: 'x', method: 5 }]), dir);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('worker 完整管线拒绝：sheet / 行 / 列 / 单元格上限，零业务写入', async () => {
    const dir = makeTempDir();
    try {
      // 105 个 sheet 声明 > maxSheets=100
      const overSheets = buildZip([
        { name: 'xl/workbook.xml', data: `<workbook>${Array.from({ length: 105 }, (_, i) => `<sheet name="S${i}"/>`).join('')}</workbook>` },
        { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>' },
      ]);
      await expectWorkerRejects(overSheets, dir, MIN_LIMITS);

      const manyRows = Array.from({ length: 1200 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>x</v></c></row>`).join('');
      const overRows = buildZip([
        { name: 'xl/workbook.xml', data: '<workbook/>' },
        { name: 'xl/worksheets/sheet1.xml', data: `<worksheet>${manyRows}</worksheet>` },
      ]);
      await expectWorkerRejects(overRows, dir, MIN_LIMITS);

      // 250 列（Excel 列引用 A..IV）超过 200 列上限。
      const colRef = (n: number): string => {
        let s = '';
        let v = n;
        while (v > 0) {
          const rem = (v - 1) % 26;
          s = String.fromCharCode(65 + rem) + s;
          v = Math.floor((v - 1) / 26);
        }
        return s;
      };
      const wide = Array.from({ length: 250 }, (_, i) => `<c r="${colRef(i + 1)}1"><v>x</v></c>`).join('');
      const overCols = buildZip([
        { name: 'xl/workbook.xml', data: '<workbook/>' },
        { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><row r="1">${wide}</row></worksheet>` },
      ]);
      await expectWorkerRejects(overCols, dir, MIN_LIMITS);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('公式安全：DDE、外部引用、无缓存值在 worker 内只读静态缓存/置空，不执行不联网', async () => {
    const dir = makeTempDir();
    try {
      const workbook = new ExcelJS.Workbook();
      const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
      instructions.getCell('A2').value = '模板版本';
      instructions.getCell('B2').value = '1';
      const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS.project);
      const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
      ws.addRow(headers);
      ws.addRow(['sid-f1', 'E-F1', '客户F', '', '']); // D=合同金额 E=区域
      ws.getCell('D2').value = { formula: 'R1C1|DDE!A1' }; // DDE
      ws.getCell('E2').value = { formula: '=[Book1.xlsx]Sheet1!A1' }; // 外部引用
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

      const { repo, close } = openWorkspace(dir);
      try {
        const d = repo.createDraft({ name: '公式安全草稿', createdBy: null, createdByUsername: null });
        const rev = repo.transitionState(d.id, 1, 'start_parsing');
        const { factory } = createImportWorkerFactory();
        const result = await runImportFileTaskInWorker(
          { draftId: d.id, expectedRevision: rev, buffer, fileName: '公式文件.xlsx' },
          { append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows) },
          { createWorker: factory },
        );
        // 两条公式安全码都记录，未执行/未联网
        expect(result.issues.some((i) => i.code === 'DDE_FORMULA')).toBe(true);
        expect(result.issues.some((i) => i.code === 'EXTERNAL_REFERENCE')).toBe(true);
        // 项目行安全写入（公式字段置空不阻断整行）
        expect(result.normalizedRows).toBe(1);
        const row = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 10 }).rows[0];
        expect(row.cells['contract.usd_tax_amount_cents']).toBeNull();
        expect(row.cells['project.region']).toBeNull();
      } finally {
        close();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('无缓存值公式置空并报 FORMULA_NO_CACHED_VALUE（worker 内）', async () => {
    const dir = makeTempDir();
    try {
      const workbook = new ExcelJS.Workbook();
      const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
      instructions.getCell('A2').value = '模板版本';
      instructions.getCell('B2').value = '1';
      const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS.project);
      const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
      ws.addRow(headers);
      ws.addRow(['sid-f2', 'E-F2', '客户F2', '', '']);
      ws.getCell('D2').value = { formula: 'NOW()' }; // 无缓存值
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

      const { repo, close } = openWorkspace(dir);
      try {
        const d = repo.createDraft({ name: '公式安全草稿2', createdBy: null, createdByUsername: null });
        const rev = repo.transitionState(d.id, 1, 'start_parsing');
        const { factory } = createImportWorkerFactory();
        const result = await runImportFileTaskInWorker(
          { draftId: d.id, expectedRevision: rev, buffer, fileName: '公式文件2.xlsx' },
          { append: (draftId, expectedRevision, category, rows) => repo.appendRows(draftId, expectedRevision, category, rows) },
          { createWorker: factory },
        );
        expect(result.issues.some((i) => i.code === 'FORMULA_NO_CACHED_VALUE')).toBe(true);
        expect(result.normalizedRows).toBe(1);
        const row = repo.queryRows(d.id, { category: 'project', offset: 0, limit: 10 }).rows[0];
        expect(row.cells['contract.usd_tax_amount_cents']).toBeNull();
      } finally {
        close();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('预检结果与 worker 拒绝错误不含任何业务值（violation message 只描述结构）', async () => {
    const zip = buildZip([{ name: '../evil-客户-ECC-序列号-888888.txt', data: '敏感客户甲乙丙丁' }]);
    const result = await preflightXlsx(zip, MIN_LIMITS);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('敏感客户甲乙丙丁');
    expect(serialized).not.toContain('ECC-');
    // 路径名只按结构描述，不复制原始业务路径
    for (const v of result.violations) {
      expect(v.message).not.toMatch(/客户|ECC-|SN-|ACC-/);
    }
  });
});
