# 讲师备课手册（presenter-preparation）

本手册用于讲师备课、彩排和现场控场，不替代逐分钟口播稿。课程总时长不变：概念 8 分钟、环境与工具角色 10 分钟、演示 30 分钟、Q&A 12 分钟；演示子段仍为 3 + 4 + 5 + 8 + 5 + 5 = 30 分钟。

配套材料：[speaker-notes.md](./speaker-notes.md)、[demo-runbook.md](./demo-runbook.md)、[environment-checklist.md](./environment-checklist.md)、[tool-roles.md](./tool-roles.md)、[workflow-checklist.md](./workflow-checklist.md)、[review-report.md](./review-report.md)、[verify-report.md](./verify-report.md)、[qa-template.md](./qa-template.md)。课程词汇以 [CONTEXT.md](./CONTEXT.md) 为准。

## 1. 课程边界

### 目标

1. 让学员把本课的 Vibe Coding 理解为**受控 AI 辅助开发**：人定义目标、约束、决策和验收证据，AI 仅辅助分析与实现。
2. 用一个小而真实的提醒窗口需求，展示需求澄清 → 规范 → TDD Red/Green → 代码评审/规范核对的闭环。
3. 让学员能区分代码评审、规范核对、测试和 OpenSpec strict 校验分别能证明什么、不能证明什么。

### 受众与形式

- 线下 10–30 人，60 分钟；不跟做、无考核、无退出卡。
- 使用搬迁服务工作台作为演示载体；业务词汇以仓库根目录 [CONTEXT.md](../../../CONTEXT.md) 为准。
- 讲师展示阶段快照和已回填的证据，学员不需要安装个人配置。

### 成功边界

- 学员能复述：0 合法、窗口只接受 `0..9007199254740991` 的非负安全整数、保存前不生效、保存后立即刷新并持久化、提醒日期可见。
- 学员理解：这次只是同一 `add-relocation-service-workbench` 进行中 change 内的 spec 更新和培训夹具回放，**不是**获批产品需求或产品发布。
- 讲师按计划完成演示并保留 12 分钟 Q&A；无法解决的个人配置/扩展问题进入“待答问题池”。

### 明确不讲什么

- 不讲 diagnose、不现场调用 Agent、不做学员跟做。
- 不讲公司政策、账号、真实 Q&A、组织信息或任何敏感数据。
- 不讲个人 IDE/模型/插件配置；不把 oh-my-opencode-slim 说成 OpenCode 官方，不把 skills 说成跨厂商标准，不把 MCP 说成需要安装的单一运行时。
- 不把 OpenSpec strict 当行为测试；不把 macOS arm64 结果说成 Windows 验证；不把培训夹具说成产品批准。
- “无独立 reset”只是培训 non-goal，不是本次行为规范要求。

## 2. 倒排准备清单

### T-7 天：内容与风险锁定

- [ ] 阅读本手册、[speaker-notes.md](./speaker-notes.md) 与 [demo-runbook.md](./demo-runbook.md)，确认 60 分钟结构不改。
- [ ] 用 [qa-template.md](./qa-template.md) 发出课前问题收集；个人配置问题预先标记为“待答问题池”候选。
- [ ] 准备 18 页演示文稿草稿和四阶段截图/录屏片段；Agent 输出只使用已保存回放，不准备现场调用入口。
- [ ] 审阅所有截图、终端输出和投影片：不得出现密钥、账号、真实客户数据、组织信息或内部附件内容。
- [ ] 与协助人员确认：一人负责计时/问题记录，一人可在投影或应用故障时协助切换到静态截图。
- [ ] 阅读 [review-report.md](./review-report.md)：如被问及遗留债务，准确说是 IPC 参数袋和外部渠道否定证明；二者不阻塞培训夹具，正式产品合入仍需另行授权和评审。

### T-1 天：演示资产与证据锁定

