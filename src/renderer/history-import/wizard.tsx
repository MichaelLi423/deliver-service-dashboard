import {
  createRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { HistoryImportVirtualGrid, type HistoryImportVirtualGridHandle } from './virtual-grid';
import type {
  HistoryImportCategory,
  HistoryImportDraftSummary,
  HistoryImportSubmitResult,
  HistoryImportWizardProvider,
  HistoryImportWorkspace,
  ImportIssue,
  IssueKind,
  WizardStepId,
} from './provider';
import { HistoryImportSessionExpiredError } from './provider';
import './wizard.css';

const STEPS: readonly { id: WizardStepId; number: string; label: string; note: string }[] = [
  { id: 'prepare', number: '01', label: '准备数据', note: '模板、文件与列映射' },
  { id: 'projects', number: '02', label: '项目与合同', note: '按 ECC 聚合' },
  { id: 'orders', number: '03', label: '开单记录', note: '四类服务单据' },
  { id: 'finance', number: '04', label: '掉票与物流费用', note: '金额与发生时间' },
  { id: 'serials', number: '05', label: '序列号地址更新', note: '逐台实际地址' },
  { id: 'requests', number: '06', label: '二维码与 Account ID 申请', note: '独立申请记录' },
  { id: 'review', number: '07', label: '校验摘要与确认', note: '封存后整体提交' },
];

const CATEGORY_LABEL: Record<HistoryImportCategory, string> = {
  projects: '项目与合同', serviceOrders: '开单记录', invoices: '掉票记录', logistics: '物流费用',
  serialAddresses: '序列号地址更新', qrRequests: '二维码申请', shipToRequests: 'Account ID 申请',
};

const STEP_CATEGORIES: Record<WizardStepId, readonly HistoryImportCategory[]> = {
  prepare: [], projects: ['projects'], orders: ['serviceOrders'], finance: ['invoices', 'logistics'],
  serials: ['serialAddresses'], requests: ['qrRequests', 'shipToRequests'], review: [],
};

const ISSUE_LABEL: Record<IssueKind, string> = { error: '错误', conflict: '冲突', warning: '警告' };
const STATE_LABEL = { not_started: '未开始', processing: '处理中', passed: '已通过', warning: '有警告', blocked: '已阻断' } as const;

export interface HistoryImportWizardProps {
  provider: HistoryImportWizardProvider;
  username?: string;
  onExit?: () => void;
  onSessionExpired?: () => void;
}

function isSessionError(error: unknown): boolean {
  return error instanceof HistoryImportSessionExpiredError || (error instanceof Error && error.message.includes('登录状态已失效'));
}

export function HistoryImportWizard({ provider, username, onExit, onSessionExpired }: HistoryImportWizardProps) {
  const [drafts, setDrafts] = useState<readonly HistoryImportDraftSummary[] | null>(null);
  const [workspace, setWorkspace] = useState<HistoryImportWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [fatal, setFatal] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(true);
  const [activeCategory, setActiveCategory] = useState<HistoryImportCategory | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [eccOpen, setEccOpen] = useState(false);
  const [eccQuery, setEccQuery] = useState('');
  const [conflict, setConflict] = useState<ImportIssue | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [pasteCategory, setPasteCategory] = useState<HistoryImportCategory | null>(null);
  const [pasteHasHeader, setPasteHasHeader] = useState(true);
  const [pasteConfirmed, setPasteConfirmed] = useState(false);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
  const [pendingOutcomes, setPendingOutcomes] = useState<readonly string[]>([]);
  const [interruptedResult, setInterruptedResult] = useState<{ draftId: string; result: HistoryImportSubmitResult } | null>(null);
  const [warningConfirmed, setWarningConfirmed] = useState(false);
  const [scopeConfirmed, setScopeConfirmed] = useState(false);
  const [submitResult, setSubmitResult] = useState<HistoryImportSubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogReturnRef = useRef<HTMLElement | null>(null);
  const dialogFirstRef = useRef<HTMLButtonElement>(null);
  const interruptedHeadingRef = useRef<HTMLHeadingElement>(null);
  const gridRefs = useRef(new Map<HistoryImportCategory, RefObject<HistoryImportVirtualGridHandle>>());

  function gridRef(category: HistoryImportCategory) {
    let ref = gridRefs.current.get(category);
    if (!ref) { ref = createRef<HistoryImportVirtualGridHandle>(); gridRefs.current.set(category, ref); }
    return ref;
  }

  async function run<T>(action: () => Promise<T>, apply?: (value: T) => void) {
    if (sessionExpired) return undefined;
    setBusy(true); setFatal('');
    try { const value = await action(); apply?.(value); return value; }
    catch (error) {
      if (isSessionError(error)) { setSessionExpired(true); setFatal('登录状态已失效。最后一次成功保存的草稿仍会保留，重新登录后需要重新完整校验。'); onSessionExpired?.(); }
      else setFatal(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally { setBusy(false); }
  }

  useEffect(() => {
    void (async () => {
      if (provider.recover) {
        const recovery = await run(() => provider.recover!());
        if (recovery) setPendingOutcomes(recovery.pendingOutcome);
      }
      await run(() => provider.listDrafts(), setDrafts);
    })();
  }, [provider]);
  useEffect(() => {
    if (!workspace) return;
    const categories = STEP_CATEGORIES[workspace.currentStep];
    setActiveCategory((current) => current && categories.includes(current) ? current : categories[0] ?? null);
    setWarningConfirmed(false); setScopeConfirmed(false);
  }, [workspace?.currentStep]);

  useEffect(() => {
    if (conflict || confirmOpen || exitOpen || pasteCategory || submitResult) window.setTimeout(() => dialogFirstRef.current?.focus(), 0);
  }, [conflict, confirmOpen, exitOpen, pasteCategory, submitResult]);

  useEffect(() => {
    if (interruptedResult) window.setTimeout(() => interruptedHeadingRef.current?.focus(), 0);
  }, [interruptedResult]);

  useEffect(() => {
    if (!workspace || !provider.subscribeProgress) return;
    return provider.subscribeProgress((event) => {
      if (event.draftId !== workspace.draft.id) return;
      if (event.state === 'running') {
        setWorkspace((current) => current ? { ...current, operation: { id: event.operationId, kind: event.kind, label: event.stage || '正在处理导入数据', processed: event.processed, total: event.total, cancelable: event.kind !== 'submitting' } } : current);
      } else {
        setNotice(event.state === 'completed' ? '处理已完成。' : event.state === 'cancelled' ? '处理已取消，草稿保持上次成功保存状态。' : '处理失败，请查看问题与错误说明。');
        // failed 的具体错误由发起操作的 Promise 进入 run/catch 展示；此处刷新会先清空 fatal，导致真实错误丢失。
        if (event.state !== 'failed') void run(() => provider.openDraft(event.draftId), setWorkspace);
      }
    });
  }, [workspace?.draft.id, provider]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (!workspace || submitting || sessionExpired || conflict || confirmOpen || exitOpen || pasteCategory || submitResult) return;
      const target = event.target;
      if (target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void update(() => event.shiftKey ? provider.redo(workspace.draft.id) : provider.undo(workspace.draft.id), event.shiftKey ? '已重做上次网格修改。' : '已撤销上次网格修改。');
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        void update(() => provider.redo(workspace.draft.id), '已重做上次网格修改。');
      } else if (event.key === 'F8') {
        const issue = workspace.issues.find((item) => item.kind !== 'warning') ?? workspace.issues[0];
        if (issue) { event.preventDefault(); void locateIssue(issue); }
      }
    }
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [workspace, submitting, sessionExpired, conflict, confirmOpen, exitOpen, pasteCategory, submitResult, provider]);

  function openDialog(trigger: HTMLElement, kind: 'conflict' | 'confirm' | 'exit', issue?: ImportIssue) {
    dialogReturnRef.current = trigger;
    if (kind === 'conflict' && issue) setConflict(issue);
    if (kind === 'confirm') setConfirmOpen(true);
    if (kind === 'exit') setExitOpen(true);
  }

  function closeDialogs() {
    setConflict(null); setConfirmOpen(false); setExitOpen(false); setPasteCategory(null);
    window.setTimeout(() => dialogReturnRef.current?.focus(), 0);
  }

  async function openDraft(id: string) { await run(() => provider.openDraft(id), setWorkspace); }
  async function createDraft() { await run(() => provider.createDraft(), setWorkspace); }
  async function update(action: () => Promise<HistoryImportWorkspace>, message?: string) {
    const result = await run(action, setWorkspace);
    if (result && message) setNotice(message);
    return result;
  }

  function requestPaste(category: HistoryImportCategory, trigger?: HTMLElement) {
    dialogReturnRef.current = trigger ?? document.activeElement as HTMLElement | null;
    setPasteHasHeader(true);
    setPasteConfirmed(false);
    setPasteCategory(category);
  }

  async function settleInterrupted(draftId: string) {
    if (!provider.settleInterrupted) return;
    const result = await run(() => provider.settleInterrupted!(draftId));
    if (result) {
      setPendingOutcomes((current) => current.filter((id) => id !== draftId));
      setInterruptedResult({ draftId, result });
    }
  }

  async function continueAfterRollback(draftId: string) {
    const opened = await run(() => provider.openDraft(draftId), setWorkspace);
    if (!opened) return;
    await update(() => provider.saveDraft(draftId, 'review'), '上次提交已完整回滚。请重新执行完整校验。');
    setInterruptedResult(null);
  }

  async function executePaste(category: HistoryImportCategory) {
    if (!workspace || !pasteConfirmed) return;
    const boundary = await update(() => provider.saveDraft(workspace.draft.id, workspace.currentStep), '已建立粘贴前保存边界。');
    if (!boundary) return;
    const pasted = await update(() => provider.pasteIntoCategory(workspace.draft.id, category, pasteHasHeader), '粘贴内容已进入目标网格并完成局部校验。');
    if (pasted) closeDialogs();
  }

  function chooseStep(step: WizardStepId) {
    if (!workspace || submitting) return;
    void update(() => provider.saveDraft(workspace.draft.id, step));
  }

  async function locateIssue(issue: ImportIssue) {
    if (!workspace) return;
    setIssuesOpen(true);
    const changed = workspace.currentStep !== issue.step;
    if (changed) {
      const loaded = await run(() => provider.saveDraft(workspace.draft.id, issue.step), setWorkspace);
      if (!loaded) return;
    }
    setActiveCategory(issue.category);
    window.setTimeout(() => { void gridRef(issue.category).current?.locateIssue(issue.id); }, changed ? 20 : 0);
  }

  async function openEcc(ecc: string, category: 'projects' | 'serviceOrders' | 'invoices' | 'logistics') {
    if (!workspace) return;
    const step: WizardStepId = category === 'projects' ? 'projects' : category === 'serviceOrders' ? 'orders' : 'finance';
    if (workspace.currentStep !== step) {
      const loaded = await run(() => provider.saveDraft(workspace.draft.id, step), setWorkspace);
      if (!loaded) return;
    }
    setActiveCategory(category);
    window.setTimeout(() => gridRef(category).current?.filterByEcc(ecc), 20);
  }

  async function submitCurrent(seal: string) {
    if (!workspace || submitting || sessionExpired) return;
    setSubmitting(true);
    closeDialogs();
    try {
      setSubmitResult(await provider.submit(workspace.draft.id, seal));
    } catch (error) {
      if (isSessionError(error)) {
        setSessionExpired(true);
        setFatal('登录状态已失效。提交已经停止，请重新登录后核对封存计划状态。最后一次成功保存的草稿仍会保留。');
        onSessionExpired?.();
      } else {
        setSubmitResult({ status: 'failed', title: '导入未完成', message: `${error instanceof Error ? error.message : String(error)}。本次没有产生部分导入，草稿已保留。` });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!workspace && interruptedResult) {
    const { draftId, result } = interruptedResult;
    const success = result.status === 'success';
    const failed = result.status === 'failed';
    return <main className="hiw hiw-interrupted-result"><section className={`hiw-result-page is-${result.status}`} aria-labelledby="interrupted-title"><span className="hiw-result-mark" aria-hidden="true">{success ? '✓' : failed ? '↩' : '?'}</span><p className="hiw-kicker">提交中断结果核对</p><h1 ref={interruptedHeadingRef} tabIndex={-1} id="interrupted-title">{success ? '整批导入已完整成功' : failed ? '整批导入已完整回滚' : '提交结果仍需核对'}</h1><p>{result.message}</p>{failed && <div className="hiw-result-note" role="status"><strong>没有产生部分导入</strong><span>草稿已保留，但旧 seal 和提交资格不可继续使用。进入草稿后必须重新完整校验。</span></div>}{success && <div className="hiw-result-note" role="status"><strong>成功结果已经核对</strong><span>本次七类数据按同一封存计划整体完成。</span></div>}<div className="hiw-result-actions">{result.status === 'unknown' ? <button className="hiw-primary" onClick={() => void settleInterrupted(draftId)}>再次核对最终状态</button> : failed ? <button className="hiw-primary" onClick={() => void continueAfterRollback(draftId)}>继续草稿并重新校验</button> : <button className="hiw-primary" onClick={() => setInterruptedResult(null)}>返回草稿首页</button>}</div></section></main>;
  }

  if (!workspace) {
    return (
      <main className="hiw hiw-home" aria-busy={busy}>
        <header className="hiw-home-header">
          <div><button className="hiw-back hiw-home-back" onClick={onExit}>← 返回数据管理</button><p className="hiw-kicker">数据管理 / 历史数据导入</p><h1>把旧数据整理成一份可核对的导入计划</h1><p>先在独立草稿中整理和校验。确认前不会写入任何业务数据。</p></div>
          <div className="hiw-home-actions">{username && <span>当前账号<strong>{username}</strong></span>}<button className="hiw-primary" onClick={() => void createDraft()} disabled={busy}>新建导入</button></div>
        </header>
        {fatal && <div className="hiw-alert" role="alert">{fatal}</div>}
        {pendingOutcomes.length > 0 && <section className="hiw-pending-outcomes" aria-labelledby="pending-outcome-title"><div><p className="hiw-kicker">上次提交曾中断</p><h2 id="pending-outcome-title">先核对最终结果，再决定下一步</h2><p>核对完成前不会再次提交相同封存计划。</p></div>{pendingOutcomes.map((draftId) => <button className="hiw-primary" key={draftId} onClick={() => void settleInterrupted(draftId)}>核对 {drafts?.find((draft) => draft.id === draftId)?.name ?? '中断草稿'} 的最终状态</button>)}</section>}
        <section className="hiw-draft-section" aria-labelledby="draft-heading">
          <div className="hiw-section-heading"><div><p className="hiw-kicker">可恢复工作区</p><h2 id="draft-heading">导入草稿</h2></div><span>{drafts?.length ?? 0} 份</span></div>
          {drafts === null ? <p role="status">正在读取草稿…</p> : drafts.length === 0 ? (
            <div className="hiw-empty"><strong>还没有导入草稿</strong><span>新建后可以分次整理，保存退出后继续。</span></div>
          ) : <div className="hiw-draft-list">{drafts.map((draft) => (
            <article className="hiw-draft-card" key={draft.id}>
              <div><span className={`hiw-save hiw-save-${draft.saveState}`}>{draft.saveState === 'saved' ? '已保存' : draft.saveState === 'saving' ? '保存中' : '保存失败'}</span><h3>{draft.name}</h3><p>上次停在：{STEPS.find((step) => step.id === draft.currentStep)?.label}</p></div>
              <dl><div><dt>记录</dt><dd>{draft.totalRows.toLocaleString('zh-CN')}</dd></div><div><dt>问题</dt><dd>{draft.issueCount}</dd></div><div><dt>更新</dt><dd>{draft.updatedAt}</dd></div></dl>
              <div className="hiw-card-actions"><button className="hiw-primary" onClick={() => void openDraft(draft.id)}>继续草稿</button><button onClick={() => { if (window.confirm('删除这份导入草稿？现有业务数据不会受到影响。')) void run(() => provider.deleteDraft(draft.id), () => setDrafts((items) => items?.filter((item) => item.id !== draft.id) ?? [])); }}>删除草稿</button></div>
            </article>
          ))}</div>}
        </section>
      </main>
    );
  }

  const stepIndex = STEPS.findIndex((step) => step.id === workspace.currentStep);
  const summary = workspace.summary;
  const canSubmit = Boolean(summary?.seal && summary.sealValid && summary.validationComplete && summary.blockingCount === 0 && (!summary.warningCount || warningConfirmed) && scopeConfirmed && !submitting && !sessionExpired);

  return (
    <main className="hiw hiw-workspace" data-testid="history-import-workspace" aria-busy={busy || submitting}>
      <header className="hiw-topbar">
        <button className="hiw-back" onClick={(event) => openDialog(event.currentTarget, 'exit')}>← 返回数据管理</button>
        <div><p className="hiw-kicker">历史数据导入</p><h1>{workspace.draft.name}</h1></div>
        <div className="hiw-account"><span>当前账号</span><strong>{workspace.username}</strong><span className={`hiw-save hiw-save-${workspace.draft.saveState}`} role="status">{workspace.draft.saveState === 'saved' ? '● 已保存' : workspace.draft.saveState === 'saving' ? '○ 保存中' : '! 保存失败'}</span></div>
      </header>

      <div className={`hiw-layout ${issuesOpen ? '' : 'issues-closed'}`}>
        <nav className="hiw-step-rail" aria-label="导入步骤">
          <ol>{STEPS.map((step) => {
            const state = workspace.steps.find((item) => item.id === step.id) ?? { state: 'not_started' as const, errorCount: 0 };
            const current = step.id === workspace.currentStep;
            return <li key={step.id}><button aria-current={current ? 'step' : undefined} onClick={() => chooseStep(step.id)} disabled={submitting}><span className="hiw-step-number">{step.number}</span><span><strong>{step.label}</strong><small>{step.note}</small><em className={`hiw-step-state is-${state.state}`}>{STATE_LABEL[state.state]}{state.errorCount ? ` · ${state.errorCount}` : ''}</em></span></button></li>;
          })}</ol>
          <button className="hiw-ecc-button" onClick={() => setEccOpen((value) => !value)} aria-expanded={eccOpen}>ECC 中心 <span>{workspace.ecc.length}</span></button>
          {eccOpen && <div className="hiw-ecc-panel"><label>查找 ECC<input type="search" placeholder="输入 ECC" value={eccQuery} onChange={(event) => setEccQuery(event.target.value)} /></label>{workspace.ecc.filter((item) => item.ecc.toLowerCase().includes(eccQuery.trim().toLowerCase())).map((item) => <section key={item.ecc} aria-label={`${item.ecc} 关联`}><strong>{item.ecc}</strong><span>来源 {item.sources}</span><div><button onClick={() => void openEcc(item.ecc, 'projects')}>项目 {item.projects}</button><button onClick={() => void openEcc(item.ecc, 'serviceOrders')}>开单 {item.serviceOrders}</button><button onClick={() => void openEcc(item.ecc, 'invoices')}>掉票 {item.invoices}</button><button onClick={() => void openEcc(item.ecc, 'logistics')}>物流 {item.logistics}</button></div></section>)}</div>}
        </nav>

        <section className="hiw-stage" aria-labelledby="stage-heading">
          {fatal && <div className="hiw-alert" role="alert">{fatal}</div>}
          <div className="hiw-stage-heading"><div><p className="hiw-kicker">步骤 {stepIndex + 1} / 7</p><h2 id="stage-heading">{STEPS[stepIndex]?.label}</h2><p>{STEPS[stepIndex]?.note}</p></div><div className="hiw-stage-tools"><button onClick={() => setKeyboardHelpOpen((value) => !value)} aria-expanded={keyboardHelpOpen} aria-controls="keyboard-help">键盘帮助</button><button className="hiw-issue-toggle" onClick={() => setIssuesOpen((value) => !value)} aria-expanded={issuesOpen}>问题 {workspace.issues.length}</button></div></div>
          {keyboardHelpOpen && <section className="hiw-keyboard-help" id="keyboard-help" aria-label="键盘操作说明"><strong>键盘操作</strong><ul><li><kbd>F8</kbd> 定位下一条阻断问题</li><li><kbd>Ctrl Z</kbd> 撤销当前会话操作</li><li><kbd>Ctrl Y</kbd> 重做当前会话操作</li><li><kbd>Enter</kbd> 编辑或提交单元格</li><li><kbd>Esc</kbd> 仅取消当前编辑或关闭确认</li><li><kbd>Ctrl V</kbd> 从网格打开主进程粘贴确认</li></ul></section>}
          {workspace.operation && <OperationBanner operation={workspace.operation} onCancel={() => void update(() => provider.cancelOperation(workspace.draft.id, workspace.operation!.id), '操作已取消，草稿已恢复到上次保存状态。')} />}
          {workspace.currentStep === 'prepare' && <PrepareStep workspace={workspace} provider={provider} update={update} onDownload={() => void run(() => provider.downloadTemplate(), (result) => setNotice(result.saved ? `空白模板 ${result.version} 已保存。` : '已取消保存模板。'))} mappingOpen={mappingOpen} setMappingOpen={setMappingOpen} />}
          {STEP_CATEGORIES[workspace.currentStep].length > 0 && <BusinessStep workspace={workspace} provider={provider} activeCategory={activeCategory} setActiveCategory={setActiveCategory} update={update} gridRef={gridRef} submitting={submitting || sessionExpired} onPaste={requestPaste} />}
          {workspace.currentStep === 'review' && <ReviewStep workspace={workspace} warningConfirmed={warningConfirmed} scopeConfirmed={scopeConfirmed} setWarningConfirmed={setWarningConfirmed} setScopeConfirmed={setScopeConfirmed} onValidate={() => void update(() => provider.validate(workspace.draft.id), '完整校验已完成。')} />}
        </section>

        {issuesOpen && <aside className="hiw-issues" aria-label="全局问题面板"><div className="hiw-issues-heading"><div><p className="hiw-kicker">跨步骤核对</p><h2>问题</h2></div><button aria-label="收起问题面板" onClick={() => setIssuesOpen(false)}>×</button></div><IssueCounts issues={workspace.issues} />{workspace.issues.length === 0 ? <div className="hiw-empty compact"><strong>没有待处理问题</strong><span>进入最终摘要前仍需完整校验。</span></div> : <ul className="hiw-issue-list">{workspace.issues.map((issue) => <li key={issue.id} className={`is-${issue.kind}`}><span className="hiw-issue-kind">{ISSUE_LABEL[issue.kind]}</span><strong>{issue.message}</strong><p>{CATEGORY_LABEL[issue.category]} · 第 {issue.rowIndex + 1} 行 · {issue.field}</p><small>{issue.source}</small><div><button onClick={() => void locateIssue(issue)}>定位</button>{issue.kind === 'conflict' && <button onClick={(event) => openDialog(event.currentTarget, 'conflict', issue)}>处理冲突</button>}</div></li>)}</ul>}</aside>}
      </div>

      <footer className="hiw-footer"><div><button onClick={() => chooseStep(STEPS[Math.max(0, stepIndex - 1)]!.id)} disabled={stepIndex === 0 || submitting}>上一步</button><button onClick={(event) => openDialog(event.currentTarget, 'exit')} disabled={submitting}>保存并退出</button></div><p aria-live="polite">{notice}</p>{workspace.currentStep === 'review' ? <button className="hiw-primary" disabled={!canSubmit} onClick={(event) => openDialog(event.currentTarget, 'confirm')}>确认导入</button> : <button className="hiw-primary" onClick={() => chooseStep(STEPS[Math.min(6, stepIndex + 1)]!.id)} disabled={submitting}>下一步</button>}</footer>

      {conflict && <ConflictDialog issue={conflict} firstRef={dialogFirstRef} onClose={closeDialogs} onResolve={(value) => void update(() => provider.resolveConflict(workspace.draft.id, conflict.id, value), '冲突决定已保存。').then((saved) => { if (saved) closeDialogs(); })} />}
      {pasteCategory && <Dialog title={`粘贴到${CATEGORY_LABEL[pasteCategory]}`} description="剪贴板内容由主进程读取和规范化，不会把全量行放进 React。请选择第一行的含义。" firstRef={dialogFirstRef} onClose={closeDialogs}><fieldset className="hiw-paste-choice"><legend>第一行是</legend><label><input type="radio" name="paste-header" checked={pasteHasHeader} onChange={() => setPasteHasHeader(true)} />字段表头</label><label><input type="radio" name="paste-header" checked={!pasteHasHeader} onChange={() => setPasteHasHeader(false)} />业务数据</label></fieldset><div className="hiw-paste-warning"><strong>开始前会建立可恢复检查点</strong><p>处理中可取消并回到操作前草稿；完成后可使用“撤销”整体恢复粘贴前内容，并可“重做”回到粘贴结果。</p><label><input type="checkbox" checked={pasteConfirmed} onChange={(event) => setPasteConfirmed(event.target.checked)} />我已核对目标类别和第一行含义</label></div><button onClick={closeDialogs}>取消</button><button className="hiw-primary" disabled={!pasteConfirmed} onClick={() => void executePaste(pasteCategory)}>建立检查点并读取剪贴板</button></Dialog>}
      {exitOpen && <Dialog title="保存并退出？" description="先保存当前步骤和修改，再回到数据管理。Escape 只关闭此确认，不会丢弃草稿。" firstRef={dialogFirstRef} onClose={closeDialogs}><button onClick={closeDialogs}>继续编辑</button><button className="hiw-primary" onClick={() => void update(() => provider.saveDraft(workspace.draft.id, workspace.currentStep)).then((saved) => { if (!saved) return; closeDialogs(); onExit?.(); setWorkspace(null); void run(() => provider.listDrafts(), setDrafts); })}>保存并退出</button></Dialog>}
      {confirmOpen && <Dialog title="确认整体导入" description="系统将按当前封存计划提交七类数据。任一记录失败时，本次全部数据都不会保存。" firstRef={dialogFirstRef} onClose={closeDialogs}><button onClick={closeDialogs}>返回核对</button><button className="hiw-primary" onClick={() => { if (summary?.seal) void submitCurrent(summary.seal); }}>开始导入</button></Dialog>}
      {submitting && <div className="hiw-submit-overlay" role="status" aria-live="polite"><div><span className="hiw-spinner" aria-hidden="true" /><strong>正在整体提交</strong><p>当前只有一个提交任务，请不要关闭窗口。</p></div></div>}
      {submitResult && <Dialog title={submitResult.title} description={submitResult.message} firstRef={dialogFirstRef} onClose={() => { setSubmitResult(null); dialogReturnRef.current?.focus(); }}><button className="hiw-primary" onClick={() => setSubmitResult(null)}>完成</button></Dialog>}
    </main>
  );
}

function PrepareStep({ workspace, provider, update, onDownload, mappingOpen, setMappingOpen }: { workspace: HistoryImportWorkspace; provider: HistoryImportWizardProvider; update: (action: () => Promise<HistoryImportWorkspace>, message?: string) => Promise<HistoryImportWorkspace | undefined>; onDownload: () => void; mappingOpen: boolean; setMappingOpen: (value: boolean) => void }) {
  return <div className="hiw-prepare"><div className="hiw-action-cards"><article><span>01</span><h3>下载当前空白模板</h3><p>版本 {workspace.templateVersion}，包含七类工作表、字段和填写说明，不含示例业务行。</p><button onClick={onDownload}>下载 Excel 模板</button></article><article><span>02</span><h3>选择 Excel 文件</h3><p>可连续选择多个 .xlsx 文件。读取、规范化和取消都由窗口 API 处理。</p><button className="hiw-primary" onClick={() => void update(() => provider.selectFiles(workspace.draft.id), '文件已加入草稿。')}>选择一个或多个文件</button></article></div>
    <section className="hiw-sheet-section"><div className="hiw-section-heading"><div><p className="hiw-kicker">来源清单</p><h3>文件与工作表</h3></div><button onClick={() => setMappingOpen(!mappingOpen)} aria-expanded={mappingOpen}>列映射 {workspace.mappings.length}</button></div>{workspace.sheets.length === 0 ? <div className="hiw-empty"><strong>尚未选择文件</strong><span>也可以在后续目标网格中直接粘贴 Excel 矩形区域。</span></div> : <div className="hiw-table-wrap"><table><thead><tr><th>文件 / 工作表</th><th>数据行</th><th>识别状态</th><th>目标类别</th></tr></thead><tbody>{workspace.sheets.map((sheet) => <tr key={sheet.id}><td><strong>{sheet.fileName}</strong><span>{sheet.sheetName}</span></td><td>{sheet.rowCount.toLocaleString('zh-CN')}</td><td><span className={`hiw-sheet-state is-${sheet.status}`}>{sheet.status === 'recognized' ? '已识别' : sheet.status === 'unknown' ? '待归类' : sheet.status === 'empty' ? '空工作表' : '已排除'}</span></td><td><select aria-label={`${sheet.sheetName} 目标类别`} value={sheet.status === 'excluded' ? 'excluded' : sheet.category ?? ''} onChange={(event) => void update(() => provider.classifySheet(workspace.draft.id, sheet.id, event.target.value as HistoryImportCategory | 'excluded'))}><option value="">请选择</option>{Object.entries(CATEGORY_LABEL).map(([id, label]) => <option value={id} key={id}>{label}</option>)}<option value="excluded">明确排除</option></select></td></tr>)}</tbody></table></div>}</section>
    {mappingOpen && <section className="hiw-mapping" aria-label="列映射"><div className="hiw-section-heading"><div><p className="hiw-kicker">文件和粘贴共用</p><h3>列映射</h3></div><button onClick={() => setMappingOpen(false)}>关闭</button></div><div className="hiw-table-wrap"><table><thead><tr><th>源列</th><th>样例值</th><th>匹配依据</th><th>目标字段</th><th>来源优先级</th></tr></thead><tbody>{workspace.mappings.map((mapping) => <tr key={mapping.id}><td>{mapping.source}</td><td>{mapping.sample}</td><td><span className={`hiw-match is-${mapping.match}`}>{mapping.match === 'exact' ? '精确匹配' : mapping.match === 'alias' ? '已知别名' : mapping.match === 'manual' ? '待人工选择' : '不使用'}</span></td><td><select aria-label={`${mapping.source} 映射目标`} value={mapping.target ?? ''} onChange={(event) => void update(() => provider.updateMapping(workspace.draft.id, mapping.id, event.target.value || null), '列映射已保存。')}><option value="">不使用</option>{mapping.targetOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></td><td>{mapping.priority ? `优先级 ${mapping.priority} · 影响 ${mapping.affectedRows ?? 0} 行` : '单一来源'}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function BusinessStep({ workspace, provider, activeCategory, setActiveCategory, update, gridRef, submitting, onPaste }: { workspace: HistoryImportWorkspace; provider: HistoryImportWizardProvider; activeCategory: HistoryImportCategory | null; setActiveCategory: (category: HistoryImportCategory) => void; update: (action: () => Promise<HistoryImportWorkspace>, message?: string) => Promise<HistoryImportWorkspace | undefined>; gridRef: (category: HistoryImportCategory) => RefObject<HistoryImportVirtualGridHandle>; submitting: boolean; onPaste: (category: HistoryImportCategory, trigger?: HTMLElement) => void }) {
  const [selection, setSelection] = useState<{ category: HistoryImportCategory; startRow: number; endRow: number } | null>(null);
  const categories = STEP_CATEGORIES[workspace.currentStep];
  const category = activeCategory ?? categories[0];
  const detail = workspace.categories.find((item) => item.category === category);
  if (!category || !detail) return null;
  const help: Record<HistoryImportCategory, string> = { projects: 'ECC 为项目与合同唯一聚合主键；同一 ECC 的来源会合并核对。', serviceOrders: '记录服务单号、服务类型、执行工程师和源业务日期。', invoices: '掉票按 ECC 关联项目，金额按 USD 精确字符串处理。', logistics: '预算价格、成交价格、物流费用和申请/登记日期均需核对。', serialAddresses: '按客户名称、序列号、Account ID 记录逐台实际地址。', qrRequests: '独立申请记录，可多选仪器服务、项目验收单或物流管理。', shipToRequests: '独立申请记录，不因缺少 ECC 产生项目关联错误。' };
  return <div className="hiw-business"><div className="hiw-category-tabs" role="tablist" aria-label="本步骤数据类别">{categories.map((id) => { const item = workspace.categories.find((candidate) => candidate.category === id)!; return <button role="tab" aria-selected={category === id} key={id} onClick={() => setActiveCategory(id)}>{CATEGORY_LABEL[id]} <span>{item.count}</span></button>; })}</div><div className="hiw-grid-intro"><div><h3>{CATEGORY_LABEL[category]}</h3><p>{help[category]}</p></div><div className="hiw-mode" role="group" aria-label={`${CATEGORY_LABEL[category]}导入方式`}><button aria-pressed={detail.mode === 'data'} onClick={() => void update(() => provider.setCategoryMode(workspace.draft.id, category, 'data'))}>有数据</button><button aria-pressed={detail.mode === 'none'} onClick={() => void update(() => provider.setCategoryMode(workspace.draft.id, category, 'none'))}>本次不导入</button></div></div>
    {detail.mode === 'none' ? <div className="hiw-none"><span>—</span><strong>本次不导入{CATEGORY_LABEL[category]}</strong><p>不会生成虚拟行、默认业务事实或待补记录。可以继续下一步。</p></div> : <><div className="hiw-grid-actions"><button onClick={() => void update(() => provider.addGridRow(workspace.draft.id, category))} disabled={submitting}>新增空白行</button><button aria-describedby="undo-scope-note" onClick={() => selection && void update(() => provider.deleteRows(workspace.draft.id, category, selection), '选中草稿行已删除。')} disabled={submitting || !selection || selection.category !== category}>删除选中行</button><button onClick={(event) => onPaste(category, event.currentTarget)} disabled={submitting}>从 Excel 粘贴</button><span /><button onClick={() => void update(() => provider.undo(workspace.draft.id))} disabled={submitting}>撤销 <kbd>Ctrl Z</kbd></button><button onClick={() => void update(() => provider.redo(workspace.draft.id))} disabled={submitting}>重做 <kbd>Ctrl Y</kbd></button></div><p className="hiw-undo-scope" id="undo-scope-note">撤销范围：单元格、列映射和当前会话新增行使用会话命令栈；大粘贴与既有行删除使用主进程磁盘检查点整体恢复。</p><HistoryImportVirtualGrid ref={gridRef(category)} provider={provider.getGridProvider(workspace.draft.id, category)} columns={detail.columns} ariaLabel={`${CATEGORY_LABEL[category]}目标网格`} height={390} onPatch={async (patches) => { await update(() => provider.patchGrid(workspace.draft.id, category, patches), '修改已保存并完成局部校验。'); }} onSelectionChange={(next) => setSelection({ category, startRow: next.start.rowIndex, endRow: next.end.rowIndex })} onPasteRequest={() => onPaste(category)} onRequestNextIssue={() => { const issue = workspace.issues.find((item) => item.category === category && item.kind !== 'warning'); if (issue) void gridRef(category).current?.locateIssue(issue.id); }} /></>}
  </div>;
}

function ReviewStep({ workspace, warningConfirmed, scopeConfirmed, setWarningConfirmed, setScopeConfirmed, onValidate }: { workspace: HistoryImportWorkspace; warningConfirmed: boolean; scopeConfirmed: boolean; setWarningConfirmed: (value: boolean) => void; setScopeConfirmed: (value: boolean) => void; onValidate: () => void }) {
  const summary = workspace.summary;
  if (!summary?.validationComplete) return <div className="hiw-validation-callout"><span>07</span><h3>先执行一次完整校验</h3><p>将重新检查七类数据、ECC 关联和现有目标数据。校验可取消，完成前不能提交。</p><button className="hiw-primary" onClick={onValidate}>开始完整校验</button></div>;
  return <div className="hiw-review"><div className={`hiw-seal ${summary.sealValid ? 'is-valid' : 'is-invalid'}`}><div><span>{summary.sealValid ? '✓' : '!'}</span><div><strong>{summary.sealValid ? '计划已封存' : '封存已失效'}</strong><p>{summary.sealValid ? '最终摘要与当前草稿一致。修改任一数据后需重新校验。' : '数据、映射或目标基线已变化，请重新完成完整校验。'}</p></div></div><button onClick={onValidate}>重新完整校验</button></div><div className="hiw-summary-table"><table><thead><tr><th>数据类别</th><th>新增</th><th>匹配现有</th><th>修正</th><th>幂等跳过</th><th>警告</th><th>阻断</th></tr></thead><tbody>{summary.categories.map((item) => <tr key={item.category}><th>{CATEGORY_LABEL[item.category]}</th><td>{item.add}</td><td>{item.match}</td><td>{item.correct}</td><td>{item.skip}</td><td>{item.warning}</td><td>{item.blocked}</td></tr>)}</tbody></table></div><div className="hiw-review-metrics"><article><span>ECC 聚合项目</span><strong>{summary.eccProjects}</strong></article><article><span>独立记录</span><strong>{summary.independentRecords}</strong></article><article><span>排除来源</span><strong>{summary.excludedSources}</strong></article>{summary.amountTotals.map((amount) => <article key={amount.label}><span>{amount.label}</span><strong>{amount.value}</strong></article>)}</div><div className="hiw-confirm-checks"><p>确认账号：<strong>{summary.confirmedBy}</strong></p><label><input type="checkbox" checked={scopeConfirmed} onChange={(event) => setScopeConfirmed(event.target.checked)} />我已核对七类记录范围、金额和排除来源</label>{summary.warningCount > 0 && <label><input type="checkbox" checked={warningConfirmed} onChange={(event) => setWarningConfirmed(event.target.checked)} />我已查看并确认 {summary.warningCount} 条警告</label>}<p className="hiw-zero-partial">整体提交：任一记录失败，本次全部数据都不会保存。</p></div></div>;
}

function IssueCounts({ issues }: { issues: readonly ImportIssue[] }) { return <div className="hiw-issue-counts">{(['error', 'conflict', 'warning'] as const).map((kind) => <div key={kind} className={`is-${kind}`}><span>{ISSUE_LABEL[kind]}</span><strong>{issues.filter((item) => item.kind === kind).length}</strong></div>)}</div>; }
function OperationBanner({ operation, onCancel }: { operation: HistoryImportWorkspace['operation'] & {}; onCancel: () => void }) { const max = operation.total ?? 100; const value = operation.total ? operation.processed : undefined; return <section className="hiw-operation" aria-label="处理进度"><div><span className="hiw-spinner" aria-hidden="true" /><div><strong>{operation.label}</strong><p>{operation.total ? `已处理 ${operation.processed.toLocaleString('zh-CN')} / ${operation.total.toLocaleString('zh-CN')} 行` : '正在准备可解释的进度…'}</p></div></div><progress max={max} value={value} aria-label={operation.label} />{operation.cancelable && <button onClick={onCancel}>取消处理</button>}</section>; }
function handleDialogKey(event: ReactKeyboardEvent<HTMLElement>, onClose: () => void) {
  if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
  if (event.key !== 'Tab') return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'));
  if (!controls.length) return;
  const first = controls[0]!; const last = controls[controls.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function Dialog({ title, description, firstRef, onClose, children }: { title: string; description: string; firstRef: RefObject<HTMLButtonElement>; onClose: () => void; children: ReactNode }) { return <div className="hiw-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="hiw-dialog" role="dialog" aria-modal="true" aria-labelledby="hiw-dialog-title" onKeyDown={(event) => handleDialogKey(event, onClose)}><button ref={firstRef} className="hiw-dialog-close" aria-label="关闭" onClick={onClose}>×</button><p className="hiw-kicker">请确认</p><h2 id="hiw-dialog-title">{title}</h2><p>{description}</p><div className="hiw-dialog-actions">{children}</div></section></div>; }
function ConflictDialog({ issue, firstRef, onClose, onResolve }: { issue: ImportIssue; firstRef: RefObject<HTMLButtonElement>; onClose: () => void; onResolve: (value: string) => void }) { const [value, setValue] = useState(issue.candidates?.[0]?.value ?? ''); const candidates = useMemo(() => issue.candidates ?? [], [issue]); return <div className="hiw-dialog-backdrop"><section className="hiw-dialog hiw-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title" onKeyDown={(event) => handleDialogKey(event, onClose)}><button ref={firstRef} className="hiw-dialog-close" aria-label="关闭冲突处理" onClick={onClose}>×</button><p className="hiw-kicker">冲突 · {CATEGORY_LABEL[issue.category]}第 {issue.rowIndex + 1} 行</p><h2 id="conflict-title">选择要保留的值</h2><p>{issue.message}</p><div className="hiw-candidates">{candidates.map((candidate) => <label key={`${candidate.value}-${candidate.source}`}><input type="radio" name="candidate" value={candidate.value} checked={value === candidate.value} onChange={() => setValue(candidate.value)} /><span><strong>{candidate.value}</strong><small>{candidate.source}</small></span></label>)}</div><label className="hiw-correction">直接输入修正值<input value={value} onChange={(event) => setValue(event.target.value)} /></label><div className="hiw-dialog-actions"><button onClick={onClose}>取消</button><button className="hiw-primary" disabled={!value.trim()} onClick={() => onResolve(value)}>保存冲突决定</button></div></section></div>; }
