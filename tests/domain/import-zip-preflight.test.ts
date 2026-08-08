import { describe, expect, it } from 'vitest';
import {
  DEFAULT_XLSX_BATCH_LIMITS,
  preflightBatch,
  preflightXlsx,
  type XlsxPreflightLimits,
} from '../../src/domain/capabilities/historical-data-import/zip-preflight';
import { buildXlsx, buildZip } from '../helpers/zip-fixtures';

/**
 * 8.19 有界 ZIP 预检：文件大小、entry 数、单 entry 展开量、累计展开、压缩比、
 * sheet/行列/单元格上限，拒绝路径异常、宏、外部链接与非法压缩方法。
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

describe('8.19 .xlsx 有界预检（yauzl 中央目录）', () => {
  it('合法 xlsx 通过预检并报告 sheet 数与日期系统', async () => {
    const buffer = await buildXlsx([
      { name: 'A', rows: [['x', 'y'], ['1', '2']] },
      { name: 'B', rows: [['ECC', '金额'], ['E-1', '100']] },
    ]);
    const result = await preflightXlsx(buffer, MIN_LIMITS);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.sheetCount).toBe(2);
    expect(result.dateSystem).toBe('1900');
    expect(result.entries).toBeGreaterThan(3);
  });

  it('非 ZIP 输入拒绝（NOT_A_ZIP）', async () => {
    const result = await preflightXlsx(Buffer.from('this is definitely not a zip file'), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'NOT_A_ZIP')).toBe(true);
  });

  it('文件超过字节上限拒绝（ZIP_TOO_LARGE）', async () => {
    const buffer = Buffer.alloc(2048, 0x61);
    const result = await preflightXlsx(buffer, { ...MIN_LIMITS, maxFileBytes: 1024 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'ZIP_TOO_LARGE')).toBe(true);
  });

  it('entry 数超过上限拒绝（TOO_MANY_ENTRIES）', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
    const result = await preflightXlsx(buildZip(entries), { ...MIN_LIMITS, maxEntries: 5 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'TOO_MANY_ENTRIES')).toBe(true);
  });

  it('单 entry 声明展开超过上限拒绝（ENTRY_UNCOMPRESSED_TOO_LARGE）', async () => {
    const zip = buildZip([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'big.bin', data: 'tiny', declaredUncompressed: 20 * 1024 * 1024 },
    ]);
    const result = await preflightXlsx(zip, { ...MIN_LIMITS, maxUncompressedBytesPerEntry: 10 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'ENTRY_UNCOMPRESSED_TOO_LARGE')).toBe(true);
  });

  it('累计展开超过上限拒绝（TOTAL_UNCOMPRESSED_TOO_LARGE）', async () => {
    // 使用 store（method 0）避免压缩比检查先触发；两个 6MB 条目声明展开合计 12MB > 10MB。
    const zip = buildZip([
      { name: 'a.dat', data: 'x'.repeat(6 * 1024 * 1024), method: 0, declaredUncompressed: 6 * 1024 * 1024 },
      { name: 'b.dat', data: 'y'.repeat(6 * 1024 * 1024), method: 0, declaredUncompressed: 6 * 1024 * 1024 },
    ]);
    const result = await preflightXlsx(
      zip,
      { ...MIN_LIMITS, maxFileBytes: 30 * 1024 * 1024, maxTotalUncompressedBytes: 10 * 1024 * 1024 },
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'TOTAL_UNCOMPRESSED_TOO_LARGE')).toBe(true);
  });

  it('压缩比超过上限拒绝（COMPRESSION_RATIO_TOO_HIGH，ZIP 炸弹）', async () => {
    // 2 MiB 高度重复内容 deflate 后约 2 KiB → 压缩比约 1000，远大于上限 50。
    const zip = buildZip([{ name: 'xl/workbook.xml', data: 'A'.repeat(2 * 1024 * 1024) }]);
    const result = await preflightXlsx(zip, { ...MIN_LIMITS, maxCompressionRatio: 50 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'COMPRESSION_RATIO_TOO_HIGH')).toBe(true);
  });

  it('路径穿越拒绝（PATH_TRAVERSAL）', async () => {
    const result = await preflightXlsx(buildZip([{ name: '../evil.txt', data: 'x' }]), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'PATH_TRAVERSAL')).toBe(true);
  });

  it('绝对路径拒绝（ABSOLUTE_PATH）', async () => {
    const result = await preflightXlsx(buildZip([{ name: '/etc/passwd', data: 'x' }]), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'ABSOLUTE_PATH')).toBe(true);
  });

  it('反斜杠路径拒绝（BACKSLASH_PATH）', async () => {
    const result = await preflightXlsx(buildZip([{ name: 'xl\\workbook.xml', data: 'x' }]), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'BACKSLASH_PATH' || v.code === 'INVALID_ENTRY_PATH')).toBe(true);
  });

  it('宏（vba）拒绝（VBA_MACRO）', async () => {
    const result = await preflightXlsx(buildZip([{ name: 'xl/vbaProject.bin', data: 'macro' }]), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'VBA_MACRO')).toBe(true);
  });

  it('外部链接拒绝（EXTERNAL_LINK）', async () => {
    const result = await preflightXlsx(buildZip([{ name: 'xl/externalLinks/links.xml', data: 'x' }]), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'EXTERNAL_LINK')).toBe(true);
  });

  it('非法压缩方法拒绝（BAD_COMPRESSION_METHOD）', async () => {
    const result = await preflightXlsx(buildZip([{ name: 'a.bin', data: 'x', method: 99 }]), MIN_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'BAD_COMPRESSION_METHOD')).toBe(true);
  });

  it('sheet 数超过上限拒绝（TOO_MANY_SHEETS）', async () => {
    const buffer = await buildXlsx([
      { name: 'A', rows: [['1']] },
      { name: 'B', rows: [['2']] },
      { name: 'C', rows: [['3']] },
    ]);
    const result = await preflightXlsx(buffer, { ...MIN_LIMITS, maxSheets: 2 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'TOO_MANY_SHEETS')).toBe(true);
  });

  it('行数超过上限拒绝（TOO_MANY_ROWS）', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => [`row-${i}`]);
    const buffer = await buildXlsx([{ name: 'S', rows: [['h'], ...rows] }]);
    const result = await preflightXlsx(buffer, { ...MIN_LIMITS, maxRowsPerSheet: 100 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'TOO_MANY_ROWS')).toBe(true);
  });

  it('列数超过上限拒绝（TOO_MANY_COLUMNS）', async () => {
    const wideRow = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const buffer = await buildXlsx([{ name: 'S', rows: [wideRow] }]);
    const result = await preflightXlsx(buffer, { ...MIN_LIMITS, maxColumnsPerSheet: 200 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'TOO_MANY_COLUMNS')).toBe(true);
  });

  it('单元格数超过上限拒绝（TOO_MANY_CELLS）', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => Array.from({ length: 60 }, (__, j) => `${i}-${j}`));
    const buffer = await buildXlsx([{ name: 'S', rows }]);
    const result = await preflightXlsx(buffer, { ...MIN_LIMITS, maxCellsPerSheet: 10_000 });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'TOO_MANY_CELLS')).toBe(true);
  });

  it('跨文件批次上限：文件数、压缩合计与展开合计', async () => {
    const violations = preflightBatch(
      [
        { fileName: 'a.xlsx', fileBytes: 100, totalCompressedBytes: 60, totalUncompressedBytes: 500 },
        { fileName: 'b.xlsx', fileBytes: 100, totalCompressedBytes: 60, totalUncompressedBytes: 500 },
        { fileName: 'c.xlsx', fileBytes: 100, totalCompressedBytes: 60, totalUncompressedBytes: 500 },
      ],
      { ...DEFAULT_XLSX_BATCH_LIMITS, maxFiles: 2 },
    );
    expect(violations.some((v) => v.code === 'TOO_MANY_ENTRIES' && v.message.includes('输入文件数'))).toBe(true);

    const uncompressed = preflightBatch(
      [{ fileName: 'a.xlsx', fileBytes: 100, totalCompressedBytes: 10, totalUncompressedBytes: 3 * 1024 * 1024 }],
      { ...DEFAULT_XLSX_BATCH_LIMITS, maxTotalUncompressedBytes: 1024 * 1024 },
    );
    expect(uncompressed.some((v) => v.code === 'TOTAL_UNCOMPRESSED_TOO_LARGE')).toBe(true);

    expect(preflightBatch([])).toHaveLength(0);
  });

  it('预检结果不含任何业务值', async () => {
    const buffer = await buildXlsx([{ name: 'S', rows: [['客户名称', 'ECC'], ['华东医药', 'ECC-001']] }]);
    const result = await preflightXlsx(buffer, MIN_LIMITS);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('华东医药');
    expect(JSON.stringify(result)).not.toContain('ECC-001');
  });
});