- [ ] 确认四阶段顺序和 hash：baseline `76747c1` → red-test `f771667` → preset-failure `0554164` → green-final `d304bd5`；不把 `380ad38` 作为阶段展示。
- [ ] 准备一个**专用 worktree + 有序分支**；不要为每一阶段创建 worktree。若 worktree 已 dirty，停止使用它，另建 worktree；禁止 `reset --hard`、`clean` 或删除未确认数据。
- [ ] 准备独立、脱敏的用户数据目录；启动演示应用时设置项目已支持的 `WORKBENCH_E2E_USER_DATA_DIR`。沿用已彩排的启动方式，不新增本手册未验证的 shell 启动命令。
- [ ] 预先完成并记录已验证命令：`npm run typecheck`、`npx vitest run`、`npm run e2e:build`、`npx playwright test e2e/workbench-v2-layout.spec.ts`、`npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict`。详细状态见 [environment-checklist.md](./environment-checklist.md)。
- [ ] 准备四条阶段证据卡：baseline 83 个聚焦 tests；red-test 的 2 个 main + 1 个 renderer 预期失败；preset-failure 的 0 值失败与负数/非整数通过；green-final 的 95 个聚焦 tests、1076 全量 tests、strict、构建和布局 E2E。
- [ ] 预生成 PDF 备用版，嵌入字体或使用现场已有字体；逐页检查中文、代码块和表格在投影比例下可读。

### T-30 分钟：现场技术检查

- [ ] 接通投影/扩展屏并检查投影分辨率；打开 PPT 和 PDF 备用版，确认第 9–16 页的代码/终端截图可读。
- [ ] 打开专用 worktree，确认当前状态 clean；不 clean 则立即换用新 worktree，不做破坏性清理。
- [ ] 确认 `WORKBENCH_E2E_USER_DATA_DIR` 指向独立脱敏目录；不要复用讲师日常数据目录。
- [ ] 在时间允许时复核已验证命令中的 `npm run typecheck`、`npx vitest run` 和 strict 校验；若不重跑，展示已回填的真实证据，不声称刚刚执行。
- [ ] `npm run e2e:build` 仅作为课前构建准备，不把构建过程塞入 30 分钟演示；macOS arm64 构建通过不代表 Windows。
- [ ] 打开预收集问题和“待答问题池”模板，指定记录人。

### 开场前 5 分钟：讲台状态

- [ ] 投影停在封面，讲师屏停在第 1 页和计时器；关闭通知、聊天弹窗和敏感窗口。
- [ ] 将应用、终端、diff、四阶段回放材料按演示顺序排好；确认没有 Agent 输入框或自动调用动作。
- [ ] 再次确认专用 worktree clean、独立用户数据目录正确、网络即使不可用也不会影响演示。
- [ ] 讲师和记录人对齐：现场问题先记后答；个人配置与扩展问题超过共性范围就进入“待答问题池”。

## 3. 18 页 PPT 逐页讲解卡

> 每页只服务一个观点。页内“建议口播”是讲师备课提示，不替代 [speaker-notes.md](./speaker-notes.md) 的逐分钟稿。

**时间校准**：第 1–5 页共 8 分钟；第 6–8 页口播共 9 分钟，另留 1 分钟切换演示工作区；第 9–16 页与快照/diff/UI 操作共 30 分钟（3 + 4 + 5 + 8 + 5 + 5）；第 17 页约 1.5 分钟、第 18 页保留 10 分钟 Q&A 与约 30 秒收尾，共 12 分钟。

### 1. 封面：Vibe Coding

- **唯一观点**：本课讲的是“从需求到证据的受控开发闭环”，不是让 AI 自主决定。
- **建议口播（约 1 分钟）**：说明线下 60 分钟、不跟做、无考核；预告概念 8 分钟、工具 10 分钟、演示 30 分钟、Q&A 12 分钟。
- **转场句**：“先把这个课程名字校准，否则后面每一步都会被误解。”
- **不要展开**：工具安装、个人配置、公司背景。
- **资料**：[README.md](./README.md)、[speaker-notes.md](./speaker-notes.md)

### 2. 术语纠偏：Vibe Coding 不等于凭感觉接受输出

