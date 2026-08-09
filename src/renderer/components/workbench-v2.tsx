import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  AccountSessionInfo,
  AdjustableProjectStatus,
  ProjectStatus,
  ProjectWizardPayload,
  ReportDto,
  ReportFilterDto,
  WorkbenchActionPayload,
  WorkbenchActionType,
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2IndependentKind,
  WorkbenchV2IndependentPageDto,
  WorkbenchV2InvalidateTag,
  WorkbenchV2LookupPageDto,
  WorkbenchV2LookupRow,
  WorkbenchV2MutationRequest,
  WorkbenchV2OverviewDto,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionKind,
  WorkbenchV2SectionPageDto,
  WorkbenchV2SectionRow,
} from "../../shared/ipc";
import {
  HistoryImportWizard,
  IpcHistoryImportProvider,
} from "../history-import";

const PAGE_SIZE = 50;
const STATUS_LABEL: Record<ProjectStatus, string> = {
  pending_entry: "待进单",
  pending_execution: "待执行",
  executing: "执行中",
  pending_acceptance: "待验收",
  pending_invoice: "待掉票",
  completed: "已完成",
  cancelled: "已取消",
};
const STAGES: AdjustableProjectStatus[] = [
  "pending_entry",
  "pending_execution",
  "executing",
  "pending_acceptance",
  "pending_invoice",
  "completed",
];
const TABS = [
  "项目总览",
  "搬迁仪器",
  "搬迁批次",
  "上门活动",
  "费用与掉票",
  "申请与维修",
] as const;
type DetailTab = (typeof TABS)[number];
const TAB_SECTION: Partial<Record<DetailTab, WorkbenchV2SectionKind>> = {
  搬迁仪器: "instruments",
  搬迁批次: "batches",
  上门活动: "activities",
  费用与掉票: "invoices",
  申请与维修: "damage_items",
};
const ACTIONS: Array<{
  type: WorkbenchActionType;
  label: string;
  help: string;
}> = [
  {
    type: "batch",
    label: "搬迁批次",
    help: "运输日期、运输公司与两档人民币报价",
  },
  {
    type: "instrument",
    label: "搬迁仪器",
    help: "名称、型号、序列号、UPS 与二维码标记",
  },
  {
    type: "visit",
    label: "上门活动",
    help: "同页记录拆机、装机、维修与其他工作",
  },
  { type: "order", label: "开单记录", help: "搬迁、认证、单寄备件或 PM 开单" },
  {
    type: "logistics",
    label: "实际物流费用",
    help: "登记时间、预算价格、成交价格与物流费用",
  },
  {
    type: "acceptance",
    label: "验收报告",
    help: "记录报告形成日期并进入待掉票",
  },
  { type: "invoice", label: "掉票", help: "按 ECC 登记发生时间与金额" },
  {
    type: "ship_to",
    label: "Ship-to 申请",
    help: "客户名称、新址地址与线性状态",
  },
  {
    type: "damage",
    label: "损坏/维修事项",
    help: "一次损坏、一个备件与维修过程",
  },
  {
    type: "core",
    label: "补齐进单核心资料",
    help: "在原项目补齐合同、ECC 与进单时间",
  },
];

type V2Method =
  | "v2Overview"
  | "v2ProjectPage"
  | "v2ProjectDetail"
  | "v2SectionPage"
  | "v2IndependentPage"
  | "v2LookupPage"
  | "v2Mutate";
