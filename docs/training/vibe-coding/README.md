# 《Vibe Coding》

**从需求到证据的受控开发闭环**

面向线下小班（10–30 人）的 60 分钟课程材料，以本仓库的搬迁服务工作台项目为演示载体。课程讲解"受控 AI 辅助开发"：人定义目标、约束、决策与验收证据，AI 辅助分析与实现；完整走一遍"需求澄清 → 规范 → TDD Red/Green → 代码评审/规范核对"的开发闭环。

课程形式：**线下、不跟做、无考核**。所有 Agent 输出均为回放，现场不调用 Agent；现场只运行测试、查看 diff、切换快照、操作 UI。

## 时间结构（共 60 分钟）

| 时间段 | 内容 | 说明 |
| --- | --- | --- |
| 0–8 分钟 | 概念 | 含 60 秒安全红线 |
| 8–18 分钟 | 环境与工具角色 | 平台无关概览，不分发个人配置 |
| 18–48 分钟 | 演示 | 30 分钟完整开发闭环演示 |
| 48–60 分钟 | Q&A | 预收集问题 + 现场补充 |

## 课程要点

- **受控 AI 辅助开发**：人定目标、约束、决策与验收证据，AI 辅助分析与实现；不是无需监督的"纯 Vibe Coding"。
- **开发闭环**：需求澄清 → 规范 → TDD 的 Red/Green 实现与验证 → 代码评审/规范核对。本课只讲 TDD，不讲诊断。
- **风险适配**：流程强度按业务歧义、改动范围、公共 API、数据/安全影响调整；目标、边界、验证证据不可省。
- **质量双门**：代码评审（安全/清晰/可维护）与规范核对（约定行为与证据）互补。
- **混合演示**：阶段快照为主、少量现场操作；四阶段快照属于培训夹具，不是产品交付。

## 材料导航

| 文件 | 用途 |
| --- | --- |
| [speaker-notes.md](./speaker-notes.md) | 逐分钟讲稿与正常中文口播 |
| [environment-checklist.md](./environment-checklist.md) | 版本、前置条件、项目自检命令与验证日期 |
| [tool-roles.md](./tool-roles.md) | 工具职责、边界与本项目状态 |
| [workflow-checklist.md](./workflow-checklist.md) | 六个最佳实践检查点与风险分级 |
| [demo-runbook.md](./demo-runbook.md) | 排练/现场/回滚步骤、四阶段 commit 与 no-live-agent 边界 |
| [presenter-preparation.md](./presenter-preparation.md) | 讲师备课手册：准备清单、18 页讲解卡、现场操作与故障预案 |
| [slides/README.md](./slides/README.md) | 18 页 PPTX、PDF 预览及可维护生成源码 |
| [review-report.md](./review-report.md) | 代码评审记录（真实发现与债务） |
| [verify-report.md](./verify-report.md) | 规范核对记录（requirements 到证据映射） |
| [qa-template.md](./qa-template.md) | 课前收集、共性问题、待答问题池与内部附件注入点 |
| [CONTEXT.md](./CONTEXT.md) | 课程特定语言词汇表（纯词汇表，术语唯一依据） |

业务领域术语以仓库根目录 [CONTEXT.md](../../../CONTEXT.md) 为准；上下文关系见 [CONTEXT-MAP.md](../../../CONTEXT-MAP.md)。

## 官方资料（截至 2026-08-10）

- OpenCode：官网 <https://opencode.ai> / 文档 <https://opencode.ai/docs/> / skills <https://opencode.ai/docs/skills/>；npm 包 `opencode-ai` 1.18.16。仓库组织曾迁移，公开材料以官网为准。
- OpenSpec：<https://openspec.dev> / GitHub <https://github.com/Fission-AI/OpenSpec>；npm 包 `@fission-ai/openspec` 1.8.0，要求 Node >=20.19.0，命令持续演进。
- MCP（Model Context Protocol）：<https://modelcontextprotocol.io>，开放协议，当前规范 2026-07-28；是协议，不是需要安装的单一运行时。
- oh-my-opencode-slim：<https://github.com/alvinunreal/oh-my-opencode-slim>，npm 包 2.2.11；第三方社区插件，非 OpenCode 官方。
- skills：通用扩展模式，但无跨厂商统一标准。
