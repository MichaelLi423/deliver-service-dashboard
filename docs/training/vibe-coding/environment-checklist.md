# 环境与前置条件核对清单

本清单服务于 90 分钟、28 页的《Vibe Coding》课程，是课程环境的唯一事实来源：版本附录、前置条件、项目自检命令与归档漂移声明。项目段打开 OpenCode 已有历史会话讲解已有输出，不重新运行 Agent 或历史命令。**只记录已确认的信息，不声称未运行的命令已通过。** 环境只给平台无关概览，不分发个人配置。

最后核对日期：2026-08-13。

## 版本附录（截至 2026-08-13，以官网/上游为准）

主叙事不依赖补丁版本；版本只在课前 T-1 天从这里核对一次。所有工具持续演进，讲课时一律说"以官网/上游为准"。

| 项目 | 版本 | 来源 |
| --- | --- | --- |
| Node.js | >= 20.19.0（OpenSpec 前置要求） | [openspec.dev](https://openspec.dev) |
| OpenCode（npm `opencode-ai`） | 研究时 1.18.18 | [opencode.ai](https://opencode.ai) |
| OpenSpec（npm `@fission-ai/openspec`） | 1.8.0 | [openspec.dev](https://openspec.dev) |
| skills CLI | 研究时 1.5.22 | skills.sh / 上游仓库 |
| oh-my-opencode-slim | 研究时 2.2.13 | [github.com/alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) |
| MCP 协议规范 | 以官网当前版本为准 | [modelcontextprotocol.io](https://modelcontextprotocol.io) |

注意：

- OpenCode 仓库组织曾迁移，公开材料一律以 [opencode.ai](https://opencode.ai) 为准。
- OpenSpec 命令持续演进，具体命令以官方文档为准。
- oh-my-opencode-slim 是第三方社区插件，**不是** OpenCode 官方组件。配置默认在用户级 `~/.config/opencode/oh-my-opencode-slim.json(c)`，项目级 `.opencode/oh-my-opencode-slim.json` 是**可选**的项目覆盖；安装不会创建 agent 目录。后台编排依赖环境变量 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`；整体禁用 `OH_MY_OPENCODE_SLIM_DISABLE=1`。
- mattpocock/skills 是个人技能集合，**不是** Agent Skills 开放标准的官方实现。
- MCP 是开放协议，**不是**需要安装的单一运行时；本项目无 MCP 配置，本课不演示。
- OpenCode 权限为三值 allow/ask/deny：默认多数操作为 allow，命中 ask 才请求批准，deny 直接拒绝；本课回放显式切 Plan，Plan 默认对编辑/bash 设 ask。

## 本仓库项目状态（已核对 2026-08-13）

| 项 | 状态 |
| --- | --- |
| `.opencode/commands/opsx-*` | 已有：opsx-propose / opsx-apply / opsx-verify / opsx-archive / opsx-explore / opsx-sync / opsx-update |
| `skills-lock.json` | 为空（`{"version":1,"skills":{}}`，未锁定任何技能） |
| MCP 配置 | 仓库无 MCP 配置文件 |
| 技术栈 | Electron + React + TypeScript + 本地 SQLite；测试为 Vitest + Playwright |

### 归档漂移声明（必读）

- 课程演示依托的原 `add-relocation-service-workbench` change **已归档**，落点 `openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`，不再是进行中 change。
- 当前正式 spec `openspec/specs/workbench-todos/spec.md` 仍是**旧两场景版本**（默认 7 天、可配置并立即生效），**不含** 0 语义、安全整数、保存前不生效、保存后立即刷新、持久化、日期可见等训练边界。
- 四阶段最终实现只存在于远端培训分支 `origin/training/vibe-coding-reminder-window`，**未合入 main**；当前 main 没有 `set_window_days` 变更操作，也没有"临期窗口"配置 UI。
- 课程使用 [training-change/](./training-change/README.md) 冻结教学叙事；它是静态教学材料，OpenSpec CLI 只扫描 `openspec/changes/`，不会把它当活动产品 change。

区分口径（贯穿课程）：

- **项目已有**：`.opencode/commands/opsx-*` 命令。
- **讲师示例（历史培训证据）**：四阶段快照 baseline `76747c1` → red-test `f771667` → preset-failure `0554164` → green-final `d304bd5`，位于远端培训分支；不是产品交付。
- **培训夹具**：[training-change/](./training-change/README.md) 静态教学叙事材料（无 design.md；evidence.md 为课程自定义证据文件，非标准 OpenSpec artifact），无批准语义。
- **可选扩展（本课不演示）**：skills（`skills-lock.json` 为空）、MCP（仓库无配置）、oh-my-opencode-slim。

## 前置条件

1. 操作系统：讲师演示机与学员环境不限平台；课程只给平台无关概览。
2. Node.js >= 20.19.0（项目 README 记录开发机 v24.15.0）。
3. 终端可运行 `npm` 脚本（详见下方项目自检命令）。
4. 演示需可用网络？历史会话应在课前确认可访问；现场不重新调用 Agent 或执行历史命令。会话不可访问时使用已脱敏讲师笔记与现有证据摘要兜底，不依赖外部模型服务。

## 项目自检命令

以下命令在仓库根目录运行。**未运行的命令标记为"未运行"，不以任何形式声称已通过。** 历史 green-final 证据来自 2026-08-10 macOS arm64 开发机，只能作为历史证据引用，不代表本次课前已重跑。

| 命令 | 目的 | 状态 |
| --- | --- | --- |
| `npm run typecheck` | TypeScript 类型检查 | 课前运行后登记日期 |
| `npx vitest run` | Vitest 单元/集成测试 | 课前运行后登记日期 |
| `npm test` | package script，等价调用 vitest run | 未运行（等价命令） |
| `npm run verify:matrix` | 构建验证矩阵 | 未运行 |
| `npm run e2e:build` | 打包 Electron（Playwright 前置步骤） | 未运行 |
| `npm run test:e2e` | 完整 Playwright 套件 | 未运行 |
| `npx playwright test e2e/workbench-v2-layout.spec.ts` | 单文件布局 E2E | 未运行 |
| `npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict` | 原 change strict 校验 | 不现场运行：change 已归档，当前 HEAD 不能重跑；仅展示 2026-08-10 历史输出。strict 只校验 CLI 校验到的规格格式、requirement/scenario 结构与可解析性，不证明 proposal/design/tasks 完成度或行为 |

> 原 change 已归档，`openspec validate` 不再针对它运行；课程引用的是历史证据，见 [training-change/evidence.md](./training-change/evidence.md)。

## 四阶段历史证据（培训分支，非产品交付）

| 阶段 | commit | 关键证据（2026-08-10 macOS arm64） |
| --- | --- | --- |
| baseline | `76747c1` | typecheck 通过；4 个聚焦文件 83 tests 通过 |
| red-test | `f771667` | typecheck 通过；domain+integration 32 通过；main 新增 2 项 `V2_MUTATION_UNKNOWN` 失败；renderer 新增 1 项控件未找到失败 |
| preset-failure | `0554164` | typecheck 通过；domain+integration 32 通过；main 仅 0 用例因"必须不小于 1"失败（负数/非整数通过）；renderer 仅 0 保存客户端拒绝且未调用 mutation |
| green-final | `d304bd5` | typecheck 通过；4 个聚焦文件 95 tests 通过；全量 93 files/1076 tests；strict 通过（Change is valid）；`npm run e2e:build` 通过；布局 E2E 1/1 |

以上证据不代表 Windows 平台验证，也不代表产品批准。`380ad38` 是叙事外中间提交，不作为阶段展示。机器执行证据逐项边界：tests 只证明被断言的特定行为；typecheck 只证明类型一致性；build/package 只证明可构建、可打包；E2E 只证明特定环境、特定路径的特定行为。

## 使用说明

- 每次课前在演示机上运行上表命令，并更新状态列日期。
- 未运行、未确认的内容保持"未运行"，不要改写为通过。
- 工具教程的 grill-with-docs / tdd / diagnosing-bugs（diagnosis 入口）/ code-review 四技能与 MCP 边界见 [tool-roles.md](./tool-roles.md)。
- 本清单与 [tool-roles.md](./tool-roles.md)、[demo-runbook.md](./demo-runbook.md)、[presenter-preparation.md](./presenter-preparation.md) 配套使用。
