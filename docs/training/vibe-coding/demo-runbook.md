# 演示手册（demo-runbook）

## 演示需求

在提醒面板内配置**临期窗口**（项目提醒的到期分类规则）。已确认需求约束：

- 允许配置为 0：此时**不**将未来提醒标记为"临期"，今日到期与已逾期不受影响。
- 无额外业务上限，但只接受 0..9007199254740991 的非负安全整数，超出范围拒绝。
- 显式保存；保存后立即刷新并持久化。
- 提醒行追加显示日期。

"无独立 reset"是本课的培训 non-goal，不是行为要求，不写入规范。

说明：该需求属于**培训夹具**演示载体。演示回放现有 `add-relocation-service-workbench` 进行中 change 的原始 propose 如何形成"临期窗口可配置"基础规则；本次 grill 发现的 0 语义、安全整数边界、保存时机、日期可见等精细约束，在同一个进行中 change 内更新 spec，不新建重叠 change。演示载体为一个专用 worktree 上的有序分支，不属于产品交付。

## 四阶段快照

演示使用培训分支上的四个有序 Git 状态：

| 阶段 | 含义 | commit |
| --- | --- | --- |
| baseline | 演示起点（未实现配置前） | `76747c1` |
| red-test | 已加失败测试（Red） | `f771667` |
| preset-failure | 预设失败（IPC/facade/UI 已接通但实现错误拒绝 0） | `0554164` |
| green-final | 实现完成、测试通过（Green） | `d304bd5` |

> 以上 commit 已在 [environment-checklist.md](./environment-checklist.md) 登记；四阶段均为培训夹具，不是产品交付。

快照载体：一个专用 worktree + 一个有序分支，属于培训夹具，不是产品交付。现场仅在 worktree 为 clean 状态时，用 detached checkout/switch 切换到实际 commit；任何 dirty 状态立即停止演示并新建 worktree，禁止 `reset --hard`、`clean` 或删除未确认数据。

## 现场边界（no-live-agent）

- 所有 Agent 输出均为回放，**不现场调用 Agent**。
- 现场允许的操作仅四类：**运行测试、查看 diff、切换快照、操作 UI**。
- 不展示密钥、不上传敏感信息；演示数据为脱敏数据。

## 现场脚本（30 分钟）

| 时间 | 动作 | 说明 |
| --- | --- | --- |
| 0–3 分钟 | 投票 + grill 回放 | 现场提问"临期窗口是什么、填 0 意味着什么"；随后回放需求澄清（grill-with-docs）过程，给出目标、边界、验收证据 |
| 3–7 分钟 | propose / spec 回放 | 回放现有 change 原始 propose 如何形成"临期窗口可配置"基础规则；本次 grill 发现的边界在同一个进行中 change 内更新 spec，不新建 change |
| 7–12 分钟 | Red | 切换到 `red-test` 快照，运行测试，确认红为预期证据 |
| 12–20 分钟 | apply diff + Green | 回放 apply 产生的 diff；现场查看 diff、运行测试转绿 |
| 20–25 分钟 | 预设失败 review | 切到 `preset-failure` 快照：IPC/facade/UI 已接通、表面可操作，但实现错误拒绝 0（要求 >=1）；测试与规范核对抓住行为偏差，代码评审关注安全/清晰/可维护 |
| 25–30 分钟 | verify 回放 + 最终 UI | 回放 OpenSpec verify 规范核对；切到 `green-final`，运行测试、操作 UI 验证：填 0 保存、提醒行日期、今日到期/已逾期不受影响 |

## 排练步骤

1. 核对四阶段 commit（`76747c1` / `f771667` / `0554164` / `d304bd5`）已登记于 [environment-checklist.md](./environment-checklist.md)，并确认对应 worktree 就绪。
2. 在演示机上按 [environment-checklist.md](./environment-checklist.md) 自检命令逐条运行，记录真实结果。
3. 完整走一遍现场脚本，用计时器核对 30 分钟分段；记录每段实际耗时并微调。
4. 验证 UI 操作路径与快照一致：配置 0 → 保存 → 立即刷新并持久化 → 提醒行显示日期。
5. 确认回放素材（diff、propose/spec、verify 输出）与对应快照一致。

## 回滚步骤（非破坏性安全流程）

- 单步失误：先确认 worktree 为 clean，再 detached checkout/switch 回到对应快照继续。
- 出现 dirty 状态：**立即停止**，禁止 `reset --hard`、`clean` 或删除未确认数据；新建一个 worktree 从对应 commit 重建干净环境，不破坏原 worktree。
- 意外持久化数据：使用独立用户数据目录，重置时仅删除该目录（见下节），不影响任何其他数据。

## 独立用户数据目录

演示应用必须使用**独立用户数据目录**，避免污染讲师日常数据，也便于一键重置：

- 启动演示构建时设置项目已支持的 `WORKBENCH_E2E_USER_DATA_DIR` 环境变量，将其指向独立目录；该测试钩子见 `src/main/index.ts`，不要用未经本项目验证的通用启动参数代替。
- 每次课前用全新目录，课后可删除；持久化演示数据的隔离是本演示的标准操作。
- 数据目录内的演示数据为脱敏数据。

## 阶段证据（2026-08-10 已回填，真实结果）

以下为四个阶段快照的实际验证结果，供演示回放引用；不虚构测试输出。

- **baseline `76747c1`**：typecheck 通过；4 个聚焦文件 83 tests 通过。
- **red-test `f771667`**：typecheck 通过；domain+integration 32 通过；main 新增 2 项以 `V2_MUTATION_UNKNOWN` 失败；renderer 新增 1 项因找不到"临期窗口"控件失败。
- **preset-failure `0554164`**：typecheck 通过；domain+integration 32 通过；main 仅 0 用例因"必须不小于 1"失败（负数/非整数通过）；renderer 仅 0 保存因客户端拒绝且未调用 mutation 失败（控件/日期已存在）。
- **green-final `d304bd5`**：typecheck 通过；4 个聚焦文件 95 tests 通过；全量 Vitest 93 files/1076 tests 通过；`npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict` 通过（Change is valid）；`npm run e2e:build` 通过（macOS arm64）；`npx playwright test e2e/workbench-v2-layout.spec.ts` 1/1 通过。以上均为 macOS arm64 开发机验证，**不代表 Windows 平台验证**。

评审与验证的完整记录见 [review-report.md](./review-report.md) 与 [verify-report.md](./verify-report.md)。

## 配套

- 口播与转场：[speaker-notes.md](./speaker-notes.md)
- 检查点与风险分级：[workflow-checklist.md](./workflow-checklist.md)
- 工具职责与边界：[tool-roles.md](./tool-roles.md)
- 代码评审记录：[review-report.md](./review-report.md)
- 规范核对记录：[verify-report.md](./verify-report.md)
