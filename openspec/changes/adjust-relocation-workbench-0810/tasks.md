# 调整搬迁工作台（0810 现场反馈）· 实施任务

本文件按依赖顺序拆分实施任务，属规划工件，不包含代码实现。实施基准为 `proposal.md`（Why/What/Impact）、`design.md`（D1~D9 决策与迁移计划）与 `specs/**/spec.md`（12 份 delta 规格）。design.md 无未决 Open Questions（TBD-07/09/11 等均为对既有规格的交叉引用，不改变本次建设范围）。

约定：状态转换与校验唯一入口为 `relocation-project-lifecycle/lifecycle.ts`（design D5 所有权）；renderer 无 Node 环境，只能经 `src/preload/index.ts` + `src/shared/ipc.ts` 的共享 IPC 契约访问主进程，SQLite 仅主进程；金额为"分"整数（BigInt/prepareReadBigInt）、业务日期 `yyyy-mm-dd`、审计时间 ISO；迁移通过 `PRAGMA user_version` 只追加、不修改 v1–v14；仓库无 lint/formatter/CI/hook，不引入不存在的命令。

验证约定（design D8）：不做全量 `npm test` 默认任务；每个验证任务使用 focused vitest（`npx vitest run tests/<路径>test.ts`）；E2E 必须先 `npm run e2e:build`（electron-forge package）再以 `workers=1` 运行 playwright；类型以 `npm run typecheck`（tsc --noEmit）为准（webpack ts-loader 为 transpileOnly）。

## 1. 变更前基线：focused characterization tests 固化当前关键口径

先于任何行为改动，为当前实现的关键口径补 focused characterization 测试并运行通过，作为后续改动的回归基线；记录"改动前全绿"证据。

- [x] 1.1 为 overview 待掉票金额口径新增/扩展 characterization 测试（tests/integration/workbench-read-v2.sqlite.test.ts）：固化当前财务公式（经仍存在且未取消项目 JOIN contracts 计算、已完成项目有效余额纳入、已取消排除、final_confirmable_amount 口径）与 totalProjects/pendingAmount 读数；完成态：focused vitest 在改动前运行通过并记录基线。
- [x] 1.2 为 lifecycle 既有转换口径新增/扩展 characterization 测试（tests/domain/lifecycle.test.ts）：固化人工调整、取消约束、金额闭环重算（TBD-11）、实际装机完成→待验收（TBD-07）、验收报告→待掉票等既有自动触发与约束；完成态：focused vitest 全绿，作为自动推进改动的回归基线。
- [x] 1.3 为 v2Delete 既有删除契约新增/扩展 characterization 测试（tests/integration/workbench-delete.sqlite.test.ts）：固化 recordType/id/expectedRevision 命令形状、稳定拒绝码（DELETE_REJECTION_CODES）、删除结果信封与原子审计行为、发票仅撤销；完成态：focused vitest 全绿，作为 type-specific 删除策略改动的回归基线。
- [x] 1.4 为 v2 队列/历史读取分页与排序新增/扩展 characterization 测试（tests/integration/workbench-read-v2.sqlite.test.ts）：固化 keyset cursor 分页、sort 选项、query/region 参数与历史视图当前排序行为；完成态：focused vitest 全绿，作为第 7 组历史/搜索改动的回归基线。
- [x] 1.5 固化当前项目队列分页现状证据（tests/integration/workbench-read-v2.sqlite.test.ts 或新增 focused 用例）：记录当前默认 page size（V2_PROJECT_PAGE_DEFAULT_LIMIT=50、上限 100）、sort/query/region 过滤后 total 与 cursor 的现状行为；完成态：focused vitest 在改动前运行通过并记录基线，作为"固定每页 20"（7.5）的改动前对照证据。
- [x] 1.6 固化当前提醒预览按记录数截断的现状证据（tests/integration/workbench-read-v2.sqlite.test.ts 或新增 focused 用例）：记录 overview reminderPreview 当前按记录数截断（最多 6 条）、尚无"先选日期列再取列内项目"的泳道读取模型；完成态：focused vitest 在改动前运行通过并记录基线，作为泳道读取模型（7.6）的改动前对照证据。
- [x] 1.7 固化当前"编辑项目资料"与项目标量 DTO 现状证据：记录项目标量 DTO 是否携带 temporaryInstrumentCount、当前编辑表单字段集合（无暂定数量/备注/暂存字段）与保存刷新路径；完成态：focused 测试/断言（tests/renderer/app.test.tsx 或 tests/domain/relocation-fields.test.ts）在改动前运行通过并记录基线，作为第 6 组编辑表单改动的对照证据。