- **唯一观点**：Vibe Coding 在本课中就是受控 AI 辅助开发。
- **建议口播（约 1.5 分钟）**：“人不是把责任交给模型，而是先给目标、约束、决策和验收证据；AI 的位置是辅助分析与实现。”
- **转场句**：“既然人仍负责，那人具体要负责什么？”
- **不要展开**：模型能力比较、提示词技巧竞赛。
- **资料**：[CONTEXT.md](./CONTEXT.md)

### 3. 人的职责：目标、边界、决策、证据

- **唯一观点**：AI 可以产出候选实现，责任边界和验收证据必须由人持有。
- **建议口播（约 1.5 分钟）**：“先问清楚什么算完成、什么不能发生、用什么看得见的证据确认；没有这些，任何看起来可运行的输出都不能直接接受。”
- **转场句**：“这些职责要落在一个可回退的闭环里。”
- **不要展开**：组织权限设计、人员绩效。
- **资料**：[workflow-checklist.md](./workflow-checklist.md)

### 4. 开发闭环：需求到证据

- **唯一观点**：需求澄清 → 规范 → TDD Red/Green → 代码评审/规范核对，任一步发现偏差都回退修正。
- **建议口播（约 3 分钟）**：强调本课只讲 TDD，不讲 diagnose；Red 不是事故，而是“尚未实现”的可见证据。
- **转场句**：“先讲一条无论使用什么工具都不能越过的红线。”
- **不要展开**：TDD 流派争论、完整测试金字塔。
- **资料**：[CONTEXT.md](./CONTEXT.md)、[workflow-checklist.md](./workflow-checklist.md)

### 5. 安全红线：60 秒最低约束

- **唯一观点**：不上传敏感信息、不展示密钥、AI 无生产权限、高风险操作人工确认。
- **建议口播（约 1 分钟）**：逐条读完后说“这不是治理体系课程，但这是演示的最低约束”。
- **转场句**：“在这条边界内，再看工具各自做什么。”
- **不要展开**：完整合规体系、公司内部安全策略。
- **资料**：[CONTEXT.md](./CONTEXT.md)、[tool-roles.md](./tool-roles.md)

### 6. 工具角色地图

- **唯一观点**：先按职责理解工具，OpenCode/OpenSpec 是本课主示例，其他是协议或可选扩展。
- **建议口播（约 3 分钟）**：说明编辑器/终端/AI 编码/规范验收的职责；MCP 是协议，skills 无跨厂商统一标准，oh-my-opencode-slim 是社区插件而非官方。
- **转场句**：“工具名字之外，本仓库实际有什么、没有什么？”
- **不要展开**：安装命令、个人插件清单、模型价格。
- **资料**：[tool-roles.md](./tool-roles.md)、[environment-checklist.md](./environment-checklist.md)

### 7. 项目现状：已有、示例、可选扩展

- **唯一观点**：区分项目已有 `.opencode/commands/opsx-*`、培训四阶段夹具和未使用的 skills/MCP/社区插件。
- **建议口播（约 3 分钟）**：“项目里有的不是所有人都必须装的；讲师示例也不是产品交付。我们不分发个人配置。”
- **转场句**：“同一个闭环不会在每次改动里使用同样的强度。”
- **不要展开**：仓库组织迁移细节、内部账号。
- **资料**：[tool-roles.md](./tool-roles.md)、[environment-checklist.md](./environment-checklist.md)

### 8. 风险适配：控制意图不省略

- **唯一观点**：所有风险保留六个控制意图，差别是文档、测试和 review 深度；本演示产品合入风险低，但跨 shared IPC/main/renderer 的集成风险按中等处理。
- **建议口播（约 3 分钟）**：“低风险不是跳过目标、边界和证据；只是把任务约定压缩、验证聚焦。这里仍展示完整聚焦证据路径。”
- **转场句**：“现在用一个小需求把这套原则落地。”
- **不要展开**：把风险分级变成审批流程、把培训夹具等同正式合入授权。
- **资料**：[workflow-checklist.md](./workflow-checklist.md)、[review-report.md](./review-report.md)

### 9. 演示需求：提醒面板的临期窗口

