# 培训任务最小步骤（夹具）：grill → spec → Red → preset-failure → Green → review/verify

> **培训夹具的任务映射。** 映射到远端培训分支 `origin/training/vibe-coding-reminder-window` 的四阶段 commit：baseline `76747c1` / red-test `f771667` / preset-failure `0554164` / green-final `d304bd5`。`380ad38`（fix: allow zero-day reminder window）是叙事外中间提交，**不作为阶段展示**（见 [../presenter-preparation.md](../presenter-preparation.md)）。

| 步骤 | 最小动作 | 对应 commit | 产出 |
| --- | --- | --- | --- |
| 1. grill | 需求澄清：对"提醒临期窗口配置入口"提三个边界问题（0 是否合法？数值边界？保存时机与日期可见？），收敛为结论 | baseline `76747c1`（起点，无变更） | [proposal.md](./proposal.md) 的澄清结论 |
| 2. spec | 把澄清结论写成 SHALL 需求与 GIVEN/WHEN/THEN 场景（Red 之前先在计划中落定验收标准） | 落地在 green-final `d304bd5` 的 spec 变更中；教学上先于 Red 讲解 | [spec.md](./spec.md) |
| 3. Red | 只加失败测试：domain/integration 补 0 与大整数；main IPC 补 `set_window_days` 0 与非法值；renderer 补控件/保存/日期断言 | red-test `f771667` | 预期失败：main 2 项 `V2_MUTATION_UNKNOWN`、renderer 1 项找不到"临期窗口"控件 |
| 4. preset-failure | 预设错误实现：IPC op、facade、UI 全部接通，但 facade 校验写成 `days <= 0` 拒绝 0 | preset-failure `0554164` | 预期失败：0 用例被"必须不小于 1"拒绝 |
| 5. Green | 最小修复：facade/领域校验改为 0..`Number.MAX_SAFE_INTEGER` 非负安全整数；UI 保存前不生效、保存后立即刷新、行内日期可见；spec 同步加固 | green-final `d304bd5` | 4 个聚焦文件 95 tests、全量 93 files/1076 tests 通过 |
| 6. review/verify | 代码评审 + 规范核对 + strict 结构校验 | green-final `d304bd5` 之后的证据 | [../review-report.md](../review-report.md)、[../verify-report.md](../verify-report.md)、[evidence.md](./evidence.md) |

## 教学要点

- 每一步都是"最小步骤"：Red 只写测试、preset 只演示偏差、Green 只做最小修复，不夹带无关改动。
- preset-failure 是刻意准备的教学安排（课程词汇表见 [../CONTEXT.md](../CONTEXT.md)），不是真实故障。
- 现场不调用 Agent，只切换快照、查看 diff、运行已验证命令（边界见 [../demo-runbook.md](../demo-runbook.md)）。
- 步骤 6 的 strict 只验证规格结构，行为符合性由测试与评审共同支持（见 [evidence.md](./evidence.md)）。
