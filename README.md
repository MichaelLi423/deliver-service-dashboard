# 搬迁服务工作台

面向搬迁负责人的**个人离线 Windows 桌面工作台**。它将搬迁服务从进单、执行记录、验收，到费用与掉票闭环集中在本机管理，并提供运营报表、历史数据导入以及本地备份与恢复能力。

本项目使用 Electron、React、TypeScript 与本地 SQLite 构建；不依赖云端服务。业务术语以 [CONTEXT.md](CONTEXT.md) 为准，使用操作见[用户手册](docs/系统用户手册/搬迁服务工作台用户手册.md)。

## 核心功能

- **项目工作台**：手工维护项目提醒与高密度项目队列，覆盖待进单、执行、验收、掉票及完成等流程。
- **业务记录**：维护搬迁批次与物流费用、仪器、开单、验收报告、掉票、Ship-to 申请、序列号地址更新、损坏维修与二维码申请。
- **运营报表**：按手工选择的月份区间实时计算，可导出 Excel（`.xlsx`）、PNG 与 PDF。
- **历史数据导入**：仅通过工作台内向导导入，支持模板、Excel 文件或矩形粘贴；完整校验、封存和原子提交避免部分写入。
- **本地数据保护**：每日首次使用自动备份（保留最近 7 份），并支持手动备份与原子恢复。

## 产品边界

- 仅供个人单机、Windows 桌面环境使用；应用启动后直接进入工作台。
- 数据保存在本机 SQLite；不接入远程数据库、云同步、外部业务系统或外部消息提醒。
- 当前不提供多用户、注册、角色或权限管理，也没有应用内密码登录与恢复码。
- SQLite 与备份文件**不加密**。请使用 Windows 账户、文件系统 ACL 和磁盘加密（如 BitLocker）保护 `userData` 与备份目录。
- 内部唯一“本地用户”只用于录入事实、工作量和审计的归属快照，不能保护数据库文件。

更完整的运行与安全边界见 [ADR-0001](docs/adr/0001-windows-desktop-local-sqlite.md) 与[迁移执行与运维说明](docs/verification/迁移执行与运维说明.md)。

## 技术栈

- Electron Forge + webpack
- React 18 + TypeScript
- Node 内置 `node:sqlite` 与本地 SQLite
- Vitest、Testing Library 与 Playwright
- ExcelJS、PDF-Lib、PNGJS

## 快速开始

### 环境要求

- Node.js：仓库未声明最低版本。请使用团队已验证的较新 Node.js 环境，并以 `npm install`、类型检查和测试结果为准。
- Windows 是交付目标；开发与验证可在其他环境进行，但其他环境的结果不等同于 Windows 验证。

### 安装与开发运行

```bash
npm install
npm start
```

`npm start` 以开发模式启动应用。业务数据位于 Electron 的 `userData` 目录；开发、测试与真实业务数据应使用相互隔离的数据目录。

## 构建与发布

```bash
npm run package  # 打包未安装的应用目录
npm run make     # 生成安装包；Windows 使用 MakerSquirrel
```

Windows 是交付目标。macOS 开发机上的打包或 E2E 结果只说明该开发环境中的特定路径可运行，不能代替 Windows 验证。

`npm run publish` 是已定义的 Forge 命令；仓库当前未配置发布目标，请勿将其视为可直接发布的流程。

## 测试与验证

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 执行 `tsc --noEmit`；webpack 的转译不代表类型正确。 |
| 单元与集成测试 | `npm test` | 执行 `vitest run`；全量用例可能耗时较长。 |
| 监听测试 | `npm run test:watch` | 执行 Vitest 监听模式。 |
| 打包 E2E 产物 | `npm run e2e:build` | **必须先于 E2E 执行**。 |
| E2E | `npm run test:e2e` | 执行 Playwright 测试真实打包产物。 |
| 场景矩阵 | `npm run verify:matrix` | 生成并校验场景到测试证据矩阵。 |

