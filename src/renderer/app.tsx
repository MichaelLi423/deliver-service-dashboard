import { useEffect, useState } from 'react';
import type { AccountSessionInfo, WorkbenchApi } from '../shared/ipc';
import { WorkbenchV2 } from './components/workbench-v2';
import './styles.css';

function api(): WorkbenchApi | undefined {
  return (window as unknown as { workbench?: WorkbenchApi }).workbench;
}

/**
 * 无密码个人模式入口：主进程在启动/恢复时已自动确保本地账号并建立访问会话，
 * 渲染层不再提供初始化/登录/密码重置/恢复码界面，应用启动后直接进入工作台。
 */
export function App(): JSX.Element {
  const [session, setSession] = useState<AccountSessionInfo | null>(null);
  const [autoBackupError, setAutoBackupError] = useState('');
  const [bootError, setBootError] = useState('');

  useEffect(() => {
    const bridge = api();
    if (!bridge) {
      setBootError('当前环境未连接主进程');
      return;
    }
    void bridge
      .getSession()
      .then((current) => {
        if (!current) throw new Error('未建立本地访问会话');
        setSession(current);
        return bridge.getAccountStatus();
      })
      .then((status) => setAutoBackupError(status.autoBackupError ?? ''))
      .catch(() => setBootError('无法打开本地工作台，请检查本地数据库'));
  }, []);

  if (bootError) {
    return (
      <div className="boot" role="alert">
        {bootError}
      </div>
    );
  }
  if (!session) {
    return (
      <div className="boot" role="status">
        正在打开本地工作台…
      </div>
    );
  }
  return (
    <WorkbenchV2
      session={session}
      autoBackupError={autoBackupError}
      onSessionRestored={setSession}
    />
  );
}
