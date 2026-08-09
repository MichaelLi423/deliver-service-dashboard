# 搬迁服务工作台（Relocation Service Workbench）

个人使用的 Windows 桌面应用（Electron + React + TypeScript + 本地 SQLite），面向搬迁负责人，
把从进单、联系客户、安排运输公司与工程师、录入单据、记录执行状态到费用申请与掉票闭环的
搬迁服务全流程，放在一个高密度、可键盘操作、可备份恢复的本地工作台里。

> 本文档面向**项目使用者**（搬迁负责人）与**开发者**。用户操作细节见
> [《搬迁服务工作台用户手册》](docs/系统用户手册/搬迁服务工作台用户手册.md)。

---

## 目录

- [定位与核心能力](#定位与核心能力)
- [当前状态](#当前状态)
- [安装与首次使用](#安装与首次使用)
- [数据与安全边界](#数据与安全边界)
- [开发环境](#开发环境)
- [package.json 全部命令](#packagejson-全部命令)
- [架构与目录](#架构与目录)
- [测试体系](#测试体系)
- [OpenSpec 流程](#openspec-流程)
- [文档索引](#文档索引)
- [已知限制](#已知限制)

---

## 定位与核心能力

- **单一本地账号 + 本机 SQLite**：业务数据不离开本机，不接远程数据库、云同步或外部业务系统；
  无多账号、注册、角色与权限管理。
- **项目提醒快速处理 + 高密项目队列**：主工作流是先处理手工维护的项目提醒，再连续推进项目队列。
- **四步新建向导**：基本信息 → 搬迁范围 → 执行准备 → 确认方式，三种保存路径
  （保存为待进单 / 未进单先执行 / 正式进单）。
- **七个主状态**：待进单、待执行、执行中、待验收、待掉票、已完成、已取消；
  人工调整 + 自动触发（实际装机完成 → 待验收；验收报告 → 待掉票；掉票金额闭环 → 已完成）共同维护。
- **九类快速记录**：搬迁批次（含费用登记日期、合同预算价与物流成交价）、搬迁仪器、上门活动、开单记录、
  验收报告、掉票、Ship-to 申请、损坏/维修事项、补齐进单核心资料，均可就近录入当前选中项目。
  （物流费用与搬迁批次合并为一次记录，物流成交价即最终实际物流费用，不再有独立"实际物流费用"入口）
- **独立模块**：序列号地址更新、二维码申请。
- **运营报表**：手工月份区间实时计算、下钻明细、Excel（.xlsx）/ PNG / PDF 三种导出。
- **备份与恢复**：每日自动备份（保留最近 7 份）+ 手动备份 + 原子恢复。
- **历史数据导入**：登录后工作台内七步向导（模板 / 文件 / Excel 粘贴 / 七类声明 / 草稿 /
  错误冲突 / 完整校验与封存 / 原子提交 / 中断恢复），是历史数据导入的**唯一入口**（无外部 CLI）。

领域语言与业务规则以 [`CONTEXT.md`](CONTEXT.md) 和
[《搬迁服务工作台 · 需求规格》](docs/搬迁服务工作台.md) 为权威（掉票≠发票/回款；搬迁项目≠合同）。

---

## 当前状态

| 项 | 状态 |
| --- | --- |
| 版本 | **0.1.0**（package.json，`private: true`，`license: UNLICENSED`） |
| 交付目标 | Windows 桌面应用；**尚未在 Windows 验证**（macOS 开发机 E2E ≠ Windows 验证） |
| 场景→测试矩阵 | 449 个场景：**447 有效证据 / 2 项 Windows 环境待验证 / 0 缺口** |
| 真实源只读验证 | 对 `docs/` 真实源 Excel 只读完整校验：识别 **1378** 条记录，**1107** 错误 / **134** 冲突 / **175** 警告；未生成 validation seal，也未触发业务数据提交 |
| 外部 CLI | 无（历史数据导入只有工作台内向导入口，早期迁移 CLI 已移除） |

- 矩阵：`docs/verification/scenario-test-matrix.md`，由 `npm run verify:matrix` 自动生成。
- 真实源只读验证口径与结果：`docs/verification/迁移执行与运维说明.md` 第 11 节。

---

## 安装与首次使用

### 使用者安装（Windows，交付目标）

1. 构建安装包：`npm run make`（Electron Forge + MakerSquirrel 产出 Windows 安装包）。
2. 运行生成的 Squirrel 安装包完成安装。
3. 从开始菜单启动「搬迁服务工作台」。

### 首次使用（三步）

1. **创建本地账号**：「首次使用初始化」填写唯一的用户名与密码（建议至少 8 位），点「创建账号并继续」。
2. **离线保存恢复码**：创建成功后只展示一次的一次性恢复码，请离线保存（离线密码管理器或纸质记录）。
   恢复码是忘记密码时唯一的恢复凭据；不要与数据库备份放在同一位置。
3. **登录工作台**：后续启动在「登录本地工作台」输入用户名与密码；忘记密码用「忘记密码？使用恢复码」重置。

> 详细步骤与全部界面操作见[用户手册](docs/系统用户手册/搬迁服务工作台用户手册.md)。

### macOS 开发机（验收环境）

- 打包：`npm run e2e:build`；E2E：`npm run test:e2e`。
- macOS 上的通过仅验证开发机可运行性，**不冒充 Windows 验证**。

---

## 数据与安全边界

| 边界 | 说明 |
| --- | --- |
| 数据目录 | Electron `userData` 下：`data/workbench.db`（业务库）、`backups/auto`（自动备份，保留 7 份）、`backups/manual`、`restore-snapshots`、`import-workspace`、`import-snapshots` |
| 本地账号 | 仅应用访问门槛，**不加密 SQLite**；主要保护边界是 Windows 操作系统账户 + 文件系统 ACL + 磁盘加密（如 BitLocker） |
| 网络 | 不联网，不向远程服务发送业务数据 |
| 密码/恢复码 | 不以明文存储（scrypt + 随机盐 + 恒定时间比较） |
| 备份恢复 | 自动备份每日首次使用触发、仅保留最近 7 份；恢复前校验可读、原子替换、失败不覆盖当前数据、恢复后重新登录 |
| 工作量归属 | 手工录入与工作量归属当前登录账号（账号内部 ID + 用户名快照）；历史导入数据不计手工工作量 |

---

## 开发环境

- 运行时与核心栈：**Electron 43.3.0**、**React 18.3**、**TypeScript 5.5**、**webpack 5**（Electron Forge 7.11.2 插件驱动）。
- 测试：**Vitest 3**（单元/集成/持久化/渲染）、**Playwright 1.49**（真实打包产物 E2E）。
- 依赖：`exceljs`（Excel 模板/导出）、`pdf-lib`（PDF 导出）、`pngjs`（PNG 导出）、`yauzl`（ZIP 预检）。
- **Node 版本**：项目**未声明最低 Node 版本**（package.json 无 `engines` 字段，也无 `.nvmrc`），
  请勿假定某个最低版本要求。开发机当前使用 Node v24（本机实测 `v24.15.0`）；
  建议使用与团队开发环境一致的较新 LTS 版本并保证 `npm install` 成功。

### 常用开发命令

```bash
npm install        # 安装依赖
npm start          # 开发模式启动（electron-forge start）
npm run typecheck  # TypeScript 全量类型检查
npm test           # Vitest 单元/集成/持久化测试
npm run test:e2e   # Playwright E2E（先 npm run e2e:build）
```

---

## package.json 全部命令

| 命令 | 说明 |
| --- | --- |
| `npm start` | 开发模式启动 Electron（`electron-forge start`） |
| `npm run package` | 打包应用（`electron-forge package`，产出未安装的应用目录） |
| `npm run make` | 生成安装包（`electron-forge make`，Windows 使用 MakerSquirrel） |
| `npm run publish` | 发布（`electron-forge publish`，当前项目未配置发布目标） |
| `npm run typecheck` | TypeScript 类型检查（`tsc --noEmit`，不产出文件） |
| `npm test` | 运行全部 Vitest 测试（`vitest run`） |
| `npm run test:watch` | Vitest 监听模式（`vitest`） |
| `npm run test:e2e` | 运行 Playwright E2E（`playwright test`，需先执行 `npm run e2e:build`） |
| `npm run e2e:build` | 打包真实产物供 E2E 使用（`electron-forge package`） |
| `npm run verify:matrix` | 生成并校验场景→测试矩阵（`node scripts/build-verification-matrix.mjs`；存在缺证据时非 0 退出） |

> E2E 中真实源只读校验默认跳过；显式执行：
> `RUN_REAL_SOURCE_READONLY=1 npx playwright test e2e/real-source-readonly.spec.ts`（不影响常规 CI）。

---

## 架构与目录

```
src/
├── domain/capabilities/        # 领域能力（每能力独立目录，含 index.ts 统一出口）
│   ├── relocation-project-lifecycle/   # 客户/合同/搬迁项目模型与主状态校验唯一入口
│   ├── relocation-execution/           # 搬迁批次、搬迁仪器、上门活动与执行事实
│   ├── service-order-recording/        # 开单记录
│   ├── project-financial-closure/      # 掉票与金额闭环
│   ├── damage-repair-tracking/         # 损坏/维修事项
│   ├── ship-to-management/             # Ship-to 与 Ship-to 申请
│   ├── serial-address-update/          # 序列号地址更新
│   ├── qr-request-tracking/            # 二维码申请
│   ├── workbench-todos/                # 项目提醒
│   ├── operational-reporting/          # 运营报表指标字典、公式与导出
│   ├── historical-data-import/         # 历史导入：规范化、校验、封存、原子提交、审计
│   ├── local-data-persistence/         # SQLite 连接、schema 迁移（v2–v12）、备份恢复
│   └── workbench-access/               # 本地账号、密码、恢复码
├── main/                       # 主进程：窗口、IPC handlers、workbench facade、导入向导 facade
├── preload/                    # preload 注入的最小 API
├── renderer/                   # React UI：登录/初始化/恢复码门、工作台（workbench-v2）、导入向导
├── shared/                     # IPC 类型契约（ipc.ts）、能力清单
├── domain/core/                # 基础设施：错误、ID、金额（定点）、时间、来源
tests/                          # Vitest 测试（domain/integration/persistence/renderer/main/security/performance/workspace/interface）
e2e/                            # Playwright E2E（打包产物、真实 UI、导入向导、真实源只读）
docs/                           # 需求规格、ADR、验证报告、用户手册
openspec/                       # OpenSpec 规格（changes/ 为进行中的变更，specs 为现行基线）
prototype/                      # 高保真录入原型（设计依据，非生产代码）
scripts/                        # build-verification-matrix.mjs 等辅助脚本
```

设计要点：

- **状态校验唯一入口**：主状态转换/校验只在 `relocation-project-lifecycle`（lifecycle.ts），
  其他模块只消费校验结果，不维护状态副本。
- **报表无状态快照**：operational-reporting 从只读事实源实时计算，不保存历史快照；导出与实时结果一致。
- **导入零部分写入**：校验阶段零业务写入；提交为单个立即写事务（七类 + 来源审计 + 快照 + 运行审计 + 对账），
  任一步失败整体回滚；导入工作区与业务库物理隔离。
- **金额定点**：金额以分整数（BigInt）存储与计算，报表 DTO 显式序列化为十进制字符串，避免精度退化。
- **迁移按 `PRAGMA user_version` 升级**（schema-v2 … v12），失败保留可恢复状态。

---

## 测试体系

| 层 | 工具 | 命令 | 覆盖 |
| --- | --- | --- | --- |
| 单元 / 领域 | Vitest | `npm test` | 各能力领域规则、状态校验、金额规则、导入校验/封存/原子提交、报表口径 |
| 集成 / 持久化 | Vitest（真实 SQLite） | `npm test` | 七类导入全流程、生命周期流转、备份恢复、IPC 契约 |
| 渲染 / 界面 | Vitest + Testing Library | `npm test` | 访问门、四步向导、九类动作、掉票编辑/撤销、报表、键盘焦点与可访问性 |
| 安全 | Vitest | `npm test` | 密码/恢复码存储、导入资源限制（ZIP 预检等）、会话守卫 |
| E2E | Playwright（真实打包 Electron） | `npm run e2e:build` + `npm run test:e2e` | 真实 UI 冒烟、导入向导流程、worker 运行时、真实源只读校验 |
| 场景矩阵 | Node 脚本 | `npm run verify:matrix` | 校验 449 个 spec 场景均有真实测试证据，缺证据非 0 退出 |

- 测试证据与场景对照：`tests/interface/README.md`、`docs/verification/scenario-test-matrix.md`。
- 诚实边界：Windows 打包与 Windows 操作系统账户保护**未验证**，矩阵中如实标记为待验证，
  不伪造证据。

---

## OpenSpec 流程

- 现行基线：`openspec/specs/`（本仓库当前以变更文档为工作基线）。
- 进行中变更：`openspec/changes/add-relocation-service-workbench/`（proposal / design / tasks /
  specs/ 下 15 个能力规格）。
- 工作台命令（`/opsx:*`，定义于 `.opencode/commands/opsx-*.md`）：
  `opsx-explore`（核对现状）、`opsx-propose`（新变更提案）、`opsx-update`（更新变更）、
  `opsx-verify`（变更→实现→测试校验）、`opsx-apply`（落实变更）、`opsx-sync`（同步基线）、
  `opsx-archive`（归档已交付变更）。
- 新规划与规格变更写入 `openspec/changes/`；仅在同步、归档或明确要求时更新正式规格。
- 发现规格与实现冲突时以规格为准，不为迎合现有代码而修改需求。

---

## 文档索引

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| [CONTEXT.md](CONTEXT.md) | 全员 | 《搬迁服务》领域语言（权威术语） |
| [搬迁服务工作台.md](docs/搬迁服务工作台.md) | 全员 | 《搬迁服务工作台 · 需求规格》v0.3（权威业务规则） |
| [用户手册](docs/系统用户手册/搬迁服务工作台用户手册.md) | 使用者 | 首次使用、界面操作、导入向导、常见报错、数据安全 |
| [迁移执行与运维说明](docs/verification/迁移执行与运维说明.md) | 运维/负责人 | 部署、数据目录、备份恢复、导入向导运维口径、真实源只读验证结果 |
| [场景→测试矩阵](docs/verification/scenario-test-matrix.md) | 开发者 | 449 个场景与测试证据对照 |
| [ADR 0001](docs/adr/0001-windows-desktop-local-sqlite.md) | 开发者 | Windows 桌面 + 本地 SQLite 架构决策 |
| [tests/interface/README.md](tests/interface/README.md) | 开发者 | workbench-interface 场景与测试对照 |
| [导入向导规格](openspec/changes/add-relocation-service-workbench/specs/history-import-wizard/spec.md) | 开发者 | 历史数据导入向导能力规格 |

---

## 已知限制

1. **Windows 未验证**：交付目标是 Windows，但当前只在 macOS 开发机打包与 E2E；macOS 通过不
   等同 Windows。Windows 安装包、开始菜单、Windows 操作系统账户保护待 Windows 打包验证。
2. **真实历史数据未导入**：真实源只读完整校验发现阻断问题（1107 错误 / 134 冲突 / 175 警告，
   识别 1378 条），未生成封存、未提交；需在向导内逐项修正后重新完整校验。
3. **无外部 CLI**：历史数据导入只有工作台内向导；早期迁移 CLI、命令行参数与自由文本 operator 已移除。
4. **本地账号不加密数据**：访问门槛 ≠ 加密；数据保护依赖 Windows 操作系统账户与磁盘加密。
5. **报表界面仅月份筛选**：区域、开单类型、运输公司、工程师、责任人等筛选维度在口径中保留，
   当前界面未开放；"月度掉票次数 / 物流费用合同占比"未作为独立小节展示；报表当前导出仅展示
   合同预算价与物流成交价，旧"预算/成交/实际费用"三列仅历史导入底层兼容。
6. **提醒临期窗口固定默认 7 天**：领域层支持配置，界面暂无配置入口。
7. **开单记录无列表页**：只能录入，项目详情选项卡暂不展示开单记录列表。
8. **单一账号**：无多账号、注册、角色与权限管理；工作量归属唯一本地账号。
9. **不联网**：无云同步、无远程数据库、无外部渠道提醒（邮件/企业微信等）。
