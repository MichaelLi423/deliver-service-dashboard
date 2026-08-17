# 培训验证证据与边界（夹具）

> 证据来自 green-final `d304bd5` 当时在 macOS arm64 开发机上的记录，已整理为备课与历史会话不可访问时的兜底材料，也是代码评审与规范核对结论的唯一长期证据摘要（阶段边界见 [../demo-runbook.md](../demo-runbook.md)，讲解卡见 [../presenter-preparation.md](../presenter-preparation.md)）。本文件冻结这些数字与边界，不随当前 HEAD 演进。

## 阶段证据（当时记录）

| 阶段 | commit | typecheck | 聚焦 tests | 全量 tests | 其他验证 |
| --- | --- | --- | --- | --- | --- |
| baseline | `76747c1` | 通过 | 4 个聚焦文件 83 tests 通过 | — | 尚无本次配置入口 |
| red-test | `f771667` | 通过 | domain+integration 32 通过；main 新增 2 项以 `V2_MUTATION_UNKNOWN` 失败；renderer 新增 1 项因找不到"临期窗口"控件失败 | — | — |
| preset-failure | `0554164` | 通过 | domain+integration 32 通过；main 仅 0 用例因"必须不小于 1"失败（负数/非整数通过）；renderer 仅 0 保存因客户端拒绝且未调用 mutation 失败（控件/日期已存在） | — | — |
| green-final | `d304bd5` | 通过 | 4 个聚焦文件 95 tests 通过 | 93 files / 1076 tests 通过 | 见下 |

green-final 的其余验证（均为 macOS arm64 开发机）：

- OpenSpec strict：`npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict` 当时通过（Change is valid）。
- `npm run e2e:build` 通过（Electron Forge 打包）。
- 布局 E2E：`npx playwright test e2e/workbench-v2-layout.spec.ts` 1/1 通过。

## 边界与说明

- **macOS ≠ Windows**：以上全部证据来自 macOS arm64 开发机，**不代表 Windows 平台验证**。
- **原 change 后来归档**：演示曾依托的 change `add-relocation-service-workbench` 已归档到 `../../../../openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`；后续正式规格继续演进，当前基线与培训分支冻结的训练边界不同。
- **当前正式 spec 不包含全部训练边界**：`../../../../openspec/specs/workbench-todos/spec.md` 的"临期窗口可配置、默认 7 个自然日"仍是旧两场景版本（默认 7 天、可配置并立即生效），没有 0 语义、安全整数、保存前不生效、保存后立即刷新、持久化、日期可见这些场景；当前 main 也没有 `set_window_days` 变更操作与"临期窗口"配置 UI。因此本夹具冻结 green-final 当时的教学叙事（见 [spec.md](./spec.md)）。
- **strict 只验证结构**：OpenSpec strict 的"Change is valid"只校验 CLI 能解析到的规格格式与 requirement/scenario 结构，不证明 proposal/design/tasks 完成度，也不校验行为符合性；行为结论还需结合机器执行证据与代码评审（见下）。
- **"无独立 reset"是夹具 non-goal**：不写成 spec 需求，也不在核对范围内（见 [proposal.md](./proposal.md)）。

## 代码评审结论（历史）

- 首次评审与修正后复审之后，已知问题中**无 blocker / high / medium**。
- 已修正的 medium：**超安全整数静默改值/日期溢出**（实现拒绝超范围值，spec 明确 0..9007199254740991 边界）；**renderer 未证明立即刷新**（补充保存后立即重新分类的聚焦用例）。
- 修正后复审补齐：日期 spec 前置过宽、保存前/非法值不变断言缺失、`addBusinessDays` NaN 防御。
- 保留的既有非阻塞 low 债务：**IPC 参数袋**、**外部渠道否定证明**（否定性断言无法穷尽证明不发送）。均不阻塞培训夹具演示；正式产品合入仍需另行授权和评审。
- 透明说明：最后三项最小修正之后**未再执行第三轮独立 Oracle 代码评审**，不冒充存在该轮验证；2026-08-13 终审是课程内容终审，不是代码分支新一轮评审。

## 规范映射结论（历史）

- 按当时 `workbench-todos` spec 将 requirements/scenarios 与证据逐条映射（0 语义、安全整数边界、保存前不生效、保存后立即刷新、持久化、提醒日期可见、仅工作台显示），green-final 阶段实现行为与 spec 约定一致。
- 该映射是**历史人工/等效规范映射**：历史阶段**没有运行过** `/opsx-verify`（`.opencode/commands/opsx-verify.md` 是项目已有的启发式命令——读取 artifacts、搜索代码，做完整性/正确性/连贯性判断；不需要 profile 前置，也不会自动跑项目测试）。
- 机器执行证据逐项边界：tests 只证明被断言的特定行为；typecheck 只证明类型一致性；build/package 只证明可构建、可打包；E2E 只证明特定环境、特定路径的特定行为。

## 数据安全

全部数字与业务日期为脱敏教学数据；本包不含真实客户数据、内部信息或密钥。