针对单个 Vitest 用例，可使用：

```bash
npx vitest run tests/<路径>.test.ts
```

测试、类型检查、构建和 E2E 证明的范围不同：它们只证明实际断言、类型、构建环境或特定路径，不能单独证明所有行为和所有平台均已验证。

## 架构与目录

```text
src/
├── main/       # Electron 主进程、窗口与 IPC handlers
├── preload/    # 向渲染进程暴露的最小 API
├── renderer/   # React 工作台界面
├── shared/     # 共享 IPC 契约（ipc.ts）
└── domain/     # 领域能力、生命周期、SQLite 持久化与迁移
tests/          # Vitest 测试
e2e/            # Playwright 打包产物 E2E
docs/           # 需求、用户手册、ADR、运维与培训资料
openspec/       # 规格变更及归档
scripts/        # 验证辅助脚本
```

架构约束：渲染进程不直接访问 Node.js 或 SQLite，所有此类访问都经 preload 与 IPC；共享 IPC 契约以 [`src/shared/ipc.ts`](src/shared/ipc.ts) 为唯一来源。数据库仅在主进程使用，schema 升级使用 `PRAGMA user_version`。金额以“分”的整数计算，业务日期使用 `yyyy-mm-dd`；项目状态转换与校验集中在生命周期模块。

原 `add-relocation-service-workbench` 变更已归档至 [`openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`](openspec/changes/archive/2026-08-10-add-relocation-service-workbench/)。新增产品能力应建立新的正式变更，不应把培训材料当作产品规格。

## 数据、备份与安全

Electron `userData` 下的主要目录如下：

| 路径 | 用途 |
| --- | --- |
| `data/workbench.db` | 本机业务 SQLite 数据库（不加密） |
| `backups/auto/` | 每日自动备份，保留最近 7 份 |
| `backups/manual/` | 手动备份输出 |
| `restore-snapshots/` | 恢复前安全快照 |
| `import-workspace/` | 历史导入草稿与校验工作区 |
| `import-snapshots/` | 导入提交前安全快照 |

恢复前会检查备份可读性并创建安全快照；恢复或导入失败不会以部分数据覆盖当前业务库。历史导入是工作台内“数据管理 → 历史数据导入”向导的唯一入口，不提供外部导入 CLI。导入真实业务数据前，请先完成备份并在向导内处理全部阻断错误和冲突。

## Vibe Coding：受控的 AI 辅助开发

这里的 Vibe Coding 指**受控 AI 辅助开发**，不是“凭感觉接受生成结果”：人负责目标、约束、关键决策和验收证据，AI 协助阅读、分析、实现与整理。无论任务大小，目标、边界和验证证据都不能省略。

### 开始前三问

动手前先把下面三件事写清楚；答案应可观察、可验证：

1. **目标是什么？** 例如“保存后提醒列表按新规则刷新”，而不是“优化提醒”。
2. **边界是什么？** 哪些行为、数据、接口、平台不能改变？是否涉及敏感数据、依赖、数据迁移或发布？
3. **如何证明完成？** 指定测试、类型检查、构建、人工验收或文档核对，并说明每项证据的范围。

有歧义时先澄清，不让 AI 自行猜测业务规则；涉及数据、安全、依赖、合并或发布的操作必须由人确认。

### 一次可回看的实现闭环

1. **规格化需求**：将目标收敛为范围、非目标和可验收场景。复杂产品变更使用正式 OpenSpec；小改动也至少留下简短、明确的任务约定。
2. **选择入口**：已知正确行为时走 **TDD**——先写会失败的测试（Red），再做最小实现使其通过（Green）；未知故障原因时走 **diagnosis**——先复现、最小化、提出假设并收集证据，定位后再修改。
3. **最小实现**：每次只解决一个已知问题，不顺带重构或扩大范围。让 AI 先说明将改哪些文件和原因，再审阅实际 diff。
4. **双重检查**：代码评审关注安全、清晰与可维护；规范核对逐条确认约定行为与证据。二者互补，不能互相替代。
5. **验证闭环**：运行与改动匹配的验证，记录真实命令和结果；若发现偏差，返回相应步骤修正，而不是把失败解释为“差不多完成”。

