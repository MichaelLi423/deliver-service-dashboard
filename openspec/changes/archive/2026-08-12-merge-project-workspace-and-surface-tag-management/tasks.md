## 1. 回归测试准备

- [x] 1.1 为顶部直接“标签管理”入口及其打开既有全局标签库的行为添加失败的 focused renderer 测试。
- [x] 1.2 为 reminders → project-workspace → queue 的 DOM 顺序、共享选中项目联动、单实例摘要/tabs 与无详情固定裁切添加失败的 focused renderer 测试。
- [x] 1.3 为 1440px、1190px、1170px、1024px 下核心工作区可操作且无页面级横向溢出添加失败的 Playwright E2E 覆盖。

## 2. Renderer 工作台实现

- [x] 2.1 将顶部主导航的“标签管理”直接动作接至现有全局标签库维护打开逻辑，不新增维护组件或状态。
- [x] 2.2 调整工作台 DOM，使项目提醒日期泳道独占整行，并按 reminders → project-workspace → queue 顺序渲染。
- [x] 2.3 创建全宽单一项目工作区，在其顶部复用 `ProjectContext` 摘要、下部复用 `ProjectDetails` tabs，并保持同一 selected project state 与既有提醒/阶段联动。
- [x] 2.4 移除 `workbench-grid` 双列布局和详情 760px/680px 固定高度裁切；约束页面横向尺寸，并仅让必要宽的工作区内容或队列表格在自身区域滚动。
- [x] 2.5 调整桌面断点或弹性约束，确认 1440px、1190px、1170px 与 1024px 下项目提醒、项目工作区、队列和核心动作可用。

## 3. 验证

- [x] 3.1 运行相关 focused renderer 测试并修复本 change 引入的失败。
- [x] 3.2 运行 `npm run typecheck`。
- [x] 3.3 运行 `npm run e2e:build`，再以 `workers=1` 运行相关 Playwright E2E 用例。
- [x] 3.4 运行 `openspec validate merge-project-workspace-and-surface-tag-management --strict --json`；如规格关键词或场景映射受影响，再运行 `npm run verify:matrix`。
