import type { DatabaseSync } from 'node:sqlite';
import type { SerialAddressUpdate } from '../serial-address-update';
import type {
  InstrumentAddressReader,
  SerialAddressUpdateRepository,
} from '../serial-address-update';
import { mapConstraintError } from './repositories';

/**
 * serial-address-update SQLite 仓储（tasks 4.3 落库）。
 * 更新事实仅记录仪器与新址关联信息，不创建/修改/删除任何 Ship-to 主数据。
 */

export class SqliteSerialAddressUpdateRepository implements SerialAddressUpdateRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): SerialAddressUpdate | undefined {
    const row = this.db.prepare('SELECT * FROM serial_address_updates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSerialAddressUpdate(row) : undefined;
  }

  save(update: SerialAddressUpdate): void {
    try {
      this.db
        .prepare(
          `INSERT INTO serial_address_updates (
             id, instrument_id, customer_name, new_site_address, serial_no,
             account_id, updated_at, actor_account_id, username_snapshot, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
        `,
        )
        .run(
          update.id,
          update.instrumentId,
          update.customerName,
          update.newSiteAddress,
          update.serialNo,
          update.accountId,
          update.updatedAt,
          update.operatorAccountId,
          update.operatorUsername,
          update.createdAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `序列号地址更新事实保存失败`);
    }
  }

  listAll(): SerialAddressUpdate[] {
    const rows = this.db.prepare('SELECT * FROM serial_address_updates').all() as Record<string, unknown>[];
    return rows.map(rowToSerialAddressUpdate);
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM serial_address_updates WHERE id = ?').run(id);
  }
}

/**
 * 搬迁仪器只读事实源（SQLite）：序列号与登记仪器一致校验。
 */
export class SqliteInstrumentAddressReader implements InstrumentAddressReader {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): { id: string; projectId: string; serialNo: string | null } | undefined {
    const row = this.db
      .prepare('SELECT id, project_id, serial_no FROM instruments WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      serialNo: row.serial_no === null ? null : String(row.serial_no),
    };
  }
}

function rowToSerialAddressUpdate(row: Record<string, unknown>): SerialAddressUpdate {
  return {
    id: String(row.id),
    instrumentId: row.instrument_id === null || row.instrument_id === undefined ? null : String(row.instrument_id),
    customerName: String(row.customer_name),
    newSiteAddress: String(row.new_site_address),
    serialNo: String(row.serial_no),
    accountId: String(row.account_id),
    updatedAt: String(row.updated_at),
    operatorAccountId: row.actor_account_id === null ? null : String(row.actor_account_id),
    operatorUsername: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
  };
}