function bridge(): WorkbenchApi | undefined {
  return (window as unknown as { workbench?: WorkbenchApi }).workbench;
}
function requireV2<K extends V2Method>(
  api: WorkbenchApi,
  name: K,
): NonNullable<WorkbenchApi[K]> {
  const method = api[name];
  if (!method)
    throw new Error(`当前工作台缺少 ${name}，已停止旧 snapshot 回退`);
  return method.bind(api) as NonNullable<WorkbenchApi[K]>;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function localDateTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function money(value: string | null, currency = "USD"): string {
  if (value === null || value === "") return "待补";
  const negative = value.startsWith("-");
  const abs = negative ? value.slice(1) : value;
  const [units, fraction = "00"] = abs.split(".");
  return `${currency} ${negative ? "-" : ""}${units.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(fraction + "00").slice(0, 2)}`;
}
function centsOf(value: string | null): bigint {
  if (!value) return 0n;
  const negative = value.startsWith("-");
  const [units = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(units || "0") * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -cents : cents;
}
function decimalOf(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

interface Filters {
  status: ProjectStatus | "";
  reminder: "" | "any" | "overdue" | "today" | "upcoming";
  region: string;
  query: string;
}
type LayerState =
  | { kind: "new" | "quick" | "reminder" | "cancel" | "report" }
  | { kind: "action"; action: WorkbenchActionType }
  | { kind: "independent"; module: WorkbenchV2IndependentKind }
  | {
      kind: "invoice-edit" | "invoice-revoke";
      invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>;
    };

export function WorkbenchV2({
  session,
  autoBackupError,
  onSessionRestored,
}: {
  session: AccountSessionInfo;
  autoBackupError?: string;
  /** 恢复备份后主进程可能改用不同账号（如备份中的既有账号），回调同步会话展示。 */
  onSessionRestored?: (session: AccountSessionInfo) => void;
}): JSX.Element {
  const [overview, setOverview] = useState<WorkbenchV2OverviewDto | null>(null);
  const [projectPage, setProjectPage] =
    useState<WorkbenchV2ProjectPageDto | null>(null);
  const [filters, setFilters] = useState<Filters>({
    status: "",
    reminder: "",
    region: "",
    query: "",
  });
  const [draftFilters, setDraftFilters] = useState(filters);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkbenchV2ProjectDetailDto | null>(
    null,
  );
  const [tab, setTab] = useState<DetailTab>("项目总览");
  const [sectionPage, setSectionPage] =
    useState<WorkbenchV2SectionPageDto | null>(null);
  const [sectionCursors, setSectionCursors] = useState<Array<string | null>>([
    null,
  ]);
  const [loading, setLoading] = useState({
    overview: true,
    projects: true,
    detail: false,
    section: false,
  });
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  const [layer, setLayer] = useState<LayerState | null>(null);
  const [historyImport, setHistoryImport] = useState(false);
  const [independentRefresh, setIndependentRefresh] = useState(0);
  const revision = useRef(0);
  const requests = useRef({ projects: 0, detail: 0, section: 0, overview: 0 });
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const importTrigger = useRef<HTMLButtonElement>(null);
  /** 提醒跳转/新建成功后钉住的目标项目：即使不在当前页也不被 loadProjects 重置选中。 */
  const selectionPin = useRef("");

  const currentPageIndex = cursorStack.length - 1;
  const currentSectionIndex = sectionCursors.length - 1;
  const selected =
    detail?.project ??
    projectPage?.projects.find((project) => project.id === selectedId) ??
    null;

  function acceptBusinessRevision(next: number): boolean {
    if (next < revision.current) return false;
    revision.current = Math.max(revision.current, next);
    return true;
  }

  async function loadOverview(): Promise<void> {
    const id = ++requests.current.overview;
    setLoading((old) => ({ ...old, overview: true }));
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(api, "v2Overview")();
      if (
        id === requests.current.overview &&
        acceptBusinessRevision(next.businessRevision)
      )
        setOverview(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (id === requests.current.overview)
        setLoading((old) => ({ ...old, overview: false }));
    }
  }

  async function loadProjects(
    cursor: string | null,
    pageIndex: number,
    focusId?: string,
    filterOverride?: Filters,
  ): Promise<void> {
    const id = ++requests.current.projects;
    setLoading((old) => ({ ...old, projects: true }));
    setError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const effective = filterOverride ?? filters;
      const next = await requireV2(
        api,
        "v2ProjectPage",
      )({
        limit: PAGE_SIZE,
        cursor,
        status: effective.status || null,
        reminder: effective.reminder || null,
        region: effective.region.trim() || null,
        query: effective.query.trim() || null,
      });
      if (
        id !== requests.current.projects ||
        !acceptBusinessRevision(next.businessRevision)
      )
        return;
      setProjectPage(next);
      setSelectedId((current) => {
        if (next.projects.some((project) => project.id === current)) {
          // 目标已在当前页，解除钉住（提醒/新建跳转已完成定位）。
          if (selectionPin.current === current) selectionPin.current = "";
          return current;
        }
        if (selectionPin.current) return selectionPin.current;
        return next.projects[0]?.id ?? "";
      });
      setNotice(
        next.total
          ? `已显示第 ${pageIndex * next.limit + 1} 至 ${Math.min((pageIndex + 1) * next.limit, next.total)} 项，共 ${next.total} 项`
          : "当前筛选没有项目",
      );
      requestAnimationFrame(() => {
        const target = focusId === "__first__" || (focusId && !next.projects.some((project) => project.id === focusId)) ? next.projects[0]?.id : focusId;
        if (target) rowRefs.current.get(target)?.focus();
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (id === requests.current.projects)
        setLoading((old) => ({ ...old, projects: false }));
    }
  }

  async function loadDetail(projectId: string): Promise<void> {
    const id = ++requests.current.detail;
    setLoading((old) => ({ ...old, detail: true }));
    setDetailError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(api, "v2ProjectDetail")(projectId);
      if (
        id === requests.current.detail &&
        projectId === selectedId &&
        acceptBusinessRevision(next.businessRevision)
      )
        setDetail(next);
    } catch (cause) {
      if (id === requests.current.detail) setDetailError(messageOf(cause));
    } finally {
      if (id === requests.current.detail)
        setLoading((old) => ({ ...old, detail: false }));
    }
  }

  async function loadSection(
    projectId: string,
    kind: WorkbenchV2SectionKind,
    cursor: string | null,
  ): Promise<void> {
    const id = ++requests.current.section;
    setLoading((old) => ({ ...old, section: true }));
    setDetailError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2SectionPage",
      )({ projectId, kind, limit: PAGE_SIZE, cursor });
      if (
        id === requests.current.section &&
        projectId === selectedId &&
        TAB_SECTION[tab] === kind &&
        acceptBusinessRevision(next.businessRevision)
      )
        setSectionPage(next);
    } catch (cause) {
      if (id === requests.current.section) setDetailError(messageOf(cause));
    } finally {
      if (id === requests.current.section)
        setLoading((old) => ({ ...old, section: false }));
    }
  }

  useEffect(() => {
    void loadOverview();
  }, []);
  useEffect(() => {
    setCursorStack([null]);
    void loadProjects(null, 0);
  }, [filters.status, filters.reminder, filters.region, filters.query]);
  useEffect(() => {
    setDetail(null);
    setSectionPage(null);
    setSectionCursors([null]);
    setTab("项目总览");
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId]);
  useEffect(() => {
    const kind = TAB_SECTION[tab];
    setSectionPage(null);
    setSectionCursors([null]);
    if (selectedId && kind) void loadSection(selectedId, kind, null);
  }, [tab]);

  async function refreshInvalidated(
    tags: readonly WorkbenchV2InvalidateTag[],
    changedProjectId?: string,
    filterOverride?: Filters,
  ): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (tags.includes("overview")) jobs.push(loadOverview());
    if (tags.includes("projects"))
      jobs.push(
        loadProjects(
          filterOverride ? null : (cursorStack.at(-1) ?? null),
          filterOverride ? 0 : currentPageIndex,
          changedProjectId ?? selectedId,
          filterOverride,
        ),
      );
    if (selectedId && tags.includes(`project:${selectedId}`))
      jobs.push(loadDetail(selectedId));
    if (
      selectedId &&
      tags.includes(`sections:${selectedId}`) &&
      TAB_SECTION[tab]
    )
      jobs.push(
        loadSection(
          selectedId,
          TAB_SECTION[tab]!,
          sectionCursors.at(-1) ?? null,
        ),
      );
    if (
      tags.includes("independent:serial_address") ||
      tags.includes("independent:qr_request")
    )
      setIndependentRefresh((value) => value + 1);
    await Promise.all(jobs);
  }

  async function mutate(
    request: WorkbenchV2MutationRequest,
    success: string,
  ): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await requireV2(api, "v2Mutate")(request);
      revision.current = Math.max(revision.current, result.businessRevision);
      let cleared: Filters | undefined;
      if (
        request.op === "create_project" &&
        result.changed?.created &&
        result.changed.projectId
      ) {
        // 新建成功：清除可能隐藏新项目的筛选、回到首屏，并钉住返回的项目 id 自动选中。
        cleared = { status: "", reminder: "", region: "", query: "" };
        selectionPin.current = result.changed.projectId;
        setDraftFilters(cleared);
        setFilters(cleared);
        setCursorStack([null]);
        setSelectedId(result.changed.projectId);
      }
      await refreshInvalidated(result.invalidated, result.changed?.projectId, cleared);
      setLayer(null);
      setToast(success);
      window.setTimeout(() => setToast(""), 2800);
    } catch (cause) {
      throw new Error(messageOf(cause));
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    selectionPin.current = "";
    setFilters({ ...draftFilters });
  }
  function resetFilters(): void {
    const next: Filters = { status: "", reminder: "", region: "", query: "" };
    selectionPin.current = "";
    setDraftFilters(next);
    setFilters(next);
  }
  function selectReminder(
    item: WorkbenchV2OverviewDto["reminderPreview"][number],
  ): void {
    const query = item.ecc ?? item.tempNo ?? item.customerName;
    // 钉住提醒目标：即使新筛选下不在当前页，也保持选中并继续按 id 读取详情。
    selectionPin.current = item.projectId;
    setFilters({ status: "", reminder: "any", region: "", query });
    setDraftFilters({ status: "", reminder: "any", region: "", query });
    setSelectedId(item.projectId);
    document.getElementById("project-queue")?.focus();
  }

  function queueKey(
    event: KeyboardEvent<HTMLTableRowElement>,
    index: number,
  ): void {
    selectionPin.current = "";
    const rows = projectPage?.projects ?? [];
    if (!rows.length) return;
    let target = index;
    if (event.key === "ArrowDown")
      target = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") target = Math.max(0, index - 1);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = rows.length - 1;
    else if (event.key === "PageDown") {
      event.preventDefault();
      void nextProjectPage(true);
      return;
    } else if (event.key === "PageUp") {
      event.preventDefault();
      void previousProjectPage(true);
      return;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(rows[index]!.id);
      return;
    } else return;
    event.preventDefault();
    const project = rows[target]!;
    setSelectedId(project.id);
    rowRefs.current.get(project.id)?.focus();
  }

  async function nextProjectPage(focus = false): Promise<void> {
    if (!projectPage?.nextCursor) return;
    selectionPin.current = "";
    const stack = [...cursorStack, projectPage.nextCursor];
    setCursorStack(stack);
    await loadProjects(
      projectPage.nextCursor,
      stack.length - 1,
      focus ? "__first__" : undefined,
    );
  }
  async function previousProjectPage(focus = false): Promise<void> {
    if (cursorStack.length <= 1) return;
    selectionPin.current = "";
    const stack = cursorStack.slice(0, -1);
    const cursor = stack.at(-1) ?? null;
    setCursorStack(stack);
    await loadProjects(
      cursor,
      stack.length - 1,
      focus ? "__first__" : undefined,
    );
  }

  async function runBackup(): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await api.backupManual();
      if (!result.canceled) {
        setToast("手动备份已保存");
        window.setTimeout(() => setToast(""), 2800);
      }
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function runRestore(): Promise<void> {
    if (!window.confirm("恢复备份会用备份文件替换当前本地数据。是否继续？"))
      return;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await api.restoreFromBackup();
      if (result.restored) {
        // 无密码模式：主进程恢复后已重新取得/确保本地账号并恢复会话。
        const refreshed = await api.getSession();
        if (refreshed) onSessionRestored?.(refreshed);
        // 直接重读工作台数据（恢复的库 revision 可能更低，先重置修订水位）。
        revision.current = 0;
        setCursorStack([null]);
        setDetail(null);
        setSectionPage(null);
        setSectionCursors([null]);
        setTab("项目总览");
        setToast("备份已恢复，数据已重新加载");
        window.setTimeout(() => setToast(""), 2800);
        void Promise.all([loadOverview(), loadProjects(null, 0)]);
      }
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  if (historyImport) {
    return (
      <HistoryImportWizard
        provider={new IpcHistoryImportProvider()}
        username={session.username}
        onExit={() => {
          setHistoryImport(false);
          setCursorStack([null]);
          void Promise.all([loadOverview(), loadProjects(null, 0)]);
          requestAnimationFrame(() => importTrigger.current?.focus());
        }}
      />
    );
  }

  const metrics = overview
    ? [
        [
          "活跃搬迁项目",
          String(overview.metrics.activeProjects),
          `共 ${overview.metrics.totalProjects} 个项目`,
        ],
        [
          "当前项目提醒",
          String(overview.metrics.reminderCount),
          `逾期 ${overview.metrics.reminderOverdue} · 今日 ${overview.metrics.reminderToday}`,
        ],
        [
          "待掉票金额",
          money(overview.metrics.pendingAmount),
          "按最终可确认金额计算",
        ],
        [
          "待验收 / 待掉票",
          `${overview.metrics.pendingAcceptance} / ${overview.metrics.pendingInvoice}`,
          "当前生命周期瓶颈",
        ],
      ]
    : [];
  const bottleneck = overview?.stages.reduce((current, item) =>
    !current || item.averageDays > current.averageDays ? item : current,
  undefined as WorkbenchV2OverviewDto["stages"][number] | undefined);

  return (
    <div className="app-shell workbench-v2">
      <header className="topbar">
        <a className="brand" href="#main">
          <span className="brand-mark small">RW</span>
          <span>搬迁服务工作台</span>
        </a>
        <nav aria-label="主导航">
          <button onClick={() => document.getElementById("reminders")?.focus()}>
            项目提醒
          </button>
          <button
            onClick={() => document.getElementById("project-queue")?.focus()}
          >
            项目队列
          </button>
          <button
            onClick={() =>
              setLayer({ kind: "independent", module: "serial_address" })
            }
          >
            序列号地址更新
          </button>
          <button
            onClick={() =>
              setLayer({ kind: "independent", module: "qr_request" })
            }
          >
            二维码申请
          </button>
          <button onClick={() => setLayer({ kind: "report" })}>运营报表</button>
          <details className="data-menu">
            <summary>数据管理</summary>
            <div>
              <button
                ref={importTrigger}
                onClick={() => setHistoryImport(true)}
              >
                历史数据导入
              </button>
              <button onClick={() => void runBackup()}>手动备份</button>
              <button className="danger-text" onClick={() => void runRestore()}>
                恢复备份
              </button>
            </div>
          </details>
        </nav>
        <div className="account-chip">
          <span aria-hidden="true">●</span>
          {session.username}
        </div>
      </header>
      <main id="main" className="page">
        <section className="command">
          <div>
            <p className="overline">任务指挥台</p>
            <h1>先处理提醒，再连续推进项目</h1>
            <p>提醒由负责人手工维护；空字段不会自动生成提醒。</p>
          </div>
          <div className="row-actions">
            <button
              className="button"
              disabled={!selected}
              onClick={() => setLayer({ kind: "quick" })}
            >
              快速记录
            </button>
            <button
              className="button primary"
              onClick={() => setLayer({ kind: "new" })}
            >
              新建搬迁项目
            </button>
          </div>
        </section>
        {error && (
          <div className="page-error" role="alert">
            {error}
            <button
              onClick={() => {
                setError("");
                void Promise.all([
                  loadOverview(),
                  loadProjects(cursorStack.at(-1) ?? null, currentPageIndex),
                ]);
              }}
            >
              重试
            </button>
          </div>
        )}
        {autoBackupError && (
          <div className="inline-warning full" role="status">
            自动备份失败：{autoBackupError}
            。工作台仍可正常使用，请及时手动备份。
          </div>
        )}
        <section
          className="metrics panel"
          aria-label="关键运营指标"
          aria-busy={loading.overview}
        >
          {metrics.map(([label, value, meta]) => (
            <div className="metric" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{meta}</small>
            </div>
          ))}
        </section>
        <section className="panel lifecycle" aria-labelledby="lifecycle-title">
          <div className="panel-head">
            <div>
              <h2 id="lifecycle-title">生命周期吞吐</h2>
              <p>点击阶段筛选主项目队列</p>
            </div>
            <button
              className="text-action"
              onClick={() => {
                selectionPin.current = "";
                setDraftFilters((old) => ({ ...old, status: "" }));
                setFilters((old) => ({ ...old, status: "" }));
              }}
              aria-pressed={!filters.status}
            >
              全部项目
            </button>
          </div>
          <div className="stages">
            {overview?.stages.map((item) => (
              <button
                key={item.status}
                className={`stage ${item.status === "pending_entry" ? "not-entered" : ""} ${filters.status === item.status ? "active" : ""}`}
                aria-pressed={filters.status === item.status}
                onClick={() => {
                  selectionPin.current = "";
                  setDraftFilters((old) => ({ ...old, status: item.status }));
                  setFilters((old) => ({ ...old, status: item.status }));
                }}
              >
                <span>{STATUS_LABEL[item.status]}</span>
                <strong>{item.count}</strong>
                <small>平均 {item.averageDays} 天</small>
              </button>
            ))}
          </div>
          {bottleneck && (
            <p className="bottleneck-callout" role="status">
              <strong>当前瓶颈：{STATUS_LABEL[bottleneck.status]}</strong>
              <span>平均停留 {bottleneck.averageDays} 天，建议优先核对该阶段项目。</span>
            </p>
          )}
        </section>
        <div className="workbench-grid">
          <section
            id="reminders"
            tabIndex={-1}
            className="panel reminder-panel"
            aria-labelledby="reminder-title"
          >
            <div className="panel-head">
              <div>
                <h2 id="reminder-title">
                  项目提醒快速处理 {overview?.reminderTotal ?? 0}
                </h2>
                <p>优先显示最接近当前时间的提醒</p>
              </div>
              <button
                className="text-action"
                onClick={() => {
                  selectionPin.current = "";
                  setDraftFilters((old) => ({ ...old, reminder: "any" }));
                  setFilters((old) => ({ ...old, reminder: "any" }));
                }}
              >
                查看全部
              </button>
            </div>
            <div className="reminder-list">
              {overview?.reminderPreview.map((item) => (
                <button
                  key={item.projectId}
                  onClick={() => selectReminder(item)}
                >
                  <span
                    className={`due due-${item.reminderDueClass ?? "note"}`}
                  >
                    {item.reminderDueClass === "overdue"
                      ? "已逾期"
                      : item.reminderDueClass === "today"
                        ? "今日"
                        : item.reminderDueClass === "upcoming"
                          ? "临期"
                          : "备注"}
                  </span>
                  <strong>{item.customerName}</strong>
                  <small>{item.ecc ?? item.tempNo}</small>
                  <p>{item.reminderNote || "查看提醒时间"}</p>
                </button>
              ))}
            </div>
          </section>
          <ProjectContext
            project={selected}
            detail={detail}
            loading={loading.detail}
            onQuick={() => setLayer({ kind: "quick" })}
            onReminder={() => setLayer({ kind: "reminder" })}
            onCancel={() => setLayer({ kind: "cancel" })}
            onStatus={(status) =>
              void mutate(
                { op: "adjust_status", projectId: selectedId, status },
                "项目主状态已通过生命周期校验并更新",
              )
            }
          />
        </div>
        <section
          id="project-queue"
          tabIndex={-1}
          className="panel queue"
          aria-labelledby="queue-title"
        >
          <div className="panel-head queue-heading">
            <div>
              <h2 id="queue-title">高密项目队列 {projectPage?.total ?? 0}</h2>
              <p>服务端 keyset 分页 · 每页最多 {PAGE_SIZE} 项</p>
            </div>
            <span className="queue-range" aria-live="polite">
              {notice}
            </span>
          </div>
          <form className="queue-filters" onSubmit={applyFilters}>
            <label>
              主状态
              <select
                value={draftFilters.status}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    status: event.target.value as ProjectStatus | "",
                  }))
                }
              >
                <option value="">全部状态</option>
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              提醒
              <select
                value={draftFilters.reminder}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    reminder: event.target.value as Filters["reminder"],
                  }))
                }
              >
                <option value="">全部项目</option>
                <option value="any">有提醒</option>
                <option value="overdue">已逾期</option>
                <option value="today">今日到期</option>
                <option value="upcoming">临期</option>
              </select>
            </label>
            <label>
              区域
              <input
                value={draftFilters.region}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    region: event.target.value,
                  }))
                }
              />
            </label>
            <label className="queue-query">
              查找项目
              <input
                type="search"
                placeholder="客户名称 / ECC / 临时编号"
                value={draftFilters.query}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    query: event.target.value,
                  }))
                }
              />
            </label>
            <button className="button primary">筛选</button>
            <button className="button" type="button" onClick={resetFilters}>
              清除
            </button>
          </form>
          <div className="queue-table-wrap" aria-busy={loading.projects}>
            <table className="project-table" role="grid" aria-label="项目队列">
              <thead>
                <tr>
                  <th>客户 / ECC</th>
                  <th>主状态</th>
                  <th>区域</th>
                  <th>提醒</th>
                  <th>批次 / 仪器</th>
                  <th>累计掉票</th>
                  <th>更新时间</th>
                  <th>就近录入</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {projectPage?.projects.map((project, index) => (
                  <tr
                    key={project.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(project.id, node);
                      else rowRefs.current.delete(project.id);
                    }}
                    className={`project-status-${project.status.replaceAll("_", "-")}`}
                    tabIndex={project.id === selectedId ? 0 : -1}
                    aria-selected={project.id === selectedId}
                    onFocus={() => {
                      selectionPin.current = "";
                      setSelectedId(project.id);
                    }}
                    onClick={() => {
                      selectionPin.current = "";
                      setSelectedId(project.id);
                    }}
                    onKeyDown={(event) => queueKey(event, index)}
                  >
                    <td>
                      <strong>{project.customerName}</strong>
                      <small>{project.ecc ?? project.tempNo}</small>
                      {!project.formallyEntered && <em>未进单</em>}
                      {project.preEntryExecution && (
                        <em className="warning">未进单先执行</em>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={project.status} />
                    </td>
                    <td>{project.region || "待补"}</td>
                    <td>
                      {project.reminderAt
                        ? new Date(project.reminderAt).toLocaleString("zh-CN")
                        : project.reminderNote || "—"}
                    </td>
                    <td>
                      {project.counts.batches} / {project.counts.instruments}
                    </td>
                    <td>{money(project.invoicedAmount)}</td>
                    <td>
                      {new Date(project.updatedAt).toLocaleDateString("zh-CN")}
                    </td>
                    <td>
                      <button
                        className="text-action row-quick-action"
                        aria-label={`为${project.customerName}快速记录`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(project.id);
                          setLayer({ kind: "quick" });
                        }}
                      >
                        记录
                      </button>
                    </td>
                    <td>
                      <button
                        className="text-action row-quick-action"
                        aria-label={`查看${project.customerName}详情`}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectionPin.current = "";
                          setSelectedId(project.id);
                        }}
                      >
                        查看详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {projectPage?.projects.length === 0 && (
              <Empty
                title="没有符合条件的项目"
                copy="调整阶段、提醒、区域或查找条件。"
              />
            )}
          </div>
          <div className="queue-pagination">
            <button
              className="button"
              disabled={cursorStack.length <= 1 || loading.projects}
              onClick={() => void previousProjectPage()}
            >
              上一页
            </button>
            <span>
              第 {projectPage?.total ? currentPageIndex * PAGE_SIZE + 1 : 0}–
              {Math.min(
                (currentPageIndex + 1) * PAGE_SIZE,
                projectPage?.total ?? 0,
              )}{" "}
              项 / 共 {projectPage?.total ?? 0} 项
            </span>
            <button
              className="button"
              disabled={!projectPage?.nextCursor || loading.projects}
              onClick={() => void nextProjectPage()}
            >
              下一页
            </button>
          </div>
        </section>
        <ProjectDetails
          project={selected}
          detail={detail}
          tab={tab}
          section={sectionPage}
          loading={loading.detail || loading.section}
          error={detailError}
          pageIndex={currentSectionIndex}
          onTab={setTab}
          onRetry={() => {
            if (!selectedId) return;
            const kind = TAB_SECTION[tab];
            if (kind)
              void loadSection(selectedId, kind, sectionCursors.at(-1) ?? null);
            else void loadDetail(selectedId);
          }}
          onAction={(action) => setLayer({ kind: "action", action })}
          onNext={() => {
            if (!sectionPage?.nextCursor || !selectedId) return;
            const next = [...sectionCursors, sectionPage.nextCursor];
            setSectionCursors(next);
            void loadSection(
              selectedId,
              TAB_SECTION[tab]!,
              sectionPage.nextCursor,
            );
          }}
          onPrevious={() => {
            if (sectionCursors.length <= 1 || !selectedId) return;
            const next = sectionCursors.slice(0, -1);
            setSectionCursors(next);
            void loadSection(
              selectedId,
              TAB_SECTION[tab]!,
              next.at(-1) ?? null,
            );
          }}
          onInvoiceEdit={(invoice) =>
            setLayer({ kind: "invoice-edit", invoice })
          }
          onInvoiceRevoke={(invoice) =>
            setLayer({ kind: "invoice-revoke", invoice })
          }
        />
      </main>
      {toast && <div className="toast success" role="status">{toast}</div>}
      {layer && (
        <Layer
          title={layerTitle(layer)}
          description={layerDescription(layer, selected)}
          side={layer.kind === "independent" || layer.kind === "report"}
          onClose={() => setLayer(null)}
        >
          {layer.kind === "new" ? (
            <ProjectCreateForm
              onSave={(payload) =>
                mutate({ op: "create_project", payload }, "搬迁项目已创建")
              }
            />
          ) : layer.kind === "quick" ? (
            <QuickMenu
              onChoose={(action) => setLayer({ kind: "action", action })}
            />
          ) : layer.kind === "action" && selected ? (
            <ActionFormV2
              type={layer.action}
              project={selected}
              onSave={(action) =>
                mutate(
                  { op: "submit_action", projectId: selected.id, action },
                  "业务记录已保存",
                )
              }
              onCompleteShipTo={(requestId, accountId) =>
                mutate(
                  { op: "ship_to_complete", requestId, accountId },
                  "Ship-to 申请已完成",
                )
              }
            />
          ) : layer.kind === "reminder" && selected ? (
            <ReminderFormV2
              project={selected}
              onSave={(at, note) =>
                mutate(
                  {
                    op: "set_reminder",
                    projectId: selected.id,
                    reminderAt: at,
                    reminderNote: note,
                  },
                  "项目提醒已保存",
                )
              }
              onClear={() =>
                mutate(
                  { op: "clear_reminder", projectId: selected.id },
                  "项目提醒已清除",
                )
              }
            />
          ) : layer.kind === "cancel" && selected ? (
            <CancelFormV2
              project={selected}
              onSave={(time, reason) =>
                mutate(
                  {
                    op: "cancel_project",
                    projectId: selected.id,
                    time,
                    reason,
                  },
                  "项目已取消",
                )
              }
            />
          ) : layer.kind === "independent" ? (
            <IndependentModuleV2
              kind={layer.module}
              project={selected}
              refreshToken={independentRefresh}
              onSave={(action) =>
                mutate(
                  { op: "submit_action", projectId: action.projectId, action },
                  "记录已保存",
                )
              }
            />
          ) : layer.kind === "invoice-edit" ? (
            <InvoiceMutationForm
              mode="edit"
              invoice={layer.invoice}
              onSave={(values) =>
                mutate(
                  {
                    op: "invoice_edit",
                    invoiceId: layer.invoice.id,
                    invoicedAt: values.time,
                    amount: values.amount,
                  },
                  "掉票已更新",
                )
              }
            />
          ) : layer.kind === "invoice-revoke" ? (
            <InvoiceMutationForm
              mode="revoke"
              invoice={layer.invoice}
              onSave={(values) =>
                mutate(
                  {
                    op: "invoice_revoke",
                    invoiceId: layer.invoice.id,
                    time: values.time,
                    reason: values.reason,
                  },
                  "掉票已撤销",
                )
              }
            />
          ) : layer.kind === "report" ? (
            <ReportPanelV2 />
          ) : null}
        </Layer>
      )}
    </div>
  );
}

