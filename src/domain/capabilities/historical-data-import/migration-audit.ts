/**
 * historical-data-import 能力（存量迁移审计与边界）。
 *
 * 存量迁移由工作台外的部署运维人员作为一次性维护动作执行；工作台不提供任何
 * 迁移或导入入口；迁移以 ECC 为项目/合同聚合主键、dry-run 只读预演、整批事务、
 * 幂等重跑、冲突清单、源业务时间保留（导入时间只作审计字段，绝不替代源业务时间）。
 * 迁移导入的数据不视为负责人手工录入、不归属本地应用账号（source = 'import'）。
 */

/** 迁移审计记录（对应 schema v1 建表 + v6 补充 source_hash）。 */
export interface MigrationAuditRecord {
  id: string;
  /** 幂等键：源文件 + sheet + 行号 + 业务键。 */
  batchKey: string;
  fileName: string | null;
  sheet: string | null;
  rowNumber: number | null;
  /** ECC 聚合主键。 */
  ecc: string | null;
  status: 'success' | 'failed' | 'skipped';
  importedCount: number;
  failedCount: number;
  errorDetails: string | null;
  /** 源内容摘要（v6）：同源未变 → 幂等跳过；源已修正 → forward-fix 重跑。 */
  sourceHash: string | null;
  /** 执行人员（工作台外部署运维人员）。 */
  operator: string | null;
  /** 导入时间只作为审计字段保存。 */
  importedAt: string;
}
