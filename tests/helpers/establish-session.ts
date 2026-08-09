/**
 * 无密码个人模式下建立访问会话的测试助手。
 * 共享 IPC 公共接口不再提供登录通道，测试直接通过账号服务确保本地账号并写入会话
 * （与主进程启动/恢复时的 ensureLocalSession 接线同路径）。
 */
import type { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import type { AccountSessionInfo } from '../../src/shared/ipc';

export async function establishLocalSession(
  accountService: () => LocalAccountService,
  setSession: (session: AccountSessionInfo | null) => void,
): Promise<AccountSessionInfo> {
  const session = await accountService().ensureLocalSession();
  const info: AccountSessionInfo = { accountId: session.accountId, username: session.username };
  setSession(info);
  return info;
}
