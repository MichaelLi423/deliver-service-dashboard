# ship-to-management

## Purpose

本能力定义搬迁目的地址（Ship-to）主数据与 Ship-to 申请的行为规则：Ship-to 是创建后不可修改的地址主数据，唯一编号沿用现有业务字段名 Account ID，并非客户主账号。系统中尚无目的 Ship-to 时，负责人按同一客户、同一新址地址创建一条 Ship-to 申请；申请只记录客户名称与新址地址，不关联搬迁仪器，也不保存结构化地址快照。申请创建时 Account ID 可空，由系统外完成流程返回后补入并进入已完成，补入的 Account ID 创建/对应不可变的 Ship-to。申请状态**线性流转**：待提交 → 处理中 → 已完成，不支持退回或取消（TBD-04）；每条申请在首次实际提交时计一次工作量，待提交草稿不计。目的地址变化时重新申请新的 Ship-to 而不修改原记录。搬迁批次与搬迁项目仅汇总展示所涉及的 Ship-to，不维护独立的批次级或项目级唯一地址。申请未完成仅作为独立提醒信息展示，不阻塞搬迁项目的进单、执行、验收、掉票或完成；系统不自动生成"Ship-to 申请未完成"提醒。

## Requirements

### Requirement: Ship-to 不可变主数据与 Account ID

每处搬迁目的地址以不可变 Ship-to 主数据表达，唯一编号为 Ship-to ID，沿用现有业务字段名 Account ID；Account ID 不是客户主账号。系统 SHALL 禁止修改已创建的 Ship-to，且已创建 Ship-to 的全部引用 SHALL 保持稳定。

#### Scenario: 创建后不可修改

- **GIVEN** 一个已创建的 Ship-to，其唯一编号为 Account ID
- **WHEN** 负责人尝试修改该 Ship-to 的地址字段
- **THEN** 系统拒绝修改并保持原 Ship-to 数据不变
- **AND** 目的地址变化只能通过申请新的 Ship-to 解决，不更新或覆盖原记录

#### Scenario: Account ID 唯一标识

- **GIVEN** 系统中已存在某 Account ID 对应的 Ship-to
- **WHEN** 创建另一个使用相同 Account ID 的 Ship-to
- **THEN** 创建被拒绝并提示 Account ID 已存在
- **AND** 已被搬迁仪器引用的 Ship-to 不因新申请而改变

### Requirement: Ship-to 申请按客户与新址地址创建

系统中不存在目的 Ship-to 时，负责人 SHALL 按同一客户、同一新址地址创建一条 Ship-to 申请；申请 SHALL 只记录客户名称与新址地址，MUST NOT 关联搬迁仪器，MUST NOT 保存结构化地址快照。客户或新址地址不同 SHALL 分别创建申请。

#### Scenario: 同客户同新址只创建一条申请

- **GIVEN** 某客户的一处新址地址在系统中尚无 Ship-to
- **WHEN** 负责人为该客户的新址地址发起 Ship-to 申请
- **THEN** 系统创建一条记录该客户与新址地址的申请
- **AND** 客户或新址地址不同分别创建申请

#### Scenario: 申请不关联仪器、不保存地址快照

- **GIVEN** 一条 Ship-to 申请已创建
- **WHEN** 负责人查看该申请或后续处理该申请
- **THEN** 系统仅以申请保存的客户与新址地址展示该申请
- **AND** 申请不关联任何搬迁仪器，也不保存结构化地址快照

### Requirement: Account ID 创建时可空、外部完成后补入并进入已完成

Ship-to 申请创建时 Account ID SHALL 可空；申请由系统外完成流程处理后，负责人 SHALL 将系统外返回的 Account ID 补入申请，补入后申请 SHALL 进入已完成并记录完成日期。申请进入已完成前 Account ID MUST NOT 为空，未补入 Account ID 的申请 SHALL NOT 进入已完成。补入的 Account ID SHALL 全局唯一，MUST NOT 与已有 Ship-to 重复；补入的 Account ID SHALL 创建/对应不可变的 Ship-to。

#### Scenario: 创建申请时 Account ID 可空

- **GIVEN** 负责人需要为该客户的新址地址申请新增 Ship-to，但尚未取得 Account ID
- **WHEN** 负责人创建该 Ship-to 申请
- **THEN** 系统允许 Account ID 为空并创建申请
- **AND** 申请在补入 Account ID 前保持待提交或处理中状态