## 2. 追加迁移 v15：新字段、legacy 区域策略与 IPC/DTO 类型

- [x] 2.1 追加 schema-v15 迁移（新增 `schema-v15.ts` 并登记入 `bootstrap.ts` 的 MIGRATIONS，不修改 v1–v14）：`projects` 增加可空列 `project_note`（项目备注）、`temporary_storage_address`（暂存地址）、`is_temporary_storage`（是否暂存，允许空表示"未填写"而非推断"否"）、`manager_approved`（是否批复）；"计划装机日期"复用既有 `planned_install_done_at` 列仅更名展示（如 apply 期证明需独立事实再追加，见 design D1）；完成态：迁移仅追加、旧库升级不重建表、不改写存量值。
- [x] 2.2 新增迁移测试（tests/persistence/migration-v15.test.ts）：全新库引导到 v15（迁移序列 1..15、user_version=15、新列已建）；v14 存量库升级保留既有业务数据、新列以空/兼容默认值初始化；region 历史文本原样保留；注入失败保留迁移前数据与可恢复状态（备份）；`PRAGMA foreign_key_check` 通过；完成态：focused vitest 全绿。
- [ ] 2.3 将孤立财务事实诊断接入迁移/启动路径：迁移执行或启动时诊断（仅计数：孤立合同、孤立掉票/最终可确认金额事实、断裂 project/contract 链接、foreign_key_check），给出治理清理路径提示，MUST NOT 静默删除财务记录；掉票记录仍仅可撤销、不物理删除；因非空项目 FK 且治理清理保留原行，结构性外键违规以 unresolved count 持续报告、不阻断迁移，不宣称 foreign_key_check 归零；完成态：诊断输出 counts、无客户值打印，focused 测试通过（与 4.3/4.4 治理路径衔接）。
- [ ] 2.4 实现区域五枚举领域写边界与 legacy "待调整"策略：新建/编辑项目区域去除首尾空白后仅允许 East、South、West、Central、North，非枚举值拒绝保存并提示（relocation-project-lifecycle 与 workbench-interface 均不提供自由输入）；存量非枚举 region 文本保留原值、读模型/报表标注为"待调整"、不猜测映射、不置空不丢弃；完成态：domain 单测覆盖非枚举拒绝/trim 校验/存量保留"待调整"分组。
- [ ] 2.5 更新 IPC/DTO 类型与接线（src/shared/ipc.ts、src/preload/index.ts、workbench-facade 相关 DTO）：新增/调整项目备注、暂存地址、是否暂存、计划装机日期（更名）、区域枚举类型、是否批复（替换批复原因）；建档输入类型移除最终可确认金额、服务单号、工程师、开单备注、缺失资料（既有 WIZARD_REJECTION_CODES 废弃字段有值即拒绝规则保持）；完成态：`npm run typecheck` 通过，IPC 契约测试（tests/main/workbench-v2-ipc.test.ts）通过。

## 3. 生命周期：plan_visit_date<=today 自动推进

