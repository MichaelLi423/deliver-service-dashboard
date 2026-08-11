/**
 * relocation-execution 能力统一入口（tasks 3.x）。
 *
 * 本模块拥有批次、仪器、上门活动/工作事实与物流记录的规则；主状态转换归
 * relocation-project-lifecycle 唯一拥有（design D4），本模块经
 * ExecutionLifecycleGateway 消费其校验入口。
 */
export * from './execution-types';
export * from './execution-repositories';
export * from './execution-service';
export * from './protected-deletion-service';
