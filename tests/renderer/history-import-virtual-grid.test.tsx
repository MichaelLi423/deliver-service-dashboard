// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  HistoryImportVirtualGrid,
  type GridCellPatch,
  type GridColumn,
  type GridFilter,
  type GridSelection,
  type GridWindowRequest,
  type HistoryImportVirtualGridHandle,
  type VirtualGridRow,
  type VirtualGridWindowProvider,
} from '../../src/renderer/history-import';

const TOTAL = 100_000;
const columns: GridColumn[] = [
  { id: 'ecc', label: 'ECC', width: 170, businessKey: true },
  { id: 'customer', label: '客户名称', width: 190 },
  { id: 'serviceOrder', label: '服务单号', width: 160 },
  { id: 'amount', label: '合同金额', width: 150 },
];

function rowAt(rowIndex: number): VirtualGridRow {
  const issue = rowIndex === 90_000
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

function setup(options: { onPatch?: (patches: readonly GridCellPatch[]) => void; onSelectionChange?: (selection: GridSelection) => void; ref?: React.RefObject<HistoryImportVirtualGridHandle> } = {}) {
  const provider = fakeProvider();
  const onPatch = vi.fn(options.onPatch);
  const result = render(
    <HistoryImportVirtualGrid
      ref={options.ref}
      provider={provider}
      columns={columns}
      ariaLabel="项目与合同导入网格"
      height={216}
      rowHeight={36}
      overscan={12}
      onPatch={onPatch}
      onSelectionChange={options.onSelectionChange}
    />,
  );
  return { ...result, provider, onPatch };
}

afterEach(() => cleanup());

describe('history import fixed-height virtual grid performance gate', () => {
  it('100k 数据只通过 window provider 读取可见窗口，DOM 行节点保持有界', async () => {
    const { provider, container } = setup();
    const grid = await screen.findByRole('grid', { name: '项目与合同导入网格' });
    expect(grid).toHaveAttribute('aria-rowcount', '100000');
    expect(screen.getByText('100,000')).toBeInTheDocument();
    expect(provider.calls[0]).toMatchObject({ offset: 0, search: '' });
    expect(provider.calls[0]!.limit).toBeLessThanOrEqual(300);
    expect(container.querySelectorAll('[data-row-index]').length).toBeLessThanOrEqual(300);
    expect(screen.queryByText('ECC-100000')).not.toBeInTheDocument();
  });

  it('scroll 与指定行 jump 读取新窗口并直接定位，无需遍历前序记录', async () => {
    const ref = createRef<HistoryImportVirtualGridHandle>();
    const { provider, container } = setup({ ref });
    await screen.findByText('ECC-000001');
    const viewport = container.querySelector('.history-grid-viewport') as HTMLDivElement;
    fireEvent.scroll(viewport, { target: { scrollTop: 36_000 } });
    await waitFor(() => expect(provider.calls.some((call) => call.offset >= 988)).toBe(true));
    expect(container.querySelectorAll('[data-row-index]').length).toBeLessThanOrEqual(300);

    await ref.current!.jumpTo(99_999, 'ecc');
    expect(await screen.findByText('ECC-100000')).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute('data-column-id', 'ecc');
  });

  it('搜索、ECC/问题筛选和错误接口驱动 provider 并聚焦目标单元格', async () => {
    const ref = createRef<HistoryImportVirtualGridHandle>();
    const { provider } = setup({ ref });
    await screen.findByText('ECC-000001');
    fireEvent.change(screen.getByLabelText('搜索业务键'), { target: { value: 'ECC-090001' } });
    fireEvent.click(screen.getByRole('button', { name: '定位' }));
    expect(await screen.findByText('ECC-090001')).toBeInTheDocument();
    const errorCell = screen.getByRole('gridcell', { name: /ECC，第 90001 行，错误：ECC 必填/ });
    expect(errorCell).toHaveAttribute('aria-invalid', 'true');
    expect(within(errorCell).getByText('错误')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('ECC 筛选'), { target: { value: 'ECC-09' } });
    fireEvent.change(screen.getByLabelText('问题类型'), { target: { value: 'error' } });
    await waitFor(() => expect(provider.filters.some((filter) => filter.ecc === 'ECC-09' && filter.issueKind === 'error')).toBe(true));

    await ref.current!.locateIssue('issue-90001');
    expect(screen.getByRole('gridcell', { name: /ECC，第 90001 行，错误：ECC 必填/ })).toHaveFocus();
    // 8.87 定位时解除阻挡视图的筛选：跳错误后按「全部问题 + 空搜索」重新读取窗口（不被既有筛选阻挡）。
    await waitFor(() => {
      const last = provider.calls[provider.calls.length - 1];
      expect(last).toMatchObject({ search: '', filter: { issueKind: 'all' } });
    });
  });

  it('方向键、Tab/Shift+Tab、Enter/Escape 可预测，编辑覆盖层在虚拟行卸载后仍保留焦点', async () => {
    const { container, onPatch } = setup();
    const first = await screen.findByRole('gridcell', { name: 'ECC，第 1 行' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('gridcell', { name: '客户名称，第 1 行' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByRole('gridcell', { name: '服务单号，第 1 行' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    const customerCell = screen.getByRole('gridcell', { name: '客户名称，第 1 行' });
    expect(customerCell).toHaveFocus();

    fireEvent.keyDown(customerCell, { key: 'Enter' });
    const editor = screen.getByRole('textbox', { name: '编辑第 1 行 客户名称' });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: '未提交值' } });
    const viewport = container.querySelector('.history-grid-viewport') as HTMLDivElement;
    fireEvent.scroll(viewport, { target: { scrollTop: 50_000 * 36 } });
    await waitFor(() => expect(screen.queryByText('ECC-000001')).not.toBeInTheDocument());
    expect(editor).toHaveFocus();
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByText(/已取消当前单元格编辑/)).toBeInTheDocument();
  });

  it('IME composing 期间 Enter 不误提交，组合结束后 Enter 仅提交一个 patch', async () => {
    const { onPatch } = setup();
    const cell = await screen.findByRole('gridcell', { name: '客户名称，第 1 行' });
    fireEvent.keyDown(cell, { key: 'Enter' });
    const editor = screen.getByRole('textbox', { name: '编辑第 1 行 客户名称' });
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: '中文客户' } });
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([
      { rowIndex: 0, rowId: 'row-0', columnId: 'customer', value: '中文客户' },
    ]));
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  it('矩形选择与 Excel TSV 粘贴通过单次回调提交批量 patch，并保持焦点', async () => {
    const onSelectionChange = vi.fn();
    const { onPatch } = setup({ onSelectionChange });
    const start = await screen.findByRole('gridcell', { name: '客户名称，第 1 行' });
    const end = screen.getByRole('gridcell', { name: '服务单号，第 2 行' });
    fireEvent.pointerDown(start, { button: 0, pointerId: 1 });
    fireEvent.pointerEnter(end, { pointerId: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      start: { rowIndex: 0, rowId: 'row-0', columnId: 'customer' },
      end: { rowIndex: 1, rowId: 'row-1', columnId: 'serviceOrder' },
    });
    start.focus();
    fireEvent.paste(start, { clipboardData: { getData: () => '甲\tSO-A\n乙\tSO-B' } });
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith([
      { rowIndex: 0, columnId: 'customer', value: '甲' },
      { rowIndex: 0, columnId: 'serviceOrder', value: 'SO-A' },
      { rowIndex: 1, columnId: 'customer', value: '乙' },
      { rowIndex: 1, columnId: 'serviceOrder', value: 'SO-B' },
    ]);
    expect(start).toHaveFocus();
    expect(screen.getByText(/已提交 4 个单元格/)).toBeInTheDocument();
  });

  it('表头/行号/业务键有冻结语义，错误与警告以文字和图标表达且网格状态可读', async () => {
    const ref = createRef<HistoryImportVirtualGridHandle>();
    setup({ ref });
    await screen.findByText('ECC-000001');
    expect(screen.getByRole('columnheader', { name: '行号' })).toHaveClass('history-grid-row-number');
    expect(screen.getByRole('columnheader', { name: /ECC/ })).toHaveTextContent('冻结');
    expect(screen.getByRole('grid', { name: '项目与合同导入网格' })).toHaveAttribute('aria-multiselectable', 'true');
    expect(screen.getByText(/方向键移动/)).toBeInTheDocument();

    await ref.current!.jumpTo(42, 'amount');
    const warningCell = await screen.findByRole('gridcell', { name: /警告：成交价格高于预算价格/ });
    expect(within(warningCell).getByText('警告')).toBeInTheDocument();
    expect(warningCell).not.toHaveAttribute('aria-invalid', 'true');
  });
});
