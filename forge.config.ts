import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

/**
 * Forge webpack 配置（Electron Forge 7.11.2）。
 *
 * - WebpackPlugin 支持 mainConfig + renderer(entryPoints)；不支持顶层 preloadConfig。
 * - preload 脚本通过 entryPoints[].preload.js 声明；插件将其构建为
 *   `.webpack/renderer/main_window/preload.js` 并注入
 *   `MAIN_WINDOW_WEBPACK_ENTRY` / `MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY` 常量
 *   （见 src/main/index.ts）。
 * - rendererConfig 不需包含 HtmlWebpackPlugin：插件按 entryPoints 自动注入
 *   （filename: `main_window/index.html`）。
 */
const forgeConfig: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Windows 安装包与升级形态在后续打包验证阶段确定（tasks 0.2）。
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    // macOS 仅为开发机验证使用；交付目标为 Windows。
    new MakerZIP({}, ['darwin', 'linux']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default forgeConfig;