- **唯一观点**：一个小需求也必须有完整边界：0 合法、只接受安全整数、显式保存、立即刷新、持久化、日期可见。
- **建议口播（约 1.5 分钟）**：说明 0 时未来提醒不临期、today/overdue 不变；“无额外业务上限”不是任意大整数，范围外拒绝；无独立 reset 是培训 non-goal。
- **转场句**：“先不急着写代码，请大家决定最该问的三个问题。”
- **不要展开**：DOM、input 类型、按钮位置、排版、ECC。
- **资料**：[demo-runbook.md](./demo-runbook.md)、[verify-report.md](./verify-report.md)

### 10. 三个 grill 问题

- **唯一观点**：先把歧义变成可观察的行为，才谈实现。
- **建议口播（约 1.5 分钟）**：依次投票问“0 是合法的吗”“多大的数可接受”“编辑什么时候生效、页面要显示什么”；收敛规则见第 5 节。
- **转场句**：“原始 change 已经有基础规则，接下来解释本次怎么在同一 change 内补边界。”
- **不要展开**：让现场设计新功能、讨论无限多的边缘案例。
- **资料**：[speaker-notes.md](./speaker-notes.md)、[workflow-checklist.md](./workflow-checklist.md)

### 11. OpenSpec：同一 change 内更新 spec

- **唯一观点**：回放原始 propose 形成“临期窗口可配置”基础规则；本次 grill 边界在同一个进行中 `add-relocation-service-workbench` change 内更新 spec，不新建重叠 change。
- **建议口播（约 3 分钟）**：明确原始 propose 不等于当时已有全部精细规则；0、安全整数、保存时机、日期可见是后续在同一 change 中补齐的行为约束；另留 1 分钟展示 spec 回放。
- **转场句**：“规范写完，先让测试明确告诉我们还没有实现。”
- **不要展开**：新建 change、把 propose 当实现指令、strict 通过等同功能通过。
- **资料**：[speaker-notes.md](./speaker-notes.md)、[verify-report.md](./verify-report.md)

### 12. Red：失败是预期证据

- **唯一观点**：Red 快照证明验收行为已被表达，但实现尚未满足。
- **建议口播（约 2 分钟）**：展示 `f771667` 的真实摘要：domain+integration 32 通过；main 新增 2 项以 `V2_MUTATION_UNKNOWN` 失败；renderer 新增 1 项因找不到“临期窗口”控件失败；其余 3 分钟用于切换快照和展示失败回放。
- **转场句**：“接通链路后，仍可能出现一个表面可操作但行为错误的版本。”
- **不要展开**：把失败说成环境事故，或现场改测试。
- **资料**：[demo-runbook.md](./demo-runbook.md)

### 13. preset-failure：表面可用不等于符合规范

- **唯一观点**：IPC/facade/UI 接通后，仍可能错误地拒绝 0（要求 >=1）。
- **建议口播（约 2 分钟）**：展示 `0554164`：domain+integration 32 通过；main 仅 0 用例因“必须不小于 1”失败，负数/非整数通过；renderer 仅 0 保存因客户端拒绝且未调用 mutation 失败，控件/日期已经存在；其余 3 分钟用于 review 回放。
- **转场句**：“下一步不是相信界面，而是看最小 diff 和 Green 证据。”
- **不要展开**：怪罪模型、猜测未展示的实现、把代码评审说成不关注安全。
- **资料**：[demo-runbook.md](./demo-runbook.md)、[review-report.md](./review-report.md)

### 14. Green：最小改动满足边界

- **唯一观点**：Green 不只代表“能点”，还代表 0/安全整数/保存/刷新/持久化/日期可见的证据链闭合。
- **建议口播（约 3 分钟）**：展示 `d304bd5` 的关键 diff 与证据摘要；其余 5 分钟用于 UI 操作：填 0 保存、未来提醒退出临期、today/overdue 保持、提醒行显示日期，并展示 95 个聚焦 tests 与 1076 全量 tests 的已回填结果。
- **转场句**：“测试变绿之后，还要过两道不同的质量门。”
- **不要展开**：逐行讲全部代码、临时添加功能、把 macOS 结果说成 Windows。
- **资料**：[demo-runbook.md](./demo-runbook.md)、[verify-report.md](./verify-report.md)

