/**
 * 版本化冻结字段映射（tasks 8.2）。
 *
 * 记录「源 Excel 列 → 目标模型字段」的映射，标注来源优先级与目标必填/可选：
 * - 合同字段以合同信息表为主要来源；
 * - 执行字段以项目执行表（仅「搬迁项目」sheet）为主要来源；
 * - 开单、掉票等动作记录以工作量统计表为主要来源（按 sheet 分别解析）；
 * - 供应商（运输公司）以供应商表为来源（供应商主数据 sheet 不映射为费用）；
 * - 物流费用历史记录仅以物流公司信息费用表「物流费用表」sheet 为来源。
 *
 * 版本化：后续源结构变化时新增版本（不修改已冻结版本），冻结映射作为
 * dry-run（8.6）与正式导入（8.7）的统一输入。
 */

export const MIGRATION_MAPPING_VERSION = 1;

/** 源表标识。 */
export type SourceTableId =
  | 'contract-info'
  | 'project-execution'
  | 'workload-stats'
  | 'supplier'
  | 'logistics';

/** 源文件与源表标识的对应关系（部署运维人员按此目录放置源文件）。 */
export const SOURCE_TABLE_FILES: Record<SourceTableId, string> = {
  'contract-info': '合同信息表.xlsx',
  'project-execution': '项目执行表.xlsx',
  'workload-stats': '工作量统计.xlsx',
  'supplier': '供应商表.xlsx',
  'logistics': '物流公司信息费用表.xlsx',
};

export const SOURCE_TABLE_IDS: readonly SourceTableId[] = [
  'contract-info',
  'project-execution',
  'workload-stats',
  'supplier',
  'logistics',
];

/** sheet 目标角色：解析该 sheet 生成的记录类型（ignored = 明确忽略；unmappable = 未配置，报告冲突）。 */
export type SheetRole =
  | 'project'
  | 'service_order'
  | 'invoice'
  | 'logistics_fee'
  | 'serial_address_update'
  | 'qr_request'
  | 'ship_to_request'
  | 'supplier'
  | 'ignored'
  | 'unmappable';

/** sheet 路由：sheet 名 → 角色（与忽略原因）。 */
export interface SheetRoute {
  /** sheet 名（精确匹配）。 */
  sheet: string;
  role: SheetRole;
  /** role=ignored 时的忽略原因（生成报告/日志，不产生 error/conflict）。 */
  ignoreReason?: string;
}

/** 源文件级路由：文件名 + sheet 路由 + 未匹配 sheet 的默认角色。 */
export interface SourceFileRoute {
  table: SourceTableId;
  file: string;
  /** 按 sheet 精确匹配。 */
  sheets: readonly SheetRoute[];
  /** 未在 sheets 中配置的 sheet 的默认角色（默认 ignored，带默认原因）。 */
  defaultRole: SheetRole;
  /** 默认忽略原因（defaultRole=ignored 时展示）。 */
  defaultIgnoreReason: string;
}

/** 单个来源列引用（表 + 源列名 + 兼容别名 + 优先级，数字越小优先级越高）。 */
export interface SourceColumnRef {
  table: SourceTableId;
  column: string;
  /** 兼容别名（如合同/项目表的 `ECC#` 与掉票表的 `ECC`）。 */
  aliases?: readonly string[];
  priority: number;
}

/** 目标字段映射。 */
export interface FieldMapping {
  /** 目标模型字段（如 contract.ecc）。 */
  target: string;
  /** 中文标签。 */
  label: string;
  /** 目标必填（缺失时 dry-run 报错）。 */
  required: boolean;
  /** 来源列，按优先级升序排列。 */
  sources: readonly SourceColumnRef[];
}

/** 版本化映射配置。 */
export interface MigrationMapping {
  version: number;
  /** 冻结时间（ISO）。 */
  frozenAt: string;
  /** 源文件路由（文件 → sheet → 角色）。 */
  files: readonly SourceFileRoute[];
  /** 目标字段映射（含列别名）。 */
  fields: readonly FieldMapping[];
}

/** 目标字段快捷取值辅助（按 target 建立索引）。 */
export function fieldByTarget(mapping: MigrationMapping, target: string): FieldMapping | undefined {
  return mapping.fields.find((f) => f.target === target);
}

/**
 * 源文件 basename 统一化（兼容 Windows/posix 分隔符与 Unicode）：
 * 同时按 `\` 与 `/` 切分取最后一段，并去除首尾空白；匹配 mapping 文件路由时统一使用。
 */
export function sourceFileBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const last = segments[segments.length - 1] ?? '';
  return last.trim();
}

/** 按源文件名（basename，兼容目录前缀）找到文件路由。 */
export function fileRouteByFileName(
  mapping: MigrationMapping,
  fileName: string,
): SourceFileRoute | undefined {
  const base = sourceFileBasename(fileName);
  return mapping.files.find((f) => f.file === base);
}