function ProjectContext({
  project,
  detail,
  loading,
  onQuick,
  onReminder,
  onCancel,
  onStatus,
}: {
  project: WorkbenchProjectRow | null;
  detail: WorkbenchV2ProjectDetailDto | null;
  loading: boolean;
  onQuick: () => void;
  onReminder: () => void;
  onCancel: () => void;
  onStatus: (status: AdjustableProjectStatus) => void;
}): JSX.Element {
  if (!project)
    return (
      <aside className="panel context">
        <Empty title="未选择项目" copy="从项目队列选择一行查看当前上下文。" />
      </aside>
    );
  return (
    <aside
      className={`panel context ${project.formallyEntered ? "entered" : "not-entered"}`}
      aria-label="当前上下文"
      aria-busy={loading}
    >
      <div className="context-head">
        <span>当前上下文 · {project.region || "区域待补"}</span>
        <h2>{project.customerName}</h2>
        <p>{project.ecc || project.tempNo}</p>
        <div className="row-actions">
          <button className="button primary small" onClick={onQuick}>
            快速记录
          </button>
          <button className="button small" onClick={onReminder}>
            维护提醒
          </button>
        </div>
      </div>
      <div className="context-section">
        <h3>状态与辨识</h3>
        <div className="tag-row">
          <StatusBadge status={project.status} />
          <span
            className={`entry-badge ${project.formallyEntered ? "entered" : "not-entered"}`}
          >
            {project.formallyEntered ? "已进单" : "未进单"}
          </span>
          {project.preEntryExecution && (
            <span className="tag warning">未进单先执行</span>
          )}
          {project.nonBlocking.pendingShipTo > 0 && (
            <span className="tag neutral">Ship-to 待处理 {project.nonBlocking.pendingShipTo}</span>
          )}
          {project.nonBlocking.qrUnmarked > 0 && (
            <span className="tag neutral">二维码待标记 {project.nonBlocking.qrUnmarked}</span>
          )}
          {project.nonBlocking.repairs > 0 && (
            <span className="tag warning">损坏/维修 {project.nonBlocking.repairs}</span>
          )}
        </div>
        <div className="status-adjust">
          <label htmlFor="context-status-v2">人工调整主状态</label>
          <select id="context-status-v2" defaultValue={project.status}>
            {STAGES.map((status) => (
              <option value={status} key={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          <button
            className="button small"
            onClick={(event) =>
              onStatus(
                (
                  event.currentTarget
                    .previousElementSibling as HTMLSelectElement
                ).value as AdjustableProjectStatus,
              )
            }
          >
            提交校验
          </button>
        </div>
        {project.status !== "cancelled" && (
          <div className="cancel-entry">
            <button className="button danger small" onClick={onCancel}>
              取消项目
            </button>
            <small>取消为终态，须记录时间与原因。</small>
          </div>
        )}
      </div>
      <div className="context-section">
        <h3>当前项目提醒</h3>
        <strong>
          {project.reminderAt
            ? new Date(project.reminderAt).toLocaleString("zh-CN")
            : "未设置提醒时间"}
        </strong>
        <p>{project.reminderNote || "暂无提醒备注"}</p>
      </div>
      <div className="context-section context-money" aria-label="金额闭环">
        <h3>金额闭环</h3>
        <dl>
          <div><dt>最终可确认</dt><dd>{money(project.finalAmount)}</dd></div>
          <div><dt>累计掉票</dt><dd>{money(project.invoicedAmount)}</dd></div>
          <div><dt>待掉票</dt><dd>{money(decimalOf(centsOf(project.finalAmount) > centsOf(project.invoicedAmount) ? centsOf(project.finalAmount) - centsOf(project.invoicedAmount) : 0n))}</dd></div>
        </dl>
      </div>
      <div className="context-section">
        <h3>执行联系</h3>
        <p>
          {detail?.detail?.oldSiteContact || "旧址联系人待补"} ·{" "}
          {detail?.detail?.newSiteContact || "新址联系人待补"}
        </p>
      </div>
    </aside>
  );
}

function ProjectDetails({
  project,
  detail,
  tab,
  section,
  loading,
  error,
  pageIndex,
  onTab,
  onRetry,
  onAction,
  onNext,
  onPrevious,
  onInvoiceEdit,
  onInvoiceRevoke,
}: {
  project: WorkbenchProjectRow | null;
  detail: WorkbenchV2ProjectDetailDto | null;
  tab: DetailTab;
  section: WorkbenchV2SectionPageDto | null;
  loading: boolean;
  error: string;
  pageIndex: number;
  onTab: (tab: DetailTab) => void;
  onRetry: () => void;
  onAction: (action: WorkbenchActionType) => void;
  onNext: () => void;
  onPrevious: () => void;
  onInvoiceEdit: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
  onInvoiceRevoke: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
}): JSX.Element {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const action: Partial<Record<DetailTab, WorkbenchActionType>> = {
    搬迁仪器: "instrument",
    搬迁批次: "batch",
    上门活动: "visit",
    费用与掉票: "invoice",
    申请与维修: "damage",
  };
  return (
    <section
      className="panel detail"
      aria-labelledby="detail-title"
      aria-busy={loading}
    >
      <div className="detail-head">
        <div>
          <p className="overline">项目详情</p>
          <h2 id="detail-title">
            {project?.customerName || "未选择项目"}
          </h2>
          <span>
            {project
              ? `${project.ecc || project.tempNo} · ${project.region || "区域待补"}`
              : "从项目队列选择一行，或点击项目提醒跳转对应项目"}
          </span>
        </div>
        {project && (
          <div className="detail-money">
            <div>
              <span>合同 USD 含税金额</span>
              <strong>{money(project.contractAmount)}</strong>
            </div>
            <div>
              <span>最终可确认金额</span>
              <strong>{money(project.finalAmount)}</strong>
            </div>
            <div>
              <span>累计掉票</span>
              <strong>{money(project.invoicedAmount)}</strong>
            </div>
          </div>
        )}
      </div>
      {project && (
        <div className="tabbar">
          <div role="tablist" aria-label="项目详情">
            {TABS.map((item, index) => (
              <button
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                role="tab"
                aria-selected={tab === item}
                aria-controls="project-detail-panel"
                tabIndex={tab === item ? 0 : -1}
                key={item}
                onClick={() => onTab(item)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : event.key === "ArrowRight"
                          ? (index + 1) % TABS.length
                          : (index - 1 + TABS.length) % TABS.length;
                  onTab(TABS[next]!);
                  tabRefs.current[next]?.focus();
                }}
              >
                {item}
              </button>
            ))}
          </div>
          {action[tab] && (
            <button
              className="button small"
              onClick={() => onAction(action[tab]!)}
            >
              就近记录
            </button>
          )}
        </div>
      )}
      <div id="project-detail-panel" className="detail-body" role="tabpanel">
        {error ? (
          <div className="page-error" role="alert">
            {error}
            <button onClick={onRetry}>重试详情</button>
          </div>
        ) : !project ? (
          <Empty
            title="未选择项目"
            copy="从项目队列选择一行，或点击项目提醒跳转对应项目。"
          />
        ) : loading ? (
          <div className="detail-loading" role="status">
            正在读取当前项目数据…
          </div>
        ) : tab === "项目总览" ? (
          <div className="fact-grid">
            {[
              ["主状态", STATUS_LABEL[project.status]],
              [
                "进单时间",
                project.entryAt
                  ? new Date(project.entryAt).toLocaleString("zh-CN")
                  : "待进单",
              ],
              ["所属区域", project.region || "待补"],
              ["合同开始日期", detail?.detail?.contractStartDate || "待补"],
              ["合同截止日期", detail?.detail?.contractEndDate || "待补"],
              ["搬迁批次", `${project.counts.batches} 个`],
              ["搬迁仪器", `${project.counts.instruments} 台`],
              ["上门活动", `${project.counts.activities} 次`],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        ) : (
          <SectionTable
            page={section}
            onInvoiceEdit={onInvoiceEdit}
            onInvoiceRevoke={onInvoiceRevoke}
          />
        )}
      </div>
      {project && tab !== "项目总览" && (
        <div className="section-pagination">
          <button
            className="button"
            disabled={pageIndex === 0}
            onClick={onPrevious}
          >
            上一页
          </button>
          <span>
            第 {section?.total ? pageIndex * PAGE_SIZE + 1 : 0}–
            {Math.min((pageIndex + 1) * PAGE_SIZE, section?.total ?? 0)} 条 / 共{" "}
            {section?.total ?? 0} 条
          </span>
          <button
            className="button"
            disabled={!section?.nextCursor}
            onClick={onNext}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

function SectionTable({
  page,
  onInvoiceEdit,
  onInvoiceRevoke,
}: {
  page: WorkbenchV2SectionPageDto | null;
  onInvoiceEdit: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
  onInvoiceRevoke: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
}): JSX.Element {
  if (!page?.rows.length)
    return <Empty title="暂无记录" copy="通过就近记录入口新增业务事实。" />;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {sectionColumns(page.kind).map((column) => (
              <th key={column}>{columnLabel(column)}</th>
            ))}
            {page.kind === "invoices" && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr key={row.id}>
              {sectionColumns(page.kind).map((column) => (
                <td key={column}>
                  {formatCell(
                    column,
                    (row as unknown as Record<string, unknown>)[column],
                  )}
                </td>
              ))}
              {row.kind === "invoices" && (
                <td>
                  {row.active ? (
                    <div className="row-actions">
                      <button
                        className="button small"
                        onClick={() => onInvoiceEdit(row)}
                      >
                        编辑
                      </button>
                      <button
                        className="button danger small"
                        onClick={() => onInvoiceRevoke(row)}
                      >
                        撤销
                      </button>
                    </div>
                  ) : (
                    <span className="terminal-note">终态 · 更正请新增</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sectionColumns(kind: WorkbenchV2SectionKind): string[] {
  return kind === "instruments"
    ? ["name", "model", "serialNo", "batchId", "ups", "qrRequested"]
    : kind === "batches"
      ? [
          "planTransportDate",
          "transportCompany",
          "originalPrice",
          "discountedPrice",
          "startedAt",
        ]
      : kind === "activities"
        ? ["visitAt", "engineers"]
        : kind === "invoices"
          ? ["invoicedAt", "amount", "active", "revokedAt"]
          : kind === "damage_items"
            ? [
                "instrumentName",
                "serialNo",
                "damageReason",
                "issueStatus",
                "partNumber",
                "partAmount",
                "partStatus",
              ]
            : ["serviceOrderNo", "orderType", "orderedAt", "engineer"];
}
function columnLabel(key: string): string {
  return (
    (
      {
        name: "仪器名称",
        model: "型号",
        serialNo: "序列号",
        batchId: "搬迁批次",
        ups: "UPS",
        qrRequested: "二维码是否申请",
        planTransportDate: "计划运输日期",
        transportCompany: "运输公司",
        originalPrice: "预算价格",
        discountedPrice: "成交价格",
        startedAt: "运输开始时间",
        visitAt: "到访时间",
        engineers: "参与工程师",
        invoicedAt: "掉票时间",
        amount: "金额",
        active: "状态",
        revokedAt: "撤销时间",
        instrumentName: "仪器名称",
        damageReason: "损坏原因",
        issueStatus: "事项状态",
        partNumber: "备件号",
        partAmount: "备件金额",
        partStatus: "备件状态",
        serviceOrderNo: "服务单号",
        orderType: "开单类型",
        orderedAt: "开单时间",
        engineer: "工程师",
      } as Record<string, string>
    )[key] || key
  );
}
function formatCell(column: string, value: unknown): string {
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (column === "amount") return money(String(value));
  return String(value);
}

function QuickMenu({
  onChoose,
}: {
  onChoose: (type: WorkbenchActionType) => void;
}): JSX.Element {
  return (
    <div>
      <p className="notice">
        十类项目动作均写入当前项目。序列号地址更新与二维码申请位于独立导航。
      </p>
      <div className="quick-grid">
        {ACTIONS.map((action) => (
          <button key={action.type} onClick={() => onChoose(action.type)}>
            <strong>{action.label}</strong>
            <span>{action.help}</span>
            <em>继续录入</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function ActionFormV2({
  type,
  project,
  onSave,
  onCompleteShipTo,
}: {
  type: WorkbenchActionType;
  project: WorkbenchProjectRow;
  onSave: (action: WorkbenchActionPayload) => Promise<void>;
  onCompleteShipTo: (requestId: string, accountId: string) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const submitLock = useRef(false);
  const optionKind: WorkbenchV2SectionKind | null = [
    "visit",
    "damage",
  ].includes(type)
    ? "instruments"
    : type === "logistics"
      ? "batches"
      : null;
  const [optionId, setOptionId] = useState("");
  const [shipTo, setShipTo] = useState<Extract<
    WorkbenchV2LookupRow,
    { kind: "ship_to_requests" }
  > | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitLock.current) return;
    submitLock.current = true;
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const values: WorkbenchActionPayload["values"] = {};
    data.forEach((value, key) => {
      if (key === "workTypes" || key === "instrumentIds") {
        const current = values[key];
        values[key] = [
          ...(Array.isArray(current) ? current : []),
          String(value),
        ];
      } else values[key] = String(value);
    });
    if (optionKind === "instruments" && optionId) {
      values.instrumentId = optionId;
      values.instrumentIds = [optionId];
    }
    if (optionKind === "batches" && optionId) values.batchId = optionId;
    for (const key of ["ups", "qrRequested"])
      values[key] = data.get(key) === "true";
    try {
      if (type === "ship_to" && shipTo)
        await onCompleteShipTo(shipTo.id, String(values.accountId || ""));
      else await onSave({ type, projectId: project.id, values });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      onChange={(event) => {
        if (type !== "logistics") return;
        const data = new FormData(event.currentTarget);
        try {
          const budget = String(data.get("budgetPrice") || "");
          const deal = String(data.get("dealPrice") || "");
          setWarning(budget && deal && centsOf(deal) > centsOf(budget) ? "成交价格高于预算价格，可以保存，请确认差额。" : "");
        } catch {
          setWarning("");
        }
      }}
    >
      <p className="notice">
        {ACTIONS.find((action) => action.type === type)?.help}
        。选项按当前项目分页读取，不加载全量记录。
      </p>
      <div className="form-grid">
        {optionKind && (
          <BoundedSectionPicker
            projectId={project.id}
            kind={optionKind}
            value={optionId}
            onChange={setOptionId}
            required
          />
        )}
        {type === "ship_to" && (
          <BoundedShipToPicker value={shipTo?.id || ""} onChange={setShipTo} />
        )}
        {actionFields(type, project, shipTo)}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {warning && <div className="inline-warning" role="status">{warning}</div>}
      <div className="form-footer">
        <span>保存后仅刷新受影响的项目和当前详情</span>
        <button className="button primary" disabled={busy}>
          {busy ? "正在保存…" : "保存记录"}
        </button>
      </div>
    </form>
  );
}

function actionFields(
  type: WorkbenchActionType,
  project: WorkbenchProjectRow,
  shipTo: Extract<
    WorkbenchV2LookupRow,
    { kind: "ship_to_requests" }
  > | null = null,
): ReactNode {
  if (type === "batch")
    return (
      <>
        <Field
          name="planTransportDate"
          label="计划运输日期"
          type="date"
          required
          autoFocus
        />
        <Field name="transportCompany" label="运输公司" optional />
        <Field
          name="originalPrice"
          label="人民币原价"
          type="number"
          step="0.01"
          optional
        />
        <Field
          name="discountedPrice"
          label="人民币折后价"
          type="number"
          step="0.01"
          optional
          help="成交价格高于预算价格时会提示确认，但仍允许记录。"
        />
      </>
    );
  if (type === "instrument")
    return (
      <>
        <Field name="name" label="仪器名称" required autoFocus />
        <Field name="model" label="型号" optional />
        <Field name="serialNo" label="序列号" optional help="无序列号时可先占位；同一搬迁项目内非空序列号不得重复。" />
        <Select
          name="ups"
          label="UPS"
          required
          options={[
            ["false", "否"],
            ["true", "是"],
          ]}
        />
        <Select
          name="qrRequested"
          label="二维码是否申请"
          required
          help="由负责人按仪器手工标记，不保存二维码地址。"
          options={[
            ["false", "否"],
            ["true", "是"],
          ]}
        />
      </>
    );
  if (type === "visit")
    return (
      <>
        <Field
          name="visitAt"
          label="到访时间"
          type="datetime-local"
          autoFocus
          optional
        />
        <Field name="engineers" label="参与工程师" required />
        <Select
          name="status"
          label="工作事实状态"
          required
          options={[
            ["in_progress", "进行中"],
            ["done", "已完成"],
          ]}
        />
        <div className="field full" role="group" aria-labelledby="v2-work-types-label">
          <span className="field-label" id="v2-work-types-label">
            工作类型 <b>必填</b>
          </span>
          <div className="choice-grid">
            {[
              ["teardown", "拆机"],
              ["install", "装机"],
              ["repair", "维修"],
              ["other", "其他"],
            ].map(([value, label], index) => (
              <label key={value}>
                <input type="checkbox" name="workTypes" value={value} defaultChecked={index === 0} />
                {label}
              </label>
            ))}
          </div>
        </div>
      </>
    );
  if (type === "order")
    return (
      <>
        <Select
          name="orderType"
          label="开单类型"
          options={[
            ["relocation", "搬迁"],
            ["certification", "认证"],
            ["parts_by_mail", "单寄备件"],
            ["pm", "PM"],
          ]}
        />
        <Field name="serviceOrderNo" label="服务单号" required help="保存时会同次创建开单记录，并关联下方工程师。" />
        <Field
          name="orderedAt"
          label="开单时间"
          type="datetime-local"
          required
        />
        <Field name="engineer" label="工程师" required help="填写服务单号时必须在同一次保存中填写执行工程师。" />
        <Field
          name="customerName"
          label="客户单位"
          defaultValue={project.customerName}
          required
        />
      </>
    );
  if (type === "logistics")
    return (
      <>
        <Field
          name="appliedAt"
          label="物流费用申请时间"
          type="datetime-local"
          required
        />
        <Field
          name="budgetPrice"
          label="预算价格（RMB）"
          type="number"
          step="0.01"
          min="0.01"
          required
          help="三项价格均按人民币记录，必须大于 0。"
        />
        <Field
          name="dealPrice"
          label="成交价格（RMB）"
          type="number"
          step="0.01"
          min="0.01"
          required
        />
        <Field
          name="logisticsCost"
          label="物流费用（RMB）"
          type="number"
          step="0.01"
          min="0.01"
          required
        />
      </>
    );
  if (type === "acceptance")
    return (
      <Field
        name="reportDate"
        label="验收报告形成日期"
        type="date"
        required
        autoFocus
      />
    );
  if (type === "invoice")
    return (
      <>
        <Field
          name="invoicedAt"
          label="掉票时间"
          type="datetime-local"
          required
          autoFocus
        />
        <Field
          name="amount"
          label="掉票金额（USD）"
          type="number"
          step="0.01"
          required
        />
      </>
    );
  if (type === "ship_to")
    return (
      <>
        <Field
          key={`customer-${shipTo?.id || "new"}`}
          name="customerName"
          label="客户名称"
          defaultValue={shipTo?.customerName || project.customerName}
          required
          autoFocus
          disabled={Boolean(shipTo)}
        />
        <Field
          key={`address-${shipTo?.id || "new"}`}
          name="newSiteAddress"
          label="新址地址"
          defaultValue={shipTo?.newSiteAddress || ""}
          required
          disabled={Boolean(shipTo)}
        />
        {!shipTo && (
          <Select
            name="status"
            label="推进到"
            options={[
              ["pending_submit", "待提交"],
              ["processing", "处理中"],
              ["completed", "已完成"],
            ]}
          />
        )}
        <Field
          name="accountId"
          label="Account ID"
          defaultValue={shipTo?.accountId || ""}
          required={Boolean(shipTo)}
        />
      </>
    );
  if (type === "damage")
    return (
      <>
        <Field name="damageReason" label="损坏原因" required help="一个事项只对应一个备件；多个备件请分别建立事项。" />
        <Field name="partNumber" label="备件号" required />
        <Field
          name="partQuantity"
          label="数量"
          type="number"
          min="1"
          required
        />
        <Field
          name="partAmount"
          label="备件金额"
          type="number"
          step="0.01"
          min="0.01"
          required
          help="仅备件状态为“已使用”时计入维修费用；合同金额为 0 时占比不可计算。"
        />
        <Select
          name="partCurrency"
          label="币种"
          options={[
            ["RMB", "RMB"],
            ["USD", "USD"],
          ]}
        />
        <Select
          name="partStatus"
          label="备件状态"
          options={[
            ["pending_submit", "待提交"],
            ["processing", "处理中"],
            ["arrived", "已到件"],
            ["used", "已使用"],
          ]}
        />
        <Select
          name="issueStatus"
          label="事项处理状态"
          options={[
            ["untreated", "未处理"],
            ["repairing", "维修中"],
            ["repaired", "已修复"],
            ["closed_unrepaired", "未修复关闭"],
          ]}
        />
        <Field
          name="registeredAt"
          label="登记时间"
          type="datetime-local"
          required
        />
      </>
    );
  return (
    <>
      <Field
        name="ecc"
        label="ECC"
        defaultValue={project.ecc || ""}
        required
        autoFocus
      />
      <Field name="entryAt" label="进单时间" type="datetime-local" required />
      <Field
        name="contractAmount"
        label="合同 USD 含税金额"
        type="number"
        step="0.01"
        help="合同金额为 0 时，正式进单须另填大于 0 的最终可确认金额。"
        required
      />
      <Field
        name="finalAmount"
        label="最终可确认金额"
        type="number"
        step="0.01"
        optional
      />
    </>
  );
}

function BoundedSectionPicker({
  projectId,
  kind,
  value,
  onChange,
  required = false,
}: {
  projectId: string;
  kind: "instruments" | "batches";
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}): JSX.Element {
  const [page, setPage] = useState<WorkbenchV2SectionPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  async function load(cursor: string | null): Promise<void> {
    const id = ++sequence.current;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2SectionPage",
      )({ projectId, kind, cursor, limit: 25 });
      if (id === sequence.current) setPage(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  useEffect(() => {
    setStack([null]);
    void load(null);
  }, [projectId, kind]);
  useEffect(() => {
    if (required && !value && page?.rows[0]) onChange(page.rows[0].id);
  }, [page, required, value]);
  return (
    <div className="field full bounded-picker">
      <label htmlFor={`v2-${kind}-picker`}>
        {kind === "instruments" ? "搬迁仪器" : "搬迁批次"}{" "}
        {required && <b>必填</b>}
      </label>
      <select
        id={`v2-${kind}-picker`}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">请选择当前页记录</option>
        {page?.rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.kind === "instruments"
              ? `${row.serialNo || "无序列号"} · ${row.name}`
              : row.kind === "batches"
                ? `${row.transportCompany || "运输公司待补"} · ${row.planTransportDate || "日期待补"}`
                : row.id}
          </option>
        ))}
      </select>
      <div className="picker-pagination">
        <span>
          本页 {page?.rows.length ?? 0} / 共 {page?.total ?? 0}
        </span>
        <button
          type="button"
          disabled={stack.length <= 1}
          onClick={() => {
            const next = stack.slice(0, -1);
            setStack(next);
            void load(next.at(-1) ?? null);
          }}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!page?.nextCursor}
          onClick={() => {
            if (!page?.nextCursor) return;
            const next = [...stack, page.nextCursor];
            setStack(next);
            void load(page.nextCursor);
          }}
        >
          下一页
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function BoundedShipToPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (
    row: Extract<WorkbenchV2LookupRow, { kind: "ship_to_requests" }> | null,
  ) => void;
}): JSX.Element {
  const [page, setPage] = useState<WorkbenchV2LookupPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  async function load(cursor: string | null): Promise<void> {
    const id = ++sequence.current;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2LookupPage",
      )({
        kind: "ship_to_requests",
        query: query.trim() || null,
        cursor,
        limit: 25,
      });
      if (id === sequence.current) setPage(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  useEffect(() => {
    void load(null);
  }, []);
  const rows =
    page?.rows.filter(
      (
        row,
      ): row is Extract<WorkbenchV2LookupRow, { kind: "ship_to_requests" }> =>
        row.kind === "ship_to_requests",
    ) ?? [];
  return (
    <div className="field full bounded-picker">
      <label htmlFor="v2-ship-to-request">已有 Ship-to 申请</label>
      <div className="lookup-search">
        <input
          aria-label="查找 Ship-to 申请"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="客户名称或新址"
        />
        <button
          type="button"
          onClick={() => {
            setStack([null]);
            void load(null);
          }}
        >
          查找
        </button>
      </div>
      <select
        id="v2-ship-to-request"
        value={value}
        onChange={(event) =>
          onChange(rows.find((row) => row.id === event.target.value) ?? null)
        }
      >
        <option value="">新建申请</option>
        {rows.map((row) => (
          <option value={row.id} key={row.id}>
            {row.customerName} · {row.newSiteAddress} · {row.status}
          </option>
        ))}
      </select>
      <div className="picker-pagination">
        <span>
          本页 {rows.length} / 共 {page?.total ?? 0}
        </span>
        <button
          type="button"
          disabled={stack.length <= 1}
          onClick={() => {
            const next = stack.slice(0, -1);
            setStack(next);
            void load(next.at(-1) ?? null);
          }}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!page?.nextCursor}
          onClick={() => {
            if (!page?.nextCursor) return;
            const next = [...stack, page.nextCursor];
            setStack(next);
            void load(page.nextCursor);
          }}
        >
          下一页
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function IndependentModuleV2({
  kind,
  project,
  refreshToken,
  onSave,
}: {
  kind: WorkbenchV2IndependentKind;
  project: WorkbenchProjectRow | null;
  refreshToken: number;
  onSave: (action: WorkbenchActionPayload) => Promise<void>;
}): JSX.Element {
  const [page, setPage] = useState<WorkbenchV2IndependentPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [instrumentId, setInstrumentId] = useState("");
  const sequence = useRef(0);
  async function load(cursor: string | null): Promise<void> {
    const id = ++sequence.current;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2IndependentPage",
      )({ kind, query: query.trim() || null, limit: 50, cursor });
      if (id === sequence.current) setPage(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  useEffect(() => {
    setStack([null]);
    void load(null);
  }, [kind, refreshToken]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const values: WorkbenchActionPayload["values"] = {};
    data.forEach((value, key) => {
      if (key === "types") {
        const current = values.types;
        values.types = [
          ...(Array.isArray(current) ? current : []),
          String(value),
        ];
      } else values[key] = String(value);
    });
    if (kind === "serial_address") values.instrumentId = instrumentId;
    try {
      if (kind === "qr_request" && !Array.isArray(values.types)) {
        throw new Error("请至少选择一种二维码申请类型");
      }
      await onSave({
        type: kind,
        projectId: kind === "serial_address" ? project?.id : undefined,
        values,
      });
      await load(stack.at(-1) ?? null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="module-layout v2-independent">
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          {kind === "serial_address" ? (
            <>
              {project ? (
                <BoundedSectionPicker
                  projectId={project.id}
                  kind="instruments"
                  value={instrumentId}
                  onChange={setInstrumentId}
                  required
                />
              ) : (
                <p className="notice full">
                  请先在项目队列选择项目，再从该项目的仪器分页中选择。
                </p>
              )}
              <Field
                name="customerName"
                label="客户名称"
                defaultValue={project?.customerName || ""}
                required
              />
              <Field name="newSiteAddress" label="新址地址" required />
              <Field name="serialNo" label="序列号" required />
              <Field name="accountId" label="Account ID" required />
              <Field
                name="updatedAt"
                label="更新时间"
                type="datetime-local"
                defaultValue={localDateTime(new Date().toISOString())}
                required
              />
            </>
          ) : (
            <>
              <Field name="applicant" label="申请人" required autoFocus />
              <Field
                name="requestedAt"
                label="申请时间"
                type="datetime-local"
                defaultValue={localDateTime(new Date().toISOString())}
                required
              />
              <div className="field full" role="group" aria-labelledby="v2-qr-types-label">
                <span className="field-label" id="v2-qr-types-label">
                  申请类型 <b>必填，可多选</b>
                </span>
                <div className="choice-grid">
                  {[
                    ["A", "仪器服务"],
                    ["project_acceptance_form", "项目验收单"],
                    ["logistics_management", "物流管理"],
                  ].map(([value, label]) => (
                    <label key={value}>
                      <input type="checkbox" name="types" value={value} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-footer">
          <span>保存后仅刷新当前独立模块</span>
          <button
            className="button primary"
            disabled={busy || (kind === "serial_address" && !instrumentId)}
          >
            {busy ? "正在保存…" : "保存记录"}
          </button>
        </div>
      </form>
      <section className="module-list">
        <form
          className="module-search"
          onSubmit={(event) => {
            event.preventDefault();
            setStack([null]);
            void load(null);
          }}
        >
          <label>
            查找记录
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="button">查找</button>
        </form>
        <DataRows rows={page?.rows ?? []} />
        <div className="queue-pagination">
          <button
            className="button"
            disabled={stack.length <= 1}
            onClick={() => {
              const next = stack.slice(0, -1);
              setStack(next);
              void load(next.at(-1) ?? null);
            }}
          >
            上一页
          </button>
          <span>
            本页 {page?.rows.length ?? 0} / 共 {page?.total ?? 0}
          </span>
          <button
            className="button"
            disabled={!page?.nextCursor}
            onClick={() => {
              if (!page?.nextCursor) return;
              const next = [...stack, page.nextCursor];
              setStack(next);
              void load(page.nextCursor);
            }}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  );
}

function DataRows({
  rows,
}: {
  rows: WorkbenchV2IndependentPageDto["rows"];
}): JSX.Element {
  if (!rows.length)
    return <Empty title="暂无记录" copy="使用左侧表单新增记录。" />;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <strong>
                  {row.kind === "qr_request" ? row.applicant : row.customerName}
                </strong>
                <small>
                  {row.kind === "qr_request"
                    ? row.types.join("、")
                    : `${row.serialNo} · ${row.accountId}`}
                </small>
              </td>
              <td>
                {new Date(
                  row.kind === "qr_request" ? row.requestedAt : row.updatedAt,
                ).toLocaleString("zh-CN")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectCreateForm({
  onSave,
}: {
  onSave: (payload: ProjectWizardPayload) => Promise<void>;
}): JSX.Element {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Record<string, string>>(() => ({
    entryAt: localDateTime(new Date().toISOString()),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function collect(form: HTMLFormElement): Record<string, string> {
    const next = { ...draft };
    new FormData(form).forEach((value, key) => {
      next[key] = String(value);
    });
    setDraft(next);
    return next;
  }
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = collect(event.currentTarget);
    if (step < 4) {
      setStep((value) => value + 1);
      return;
    }
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = (submitter?.value || "formal") as ProjectWizardPayload["intent"];
    if (values.serviceOrderNo?.trim() && !values.engineers?.trim()) {
      setError("已填写服务单号，请先补齐参与工程师；项目与开单均未保存。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        intent,
        customerName: values.customerName || "",
        ecc: values.ecc,
        entryAt: values.entryAt,
        region: values.region || "",
        oldSiteContact: values.oldSiteContact,
        newSiteContact: values.newSiteContact,
        contractStartDate: values.contractStartDate || "",
        contractEndDate: values.contractEndDate || "",
        oldSiteAddress: values.oldSiteAddress || "",
        newSiteAddress: values.newSiteAddress || "",
        instrumentName: values.instrumentName || "",
        model: values.model,
        ups: values.ups === "true",
        contractAmount: values.contractAmount,
        finalAmount: values.finalAmount,
        planVisitAt: values.planVisitAt,
        planTransportAt: values.planTransportAt,
        siteConfirmed: values.siteConfirmed === "on",
        actualInstallDoneAt: values.actualInstallDoneAt,
        serviceOrderNo: values.serviceOrderNo,
        engineers: values.engineers,
        serviceOrderNote: values.serviceOrderNote,
        approvalReason: values.approvalReason,
        missingItems: values.missingItems,
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <p className="notice">标记“可后补”的字段可暂时留空；选择正式进单时仍会按业务条件完整校验。</p>
      <div className="wizard-steps" aria-label="新建搬迁项目步骤">
        {["基本信息", "搬迁范围", "执行准备", "确认方式"].map(
          (label, index) => (
            <div
              className={
                step === index + 1 ? "active" : step > index + 1 ? "done" : ""
              }
              key={label}
            >
              <span>步骤 {index + 1}</span>
              <strong>{label}</strong>
            </div>
          ),
        )}
      </div>
      <div className="form-grid" key={step}>
        {step === 1 ? (
          <>
            <Field
              name="customerName"
              label="客户名称"
              defaultValue={draft.customerName}
              required
              autoFocus
            />
            <Field
              name="region"
              label="区域"
              defaultValue={draft.region}
              required
            />
            <Field
              name="entryAt"
              label="进单时间"
              type="datetime-local"
              defaultValue={draft.entryAt}
              optional
              help="正式进单统计口径；默认当前时间，可补录或修正，待进单时可留空。"
            />
            <Field name="oldSiteContact" label="旧址联系人" defaultValue={draft.oldSiteContact} optional />
            <Field name="newSiteContact" label="新址联系人" defaultValue={draft.newSiteContact} optional />
            <Field
              name="contractAmount"
              label="合同 USD 含税金额"
              type="number"
              step="any"
              defaultValue={draft.contractAmount}
              optional
              help="仅合同 USD 含税金额允许为 0；正式进单且金额为 0 时须补最终可确认金额。"
            />
            <Field
              name="contractStartDate"
              label="合同开始日期"
              type="date"
              defaultValue={draft.contractStartDate}
              required
            />
            <Field
              name="contractEndDate"
              label="合同截止日期"
              type="date"
              defaultValue={draft.contractEndDate}
              required
            />
          </>
        ) : step === 2 ? (
          <>
            <Field
              name="oldSiteAddress"
              label="旧址地址"
              defaultValue={draft.oldSiteAddress}
              required
            />
            <Field
              name="newSiteAddress"
              label="新址地址"
              defaultValue={draft.newSiteAddress}
              required
            />
            <Field
              name="instrumentName"
              label="仪器名称"
              defaultValue={draft.instrumentName}
              required
            />
            <Field name="model" label="型号" defaultValue={draft.model} optional />
            <Select
              name="ups"
              label="UPS"
              defaultValue={draft.ups || "false"}
              options={[
                ["false", "否"],
                ["true", "是"],
              ]}
            />
          </>
        ) : step === 3 ? (
          <>
            <Field
              name="planVisitAt"
              label="计划上门时间"
              type="datetime-local"
              defaultValue={draft.planVisitAt}
              optional
            />
            <Field
              name="planTransportAt"
              label="计划运输时间"
              type="datetime-local"
              defaultValue={draft.planTransportAt}
              optional
            />
            <Field
              name="actualInstallDoneAt"
              label="实际装机完成时间"
              type="datetime-local"
              defaultValue={draft.actualInstallDoneAt}
              optional
            />
            <label className="confirm-check full">
              <input
                name="siteConfirmed"
                type="checkbox"
                defaultChecked={draft.siteConfirmed === "on"}
              />
              现场条件已确认
            </label>
            <Field
              name="serviceOrderNo"
              label="服务单号"
              defaultValue={draft.serviceOrderNo}
              optional
              help="填写后参与工程师必填；项目与搬迁开单将同次创建。"
            />
            <Field
              name="engineers"
              label="参与工程师"
              defaultValue={draft.engineers}
              optional
              help="填写服务单号时必须补齐，可填写多名工程师。"
            />
            <TextArea
              name="serviceOrderNote"
              label="开单备注"
              defaultValue={draft.serviceOrderNote}
              optional
              help="可后补；开单时间默认当前时间。"
            />
          </>
        ) : (
          <div className="wizard-review full">
            <div className="wizard-section-head">
              <div>
                <h3 id="wizard-summary-title">录入摘要</h3>
                <p>提交前核对本次项目、执行准备与开单信息。</p>
              </div>
              <span>第 4 步 / 共 4 步</span>
            </div>
            <dl className="summary-grid" aria-labelledby="wizard-summary-title">
              {[
                ["客户 / 区域", `${draft.customerName || "待补"} / ${draft.region || "待补"}`],
                ["进单时间", draft.entryAt || "待进单时可留空"],
                ["旧址 / 新址联系人", `${draft.oldSiteContact || "待补"} / ${draft.newSiteContact || "待补"}`],
                ["合同日期", `${draft.contractStartDate || "待补"} 至 ${draft.contractEndDate || "待补"}`],
                ["搬迁地址", `${draft.oldSiteAddress || "待补"} → ${draft.newSiteAddress || "待补"}`],
                ["搬迁仪器", `${draft.instrumentName || "待补"}${draft.model ? ` · ${draft.model}` : ""} · UPS ${draft.ups === "true" ? "是" : "否"}`],
                ["计划安排", `上门 ${draft.planVisitAt || "待补"} · 运输 ${draft.planTransportAt || "待补"}`],
                ["实际装机完成", draft.actualInstallDoneAt || "未记录"],
                ["场地确认", draft.siteConfirmed === "on" ? "已确认" : "未确认"],
                ["服务单", draft.serviceOrderNo ? `${draft.serviceOrderNo} · ${draft.engineers || "缺工程师"}` : "未填写，不创建开单"],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="confirm-fields form-grid" aria-label="确认方式补充资料">
              <Field name="ecc" label="ECC" defaultValue={draft.ecc} optional help="正式进单前必须补齐 ECC。" />
              <Field name="finalAmount" label="最终可确认金额（USD）" type="number" step="0.01" defaultValue={draft.finalAmount} optional />
              <Field name="approvalReason" label="经理批复原因" defaultValue={draft.approvalReason} optional />
              <Field name="missingItems" label="缺失资料" defaultValue={draft.missingItems} optional />
            </div>
            <div className="save-paths" aria-label="保存路径">
              <button name="intent" value="draft" disabled={busy}>
                <strong>保存为待进单</strong>
                <span>保存当前资料，项目保持待进单。</span>
              </button>
              <button name="intent" value="pre_entry_execution" disabled={busy}>
                <strong>未进单先执行</strong>
                <span>记录经理批复，主状态仍保持待进单。</span>
              </button>
              <button className="primary-path" name="intent" value="formal" disabled={busy}>
                <strong>正式进单</strong>
                <span>校验 ECC、进单时间、合同与搬迁范围。</span>
              </button>
            </div>
          </div>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <button
          type="button"
          className="button"
          disabled={step === 1}
          onClick={() => setStep((value) => value - 1)}
        >
          上一步
        </button>
        {step < 4 ? (
          <button className="button primary" disabled={busy}>下一步</button>
        ) : (
          <span>选择上方一种保存路径；提交时继续执行现有业务校验。</span>
        )}
      </div>
    </form>
  );
}

function ReminderFormV2({
  project,
  onSave,
  onClear,
}: {
  project: WorkbenchProjectRow;
  onSave: (at: string | null, note: string | null) => Promise<void>;
  onClear: () => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave(
          String(data.get("at") || "") || null,
          String(data.get("note") || "") || null,
        ).catch((cause) => setError(messageOf(cause)));
      }}
    >
      <p className="notice">
        项目只保留一个当前提醒，可编辑或清除，不保存提醒完成历史。
      </p>
      <div className="form-grid">
        <Field
          name="at"
          label="当前提醒时间"
          type="datetime-local"
          defaultValue={localDateTime(project.reminderAt)}
        />
        <Field
          name="note"
          label="备注内容"
          defaultValue={project.reminderNote || ""}
        />
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <button
          type="button"
          className="button danger"
          onClick={() =>
            void onClear().catch((cause) => setError(messageOf(cause)))
          }
        >
          清除提醒
        </button>
        <button className="button primary">保存当前提醒</button>
      </div>
    </form>
  );
}
function CancelFormV2({
  project,
  onSave,
}: {
  project: WorkbenchProjectRow;
  onSave: (time: string, reason: string) => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave(String(data.get("time")), String(data.get("reason"))).catch(
          (cause) => setError(messageOf(cause)),
        );
      }}
    >
      <p className="notice danger-notice">
        取消为终态不可恢复；存在任何掉票历史（含已撤销）的项目禁止取消。
      </p>
      <div className="form-grid">
        <Field
          name="time"
          label="取消时间"
          type="datetime-local"
          defaultValue={localDateTime(new Date().toISOString())}
          required
          autoFocus
        />
        <Field name="reason" label="取消原因" required />
        <label className="confirm-check full">
          <input type="checkbox" required />
          我确认项目取消后不可恢复
        </label>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>{project.customerName}</span>
        <button className="button danger">确认取消项目</button>
      </div>
    </form>
  );
}
function InvoiceMutationForm({
  mode,
  invoice,
  onSave,
}: {
  mode: "edit" | "revoke";
  invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>;
  onSave: (values: {
    time: string;
    amount: string;
    reason: string;
  }) => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave({
          time: String(data.get("time")),
          amount: String(data.get("amount") || ""),
          reason: String(data.get("reason") || ""),
        }).catch((cause) => setError(messageOf(cause)));
      }}
    >
      <p className={`notice ${mode === "revoke" ? "danger-notice" : ""}`}>
        {mode === "revoke"
          ? "撤销后为不可恢复终态，更正需新增有效掉票。"
          : "仅有效掉票可以直接编辑。"}
      </p>
      <div className="form-grid">
        <Field
          name="time"
          label={mode === "edit" ? "掉票时间" : "撤销时间"}
          type="datetime-local"
          defaultValue={localDateTime(
            mode === "edit" ? invoice.invoicedAt : new Date().toISOString(),
          )}
          required
          autoFocus
        />
        {mode === "edit" ? (
          <Field
            name="amount"
            label="掉票金额（USD）"
            type="number"
            step="any"
            defaultValue={invoice.amount}
            required
          />
        ) : (
          <>
            <Field name="reason" label="撤销原因" required />
            <label className="confirm-check full">
              <input type="checkbox" required />
              我确认撤销后不可恢复
            </label>
          </>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>{invoice.id}</span>
        <button
          className={`button ${mode === "revoke" ? "danger" : "primary"}`}
        >
          {mode === "edit" ? "保存修改" : "确认撤销掉票"}
        </button>
      </div>
    </form>
  );
}

function ReportPanelV2(): JSX.Element {
  const [filter, setFilter] = useState<ReportFilterDto>({
    monthFrom: "",
    monthTo: "",
  });
  const [report, setReport] = useState<ReportDto | null>(null);
  const [details, setDetails] = useState<Array<Record<string, string | number | boolean | null>>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"build" | "xlsx" | "png" | "pdf" | "">("");
  async function build(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy("build");
    setError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      setReport(await api.buildReport(filter));
      setDetails([]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function drill(key: string): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      setDetails(await api.drillDown(key, filter));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function exportFile(format: "xlsx" | "png" | "pdf"): Promise<void> {
    setBusy(format);
    setError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await api.exportReport(format, filter);
      if (!result.saved) setError("已取消保存，未生成导出文件。");
    } catch (cause) {
      setError(`导出失败：${messageOf(cause)}`);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="report">
      <form className="report-filter" onSubmit={(event) => void build(event)}>
        <Field
          name="monthFrom"
          label="起始月份"
          type="month"
          required
          onChange={(event) =>
            setFilter((old) => ({ ...old, monthFrom: event.target.value }))
          }
        />
        <Field
          name="monthTo"
          label="截止月份"
          type="month"
          required
          onChange={(event) =>
            setFilter((old) => ({ ...old, monthTo: event.target.value }))
          }
        />
        <button className="button primary" disabled={Boolean(busy)}>{busy === "build" ? "正在计算…" : "实时计算报表"}</button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {report && (
        <section>
          <h3>有界报表结果</h3>
          {report.sections.map((section) => (
            <article className="report-section" key={section.key}>
              <strong>{section.label}</strong>
              <span>{section.rows.length} 行</span>
              <button className="button small" onClick={() => void drill(section.key)}>查看明细</button>
            </article>
          ))}
          <div className="row-actions">
            <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile("xlsx")}>
              {busy === "xlsx" ? "正在导出…" : "导出 Excel"}
            </button>
            <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile("png")}>
              {busy === "png" ? "正在导出…" : "导出 PNG"}
            </button>
            <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile("pdf")}>
              {busy === "pdf" ? "正在导出…" : "导出 PDF"}
            </button>
          </div>
        </section>
      )}
      {details.length > 0 && (
        <section>
          <h3>下钻明细</h3>
          <div className="table-scroll"><table className="data-table"><tbody>{details.map((row, index) => <tr key={String(row.id ?? index)}>{Object.values(row).map((value, cell) => <td key={cell}>{String(value ?? "—")}</td>)}</tr>)}</tbody></table></div>
        </section>
      )}
    </div>
  );
}

function Layer({
  title,
  description,
  side = false,
  onClose,
  children,
}: {
  title: string;
  description: string;
  side?: boolean;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement,
  );
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      );
    window.setTimeout(() => {
      const preferred = root.querySelector<HTMLElement>(
        '[autofocus],input:not([disabled]),select:not([disabled]),textarea:not([disabled])',
      );
      (preferred ?? focusables()[0])?.focus();
    }, 0);
    function key(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      opener.current?.focus();
    };
  }, [onClose]);
  return (
    <div
      className={`overlay ${side ? "side" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className={side ? "drawer wide-drawer" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="layer-title-v2"
      >
        <header className="layer-head">
          <div>
            <h2 id="layer-title-v2">{title}</h2>
            <p>{description}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="layer-body">{children}</div>
      </section>
    </div>
  );
}
function Field({
  name,
  label,
  required = false,
  optional = false,
  help,
  ...props
}: {
  name: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: string;
} & React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  const helpId = help ? `v2-${name}-help` : undefined;
  return (
    <div className="field">
      <label htmlFor={`v2-${name}`}>
        {label} {required ? <b>必填</b> : optional ? <em>可后补</em> : null}
      </label>
      <input id={`v2-${name}`} name={name} required={required} aria-describedby={helpId} {...props} />
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function Select({
  name,
  label,
  options,
  required = false,
  optional = false,
  help,
  ...props
}: {
  name: string;
  label: string;
  options: Array<[string, string]>;
  required?: boolean;
  optional?: boolean;
  help?: string;
} & React.SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  const helpId = help ? `v2-${name}-help` : undefined;
  return (
    <div className="field">
      <label htmlFor={`v2-${name}`}>{label} {required ? <b>必填</b> : optional ? <em>可后补</em> : null}</label>
      <select id={`v2-${name}`} name={name} required={required} aria-describedby={helpId} {...props}>
        {options.map(([value, text]) => (
          <option value={value} key={value}>
            {text}
          </option>
        ))}
      </select>
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function TextArea({
  name,
  label,
  optional = false,
  help,
  ...props
}: {
  name: string;
  label: string;
  optional?: boolean;
  help?: string;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  const helpId = help ? `v2-${name}-help` : undefined;
  return (
    <div className="field full">
      <label htmlFor={`v2-${name}`}>{label} {optional ? <em>可后补</em> : null}</label>
      <textarea id={`v2-${name}`} name={name} aria-describedby={helpId} {...props} />
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function StatusBadge({ status }: { status: ProjectStatus }): JSX.Element {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true">
        {status === "pending_entry" ? "○" : status === "completed" ? "✓" : "◆"}
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}
function Empty({ title, copy }: { title: string; copy: string }): JSX.Element {
  return (
    <div className="empty">
      <span aria-hidden="true">—</span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}
function layerTitle(layer: LayerState): string {
  if (layer.kind === "new") return "新建搬迁项目";
  if (layer.kind === "quick") return "快速记录";
  if (layer.kind === "reminder") return "维护项目提醒";
  if (layer.kind === "cancel") return "取消项目";
  if (layer.kind === "report") return "运营报表";
  if (layer.kind === "independent")
    return layer.module === "serial_address" ? "序列号地址更新" : "二维码申请";
  if (layer.kind === "invoice-edit") return "编辑掉票";
  if (layer.kind === "invoice-revoke") return "撤销掉票";
  if (layer.kind === "action")
    return (
      ACTIONS.find((action) => action.type === layer.action)?.label ||
      "记录业务事实"
    );
  return "记录业务事实";
}
function layerDescription(
  layer: LayerState,
  project: WorkbenchProjectRow | null,
): string {
  if (layer.kind === "new") return "四步完成范围、准备与确认路径";
  if (layer.kind === "report") return "手工月份区间与有界导出";
  if (layer.kind === "independent") return "独立模块 · 记录按页读取";
  if (layer.kind === "cancel") return "记录取消时间与原因（终态，不可恢复）";
  return project
    ? `${project.customerName} · ${project.ecc || project.tempNo}`
    : "选择需要记录的动作";
}
