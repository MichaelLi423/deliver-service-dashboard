/**
 * relocation-project-lifecycle 能力统一入口。
 *
 * 本模块是主状态转换/校验入口与客户/合同/项目基础模型的唯一拥有者
 * （design D4 / D13 / D3；tasks 1.6~1.8 与 2.1~2.7）。todos/reporting/interface
 * 只消费本模块输出；掉票事实（写入归 project-financial-closure）以只读仓储消费。
 */
export * from './states';
export * from './lifecycle';
export * from './customer';
export * from './customer-service';
export * from './contract';
export * from './contract-service';
export * from './project';
export * from './project-service';
