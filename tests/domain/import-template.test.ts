import { describe, expect, it } from 'vitest';
import {
  SOURCE_ROW_ID_COLUMN,
  TEMPLATE_INSTRUCTIONS_SHEET,
  TEMPLATE_VERSION,
  categoryByTemplateSheet,
  generateTemplateWorkbook,
  isSupportedTemplateWorkbook,
  isTemplateWorkbook,
  readTemplateVersionFromBuffer,
  templateSheetName,
} from '../../src/domain/capabilities/historical-data-import/template';
import { fieldCatalogFor } from '../../src/domain/capabilities/historical-data-import/field-catalog';
import { IMPORT_CATEGORIES, IMPORT_CATEGORY_LABELS } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { readWorkbookGrid } from '../../src/domain/capabilities/historical-data-import/excel-source';
import { preflightXlsx } from '../../src/domain/capabilities/historical-data-import/zip-preflight';

/**
 * 8.18 当前版本 Excel 空白模板生成器：填写说明 + 七个业务 sheet、
 * 模板版本与稳定 source_row_id，且不包含会被识别为真实数据的示例行。
 */

describe('8.18 版本化单工作簿空白模板', () => {
  it('生成单个工作簿：填写说明 + 七个业务 sheet，无示例业务行', async () => {
    const buffer = await generateTemplateWorkbook();
    const { sheets } = await readWorkbookGrid(buffer);
    const names = sheets.map((s) => s.name);
    expect(names[0]).toBe(TEMPLATE_INSTRUCTIONS_SHEET);
    for (const category of IMPORT_CATEGORIES) {
      expect(names).toContain(IMPORT_CATEGORY_LABELS[category]);
    }
    expect(names).toHaveLength(1 + IMPORT_CATEGORIES.length);

    // 每个业务 sheet 只有表头（source_row_id + 目标字段），无任何数据行
    for (const category of IMPORT_CATEGORIES) {
      const grid = sheets.find((s) => s.name === IMPORT_CATEGORY_LABELS[category])!;
      const expectedHeaderCount = 1 + fieldCatalogFor(category).length;
      expect(grid.rows[0].filter((c) => c.kind !== 'empty')).toHaveLength(expectedHeaderCount);
      for (let r = 1; r < grid.rows.length; r += 1) {
        expect(grid.rows[r].every((c) => c.kind === 'empty')).toBe(true); // 无示例/数据行
      }
    }
  });

  it('每个业务 sheet 首列为稳定 source_row_id，其后为目标字段表头', async () => {
    const buffer = await generateTemplateWorkbook();
    const { sheets } = await readWorkbookGrid(buffer);
    for (const category of IMPORT_CATEGORIES) {
      const grid = sheets.find((s) => s.name === IMPORT_CATEGORY_LABELS[category])!;
      const headers = grid.rows[0].map((c) => (c.kind === 'text' ? c.value : '')).filter(Boolean);
      expect(headers[0]).toBe(SOURCE_ROW_ID_COLUMN);
      const fieldHeaders = fieldCatalogFor(category).map((f) => f.label);
      expect(headers.slice(1)).toEqual(fieldHeaders);
    }
  });

  it('模板版本可识别且为受支持版本', async () => {
    const buffer = await generateTemplateWorkbook();
    expect(await isTemplateWorkbook(buffer)).toBe(true);
    expect(await isSupportedTemplateWorkbook(buffer)).toBe(true);
    expect(await readTemplateVersionFromBuffer(buffer)).toEqual({ version: TEMPLATE_VERSION, supported: true });
    expect(TEMPLATE_VERSION).toBe(1);
  });

  it('旧版本模板识别为不支持（版本不为当前版本）', async () => {
    const buffer = await generateTemplateWorkbook({ version: 0 });
    expect(await isTemplateWorkbook(buffer)).toBe(true);
    expect(await readTemplateVersionFromBuffer(buffer)).toEqual({ version: 0, supported: false });
    expect(await isSupportedTemplateWorkbook(buffer)).toBe(false);
  });

  it('sheet 名 ↔ 类别映射精确且双向一致', () => {
    for (const category of IMPORT_CATEGORIES) {
      expect(categoryByTemplateSheet(templateSheetName(category))).toBe(category);
      expect(categoryByTemplateSheet(` ${templateSheetName(category)} `)).toBe(category); // trim 后匹配
    }
    expect(categoryByTemplateSheet('未知业务表')).toBeUndefined();
  });

  it('模板可通过 ZIP 有界预检（正常 xlsx 结构）', async () => {
    const buffer = await generateTemplateWorkbook();
    const preflight = await preflightXlsx(buffer);
    expect(preflight.ok).toBe(true);
    expect(preflight.sheetCount).toBe(1 + IMPORT_CATEGORIES.length);
  });
});
