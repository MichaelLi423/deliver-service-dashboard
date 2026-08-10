# 项目开发规则

- 每次完成代码或文档修改后，检查实际 diff，提交本次相关改动并推送到远程仓库；不要把已完成的修改仅留在本地工作区。

## 命令与验证

- 脚本命令：`npm run typecheck`=tsc --noEmit；`npm test`=vitest run；`npm run test:e2e`=playwright test；`npm run e2e:build`=electron-forge package；`npm run verify:matrix`=node scripts/build-verification-matrix.mjs。
- webpack 的 ts-loader 为 transpileOnly，打包/测试通过不代表类型正确；类型必须走 `npm run typecheck`。
- 单测用 focused：`npx vitest run tests/<路径>test.ts`。Vitest 只收集 `tests/**/*.test.{ts,tsx}`，默认 node 环境；DOM 相关用例必须在文件顶部写 `@vitest-environment jsdom`。
- 全量 `npm test` 含 100k/50k 性能用例耗时很长，优先 focused 验证。
- E2E 前必须先 `npm run e2e:build`，否则用例会 skip 而非失败。产物为 macOS arm64 中文版应用；playwright 需 workers=1。
- 真实源只读测试需 `RUN_REAL_SOURCE_READONLY=1`，依赖 `docs` 下被 gitignore 的真实 xlsx，最长约 6 分钟。

## 敏感数据

- `docs` 下 5 个真实 xlsx 和 1 个 pptx 是客户敏感数据且已 gitignore：禁止修改、读取/打印业务值、stage 或 commit；只读验证仅可输出脱敏哈希/计数。

## 规格与证据

- OpenSpec 基线在 `openspec/changes/add-relocation-service-workbench/`，仓库没有 `openspec/specs/`；规格与实现冲突时以规格为准，领域语言以 `CONTEXT.md` 为准。
- `verify:matrix` 从该 change 的 `specs` 扫规格，按 `docs/verification/scenario-map.mjs` 的 [文件, 关键词] 校验证据，并重写已跟踪的 `scenario-test-matrix.md`；改动关键词会破坏证据匹配。
- `tests/interface/README.md` 已过期（登录/恢复码、四步向导已不存在），现状是无密码个人模式，不得据其判断实现。

## 架构事实

- 真实入口：`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.tsx`；`package.json` 的 main 指向 `.webpack/main`，是构建产物。
- renderer 无 Node 环境，只能经 preload+IPC 访问主进程；共享 IPC 契约唯一来源是 `src/shared/ipc.ts`。SQLite 仅在主进程使用。
- 数据库迁移用 `PRAGMA user_version`；只追加新迁移，不修改已发布迁移；新增 schema 版本必须配迁移测试。
- 金额是"分"整数，用 BigInt；DB 读取用 `prepareReadBigInt`。业务日期用 `yyyy-mm-dd`，审计时间用 ISO。
- 状态转换与校验的唯一入口是 `lifecycle.ts`。

## 环境与边界

- 仓库没有 lint/formatter/CI/hook，不要杜撰对应命令。
- 仓库未声明 Node 最低版本，但 `node:sqlite`/`setReadBigInts` 需较新 Node，README 记录开发机 v24.15.0；未经验证不要写死最低版本。
- 不要触碰与本任务无关的未跟踪内容 `docs/issue/` 与 `docs/training/vibe-coding/`。
