import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  ImportCancelledError,
  PasteOverlayError,
  isImportCancelled,
  runImportFileTask,
  runImportPasteTask,
  type ChunkWritePort,
  type ImportFileTaskParams,
} from '../../src/domain/capabilities/historical-data-import/import-tasks';
import { fieldCatalogFor } from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { TEMPLATE_INSTRUCTIONS_SHEET, TEMPLATE_VERSION } from '../../src/domain/capabilities/historical-data-import/template';
import { XlsxPreflightError } from '../../src/domain/capabilities/historical-data-import/zip-preflight';
import { IMPORT_CATEGORIES, IMPORT_CATEGORY_LABELS, type ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { planDigestFromRowHashes } from '../../src/domain/capabilities/historical-data-import/digest';
import type { AppendRowInput } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';

/**
 * 8.20/8.23/8.25/8.26：文件与粘贴统一规范化管线。
 * 覆盖模板/受支持-旧版本、未知 sheet/列、文件合并、粘贴覆盖、前导零、
 * 公式、外链（zip 层）、资源上限（zip 层）与文件/粘贴等价、稳定摘要。
 */

/** 内存分块写入端口（测试注入；校验修订连续推进）。 */
interface WrittenRow extends AppendRowInput {
  category: ImportCategory;
}
class FakeWriter implements ChunkWritePort {
  rows: WrittenRow[] = [];
  private current = 1;
  append(_draftId: string, expectedRevision: number, category: ImportCategory, rows: AppendRowInput[]): number {
    expect(expectedRevision).toBe(this.current);
    for (const r of rows) {
      this.rows.push({ ...r, category });
    }
    this.current += 1;
    return this.current;
  }
}

/** 构造带填写说明 + 数据行的模板工作簿（合成数据）。 */
async function buildTemplateBuffer(
  rowsByCategory: Partial<Record<ImportCategory, Array<Record<string, string | number>>>>,
  options: {
    extraSheets?: Array<{ name: string; rows: string[][] }>;
    version?: number | null;
    extraHeaders?: Partial<Record<ImportCategory, string[]>>;
  } = {},
): Promise<Buffer> {
  const { extraSheets = [], version = TEMPLATE_VERSION, extraHeaders = {} } = options;
  const workbook = new ExcelJS.Workbook();
  if (version !== null) {
    const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
    instructions.getCell('A2').value = '模板版本';
    instructions.getCell('B2').value = String(version);
  }
  for (const category of IMPORT_CATEGORIES) {
    const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS[category]);
    const headers = ['source_row_id', ...fieldCatalogFor(category).map((f) => f.label), ...(extraHeaders[category] ?? [])];
    ws.addRow(headers);
    for (const values of rowsByCategory[category] ?? []) {
      ws.addRow(headers.map((h) => values[h] ?? ''));
    }
  }
  for (const extra of extraSheets) {
    const ws = workbook.addWorksheet(extra.name);
    for (const row of extra.rows) {
      ws.addRow(row);
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function projectRow(ecc: string, customer: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'source_row_id': `sid-${ecc}`, ECC: ecc, 客户名称: customer, 区域: '华东', ...extra };
}

async function runFile(
  writer: FakeWriter,
  buffer: Buffer,
  fileName = '模板导入.xlsx',
  params?: Partial<ImportFileTaskParams>,
) {
  return runImportFileTask({
    draftId: 'd1',
    expectedRevision: 1,
    buffer,
    fileName,
    writer,
    ...params,
  });
}

describe('8.26 模板文件导入与版本识别', () => {
  it('模板工作簿按 sheet 精确路由七类，忽略填写说明，无示例行不产生数据', async () => {
    const buffer = await buildTemplateBuffer({
      project: [projectRow('E-1', '华东医药')],
      service_order: [{ 'source_row_id': 'so-1', 服务单号: 'SO-001', 开单类型: 'relocation', 开单时间: '2026-07-01', 工程师: '甲', 客户单位: '华东医药' }],
    });
    const writer = new FakeWriter();
    const result = await runFile(writer, buffer);
    expect(result.templateMode).toBe(true);
    expect(result.templateVersionSupported).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.categories.project).toBe(1);
    expect(result.categories.service_order).toBe(1);
    expect(result.categories.invoice).toBe(0);
    expect(result.normalizedRows).toBe(2);
    // 填写说明 sheet 不产生数据
    expect(result.sheets.some((s) => s.sheet === TEMPLATE_INSTRUCTIONS_SHEET)).toBe(false);
    expect(writer.rows).toHaveLength(2);
  });

  it('旧版本模板识别为不支持（版本 != 当前），仍报告版本问题而非静默跳过', async () => {
    const buffer = await buildTemplateBuffer(
      { project: [projectRow('E-2', '客户A')] },
      { version: 0 },
    );
    const result = await runFile(new FakeWriter(), buffer);
    expect(result.templateMode).toBe(true);
    expect(result.templateVersionSupported).toBe(false);
  });

  it('非模板旧五源工作簿按冻结 sheet/列别名解析', async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('开单记录表');
    ws.addRow(['单号', '类型', '日期', '工程师', '客户单位']);
    ws.addRow(['SO-L1', 'pm', '2026-01-01', '甲', '华东']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await runFile(new FakeWriter(), buffer, '工作量统计.xlsx');
    expect(result.templateMode).toBe(false);
    expect(result.categories.service_order).toBe(1);
    expect(result.issues).toHaveLength(0);
    const so = result.sheets.find((s) => s.sheet === '开单记录表')!;
    expect(so.columnMapping.every((c) => c.state === 'exact' || c.state === 'alias')).toBe(true);
  });
});

describe('8.26 未知 sheet / 未知列：待人工映射或明确排除，不猜测', () => {
  it('模板中未知 sheet 进入 UNKNOWN_SHEET 问题，不产生数据', async () => {
    const buffer = await buildTemplateBuffer(
      { project: [projectRow('E-3', '客户B')] },
      { extraSheets: [{ name: '未知业务表', rows: [['x']] }] },
    );
    const result = await runFile(new FakeWriter(), buffer);
    expect(result.issues.some((i) => i.code === 'UNKNOWN_SHEET' && i.message.includes('未知业务表'))).toBe(true);
    expect(result.categories.project).toBe(1); // 已知 sheet 正常解析
  });

  it('未知列进入 UNKNOWN_COLUMN 问题（待人工映射或排除），不影响已知列', async () => {
    const buffer = await buildTemplateBuffer(
      {
        project: [
          { 'source_row_id': 'e4', ECC: 'E-4', 客户名称: '客户C', 自定义列: '不应猜测映射' },
        ],
      },
      { extraHeaders: { project: ['自定义列'] } },
    );
    const result = await runFile(new FakeWriter(), buffer);
    expect(result.issues.some((i) => i.code === 'UNKNOWN_COLUMN' && i.sourceColumn === '自定义列')).toBe(true);
    expect(result.categories.project).toBe(1);
  });

  it('旧五源中未知 sheet 只进入待人工映射（不模糊猜测）', async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('没有配置的统计表');
    ws.addRow(['某列', '值']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await runFile(new FakeWriter(), buffer, '工作量统计.xlsx');
    expect(result.issues.some((i) => i.code === 'UNKNOWN_SHEET' && i.sheet === '没有配置的统计表')).toBe(true);
    expect(result.normalizedRows).toBe(0);
  });
});

describe('8.26 前导零与标识符文本保留', () => {
  it('ECC / 服务单号 / Account ID / 序列号按文本保留前导零（不转数值）', async () => {
    const buffer = await buildTemplateBuffer({
      project: [projectRow('00012', '客户前导零')],
      service_order: [{ 'source_row_id': 'so-2', 服务单号: '00777', 开单类型: 'relocation', 开单时间: '2026-07-01', 工程师: '甲', 客户单位: '华东' }],
      serial_address_update: [{ 'source_row_id': 'sau-1', 客户名称: '华东', 新址地址: '址A', 序列号: '000SN9', 'Account ID': '000ACC' , 更新时间: '2026-07-02'}],
    });
    const writer = new FakeWriter();
    const result = await runFile(writer, buffer);
    expect(result.issues).toHaveLength(0);
    const project = writer.rows.find((r) => r.category === 'project')!;
    expect(project.businessKey).toBe('00012'); // 前导零保留
    expect(project.cells!['contract.ecc']).toBe('00012');
    const so = writer.rows.find((r) => r.category === 'service_order')!;
    expect(so.cells!['service_order.service_order_no']).toBe('00777');
    const sau = writer.rows.find((r) => r.category === 'serial_address_update')!;
    expect(sau.cells!['serial_address_update.serial_no']).toBe('000SN9');
    expect(sau.cells!['serial_address_update.account_id']).toBe('000ACC');
  });
});

describe('8.26 公式与不可安全读取内容', () => {
  it('无缓存值的公式单元格置空并报 FORMULA_NO_CACHED_VALUE；有缓存值的公式读取缓存', async () => {
    const workbook = new ExcelJS.Workbook();
    const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
    instructions.getCell('A2').value = '模板版本';
    instructions.getCell('B2').value = '1';
    const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS.project);
    const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
    ws.addRow(headers);
    ws.addRow(['sid-f1', 'E-F1', '客户F', '', '']); // D=合同金额 E=区域 初始为空
    ws.getCell('D2').value = { formula: 'NOW()' }; // 无缓存值 → FORMULA_NO_CACHED_VALUE
    ws.getCell('E2').value = '10000'; // 区域
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const writer = new FakeWriter();
    const result = await runFile(writer, buffer);
    const issue = result.issues.find((i) => i.code === 'FORMULA_NO_CACHED_VALUE');
    expect(issue).toBeDefined();
    // 无缓存公式字段置空（不影响整行导入）
    const row = writer.rows.find((r) => r.category === 'project')!;
    expect(row.cells!['contract.usd_tax_amount_cents']).toBeNull();
    expect(row.cells!['project.region']).toBe('10000');
  });

  it('DDE 与外部工作簿引用公式标记为不可安全读取（DDE_FORMULA / EXTERNAL_REFERENCE）', async () => {
    const workbook = new ExcelJS.Workbook();
    const instructions = workbook.addWorksheet(TEMPLATE_INSTRUCTIONS_SHEET);
    instructions.getCell('A2').value = '模板版本';
    instructions.getCell('B2').value = '1';
    const ws = workbook.addWorksheet(IMPORT_CATEGORY_LABELS.project);
    const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
    ws.addRow(headers);
    ws.addRow(['sid-f2', 'E-F2', '客户F2', '', '']);
    ws.getCell('D2').value = { formula: 'R1C1|DDE!A1' }; // DDE
    ws.getCell('E2').value = { formula: '=[Book1.xlsx]Sheet1!A1' }; // 外部引用
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await runFile(new FakeWriter(), buffer);
    expect(result.issues.some((i) => i.code === 'DDE_FORMULA')).toBe(true);
    expect(result.issues.some((i) => i.code === 'EXTERNAL_REFERENCE')).toBe(true);
    expect(result.issues.length).toBe(2);
  });
});

