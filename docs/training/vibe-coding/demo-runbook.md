# 演示手册（demo-runbook）

本手册覆盖 90 分钟、34 页课程中的两段静态回放（第一次 OpenCode 会话 12 分钟、项目整合演示 22 分钟）与现场操作边界。所有 Agent 输出均为回放；现场不调用 Agent。素材清单见 [presenter-preparation.md](./presenter-preparation.md) 第 5 节。工具教程段（20–42 分钟：mattpocock/skills、oh-my-opencode-slim、OpenSpec）与开发方法段（42–54 分钟：TDD vs diagnosis、四层证据）不在本演示范围内，见 [speaker-notes.md](./speaker-notes.md) 与 [tool-roles.md](./tool-roles.md)。

## 静态回放的定义

- 连续编号的**静态重构材料**定义为**步骤 1–4**：每步解释"当时发生了什么、为什么"——真实因果，不是演示视频。这些材料依据已核验的会话步骤和历史输出摘要重新排版，**不是原始界面截图、不是现场 Agent 输出**，浏览器课件不嵌入原始图片。
- 现场不允许调用 Agent 补素材；素材缺失时口头描述并课后补齐（见 [presenter-preparation.md](./presenter-preparation.md) 故障矩阵）。
- 现场允许的操作仅四类：**运行测试、查看 diff、切换快照、操作 UI**。

## 回放块一：第一次 OpenCode 会话（12 分钟，页 6–11）

| 步骤 | commit/状态 | 素材 | 看什么 | 说什么 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 准备 | baseline `76747c1` | 仓库 `git status` 干净 + 分支名 | 起点可信 | "AI 参与的工作先有干净、可回退的起点。" | 进入会话 |
| 步骤 1 启动与状态 | — | R1 会话状态静态重构材料 | 模型/工作目录/可用工具 | "状态就是会话的边界说明书。" | 只读理解 |
| 步骤 2 只读理解 | — | R2 复述回答静态重构材料 | Agent 对项目结构/构建的复述 | "先验证理解，再谈修改。" | 权限 |
| 步骤 3 模式与权限 | — | R3 Plan 模式切换与 permission（ask）配置、命中 ask 的批准请求静态重构材料 | 默认主 Agent 是 Build；回放显式切到 Plan；权限三值 allow/ask/deny：默认多数权限 allow、命中 ask 才请求批准、deny 直接拒绝 | "权限是人握方向盘的具象化。" | diff/undo/验证 |
| 步骤 4 diff/undo/验证 | — | R4 diff 视图、`/undo` 结果、测试输出静态重构材料 | 改动范围与验证结果；`/undo` 单次撤销上一条用户消息及其后的回复与文件改动，可连续执行继续向前、`/redo` 恢复，跨会话/版本点依赖 Git | "diff 把关、undo 单步回退、验证给证据。" | 进入工具教程 |

## 回放块二：项目整合演示（22 分钟，页 28–32）

### 演示需求

在提醒面板内配置**临期窗口**。已确认约束：

- 0 合法：未来提醒不归临期，今日到期与已逾期不受影响。
- 无额外业务上限，但只接受 0..9007199254740991 的非负安全整数，超范围拒绝。
- 显式保存前不生效；保存后立即刷新并持久化。
- 提醒行展示提醒日期与到期分类。
- "无独立 reset"是夹具 non-goal，不是行为要求。

### 归档漂移（开场必讲）

- 原 `add-relocation-service-workbench` change **已归档**，不再是进行中；当前正式 spec 是旧两场景版，不含上述训练边界。
- 四阶段实现只在远端培训分支 `origin/training/vibe-coding-reminder-window`，未合入 main。
- 课程使用 [training-change/](./training-change/README.md) 冻结教学叙事：静态夹具，无产品批准语义；OpenSpec CLI 不扫描它。

### 22 分钟脚本

| 时间 | 页 | 动作 | 素材/命令 | 看什么 | 说什么 |
| --- | --- | --- | --- | --- | --- |
| 0:00–2:00 | 28 | 原始需求 | 需求卡 | 一句话需求 + 三类到期状态 | "一句话藏着五个歧义。" |
| 2:00–6:00 | 29 | grill 澄清 | R5 grill 静态重构材料 | 三问三答收敛 | "澄清出五条可验证约束。" |
| 6:00–10:00 | 30 | training change/spec | R6 spec 静态重构材料 | 夹具 spec 场景 | "原 change 已归档；用夹具冻结叙事，不是产品 change。" |
| 10:00–16:00 | 31 | Red 与 preset-failure | R7/R8 静态重构材料 | red-test 与 preset-failure 证据 | "红是预期证据；表面可用不等于行为正确。" |
| 16:00–22:00 | 32 | Green/review/verify | R9/R10/R11 静态重构材料（strict 为 2026-08-10 历史输出摘要，不现场重跑；spec 对照为历史人工/等效规范映射，当时未运行 `/opsx-verify`） | green 证据、verify、UI 终态 | "四层证据闭环；历史证据不代表产品批准。" |