- [x] 3.1 在 `lifecycle.ts` 增加计划上门日期到期自动推进的显式路径（design D5 转换表）：候选 `plan_visit_at <= today`，仅 待进单(pending_entry)/待执行(pending_execution)→执行中(executing)；执行中幂等不写；待验收(pending_acceptance)/待掉票(pending_invoice) 不倒退；已完成/已取消终态不变；转换必须经 lifecycle 唯一入口（resolveStatus 等既有入口），覆盖到期/未到期/逾期漏跑补推进全状态行；完成态：tests/domain/lifecycle.test.ts 新增场景全绿（含待进单带"未进单先执行"标签到期自动进入执行中）。
- [ ] 3.2 实现自动推进的幂等与审计：仅真实转换才更新 project revision 与审计事实；重复检查零写、无重复/反向转换审计；推进在事务内重查候选状态后再写入，防与人工编辑竞争；完成态：领域测试覆盖幂等零写、事务内重查、revision/audit 只在真实转换时变化。
- [ ] 3.3 实现主进程应用操作 `advanceDuePlanVisits(today)` 及其触发点：迁移后首次工作台读取前、应用 activate/resume 时、运行中跨本地业务日期边界时执行；不承诺后台运行，漏跑在下次激活补推进；通过 facade/接线层暴露；完成态：focused domain/integration 测试验证触发语义，typecheck 通过。
- [ ] 3.4 保证自动推进优先级与不倒退：自动触发优先于人工提交的状态值、系统不覆盖自动触发结果；正式进单在原项目上完成、不新建项目，已在执行中或后续状态的项目不得因进单回退；实际装机完成/验收报告/金额闭环等更强事实保留优先级；完成态：tests/integration/relocation-project-lifecycle.sqlite.test.ts 覆盖人工提交与自动触发并发优先级、正式进单不倒退场景。

## 4. Overview 同修订读取、有效项目财务口径与孤立数据治理

- [x] 4.1 将 `WorkbenchReadRepository.overview()` 改为同修订读取：totalProjects 与待掉票金额在同一个 SQLite 读事务（或单一聚合查询）内计算，消除"分别读取的修订之间可观察不一致"（design D2）；不改变财务公式本身；完成态：focused 集成测试断言同修订一致性。
- [x] 4.2 固化"仅由仍存在项目的有效财务事实计算"口径：财务聚合经仍存在且未取消项目 JOIN，孤立/脏事实不计入，已完成但仍有有效待掉票余额的项目纳入、已取消项目排除，不改为"仅活跃项目"筛选；系统中无任何项目时 pendingAmount 必为 0；完成态：tests/integration/financial-closure.sqlite.test.ts 覆盖 零项目为 0/孤立排除/已完成余额纳入/已取消排除 四场景。
- [ ] 4.3 实现只读孤立数据诊断：输出仅计数（孤立合同、孤立掉票/最终可确认金额事实、断裂 project/contract 链接、`PRAGMA foreign_key_check`），不打印任何客户值；默认只读、不删除任何财务记录；因非空项目 FK 且治理撤销保留原行，结构性外键违规（含治理撤销后的保留行）持续以 unresolved count 报告并给出人工恢复/治理路径，不宣称 foreign_key_check 归零；可接入迁移/启动诊断（与 2.3 同源实现）；完成态：focused 测试断言计数正确、结构性违规以 unresolved count 呈现且无客户值输出。
- [ ] 4.4 实现安全治理清理路径（防复发）：对活跃孤立掉票执行治理撤销，前置为 先备份 + 负责人显式确认 + 审计结果记录；治理撤销经既有撤销语义使掉票进入撤销终态并保留原行，SHALL NOT 物理删除掉票记录；治理后因非空项目 FK 与保留原行，结构性外键违规仍以 unresolved count 持续报告，提供人工恢复/治理路径，不宣称 foreign_key_check 归零；提供防复发校验（新写入仍经有效性约束）；治理后待掉票金额指标恢复正常（不再计入已撤销孤立掉票）；完成态：tests/integration/data-cleanup.sqlite.test.ts（或同目录新增 focused 用例）覆盖 备份前置/确认前置/审计结果/撤销终态保留原行/防复发/结构性违规仍报告且不归零。

## 5. 登记记录删除：type-specific 领域策略

