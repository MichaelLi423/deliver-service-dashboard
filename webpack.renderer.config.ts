import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';

/**
 * 渲染层 webpack 配置（Electron Forge webpack-typescript 模板风格）。
 *
 * - 不包含 HtmlWebpackPlugin：@electron-forge/plugin-webpack 会按
 *   forge.config.ts 的 entryPoints 自动注入（filename: `main_window/index.html`）。
 * - preload 复用本配置（插件合并后 target 为 sandboxedPreload/electron-preload）。
 * - 渲染层不使用任何原生模块（node:sqlite 等仅主进程使用），因此移除
 *   node-loader / @vercel/webpack-asset-relocator-loader 规则，避免把
 *   `__dirname` 等 Node 运行时引用注入沙箱渲染层导致运行时崩溃
 *   （`ReferenceError: __dirname is not defined`）。
 */
const rendererRules = (rules?.rules ?? []).filter((rule) => {
  if (typeof rule !== 'object' || rule === null) {
    return true; // 布尔/字符串/省略等非对象规则保留
  }
  const use = Array.isArray(rule.use) ? rule.use : [rule.use];
  const loaderNames = use
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') return entry.loader ?? '';
      return '';
    })
    .join(',');
  return !loaderNames.includes('node-loader') && !loaderNames.includes('asset-relocator');
});

export const rendererConfig: Configuration = {
  module: {
    rules: rendererRules,
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