### 四阶段历史证据（培训分支，非产品交付）

| 阶段 | commit | 关键证据（2026-08-10 macOS arm64） |
| --- | --- | --- |
| baseline | `76747c1` | typecheck 通过；4 个聚焦文件 83 tests 通过 |
| red-test | `f771667` | typecheck 通过；domain+integration 32 通过；main 新增 2 项 `V2_MUTATION_UNKNOWN` 失败；renderer 新增 1 项控件未找到失败 |
| preset-failure | `0554164` | typecheck 通过；domain+integration 32 通过；main 仅 0 用例因"必须不小于 1"失败（负数/非整数通过）；renderer 仅 0 保存客户端拒绝且未调用 mutation |
| green-final | `d304bd5` | typecheck 通过；4 个聚焦文件 95 tests 通过；全量 93 files/1076 tests；strict 通过（Change is valid）；`npm run e2e:build` 通过；布局 E2E 1/1 |

`380ad38` 是叙事外中间提交，不作为阶段展示。机器执行证据逐项边界：tests 只证明被断言的特定行为；typecheck 只证明类型一致性；build/package 只证明可构建、可打包；E2E 只证明特定环境、特定路径的特定行为。以上证据不代表 Windows 平台验证；完整 `npm run test:e2e` 与 `npm run verify:matrix` 未运行。

### 页 26 虚构 diagnosis 微案例（不属于两段演示回放）

页 26 的 diagnosis 演示是一条**明确标注虚构**的教学微案例，独立于项目四阶段历史证据，不混同历史 preset-failure，也不声称来自仓库真实缺陷。现场只按静态重构材料讲六步证据链，不运行任何诊断命令：

| 步骤 | 观察/动作 | 具体内容 |
| --- | --- | --- |
| 1 复现 | 观察 | 搜索框按 Enter 没反应；点击按钮正常 |
| 2 最小化 | 缩小范围 | 只保留搜索表单与 keydown 路径 |
| 3 假设 | 列出候选 | 焦点问题、preventDefault、缺少 submit 绑定 |
| 4 插桩/排除 | 验证假设 | keydown 已触发，但 submit handler 调用数为 0，排除焦点与后端 |
| 5 修复 | 改代码 | 统一走 form onSubmit |
| 6 回归测试 | 再验证 | Enter 与点击均触发一次查询 |

## 快照载体与切换纪律

- 载体：**一个专用 worktree + 一个有序分支**；不为每个阶段建 worktree。
- 现场仅在 worktree 为 clean 状态时，用 detached checkout/switch 切换到实际 commit。
- 出现 dirty 状态：**立即停止**，禁止 `reset --hard`、`clean` 或删除未确认数据；新建一个 worktree 从对应 commit 重建干净环境，不破坏原 worktree。

## 独立用户数据目录

- 启动演示应用时设置项目已支持的 `WORKBENCH_E2E_USER_DATA_DIR` 环境变量，指向独立脱敏目录；该测试钩子见 `src/main/index.ts`，不要用未经本项目验证的通用启动参数代替。
- 每次课前用全新目录，课后可删除；数据目录内的演示数据为脱敏数据。

## 回滚步骤（非破坏性安全流程）

- 单步失误：先确认 worktree 为 clean，再 detached checkout/switch 回到对应快照继续。
- dirty 状态：立即停止，禁止破坏性命令；新建专用 worktree 从对应 commit 重建干净环境。
- 意外持久化数据：重置时仅删除独立用户数据目录，不影响任何其他数据。

## 排练步骤

1. 核对四阶段 commit 与归档漂移三条事实（见 [training-change/README.md](./training-change/README.md)）。
2. 在演示机上按 [environment-checklist.md](./environment-checklist.md) 自检命令逐条运行，登记真实结果。
3. 逐张核对静态素材 R1–R11 与讲解卡顺序一致（清单见 [presenter-preparation.md](./presenter-preparation.md) 第 5 节）。
4. 完整走一遍 12 + 22 分钟两段脚本，用计时器核对；记录每段实际耗时并微调。
5. 验证 UI 终态路径与 green-final 一致：填 0 保存 → 立即刷新并持久化 → 提醒行显示日期。

## 配套

- 口播与转场：[speaker-notes.md](./speaker-notes.md)
- 逐页讲解卡与素材清单：[presenter-preparation.md](./presenter-preparation.md)
- 检查点与四层证据：[workflow-checklist.md](./workflow-checklist.md)
- 工具职责与边界：[tool-roles.md](./tool-roles.md)
- 历史评审与核对：[review-report.md](./review-report.md)、[verify-report.md](./verify-report.md)
- 培训夹具：[training-change/README.md](./training-change/README.md)
