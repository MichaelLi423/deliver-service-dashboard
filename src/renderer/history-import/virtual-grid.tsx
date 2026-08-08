import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import './virtual-grid.css';

export type GridIssueKind = 'error' | 'conflict' | 'warning';

export interface GridIssue {
  id: string;
  kind: GridIssueKind;
  message: string;
  rowIndex: number;
  columnId: string;
  source?: string;
}

export interface VirtualGridRow {
  id: string;
  values: Readonly<Record<string, string | null>>;
  issues?: readonly GridIssue[];
  readOnlyColumns?: readonly string[];
}

export interface GridFilter {
  ecc?: string;
  issueKind?: GridIssueKind | 'all';
}

export interface GridWindowRequest {
  offset: number;
  limit: number;
  search: string;
  filter: GridFilter;
}

export interface GridWindowResult {
  rows: readonly VirtualGridRow[];
  total: number;
}

export interface GridLocation {
  rowIndex: number;
  columnId?: string;
}

/** Renderer-facing, disk/window-backed contract. Implementations must not return the complete data set. */
export interface VirtualGridWindowProvider {
  readWindow(request: GridWindowRequest): Promise<GridWindowResult>;
  search?(query: string, filter: GridFilter): Promise<GridLocation | null>;
  locateIssue?(issueId: string): Promise<GridLocation | null>;
}

export interface GridColumn {
  id: string;
  label: string;
  width?: number;
  frozen?: boolean;
  businessKey?: boolean;
  readOnly?: boolean;
}

export interface GridCellPatch {
  rowIndex: number;
  rowId?: string;
  columnId: string;
  value: string;
}

export interface GridSelection {
  start: GridLocation;
  end: GridLocation;
}

export interface HistoryImportVirtualGridHandle {
  jumpTo(rowIndex: number, columnId?: string): Promise<void>;
  locateIssue(issueId: string): Promise<void>;
  focusSearch(): void;
  filterByEcc(ecc: string): void;
}

export interface HistoryImportVirtualGridProps {
  provider: VirtualGridWindowProvider;
  columns: readonly GridColumn[];
  ariaLabel: string;
  height?: number;
  rowHeight?: number;
  overscan?: number;
  initialFilter?: GridFilter;
  onPatch: (patches: readonly GridCellPatch[]) => void | Promise<void>;
  onSelectionChange?: (selection: GridSelection) => void;
  onFilterChange?: (filter: GridFilter) => void;
  onRequestNextIssue?: () => void;
  /** When supplied, clipboard text stays outside React and the host/provider owns paste processing. */
  onPasteRequest?: () => void;
}

interface ActiveCell extends GridLocation {
  rowId?: string;
}

interface EditState extends ActiveCell {
  original: string;
  value: string;
}

const ROW_NUMBER_WIDTH = 58;
const DEFAULT_ROW_HEIGHT = 36;
const DEFAULT_HEIGHT = 432;
const MAX_RENDERED_ROWS = 300;
const ISSUE_LABEL: Record<GridIssueKind, string> = {
  error: '错误',
  conflict: '冲突',
  warning: '警告',
};

function sameLocation(a: GridLocation, b: GridLocation): boolean {
  return a.rowIndex === b.rowIndex && a.columnId === b.columnId;
}

function parseClipboard(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return normalized.split('\n').map((line) => line.split('\t'));
}

