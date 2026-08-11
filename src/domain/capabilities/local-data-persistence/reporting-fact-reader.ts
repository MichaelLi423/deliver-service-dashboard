import type { DatabaseSync } from 'node:sqlite';
import type { ReportingFactReader } from '../operational-reporting';
import type { Contract, Project } from '../relocation-project-lifecycle';
import type { InvoiceRecord } from '../project-financial-closure';
import type { ServiceOrder } from '../service-order-recording';
import type { DamageRepairItem } from '../damage-repair-tracking';
import type { Batch, LogisticsFee } from '../relocation-execution';
import type { ShipToRequest } from '../ship-to-management';
import type { QrRequest } from '../qr-request-tracking';
import type { SerialAddressUpdate } from '../serial-address-update';
import {
  SqliteBatchRepository,
  SqliteLogisticsFeeRepository,
} from './execution-repositories';
import { SqliteDamageRepairItemRepository } from './damage-repair-repositories';
import { SqliteInvoiceRepository } from './financial-repositories';
import { SqliteQrRequestRepository } from './qr-request-repositories';
import { SqliteContractRepository, SqliteProjectRepository } from './repositories';
import { SqliteSerialAddressUpdateRepository } from './serial-address-update-repositories';
import { SqliteServiceOrderRepository } from './service-order-repositories';
import { SqliteShipToRequestRepository } from './ship-to-repositories';

/**
 * operational-reporting SQLite 事实读取层（tasks 7.1/7.10）。
 *
 * 每次调用实时从数据库读取原始事实（无缓存、无快照），由 operational-reporting
 * 的唯一统计公式消费；不维护业务状态、不复制各模块的校验规则。
 */
export class SqliteReportingFactReader implements ReportingFactReader {
  private readonly db: DatabaseSync;
  private readonly projects: SqliteProjectRepository;
  private readonly contracts: SqliteContractRepository;
  private readonly invoices: SqliteInvoiceRepository;
  private readonly orders: SqliteServiceOrderRepository;
  private readonly damages: SqliteDamageRepairItemRepository;
  private readonly batches: SqliteBatchRepository;
  private readonly fees: SqliteLogisticsFeeRepository;
  private readonly shipToRequests: SqliteShipToRequestRepository;
  private readonly qrRequests: SqliteQrRequestRepository;
  private readonly serialUpdates: SqliteSerialAddressUpdateRepository;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.projects = new SqliteProjectRepository(db);
    this.contracts = new SqliteContractRepository(db);
    this.invoices = new SqliteInvoiceRepository(db);
    this.orders = new SqliteServiceOrderRepository(db);
    this.damages = new SqliteDamageRepairItemRepository(db);
    this.batches = new SqliteBatchRepository(db);
    this.fees = new SqliteLogisticsFeeRepository(db);
    this.shipToRequests = new SqliteShipToRequestRepository(db);
    this.qrRequests = new SqliteQrRequestRepository(db);
    this.serialUpdates = new SqliteSerialAddressUpdateRepository(db);
  }

  listProjects(): Project[] {
    return this.projects.listAll();
  }

  listContracts(): Contract[] {
    return this.contracts.listAll();
  }

  listInvoices(): InvoiceRecord[] {
    return this.invoices.listAll();
  }

  listServiceOrders(): ServiceOrder[] {
    return this.orders.list();
  }

  listDamageItems(): DamageRepairItem[] {
    return this.damages.listAll();
  }

  listBatches(): Batch[] {
    return this.batches.listAll();
  }

  listLogisticsFees(): LogisticsFee[] {
    return this.fees.listAll();
  }

  listShipToRequests(): ShipToRequest[] {
    return this.shipToRequests.listAll();
  }

  listQrRequests(): QrRequest[] {
    return this.qrRequests.listAll();
  }

  listSerialAddressUpdates(): SerialAddressUpdate[] {
    return this.serialUpdates.listAll();
  }

  listProjectTagAssignments(): readonly { projectId: string; tagId: string }[] {
    return (this.db.prepare('SELECT project_id, tag_id FROM project_tag_assignments').all() as Array<{
      project_id: string;
      tag_id: string;
    }>).map((row) => ({ projectId: row.project_id, tagId: row.tag_id }));
  }

  listProjectTagIds(): readonly string[] {
    return (this.db.prepare('SELECT id FROM project_tag_definitions').all() as Array<{ id: string }>).map((row) => row.id);
  }
}
