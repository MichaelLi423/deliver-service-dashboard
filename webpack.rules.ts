import type { Configuration } from 'webpack';

/**
 * 共享 webpack 规则。
 * ts-loader 采用 transpileOnly，类型检查由 `npm run typecheck`（tsc --noEmit）单独执行，
 * 保持增量构建速度与类型安全分离。
 */
export const rules: Configuration['module'] = {
  rules: [
    {
      test: /\.node$/,
      use: 'node-loader',
    },
    {
      test: /\.(m?js|node)$/,
      parser: { amd: false },
      use: {
        loader: '@vercel/webpack-asset-relocator-loader',
        options: {
          outputAssetBase: 'native_modules',
        },
      },
    },
    {
      test: /\.tsx?$/,
      exclude: /(node_modules|\.webpack)/,
      use: {
        loader: 'ts-loader',
        options: {
          transpileOnly: true,
        },
      },
    },
    {
      test: /\.css$/,
      use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
    },
  ],
};
