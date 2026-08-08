// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  HistoryImportVirtualGrid,
  type GridColumn,
  type GridFilter,
  type GridWindowRequest,
  type HistoryImportVirtualGridHandle,
  type VirtualGridRow,
  type VirtualGridWindowProvider,
} from '../../src/renderer/history-import';

/**
 * 8.70 / 8.71 单网格 100,000 行基准（现有组件/provider，只新增测试）。
 *
 * - 只呈现可见窗口：DOM 行节点与 provider 请求窗口保持有界（≤ 300）；
 * - 交互性能：滚动 / 搜索 / ECC-问题筛选 / 跳错误连续操作的 p95 延迟在合理阈值内
 *   （实测指标记录，jsdom 下为 React 渲染 + provider 往返耗时）；
 * - renderer 不持有完整 100,000 行对象图：整场会话 provider 累计请求行数远小于
 *   100k，任何单次请求都只取窗口，DOM 不随总行数增长；
 * - 横向冻结身份：行号 sticky、ECC（业务键）is-frozen 固定在左侧，横向滚动后
 *   表头/行号/ECC 仍可辨识。
 */

const TOTAL = 100_000;
const columns: GridColumn[] = [
  { id: 'ecc', label: 'ECC', width: 170, businessKey: true },
  { id: 'customer', label: '客户名称', width: 190 },
  { id: 'serviceOrder', label: '服务单号', width: 160 },
  { id: 'amount', label: '合同金额', width: 150 },
  { id: 'region', label: '区域', width: 140 },
  { id: 'engineer', label: '工程师', width: 130 },
];

function rowAt(rowIndex: number): VirtualGridRow {
  const issue =
    rowIndex === 90_000
      ? [{ id: 'issue-90001', kind: 'error' as const, message: 'ECC 必填', rowIndex, columnId: 'ecc', source: '历史.xlsx / 项目 / 90002' }]
      : rowIndex === 42
        ? [{ id: 'warning-43', kind: 'warning' as const, message: '成交价格高于预算价格', rowIndex, columnId: 'amount' }]
        : [];
  return {
    id: `row-${rowIndex}`,
    values: {
      ecc: `ECC-${String(rowIndex + 1).padStart(6, '0')}`,
      customer: `客户 ${rowIndex + 1}`,
      serviceOrder: `SO-${rowIndex + 1}`,
      amount: `${rowIndex + 1}.00`,
      region: '华东',
      engineer: `工程师${rowIndex % 5}`,
    },
    issues: issue,
  };
}

function fakeProvider(): VirtualGridWindowProvider & { calls: GridWindowRequest[]; filters: GridFilter[] } {
  const calls: GridWindowRequest[] = [];
  const filters: GridFilter[] = [];
  return {
    calls,
    filters,
    async readWindow(request) {
      calls.push(request);
      filters.push(request.filter);
      return {
        total: TOTAL,
        rows: Array.from({ length: Math.min(request.limit, TOTAL - request.offset) }, (_, index) => rowAt(request.offset + index)),
      };
    },
    async search(query) {
      const match = /ECC-(\d+)/.exec(query);
      return match ? { rowIndex: Number(match[1]) - 1, columnId: 'ecc' } : null;
    },
    async locateIssue(issueId) {
      return issueId === 'issue-90001' ? { rowIndex: 90_000, columnId: 'ecc' } : null;
    },
  };
}

function setup() {
  const provider = fakeProvider();
  const ref = createRef<HistoryImportVirtualGridHandle>();
  const result = render(
    <HistoryImportVirtualGrid
      ref={ref}
      provider={provider}
      columns={columns}
      ariaLabel="项目与合同导入网格"
      height={216}
      rowHeight={36}
      overscan={12}
      onPatch={vi.fn()}
    />,
  );
  return { ...result, provider, ref };
}

/** 逐次操作耗时（p95）。 */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

afterEach(() => cleanup());

