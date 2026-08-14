# Q&A 模板（qa-template）

本模板用于 90 分钟课程（26 页）的课前收集、共性问题整理、待答问题池登记，并为私有材料标注内部附件注入点。**本公开文件不包含任何真实内部信息。**

## 课前收集（发给学员）

请在上课前填写并提交，用于安排 8 分钟 Q&A：

1. 你之前用过 AI 编码工具吗？用过哪些？（单选：没用过 / 用过但不多 / 常用）
2. 你更关心哪个主题？（多选：会话与权限 / 技能包 skills / 多 Agent 编排 / OpenSpec 规范 / TDD 与诊断 / 安全边界 / 其他）
3. 你当前最想解决的一个问题是什么？（一句话）
4. 你的技术角色？（开发 / 产品 / 测试 / 运维 / 其他）

## 共性问题（课堂公开回答）

以下为整理后的共性问题与回答要点（版本以官网/上游为准，详见 [environment-checklist.md](./environment-checklist.md)）：

- **Q：Vibe Coding 是不是不用管代码了？**
  A：不是。本课口径：受控 AI 辅助开发——人定义目标、约束、决策与验收证据，AI 辅助分析与实现；不是"凭感觉接受输出"。

- **Q：单 Agent 和 oh-my-opencode-slim 多 Agent 怎么选？**
  A：任务边界清晰、串行、能描述清楚就用单 Agent；任务可切分、需并行或独立复核再考虑编排。编排有协调成本与 token 成本（Council 多模型投票尤其明显），能单就不多。配置默认在用户级 `~/.config/opencode/oh-my-opencode-slim.json(c)`，项目级 `.opencode/oh-my-opencode-slim.json` 是可选的覆盖（安装不创建 agent 目录）；后台编排需要 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`，整体禁用 `OH_MY_OPENCODE_SLIM_DISABLE=1`。

- **Q：mattpocock/skills 是官方标准吗？**
  A：不是。它是个人技能集合；背景是 Agent Skills 开放标准与 skills.sh / Vercel Labs 生态。安装前先审阅，安装方式二选一防重复注册。

- **Q：OpenSpec 的 strict 通过是不是就说明实现对了？**
  A：不是。strict 只验证 CLI 校验到的规格格式、requirement/scenario 结构与可解析性，不证明 proposal/design/tasks 完成度，也不验证行为。行为符合性靠规范映射/启发式核对（本课展示历史人工/等效规范映射；项目里 `/opsx-verify` 可辅助这类核对，但本课不声称当时运行过它）、机器执行证据、code review 叠加。机器执行证据逐项边界：tests 只证明被断言的特定行为；typecheck 只证明类型一致性；build/package 只证明可构建、可打包；E2E 只证明特定环境、特定路径的特定行为——不能笼统说"整体支持行为符合性"。

- **Q：TDD 和 diagnosis 有什么区别？**
  A：TDD 面对已知目标行为，先写失败测试；diagnosis 面对未知故障原因，先收集日志/复现/最小环境再改代码。方向不同，都靠证据。

- **Q：MCP 要装吗？**
  A：它是协议不是运行时；只有内置工具不够、必须接外部系统时才用。本项目无 MCP 配置，本课不演示。

- **Q：演示里的"临期窗口"现在是产品功能吗？**
  A：不是。原 change 已归档，正式 spec 是旧版，实现只在远端培训分支。课程用的是 training-change 培训夹具，冻结当时的教学叙事，无产品批准语义。

- **Q：项目演示为什么不重新运行 Agent？**
  A：项目段打开 OpenCode 中已有的历史会话，按关键节点讲解已有输出，不重新运行 Agent 或历史命令，避免把课堂变成不可控的重放。页 8–11 仍使用静态重构材料；历史会话打不开时改用已脱敏讲师笔记与现有证据摘要。

## 待答问题池（会后书面处理）

现场无法在共性 Q&A 时间解决的个人配置或扩展问题，登记于此，会后书面处理。

| 编号 | 问题摘要 | 提问人 | 状态 |
| --- | --- | --- | --- |
| 1 | （课后填写） | | 待处理 |
| 2 | （课后填写） | | 待处理 |

> 注意：待答问题池是课堂纪律安排，不使用英文术语 "parking lot" 作为规范术语。

## 内部附件注入点（仅私有版本）

以下为内部附件注入点，**仅在私有版本中填入**公司特定政策、账号说明和真实 Q&A；公开版本此节保持为空，不包含任何真实内部信息。

- [ ] 公司特定政策注入点：`{{INTERNAL_POLICY}}`
- [ ] 账号说明注入点：`{{INTERNAL_ACCOUNT_NOTES}}`
- [ ] 真实 Q&A 注入点：`{{INTERNAL_QA}}`

> 公开版只标注注入点，不创建真实附件。

## 配套

- 课程概览与导航：[README.md](./README.md)
- 口播脚本：[speaker-notes.md](./speaker-notes.md)
- 讲师备课手册：[presenter-preparation.md](./presenter-preparation.md)
