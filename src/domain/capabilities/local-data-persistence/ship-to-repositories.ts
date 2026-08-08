import type { DatabaseSync } from 'node:sqlite';
import type { ShipTo, ShipToRequest, ShipToRequestStatus } from '../ship-to-management';
import type {
  ShipToAddressReader,
  ShipToRepository,
  ShipToRequestRepository,
} from '../ship-to-management';
import { mapConstraintError } from './repositories';

/**
 * ship-to-management SQLite 仓储（tasks 4.1~4.2 落库）。
 * Account ID 全局唯一以 ship_tos.account_id 与 ship_to_requests.account_id
 * 唯一/部分唯一索引为最终防线。
 */

export class SqliteShipToRepository implements ShipToRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): ShipTo | undefined {
    const row = this.db.prepare('SELECT * FROM ship_tos WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToShipTo(row) : undefined;
  }

  findByAccountId(accountId: string): ShipTo | undefined {
    const row = this.db.prepare('SELECT * FROM ship_tos WHERE account_id = ?').get(accountId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToShipTo(row) : undefined;
  }

  save(shipTo: ShipTo): void {
    try {
      this.db
        .prepare(
          'INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)',
        )
        .run(shipTo.id, shipTo.accountId, shipTo.customerName, shipTo.newSiteAddress, shipTo.createdAt);
    } catch (err) {
      throw mapConstraintError(err, `Ship-to 保存失败（Account ID 全局唯一且创建后不可修改）`);
    }
  }

  listAll(): ShipTo[] {
    const rows = this.db.prepare('SELECT * FROM ship_tos').all() as Record<string, unknown>[];
    return rows.map(rowToShipTo);
  }
}

export class SqliteShipToRequestRepository implements ShipToRequestRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): ShipToRequest | undefined {
    const row = this.db.prepare('SELECT * FROM ship_to_requests WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToShipToRequest(row) : undefined;
  }

  findByAccountId(accountId: string): ShipToRequest | undefined {
    const row = this.db
      .prepare('SELECT * FROM ship_to_requests WHERE account_id = ?')
      .get(accountId) as Record<string, unknown> | undefined;
    return row ? rowToShipToRequest(row) : undefined;
  }

  findByCustomerAndAddress(customerName: string, newSiteAddress: string): ShipToRequest | undefined {
    // 与 v8 唯一索引一致：按 trim 后值比较（同客户同新址一条申请）。
    const row = this.db
      .prepare(
        'SELECT * FROM ship_to_requests WHERE trim(customer_name) = ? AND trim(new_site_address) = ? LIMIT 1',
      )
      .get(customerName.trim(), newSiteAddress.trim()) as Record<string, unknown> | undefined;
    return row ? rowToShipToRequest(row) : undefined;
  }

  save(request: ShipToRequest): void {
    try {
      this.db
        .prepare(
          `INSERT INTO ship_to_requests (
             id, customer_name, new_site_address, account_id, status,
             submitted_at, completed_at, actor_account_id, username_snapshot, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             account_id=excluded.account_id, status=excluded.status,
             submitted_at=excluded.submitted_at, completed_at=excluded.completed_at,
             actor_account_id=excluded.actor_account_id,
             username_snapshot=excluded.username_snapshot,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          request.id,
          request.customerName,
          request.newSiteAddress,
          request.accountId,
          request.status,
          request.submittedAt,
          request.completedAt,
          request.operatorAccountId,
          request.operatorUsername,
          request.createdAt,
          request.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(
        err,
        `Ship-to 申请保存失败（同客户同新址唯一或 Account ID 唯一约束冲突）`,
      );
    }
  }

  listAll(): ShipToRequest[] {
    const rows = this.db.prepare('SELECT * FROM ship_to_requests').all() as Record<string, unknown>[];
    return rows.map(rowToShipToRequest);
  }
}

/** 批次/项目所涉 Ship-to 汇总展示的只读事实源（SQLite）。 */
export class SqliteShipToAddressReader implements ShipToAddressReader {
  constructor(private readonly db: DatabaseSync) {}

  listInstrumentIdsByBatch(batchId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM instruments WHERE batch_id = ?')
      .all(batchId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  listInstrumentIdsByProject(projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM instruments WHERE project_id = ?')
      .all(projectId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  listDestinationShipToIds(instrumentIds: string[]): string[] {
    if (instrumentIds.length === 0) return [];
    const placeholders = instrumentIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT destination_ship_to_id FROM instruments
         WHERE destination_ship_to_id IS NOT NULL AND id IN (${placeholders})`,
      )
      .all(...instrumentIds) as { destination_ship_to_id: string }[];
    return rows.map((r) => r.destination_ship_to_id);
  }
}

// ---- row → 领域对象映射 ----

function rowToShipTo(row: Record<string, unknown>): ShipTo {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    customerName: String(row.customer_name),
    newSiteAddress: String(row.new_site_address),
    createdAt: String(row.created_at),
  };
}

function rowToShipToRequest(row: Record<string, unknown>): ShipToRequest {
  return {
    id: String(row.id),
    customerName: String(row.customer_name),
    newSiteAddress: String(row.new_site_address),
    accountId: row.account_id === null ? null : String(row.account_id),
    status: row.status as ShipToRequestStatus,
    submittedAt: row.submitted_at === null ? null : String(row.submitted_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    operatorAccountId: row.actor_account_id === null ? null : String(row.actor_account_id),
    operatorUsername: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
