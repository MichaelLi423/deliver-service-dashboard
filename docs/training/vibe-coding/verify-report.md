# 规范核对报告（verify-report）

按当前同一 `add-relocation-service-workbench` change 的 `workbench-todos` spec，将 requirements/scenarios 与证据做映射，用于培训回放（质量双门之规范核对侧）。

## 依据

- change：`add-relocation-service-workbench`（进行中，不新建 change）
- spec：`specs/workbench-todos/spec.md`
- 核对阶段：green-final `d304bd5`

## Requirements/Scenarios → 证据映射

| 行为点 | spec 出处（workbench-todos） | 证据 |
| --- | --- | --- |
| 0 语义 | Scenario：临期窗口为 0 | domain+integration 测试；preset-failure 阶段"0 保存失败/其余通过"与 green-final"0 合法"的红绿对照 |
| 安全整数边界 / 无额外业务上限 | Requirement：临期窗口可配置、默认 7 个自然日；Scenario：拒绝非法与超范围值 | 超范围/负数/非整数拒绝测试；实现含安全整数校验（0..9007199254740991） |
| 显式保存前不生效 | Scenario：保存前编辑值不生效 | 保存前分类不变断言测试 |
| 保存后立即刷新 | Scenario：临期窗口保存后立即生效并持久化 | renderer 保存后重新分类的可观察断言 |
| 持久化 | Scenario：临期窗口保存后立即生效并持久化（关闭重开保持） | 配置持久化测试（关闭重开后保持） |
| 提醒日期可见 | Scenario：工作台展示提醒日期 | renderer 断言提醒行展示格式化日期 |
| 仅工作台显示 | Scenario：仅工作台内提醒 | 不发送外部渠道的否定断言（见 [review-report.md](./review-report.md) 既有债务说明） |

## 工具与判定说明

- `npx @fission-ai/openspec@1.8.0 validate add-relocation-service-workbench --strict` 通过（Change is valid）。
- 该命令只验证**规格结构**（格式、引用、change 完整性）；**行为符合性**由上表的测试证据与 [review-report.md](./review-report.md) 的代码评审共同支持，二者互补（质量双门）。
- "无独立 reset"是本课培训 non-goal，不写成 spec 需求，故不在核对范围内。

## 结论

green-final 阶段，实现行为与 workbench-todos spec 约定一致；结论可用于培训回放（演示 3f：verify 回放 + 最终 UI）。

配套：[review-report.md](./review-report.md)、[demo-runbook.md](./demo-runbook.md)。
