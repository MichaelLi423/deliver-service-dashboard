import type { DatabaseSync } from 'node:sqlite';
import { PersistenceError, UniquenessError } from '../../core/errors';
import { prepareReadBigInt } from './connection';
import type { AccountRepository } from '../workbench-access/account';
import type { Account } from '../workbench-access/account';
import type {
  Contract,
  ContractRepository,
  InvoiceReadRepository,
  Project,
  ProjectRepository,
} from '../relocation-project-lifecycle';
import type { Customer, CustomerRepository } from '../relocation-project-lifecycle';

/**
 * SQLite 仓储实现（tasks 1.2/1.6/1.7 唯一性 + 1.9 持久化）。
 * 唯一性以 SQLite 唯一/部分唯一索引为最终防线，并把约束冲突映射为领域错误。
 */

const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** 将底层约束错误映射为 UniquenessError / PersistenceError。 */
export function mapConstraintError(err: unknown, message: string): Error {
  const e = err as { errcode?: number; message?: string };
  if (e?.errcode === SQLITE_CONSTRAINT_UNIQUE) {
    return new UniquenessError('DB_UNIQUE_VIOLATION', message);
  }
  return new PersistenceError('DB_WRITE_FAILED', e?.message ?? String(err));
}

export class SqliteCustomerRepository implements CustomerRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByName(name: string): Customer | undefined {
    const row = this.db.prepare('SELECT * FROM customers WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? (row as unknown as Customer) : undefined;
  }