### 15. 质量双门：review 与 spec 核对互补

- **唯一观点**：代码评审关注安全、清晰、可维护；规范核对与测试关注约定行为和证据。
- **建议口播（约 2 分钟）**：说明首次 review 的两个 medium 和既有两个 low；说明修正后仍没有第三轮独立 Oracle 评审，不能夸大结论。
- **转场句**：“这些结论要落到可复查的证据清单里。”
- **不要展开**：把 strict 当成行为验证、承诺正式产品批准。
- **资料**：[review-report.md](./review-report.md)

### 16. 证据清单：strict 的边界

- **唯一观点**：OpenSpec strict 验证规格结构；行为符合性由测试和 review 共同支持。
- **建议口播（约 2 分钟）**：展示 `d304bd5` 的 strict “Change is valid”、e2e build（macOS arm64）、布局 E2E 1/1；另留 1 分钟展示 strict 回放；明确这些不代表 Windows 平台验证。
- **转场句**：“这不是一次演示专用技巧，最后看怎样带回日常工作。”
- **不要展开**：完整 E2E 已通过的暗示（完整 `npm run test:e2e` 未运行）、Windows 已验证的暗示。
- **资料**：[verify-report.md](./verify-report.md)、[environment-checklist.md](./environment-checklist.md)

### 17. 日常落地：把闭环缩放到风险

- **唯一观点**：日常可按风险压缩材料，不压缩目标、边界、证据和双门意图。
- **建议口播（约 1.5 分钟）**：“小改动可用简短任务约定和聚焦验证；影响面扩大时加深文档、测试和 review。不要把课程夹具直接当产品合入结论。”
- **转场句**：“最后进入预收集问题和现场问题。”
- **不要展开**：要求全员采用同一工具或个人配置。
- **资料**：[workflow-checklist.md](./workflow-checklist.md)

### 18. Q&A / 收尾

- **唯一观点**：共性问题现场回答，个人配置和扩展问题书面跟进。
- **建议口播（约 2 分钟）**：用约 10 分钟处理预收集与现场 Q&A；超出课程边界的内容记入“待答问题池”。最后用约 30 秒重申“受控、证据、闭环”，不安排退出卡。
- **转场句**：“谢谢；问题记录会按模板会后书面处理。”
- **不要展开**：临时现场配置、敏感账号、内部政策。
- **资料**：[qa-template.md](./qa-template.md)、[speaker-notes.md](./speaker-notes.md)

## 4. 30 分钟演示：台前操作清单

### 演示纪律

- 所有 Agent 输出均为**回放**；现场不调用 Agent。
- 现场只做：运行已验证测试命令、查看已准备 diff、切换快照、操作 UI。
- 快照只能在专用 worktree clean 时切换；dirty 时立即停下并新建 worktree，绝不执行 `reset --hard`、`clean` 或删除未确认数据。
- 启动应用前确保 `WORKBENCH_E2E_USER_DATA_DIR` 指向独立脱敏目录；使用彩排已验证的启动方式，不临场发明命令。