- [ ] 5.1 将删除统一为主进程分发架构（design D3）：保持 v2Delete 单一命令形状（recordType/id/expectedRevision），主进程按类型分发到归属领域服务，服务在写事务内重查状态、修订与依赖；成功删除与最小 tombstone/审计事实原子写入；import-source 审计保留并标记为指向已删除记录而非擦除；完成态：现有 workbench-delete 集成测试全绿并新增分发断言。
- [ ] 5.2 实现独立可删除类型策略：开单记录删除不影响关联项目主状态与进单状态；损坏/维修事项删除时按引用关系原子清理仅指向该事项的维修上门活动关联、不删除活动本身、不影响关联仪器与项目；序列号地址更新删除后仪器实际关联新址以剩余最近更新事实为准；二维码申请删除不影响仪器"二维码是否申请"手工标记；均要求确认、原子、不留孤立数据；完成态：各类型 domain+integration 测试覆盖确认后删除/未确认不删/关联保持。
- [ ] 5.3 实现依赖拒绝与状态重算：存在下游业务事实的记录（如被引用的批次/仪器等）原子拒绝删除并返回用户可读原因（DELETE_REJECTED_DEPENDENCIES）；删除验收报告/上门活动等执行事实引起的状态重算必须经 lifecycle 唯一入口（DELETE_REJECTED_STATUS_RECALC 语义保持）；完成态：拒绝码与重算路径测试通过。
- [ ] 5.4 实现 Ship-to 申请删除策略：未补入 Account ID 且未完成的申请直接删除；已完成申请对应的不可变 Ship-to 仍被仪器/批次/项目引用时原子拒绝并说明原因；无任何引用且仅由该申请产生时随申请原子清理该主数据、不留孤立；记录级删除、非"退回/取消"语义、不影响其他申请线性流转；完成态：tests/integration/ship-to-serial.sqlite.test.ts（或 workbench-delete）覆盖直接删除/引用拒绝/无引用清理。
- [ ] 5.5 保持项目取消与掉票撤销例外：项目不提供物理删除入口、终止仍用取消语义；掉票记录不提供物理删除入口、仅撤销且撤销为终态（禁编辑/重复撤销），发票修正不物理删除；renderer 断言无物理删除入口；完成态：workbench-interface 相关集成测试与 UI 断言通过。
- [ ] 5.6 汇总各类型删除集成测试（tests/integration/workbench-delete.sqlite.test.ts）：登记类记录（批次、仪器、开单、验收报告、Ship-to 申请、损坏/维修事项、序列号地址更新、二维码申请）成功删除后不再出现在详情、历史浏览与对应统计；expectedRevision 不匹配拒绝；审计保留；完成态：focused vitest 全绿。

## 6. 独立登记与建档调整

