# 《Vibe Coding》

**从需求到证据的受控开发闭环**

面向技术混合受众（开发为主，含少量产品/测试/运维）的 90 分钟线下课程，共 26 页演示，以本仓库的搬迁服务工作台项目为演示载体。课程讲解"受控 AI 辅助开发"：人定义目标、约束、决策与验收证据，AI 辅助分析与实现；覆盖一次真实 OpenCode 会话、三套关键工具、TDD 与 diagnosis 两种入口、四层验证证据，最后用一个小需求走完完整闭环。

课程形式：**线下、不跟做、无考核**。项目演示段由讲师通过 OpenCode 打开**已有历史会话**，按关键节点跳转、讲解其中**已有的输出**——不重新运行 Agent、不重新执行历史命令；课件只给整体思路。页 8–11 的 Agent 输出以**连续编号的静态重构材料**呈现（步骤 1–4）——这些材料依据已核验的会话步骤和历史输出摘要重新排版，**不是原始界面截图，也不是现场 Agent 输出**。

## 时间结构（共 90 分钟）

| 时间段 | 内容 | 页 |
| --- | --- | --- |
| 0–8 分钟 | 概念与安全 | 1–5 |
| 8–20 分钟 | 第一次 OpenCode 会话（静态重构材料：仓库/status/Plan/权限/diff/undo/验证） | 6–11 |
| 20–42 分钟 | 三套关键工具教程：mattpocock/skills 7 分钟、oh-my-opencode-slim 8 分钟、OpenSpec 7 分钟；MCP 共 2 分钟：页 12（1 分钟）与页 20（1 分钟） | 12–20 |
| 42–54 分钟 | 开发方法：TDD vs diagnosis + review/verify 四层证据 | 21–22 |
| 54–76 分钟 | 现场演示：OpenCode 历史会话（22 分钟） | 23–25 |
| 76–90 分钟 | Q&A 与收尾 | 26 |

## 课程要点

- **受控 AI 辅助开发**：人定目标、约束、决策与验收证据，AI 辅助分析与实现；不是"凭感觉接受输出"。
- **会话是基本单元**：模型、Agent、工具、session 各有边界；第一次会话从只读理解开始，权限按 allow/ask/deny 策略控制（默认多数为 allow，命中 ask 才请求批准，deny 直接拒绝）。
- **TDD 与 diagnosis 是两个入口**：TDD 面对已知目标行为（先写失败测试），diagnosis 面对未知故障原因（先收集证据）；本课两个都讲清何时用。
- **四层证据**：OpenSpec strict（只验结构）→ 规范映射/启发式核对（历史人工对照，可由 `/opsx-verify` 辅助）→ 机器执行证据 → code review（安全/清晰/可维护）。机器执行证据逐项有边界：tests 只证明被断言的特定行为；typecheck 只证明类型一致性；build/package 只证明可构建、可打包；E2E 只证明特定环境、特定路径的特定行为——不能笼统说"整体支持行为符合性"。
- **风险适配**：流程强度按业务歧义、改动范围、公共 API、数据/安全影响调整；目标、边界、验证证据不可省。
- **现场演示**：讲师通过 OpenCode 打开已有历史会话，按关键节点讲解已有输出（需求澄清 → 规格/计划 → Red → Green → Review/Verify），不重新运行 Agent、不重新执行历史命令；页 8–11 的 Agent 输出以静态重构材料呈现，保证可复现。

## 材料导航

| 文件 | 用途 |
| --- | --- |
| [presenter-preparation.md](./presenter-preparation.md) | 讲师备课手册：26 页逐页讲解卡、准备清单、故障预案 |
| [speaker-notes.md](./speaker-notes.md) | 逐分钟讲稿与正常中文口播 |
| [environment-checklist.md](./environment-checklist.md) | 版本附录、前置条件、项目自检命令与归档漂移声明 |
| [tool-roles.md](./tool-roles.md) | 工具职责/边界/本项目状态，关键工具"是什么/为什么/怎么用" |
| [workflow-checklist.md](./workflow-checklist.md) | TDD vs diagnosis、四层证据、检查点与风险分级 |
| [demo-runbook.md](./demo-runbook.md) | 现场演示操作提纲：课前确认、关键节点跳转、时间控制、历史证据口径与失败兜底 |
| [qa-template.md](./qa-template.md) | 课前收集、共性问题、待答问题池与内部附件注入点 |
| [CONTEXT.md](./CONTEXT.md) | 课程特定语言词汇表（纯词汇表，术语唯一依据） |
| [review-report.md](./review-report.md) | 历史代码评审记录（培训夹具证据，非当前产品评审） |
| [verify-report.md](./verify-report.md) | 历史规范核对记录（培训夹具证据） |
| [training-change/README.md](./training-change/README.md) | 培训夹具材料包（备课/兜底材料，非现场主要展示入口） |
| [slides/index.html](./slides/index.html) | 可离线直接打开的 26 页浏览器幻灯片 |
| [slides/README.md](./slides/README.md) | 演讲操作与验证说明 |

业务领域术语以仓库根目录 [CONTEXT.md](../../../CONTEXT.md) 为准；上下文关系见 [CONTEXT-MAP.md](../../../CONTEXT-MAP.md)。

## 归档漂移声明（重要）

课程演示依托的原 `add-relocation-service-workbench` change **已归档**（落点 `openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`），不再是进行中 change。当前 `openspec/specs/workbench-todos/` 仍是旧版两场景规范，**不含**本课展示的 0 语义、安全整数、保存时机、持久化、日期可见等训练边界；最终实现只存在于远端培训分支 `origin/training/vibe-coding-reminder-window`，**未合入 main**。课程使用 [training-change/](./training-change/README.md) 冻结教学叙事，四阶段 commit 只是历史训练证据，不代表产品批准或产品变更。

## 官方资料（版本以官网/上游为准）

- OpenCode：官网 <https://opencode.ai> / 文档 <https://opencode.ai/docs/> / skills <https://opencode.ai/docs/skills/>。仓库组织曾迁移，公开材料以官网为准。
- OpenSpec：<https://openspec.dev> / GitHub <https://github.com/Fission-AI/OpenSpec>；要求 Node >=20.19.0，命令持续演进。
- MCP（Model Context Protocol）：<https://modelcontextprotocol.io>，开放协议；是协议，不是需要安装的单一运行时。
- skills：Agent Skills 开放标准生态（skills.sh / Vercel Labs）；mattpocock/skills 是个人技能集合，不是官方标准。
- oh-my-opencode-slim：<https://github.com/alvinunreal/oh-my-opencode-slim>；第三方社区插件，非 OpenCode 官方。
- 具体版本号集中在 [environment-checklist.md](./environment-checklist.md) 附录，主叙事不依赖补丁版本。