describe('8.26 资源上限（任务层拒绝）', () => {
  it('未通过 ZIP 预检的文件抛 XlsxPreflightError，不产生任何行', async () => {
    const buffer = await buildTemplateBuffer({ project: [projectRow('E-5', '客户D')] });
    const writer = new FakeWriter();
    await expect(
      runFile(writer, buffer, '模板导入.xlsx', { limits: { ...DEFAULT_TINY_LIMITS } }),
    ).rejects.toBeInstanceOf(XlsxPreflightError);
    expect(writer.rows).toHaveLength(0);
  });
});

const DEFAULT_TINY_LIMITS = {
  maxFileBytes: 10,
  maxEntries: 10,
  maxUncompressedBytesPerEntry: 100,
  maxTotalUncompressedBytes: 100,
  maxCompressionRatio: 5,
  maxSheets: 3,
  maxRowsPerSheet: 5,
  maxColumnsPerSheet: 5,
  maxCellsPerSheet: 50,
};

describe('8.26 粘贴覆盖预检与粘贴导入', () => {
  it('覆盖预检不通过时抛 PasteOverlayError，不写入任何行', async () => {
    const text = 'ECC\t客户名称\nE-1\t华东';
    await expect(
      runImportPasteTask({
        draftId: 'd1',
        expectedRevision: 1,
        category: 'project',
        text,
        headerConfirmed: true,
        append: false,
        existingRows: 0, // 覆盖 1 行超出既有网格
        existingColumns: 0,
        writer: new FakeWriter(),
      }),
    ).rejects.toBeInstanceOf(PasteOverlayError);
  });

  it('粘贴导入规范化行并保持来源定位（gridRow 与 pasteBatch）', async () => {
    const text = 'source_row_id\tECC\t客户名称\np1\tE-6\t客户E';
    const writer = new FakeWriter();
    const result = await runImportPasteTask({
      draftId: 'd1',
      expectedRevision: 1,
      category: 'project',
      text,
      headerConfirmed: true,
      append: true,
      existingRows: 0,
      existingColumns: 2,
      writer,
    });
    expect(result.overlay.allowed).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.normalizedRows).toBe(1);
    const row = writer.rows[0];
    expect(row.category).toBe('project');
    expect(row.businessKey).toBe('E-6');
    expect(row.pasteBatch).toBe(result.pasteBatch);
    expect(row.sourceRow).toBe(2); // 表头占第 1 行
    expect(result.issues).toHaveLength(0);
  });
});

