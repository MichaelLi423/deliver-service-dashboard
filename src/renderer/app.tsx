import { useEffect, useState, type FormEvent } from 'react';
import type { AccountSessionInfo, WorkbenchApi } from '../shared/ipc';
import { WorkbenchV2 } from './components/workbench-v2';
import './styles.css';

function api(): WorkbenchApi | undefined {
  return (window as unknown as { workbench?: WorkbenchApi }).workbench;
}

const SESSION_EXPIRED_EVENT = 'workbench:session-expired';

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('登录状态已失效')) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  return message;
}

export function App(): JSX.Element {
  const [gate, setGate] = useState<'loading' | 'initialize' | 'recovery' | 'login' | 'code' | 'workbench'>('loading');
  const [session, setSession] = useState<AccountSessionInfo | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [autoBackupError, setAutoBackupError] = useState('');

  useEffect(() => {
    const bridge = api();
    if (!bridge) {
      setGate('initialize');
      return;
    }
    void Promise.all([bridge.getAccountStatus(), bridge.getSession()])
      .then(([status, current]) => {
        setSession(current);
        setAutoBackupError(status.autoBackupError ?? '');
        setGate(current ? 'workbench' : status.initialized ? 'login' : 'initialize');
      })
      .catch(() => setGate('initialize'));
  }, []);

  useEffect(() => {
    const expire = () => {
      setSession(null);
      setGate('login');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
  }, []);

  if (gate === 'loading') return <div className="boot" role="status">正在打开本地工作台…</div>;
  if (gate === 'code') return <RecoveryCode code={recoveryCode} onContinue={() => setGate(session ? 'workbench' : 'login')} />;
  if (gate !== 'workbench') {
    return <AccessGate mode={gate} autoBackupError={autoBackupError} onMode={setGate} onAuthorized={(next, code) => {
      setSession(next);
      if (code) {
        setRecoveryCode(code);
        setGate('code');
      } else setGate('workbench');
    }} />;
  }
  return <WorkbenchV2 session={session!} autoBackupError={autoBackupError} onSessionExpired={() => {
    setSession(null);
    setGate('login');
  }} />;
}

function AccessGate({ mode, autoBackupError, onMode, onAuthorized }: {
  mode: 'initialize' | 'recovery' | 'login';
  autoBackupError?: string;
  onMode: (mode: 'initialize' | 'recovery' | 'login') => void;
  onAuthorized: (session: AccountSessionInfo | null, code?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const bridge = api();
      if (!bridge) throw new Error('当前环境未连接主进程');
      if (mode === 'initialize') {
        const username = String(form.get('username'));
        const result = await bridge.initializeAccount(username, String(form.get('password')));
        onAuthorized({ accountId: result.accountId, username: result.username }, result.recoveryCode);
      } else if (mode === 'login') {
        onAuthorized(await bridge.login(String(form.get('username')), String(form.get('password'))));
      } else {
        const result = await bridge.resetPassword(String(form.get('recoveryCode')), String(form.get('newPassword')));
        onAuthorized(null, result.recoveryCode);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return <main className="access-shell"><section className="access-brand"><div className="brand-mark">RW</div><p>搬迁服务</p><h1>把项目推进放在第一位</h1><div className="access-lines"><span>本机 SQLite 持久化</span><span>单一本地账号访问门</span><span>业务数据不离开本机</span></div></section><section className="access-panel" aria-labelledby="access-title"><div className="access-copy"><span className="overline">搬迁服务工作台</span><h2 id="access-title">{mode === 'initialize' ? '首次使用初始化' : mode === 'login' ? '登录本地工作台' : '使用恢复码重置密码'}</h2><p>{mode === 'initialize' ? '创建唯一的本地账号。完成后会展示一次恢复码，请离线保存。' : mode === 'login' ? '登录后进入项目提醒与高密度项目队列。' : '恢复码使用后立即失效，并生成新的恢复码。'}</p></div><form onSubmit={submit} className="form-stack">{mode !== 'recovery' && <Field name="username" label="用户名" required autoFocus />}{mode === 'recovery' ? <><Field name="recoveryCode" label="恢复码" required autoFocus help="输入此前离线保存的一次性恢复码。" /><Field name="newPassword" label="新密码" type="password" required /></> : <Field name="password" label={mode === 'initialize' ? '密码' : '密码'} type="password" required help={mode === 'initialize' ? '请使用至少 8 位且便于离线管理的密码。' : undefined} />}<InlineError message={error} /><button className="button primary wide" disabled={busy}>{busy ? '正在处理…' : mode === 'initialize' ? '创建账号并继续' : mode === 'login' ? '登录工作台' : '重置密码'}</button></form>{mode === 'login' && <button className="link-button" onClick={() => onMode('recovery')}>忘记密码？使用恢复码</button>}{mode === 'recovery' && <button className="link-button" onClick={() => onMode('login')}>返回登录</button>}{autoBackupError && <p className="inline-warning" role="status">自动备份失败：{autoBackupError}。工作台仍可正常打开，请及时手动备份。</p>}<p className="security-note">本地账号仅作为应用访问门槛，不加密 SQLite。数据文件与备份由 Windows 操作系统账户保护。</p></section></main>;
}

function RecoveryCode({ code, onContinue }: { code: string; onContinue: () => void }) {
  const [copied, setCopied] = useState(false);
  return <main className="access-shell"><section className="access-brand"><div className="brand-mark">RW</div><p>访问恢复</p><h1>只展示这一次</h1></section><section className="access-panel" aria-labelledby="recovery-title"><span className="overline">重要</span><h2 id="recovery-title">离线保存恢复码</h2><p>此恢复码不会再次显示。使用后会失效并生成新恢复码。</p><output className="recovery-code" aria-label="一次性恢复码">{code}</output><div className="row-actions"><button className="button" onClick={() => { void navigator.clipboard?.writeText(code); setCopied(true); }}>{copied ? '已复制' : '复制恢复码'}</button><button className="button primary" onClick={onContinue}>我已离线保存</button></div><p className="security-note">建议写入离线密码管理器或打印保存，避免与数据库备份放在同一位置。</p></section></main>;
}

function Field({ name, label, required = false, help, ...props }: {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const helpId = help ? `${name}-help` : undefined;
  return <div className="field"><label htmlFor={name}>{label} {required && <b>必填</b>}</label><input id={name} name={name} required={required} aria-describedby={helpId} {...props} />{help && <small id={helpId}>{help}</small>}</div>;
}

function InlineError({ message }: { message: string }) {
  return message ? <div className="inline-error" role="alert">{message}</div> : null;
}
