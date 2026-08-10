# 代码评审报告（review-report）

独立代码评审记录，用于培训回放（质量双门之代码评审侧）。记录真实过程，不粉饰。

## 评审对象

- change：`add-relocation-service-workbench`（进行中）
- 能力：workbench-todos（项目提醒，临期窗口配置）
- 阶段快照：baseline `76747c1` / red-test `f771667` / preset-failure `0554164` / green-final `d304bd5`
- 评审方式：对照 spec 逐条核对 + 变更 diff 审查；独立于实现过程

## 首次评审发现

- **Medium：超安全整数静默改值/日期溢出**。对超过安全整数上限的值未显式拒绝，存在被静默改写或日期计算溢出的风险。已修正：实现拒绝超范围值，spec 明确 0..9007199254740991 边界。
- **Medium：renderer 未证明立即刷新**。UI 侧缺少"保存后当前工作台立即按新窗口重新分类"的可观察证据。已修正：补充 renderer 聚焦用例验证保存后刷新。
- **Low（既有）：IPC 参数袋**。mutation 请求以参数袋对象传递，字段组合校验依赖实现约定。属既有非阻塞债务，本次未引入新风险。
- **Low（既有）：外部渠道否定测试**。仅工作台内展示的"不发送到外部渠道"为否定性验证，测试证据为断言不发送，无法穷尽证明。属既有非阻塞债务。

## 修正后复审发现

- **日期 spec 前置过宽**。"工作台展示提醒日期"场景的 GIVEN 未限定提醒必须包含日期且该日期有到期分类；领域允许仅备注无日期、也允许未来窗口外无分类。已修正：GIVEN 限定为"当前提醒包含提醒日期且该日期具有临期/今日到期/已逾期的到期分类"。
- **保存前/非法不变断言缺失**。缺少"保存前编辑值不生效"与"非法值拒绝后原窗口保持不变"的行为断言。已修正：补齐对应 spec 场景与测试。
- **Low：addBusinessDays NaN 防御**。日期运算函数缺少对 NaN 输入的防御性处理。已修正。

## 结论

- 按独立复审行动项完成修正并完成验证后，已知问题中无 blocker / high / medium。
- 保留的既有非阻塞债务：IPC 参数袋、外部渠道否定证明。均不阻塞培训夹具演示；正式产品合入仍需另行授权和评审。
- 透明说明：以上结论来自首次评审与修正后复审；最后三项最小修正（日期 spec 前置、保存前/非法不变断言、addBusinessDays NaN 防御）之后，未再执行第三轮独立 Oracle 评审，不冒充存在该轮验证。

## 实际验证（2026-08-10）

- 四阶段 typecheck 均通过；green-final 全量 Vitest 93 files/1076 tests 通过；`npm run e2e:build` 通过；单文件 Playwright（`e2e/workbench-v2-layout.spec.ts`）1/1 通过。
- 以上均为 macOS arm64 开发机验证，**不代表 Windows 平台验证**。

配套：[verify-report.md](./verify-report.md)、[demo-runbook.md](./demo-runbook.md)。
