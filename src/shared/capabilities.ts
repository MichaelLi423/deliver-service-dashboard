/**
 * 14 个能力模块清单与统一入口（design D2 模块化单体逻辑边界）。
 * 每个模块与其能力规格一一对应；边界是逻辑接缝而非独立部署/存储。
 */

export const CAPABILITY_NAMES = [
  'workbench-access',
  'relocation-project-lifecycle',
  'relocation-execution',
  'service-order-recording',
  'ship-to-management',
  'serial-address-update',
  'damage-repair-tracking',
  'qr-request-tracking',
  'workbench-todos',
  'workbench-interface',
  'project-financial-closure',
  'operational-reporting',
  'historical-data-import',
  'local-data-persistence',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** 模块所有权对照（design D4/D9/D10/D14/D17/D18；供结构测试校验所有权边界）。 */
export const CAPABILITY_OWNERSHIP: Record<CapabilityName, string> = {
  'workbench-access': '本地账号访问与事实归属（D12）',
  'relocation-project-lifecycle': '唯一拥有主状态转换/校验入口；客户/合同/项目基础模型（D3/D4/D13）',
  'relocation-execution': '批次/仪器/上门活动与工作事实/物流记录（D5）',
  'service-order-recording': '四类开单记录与服务单号唯一性（TBD-21/22）',
  'ship-to-management': 'Ship-to 不可变主数据与申请线性状态（D6/TBD-04）',
  'serial-address-update': '序列号地址更新事实（D6）',
  'damage-repair-tracking': '损坏/维修事项与维修上门多对多关联（TBD-13/15/24）',
  'qr-request-tracking': '二维码申请独立模块与仪器手工标记（TBD-06）',
  'workbench-todos': '项目提醒展示与到期分类（只消费，不拥有业务状态，D9）',
  'workbench-interface': '表现层：只消费事实与校验结果（D14~D16）',
  'project-financial-closure': '金额闭环：只消费 lifecycle 校验结果（D4/D7/D8）',
  'operational-reporting': '唯一拥有统计公式（只消费事实，D10）',
  'historical-data-import': '一次性迁移：ECC 聚合主键/dry-run/幂等/冲突（D11）',
  'local-data-persistence': '本地存储、备份与恢复（D17/D18）',
};