describe('8.70/8.71 100k 网格基准（现有组件/provider）', () => {
  it('DOM 与 provider 请求窗口有界，累计请求行数远小于 100k（renderer 不持有全量对象）', async () => {
    const { provider, container, ref } = setup();
    await screen.findByText('ECC-000001');
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '100000');
    expect(container.querySelectorAll('[data-row-index]').length).toBeLessThanOrEqual(300);
    expect(provider.calls[0]!.limit).toBeLessThanOrEqual(300);

    // 连续滚动 + 跳转 + 搜索 + 跳错误：多次窗口请求
    const viewport = container.querySelector('.history-grid-viewport') as HTMLDivElement;
    for (let scroll of [36_000, 90_000 * 36, 12_000, 88_000 * 36]) {
      fireEvent.scroll(viewport, { target: { scrollTop: scroll } });
      await waitFor(() => expect(provider.calls.some((c) => Math.abs(c.offset - (Math.floor(scroll / 36) - 12)) < 30)).toBe(true));
    }
    await ref.current!.jumpTo(99_999, 'ecc');
    await screen.findByText('ECC-100000');
    await ref.current!.locateIssue('issue-90001');
    await screen.findByText('ECC-090001');

    // renderer 不持有全量对象：累计请求行数（窗口求和）远小于 100k，且无 bulk 请求。
    const totalRequestedRows = provider.calls.reduce((sum, c) => sum + c.limit, 0);
    expect(provider.calls.every((c) => c.limit <= 300)).toBe(true);
    expect(totalRequestedRows).toBeLessThan(10_000);
    console.log(`[8.70 metric] providerRequests=${provider.calls.length} totalRequestedRows=${totalRequestedRows} domRows=${container.querySelectorAll('[data-row-index]').length}`);
    // 网格底部行未物化：尾行文本不存在（只呈现可见窗口）。
    expect(screen.queryByText(/客户 100000/)).not.toBeInTheDocument();
  });

  it('滚动/搜索/ECC+问题筛选/跳错误连续操作的 p95 延迟在合理阈值内', async () => {
    const { provider, container, ref } = setup();
    await screen.findByText('ECC-000001');
    const viewport = container.querySelector('.history-grid-viewport') as HTMLDivElement;

    const samples: number[] = [];
    const run = (op: () => Promise<unknown>) => {
      const t0 = performance.now();
      return op().then(() => {
        samples.push(performance.now() - t0);
      });
    };

    // 混合操作：远距跳转、搜索定位、跳错误、滚动到中部/尾部。
    await run(() => ref.current!.jumpTo(50_000, 'ecc'));
    await screen.findByText('ECC-050001');
    await run(() => ref.current!.jumpTo(99_999, 'ecc'));
    await screen.findByText('ECC-100000');
    await run(async () => {
      fireEvent.change(screen.getByLabelText('搜索业务键'), { target: { value: 'ECC-077777' } });
      fireEvent.click(screen.getByRole('button', { name: '定位' }));
      await screen.findByText('ECC-077777');
    });
    await run(() => ref.current!.locateIssue('issue-90001'));
    await screen.findByText('ECC-090001');
    await run(async () => {
      fireEvent.change(screen.getByLabelText('ECC 筛选'), { target: { value: 'ECC-09' } });
      fireEvent.change(screen.getByLabelText('问题类型'), { target: { value: 'error' } });
      await waitFor(() => expect(provider.filters.some((f) => f.ecc === 'ECC-09' && f.issueKind === 'error')).toBe(true));
    });
    for (let i = 0; i < 10; i += 1) {
      const offset = (i * 9_000 + 3_000) % 100_000;
      await run(async () => {
        fireEvent.scroll(viewport, { target: { scrollTop: offset * 36 } });
        await waitFor(() => expect(provider.calls.some((c) => Math.abs(c.offset - offset) < 30)).toBe(true));
      });
    }

    const latencyP95 = p95(samples);
    console.log(`[8.70 metric] operations=${samples.length} latencyP95Ms=${Math.round(latencyP95)} minMs=${Math.round(Math.min(...samples))} maxMs=${Math.round(Math.max(...samples))}`);
    // jsdom 下为 React 渲染 + provider 往返；合理阈值 1500ms（宽松防抖）。
    expect(latencyP95).toBeLessThan(1500);
    // 全量操作后 DOM 仍保持有界。
    expect(container.querySelectorAll('[data-row-index]').length).toBeLessThanOrEqual(300);
  });

  it('横向冻结身份：行号 sticky、ECC 业务键 is-frozen 固定左侧，横向滚动后表头/行号/ECC 仍可辨识', async () => {
    const { container } = setup();
    await screen.findByText('ECC-000001');

    const eccHeader = screen.getByRole('columnheader', { name: /ECC/ });
    expect(eccHeader).toHaveClass('is-frozen');
    // 冻结列 pinned 在行号（58px）之后：left 偏移 = ROW_NUMBER_WIDTH。
    expect((eccHeader as HTMLElement).style.left).toBe('58px');
    expect(screen.getByRole('columnheader', { name: '行号' })).toHaveClass('history-grid-row-number');
    // 非冻结列无 is-frozen。
    expect(screen.getByRole('columnheader', { name: '客户名称' })).not.toHaveClass('is-frozen');

    // 横向滚动事件后：冻结语义不变，ECC 单元格仍固定左侧、文本可辨识。
    const viewport = container.querySelector('.history-grid-viewport') as HTMLDivElement;
    fireEvent.scroll(viewport, { target: { scrollLeft: 600 } });
    const eccCell = screen.getByRole('gridcell', { name: /ECC，第 1 行/ });
    expect(eccCell).toHaveClass('is-frozen');
    expect((eccCell as HTMLElement).style.left).toBe('58px');
    expect(screen.getByText('ECC-000001')).toBeInTheDocument();
    const rowNumberHeader = screen.getByRole('columnheader', { name: '行号' });
    expect(rowNumberHeader).toHaveClass('history-grid-row-number');
    // 网格列数声明完整（行号 + 6 列）。
    expect(screen.getByRole('grid')).toHaveAttribute('aria-colcount', '7');
    console.log('[8.71 metric] horizontalFrozenIdentity=ECC pinned left=58px rowNumber sticky header preserved');
  });
});