#### Scenario: 外部完成后补入 Account ID 进入已完成

- **GIVEN** 一条 Ship-to 申请处于处理中且系统外已完成
- **WHEN** 负责人补入系统外返回的 Account ID
- **THEN** 申请进入已完成并记录完成日期
- **AND** 补入的 Account ID 创建/对应该申请产生的不可变 Ship-to

#### Scenario: 补入重复 Account ID 被拒

- **GIVEN** 系统中已存在某 Account ID 对应的 Ship-to
- **WHEN** 负责人向一条申请补入该 Account ID
- **THEN** 系统拒绝补入并提示 Account ID 已存在
- **AND** 申请保持原状态，不进入已完成

### Requirement: 申请线性状态与首次提交工作量

Ship-to 申请 SHALL 独立采用待提交、处理中、已完成三种状态，状态 SHALL 线性流转：待提交 → 处理中 → 已完成，MUST NOT 支持退回或取消（TBD-04）；每条申请 SHALL 在首次实际提交时计一次工作量；待提交草稿 MUST NOT 计工作量，后续状态更新 MUST NOT 重复计数。

#### Scenario: 首次实际提交计一次工作量

- **GIVEN** 一条 Ship-to 申请处于待提交
- **WHEN** 负责人首次实际提交该申请使其进入处理中
- **THEN** 该申请计一次申请工作量
- **AND** 从未实际提交的待提交草稿不计工作量

#### Scenario: 状态线性流转不支持退回或取消

- **GIVEN** 一条 Ship-to 申请已进入处理中
- **WHEN** 负责人尝试将该申请退回至待提交或取消
- **THEN** 系统不提供退回或取消操作
- **AND** 申请只能继续流转至已完成

#### Scenario: 后续状态更新不重复计数

- **GIVEN** 一条申请已计入一次工作量并进入处理中
- **WHEN** 该申请随后进入已完成
- **THEN** 该申请的工作量不重复增加
- **AND** 后续状态更新也不增加工作量

### Requirement: 目的地址变化重新申请

Ship-to 创建后不可修改；目的地址发生变化时，负责人 SHALL 重新申请新的 Ship-to，MUST NOT 更新或覆盖原记录。原申请 SHALL 保留。

#### Scenario: 地址变化新建申请

- **GIVEN** 一台搬迁仪器的实际目的地址较其当前关联发生变化
- **WHEN** 负责人处理该地址变化
- **THEN** 原 Ship-to 记录保持不变
- **AND** 系统按客户与新址地址重新创建 Ship-to 申请并保留原申请，新申请按首次提交计一次工作量

### Requirement: 批次与项目仅汇总展示所涉 Ship-to

搬迁批次和搬迁项目 SHALL 仅汇总展示所涉及的 Ship-to，MUST NOT 重复维护唯一的批次级或项目级地址。

#### Scenario: 批次仅汇总展示所涉 Ship-to

- **GIVEN** 某搬迁批次的搬迁仪器关联了多个目的 Ship-to
- **WHEN** 展示该批次的目的地址
- **THEN** 系统仅汇总展示该批次所涉及的 Ship-to
- **AND** 不为搬迁批次维护独立的唯一地址

#### Scenario: 项目仅汇总展示所涉 Ship-to

- **GIVEN** 某搬迁项目包含多个批次且整体涉及多个目的 Ship-to
- **WHEN** 展示该搬迁项目的目的地址
- **THEN** 系统仅汇总展示项目所涉及的全部 Ship-to
- **AND** 不为搬迁项目维护独立的唯一地址

### Requirement: 申请未完成不阻塞项目

Ship-to 申请未完成时 SHALL 只作为独立提醒信息展示，且 MUST NOT 阻塞搬迁项目的进单、执行、验收、掉票或完成；系统 SHALL NOT 自动生成"Ship-to 申请未完成"提醒。

#### Scenario: 未完成申请不影响项目流转

- **GIVEN** 某搬迁项目存在一条未完成的 Ship-to 申请
- **WHEN** 该项目进行进单、执行、验收、掉票或完成流转
- **THEN** 未完成的申请不阻塞任何项目状态流转
- **AND** 系统仅将未完成申请作为独立提醒信息展示，不自动创建项目提醒