/** 按 sheet 名找到该文件的 sheet 路由（未匹配返回 null，由调用方用 defaultRole）。
 *  匹配前做 trim + Unicode NFC 标准化，兼容实际工作簿中的空白与等价字符。 */
export function sheetRouteOf(file: SourceFileRoute, sheet: string): SheetRoute | undefined {
  const key = sheet.trim().normalize('NFC');
  return file.sheets.find((s) => s.sheet.trim().normalize('NFC') === key);
}

/** 冻结 v1 映射（sheet 路由 + 列别名，源列名以客户迁移输入文件为准，版本化记录）。 */
export const MAPPING_V1: MigrationMapping = {
  version: MIGRATION_MAPPING_VERSION,
  frozenAt: '2026-08-07',
  files: [
    {
      table: 'contract-info',
      file: SOURCE_TABLE_FILES['contract-info'],
      sheets: [
        { sheet: '合同信息', role: 'project' },
        { sheet: '合同', role: 'project' },
      ],
      // 合同信息表整体为合同/项目输入（含未配置 sheet 也按 project 处理，避免漏读）
      defaultRole: 'project',
      defaultIgnoreReason: '合同信息表存在未配置的 sheet，按 project 处理',
    },
    {
      table: 'project-execution',
      file: SOURCE_TABLE_FILES['project-execution'],
      sheets: [
        { sheet: '搬迁项目', role: 'project' },
        { sheet: '工作表1', role: 'ignored', ignoreReason: '项目执行表辅助工作表「工作表1」，非项目执行输入' },
        { sheet: 'MRS Node', role: 'ignored', ignoreReason: '项目执行表辅助工作表「MRS Node」，非项目执行输入' },
      ],
      // 仅 mapping 明确 ignored 的辅助 sheet 才忽略；其余未配置 sheet 报告冲突（不猜测映射）
      defaultRole: 'unmappable',
      defaultIgnoreReason: '项目执行表存在未配置的 sheet，不猜测映射',
    },
    {
      table: 'workload-stats',
      file: SOURCE_TABLE_FILES['workload-stats'],
      sheets: [
        { sheet: '开单记录表', role: 'service_order' },
        { sheet: '掉票记录表', role: 'invoice' },
        { sheet: '物流费用表', role: 'logistics_fee' },
        { sheet: '搬迁地址信息表', role: 'serial_address_update' },
        { sheet: '服务二维码表', role: 'qr_request' },
        { sheet: 'Ship-to申请', role: 'ship_to_request' },
        { sheet: '搬迁地址信息表（原表无，待新增项）', role: 'ship_to_request' },
      ],
      // 已知 sheet 按角色解析；未配置 sheet 报告冲突（不猜测映射）
      defaultRole: 'unmappable',
      defaultIgnoreReason: '工作量统计存在未配置的 sheet，不猜测映射',
    },
    {
      table: 'supplier',
      file: SOURCE_TABLE_FILES['supplier'],
      sheets: [],
      // 供应商主数据：目标无独立供应商主数据表，按 mapping ignored（不伪造费用错误）
      defaultRole: 'supplier',
      defaultIgnoreReason: '供应商主数据无独立目标表，仅作运输公司参考来源，不产生记录',
    },
    {
      table: 'logistics',
      file: SOURCE_TABLE_FILES['logistics'],
      sheets: [
        { sheet: '物流费用表', role: 'logistics_fee' },
      ],
      // 物流公司信息费用表中未配置的 sheet（如供应商主数据 sheet）不得当物流费用
      defaultRole: 'supplier',
      defaultIgnoreReason: '物流公司信息费用表未配置的 sheet（如供应商主数据），不映射为物流费用',
    },
  ],
  fields: [
    // ---- 合同/项目聚合字段（ECC 为聚合主键，TBD-18；合同/项目表列名为 ECC#，兼容 ECC）----
    {
      target: 'contract.ecc',
      label: 'ECC',
      required: true,
      sources: [
        { table: 'contract-info', column: 'ECC#', aliases: ['ECC'], priority: 1 },
        { table: 'project-execution', column: 'ECC#', aliases: ['ECC'], priority: 1 },
      ],
    },
    {
      target: 'contract.customer_name',
      label: '客户名称',
      required: true,
      sources: [
        { table: 'contract-info', column: '客户名称', aliases: ['Account name', 'Account Name', '客户单位名称'], priority: 1 },
        { table: 'project-execution', column: '客户名称', aliases: ['客户单位名称', 'Account name', 'Account Name'], priority: 2 },
      ],
    },
    {
      target: 'contract.usd_tax_amount_cents',
      label: '合同USD含税金额',
      required: false,
      sources: [
        { table: 'contract-info', column: '合同USD含税金额', priority: 1 },
        { table: 'project-execution', column: '合同金额USD', priority: 2 },
      ],
    },
    {
      target: 'project.entry_at',
      label: '进单时间',
      required: false,
      sources: [
        { table: 'contract-info', column: '进单时间', priority: 1 },
        { table: 'project-execution', column: '进单时间', priority: 2 },
      ],
    },
    {
      target: 'project.region',
      label: '区域',
      required: false,
      sources: [
        { table: 'project-execution', column: '区域', priority: 1 },
        { table: 'contract-info', column: '区域', priority: 2 },
      ],
    },
    {
      target: 'project.contract_start_date',
      label: '合同开始日期',
      required: false,
      sources: [{ table: 'contract-info', column: '合同开始日期', priority: 1 }],
    },
    {
      target: 'project.contract_end_date',
      label: '合同截止日期',
      required: false,
      sources: [{ table: 'contract-info', column: '合同截止日期', priority: 1 }],
    },
    {
      target: 'project.actual_install_done_at',
      label: '实际装机完成时间',
      required: false,
      sources: [{ table: 'project-execution', column: '实际装机完成时间', priority: 1 }],
    },
    {
      target: 'project.acceptance_report_date',
      label: '验收报告形成日期',
      required: false,
      sources: [{ table: 'project-execution', column: '验收报告形成日期', priority: 1 }],
    },
    {
      target: 'project.cancelled_at',
      label: '取消时间',
      required: false,
      sources: [{ table: 'project-execution', column: '取消时间', priority: 1 }],
    },
    // ---- 搬迁仪器（执行字段）----
    {
      target: 'instrument.name',
      label: '仪器名称',
      required: true,
      sources: [{ table: 'project-execution', column: '仪器名称', priority: 1 }],
    },
    {
      target: 'instrument.serial_no',
      label: '序列号',
      required: false,
      sources: [{ table: 'project-execution', column: '序列号', priority: 1 }],
    },
    // ---- 开单动作（工作量统计表「开单记录表」sheet；按服务单号独立记录，不要求 ECC）----
    {
      target: 'service_order.service_order_no',
      label: '服务单号',
      required: true,
      sources: [{ table: 'workload-stats', column: '服务单号', aliases: ['单号'], priority: 1 }],
    },
    {
      target: 'service_order.order_type',
      label: '开单类型',
      required: true,
      sources: [{ table: 'workload-stats', column: '开单类型', aliases: ['类型'], priority: 1 }],
    },
    {
      target: 'service_order.ordered_at',
      label: '开单时间',
      required: true,
      sources: [{ table: 'workload-stats', column: '开单时间', aliases: ['日期'], priority: 1 }],
    },
    {
      target: 'service_order.engineer',
      label: '工程师',
      required: true,
      sources: [{ table: 'workload-stats', column: '工程师', priority: 1 }],
    },
    {
      target: 'service_order.customer_name',
      label: '客户单位',
      required: true,
      sources: [{ table: 'workload-stats', column: '客户单位', aliases: ['客户名称', '客户单位名称'], priority: 1 }],
    },
    {
      target: 'service_order.note',
      label: '备注',
      required: false,
      sources: [{ table: 'workload-stats', column: '备注', priority: 1 }],
    },
    // ---- 掉票动作（工作量统计表「掉票记录表」sheet；按 ECC 归属项目聚合，掉票表列名为 ECC）----
    {
      target: 'invoice.ecc',
      label: 'ECC',
      required: true,
      sources: [
        { table: 'workload-stats', column: 'ECC', aliases: ['ECC#'], priority: 1 },
      ],
    },
    {
      target: 'invoice.region',
      label: '区域',
      required: false,
      sources: [{ table: 'workload-stats', column: '区域', priority: 1 }],
    },
    {
      target: 'invoice.customer_name',
      label: '客户名称',
      required: false,
      sources: [{ table: 'workload-stats', column: '客户名称', aliases: ['客户单位'], priority: 1 }],
    },
    {
      target: 'invoice.amount_cents',
      label: '掉票金额',
      required: true,
      sources: [{ table: 'workload-stats', column: '掉票金额', aliases: ['金额', '金额（USD）'], priority: 1 }],
    },
    {
      target: 'invoice.invoiced_at',
      label: '掉票时间',
      required: true,
      sources: [{ table: 'workload-stats', column: '掉票时间', priority: 1 }],
    },
    // ---- 物流费用（物流公司信息费用表「物流费用表」sheet / 工作量统计「物流费用表」sheet）----
    // 旧表只有「月份」「金额」「物流公司」：月份不得提升为具体申请/登记时间
    // （月份 不作为 applied_at 别名，仍产生 applied_at 必填错误）；金额映射
    // logistics_cost（不再误报缺失）；缺预算/成交仍各报必填；物流公司映射 carrier。
    {
      target: 'logistics_fee.applied_at',
      label: '物流费用申请（登记）时间',
      required: true,
      sources: [
        { table: 'logistics', column: '物流费用申请登记时间', aliases: ['申请时间', '登记时间', '物流费用申请时间'], priority: 1 },
        { table: 'workload-stats', column: '物流费用申请登记时间', aliases: ['申请时间', '登记时间'], priority: 1 },
      ],
    },
    {
      target: 'logistics_fee.budget_price_cents',
      label: '预算价格',
      required: true,
      sources: [
        { table: 'logistics', column: '预算价格', priority: 1 },
        { table: 'workload-stats', column: '预算价格', priority: 1 },
      ],
    },
    {
      target: 'logistics_fee.deal_price_cents',
      label: '成交价格',
      required: true,
      sources: [
        { table: 'logistics', column: '成交价格', priority: 1 },
        { table: 'workload-stats', column: '成交价格', priority: 1 },
      ],
    },
    {
      target: 'logistics_fee.logistics_cost_cents',
      label: '实际物流费用',
      required: true,
      sources: [
        { table: 'logistics', column: '实际物流费用', aliases: ['金额'], priority: 1 },
        { table: 'workload-stats', column: '实际物流费用', aliases: ['金额'], priority: 1 },
      ],
    },
    {
      target: 'logistics_fee.transport_company',
      label: '物流公司',
      required: false,
      sources: [
        { table: 'logistics', column: '物流公司', aliases: ['运输公司', '承运商'], priority: 1 },
        { table: 'workload-stats', column: '物流公司', aliases: ['运输公司', '承运商'], priority: 1 },
      ],
    },
    // ---- 序列号地址更新（工作量统计表「搬迁地址信息表」sheet；按序列号逐台登记，不要求 ECC）----
    {
      target: 'serial_address_update.customer_name',
      label: '客户名称',
      required: true,
      sources: [{ table: 'workload-stats', column: '客户名称', aliases: ['单位名称', '客户单位'], priority: 1 }],
    },
    {
      target: 'serial_address_update.new_site_address',
      label: '新址地址',
      required: true,
      sources: [{ table: 'workload-stats', column: '新址地址', priority: 1 }],
    },
    {
      target: 'serial_address_update.serial_no',
      label: '序列号',
      required: true,
      sources: [{ table: 'workload-stats', column: '序列号', priority: 1 }],
    },
    {
      target: 'serial_address_update.account_id',
      label: 'Account ID',
      required: true,
      sources: [{ table: 'workload-stats', column: 'Account ID', aliases: ['AccountID', 'account id'], priority: 1 }],
    },
    {
      target: 'serial_address_update.updated_at',
      label: '更新时间',
      required: true,
      sources: [{ table: 'workload-stats', column: '更新时间', aliases: ['更新日期'], priority: 1 }],
    },
    // ---- 二维码申请（工作量统计表「服务二维码表」sheet；独立申请记录，不要求 ECC）----
    {
      target: 'qr_request.applicant',
      label: '申请人',
      required: true,
      sources: [{ table: 'workload-stats', column: '申请人', priority: 1 }],
    },
    {
      target: 'qr_request.requested_at',
      label: '申请时间',
      required: true,
      sources: [{ table: 'workload-stats', column: '申请时间', aliases: ['日期'], priority: 1 }],
    },
    {
      target: 'qr_request.type_code',
      label: '申请类型',
      required: false,
      sources: [{ table: 'workload-stats', column: '申请类型', aliases: ['类型', '具体类型'], priority: 1 }],
    },
    {
      target: 'qr_request.type_count',
      label: '类型数量',
      required: false,
      sources: [{ table: 'workload-stats', column: '类型数量', priority: 1 }],
    },
    // ---- Ship-to 申请（工作量统计表「Ship-to申请」/「搬迁地址信息表（原表无，待新增项）」sheet；
    //      独立申请记录，不要求 ECC）----
    {
      target: 'ship_to_request.customer_name',
      label: '客户名称',
      required: true,
      sources: [{ table: 'workload-stats', column: '客户名称', aliases: ['客户单位名称', '单位名称'], priority: 1 }],
    },
    {
      target: 'ship_to_request.new_site_address',
      label: '新址地址',
      required: true,
      sources: [{ table: 'workload-stats', column: '新址地址', priority: 1 }],
    },
    {
      target: 'ship_to_request.account_id',
      label: 'Account ID',
      required: false,
      sources: [{ table: 'workload-stats', column: 'Account ID', aliases: ['AccountID', 'account id'], priority: 1 }],
    },
    {
      target: 'ship_to_request.requested_at',
      label: '日期',
      required: false,
      sources: [{ table: 'workload-stats', column: '日期', aliases: ['申请时间', '提交时间'], priority: 1 }],
    },
  ],
};
