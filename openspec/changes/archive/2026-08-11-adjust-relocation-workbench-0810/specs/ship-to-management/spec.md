# ship-to-management

## ADDED Requirements

### Requirement: Ship-to 申请记录删除

Ship-to 申请记录 SHALL 支持负责人确认后删除；删除后该申请 SHALL 不再出现在申请详情、历史浏览与申请工作量统计中。删除为记录级移除操作，MUST NOT 视为"退回"或"取消"，MUST NOT 改变其他申请的状态与线性流转。删除申请时，若该申请尚未补入 Account ID 且未进入已完成，系统 SHALL 直接删除该申请；若该申请已进入已完成并创建/对应不可变 Ship-to 主数据，系统 SHALL 按以下关联约束处理：该 Ship-to 仍被搬迁仪器、搬迁批次或搬迁项目引用时，SHALL 原子拒绝删除并说明原因；该 Ship-to 无任何引用且仅由该申请产生时，SHALL 随申请原子清理该 Ship-to 主数据，MUST NOT 静默留下孤立数据。

#### Scenario: 确认后删除且不再出现在详情与统计

- **GIVEN** 系统中存在一条 Ship-to 申请记录
- **WHEN** 负责人确认删除该申请
- **THEN** 系统删除该申请记录
- **AND** 该申请不再出现在申请详情、历史浏览与申请工作量统计中

#### Scenario: 删除非退回或取消

- **GIVEN** 一条 Ship-to 申请已进入处理中
- **WHEN** 负责人删除该申请记录
- **THEN** 系统将该记录作为记录级删除移除，不视为退回或取消
- **AND** 其他申请的线性状态流转不受影响

#### Scenario: 未完成申请直接删除

- **GIVEN** 一条 Ship-to 申请处于待提交或处理中且未补入 Account ID
- **WHEN** 负责人确认删除该申请
- **THEN** 系统直接删除该申请
- **AND** 不产生任何 Ship-to 主数据遗留

#### Scenario: 已完成申请对应 Ship-to 被引用时拒绝删除

- **GIVEN** 一条已完成申请对应的不可变 Ship-to 仍被搬迁仪器或搬迁项目引用
- **WHEN** 负责人确认删除该申请
- **THEN** 系统原子拒绝删除并说明原因
- **AND** 该申请与 Ship-to 主数据均保持不变

#### Scenario: 已完成申请对应 Ship-to 无引用时随申请清理

- **GIVEN** 一条已完成申请对应的不可变 Ship-to 无任何其他引用且仅由该申请产生
- **WHEN** 负责人确认删除该申请
- **THEN** 系统随删除申请原子清理该 Ship-to 主数据
- **AND** 不静默留下孤立数据
