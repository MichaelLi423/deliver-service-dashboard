import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../relocation-project-lifecycle';
import type { ServiceOrder, OrderType } from '../service-order-recording';
import type {
  ServiceOrderRepository,
  WizardSaveGateway,
} from '../service-order-recording';
import { mapConstraintError } from './repositories';
import { SqliteProjectRepository } from './repositories';

/**
 * service-order-recording SQLite 仓储（tasks 3.8~3.10 落库）。
 * 非空服务单号全局唯一以 SQLite 部分唯一索引（WHERE service_order_no IS NOT NULL）为最终防线。
 */

export class SqliteServiceOrderRepository implements ServiceOrderRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): ServiceOrder | undefined {
    const row = this.db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToServiceOrder(row) : undefined;
  }

  findByServiceOrderNo(serviceOrderNo: string): ServiceOrder | undefined {
    const row = this.db
      .prepare('SELECT * FROM service_orders WHERE service_order_no = ?')
      .get(serviceOrderNo) as Record<string, unknown> | undefined;
    return row ? rowToServiceOrder(row) : undefined;
  }

  save(order: ServiceOrder): void {
    try {
      this.db
        .prepare(
          `INSERT INTO service_orders (
             id, order_type, service_order_no, ordered_at, engineer, customer_name,
             project_id, note, account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             order_type=excluded.order_type, service_order_no=excluded.service_order_no,
             ordered_at=excluded.ordered_at, engineer=excluded.engineer,
             customer_name=excluded.customer_name, project_id=excluded.project_id,
             note=excluded.note,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          order.id,
          order.orderType,
          order.serviceOrderNo,
          order.orderedAt,
          order.engineer,
          order.customerName,
          order.projectId,
          order.note,
          order.accountId,
          order.usernameSnapshot,
          order.createdAt,
          order.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `开单记录保存失败（非空服务单号全局唯一）`);
    }
  }

  list(): ServiceOrder[] {
    const rows = this.db.prepare('SELECT * FROM service_orders').all() as Record<string, unknown>[];
    return rows.map(rowToServiceOrder);
  }

  listByProject(projectId: string): ServiceOrder[] {
    const rows = this.db
      .prepare('SELECT * FROM service_orders WHERE project_id = ?')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(rowToServiceOrder);
  }
}

/**
 * 项目向导原子保存网关（3.10）：项目与自动创建的搬迁开单记录在同一 SQLite
 * 事务内一并保存，失败整体回滚（不产生部分数据）。
 */
export class SqliteWizardSaveGateway implements WizardSaveGateway {
  constructor(
    private readonly db: DatabaseSync,
    private readonly projectRepo: SqliteProjectRepository,
    private readonly orderRepo: SqliteServiceOrderRepository,
  ) {}

  saveAtomically(project: Project, order: ServiceOrder | null): void {
    this.db.exec('BEGIN');
    try {
      this.projectRepo.save(project);
      if (order) {
        this.orderRepo.save(order);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败时继续抛出主错误
      }
      throw err;
    }
  }
}

function rowToServiceOrder(row: Record<string, unknown>): ServiceOrder {
  return {
    id: String(row.id),
    orderType: row.order_type as OrderType,
    serviceOrderNo: row.service_order_no === null ? null : String(row.service_order_no),
    orderedAt: String(row.ordered_at),
    engineer: String(row.engineer),
    customerName: String(row.customer_name),
    projectId: row.project_id === null ? null : String(row.project_id),
    note: row.note === null ? null : String(row.note),
    accountId: row.account_id === null ? null : String(row.account_id),
    usernameSnapshot: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
