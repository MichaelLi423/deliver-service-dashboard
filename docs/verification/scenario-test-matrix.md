# 场景→测试矩阵（tasks 10.1）

> 由 `npm run verify:matrix`（scripts/build-verification-matrix.mjs）自动生成。
> 登记表：`docs/verification/scenario-map.mjs`。脚本校验每一条证据（文件存在且标题关键词出现），
> 找不到证据或证据无效时如实标记为缺口，不谎称覆盖。状态图例：✅ 有效证据 · ⏳ 待验证（真实源迁移/Windows）· ❌ 缺口。

## 汇总

| 指标 | 数量 |
| --- | --- |
| 能力 spec 数 | 12 |
| ADDED Requirements 场景总数 | 150 |
| 有有效测试证据（✅） | 150 |
| 待验证（⏳，真实源迁移 / Windows 验证） | 0 |
| 缺证据 / 证据无效（❌） | 0 |

### 待验证与阻塞项（诚实边界）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 10.4/10.5 Windows 打包验证 | ⏳ | macOS 开发机 Electron E2E 已通过（e2e/electron-smoke.spec.ts、e2e/import-wizard-flow.spec.ts、e2e/import-worker-runtime.spec.ts）；Windows 安装包与 Windows 操作系统账户保护未验证 |

## 按能力对照

### damage-repair-tracking

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 损坏/维修事项删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留」 |  |
| 损坏/维修事项删除 | 未确认不删除 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 损坏/维修事项删除 | 删除时原子清理维修上门关联引用 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「确认后删除：事项从 countItems 统计消失，且仅指向该事项的维修上门关联被清理」 |  |
| 损坏/维修事项删除 | 删除不影响关联仪器与项目 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「删除不影响关联仪器与搬迁项目」 |  |

### local-data-persistence

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 追加迁移保存新增字段与枚举并兼容旧库 | 追加迁移不修改已发布迁移 | ✅ | `tests/persistence/migration-v15.test.ts`「全新库引导到最新版本：迁移序列 1..16、user_version=16、v15 四列已建立、审计表/索引/FK 已建、可写入最小审计事实」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 旧库升级保留既有数据并初始化新字段 | ✅ | `tests/persistence/migration-v15.test.ts`「v14 存量库升级到 v15：业务数据完整保留、legacy region 原文不变、新列空初始化、legacy origin/deleted marker 保持 null」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 新增字段与受控区域值持久化 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「v15 新字段建档后更新并关闭重开：region 受控枚举及 null/false 语义均持久化」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 迁移诊断并清理孤立财务事实 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留」<br>`tests/integration/financial-integrity.sqlite.test.ts`「治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 结构性外键违规持续报告且不阻断迁移 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 迁移失败保留可恢复状态 | ✅ | `tests/persistence/migration.test.ts`「迁移失败：注入失败迁移 → 整体回滚、保留原库与迁移前安全备份、返回明确恢复信息」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | v15 已发布库追加 v16 不修改既有迁移 | ✅ | `tests/persistence/migration-v16.test.ts`「全新库引导到最新版本：迁移序列 1..16、user_version=16、三列已建立、三态写入与 foreign_key_check 通过」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | v15 库升级保留数据并初始化暂定范围列 | ✅ | `tests/persistence/migration-v16.test.ts`「v15 存量库升级到 v16：业务数据完整保留、legacy region 原文不变、v15 字段原样保留、新列 null 初始化」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | 暂定搬迁范围字段持久化保留 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「关闭重开持久化：建档/编辑的暂定仪器范围字段重开后保留」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | v16 迁移失败保留可恢复状态 | ✅ | `tests/persistence/migration-v16.test.ts`「注入失败保留迁移前数据与可恢复状态：整体回滚、版本仍为 15、全部 v16 结构回滚、迁移前备份可恢复」 |  |

