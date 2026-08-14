# training-change：培训夹具材料包（提醒临期窗口配置入口）

> **培训夹具，不是产品 OpenSpec change。**
> 本目录位于 `docs/training/vibe-coding/` 下，是静态教学材料；openspec CLI 只扫描仓库根目录 `openspec/changes/`，**不会把本包当作活动产品 change 扫描**。本包没有任何产品批准、合入或发布语义。

本包为《Vibe Coding》课程备课与历史会话不可访问时的兜底提供**完整教学叙事材料**：用 proposal / spec / tasks / evidence 还原"提醒临期窗口配置入口"这条演示需求在远端培训分支上的完整开发闭环。全部内容冻结于 green-final `d304bd5` 当时的教学叙事，不随当前 HEAD 的 OpenSpec 归档继续漂移；它不是现场主入口。

## 为什么放在培训目录

- **原 change 已经归档**：演示曾依托的 change `add-relocation-service-workbench` 已归档到 `openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`。后续正式规格继续演进，当前基线与培训分支冻结的精细边界并不相同。
- **当前正式 spec 已漂移**：`openspec/specs/workbench-todos/spec.md` 的"临期窗口可配置、默认 7 个自然日"仍是旧两场景版本，**不含** 0 语义、安全整数、保存前不生效、持久化、日期可见等训练边界；培训分支 `d304bd5` 的加固 spec 从未同步进 main。
- **冻结教学叙事**：课程需要"当时的 spec 长什么样、当时的证据是什么"可以稳定引用。放进根 `openspec/changes/` 会与归档机制冲突并污染 CLI 扫描；放在 `docs/training/vibe-coding/training-change/` 随课件一起版本化，且明确不是产品 change。

## 与真实归档 change、培训分支的关系

- 本包不是真实归档 change 的副本或替代品。真实归档 change 是 `openspec/changes/archive/2026-08-10-add-relocation-service-workbench/`；本包只冻结教学中用到的培训分支 spec 叙事。
- 四阶段快照位于远端培训分支 `origin/training/vibe-coding-reminder-window`：
  - baseline `76747c1`（docs: add context map and training context）
  - red-test `f771667`（test: add red reminder window scenarios）
  - preset-failure `0554164`（training: add preset reminder window failure）
  - green-final `d304bd5`（fix: harden reminder window boundaries）
  - 另有叙事外中间提交 `380ad38`（fix: allow zero-day reminder window），**不作为四阶段展示**（见 [../presenter-preparation.md](../presenter-preparation.md)）。
- **最终实现只存在于远端培训分支，当前 main 不合入**：含 0 语义、安全整数、保存前不生效、保存后立即刷新、持久化、日期可见的完整配置入口与加固 spec 仅在 `origin/training/vibe-coding-reminder-window` 上；当前 main 既没有 `set_window_days` 变更操作，也没有"临期窗口"配置 UI。

## 非产品批准声明

- 本包中的 proposal / spec 是**教学叙事**，不代表获批产品需求，也不是任何正式产品决策。
- "无独立 reset"等条目是**夹具范围约定**（non-goal），只为课程聚焦而写，不冒充产品规格。
- 如未来要真正落地该能力，应另立正式 OpenSpec change，走正常澄清、规范、实现、评审流程；届时以当时的正式 spec 为准，不引用本包。

## 如何在课件中使用

- 本包可作为"当时文档长什么样"的脱敏静态证据，供备课或历史会话不可访问时使用，替代向 HEAD 中的 `openspec/` 现场查找（避免归档漂移影响演示）。
- 现场项目段打开已有历史会话并按关键节点讲解已有输出；其边界和兜底以 [../demo-runbook.md](../demo-runbook.md) 为准，讲解卡以 [../presenter-preparation.md](../presenter-preparation.md) 为准，环境准备以 [../environment-checklist.md](../environment-checklist.md) 为准。
- 本包五个文件对应闭环环节：proposal（需求澄清产物）→ spec（规范）→ tasks（最小步骤）→ evidence（验证证据与边界）。注意：本包**没有 design.md**（当时该 change 未产生 design 文档）；evidence.md 是**课程自定义的证据文件，不是标准 OpenSpec artifact**（标准 artifacts 为 proposal/spec/tasks/design）。
- 术语以课程词汇表 [../CONTEXT.md](../CONTEXT.md) 为准（培训夹具、四阶段快照、预设失败、质量双门等）；业务领域语言以仓库根目录 [../../../../CONTEXT.md](../../../../CONTEXT.md) 为准。

## 文件导航

| 文件 | 内容 |
| --- | --- |
| [proposal.md](./proposal.md) | 培训目标、problem/scope/non-goals（标注非产品提案） |
| [spec.md](./spec.md) | 静态教学规范：SHALL 需求 + GIVEN/WHEN/THEN 场景 |
| [tasks.md](./tasks.md) | grill→spec→Red→preset-failure→Green→review/verify 最小步骤与四阶段 commit 映射 |
| [evidence.md](./evidence.md) | 课程自定义验证证据与边界（非标准 OpenSpec artifact；计数、平台、strict 含义、归档漂移） |

本包没有 design.md（当时该 change 未产生 design 文档），因此不存在 design 决策章节。

## 安全边界

本包不含真实客户数据、内部信息或密钥；文中的业务日期（如 `2026-08-08`）均为脱敏教学数据。