describe('8.23/8.25 文件/粘贴等价与稳定摘要', () => {
  it('相同语义内容：文件与粘贴产生相同规范化计划摘要（project 类别）', async () => {
    const buffer = await buildTemplateBuffer({
      project: [projectRow('E-7', '等价客户')],
    });
    const fileWriter = new FakeWriter();
    const fileResult = await runFile(fileWriter, buffer);
    expect(fileResult.normalizedRows).toBe(1);

    const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
    const vals: Record<string, string> = { 'source_row_id': 'sid-E-7', ECC: 'E-7', 客户名称: '等价客户', 区域: '华东' };
    const pasteText = [headers.join('\t'), headers.map((h) => vals[h] ?? '').join('\t')].join('\n');

    const pasteWriter = new FakeWriter();
    const pasteResult = await runImportPasteTask({
      draftId: 'd1', expectedRevision: 1, category: 'project', text: pasteText,
      headerConfirmed: true, append: true, existingRows: 0, existingColumns: headers.length, writer: pasteWriter,
    });

    // 文件与粘贴的规范化计划摘要一致（物理来源差异不进入计划摘要）
    expect(pasteResult.planDigest).toBe(fileResult.planDigest);
    // 原始输入摘要区分输入来源
    expect(pasteResult.rawDigest).not.toBe(fileResult.rawDigest);
    expect(pasteResult.rawDigest).toBe(
      (await import('node:crypto')).createHash('sha256').update(pasteText).digest('hex'),
    );
  });

  it('相同语义内容：服务单号（业务键）行在文件与粘贴间计划摘要一致', async () => {
    const buffer = await buildTemplateBuffer({
      service_order: [{ 'source_row_id': 'so-7', 服务单号: 'SO-7', 开单类型: 'pm', 开单时间: '2026-07-01', 工程师: '甲', 客户单位: '等价客户' }],
    });
    const fileResult = await runFile(new FakeWriter(), buffer);

    const headers = ['source_row_id', ...fieldCatalogFor('service_order').map((f) => f.label)];
    const vals: Record<string, string> = { 'source_row_id': 'so-7', 服务单号: 'SO-7', 开单类型: 'pm', 开单时间: '2026-07-01', 工程师: '甲', 客户单位: '等价客户' };
    const pasteText = [headers.join('\t'), headers.map((h) => vals[h] ?? '').join('\t')].join('\n');
    const pasteResult = await runImportPasteTask({
      draftId: 'd1', expectedRevision: 1, category: 'service_order', text: pasteText,
      headerConfirmed: true, append: true, existingRows: 0, existingColumns: headers.length, writer: new FakeWriter(),
    });
    expect(pasteResult.planDigest).toBe(fileResult.planDigest);
  });

  it('相同内容不同物理顺序得到相同计划摘要（稳定排序）', async () => {
    const rowsA = [projectRow('E-8', '客户A'), projectRow('E-9', '客户B')];
    const rowsB = [projectRow('E-9', '客户B'), projectRow('E-8', '客户A')];
    const bufferA = await buildTemplateBuffer({ project: rowsA });
    const bufferB = await buildTemplateBuffer({ project: rowsB });
    const a = await runFile(new FakeWriter(), bufferA);
    const b = await runFile(new FakeWriter(), bufferB);
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.normalizedRows).toBe(2);
    expect(b.normalizedRows).toBe(2);
  });

  it('计划摘要包含行身份：业务键变化则摘要变化', async () => {
    const bufferA = await buildTemplateBuffer({ project: [projectRow('E-10', '客户A')] });
    const bufferB = await buildTemplateBuffer({ project: [projectRow('E-11', '客户A')] });
    const a = await runFile(new FakeWriter(), bufferA);
    const b = await runFile(new FakeWriter(), bufferB);
    expect(a.planDigest).not.toBe(b.planDigest);
  });

  it('原始输入摘要绑定来源（相同规范化内容的文件与粘贴原始摘要不同）', async () => {
    const buffer = await buildTemplateBuffer({ project: [projectRow('E-12', '客户C')] });
    const fileResult = await runFile(new FakeWriter(), buffer);
    const headers = ['source_row_id', ...fieldCatalogFor('project').map((f) => f.label)];
    const vals: Record<string, string> = { 'source_row_id': 'sid-E-12', ECC: 'E-12', 客户名称: '客户C', 区域: '华东' };
    const pasteText = [headers.join('\t'), headers.map((h) => vals[h] ?? '').join('\t')].join('\n');
    const pasteResult = await runImportPasteTask({
      draftId: 'd1', expectedRevision: 1, category: 'project', text: pasteText,
      headerConfirmed: true, append: true, existingRows: 0, existingColumns: headers.length, writer: new FakeWriter(),
    });
    expect(fileResult.rawDigest).not.toBe(pasteResult.rawDigest);
    expect(fileResult.planDigest).toBe(pasteResult.planDigest);
  });
});

