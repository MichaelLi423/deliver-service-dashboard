# 工具角色（tool-roles）

本课工具**按职责讲，不按产品记**：先理解每类工具承担什么职责，具体产品只是实现该职责的示例。工具会持续演进，命令以官方文档为准；本课以 OpenCode 与 OpenSpec 为主示例。

## 职责一览

| 职责 | 需要做的事 | 本课主示例 | 说明 |
| --- | --- | --- | --- |
| 编辑器 | 查看代码、编辑、看 diff、阅读快照 | 讲师自选 | 不分发个人配置，平台无关 |
| 终端 | 运行测试、git 操作、切换快照 | 系统终端 | 现场只做运行测试、查看 diff、切换快照、操作 UI |
| AI 编码工具 | 在人的目标、约束、决策与验收证据下辅助分析与实现 | OpenCode（npm `opencode-ai` 1.18.16） | 受控 AI 辅助开发的执行侧 |
| 规范与验收工具 | 把需求澄清为规范、生成可验证的验收场景、核对实现 | OpenSpec（npm `@fission-ai/openspec` 1.8.0，Node >= 20.19.0） | 需求→规范→验证的证据载体 |
| 模型上下文协议 | 连接 AI 工具与外部数据/工具的标准方式 | MCP（[modelcontextprotocol.io](https://modelcontextprotocol.io)，协议规范 2026-07-28） | 是开放协议，不是单一运行时；本仓库无 MCP 配置，本课不涉及 |
| 技能/扩展模式 | 给工具扩展特定能力 | skills 模式 | 通用扩展模式，但无跨厂商统一标准 |
| 社区插件 | 第三方提供的增强 | oh-my-opencode-slim（npm 2.2.11，[GitHub](https://github.com/alvinunreal/oh-my-opencode-slim)） | 第三方社区插件，非 OpenCode 官方 |

## 边界（no-live-agent）

- **本课所有 Agent 输出均为回放**，现场不调用 Agent。
- 现场允许的操作只有四类：运行测试、查看 diff、切换快照、操作 UI。
- 这保证了演示可复现、不依赖网络、不受模型输出不确定性影响。

## 本项目现状（区分三类口径）

| 类别 | 内容 |
| --- | --- |
| **项目已有** | `.opencode/commands/opsx-*`（opsx-propose / opsx-apply / opsx-verify 等 7 个命令） |
| **讲师示例（培训夹具）** | 演示分支四阶段快照 baseline → red-test → preset-failure → green-final；属培训夹具，**不是产品交付** |
| **可选扩展（本课不使用）** | skills（`skills-lock.json` 为空）、MCP（仓库无配置）、oh-my-opencode-slim |

## 术语对照

与 [CONTEXT.md](./CONTEXT.md) 中词汇的对应关系：

- **工具角色**：先按职责理解工具，具体产品只是实现示例。
- **受控 AI 辅助开发**：AI 编码工具（OpenCode）在人的约束下辅助分析与实现。
- **安全红线**：不上传敏感信息、不展示密钥、AI 无生产权限、破坏性/数据/依赖/合并发布操作需人工确认。

配套：[environment-checklist.md](./environment-checklist.md)（版本与自检）、[demo-runbook.md](./demo-runbook.md)（演示操作）。