- [ ] 6.1 实现序列号地址更新双模式（serial-address-update）：独立登记不关联任何项目/仪器，必填客户名称、新址地址、序列号、Account ID、更新日期，序列号仅非空校验、不执行仪器一致性校验；选择关联项目/仪器时执行一致性校验（序列号与仪器一致否则拒绝）；一台仪器可有多条更新事实按更新日期保留；不引入未确认的序列号格式约束；完成态：tests/domain/serial-address-update.test.ts 全绿。
- [ ] 6.2 确认/补齐二维码申请独立与删除语义（qr-request-tracking）：申请保持独立记录、不新增可空项目/仪器外键；重复申请保留完整历史、各自独立计数工作量；确认删除后从申请历史、详情与工作量统计中消失；删除不影响仪器"二维码是否申请"标记；完成态：tests/domain/qr-request-tracking.test.ts 与关联集成测试全绿。
- [ ] 6.3 调整建档表单（renderer 单页分组录入）：项目与进单分组含进单日期、区域（五固定选项）、旧址/新址联系人、合同起止日期与可选项目备注，不含项目负责人、销售通知时间、最终可确认金额、服务单号、工程师、开单备注；搬迁范围含旧址/新址地址、仪器名称与数量、型号（选填）、UPS 是/否与暂存地址，旧址/新址/数量允许留空后补、无 Ship-to 地址快照；执行准备含计划上门/运输日期（分开）、场地确认、实际装机完成日期、计划装机日期（更名）与是否暂存，不含工程师与服务单号；保存意图含 待进单/正式进单/未进单先执行 三路径，未进单先执行记录是否批复、不收集缺失资料；保存不同次创建开单记录；可后补字段留空不无提示丢失、不自动生成提醒；完成态：tests/renderer/app.test.tsx 与 tests/interface/layout.test.ts 表单/导航断言全绿。
- [ ] 6.4 落实项目领域写边界：新建/编辑项目校验五枚举区域（trim 后，非枚举拒绝，legacy 值保留待调整）；废弃字段（最终可确认金额/服务单号/工程师/开单备注/缺失资料）有值即拒绝（WIZARD_REJECTION_CODES 保持）；项目备注可空、建档后补充/修改不影响主状态；暂存地址/是否暂存为手工维护执行事实、不触发主状态流转；完成态：tests/domain/relocation-fields.test.ts、relocation-entry.test.ts 与 tests/integration/create-project-ecc-rules.sqlite.test.ts 全绿。
- [ ] 6.5 实现"编辑项目资料"暂定仪器数量维护（复用既有 temporaryInstrumentCount 事实与项目标量 DTO，design D6/D9，不新增迁移列）：编辑表单展示当前暂定仪器数量，允许查看、留空、补录或调整，保存走既有项目标量更新路径、保存后刷新项目标量读模型回显最新值；不生成虚拟仪器记录、不改变既有逐台仪器事实、不触发主状态流转；取值校验遵循既有输入校验规则、不引入新格式约束；完成态：tests/domain/relocation-fields.test.ts 或 relocation-execution.test.ts 覆盖 查看/留空/补录/调整/回显 与 不建仪器/不改仪器事实/不触发状态 场景全绿。
- [ ] 6.6 落实"编辑项目资料"renderer 表单与 DTO/IPC 接线：确认项目标量 DTO 与编辑保存请求已携带 temporaryInstrumentCount（沿用既有字段与校验，不新增 schema 列），renderer 编辑表单接入并回显最新保存值；完成态：`npm run typecheck` 通过，tests/renderer/app.test.tsx 断言 查看/留空/补录/调整后回显最新值，无 schema-v15 之外的新增列改动。

## 7. 项目详情、历史浏览、提醒视图与搜索筛选

