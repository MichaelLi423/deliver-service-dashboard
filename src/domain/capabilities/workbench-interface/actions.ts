/**
 * workbench-interface 能力（表现层占位）。
 *
 * 本模块只定义表单入口、字段呈现、校验反馈与展示，只消费各业务能力的事实与
 * 校验结果（design D14~D16）；不重复业务状态与金额校验规则。
 * 具体界面结构（项目提醒快速处理 + 高密度项目队列主操作流、生命周期吞吐、
 * 当前上下文、详情 tab、四步向导、快速记录等）见 tasks 9.x。
 * 渲染层语义化最小占位见 src/renderer。
 */

/** 项目快速记录的十类业务动作（TBD-24 / 9.6）。 */
export const QUICK_RECORD_ACTIONS = [
  'batch', // 搬迁批次
  'instrument', // 搬迁仪器
  'activity', // 上门活动
  'service_order', // 开单记录
  'logistics_fee', // 实际物流费用
  'acceptance', // 验收报告
  'invoice', // 掉票
  'ship_to_request', // Ship-to 申请
  'damage_repair_item', // 损坏/维修事项（备件申请并入其中，无独立备件申请入口）
  'complete_entry_info', // 补齐进单核心资料
] as const;
export type QuickRecordAction = (typeof QUICK_RECORD_ACTIONS)[number];
