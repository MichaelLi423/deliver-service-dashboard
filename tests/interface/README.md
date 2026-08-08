# workbench-interface 场景与测试对照

## 自动化对照

| 界面场景 | 自动化证据 |
| --- | --- |
| 首次初始化、一次性恢复码、后续登录、恢复码重置 | `tests/renderer/app.test.tsx`「访问门与主操作流」 |
| 项目提醒、高密项目队列、六阶段吞吐、当前上下文 | `tests/renderer/app.test.tsx`「展示提醒、六阶段…」 |
| 未进单 / 已进单非仅颜色区分 | 同上；断言“未进单”“未进单先执行”文字标识 |
| 项目、提醒、阶段联动 | 同上；点击阶段后断言队列和上下文 |
| 四步向导与三个保存路径 | `tests/renderer/app.test.tsx`「四步向导…」 |
| 十类快速记录专用表单 | `tests/renderer/app.test.tsx`「十类动作逐一打开…」 |
| 掉票有效记录编辑、撤销终态与新增更正提示 | `tests/renderer/app.test.tsx`「费用与掉票支持有效记录直接编辑与不可恢复撤销」；`e2e/electron-smoke.spec.ts` 真实 Electron 掉票维护路径 |
| 项目取消专用命令、时间/原因与二次确认 | `tests/renderer/app.test.tsx`「取消项目为专用命令入口…」 |
| 手动备份、恢复替换警告、恢复后重新登录 | `tests/renderer/app.test.tsx`「手动备份/恢复备份位于主导航…」；主进程边界见 `tests/main/ipc-handlers.test.ts` |
| 业务命令会话失效统一回登录 | `tests/renderer/app.test.tsx`「任一业务命令返回会话失效时统一回到登录页」 |
| Ship-to 按既有申请 ID 线性推进 | `tests/renderer/app.test.tsx`「Ship-to 表单创建草稿…」「Ship-to 表单可选择既有申请…」 |
| 上门同页拆机、装机、维修、其他 | `tests/renderer/app.test.tsx`「上门活动同页…」 |
| 独立序列号地址更新 / 二维码申请 | `tests/renderer/app.test.tsx`「独立导航…」 |
| 报表手工月份、筛选、下钻、Excel/PNG/PDF | `tests/renderer/app.test.tsx`「报表要求…」 |
| Dialog 焦点、label、Escape、焦点恢复 | `tests/renderer/app.test.tsx`「Dialog 首字段…」 |
| 1024/1440、内部表格滚动、字号、reduced motion | `tests/interface/layout.test.ts` |

## 原型意图验收记录

- 已复核选定原型的任务顺序：顶部指标 → 六阶段吞吐 → 项目提醒快速处理 → 高密项目队列 + 当前上下文 → 六详情 tabs。
- 生产实现保留专业、克制、高密度运营语言；未复制原型 HTML、CSS 或 JavaScript。
- 原型中的旧“自动待办”语义已替换为现行规格的手工“项目提醒”，不生成缺失字段提醒。
- 独立模块保持在顶部主导航；二维码申请未混入项目快速记录，序列号地址更新未藏入“申请与维修”tab。
- 生产实现增加访问门、焦点陷阱、遮罩空白关闭、焦点恢复、`aria-live` Toast 与 reduced-motion 降级。

## 平台边界

`e2e/electron-smoke.spec.ts` 在 macOS 开发机以临时 userData 运行真实打包产物并操作真实 UI
（tasks 10.4，先 `npm run e2e:build` 再 `npm run test:e2e`），验证 macOS 开发机可运行性；
**不冒充 Windows 验证**。Windows 安装包与 Windows 操作系统账户保护仍待 Windows 打包验证
阶段确认（见 tasks.md 10.4/10.5 备注与 docs/verification/迁移执行与运维说明.md）。