- [ ] 7.1 扩展项目详情总览与 tab/导航（workbench-interface）：总览完整展示项目基础字段（客户名称、ECC 或临时编号、区域、主状态、进单日期）、旧址/新址地址、执行准备（计划上门/运输日期、场地确认、是否暂存）、项目备注及关联登记事实；关联登记事实按类型分页或分 tab 加载、不一次快照全量；序列号地址更新与二维码申请经扩展 tab 或独立导航模块提供，不藏在"申请与维修"tab；完成态：tests/integration/workbench-read-v2.sqlite.test.ts 与 renderer 详情 tab 断言全绿。
- [ ] 7.2 实现"浏览全部记录"完整历史视图：顶栏入口跳转集中视图，聚合展示各登记类记录；按各类型业务日期倒序、相同业务日期按稳定次级规则（记录创建时间或系统主键）固定顺序、分页重复加载不改变顺序；各类型业务日期选择器集中在主进程共享映射（design D6），使 UI 排序与导出/读取口径一致；完成态：tests/integration/workbench-read-v2.sqlite.test.ts 覆盖倒序/稳定/分页断言。
- [ ] 7.3 实现提醒"查看全部"完整视图：入口跳转完整提醒视图并集中展示全部项目提醒及其到期分类；支持按提醒日期升序或降序，未选择方向时默认最近日期优先（降序），排序选择立即生效；完成态：tests/integration/workbench-todos.sqlite.test.ts 与 renderer 断言全绿。
- [ ] 7.4 实现项目队列关键词搜索与区域筛选：关键词搜索覆盖客户名称、ECC 与系统临时编号，任一匹配即筛选；区域筛选仅提供 East、South、West、Central、North 五个固定选项、无自由输入；关键词与区域可组合、同时满足才展示；完成态：tests/integration/workbench-read-v2.sqlite.test.ts 与 renderer 队列筛选断言全绿（既有 query/region 参数按 spec 补齐约束）。
- [ ] 7.5 实现项目队列固定每页 20 的共享契约与主进程读取（design D6/D9）：共享 IPC/读取契约不接受 renderer 任意 page size，主进程统一应用 20；应用筛选或关键词搜索后按过滤后集合重算 total、丢弃当前 cursor 并从第一页开始；每个 cursor 顺序在业务排序键后追加唯一稳定 tie-breaker（如记录 id），翻页不重复/不遗漏等键项目；最后一页允许少于 20 项、不以空项补足；不展示"每页最多50项"等冲突文案；完成态：tests/integration/workbench-read-v2.sqlite.test.ts 与 tests/main/workbench-v2-ipc.test.ts 覆盖 固定20/过滤后重算total/cursor重置/等键稳定/末页少于20/无冲突文案。
- [ ] 7.6 实现提醒泳道"先日期后项目"的有界读取模型（design D6/D9）：主进程先按提醒日期从最早逾期向未来升序选取最多 7 个不同非空业务日期（日期不要求连续自然日，首批不足 7 个不同日期继续向未来补列，全量提醒不足时仅返回已有非空日期列、不制造空列），再仅对选中日期读取列内项目；MUST NOT 先按记录数截断再分组；列内项目用稳定 tie-breaker 固定顺序；高量日期列可带独立分页 cursor、推进该列不得重算或改变已选日期集合；本泳道升序不改变完整提醒视图默认按提醒日期降序（与 7.3 独立）；完成态：tests/integration/workbench-todos.sqlite.test.ts 覆盖 同日归列/非连续日期/首批不足未来补列/全量不足仅非空列/列内稳定/按列分页不改日期集合。

## 8. Sticky 顶部 UI

- [ ] 8.1 实现单一滚动根 + 导航/任务指挥台头部整体固定（design D7）：采用单一页面滚动根，顶部导航 sticky at `top:0`，任务指挥台标题、说明与操作区紧随其下并按导航高度偏移整体固定；预留等价布局空间使内容与操作区不被遮挡；窄宽度（1024）下操作区允许在固定区内换行、不溢出；完成态：tests/interface/layout.test.ts 覆盖固定区与内容不遮挡断言。
- [ ] 8.2 保证固定头部不拦截键盘焦点：固定区不覆盖焦点所在控件，表单字段焦点保持可滚动可见、可正常输入（滚动补偿/scroll-margin）；完成态：renderer/interface 焦点测试通过。
- [ ] 8.3 补充 1024/1440 两个目标宽度布局测试：两宽度下头部整体固定可见、内容不被遮挡、无页面级横向溢出、操作区可及；完成态：tests/interface/layout.test.ts 新增场景全绿（E2E 视口场景见 9.7）。
- [ ] 8.4 实现提醒泳道 UI（design D7/D9，对应 7.6 读取模型）：每列列头显示对应业务日期、同一提醒日期项目纵向堆叠；列保持可读最小宽度；1024px 下泳道容器（而非页面）拥有横向滚动、页面不产生横向溢出，键盘遍历可到达各日期列及列内可操作项目且焦点指示可见；1440px 下宽度允许时尽量展示全部 7 列、不可读时保留内部滚动而非把列压到不可用宽度；完成态：tests/interface/layout.test.ts 覆盖 日期列头/同日纵列/1024 内部横滚不溢出/键盘可达/1440 尽量 7 列可读或内部滚动。

## 9. 聚焦验证与交付

