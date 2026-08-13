# 工具角色（tool-roles）

本课（90 分钟、34 页，全静态回放）工具**按职责讲，不按产品记**：先理解每类工具承担什么职责，具体产品只是实现该职责的示例。三套关键工具深入"是什么/为什么/怎么用"；MCP 只讲边界。版本一律"以官网/上游为准"，具体数字见 [environment-checklist.md](./environment-checklist.md)。

## 职责一览

| 职责 | 需要做的事 | 本课示例 | 定位 |
| --- | --- | --- | --- |
| 编辑器 | 查看代码、编辑、看 diff | 讲师自选 | 不分发个人配置，平台无关 |
| 终端 | 运行测试、git、切换快照 | 系统终端 | 现场只运行测试、查看 diff、切换快照、操作 UI |
| AI 编码会话 | 在人的约束下辅助分析与实现 | OpenCode | 本课会话单元；"是什么/为什么/怎么用"见下 |
| 技能包 | 把高频工作流固化为可复用技能 | mattpocock/skills | 个人技能集合，非官方标准 |
| 多 Agent 编排 | 复杂任务分角色协作 | oh-my-opencode-slim | 第三方社区插件，非 OpenCode 官方 |
| 规范与验收 | 需求→规格→实现→核对 | OpenSpec | 证据的组织方式；本仓库已有连字符命令 `/opsx-propose` 等 |
| 外部系统协议 | AI 连接外部系统的标准方式 | MCP | 只讲边界；本项目无配置，本课不演示 |

## OpenCode：是什么 / 为什么 / 怎么用

