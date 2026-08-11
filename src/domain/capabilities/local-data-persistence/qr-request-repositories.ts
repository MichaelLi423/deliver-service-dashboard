import type { DatabaseSync } from 'node:sqlite';
import type { QrRequest, QrRequestTypeCode } from '../qr-request-tracking';
import type { QrRequestRepository } from '../qr-request-tracking';
import { mapConstraintError } from './repositories';

/**
 * qr-request-tracking SQLite 仓储（tasks 4.9 落库）。
 * 申请记录与选中类型分表保存（qr_requests / qr_request_types），
 * 同一条申请内类型唯一（去重），历史申请完整保留、不覆盖不删除。
 */

export class SqliteQrRequestRepository implements QrRequestRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): QrRequest | undefined {
    const row = this.db.prepare('SELECT * FROM qr_requests WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.assemble(row) : undefined;
  }

  save(request: QrRequest): void {
    try {
      this.db
        .prepare(
          `INSERT INTO qr_requests (
             id, applicant, requested_at, account_id, username_snapshot, created_at
           ) VALUES (?,?,?,?,?,?)
        `,
        )
        .run(
          request.id,
          request.applicant,
          request.requestedAt,
          request.operatorAccountId,
          request.operatorUsername,
          request.createdAt,
        );
      for (const type of request.types) {
        this.db
          .prepare('INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)')
          .run(`${request.id}:${type}`, request.id, type);
      }
    } catch (err) {
      throw mapConstraintError(err, `二维码申请保存失败`);
    }
  }

  listAll(): QrRequest[] {
    const rows = this.db.prepare('SELECT * FROM qr_requests').all() as Record<string, unknown>[];
    return rows.map((row) => this.assemble(row));
  }

  /** 删除申请拥有的类型行；事务边界由领域调用方提供。 */
  deleteTypesByRequestId(id: string): void {
    try {
      this.db.prepare('DELETE FROM qr_request_types WHERE qr_request_id = ?').run(id);
    } catch (err) {
      throw mapConstraintError(err, `二维码申请类型删除失败`);
    }
  }

  /** 删除申请主行；事务边界由领域调用方提供。 */
  deleteById(id: string): void {
    try {
      this.db.prepare('DELETE FROM qr_requests WHERE id = ?').run(id);
    } catch (err) {
      throw mapConstraintError(err, `二维码申请删除失败`);
    }
  }

  private assemble(row: Record<string, unknown>): QrRequest {
    const types = this.db
      .prepare('SELECT type_code FROM qr_request_types WHERE qr_request_id = ? ORDER BY id')
      .all(String(row.id)) as { type_code: QrRequestTypeCode }[];
    return {
      id: String(row.id),
      applicant: String(row.applicant),
      requestedAt: String(row.requested_at),
      types: types.map((t) => t.type_code),
      operatorAccountId: row.account_id === null ? null : String(row.account_id),
      operatorUsername: row.username_snapshot === null ? null : String(row.username_snapshot),
      createdAt: String(row.created_at),
    };
  }
}