- [ ] 9.1 focused domain 验证：运行本 change 涉及的领域测试文件（lifecycle、relocation-fields、relocation-entry、relocation-execution、serial-address-update、ship-to-management、damage-repair-tracking、qr-request-tracking、service-order-recording、operational-reporting、workbench-todos 等）；完成态：`npx vitest run tests/domain/...` 全绿。
- [ ] 9.2 focused persistence 验证：运行 migration-v15、schema、connection 等持久化测试；完成态：`npx vitest run tests/persistence/migration-v15.test.ts tests/persistence/schema.test.ts` 全绿。
- [ ] 9.3 focused integration 验证：运行 workbench-read-v2、workbench-delete、financial-closure、relocation-project-lifecycle、ship-to-serial、operational-reporting、damage-repair-qr、data-cleanup 等 sqlite 集成测试；完成态：`npx vitest run tests/integration/...` 全绿。
- [ ] 9.4 focused renderer/interface 验证：运行 tests/renderer/app.test.tsx 与 tests/interface/layout.test.ts；完成态：focused vitest 全绿。
- [ ] 9.5 类型验证：完成态：`npm run typecheck`（tsc --noEmit）零错误（webpack 打包通过不代表类型正确）。
- [ ] 9.6 更新证据映射并运行验证矩阵：按真实新增/修改的测试登记 `docs/verification/scenario-map.mjs` 证据（[文件, 标题关键词]），运行 `npm run verify:matrix` 重写 scenario-test-matrix.md；完成态：矩阵无缺口或如实登记 pending/note，不得谎称覆盖。
- [ ] 9.7 E2E 聚焦场景：先 `npm run e2e:build`（electron-forge package）再以 `workers=1` 运行 focused E2E（workbench-v2-layout 等），覆盖 sticky 固定头部在 1024/1440 视口、键盘焦点与导航跳转；完成态：playwright focused 用例全绿（未构建时用例会 skip 而非失败，须先构建）。
- [ ] 9.8 提交并推送：检查实际 diff，提交本 change 相关改动（tasks/代码/测试/矩阵）并推送到远程仓库（项目规则：不留存仅本地工作区的已完成修改）；完成态：git 状态干净、改动已推送。
- [ ] 9.9 扩展 focused integration 证据（20 项分页与 7 日期泳道）：运行 tests/integration/workbench-read-v2.sqlite.test.ts 的固定 20 分页/过滤后重算 total/cursor 重置/等键稳定场景 与 tests/integration/workbench-todos.sqlite.test.ts 的 7 日期列读取模型场景（对应 7.5/7.6）；完成态：focused vitest 全绿。
- [ ] 9.10 扩展 focused renderer/interface 证据（编辑表单暂定数量 + 泳道 UI + 1024/1440）：运行 tests/renderer/app.test.tsx（暂定数量查看/留空/补录/调整/回显，对应 6.5/6.6）与 tests/interface/layout.test.ts（泳道日期列头/同日纵列/1024 内部横滚不溢出/1440 可读或内部滚动，对应 8.4）；完成态：focused vitest 全绿。
- [ ] 9.11 扩展 E2E 证据（泳道 1024/1440）：先 `npm run e2e:build`（electron-forge package）再以 `workers=1` 运行 focused E2E，覆盖提醒泳道在 1024（容器内横向滚动、页面无溢出、键盘可达）与 1440（尽量 7 列可读或内部滚动）以及 sticky 固定头部；完成态：playwright focused 用例全绿（未构建时用例会 skip 而非失败，须先构建）。
- [ ] 9.12 扩展 verify matrix 证据：按 20 项分页与 7 日期列相关新增测试登记 `docs/verification/scenario-map.mjs` 证据（[文件, 标题关键词]），运行 `npm run verify:matrix` 重写 scenario-test-matrix.md；完成态：矩阵无缺口或如实登记 pending/note，不得谎称覆盖。

说明：本任务列表默认不做全量 `npm test`（含 100k/50k 性能用例，耗时极长）；如 focused 验证暴露更广回归风险，再由实施者判断补跑相关 focused 范围。仓库无 lint/CI/hook，不设置对应任务。
