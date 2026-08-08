import type { DatabaseSync } from 'node:sqlite';
import type { InvoiceRecord, InvoiceRepository } from '../project-financial-closure';
import { mapConstraintError, toBigInt } from './repositories';
import { prepareReadBigInt } from './connection';

/**
 * project-financial-closure SQLite 仓储（tasks 5.x 落库）。
 * 掉票记录不可物理删除（本仓储不提供 delete），撤销后为终态。
 */

export class SqliteInvoiceRepository implements InvoiceRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): InvoiceRecord | undefined {
    const row = prepareReadBigInt(this.db, 'SELECT * FROM invoices WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToInvoice(row) : undefined;
  }

  save(invoice: InvoiceRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO invoices (
             id, project_id, amount_cents, invoiced_at, revoked_at, revoke_reason,
             last_modified_at, account_id, username_snapshot, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             amount_cents=excluded.amount_cents, invoiced_at=excluded.invoiced_at,
             revoked_at=excluded.revoked_at, revoke_reason=excluded.revoke_reason,
             last_modified_at=excluded.last_modified_at,
             account_id=excluded.account_id, username_snapshot=excluded.username_snapshot
        `,
        )
        .run(
          invoice.id,
          invoice.projectId,
          invoice.amountCents.toString(),
          invoice.invoicedAt,
          invoice.revokedAt,
          invoice.revokeReason,
          invoice.lastModifiedAt,
          invoice.operatorAccountId,
          invoice.operatorUsername,
          invoice.createdAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `掉票记录保存失败`);
    }
  }

  listByProject(projectId: string): InvoiceRecord[] {
    const rows = prepareReadBigInt(
      this.db,
      'SELECT * FROM invoices WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(rowToInvoice);
  }

  listAll(): InvoiceRecord[] {
    const rows = prepareReadBigInt(this.db, 'SELECT * FROM invoices').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToInvoice);
  }
}

function rowToInvoice(row: Record<string, unknown>): InvoiceRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    amountCents: toBigInt(row.amount_cents) ?? 0n,
    invoicedAt: String(row.invoiced_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    revokeReason: row.revoke_reason === null ? null : String(row.revoke_reason),
    lastModifiedAt: String(row.last_modified_at),
    operatorAccountId: row.account_id === null ? null : String(row.account_id),
    operatorUsername: row.username_snapshot === null ? null : String(row.username_snapshot),
    createdAt: String(row.created_at),
  };
}
