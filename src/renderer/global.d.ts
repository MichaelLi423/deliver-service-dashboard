/**
 * 渲染层窗口的全局类型声明（preload 注入的最小 API）。
 * 渲染层没有 Node 访问；此声明仅描述 contextBridge 暴露的形状。
 */
import type { WorkbenchApi } from '../shared/ipc';

declare global {
  interface Window {
    workbench: WorkbenchApi;
  }
}

export {};
