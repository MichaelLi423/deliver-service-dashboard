import type { Project, Contract } from '../relocation-project-lifecycle';
import type { InvoiceRecord } from '../project-financial-closure';
import type { ServiceOrder } from '../service-order-recording';
import type { DamageRepairItem } from '../damage-repair-tracking';
import type { Batch, LogisticsFee } from '../relocation-execution';
import type { ShipToRequest } from '../ship-to-management';
import type { QrRequest } from '../qr-request-tracking';
import type { SerialAddressUpdate } from '../serial-address-update';

/**
 * operational-reporting 事实读取层（design D10 / tasks 7.1）。
 *
 * 报表实时从各模块事实读取全部原始事实，由本模块（operational-reporting）
 * 唯一拥有的统计公式计算，不维护业务状态、不保存历史快照。
 * SQLite 实现见 local-data-persistence/reporting-fact-reader.ts。
 */
export interface ReportingFactReader {
  listProjects(): Project[];
  listContracts(): Contract[];
  listInvoices(): InvoiceRecord[];
  listServiceOrders(): ServiceOrder[];
  listDamageItems(): DamageRepairItem[];
  listBatches(): Batch[];
  listLogisticsFees(): LogisticsFee[];
  listShipToRequests(): ShipToRequest[];
  listQrRequests(): QrRequest[];
  listSerialAddressUpdates(): SerialAddressUpdate[];
  /** 项目分类标签关联；报表仅用其构造一次唯一项目范围，绝不 JOIN 到聚合事实。 */
  listProjectTagAssignments?(): readonly { projectId: string; tagId: string }[];
  /** 标签目录 ID，用于对报表筛选中的未知 ID 给出稳定校验失败。 */
  listProjectTagIds?(): readonly string[];
}