- **是什么**：跑在终端里的 AI 编码工具（[opencode.ai](https://opencode.ai)），把模型、工具、权限组织成一次可检查的会话。主界面三区：对话、文件差异、终端。
- **为什么**：价值不在"打字更快"，而在会话可检查——状态、计划、权限、diff、undo 每一步都有迹可循，符合受控 AI 辅助开发。
- **怎么用（本课四步）**：
  1. **启动与状态**：建立会话后先看模型、工作目录、可用工具——这是会话的边界说明书。
  2. **只读理解**：让 Agent 读仓库、回答"项目是什么/怎么组织/怎么构建"，明确不许改文件；理解错了后面免谈。
  3. **模式与权限**：默认主 Agent 是 Build；本课回放**显式切到 Plan 模式**，并把相关操作的 permission 配置为 ask。权限三值为 allow/ask/deny：默认多数权限为 allow 直接放行，只有命中 ask 的操作才请求批准，deny 直接拒绝；Plan 默认对编辑与 bash 类操作设 ask。
  4. **diff / undo / 验证**：改完看 diff 把关范围；`/undo` 单次撤销上一条用户消息及其后的回复与文件改动，可连续执行 `/undo` 继续向前、`/redo` 恢复；跨会话或需要明确版本点时依赖 Git；最后跑测试/类型检查/构建给证据。

## mattpocock/skills：是什么 / 为什么 / 怎么用

- **是什么**：Matt Pocock 维护的**个人技能集合**。背景是 Agent Skills 开放标准与 skills.sh / Vercel Labs 生态——标准定义技能怎么写、怎么分发；mattpocock/skills 是其中一个具体的包，**不是官方标准**。
- **为什么**：它把四类高频工作流做成了可复用技能，正好对应开发闭环四个环节：
  - `grill-with-docs`：需求澄清——先读文档再连环提问，把歧义逼成可验证约束。
  - `tdd`：测试先行——先写失败测试钉死目标行为。
  - `diagnosing-bugs`：诊断（diagnosis 入口）——先收集日志/复现/最小环境，再动代码。
  - `code-review`：评审——按安全、清晰、可维护三个视角检查。
- **怎么用**：
  - 安装示例：`npx skills@latest add mattpocock/skills`（版本以官网/上游为准）。
  - **先审阅再启用**：技能包会往工作区写文件，先看它加了什么。
  - **上游要求的 setup**：安装时选择 `setup-matt-pocock-skills`，并在每个仓库运行一次 `/setup-matt-pocock-skills`。
  - **安装方式二选一**：插件安装与 skills.sh 安装二选一，避免同一技能重复注册。
  - 不要夸大它对 OpenCode 的适配程度。

## oh-my-opencode-slim：是什么 / 为什么 / 怎么用

- **是什么**：给 OpenCode 加多 Agent 编排能力的**第三方社区插件**（[GitHub](https://github.com/alvinunreal/oh-my-opencode-slim)），**不是 OpenCode 官方**。
- **为什么**：单 Agent 长任务会上下文膨胀、注意力漂移；编排把任务分给不同职责的 Agent 并行或接力。判断标准：**能单 Agent 就不编排**——任务边界清晰、串行依赖、一个人能描述清楚时，单 Agent 最简单、最好回看；只有任务可切分、需并行或对抗性检查时才升级编排。
- **内置角色**（真实角色名，不是抽象阶段）：Orchestrator（分派与汇总）、Explorer（只读侦察）、Fixer（有界实现）、Oracle（按需高风险评审）、Designer（UI）、Librarian（官方资料）、Council（多模型投票，按需开启、成本高）、Observer（可选）。"计划 → 实现 → 复核"只是抽象阶段，不是插件角色名。
- **怎么用**：
  - 安装示例：`npx oh-my-opencode-slim@latest install`，然后登录/刷新，`ping all agents` 检查角色就绪。
  - **配置路径**：默认用户级配置 `~/.config/opencode/oh-my-opencode-slim.json(c)`；项目级 `.opencode/oh-my-opencode-slim.json` 是**可选**的项目覆盖，不是唯一落点，不要说"统一写进项目配置"。
  - **权限**：安装和运行会读写用户级配置、调用模型，看清请求什么再批准；安装**不会**创建 agent 目录。
  - **成本**：Council 等多模型投票角色会明显增加 token 消耗，心里要有数。
  - **开关**：后台编排依赖环境变量 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`；整体禁用 `OH_MY_OPENCODE_SLIM_DISABLE=1`，不用时关掉。高级命令放讲师手册，不进主 PPT。
- 本课演示主要用单 Agent 流程，编排只做概念定位。

## OpenSpec：是什么 / 为什么 / 怎么用

- **是什么**：规范优先的工作流工具（[openspec.dev](https://openspec.dev)、[GitHub](https://github.com/Fission-AI/OpenSpec)），要求 Node >= 20.19.0。
- **为什么**：它解决"AI 写完代码，凭什么说符合需求"——把需求变成规格、把规格变成可验证场景，实现后再逐条核对，证据有组织、可复查。
- **怎么用**：
  - **两种入口**：终端 CLI（人手动操作）；聊天命令（会话内让 Agent 走流程）。命令形态会随宿主工具不同而变化，本课只展示本仓库实际命令：`.opencode/commands/` 里已有的连字符形式 `/opsx-propose`、`/opsx-apply`、`/opsx-verify`、`/opsx-archive`、`/opsx-explore`。
  - **artifacts**：proposal（提案）、spec（规格：SHALL + 场景）、design（设计决策）、tasks（最小步骤）。changes 放进行中，归档进 archive。
  - **核心流程**：explore 摸清现状 → propose 生成提案与规格 → apply 按规格实现 → archive 完成后归档。
  - **verify**：本仓库 `.opencode/commands/opsx-verify.md` 是项目已有的启发式命令——读取 artifacts、搜索代码，做完整性/正确性/连贯性的启发式判断；不需要 profile 前置，也不会自动跑项目测试。本课不声称 green-final 阶段真实运行过它；现场展示的是**历史人工/等效规范映射**（见 [verify-report.md](./verify-report.md)）。
  - **strict 只验结构**：`validate --strict` 的"Change is valid"只校验 CLI 校验到的规格格式、requirement/scenario 结构与可解析性，**不证明 proposal/design/tasks 完成度，也不校验行为符合性**。行为由机器执行证据与 code review 共同支持（四层证据见 [workflow-checklist.md](./workflow-checklist.md)）。本课 strict 输出是 2026-08-10 历史记录：原 change 已归档，当前 HEAD 不能重跑；training-change 是静态夹具不被 CLI 扫描，只能人工阅读。

## MCP：只讲边界

- MCP（Model Context Protocol）是**协议**，不是需要安装的单一运行时；它解决"AI 怎么连外部系统"。
- 使用判断只有一条：**内置工具不够、必须接外部系统时才用**。别为用而用。
- 本项目无 MCP 配置，本课不演示、不配置。

## 边界（no-live-agent）

- **所有 Agent 输出均为静态回放**，现场不调用 Agent。
- 现场允许的操作仅四类：运行测试、查看 diff、切换快照、操作 UI。
- 不展示密钥、不上传敏感信息；演示数据为脱敏数据；独立用户数据目录必须隔离。

## 项目现状与归档漂移

- 原 `add-relocation-service-workbench` change **已归档**（`openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`），不再是进行中 change。
- 当前正式 spec `openspec/specs/workbench-todos/` 是旧两场景版，**不含**本课训练边界。
- 四阶段实现只在远端培训分支 `origin/training/vibe-coding-reminder-window`，未合入 main。
- 课程用 [training-change/](./training-change/README.md) 冻结教学叙事；它是静态夹具，无产品批准语义。

## 术语对照

与 [CONTEXT.md](./CONTEXT.md) 的对应关系：

- **工具角色**：先按职责理解工具，具体产品只是实现示例。
- **受控 AI 辅助开发**：OpenCode 会话在人的目标、约束、决策、验收证据下运行。
- **安全红线**：不上传敏感信息、不展示密钥、AI 无生产权限、破坏性/数据/依赖/合并发布操作需人工确认。

配套：[environment-checklist.md](./environment-checklist.md)（版本与自检）、[demo-runbook.md](./demo-runbook.md)（演示操作）。