### operational-reporting

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 区域维度与责任人归属 | 区域按去除空格后的精确值分组 | ✅ | `tests/domain/operational-reporting.test.ts`「区域按去除首尾空白后的精确值分组（7.8）」 |  |
| 区域维度与责任人归属 | 存量非标准区域不被静默转换 | ✅ | `tests/domain/operational-reporting.test.ts`「存量非标准区域原值保留并归入「待调整」独立分组（不猜测、不置空、不丢弃）」 |  |
| 区域维度与责任人归属 | 区域修改后报表实时重算 | ✅ | `tests/domain/operational-reporting.test.ts`「区域修改后历史报表实时重算（7.8）」<br>`tests/integration/operational-reporting.sqlite.test.ts`「区域修改实时重算；账号改名后历史统计仍按动作记录快照归属」 |  |
| 区域维度与责任人归属 | 工作量归属责任人取动作记录 | ✅ | `tests/domain/operational-reporting.test.ts`「事项数量与金额按登记月份归属并取责任人快照」<br>`tests/integration/operational-reporting.sqlite.test.ts`「区域修改实时重算；账号改名后历史统计仍按动作记录快照归属」 |  |

### project-financial-closure

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 无任何项目时待掉票金额为 0 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 孤立财务事实不污染指标 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「孤立排除：引用不存在项目的掉票/合同事实不计入指标」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 仍存在项目的有效财务事实计入指标 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 诊断清理与防复发 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「治理后待掉票金额指标保持正常（现有 repository 读取验证，不改其代码）」<br>`tests/integration/financial-integrity.sqlite.test.ts`「防复发：正常 foreign_keys=ON 下写入无项目合同/掉票被拒；治理不产生新孤立行」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 治理不改变掉票撤销终态与不可物理删除 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「invoice 删除映射为撤销：必填撤销日期/原因，行不物理删除」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 活跃孤立掉票治理撤销保留原行 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 结构性外键违规持续报告且不宣称归零 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费」 |  |