| 时间 | 阶段/commit | 命令或操作 | 讲师看到什么 | 讲师说什么 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 0:00–0:30 | baseline `76747c1` | 切换至 baseline（仅在 clean worktree）；**无现场测试命令**，展示已回填证据卡 | 还没有本次配置入口；baseline typecheck 通过、4 个聚焦文件 83 tests 通过 | “这是起点，先确认不是从一堆未知失败开始。” | 进入投票和 grill 回放 |
| 0:30–3:00 | baseline `76747c1` | 无命令；播放 grill 回放/展示需求卡 | 三个边界问题与收敛答案 | “先澄清 0、数值边界、保存和日期可见。” | 打开原始 propose 与更新后 spec 的回放 |
| 3:00–7:00 | baseline → red-test | 无命令；查看已准备的 propose/spec diff 回放 | 原始 propose 的“可配置”基础规则，以及同一 change 内补齐的精细场景 | “不是新建 change；我们在已有进行中 change 内更新 spec。” | 切至 red-test |
| 7:00–12:00 | red-test `f771667` | 无新增聚焦命令；展示真实失败摘要 | 32 domain+integration 通过；main 2 项 `V2_MUTATION_UNKNOWN`；renderer 1 项找不到“临期窗口”控件 | “Red 是验收已经写出、实现尚未跟上的证据。” | 切至 preset-failure |
| 12:00–20:00 | preset-failure `0554164` → green-final `d304bd5` | 查看预先准备的 diff 回放；在 green-final 可运行已验证的 `npx vitest run` | preset 里控件/日期存在但 0 被拒；green 最终全量 93 files/1076 tests 通过 | “链路接通不等于行为正确；最小修改必须同时满足 0 和安全整数边界。” | 切至 preset-failure review |
| 20:00–25:00 | preset-failure `0554164` | 无命令；展示失败信息与 review 回放 | “必须不小于 1”、客户端拒绝且未调用 mutation；负数/非整数通过 | “测试和规范抓行为偏差；代码评审同时看安全、清晰、可维护。” | 切至 green-final verify |
| 25:00–28:00 | green-final `d304bd5` | 已验证命令：`npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict` | `Change is valid` | “strict 只验证规格结构；行为还要由测试和 review 支持。” | 打开最终 UI |
| 28:00–30:00 | green-final `d304bd5` | 无终端命令；用独立用户数据目录操作 UI | 填 0、显式保存、未来提醒不临期、today/overdue 不变、提醒行有日期 | “这是培训夹具的回放证据，不是产品批准；macOS 结果不代表 Windows。” | 进入 Q&A |

> `npm run e2e:build` 和单文件布局 E2E 已在 green-final 验证，但作为课前准备，不在台前 30 分钟中等待构建。完整 `npm run test:e2e` 与 `npm run verify:matrix` 均未运行，现场不得说成已通过。

## 5. 观众互动与 Q&A 控场

### 三个 grill 投票问题

| 问题 | 提问方式 | 预期答案 | 不同意见的收敛方式 |
| --- | --- | --- | --- |
| 0 是不是合法值？ | “请举手：0 是错误输入，还是一个有业务含义的配置？” | 合法；未来提醒不归临期，today/overdue 不变 | 回到可观察行为：若 0 不合法，就无法表达“关闭未来临期标记”的业务选择；以 spec 场景为准 |
| 可以输入多大？ | “无额外业务上限，是不是等于任何大整数都可以？” | 否；只接受 `0..9007199254740991` 的非负安全整数，超范围拒绝 | 区分业务上限与技术精确表示范围；不讨论 input 控件细节 |
| 编辑后何时生效、用户怎么确认？ | “输完数字是否已经改变分类？页面还应展示什么？” | 显式保存前不生效；保存后立即刷新并持久化；当前提醒日期可见 | 用“保存前不变 / 保存后刷新 / 关闭重开保持”三条证据收敛，不扩展到按钮位置或文案 |

### Q&A 节奏

1. 课前从 [qa-template.md](./qa-template.md) 汇总问题，优先回答共性问题。
2. 现场每个问题先判断：是否与课程目标、当前演示需求或公开资料相关。
3. 个人配置、插件选择、扩展需求、内部政策类问题不在现场配置；记录到“待答问题池”，会后书面处理。
4. 若争论超过 90 秒，复述双方共同点、指出当前 spec/证据边界，记录后转下一个问题。

## 6. 故障预案矩阵