export const HistoryImportVirtualGrid = forwardRef<HistoryImportVirtualGridHandle, HistoryImportVirtualGridProps>(
  function HistoryImportVirtualGrid(
    {
      provider,
      columns,
      ariaLabel,
      height = DEFAULT_HEIGHT,
      rowHeight = DEFAULT_ROW_HEIGHT,
      overscan = 8,
      initialFilter = { issueKind: 'all' },
      onPatch,
      onSelectionChange,
      onFilterChange,
      onRequestNextIssue,
      onPasteRequest,
    },
    forwardedRef,
  ) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const editorRef = useRef<HTMLInputElement>(null);
    const cellRefs = useRef(new Map<string, HTMLDivElement>());
    const requestSequence = useRef(0);
    const composing = useRef(false);
    const skipBlurCommit = useRef(false);
    const dragAnchor = useRef<GridLocation | null>(null);
    const queryRef = useRef({ search: '', filter: initialFilter });
    const [scrollTop, setScrollTop] = useState(0);
    const [searchText, setSearchText] = useState('');
    const [filter, setFilter] = useState<GridFilter>(initialFilter);
    const [windowResult, setWindowResult] = useState<GridWindowResult>({ rows: [], total: 0 });
    const [loadedOffset, setLoadedOffset] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [active, setActive] = useState<ActiveCell>({ rowIndex: 0, columnId: columns[0]?.id ?? '' });
    const [selection, setSelection] = useState<GridSelection | null>(null);
    const [editing, setEditing] = useState<EditState | null>(null);
    const [editorBox, setEditorBox] = useState<CSSProperties>({ display: 'none' });
    const [announcement, setAnnouncement] = useState('');

    const safeRowHeight = Math.max(24, rowHeight);
    const visibleCount = Math.max(1, Math.ceil(height / safeRowHeight));
    const safeOverscan = Math.max(0, Math.min(overscan, Math.floor((MAX_RENDERED_ROWS - visibleCount) / 2)));
    const startIndex = Math.max(0, Math.floor(scrollTop / safeRowHeight) - safeOverscan);
    const requestLimit = Math.min(MAX_RENDERED_ROWS, visibleCount + safeOverscan * 2);
    const columnIndex = useMemo(() => new Map(columns.map((column, index) => [column.id, index])), [columns]);
    const frozenOffsets = useMemo(() => {
      let left = ROW_NUMBER_WIDTH;
      const result = new Map<string, number>();
      for (const column of columns) {
        if (!column.frozen && !column.businessKey) continue;
        result.set(column.id, left);
        left += column.width ?? 160;
      }
      return result;
    }, [columns]);
    const gridTemplate = useMemo(
      () => `${ROW_NUMBER_WIDTH}px ${columns.map((column) => `${column.width ?? 160}px`).join(' ')}`,
      [columns],
    );
    const totalWidth = useMemo(
      () => ROW_NUMBER_WIDTH + columns.reduce((sum, column) => sum + (column.width ?? 160), 0),
      [columns],
    );

    const readWindow = useCallback(async (
      offset: number,
      nextSearch = queryRef.current.search,
      nextFilter = queryRef.current.filter,
    ) => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      setLoadError('');
      setWindowResult((current) => ({ ...current, rows: [] }));
      try {
        const result = await provider.readWindow({ offset, limit: requestLimit, search: nextSearch, filter: nextFilter });
        if (sequence !== requestSequence.current) return;
        setLoadedOffset(offset);
        setWindowResult({ rows: result.rows.slice(0, MAX_RENDERED_ROWS), total: Math.max(0, result.total) });
      } catch (error) {
        if (sequence !== requestSequence.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setWindowResult((current) => ({ ...current, rows: [] }));
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    }, [provider, requestLimit]);

    useEffect(() => {
      void readWindow(startIndex);
    }, [readWindow, startIndex]);

    const focusCell = useCallback((location: GridLocation): Promise<void> => new Promise((resolve) => {
      const key = `${location.rowIndex}:${location.columnId ?? columns[0]?.id ?? ''}`;
      const focus = (attempt: number) => {
        const cell = cellRefs.current.get(key);
        if (cell) {
          cell.focus();
          resolve();
        } else if (attempt < 4) window.setTimeout(() => focus(attempt + 1), 0);
        else resolve();
      };
      focus(0);
    }), [columns]);

    const jumpTo = useCallback(async (rawRowIndex: number, columnId = columns[0]?.id ?? '') => {
      const rowIndex = Math.max(0, Math.min(Math.floor(rawRowIndex), Math.max(0, windowResult.total - 1)));
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.scrollTop = rowIndex * safeRowHeight;
        setScrollTop(viewport.scrollTop);
      }
      setActive({ rowIndex, columnId });
      setSelection({ start: { rowIndex, columnId }, end: { rowIndex, columnId } });
      await readWindow(Math.max(0, rowIndex - safeOverscan));
      await focusCell({ rowIndex, columnId });
      setAnnouncement(`已定位到第 ${rowIndex + 1} 行，${columns.find((column) => column.id === columnId)?.label ?? columnId}`);
    }, [columns, focusCell, readWindow, safeOverscan, safeRowHeight, windowResult.total]);

    useImperativeHandle(forwardedRef, () => ({
      jumpTo,
      async locateIssue(issueId: string) {
        queryRef.current = { search: '', filter: { issueKind: 'all' } };
        setSearchText('');
        setFilter({ issueKind: 'all' });
        onFilterChange?.({ issueKind: 'all' });
        const location = await provider.locateIssue?.(issueId);
        if (location) await jumpTo(location.rowIndex, location.columnId);
      },
      focusSearch() {
        searchRef.current?.focus();
      },
      filterByEcc(ecc: string) {
        updateFilter({ ...queryRef.current.filter, ecc });
      },
    }), [jumpTo, provider]);

    useLayoutEffect(() => {
      if (!editing) return;
      const root = viewportRef.current;
      const cell = cellRefs.current.get(`${editing.rowIndex}:${editing.columnId}`);
      if (root && cell) {
        const rootBox = root.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        setEditorBox({
          display: 'block',
          left: cellBox.left - rootBox.left + root.scrollLeft,
          top: cellBox.top - rootBox.top + root.scrollTop,
          width: cellBox.width,
          height: cellBox.height,
        });
      }
      editorRef.current?.focus();
      editorRef.current?.select();
    }, [editing, scrollTop, windowResult.rows]);

    function updateFilter(next: GridFilter) {
      queryRef.current = { ...queryRef.current, filter: next };
      setFilter(next);
      onFilterChange?.(next);
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = 0;
      setScrollTop(0);
      void readWindow(0, searchText, next);
    }

    async function submitSearch() {
      queryRef.current = { ...queryRef.current, search: searchText };
      const location = await provider.search?.(searchText, filter);
      if (location) await jumpTo(location.rowIndex, location.columnId);
      else setAnnouncement(searchText ? `未找到“${searchText}”` : '请输入搜索内容');
    }

    function selectCell(next: ActiveCell, extend = false) {
      setActive(next);
      const nextSelection = extend && selection
        ? { start: selection.start, end: { rowIndex: next.rowIndex, columnId: next.columnId } }
        : { start: { rowIndex: next.rowIndex, columnId: next.columnId }, end: { rowIndex: next.rowIndex, columnId: next.columnId } };
      setSelection(nextSelection);
      onSelectionChange?.(nextSelection);
    }

    function beginEdit(cell: ActiveCell, initial?: string) {
      const localRow = windowResult.rows[cell.rowIndex - loadedOffset];
      const original = localRow?.values[cell.columnId ?? ''] ?? '';
      setEditing({ ...cell, original, value: initial ?? original });
    }

    async function commitEdit(moveAfterCommit?: number) {
      if (!editing) return;
      skipBlurCommit.current = true;
      if (editing.value !== editing.original) {
        await onPatch([{ rowIndex: editing.rowIndex, rowId: editing.rowId, columnId: editing.columnId ?? '', value: editing.value }]);
        setAnnouncement(`第 ${editing.rowIndex + 1} 行已更新`);
      }
      const committed = editing;
      setEditing(null);
      if (moveAfterCommit !== undefined) moveCell(committed, moveAfterCommit, false);
      else focusCell(committed);
    }

    function cancelEdit() {
      if (!editing) return;
      skipBlurCommit.current = true;
      const cancelled = editing;
      setEditing(null);
      setAnnouncement('已取消当前单元格编辑，草稿未受影响');
      focusCell(cancelled);
    }

    function moveCell(from: GridLocation, delta: number, extend: boolean) {
      const currentColumn = columnIndex.get(from.columnId ?? '') ?? 0;
      const linear = from.rowIndex * columns.length + currentColumn + delta;
      const bounded = Math.max(0, Math.min(linear, Math.max(0, windowResult.total * columns.length - 1)));
      const next: ActiveCell = {
        rowIndex: Math.floor(bounded / columns.length),
        columnId: columns[bounded % columns.length]?.id ?? '',
      };
      selectCell(next, extend);
      const firstVisible = Math.floor(scrollTop / safeRowHeight);
      const lastVisible = firstVisible + visibleCount - 1;
      if (next.rowIndex < firstVisible || next.rowIndex > lastVisible) void jumpTo(next.rowIndex, next.columnId);
      else focusCell(next);
    }

    function handleCellKey(event: KeyboardEvent<HTMLDivElement>, cell: ActiveCell) {
      if (event.nativeEvent.isComposing || composing.current) return;
      const movement: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -columns.length,
        ArrowDown: columns.length,
      };
      if (event.key in movement) {
        event.preventDefault();
        moveCell(cell, movement[event.key], event.shiftKey);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        moveCell(cell, event.shiftKey ? -1 : 1, false);
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        beginEdit(cell);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        beginEdit(cell, event.key);
      }
    }

    function handleEditorKey(event: KeyboardEvent<HTMLInputElement>) {
      if (event.nativeEvent.isComposing || composing.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void commitEdit();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        void commitEdit(event.shiftKey ? -1 : 1);
      }
    }

    function handlePaste(event: ClipboardEvent<HTMLDivElement>, cell: ActiveCell) {
      if (onPasteRequest) {
        event.preventDefault();
        onPasteRequest();
        setAnnouncement('已打开粘贴确认，剪贴板内容将由主进程读取');
        return;
      }
      const matrix = parseClipboard(event.clipboardData.getData('text/plain'));
      if (!matrix.length || !matrix[0]?.length) return;
      event.preventDefault();
      const startColumn = columnIndex.get(cell.columnId ?? '') ?? 0;
      const patches: GridCellPatch[] = [];
      matrix.forEach((values, rowOffset) => values.forEach((value, columnOffset) => {
        const column = columns[startColumn + columnOffset];
        const rowIndex = cell.rowIndex + rowOffset;
        if (!column || rowIndex >= windowResult.total || column.readOnly) return;
        patches.push({ rowIndex, columnId: column.id, value });
      }));
      if (!patches.length) return;
      void onPatch(patches);
      const last = patches[patches.length - 1];
      const nextSelection = {
        start: { rowIndex: cell.rowIndex, columnId: cell.columnId },
        end: { rowIndex: last.rowIndex, columnId: last.columnId },
      };
      setSelection(nextSelection);
      onSelectionChange?.(nextSelection);
      setAnnouncement(`已提交 ${patches.length} 个单元格的矩形粘贴修改`);
      focusCell(cell);
    }

    function pointerDown(event: PointerEvent<HTMLDivElement>, cell: ActiveCell) {
      if (event.button > 0) return;
      dragAnchor.current = cell;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      selectCell(cell);
    }

    function pointerEnter(cell: ActiveCell) {
      if (!dragAnchor.current) return;
      const nextSelection = { start: dragAnchor.current, end: cell };
      setSelection(nextSelection);
      onSelectionChange?.(nextSelection);
    }

    const isSelected = (location: GridLocation) => {
      if (!selection) return false;
      const startColumn = columnIndex.get(selection.start.columnId ?? '') ?? 0;
      const endColumn = columnIndex.get(selection.end.columnId ?? '') ?? 0;
      const column = columnIndex.get(location.columnId ?? '') ?? 0;
      return location.rowIndex >= Math.min(selection.start.rowIndex, selection.end.rowIndex)
        && location.rowIndex <= Math.max(selection.start.rowIndex, selection.end.rowIndex)
        && column >= Math.min(startColumn, endColumn)
        && column <= Math.max(startColumn, endColumn);
    };

    const visibleStart = windowResult.total === 0 || windowResult.rows.length === 0 ? 0 : loadedOffset + 1;
    const visibleEnd = Math.min(windowResult.total, loadedOffset + windowResult.rows.length);

    return (
      <section className="history-grid-shell" aria-label={`${ariaLabel}工具区`}>
        <div className="history-grid-toolbar">
          <form onSubmit={(event) => { event.preventDefault(); void submitSearch(); }} role="search">
            <label htmlFor={`${ariaLabel}-search`}>搜索业务键</label>
            <div className="history-grid-inline-control">
              <input
                ref={searchRef}
                id={`${ariaLabel}-search`}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="ECC / 服务单号"
              />
              <button type="submit">定位</button>
            </div>
          </form>
          <label>
            ECC 筛选
            <input value={filter.ecc ?? ''} onChange={(event) => updateFilter({ ...filter, ecc: event.target.value })} />
          </label>
          <label>
            问题类型
            <select
              value={filter.issueKind ?? 'all'}
              onChange={(event) => updateFilter({ ...filter, issueKind: event.target.value as GridFilter['issueKind'] })}
            >
              <option value="all">全部问题</option>
              <option value="error">错误</option>
              <option value="conflict">冲突</option>
              <option value="warning">警告</option>
            </select>
          </label>
          <form
            className="history-grid-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(new FormData(event.currentTarget).get('row'));
              if (Number.isFinite(value)) void jumpTo(value - 1);
            }}
          >
            <label htmlFor={`${ariaLabel}-jump`}>跳至行</label>
            <div className="history-grid-inline-control">
              <input id={`${ariaLabel}-jump`} name="row" type="number" min="1" max={Math.max(1, windowResult.total)} />
              <button type="submit">跳转</button>
            </div>
          </form>
          {onRequestNextIssue && <button type="button" className="history-grid-next-issue" onClick={onRequestNextIssue}>定位下一错误</button>}
        </div>

        <div className="history-grid-statusline">
          <span><strong>{windowResult.total.toLocaleString('zh-CN')}</strong> 条记录</span>
          <span aria-live="polite">当前呈现 {visibleStart}–{visibleEnd} 行 · DOM {windowResult.rows.length} 行</span>
          {loading && <span className="history-grid-loading" role="status">正在读取窗口…</span>}
          {loadError && <span className="history-grid-load-error" role="alert">读取失败：{loadError}</span>}
        </div>

        <div
          ref={viewportRef}
          className="history-grid-viewport"
          data-testid="history-import-grid-viewport"
          style={{ height }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onPointerUp={() => { dragAnchor.current = null; }}
          onPointerCancel={() => { dragAnchor.current = null; }}
        >
          <div
            className="history-grid"
            role="grid"
            aria-label={ariaLabel}
            aria-rowcount={windowResult.total}
            aria-colcount={columns.length + 1}
            aria-multiselectable="true"
            style={{ width: totalWidth, minWidth: '100%' }}
          >
            <div className="history-grid-header" role="row" style={{ gridTemplateColumns: gridTemplate, height: safeRowHeight }}>
              <div className="history-grid-columnheader history-grid-row-number" role="columnheader" aria-label="行号">#</div>
              {columns.map((column) => {
                const frozen = frozenOffsets.has(column.id);
                return (
                  <div
                    key={column.id}
                    role="columnheader"
                    className={`history-grid-columnheader ${frozen ? 'is-frozen' : ''}`}
                    style={frozen ? { left: frozenOffsets.get(column.id) } : undefined}
                  >
                    <span>{column.label}</span>
                    {(column.businessKey || column.frozen) && <small>冻结</small>}
                  </div>
                );
              })}
            </div>
            <div className="history-grid-spacer" style={{ height: windowResult.total * safeRowHeight }}>
              {windowResult.rows.map((row, localIndex) => {
                const rowIndex = loadedOffset + localIndex;
                const rowIssues = row.issues ?? [];
                return (
                  <div
                    key={row.id}
                    className={`history-grid-row ${rowIssues.length ? 'has-issue' : ''}`}
                    role="row"
                    aria-rowindex={rowIndex + 1}
                    style={{ gridTemplateColumns: gridTemplate, height: safeRowHeight, transform: `translateY(${rowIndex * safeRowHeight}px)` }}
                    data-row-index={rowIndex}
                  >
                    <div className="history-grid-row-number" role="rowheader">
                      {rowIssues.length > 0 && <span className="history-grid-row-issue" aria-label={`本行有 ${rowIssues.length} 个问题`}>!</span>}
                      {rowIndex + 1}
                    </div>
                    {columns.map((column) => {
                      const location: ActiveCell = { rowIndex, rowId: row.id, columnId: column.id };
                      const issues = rowIssues.filter((issue) => issue.columnId === column.id);
                      const frozen = frozenOffsets.has(column.id);
                      const readOnly = column.readOnly || row.readOnlyColumns?.includes(column.id);
                      const selected = isSelected(location);
                      const focused = sameLocation(active, location);
                      return (
                        <div
                          key={column.id}
                          ref={(node) => {
                            const key = `${rowIndex}:${column.id}`;
                            if (node) cellRefs.current.set(key, node);
                            else cellRefs.current.delete(key);
                          }}
                          role="gridcell"
                          tabIndex={focused ? 0 : -1}
                          aria-selected={selected}
                          aria-readonly={readOnly || undefined}
                          aria-invalid={issues.some((issue) => issue.kind === 'error') || undefined}
                          aria-label={`${column.label}，第 ${rowIndex + 1} 行${issues.length ? `，${issues.map((issue) => `${ISSUE_LABEL[issue.kind]}：${issue.message}`).join('；')}` : ''}`}
                          className={`history-grid-cell ${frozen ? 'is-frozen' : ''} ${selected ? 'is-selected' : ''} ${readOnly ? 'is-readonly' : ''}`}
                          style={frozen ? { left: frozenOffsets.get(column.id) } : undefined}
                          data-column-id={column.id}
                          onFocus={() => setActive(location)}
                          onDoubleClick={() => { if (!readOnly) beginEdit(location); }}
                          onKeyDown={(event) => { if (!readOnly) handleCellKey(event, location); else if (event.key in { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Tab: 1 }) handleCellKey(event, location); }}
                          onPaste={(event) => handlePaste(event, location)}
                          onPointerDown={(event) => pointerDown(event, location)}
                          onPointerEnter={() => pointerEnter(location)}
                        >
                          <span className="history-grid-cell-value">{row.values[column.id] ?? ''}</span>
                          {readOnly && <span className="history-grid-state-label">只读</span>}
                          {issues.map((issue) => (
                            <span key={issue.id} className={`history-grid-issue history-grid-issue-${issue.kind}`} title={issue.message}>
                              <span aria-hidden="true">{issue.kind === 'error' ? '×' : issue.kind === 'conflict' ? '⇄' : '!'}</span>
                              {ISSUE_LABEL[issue.kind]}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <input
              ref={editorRef}
              className="history-grid-editor"
              style={editorBox}
              value={editing?.value ?? ''}
              aria-label={editing ? `编辑第 ${editing.rowIndex + 1} 行 ${columns.find((column) => column.id === editing.columnId)?.label ?? editing.columnId}` : '单元格编辑器'}
              onChange={(event) => setEditing((current) => current ? { ...current, value: event.target.value } : current)}
              onKeyDown={handleEditorKey}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onBlur={() => {
                if (skipBlurCommit.current) {
                  skipBlurCommit.current = false;
                  return;
                }
                if (editing && !composing.current) void commitEdit();
              }}
            />
          </div>
        </div>
        <p className="history-grid-help" id={`${ariaLabel}-help`}>
          方向键移动；Enter 编辑或提交；Tab / Shift+Tab 顺序移动；Escape 仅取消当前编辑；支持矩形选择和粘贴。
        </p>
        <div className="history-grid-announcer" aria-live="polite" aria-atomic="true">{announcement}</div>
      </section>
    );
  },
);

export const FixedHeightVirtualGrid = HistoryImportVirtualGrid;
