# 环境与前置条件核对清单

本清单是课程环境的唯一事实来源：官方版本、前置条件、项目自检命令与最后验证日期。**本清单只记录已确认的信息，不声称未运行的命令已通过。** 环境只给平台无关概览，不分发个人配置。

最后核对日期：2026-08-10。

## 官方版本（截至 2026-08-10，以官网为准）

| 项目 | 版本 | 来源 |
| --- | --- | --- |
| Node.js | >= 20.19.0（OpenSpec 前置要求） | [openspec.dev](https://openspec.dev) |
| OpenCode（npm `opencode-ai`） | 1.18.16 | [opencode.ai](https://opencode.ai) |
| OpenSpec（npm `@fission-ai/openspec`） | 1.8.0 | [openspec.dev](https://openspec.dev) |
| oh-my-opencode-slim（npm） | 2.2.11 | [github.com/alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) |
| MCP 协议规范 | 2026-07-28 | [modelcontextprotocol.io](https://modelcontextprotocol.io) |

注意：

- OpenCode 仓库组织曾迁移，公开材料一律以 [opencode.ai](https://opencode.ai) 为准。
- OpenSpec 命令持续演进，具体命令以官方文档为准。
- oh-my-opencode-slim 是第三方社区插件，**不是** OpenCode 官方组件。
- MCP 是开放协议，**不是**需要安装的单一运行时。

## 本仓库项目状态（已核对 2026-08-10）

| 项 | 状态 |
| --- | --- |
| `.opencode/commands/opsx-*` | 已有：opsx-propose / opsx-apply / opsx-verify / opsx-archive / opsx-explore / opsx-sync / opsx-update |
| `skills-lock.json` | 为空（`{"version":1,"skills":{}}`，未锁定任何技能） |
| MCP 配置 | 仓库无 MCP 配置文件 |
| 技术栈 | Electron + React + TypeScript + 本地 SQLite；测试为 Vitest + Playwright |

区分口径（贯穿课程）：

- **项目已有**：`.opencode/commands/opsx-*` 命令。
- **讲师示例**：演示分支上的四阶段快照（baseline → red-test → preset-failure → green-final，见 [demo-runbook.md](./demo-runbook.md)），属于培训夹具，不是产品交付。
- **可选扩展**：skills、MCP、oh-my-opencode-slim 等，本演示不使用。

## 前置条件

1. 操作系统：讲师演示机与学员环境不限平台；课程只给平台无关概览。
2. Node.js >= 20.19.0（项目 README 记录开发机 v24.15.0）。
3. Git 已安装，可创建 worktree 与切换分支。
4. 终端可运行 `npm` 脚本（详见下方项目自检命令）。
5. 演示需可用网络？不需要——演示为阶段快照回放，不现场调用 Agent，不依赖外部模型服务。

## 项目自检命令

以下命令在仓库根目录运行。**未运行的命令标记为"未运行"，不以任何形式声称已通过。**

| 命令 | 目的 | 最后验证日期 |
| --- | --- | --- |
| `npm run typecheck` | TypeScript 类型检查（四阶段均通过） | 2026-08-10 已验证 |
| `npx vitest run` | 运行 Vitest 单元/集成测试（green-final 全量 93 files/1076 tests） | 2026-08-10 已验证 |
| `npm test` | package script，等价调用 vitest run | 未运行（本轮实际以 `npx vitest run` 验证） |
| `npm run verify:matrix` | 构建验证矩阵（`node scripts/build-verification-matrix.mjs`） | 未运行 |
| `npm run e2e:build` | 打包 Electron（Playwright 前置步骤，green-final 通过，macOS arm64） | 2026-08-10 已验证 |
| `npm run test:e2e` | 运行 Playwright 端到端测试（完整套件） | 未运行 |
| `npx playwright test e2e/workbench-v2-layout.spec.ts` | 单文件布局 E2E（green-final 1/1 通过） | 2026-08-10 已验证 |
| `npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict` | OpenSpec 结构校验（Change is valid） | 2026-08-10 已验证 |
| `git worktree list` | 确认四阶段快照 worktree 就绪 | 未运行 |

## 演示快照（已回填 2026-08-10）

四阶段快照 commit 已确定，见 [demo-runbook.md](./demo-runbook.md)：

- baseline = `76747c1`
- red-test = `f771667`
- preset-failure = `0554164`
- green-final = `d304bd5`

均为培训夹具，不是产品交付。

## 使用说明

- 每次课前在演示机上运行上表命令，并更新"最后验证日期"。
- 未运行、未确认的内容保持"未运行"字样，不要改写为通过。
- 本清单与 [tool-roles.md](./tool-roles.md)、[demo-runbook.md](./demo-runbook.md) 配套使用。