### qr-request-tracking

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 重复申请保留历史 | 重复申请保留历史 | ✅ | `tests/domain/qr-request-tracking.test.ts`「新旧申请均保留在申请历史中，各自独立保存并计数」 |  |
| 重复申请保留历史 | 确认删除后不再保留 | ✅ | `tests/domain/qr-request-tracking.test.ts`「确认后删除：从申请历史与工作量统计中消失」 |  |
| 二维码申请记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留」 |  |
| 二维码申请记录删除 | 未确认不删除 | ✅ | `tests/domain/qr-request-tracking.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 二维码申请记录删除 | 删除不影响仪器标记与项目 | ✅ | `tests/domain/qr-request-tracking.test.ts`「删除不影响仪器"二维码是否申请"手工标记」 |  |

### relocation-execution

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 暂存地址与是否暂存 | 搬迁范围记录暂存地址 | ✅ | `tests/domain/relocation-fields.test.ts`「暂存地址/是否暂存为手工维护执行事实：修改不影响主状态」 |  |
| 暂存地址与是否暂存 | 执行准备记录是否暂存 | ✅ | `tests/domain/relocation-fields.test.ts`「暂存地址/是否暂存为手工维护执行事实：修改不影响主状态」 |  |
| 暂存地址与是否暂存 | 暂存信息不触发状态流转 | ✅ | `tests/domain/relocation-fields.test.ts`「暂存地址/是否暂存为手工维护执行事实：修改不影响主状态」 |  |
| 计划装机日期 | 记录计划装机日期 | ✅ | `tests/main/workbench-v2-ipc.test.ts`「update_project 经 IPC：0810 标量（备注/暂存/是否批复/暂定数量/计划装机日期）保存并经 detail 回显」 |  |
| 计划装机日期 | 计划装机日期不触发状态流转 | ✅ | `tests/integration/new-batch-behaviors.sqlite.test.ts`「计划装机完成日期：可随新建/补齐/更新写入，且不触发生命周期」 |  |
| 项目暂定搬迁范围字段 | 建档时填写暂定搬迁范围并持久化 | ✅ | `tests/persistence/migration-v16.test.ts`「全新库引导到最新版本：迁移序列 1..16、user_version=16、三列已建立、三态写入与 foreign_key_check 通过」<br>`tests/renderer/app.test.tsx`「待进单通过公共建档 payload 显式提交暂定范围未填写三态且不登记仪器」 |  |
| 项目暂定搬迁范围字段 | 暂定搬迁范围允许留空后补 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「编辑资料回显：update_project 填写/修改/清空范围字段，不建仪器、不改状态」 |  |
| 项目暂定搬迁范围字段 | UPS 未填写区别于否 | ✅ | `tests/persistence/migration-v16.test.ts`「全新库引导到最新版本：迁移序列 1..16、user_version=16、三列已建立、三态写入与 foreign_key_check 通过」 |  |
| 项目暂定搬迁范围字段 | 暂定搬迁范围不建仪器不改既有事实 | ✅ | `tests/domain/relocation-execution.test.ts`「项目暂定仪器范围（v16：只更新项目标量，不建仪器、不触发主状态）」 |  |
| 暂定数量登记 | 只记暂定数量不建仪器 | ✅ | `tests/domain/relocation-execution.test.ts`「只记暂定数量不建仪器：保存数量信息且不创建任何仪器记录」 |  |
| 暂定数量登记 | 仪器数量允许建档后补充 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 编辑项目资料查看并留空暂定数量 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 编辑项目资料补录暂定数量并保存最新值 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 编辑项目资料调整暂定数量不改变既有仪器事实 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 调整暂定数量不触发状态流转 | ✅ | `tests/domain/relocation-execution.test.ts`「项目暂定仪器范围（v16：只更新项目标量，不建仪器、不触发主状态）」 |  |

### relocation-project-lifecycle

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 项目备注 | 建档时填写可选项目备注 | ✅ | `tests/domain/relocation-fields.test.ts`「项目备注可空：建档后补充/修改/清空，不触发主状态流转」 |  |
| 项目备注 | 建档后补充或修改项目备注 | ✅ | `tests/domain/relocation-fields.test.ts`「项目备注可空：建档后补充/修改/清空，不触发主状态流转」 |  |
| 主状态人工调整与系统校验 | 负责人直接调整主状态 | ✅ | `tests/domain/relocation-status.test.ts`「负责人直接调整主状态：待执行 → 执行中 校验通过」 |  |
| 主状态人工调整与系统校验 | 非法状态调整被拒 | ✅ | `tests/domain/relocation-status.test.ts`「非法状态调整被拒：待执行 → 已完成（尚无掉票闭环依据）」 |  |
| 主状态人工调整与系统校验 | 实际装机完成日期自动进入待验收 | ✅ | `tests/domain/lifecycle.test.ts`「自动触发 1：实际装机完成时间自动置为待验收，且优先于人工选择」<br>`tests/domain/relocation-status.test.ts`「录入实际装机完成时间自动进入待验收（TBD-07）」 |  |
| 主状态人工调整与系统校验 | 验收报告自动进入待掉票 | ✅ | `tests/domain/lifecycle.test.ts`「自动触发 2：标记验收报告并填写报告形成日期自动置为待掉票（不要求客户确认）」 |  |
| 主状态人工调整与系统校验 | 金额闭环自动重算 | ✅ | `tests/domain/lifecycle.test.ts`「自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）」 |  |
| 主状态人工调整与系统校验 | 计划上门日期到达自动进入执行中优先于人工状态值 | ✅ | `tests/domain/lifecycle.test.ts`「到期自动推进优先于人工目标值」 |  |
| 正式进单 | 填写进单日期保持填写值 | ✅ | `tests/domain/relocation-entry.test.ts`「填写进单时间保持填写值，不以当前时间覆盖」 |  |
| 正式进单 | 进单日期默认当天且可补录 | ✅ | `tests/domain/relocation-entry.test.ts`「进单时间未填写默认取当前时间，并允许进单后补录或修正」 |  |
| 正式进单 | 待进单进单日期可空 | ✅ | `tests/domain/relocation-entry.test.ts`「待进单阶段进单时间可空」 |  |
| 正式进单 | 核心信息缺失拒绝进单 | ✅ | `tests/domain/relocation-entry.test.ts`「核心信息缺失拒绝进单并就地提示缺失项」 |  |
| 正式进单 | 缺合同拒绝进单 | ✅ | `tests/domain/relocation-entry.test.ts`「缺合同拒绝进单并提示先补齐合同」 |  |
| 正式进单 | 建档移除字段不阻塞进单 | ✅ | `tests/renderer/app.test.tsx`「新建项目由明确意图提交正式进单且不夹带服务单等已移除字段」 |  |
| 未进单先执行 | 批复后优先安排上门 | ✅ | `tests/domain/relocation-status.test.ts`「未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单」<br>`tests/integration/critical-paths.sqlite.test.ts`「1. 未进单先执行全链路」 |  |
| 未进单先执行 | 先执行后进单由负责人确定主状态 | ✅ | `tests/domain/relocation-status.test.ts`「先执行后进单：正式进单基线待执行（无自动触发时），主状态由负责人后续确定」<br>`tests/domain/lifecycle.test.ts`「标签清除后主状态由负责人人工确定，且明确自动触发仍生效」 |  |
| 未进单先执行 | 先录入实际装机完成日期后进单自动待验收 | ✅ | `tests/domain/relocation-status.test.ts`「先录入实际装机完成时间后进单自动待验收（TBD-07）」<br>`tests/integration/relocation-project-lifecycle.sqlite.test.ts`「未进单先执行 → 正式进单在原项目上完成，自动触发待验收」 |  |
| 未进单先执行 | 计划上门日期到期后待进单自动进入执行中 | ✅ | `tests/domain/lifecycle.test.ts`「待进单带"未进单先执行"标签到期自动进入执行中」 |  |
| 未进单先执行 | 已在执行中的项目正式进单不倒退 | ✅ | `tests/integration/relocation-project-lifecycle.sqlite.test.ts`「正式进单不倒退：已在执行中的项目进单后保持执行中，在原项目上完成」 |  |
| 执行准备与待验收触发 | 计划上门日期与运输日期分开记录 | ✅ | `tests/domain/relocation-status.test.ts`「计划上门时间与计划运输时间分开记录」 |  |
| 执行准备与待验收触发 | 场地确认不影响状态流转 | ✅ | `tests/domain/relocation-status.test.ts`「场地确认不影响状态流转」 |  |
| 执行准备与待验收触发 | 计划上门日期到达待执行项目自动进入执行中 | ✅ | `tests/domain/lifecycle.test.ts`「到期：待执行 → 执行中」 |  |
| 执行准备与待验收触发 | 计划上门日期到期待进单项目自动进入执行中 | ✅ | `tests/domain/lifecycle.test.ts`「到期：待进单 → 执行中（reason plan_visit_due）」 |  |
| 执行准备与待验收触发 | 自动推进幂等重复检查不重复触发 | ✅ | `tests/integration/relocation-project-lifecycle.sqlite.test.ts`「重复执行幂等零写：项目/revision/audit 全零变化」 |  |
| 执行准备与待验收触发 | 计划日期不自动流转 | ✅ | `tests/domain/relocation-status.test.ts`「计划时间到期不自动流转（计划时间与场地确认均不触发主状态）」 |  |
| 执行准备与待验收触发 | 待验收与待掉票不倒退 | ✅ | `tests/domain/lifecycle.test.ts`「到期：待验收/待掉票不倒退」 |  |
| 执行准备与待验收触发 | 终态项目不因计划上门日期改变 | ✅ | `tests/domain/lifecycle.test.ts`「到期：已完成终态不变」<br>`tests/domain/lifecycle.test.ts`「到期：已取消终态不变（仍拒绝流转）」 |  |
| 执行准备与待验收触发 | 漏跑后补推进 | ✅ | `tests/domain/lifecycle.test.ts`「逾期补推进：计划上门日期早于 today 数日（漏跑）仍自动进入执行中」 |  |
| 执行准备与待验收触发 | 计划运输日期与场地确认不触发流转 | ✅ | `tests/integration/relocation-project-lifecycle.sqlite.test.ts`「实际装机完成自动待验收并持久化；计划时间与场地确认不触发」 |  |
| 执行准备与待验收触发 | 录入实际装机完成日期自动进入待验收 | ✅ | `tests/domain/relocation-status.test.ts`「录入实际装机完成时间自动进入待验收（TBD-07）」 |  |
| 项目基础字段与合同日期 | 记录旧址与新址联系人 | ✅ | `tests/domain/relocation-fields.test.ts`「记录旧址与新址联系人（手工文本）」 |  |
| 项目基础字段与合同日期 | 记录项目默认旧址与新址 | ✅ | `tests/domain/relocation-fields.test.ts`「记录项目默认旧址与新址」 |  |
| 项目基础字段与合同日期 | 旧址与新址允许建档后补充 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「旧址/新址建档留空后可补录：不改变状态，关闭重开后保留」 |  |
| 项目基础字段与合同日期 | 合同截止日期不得早于开始日期 | ✅ | `tests/domain/relocation-fields.test.ts`「合同截止日期早于开始日期时拒绝保存并提示」<br>`tests/domain/relocation-fields.test.ts`「合同截止日期等于开始日期允许保存」 |  |
| 项目区域 | 区域仅五个固定选项 | ✅ | `tests/domain/relocation-fields.test.ts`「五个固定取值均可保存：去除首尾空白后保存规范化值」 |  |
| 项目区域 | 非枚举区域值被拒 | ✅ | `tests/domain/relocation-fields.test.ts`「非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）」 |  |
| 项目区域 | 区域为自由文本 | ✅ | `tests/domain/relocation-fields.test.ts`「非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）」 |  |
| 项目区域 | 区域修改后报表实时重算 | ✅ | `tests/domain/relocation-fields.test.ts`「区域修改后按最新值实时重算分组（不保存快照）」<br>`tests/domain/operational-reporting.test.ts`「区域修改后历史报表实时重算（7.8）」 |  |

### serial-address-update

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 序列号地址更新事实逐台登记 | 逐台创建更新事实 | ✅ | `tests/domain/serial-address-update.test.ts`「逐台创建更新事实：记录客户名称、新址地址、序列号、Account ID 与更新时间」 |  |
| 序列号地址更新事实逐台登记 | 独立登记不关联项目或仪器 | ✅ | `tests/domain/serial-address-update.test.ts`「instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器」 |  |
| 序列号地址更新事实逐台登记 | 一台仪器多次地址变化 | ✅ | `tests/domain/serial-address-update.test.ts`「一台仪器多次地址变化：每次登记各创建一条，按更新时间保留可追溯」 |  |
| 非空字段与序列号校验 | 非空字段缺失拒绝保存 | ✅ | `tests/domain/serial-address-update.test.ts`「非空字段缺失拒绝保存」 |  |
| 非空字段与序列号校验 | 序列号与登记仪器一致 | ✅ | `tests/domain/serial-address-update.test.ts`「序列号与登记仪器一致：不一致拒绝保存」 |  |
| 非空字段与序列号校验 | 独立登记仅校验序列号非空 | ✅ | `tests/domain/serial-address-update.test.ts`「instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器」 |  |
| 非空字段与序列号校验 | 不引入未确认序列号格式 | ✅ | `tests/domain/serial-address-update.test.ts`「不引入未确认的序列号格式约束：仅非空与仪器一致」 |  |
| 序列号地址更新记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/domain/serial-address-update.test.ts`「确认后删除：更新事实从列表与按更新日期计数统计中消失」 |  |
| 序列号地址更新记录删除 | 未确认不删除 | ✅ | `tests/domain/serial-address-update.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 序列号地址更新记录删除 | 删除不影响关联仪器与 Ship-to | ✅ | `tests/domain/serial-address-update.test.ts`「删除更新事实不修改或删除关联仪器（与 Ship-to 主数据无关）」 |  |
| 序列号地址更新记录删除 | 删除后实际关联以剩余最近更新事实为准 | ✅ | `tests/domain/serial-address-update.test.ts`「删除较新更新事实后，仪器实际关联新址回退到剩余最近更新事实」 |  |

### service-order-recording

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 服务单记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/domain/service-order-recording.test.ts`「确认后删除：开单记录从列表与开单量统计中消失，其他记录不受影响」 |  |
| 服务单记录删除 | 未确认不删除 | ✅ | `tests/domain/service-order-recording.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 服务单记录删除 | 删除不影响关联项目 | ✅ | `tests/domain/service-order-recording.test.ts`「删除不影响关联项目：项目保留，主状态与进单状态不变」 |  |
| 服务单记录删除 | 删除为原子操作 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「service_order 删除成功：行删除 + 来源审计保留并标记 + tombstone 原子写入 + invalidate 标签」 |  |

### ship-to-management

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| Ship-to 申请记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留」 |  |
| Ship-to 申请记录删除 | 删除非退回或取消 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：删除处理中无 Account ID 的并行申请只物理删除目标，不取消或回退另一申请，仍保留 tombstone」 |  |
| Ship-to 申请记录删除 | 未完成申请直接删除 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：未完成且无 Account ID 直接删除；异常未完成已有 Account ID 保守拒绝」 |  |
| Ship-to 申请记录删除 | 已完成申请对应 Ship-to 被引用时拒绝删除 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：completed 对应 Ship-to 仍被仪器引用时原子拒绝；legacy 无来源也拒绝」 |  |
| Ship-to 申请记录删除 | 已完成申请对应 Ship-to 无引用时随申请清理 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：completed 经 origin_request_id 证明来源，无引用随申请原子清理 Ship-to」 |  |

### workbench-interface

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 待掉票指标仅由有效关联财务事实计算 | 待掉票金额仅计入有效关联事实 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「孤立排除：引用不存在项目的掉票/合同事实不计入指标」 |  |
| 待掉票指标仅由有效关联财务事实计算 | 无项目时指标显示 0 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0」 |  |
| 待掉票指标仅由有效关联财务事实计算 | 保持有效项目财务口径 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入」<br>`tests/integration/financial-closure.sqlite.test.ts`「已取消排除：仅已取消项目存在时 pendingAmount 为 0（口径不改动为仅活跃项目）」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 登记记录删除需确认 | ✅ | `tests/renderer/app.test.tsx`「删除确认取消时通用保护阻止 v2Delete 调用」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 各类登记记录均提供删除入口 | ✅ | `tests/renderer/app.test.tsx`「历史抽屉明确列出八类删除记录并分别走关联与独立读取路由」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 搬迁项目维持取消语义 | ✅ | `tests/renderer/app.test.tsx`「项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 掉票记录维持撤销语义 | ✅ | `tests/renderer/app.test.tsx`「项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销」 |  |
| 顶栏浏览全部记录入口与业务日期倒序 | 顶栏入口跳转完整记录视图 | ✅ | `tests/renderer/app.test.tsx`「统一历史入口按日期真正跨项目读取，展示项目上下文并受保护删除」 |  |
| 顶栏浏览全部记录入口与业务日期倒序 | 按业务日期倒序排列 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页」 |  |
| 顶栏浏览全部记录入口与业务日期倒序 | 相同业务日期稳定排序 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页」 |  |
| 项目队列关键词搜索与固定区域筛选 | 按客户名称或编号搜索 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND」 |  |
| 项目队列关键词搜索与固定区域筛选 | 区域筛选为固定枚举 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND」 |  |
| 项目队列关键词搜索与固定区域筛选 | 搜索与区域筛选组合 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND」 |  |
| 编辑项目资料维护暂定仪器数量 | 查看已有暂定仪器数量 | ✅ | `tests/renderer/app.test.tsx`「编辑项目资料打开已有 temporaryInstrumentCount 时显式回显值，并支持补录、调整及清空」 |  |
| 编辑项目资料维护暂定仪器数量 | 暂定仪器数量允许留空 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 编辑项目资料维护暂定仪器数量 | 补录或调整后回显最新值 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 高密度项目队列固定每页 20 个项目 | 每页固定展示 20 个项目 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确」 |  |
| 高密度项目队列固定每页 20 个项目 | 筛选或搜索后重算总数与分页 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20」 |  |
| 高密度项目队列固定每页 20 个项目 | 翻页时页内顺序稳定 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确」 |  |
| 高密度项目队列固定每页 20 个项目 | 最后一页允许少于 20 个项目 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20」 |  |
| 高密度项目队列固定每页 20 个项目 | 不展示错误的每页数量文案 | ✅ | `tests/interface/layout.test.ts`「项目队列明确固定每页20且不存在旧的每页最多50项文案」 |  |
| 页面滚动时顶部导航与任务指挥台固定头部 | 滚动时头部整体固定 | ✅ | `tests/interface/layout.test.ts`「单一页面滚动根下 topbar 与 command 按真实导航高度协同固定并保留滚动补偿」 |  |
| 页面滚动时顶部导航与任务指挥台固定头部 | 固定头部不遮挡内容 | ✅ | `tests/interface/layout.test.ts`「单一页面滚动根下 topbar 与 command 按真实导航高度协同固定并保留滚动补偿」 |  |
| 页面滚动时顶部导航与任务指挥台固定头部 | 不拦截键盘焦点 | ✅ | `e2e/workbench-v2-layout.spec.ts`「Oracle #10 任务指挥台布局、150% 文本缩放与 sticky 深层表单焦点均不遮挡」 |  |
| 单页分组录入创建搬迁项目 | 单页分组呈现与对应字段 | ✅ | `tests/renderer/app.test.tsx`「新建项目明确保存意图与可后补字段，弹层首字段聚焦且 Escape 可关闭」<br>`tests/renderer/app.test.tsx`「新建搬迁项目单页四分组包含执行日期且不再使用旧装机标签」 |  |
| 单页分组录入创建搬迁项目 | 搬迁范围分组字段 | ✅ | `tests/renderer/app.test.tsx`「新建搬迁项目单页四分组包含执行日期且不再使用旧装机标签」 |  |
| 单页分组录入创建搬迁项目 | 执行准备分组字段 | ✅ | `tests/renderer/app.test.tsx`「新建搬迁项目单页四分组包含执行日期且不再使用旧装机标签」 |  |
| 单页分组录入创建搬迁项目 | 保存为待进单 | ✅ | `tests/integration/workbench-facade.sqlite.test.ts`「真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请」 | 单页分组录入「保存为待进单」（intent=draft）经 WorkbenchFacade（Electron 主进程入口）真实落库；正式进单/未进单先执行两个保存路径由 electron-smoke E2E 覆盖 |
| 单页分组录入创建搬迁项目 | 正式进单 | ✅ | `tests/renderer/app.test.tsx`「新建项目由明确意图提交正式进单且不夹带服务单等已移除字段」 |  |
| 单页分组录入创建搬迁项目 | 未进单先执行 | ✅ | `e2e/electron-smoke.spec.ts`「未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）」 |  |
| 单页分组录入创建搬迁项目 | 填写服务单号要求工程师并同次创建开单 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器二维码与损坏维修表单给出对应字段约束和就地反馈」 | 单页录入中「服务单号必填工程师并同次保存」由领域测试 service-order-recording 3.10 覆盖，界面透传 |
| 单页分组录入创建搬迁项目 | 可后补字段不无提示丢失且不自动生成提醒 | ✅ | `tests/renderer/app.test.tsx`「新建项目明确保存意图与可后补字段，弹层首字段聚焦且 Escape 可关闭」 |  |
| 详情 tab 按需展开与独立模块 | 详情 tab 可切换展开 | ✅ | `tests/renderer/app.test.tsx`「详情 tab 按需加载，项目总览不读取 section」 |  |
| 详情 tab 按需展开与独立模块 | 扩展 tab 或独立导航模块提供新增能力 | ✅ | `tests/renderer/app.test.tsx`「独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数」 |  |
| 详情 tab 按需展开与独立模块 | 二维码申请模块表单多选类型 | ✅ | `tests/renderer/app.test.tsx`「独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数」 |  |
| 详情 tab 按需展开与独立模块 | 项目总览展示关键事实 | ✅ | `tests/renderer/app.test.tsx`「详情 tab 按需加载，项目总览不读取 section」 |  |
| 详情 tab 按需展开与独立模块 | 费用与掉票 tab 展示金额与掉票记录 | ✅ | `tests/renderer/app.test.tsx`「费用与掉票在列表前展示金额事实，并显示掉票最后修改时间」 |  |

### workbench-todos

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 查看全部跳转完整提醒视图并按提醒日期排序 | 查看全部跳转完整提醒视图 | ✅ | `tests/renderer/app.test.tsx`「查看全部进入完整提醒页，默认日期降序，切换升序立即首页重读并稳定翻页」 |  |
| 查看全部跳转完整提醒视图并按提醒日期排序 | 默认按提醒日期最近优先 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.3：完整提醒视图默认按提醒日期降序（最近日期优先），含到期分类，仅备注项目也计入」 |  |
| 查看全部跳转完整提醒视图并按提醒日期排序 | 可选择升序或降序排列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 同一提醒日期归入同一泳道列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 最多选取 7 个非连续提醒日期 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 首批不足时继续向未来补列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 全量不足时不制造空列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 每列内项目顺序稳定 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：列内 id 稳定 tie-breaker；按列分页携带 selectedDates 锁定日期集合、不重算不重读」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 1024px 下泳道内部横向滚动且键盘可达 | ✅ | `tests/interface/layout.test.ts`「提醒泳道在 1024 与 1440 保持可读最小列宽并只在容器内部横滚」<br>`tests/interface/layout.test.ts`「泳道和全部可聚焦目标有清晰 focus-visible，reduced motion 不移除静态反馈」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 完整提醒视图保持独立默认排序 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立」 |  |
