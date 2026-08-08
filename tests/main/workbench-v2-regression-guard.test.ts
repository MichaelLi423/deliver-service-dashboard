import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import { WorkbenchFacade } from '../../src/main/workbench-facade';

/**
 * Oracle #10 收尾回归守卫：
 * 1. 运行时：IPC_CHANNELS 不再暴露旧 snapshot / 整份快照 mutation 通道；
 * 2. 运行时：WorkbenchFacade 原型上不存在 snapshot 与旧 legacy wrapper，v2 入口齐全；
 * 3. 源码：backend（shared/ipc、preload、main）不再出现旧 channel 字符串、
 *    WorkbenchSnapshot 类型或旧业务方法标识符（防止回归）。
 */

/** 已删除的旧通道 key（IPC_CHANNELS 不得再包含）。 */
const REMOVED_CHANNEL_KEYS = [
  'workbenchGetSnapshot',
  'workbenchCreateProject',
  'workbenchSubmitAction',
  'workbenchSetReminder',
  'workbenchClearReminder',
  'workbenchAdjustStatus',
  'workbenchCancelProject',
  'shipToCompleteRequest',
  'invoiceEdit',
  'invoiceRevoke',
];

/** 已删除的旧 channel 字面量（backend 源码不得再出现）。 */
const REMOVED_CHANNEL_STRINGS = [
  'workbench:get-snapshot',
  'workbench:create-project',
  'workbench:submit-action',
  'workbench:set-reminder',
  'workbench:clear-reminder',
  'workbench:adjust-status',
  'workbench:cancel-project',
  'ship-to:complete-request',
  'invoice:edit',
  'invoice:revoke',
];

/** 已删除的旧业务方法标识符（边界上已整体删除；注意领域服务方法名会内部合法调用）。 */
const REMOVED_METHOD_IDENTIFIERS = [
  'getWorkbenchSnapshot',
  'WorkbenchSnapshot',
  'workbenchGetSnapshot',
  'completeShipToRequest',
];

/** 已删除的旧通道在 handler/preload 中的引用（channel key 已删，复合引用必然消失）。 */
const REMOVED_CHANNEL_REFERENCES = [
  'IPC_CHANNELS.workbenchGetSnapshot',
  'IPC_CHANNELS.workbenchCreateProject',
  'IPC_CHANNELS.workbenchSubmitAction',
  'IPC_CHANNELS.workbenchSetReminder',
  'IPC_CHANNELS.workbenchClearReminder',
  'IPC_CHANNELS.workbenchAdjustStatus',
  'IPC_CHANNELS.workbenchCancelProject',
  'IPC_CHANNELS.shipToCompleteRequest',
  'IPC_CHANNELS.invoiceEdit',
  'IPC_CHANNELS.invoiceRevoke',
];

/** 必须保留的 v2 / 独立通道。 */
const KEPT_CHANNEL_KEYS = [
  'workbenchV2Overview',
  'workbenchV2ProjectPage',
  'workbenchV2ProjectDetail',
  'workbenchV2SectionPage',
  'workbenchV2IndependentPage',
  'workbenchV2LookupPage',
  'workbenchV2Mutate',
  'shipToCreateRequest',
  'shipToSubmitRequest',
  'reportBuild',
  'reportDrillDown',
  'reportExport',
  'backupManual',
  'restoreFromBackup',
];

const BACKEND_FILES = [
  'src/shared/ipc.ts',
  'src/preload/index.ts',
  'src/main/ipc-handlers.ts',
  'src/main/workbench-facade.ts',
];

function readBackend(): string[] {
  return BACKEND_FILES.map((f) => readFileSync(join(process.cwd(), f), 'utf8'));
}

describe('Oracle #10 收尾回归守卫：旧 snapshot 通道与整份快照 API 已从 backend 移除', () => {
  it('运行时：IPC_CHANNELS 不再暴露旧 channel，且保留 v2 与账号/备份/报表通道', () => {
    for (const key of REMOVED_CHANNEL_KEYS) {
      expect(IPC_CHANNELS, `旧通道 ${key} 不应存在`).not.toHaveProperty(key);
    }
    for (const key of KEPT_CHANNEL_KEYS) {
      expect(IPC_CHANNELS, `保留通道 ${key} 应存在`).toHaveProperty(key);
    }
    // 旧 channel 字符串不再作为任何值
    const values = Object.values(IPC_CHANNELS);
    for (const str of REMOVED_CHANNEL_STRINGS) {
      expect(values, `旧 channel 字面量 ${str} 不应存在`).not.toContain(str);
    }
  });

  it('运行时：WorkbenchFacade 无 snapshot / 旧 wrapper，v2 读写入口齐全', () => {
    const proto = WorkbenchFacade.prototype as unknown as Record<string, unknown>;
    expect(proto.snapshot).toBeUndefined();
    for (const name of ['createProject', 'submitAction', 'setReminder', 'clearReminder', 'adjustStatus', 'cancelProject', 'completeShipToRequest', 'editInvoice', 'revokeInvoice']) {
      expect(proto, `旧 wrapper ${name} 不应存在`).not.toHaveProperty(name);
    }
    for (const name of ['v2Overview', 'v2ProjectPage', 'v2ProjectDetail', 'v2SectionPage', 'v2IndependentPage', 'v2LookupPage', 'v2Mutate', 'createShipToRequest', 'submitShipToRequest']) {
      expect(proto, `v2 入口 ${name} 应存在`).toHaveProperty(name);
    }
  });

  it('源码守卫：backend 源码不再包含旧 channel 字符串 / WorkbenchSnapshot / 旧通道引用', () => {
    const sources = readBackend();
    const all = sources.join('\n');
    for (const str of REMOVED_CHANNEL_STRINGS) {
      expect(all, `backend 源码不应包含旧 channel 字面量 ${str}`).not.toContain(str);
    }
    for (const id of REMOVED_METHOD_IDENTIFIERS) {
      // 精确标识符（\b 边界；writeCreateProject 等派生名不影响 createProject 判定）
      const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      expect(re.test(all), `backend 源码不应包含旧标识符 ${id}`).toBe(false);
    }
    for (const ref of REMOVED_CHANNEL_REFERENCES) {
      expect(all, `backend 源码不应包含旧通道引用 ${ref}`).not.toContain(ref);
    }
    // v2 入口在 preload 中已接线
    const preload = sources[1];
    for (const method of ['v2Overview', 'v2ProjectPage', 'v2ProjectDetail', 'v2SectionPage', 'v2IndependentPage', 'v2LookupPage', 'v2Mutate']) {
      expect(preload, `preload 应暴露 ${method}`).toContain(method);
    }
  });
});