| 情况 | 立即动作 | 继续方式 | 禁止动作 |
| --- | --- | --- | --- |
| 投屏不可用 | 切到本机屏幕或 PDF 备用版；记录时间损失 | 用第 9–16 页截图和讲解卡完成演示 | 临时安装驱动、暴露个人桌面或敏感窗口 |
| 字体/中文乱码 | 切换嵌入字体的 PDF | 用 PDF 继续，不现场改字体 | 下载未知字体或联网安装软件 |
| PowerPoint 崩溃 | 打开同版 PDF | 按页码卡片继续；讲师屏保留计时器 | 临时重做投影片 |
| 测试超时或终端无响应 | 停止等待，展示已回填真实证据摘要 | 说明该命令不再现场重跑，继续 diff/UI 回放 | 重复执行、杀掉不明进程、声称测试通过 |
| 应用打不开 | 切到 green-final UI 录屏/截图 | 继续讲需求、diff、证据和 review | 改代码、改配置、使用讲师日常数据目录 |
| worktree dirty | 立即停止切换 | 新建专用 worktree 后从对应 commit 继续；必要时切截图回放 | `reset --hard`、`clean`、删除未确认文件 |
| 用户数据目录异常 | 停止使用该目录，换新的独立脱敏目录 | 用已准备截图或重启应用到新目录 | 删除未确认数据、复用真实数据目录 |
| 网络不可用 | 保持离线演示 | 使用本地快照、已保存输出、PPT/PDF | 现场调用 Agent、尝试登录外部账号 |
| 现场问题跑偏 | 复述问题并标记分类 | 相关则简答；个人/扩展问题进入待答问题池 | 现场配置个人环境、讨论内部政策或账号 |

## 7. 讲师容易犯的错误

- 把 OpenSpec strict 的 `Change is valid` 说成行为已经验证。纠正：strict 只验证规格结构，行为仍靠测试和 review。
- 把 macOS arm64 的 build/E2E 结果说成 Windows 验证。纠正：明确“不代表 Windows 平台验证”。
- 把 oh-my-opencode-slim 说成 OpenCode 官方，或把 skills 说成跨厂商标准。纠正：前者是社区插件，后者无统一标准。
- 把四阶段培训夹具说成产品批准/可直接合入。纠正：正式产品合入仍需另行授权和评审。
- 把“无额外业务上限”说成可以接受任意大整数。纠正：只接受 `0..9007199254740991` 的非负安全整数，超范围拒绝。
- 现场调用 Agent、展示密钥、上传敏感数据，或将 `WORKBENCH_E2E_USER_DATA_DIR` 指向日常数据目录。
- 因 worktree dirty 使用破坏性 Git 命令。纠正：停止、换专用 worktree、保留原始未确认数据。
- 把“无独立 reset”写成产品行为要求。纠正：它只是培训 non-goal。
- 说“最后三项最小修正后又完成第三轮独立 Oracle 评审”。纠正：没有该轮评审，见 [review-report.md](./review-report.md)。

## 8. 彩排记录模板

```md
日期：
讲师：
专用 worktree：
独立用户数据目录：
四阶段 commit：76747c1 / f771667 / 0554164 / d304bd5

投影/PDF/字体：通过 / 问题：
worktree clean：是 / 否（若否，停止并记录）：
no-live-agent 边界：已确认 / 未确认：

时间实测：
- 概念（目标 8 分钟）：
- 环境与工具（目标 10 分钟）：
- 演示（目标 30 分钟；3+4+5+8+5+5）：
- Q&A（目标 12 分钟）：

证据展示：
- baseline 83 聚焦 tests：
- red-test 预期失败摘要：
- preset-failure 0 值偏差：
- green-final 95 聚焦 / 1076 全量 / strict / build / 布局 1/1：

故障与处理：
下次调整：
```

## 9. 课后复盘模板

```md
日期/场次/人数：
是否完成 60 分钟结构：是 / 否；偏差：
演示是否保持 no-live-agent：是 / 否；如否，停止原因与后续处理：
是否使用独立 worktree 与独立用户数据目录：是 / 否：

学员最常见的三个问题：
1.
2.
3.

待答问题池编号与会后负责人：

哪些页面超时/讲不清：
哪些证据最能帮助理解：
故障预案是否命中：
公开材料需要改进的地方（不得写入内部信息）：
下次课前需要验证的命令/资产：
```

## 10. 结束前核对

- [ ] 不超时：8 + 10 + 30 + 12 = 60；演示为 3 + 4 + 5 + 8 + 5 + 5 = 30。
- [ ] 所有 Agent 输出为回放，现场未调用 Agent。
- [ ] 未把培训夹具、macOS 验证、OpenSpec strict 夸大为产品批准、Windows 验证或行为验证。
- [ ] 个人配置问题已进入待答问题池；公开材料未写入内部信息。
