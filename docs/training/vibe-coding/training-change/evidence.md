# 培训验证证据与边界（夹具）

> 证据来自 green-final `d304bd5` 当时在 macOS arm64 开发机上的记录，已回填到课件材料（阶段证据见 [../demo-runbook.md](../demo-runbook.md)，证据卡见 [../presenter-preparation.md](../presenter-preparation.md)，核对映射见 [../verify-report.md](../verify-report.md)，评审记录见 [../review-report.md](../review-report.md)）。本文件冻结这些数字与边界，供新版 PPT 回放引用，不随当前 HEAD 演进。

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
- **strict 只验证结构**：OpenSpec strict 的"Change is valid"只校验 CLI 能解析到的规格格式与 requirement/scenario 结构，不证明 proposal/design/tasks 完成度，也不校验行为符合性；行为结论还需结合机器执行证据与代码评审（见 [../verify-report.md](../verify-report.md)）。
- **"无独立 reset"是夹具 non-goal**：不写成 spec 需求，也不在核对范围内（见 [proposal.md](./proposal.md)）。

## 数据安全

全部数字与业务日期为脱敏教学数据；本包不含真实客户数据、内部信息或密钥。
