import { describe, expect, it } from 'vitest';
import {
  confirmFirstRowAsHeader,
  parsePasteText,
  preflightPasteOverlay,
} from '../../src/domain/capabilities/historical-data-import/paste-parser';

/**
 * 8.22 矩形剪贴板解析、首行表头确认、追加与覆盖预检、
 * 分块草稿写入及覆盖取消；保持 Excel 行列顺序和来源定位。
 */

describe('8.22 矩形粘贴解析', () => {
  it('按行/列解析为矩形，保持行列顺序', () => {
    const parsed = parsePasteText('ECC\t客户名称\nE-1\t华东\nE-2\t华北');
    expect(parsed.width).toBe(2);
    expect(parsed.rows).toEqual([
      ['ECC', '客户名称'],
      ['E-1', '华东'],
      ['E-2', '华北'],
    ]);
    expect(parsed.skippedEmptyRows).toBe(0);
  });

  it('短行补齐为矩形，行尾空单元格被裁剪', () => {
    const parsed = parsePasteText('a\tb\tc\nd\te\nf');
    expect(parsed.width).toBe(3);
    expect(parsed.rows[1]).toEqual(['d', 'e', '']);
    expect(parsed.rows[2]).toEqual(['f', '', '']);
  });

  it('完全空白行跳过并计数；\\r\\n 兼容', () => {
    const parsed = parsePasteText('a\tb\r\n\r\n\t\r\nc\td');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parsed.skippedEmptyRows).toBe(2);
  });

  it('空文本返回空矩形', () => {
    expect(parsePasteText('')).toEqual({ rows: [], width: 0, skippedEmptyRows: 0 });
  });

  it('首行表头确认：是表头时首行作为表头、其余为数据行，行序保持', () => {
    const parsed = parsePasteText('ECC\t金额\ne1\t100\ne2\t200');
    const withHeader = confirmFirstRowAsHeader(parsed, true);
    expect(withHeader.header).toEqual(['ECC', '金额']);
    expect(withHeader.dataRows).toEqual([
      ['e1', '100'],
      ['e2', '200'],
    ]);
    expect(withHeader.rowCount).toBe(2);
  });

  it('首行表头确认：不是表头时全部行作为数据行', () => {
    const parsed = parsePasteText('e1\t100\ne2\t200');
    const noHeader = confirmFirstRowAsHeader(parsed, false);
    expect(noHeader.header).toEqual([]);
    expect(noHeader.dataRows).toEqual([
      ['e1', '100'],
      ['e2', '200'],
    ]);
    expect(noHeader.rowCount).toBe(2);
  });
});

describe('8.22 追加与覆盖预检', () => {
  const limits = { maxRowsPerSheet: 10, maxColumnsPerSheet: 5, maxCellsPerSheet: 50 };

  it('追加在既有行之后且不超限时允许', () => {
    const verdict = preflightPasteOverlay({
      append: true,
      existingRows: 3,
      existingColumns: 2,
      dataRowCount: 4,
      columnCount: 2,
      limits,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.targetStartRow).toBe(4);
    expect(verdict.targetEndRow).toBe(7);
    expect(verdict.wouldOverwrite).toBe(false);
  });

  it('追加超出上限时拒绝且不写入', () => {
    const verdict = preflightPasteOverlay({
      append: true,
      existingRows: 9,
      existingColumns: 2,
      dataRowCount: 5,
      columnCount: 3,
      limits,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.length).toBeGreaterThan(0);
  });

  it('覆盖预检：触碰既有行范围时给出 wouldOverwrite', () => {
    const verdict = preflightPasteOverlay({
      append: false,
      existingRows: 5,
      existingColumns: 3,
      dataRowCount: 3,
      columnCount: 3,
      limits,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.wouldOverwrite).toBe(true);
    expect(verdict.targetStartRow).toBe(1);
    expect(verdict.targetEndRow).toBe(3);
  });

  it('覆盖超出既有网格范围时拒绝（不产生部分覆盖）', () => {
    const verdict = preflightPasteOverlay({
      append: false,
      existingRows: 2,
      existingColumns: 2,
      dataRowCount: 5,
      columnCount: 4,
      limits,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.some((v) => v.includes('超出既有网格行数'))).toBe(true);
  });
});
