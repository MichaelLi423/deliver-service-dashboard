import type { Project, Contract } from '../../src/domain/capabilities/relocation-project-lifecycle';
import type { InvoiceRecord } from '../../src/domain/capabilities/project-financial-closure';
import type { ServiceOrder } from '../../src/domain/capabilities/service-order-recording';
import type { DamageRepairItem } from '../../src/domain/capabilities/damage-repair-tracking';
import type { Batch, LogisticsFee } from '../../src/domain/capabilities/relocation-execution';
import type { ShipToRequest } from '../../src/domain/capabilities/ship-to-management';
import type { QrRequest } from '../../src/domain/capabilities/qr-request-tracking';
import type { SerialAddressUpdate } from '../../src/domain/capabilities/serial-address-update';
import type { ReportingFactReader } from '../../src/domain/capabilities/operational-reporting';

/**
 * operational-reporting 领域测试用内存事实源（tasks 7.x 场景）。
 * 直接操作数组，支持事后编辑/撤销/取消/改名等实时重算场景。
 */
export class InMemoryReportingFacts implements ReportingFactReader {
  projects: Project[] = [];
  contracts: Contract[] = [];
  invoices: InvoiceRecord[] = [];
  serviceOrders: ServiceOrder[] = [];
  damageItems: DamageRepairItem[] = [];
  batches: Batch[] = [];
  logisticsFees: LogisticsFee[] = [];
  shipToRequests: ShipToRequest[] = [];
  qrRequests: QrRequest[] = [];
  serialAddressUpdates: SerialAddressUpdate[] = [];

  listProjects(): Project[] {
    return this.projects;
  }
  listContracts(): Contract[] {
    return this.contracts;
  }
  listInvoices(): InvoiceRecord[] {
    return this.invoices;
  }
  listServiceOrders(): ServiceOrder[] {
    return this.serviceOrders;
  }
  listDamageItems(): DamageRepairItem[] {
    return this.damageItems;
  }
  listBatches(): Batch[] {
    return this.batches;
  }
  listLogisticsFees(): LogisticsFee[] {
    return this.logisticsFees;
  }
  listShipToRequests(): ShipToRequest[] {
    return this.shipToRequests;
  }
  listQrRequests(): QrRequest[] {
    return this.qrRequests;
  }
  listSerialAddressUpdates(): SerialAddressUpdate[] {
    return this.serialAddressUpdates;
  }
}