### 风险决定投入，不决定是否负责

| 风险 | 常见信号 | 应对 |
| --- | --- | --- |
| 低 | 范围小、行为可观察 | 简短约定、聚焦测试、审阅 diff。 |
| 中 | 跨模块、局部接口或持久化影响 | 增加场景、集成验证和评审深度。 |
| 高 | 数据/安全、公共 API、大范围变更、业务歧义 | 先完成澄清与规格，执行完整测试、评审和人工确认。 |

AI 适合承担仓库阅读、候选方案、受限实现和测试辅助；人必须保留对业务定义、风险取舍、敏感信息、破坏性操作与最终合入的责任。不要上传客户数据或密钥，也不要给予 AI 生产环境权限。

### 常见误区

- 只给一句模糊提示就直接接受大量改动；应先明确验收标准和非目标。
- 把“测试通过”写成“全部正确”；测试只证明被断言的行为。
- 用 TDD 处理尚未定位的故障，或跳过诊断直接猜修复；两种入口的第一步不同。
- 只看 AI 的文字总结，不看 diff、命令输出和失败原因。
- 把培训夹具当作当前产品功能或正式规格。

更多可操作材料见 [Vibe Coding 培训首页](docs/training/vibe-coding/README.md)、[工作流检查清单](docs/training/vibe-coding/workflow-checklist.md) 与[工具角色说明](docs/training/vibe-coding/tool-roles.md)。其中 `training-change/` 是冻结的**培训夹具**，用于教学叙事，不是当前产品功能、正式 OpenSpec 变更或待合入实现。

## 文档导航

| 文档 | 适用对象 | 内容 |
| --- | --- | --- |
| [CONTEXT.md](CONTEXT.md) | 全员 | 领域术语与时间口径。 |
| [需求规格](docs/搬迁服务工作台.md) | 产品、开发 | 已确认业务规则与范围。 |
| [用户手册](docs/系统用户手册/搬迁服务工作台用户手册.md) | 使用者 | 安装、操作和常见问题。 |
| [ADR-0001](docs/adr/0001-windows-desktop-local-sqlite.md) | 开发、运维 | Windows 桌面与本地 SQLite 的架构决策。 |
| [迁移执行与运维说明](docs/verification/迁移执行与运维说明.md) | 负责人、运维 | 数据目录、备份恢复、历史导入和验证边界。 |
| [场景—测试矩阵](docs/verification/scenario-test-matrix.md) | 开发、测试 | 场景与测试证据的对应关系。 |
| [Vibe Coding 培训](docs/training/vibe-coding/README.md) | 新手、讲师 | 受控 AI 辅助开发课程与资料导航。 |

## 贡献

提交改动前，请先阅读领域术语、相关规格和现有测试；保持变更最小，并在 PR 中说明目标、边界、验证命令及其实际结果。涉及数据库迁移、IPC 契约、生命周期规则或数据安全的改动，应补充相应的测试与评审证据。

请勿提交真实客户文件、密钥或其他敏感数据。历史数据导入资料中的真实 Excel/PPTX 不应读取、修改或加入版本控制。

## 许可证与状态

- 当前版本：`0.1.0`，`private: true`。
- 仓库包含 [Apache License 2.0](LICENSE) 文本；但 `package.json` 的 `license` 字段为 `UNLICENSED`。发布或复用前应先由维护者澄清这两处许可证信息的适用关系。
- 本项目为个人离线 Windows 工作台；未承诺云同步、多用户或角色权限等后续能力。