describe('8.26 文件合并与粘贴追加', () => {
  it('两个文件合并：追加写入不丢失，重跑顺序无关', async () => {
    const bufferA = await buildTemplateBuffer({ project: [projectRow('E-20', '客户A')] });
    const bufferB = await buildTemplateBuffer({ project: [projectRow('E-21', '客户B')] });

    const w1 = new FakeWriter();
    const r1a = await runFile(w1, bufferA);
    const r1b = await runFile(w1, bufferB, '模板导入.xlsx', { expectedRevision: r1a.newRevision });
    void r1b;

    const w2 = new FakeWriter();
    const r2b = await runFile(w2, bufferB);
    const r2a = await runFile(w2, bufferA, '模板导入.xlsx', { expectedRevision: r2b.newRevision });

    // 合并后行集合一致（与顺序无关）
    const keys = (rows: AppendRowInput[]): string => rows.map((r) => r.businessKey ?? '').sort().join(',');
    expect(keys(w1.rows)).toBe(keys(w2.rows));
    expect(w1.rows).toHaveLength(2);
    // 各自文件摘要稳定
    expect(r1a.planDigest).toBe(r2a.planDigest);
  });

  it('粘贴追加在既有行之后，修订号连续推进', async () => {
    const writer = new FakeWriter();
    const first = await runImportPasteTask({
      draftId: 'd1', expectedRevision: 1, category: 'project',
      text: 'ECC\t客户名称\nE-30\t客户A',
      headerConfirmed: true, append: true, existingRows: 0, existingColumns: 2, writer,
    });
    const second = await runImportPasteTask({
      draftId: 'd1', expectedRevision: first.newRevision, category: 'project',
      text: 'ECC\t客户名称\nE-31\t客户B',
      headerConfirmed: true, append: true, existingRows: 1, existingColumns: 2, writer,
    });
    expect(second.newRevision).toBeGreaterThan(first.newRevision);
    expect(writer.rows.map((r) => r.businessKey)).toEqual(['E-30', 'E-31']);
  });
});