  save(customer: Customer): void {
    try {
      this.db
        .prepare(
          'INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(customer.id, customer.name, customer.createdAt, customer.createdAt);
    } catch (err) {
      throw mapConstraintError(err, `客户名称「${customer.name}」已存在（唯一业务标识）`);
    }
  }
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  findById(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return rowToProject(row);
  }

  listAll(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY temp_no').all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => rowToProject(row));
  }

  save(project: Project): void {
    try {
      this.db
        .prepare(
          `INSERT INTO projects (
             id, temp_no, status, pre_entry_execution, scope_confirmed,
             manager_approval_reason, manager_approval_missing,
             customer_id, contract_id, entry_at,
             region, old_site_contact, new_site_contact, old_site_address, new_site_address,
             contract_start_date, contract_end_date, plan_visit_at, plan_transport_at,
             site_confirmed, actual_install_done_at, acceptance_report, acceptance_report_date,
             cancelled_at, cancel_reason, reminder_at, reminder_note,
             reminder_account_id, reminder_username_snapshot, temporary_instrument_count,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status, pre_entry_execution=excluded.pre_entry_execution,
             scope_confirmed=excluded.scope_confirmed,
             manager_approval_reason=excluded.manager_approval_reason,
             manager_approval_missing=excluded.manager_approval_missing,
             customer_id=excluded.customer_id, contract_id=excluded.contract_id,
             entry_at=excluded.entry_at, region=excluded.region,
             old_site_contact=excluded.old_site_contact, new_site_contact=excluded.new_site_contact,
             old_site_address=excluded.old_site_address, new_site_address=excluded.new_site_address,
             contract_start_date=excluded.contract_start_date, contract_end_date=excluded.contract_end_date,
             plan_visit_at=excluded.plan_visit_at, plan_transport_at=excluded.plan_transport_at,
             site_confirmed=excluded.site_confirmed, actual_install_done_at=excluded.actual_install_done_at,
             acceptance_report=excluded.acceptance_report, acceptance_report_date=excluded.acceptance_report_date,
             cancelled_at=excluded.cancelled_at, cancel_reason=excluded.cancel_reason,
             reminder_at=excluded.reminder_at, reminder_note=excluded.reminder_note,
             reminder_account_id=excluded.reminder_account_id,
             reminder_username_snapshot=excluded.reminder_username_snapshot,
             temporary_instrument_count=excluded.temporary_instrument_count,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          project.id,
          project.tempNo,
          project.status,
          project.preEntryExecution ? 1 : 0,
          project.scopeConfirmed ? 1 : 0,
          project.managerApprovalReason,
          project.managerApprovalMissing,
          project.customerId,
          project.contractId,
          project.entryAt,
          project.region,
          project.oldSiteContact,
          project.newSiteContact,
          project.oldSiteAddress,
          project.newSiteAddress,
          project.contractStartDate,
          project.contractEndDate,
          project.planVisitAt,
          project.planTransportAt,
          project.siteConfirmed ? 1 : 0,
          project.actualInstallDoneAt,
          project.acceptanceReport ? 1 : 0,
          project.acceptanceReportDate,
          project.cancelledAt,
          project.cancelReason,
          project.reminderAt,
          project.reminderNote,
          project.reminderAccountId,
          project.reminderUsernameSnapshot,
          project.temporaryInstrumentCount,
          project.createdAt,
          project.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `项目保存失败（临时编号或关联冲突）`);
    }
  }
}

export class SqliteContractRepository implements ContractRepository {
  constructor(private readonly db: DatabaseSync) {}

  findByProjectId(projectId: string): Contract | undefined {
    const row = prepareReadBigInt(this.db, 'SELECT * FROM contracts WHERE project_id = ?').get(
      projectId,
    ) as Record<string, unknown> | undefined;
    return row ? rowToContract(row) : undefined;
  }

  findByEcc(ecc: string): Contract | undefined {
    const row = prepareReadBigInt(this.db, 'SELECT * FROM contracts WHERE ecc = ?').get(ecc) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToContract(row) : undefined;
  }

  listAll(): Contract[] {
    const rows = prepareReadBigInt(this.db, 'SELECT * FROM contracts').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToContract);
  }

  save(contract: Contract): void {
    try {
      this.db
        .prepare(
          `INSERT INTO contracts (
             id, project_id, temp_number, ecc, ecc_last_modified_at,
             usd_tax_amount_cents, entry_amount_snapshot_cents, final_confirmable_amount_cents,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             project_id=excluded.project_id, temp_number=excluded.temp_number,
             ecc=excluded.ecc, ecc_last_modified_at=excluded.ecc_last_modified_at,
             usd_tax_amount_cents=excluded.usd_tax_amount_cents,
             entry_amount_snapshot_cents=excluded.entry_amount_snapshot_cents,
             final_confirmable_amount_cents=excluded.final_confirmable_amount_cents,
             updated_at=excluded.updated_at
        `,
        )
        .run(
          contract.id,
          contract.projectId,
          contract.tempNumber,
          contract.ecc,
          contract.eccLastModifiedAt,
          contract.usdTaxAmountCents === null ? null : contract.usdTaxAmountCents.toString(),
          contract.entryAmountSnapshotCents === null
            ? null
            : contract.entryAmountSnapshotCents.toString(),
          contract.finalConfirmableAmountCents === null
            ? null
            : contract.finalConfirmableAmountCents.toString(),
          contract.createdAt,
          contract.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `合同保存失败（ECC 或项目关联冲突）`);
    }
  }
}

/**
 * 掉票事实读取仓储（只读；写入属 project-financial-closure 5.x）。
 * 供 lifecycle 消费掉票事实：取消约束（含已撤销历史）与金额闭环重算。
 */
export class SqliteInvoiceReadRepository implements InvoiceReadRepository {
  constructor(private readonly db: DatabaseSync) {}

  sumActiveAmounts(projectId: string): bigint {
    const row = prepareReadBigInt(
      this.db,
      'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoices WHERE project_id = ? AND revoked_at IS NULL',
    ).get(projectId) as { total: bigint | string | number };
    return BigInt(String(row.total));
  }

  hasAnyInvoiceHistory(projectId: string): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM invoices WHERE project_id = ?')
      .get(projectId) as { n: number };
    return row.n > 0;
  }
}

export class SqliteAccountRepository implements AccountRepository {
  constructor(private readonly db: DatabaseSync) {}

  findFirst(): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAccount(row) : undefined;
  }

  findByUsername(username: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAccount(row) : undefined;
  }

  save(account: Account): void {
    try {
      this.db
        .prepare(
          `INSERT INTO accounts (
             id, username, password_hash, password_salt, recovery_code_hash, recovery_code_salt,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?)
        `,
        )
        .run(
          account.id,
          account.username,
          account.passwordHash,
          account.passwordSalt,
          account.recoveryCodeHash,
          account.recoveryCodeSalt,
          account.createdAt,
          account.updatedAt,
        );
    } catch (err) {
      throw mapConstraintError(err, `账号保存失败`);
    }
  }

  update(account: Account): void {
    try {
      this.db
        .prepare(
          `UPDATE accounts SET
             username = ?, password_hash = ?, password_salt = ?,
             recovery_code_hash = ?, recovery_code_salt = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          account.username,
          account.passwordHash,
          account.passwordSalt,
          account.recoveryCodeHash,
          account.recoveryCodeSalt,
          account.updatedAt,
          account.id,
        );
    } catch (err) {
      throw mapConstraintError(err, `账号更新失败`);
    }
  }
}

// ---- row → 领域对象映射（SQLite 行均为字符串/数字/null） ----

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    recoveryCodeHash: row.recovery_code_hash === null ? null : String(row.recovery_code_hash),
    recoveryCodeSalt: row.recovery_code_salt === null ? null : String(row.recovery_code_salt),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toBigInt(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(String(value));
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === '1';
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    tempNo: String(row.temp_no),
    status: row.status as Project['status'],
    preEntryExecution: toBool(row.pre_entry_execution),
    scopeConfirmed: toBool(row.scope_confirmed),
    managerApprovalReason:
      row.manager_approval_reason === null ? null : String(row.manager_approval_reason),
    managerApprovalMissing:
      row.manager_approval_missing === null ? null : String(row.manager_approval_missing),
    customerId: row.customer_id === null ? null : String(row.customer_id),
    contractId: row.contract_id === null ? null : String(row.contract_id),
    entryAt: row.entry_at === null ? null : String(row.entry_at),
    region: row.region === null ? null : String(row.region),
    oldSiteContact: row.old_site_contact === null ? null : String(row.old_site_contact),
    newSiteContact: row.new_site_contact === null ? null : String(row.new_site_contact),
    oldSiteAddress: row.old_site_address === null ? null : String(row.old_site_address),
    newSiteAddress: row.new_site_address === null ? null : String(row.new_site_address),
    contractStartDate: row.contract_start_date === null ? null : String(row.contract_start_date),
    contractEndDate: row.contract_end_date === null ? null : String(row.contract_end_date),
    planVisitAt: row.plan_visit_at === null ? null : String(row.plan_visit_at),
    planTransportAt: row.plan_transport_at === null ? null : String(row.plan_transport_at),
    siteConfirmed: toBool(row.site_confirmed),
    actualInstallDoneAt: row.actual_install_done_at === null ? null : String(row.actual_install_done_at),
    acceptanceReport: toBool(row.acceptance_report),
    acceptanceReportDate:
      row.acceptance_report_date === null ? null : String(row.acceptance_report_date),
    cancelledAt: row.cancelled_at === null ? null : String(row.cancelled_at),
    cancelReason: row.cancel_reason === null ? null : String(row.cancel_reason),
    reminderAt: row.reminder_at === null ? null : String(row.reminder_at),
    reminderNote: row.reminder_note === null ? null : String(row.reminder_note),
    reminderAccountId: row.reminder_account_id === null ? null : String(row.reminder_account_id),
    reminderUsernameSnapshot:
      row.reminder_username_snapshot === null ? null : String(row.reminder_username_snapshot),
    temporaryInstrumentCount:
      row.temporary_instrument_count === null ? null : Number(row.temporary_instrument_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToContract(row: Record<string, unknown>): Contract {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    tempNumber: String(row.temp_number),
    ecc: row.ecc === null ? null : String(row.ecc),
    eccLastModifiedAt:
      row.ecc_last_modified_at === null ? null : String(row.ecc_last_modified_at),
    usdTaxAmountCents: toBigInt(row.usd_tax_amount_cents),
    entryAmountSnapshotCents: toBigInt(row.entry_amount_snapshot_cents),
    finalConfirmableAmountCents: toBigInt(row.final_confirmable_amount_cents),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