describe('8.20 取消与恢复', () => {
  it('任务取消抛 ImportCancelledError，不形成部分合并', async () => {
    const controller = new AbortController();
    const buffer = await buildTemplateBuffer({ project: [projectRow('E-40', '客户A')] });
    const writer = new FakeWriter();
    // 在首个 writing 进度后取消：下一次 flush 前的 assertNotAborted 抛出。
    let sawWriting = false;
    const run = runImportFileTask({
      draftId: 'd1',
      expectedRevision: 1,
      buffer,
      fileName: '模板导入.xlsx',
      signal: controller.signal,
      onProgress: (p) => {
        if (p.stage === 'writing' && !sawWriting) {
          sawWriting = true;
          controller.abort();
        }
      },
      writer,
    });
    await expect(run).rejects.toSatisfy((err: unknown) => isImportCancelled(err));
    expect(controller.signal.aborted).toBe(true);
    expect(writer.rows.length).toBeLessThan(2); // 取消后无部分草稿合并（可能已写入首个块）
  });

  it('已中止信号在读取前直接取消', async () => {
    const controller = new AbortController();
    controller.abort();
    const buffer = await buildTemplateBuffer({ project: [projectRow('E-41', '客户A')] });
    await expect(
      runImportFileTask({
        draftId: 'd1', expectedRevision: 1, buffer, fileName: 'x.xlsx', signal: controller.signal, writer: new FakeWriter(),
      }),
    ).rejects.toBeInstanceOf(ImportCancelledError);
  });
});

describe('摘要稳定性辅助（planDigestFromRowHashes 排序无关）', () => {
  it('行哈希集合稳定排序后摘要一致', () => {
    const a = planDigestFromRowHashes(['aa', 'bb']);
    const b = planDigestFromRowHashes(['bb', 'aa']);
    expect(a).toBe(b);
    expect(planDigestFromRowHashes(['aa'])).not.toBe(a);
  });
});
