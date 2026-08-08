import { parseDecimalToCents } from '../../core/money';
import type { ImportCategory } from './workspace/workspace-model';
import { IMPORT_CATEGORIES, IMPORT_CATEGORY_LABELS } from './workspace/workspace-model';
import type { NormalizedRow } from './normalized-row';
import { fieldCatalogFor } from './field-catalog';
import type { ImportProblem, ImportProblemCode } from './validation-model';
import { severityOfCode } from './validation-model';
import {
  buildPlanFromRows,
  sourcePositionOf,
  planSourceKey,
  type NormalizedImportPlan,
  type PlanInvoice,
  type PlanLogisticsFee,
} from './validation-kernel';
import type { TargetConflictReader } from './target-reader';

/**
 * 校验编排（design D24 / tasks 8.28~8.34、8.36）。
 *
 * - validatePlan：七类跨表完整校验（必填/金额/格式、ECC 聚合冲突、跨类关联与唯一性、
 *   独立申请边界、目标库冲突、声明与空导入资格）；校验期间只读目标库，零业务写入；
 * - validateAffected：受影响记录/ECC 的局部重校验（跨类唯一性留在完整校验阶段）；
 * - 资格：任一未声明类别、空导入、错误或未解决冲突 → blocked；警告不阻断。
 */

export interface ValidationOptions {
  /** 七类显式声明（'data' | 'none'）；未声明的类别阻止进入最终确认。 */
  declared: Partial<Record<ImportCategory, 'data' | 'none'>>;
  /** 目标库只读读取器（提供时执行 ECC 引用 / 序列号匹配 / 目标覆盖冲突检查）。 */
  target?: TargetConflictReader;
}

export interface ValidationResult {
  plan: NormalizedImportPlan;
  problems: ImportProblem[];
  /** eligible = 无错误且无未解决冲突（警告不阻断）。 */
  eligible: boolean;
  /** 阻断原因（错误/未解决冲突/未声明类别/空导入）。 */
  blockingReasons: string[];
}

/** 受影响选择（局部重校验：受影响记录行 + 受影响 ECC）。 */
export interface AffectedSelection {
  rowIds: string[];
  eccs: string[];
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/;

function isEmpty(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function problem(
  row: NormalizedRow | null,
  code: ImportProblemCode,
  field: string | null,
  message: string,
  extra?: Partial<ImportProblem>,
): ImportProblem {
  return {
    code,
    severity: severityOfCode(code),
    category: row?.category ?? extra?.category ?? null,
    recordKey: row?.rowId ?? extra?.recordKey ?? null,
    field,
    gridRow: row?.sourceRow ?? null,
    businessKey: row?.businessKey ?? extra?.businessKey ?? null,
    sourcePosition: row ? sourcePositionOf(row) : extra?.sourcePosition ?? null,
    message,
    ...extra,
  };
}

/** 记录级字段校验：必填、金额正数、日期/金额格式（design 8.30）。 */
function validateRowFields(row: NormalizedRow, problems: ImportProblem[]): void {
  const isInstrumentRow =
    row.category === 'project' &&
    (row.cells['instrument.name'] !== undefined && row.cells['instrument.name'] !== null && row.cells['instrument.name'] !== '') ||
    (row.cells['instrument.serial_no'] !== undefined && row.cells['instrument.serial_no'] !== null && row.cells['instrument.serial_no'] !== '');

  for (const field of fieldCatalogFor(row.category)) {
    const raw = row.cells[field.field] ?? null;
    const value = raw !== null && raw.trim() !== '' ? raw : null;

    // 必填（ECC 单独错误码；项目级必填在聚合后检查，避免跨来源行误报）。
    if (field.required && value === null) {
      if (row.category === 'project') {
        if (field.field === 'instrument.name' && isInstrumentRow) {
          problems.push(
            problem(row, 'MISSING_REQUIRED_FIELD', field.field, `目标字段「${field.label}」（${field.field}）必填缺失`),
          );
        }
        // contract.ecc / contract.customer_name 由聚合级检查（ECC 孤儿行 / 项目级必填）。
        continue;
      }
      if (field.field.endsWith('.ecc')) {
        problems.push(
          problem(row, 'MISSING_ECC', field.field, `项目/数据缺少 ECC（${field.label}为目标必填），补齐前不可提交`),
        );
      } else {
        problems.push(
          problem(row, 'MISSING_REQUIRED_FIELD', field.field, `目标字段「${field.label}」（${field.field}）必填缺失`),
        );
      }
    }

    if (value === null) continue;

    switch (field.type) {
      case 'money': {
        try {
          const cents = parseDecimalToCents(value);
          if (cents === 0n && field.field !== 'contract.usd_tax_amount_cents') {
            problems.push(
              problem(row, 'AMOUNT_NOT_POSITIVE', field.field, `目标字段「${field.label}」有值必须大于 0（仅合同 USD 含税金额允许为 0）`),
            );
          }
        } catch {
          problems.push(problem(row, 'INVALID_AMOUNT', field.field, `目标字段「${field.label}」不是合法金额`));
        }
        break;
      }
      case 'date':
        if (!DATE_ONLY_RE.test(value)) {
          problems.push(problem(row, 'INVALID_VALUE', field.field, `目标字段「${field.label}」不是合法业务日期（yyyy-mm-dd）`));
        }
        break;
      case 'datetime':
        if (!ISO_DATETIME_RE.test(value)) {
          problems.push(problem(row, 'INVALID_VALUE', field.field, `目标字段「${field.label}」不是合法业务时间（带时区偏移 ISO）`));
        }
        break;
      default:
        break;
    }
  }

  // 成交价格高于预算价格：仅警告（业务规则明确允许记录）。
  if (row.category === 'logistics_fee') {
    const budgetRaw = row.cells['logistics_fee.budget_price_cents'];
    const dealRaw = row.cells['logistics_fee.deal_price_cents'];
    if (budgetRaw !== null && budgetRaw !== '' && dealRaw !== null && dealRaw !== '') {
      try {
        const budgetCents = parseDecimalToCents(budgetRaw);
        const dealCents = parseDecimalToCents(dealRaw);
        if (dealCents > budgetCents) {
          const diff = formatYuan(dealCents - budgetCents);
          problems.push(
            problem(
              row,
              'DEAL_ABOVE_BUDGET',
              'logistics_fee.deal_price_cents',
              `成交价格高于预算价格（差额 ${diff} 元），允许记录但请负责人核对`,
            ),
          );
        }
      } catch {
        // 非法金额已由字段校验报告
      }
    }
  }

  // 物理位置兜底身份：重排行会改变身份，最终确认前提示。
  if (row.positionOnlyIdentity) {
    problems.push(
      problem(
        row,
        'POSITION_ONLY_IDENTITY',
        null,
        '该记录既无业务键也无稳定源行 ID，身份以来源与物理行号为兜底：重排行可能改变后续修正匹配',
      ),
    );
  }
}

/** 分 → 元（两位小数）。 */
function formatYuan(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const units = abs / 100n;
  const frac = abs % 100n;
  const body = `${units}.${String(frac).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/** 聚合项目级校验：项目必填（customer_name）、金额/日期范围。 */
function validateAggregatedProjects(plan: NormalizedImportPlan, byRowId: Map<string, NormalizedRow>, problems: ImportProblem[]): void {
  for (const project of plan.projects) {
    const firstRow = byRowId.get(project.rows[0]?.rowId ?? '') ?? project.rows[0];
    if (isEmpty(project.customerName)) {
      problems.push(
        problem(firstRow, 'MISSING_REQUIRED_FIELD', 'contract.customer_name', '目标字段「客户名称」（contract.customer_name）必填缺失'),
      );
    }
    if (project.contractStartDate !== null && project.contractEndDate !== null && project.contractEndDate < project.contractStartDate) {
      problems.push(
        problem(
          firstRow,
          'INVALID_DATE_RANGE',
          'project.contract_end_date',
          '合同截止日期不得早于合同开始日期',
          { businessKey: project.ecc },
        ),
      );
    }
  }
}

/** ECC 引用校验（8.31）：掉票/物流费用必须引用本次计划或目标库中唯一匹配的 ECC。 */
function validateEccReferences(
  plan: NormalizedImportPlan,
  target: TargetConflictReader | undefined,
  byRowId: Map<string, NormalizedRow>,
  problems: ImportProblem[],
): void {
  const planEccs = new Set(plan.projects.map((p) => p.ecc));
  const check = (record: PlanInvoice | PlanLogisticsFee, ecc: string | null, field: string): void => {
    if (isEmpty(ecc)) return; // 必填缺失由字段校验报告
    const row = byRowId.get(record.rows[0]?.rowId ?? '') ?? record.rows[0];
    const inPlan = planEccs.has(ecc!);
    const inTarget = target !== undefined && target.hasEcc(ecc!);
    if (!inPlan && !inTarget) {
      problems.push(
        problem(row, 'UNRESOLVED_ECC_REFERENCE', field, `ECC「${ecc}」未在本次计划或目标库中唯一匹配，无法关联搬迁项目`),
      );
    }
  };
  for (const invoice of plan.invoices) check(invoice, invoice.ecc, 'invoice.ecc');
  for (const fee of plan.logisticsFees) check(fee, fee.ecc, 'logistics_fee.ecc');
}

/** 跨类唯一性（8.31）：重复非空服务单号、重复 Account ID、序列号匹配与同项目唯一。 */
function validateCrossClass(
  plan: NormalizedImportPlan,
  target: TargetConflictReader | undefined,
  byRowId: Map<string, NormalizedRow>,
  problems: ImportProblem[],
): void {
  // 重复非空服务单号 → 冲突清单（解决前整批禁止导入）。
  const byNo = new Map<string, typeof plan.serviceOrders>();
  for (const order of plan.serviceOrders) {
    if (isEmpty(order.serviceOrderNo)) continue;
    const list = byNo.get(order.serviceOrderNo) ?? [];
    list.push(order);
    byNo.set(order.serviceOrderNo, list);
  }
  for (const [no, orders] of byNo) {
    if (orders.length < 2) continue;
    for (const order of orders) {
      const row = byRowId.get(order.rows[0]?.rowId ?? '') ?? order.rows[0];
      problems.push(
        problem(
          row,
          'DUPLICATE_SERVICE_ORDER',
          'service_order.service_order_no',
          `不同记录存在重复的非空服务单号（业务键 ${no}），解决前不可提交`,
        ),
      );
    }
  }

  // 重复非空 Account ID（Ship-to 申请之间）。
  const byAccount = new Map<string, typeof plan.shipToRequests>();
  for (const req of plan.shipToRequests) {
    if (isEmpty(req.accountId)) continue;
    const list = byAccount.get(req.accountId!) ?? [];
    list.push(req);
    byAccount.set(req.accountId!, list);
  }
  for (const [accountId, reqs] of byAccount) {
    if (reqs.length < 2) continue;
    for (const req of reqs) {
      const row = byRowId.get(req.rows[0]?.rowId ?? '') ?? req.rows[0];
      problems.push(
        problem(
          row,
          'DUPLICATE_ACCOUNT_ID',
          'ship_to_request.account_id',
          `不同 Ship-to 申请具有重复的非空 Account ID（业务键 ${accountId}），解决前不可提交`,
        ),
      );
    }
  }

  // 序列号匹配：序列号地址更新必须唯一匹配计划或目标库中的搬迁仪器。
  const planProjectsBySerial = new Map<string, string[]>();
  for (const project of plan.projects) {
    for (const inst of project.instruments) {
      if (isEmpty(inst.serialNo)) continue;
      const list = planProjectsBySerial.get(inst.serialNo!) ?? [];
      if (!list.includes(project.ecc)) list.push(project.ecc);
      planProjectsBySerial.set(inst.serialNo!, list);
    }
  }
  for (const update of plan.serialAddressUpdates) {
    const serial = update.serialNo;
    if (isEmpty(serial)) continue;
    const row = byRowId.get(update.rows[0]?.rowId ?? '') ?? update.rows[0];
    const inPlanProjects = planProjectsBySerial.get(serial!) ?? [];
    if (inPlanProjects.length > 1) {
      problems.push(
        problem(
          row,
          'SERIAL_NO_MISMATCH',
          'serial_address_update.serial_no',
          `序列号「${serial}」在本计划中匹配多个项目，无法唯一匹配搬迁仪器`,
        ),
      );
      continue;
    }
    if (inPlanProjects.length === 1) continue; // 计划内唯一匹配
    if (target !== undefined) {
      const targetProjects = target.projectsBySerial(serial!);
      if (targetProjects.length === 1) continue; // 目标库唯一匹配
      problems.push(
        problem(
          row,
          'SERIAL_NO_MISMATCH',
          'serial_address_update.serial_no',
          targetProjects.length === 0
            ? `序列号「${serial}」在计划与目标库中均未匹配到搬迁仪器`
            : `序列号「${serial}」在目标库中匹配多个项目，无法唯一匹配`,
        ),
      );
    } else {
      problems.push(
        problem(
          row,
          'SERIAL_NO_MISMATCH',
          'serial_address_update.serial_no',
          `序列号「${serial}」未在本计划中匹配到搬迁仪器，且未提供目标库用于唯一匹配`,
        ),
      );
    }
  }

  // 同项目序列号唯一性：非空序列号在同一 ECC 项目内不得重复。
  for (const project of plan.projects) {
    const seen = new Set<string>();
    for (const inst of project.instruments) {
      if (isEmpty(inst.serialNo)) continue;
      if (seen.has(inst.serialNo!)) {
        const row = byRowId.get(inst.rows[0]?.rowId ?? '') ?? inst.rows[0];
        problems.push(
          problem(
            row,
            'DUPLICATE_SERIAL_IN_PROJECT',
            'instrument.serial_no',
            `序列号「${inst.serialNo}」在项目「${project.ecc}」内重复，违反同项目序列号唯一性`,
          ),
        );
      }
      seen.add(inst.serialNo!);
    }
  }
}

/** 独立申请边界（8.32）：二维码类型不得由数量猜测；QR/Ship-to 不强制 ECC。 */
function validateBoundaries(plan: NormalizedImportPlan, byRowId: Map<string, NormalizedRow>, problems: ImportProblem[]): void {
  for (const qr of plan.qrRequests) {
    const row = byRowId.get(qr.rows[0]?.rowId ?? '') ?? qr.rows[0];
    if (isEmpty(qr.typeCode)) {
      problems.push(
        problem(
          row,
          'QR_TYPE_MISSING',
          'qr_request.type_code',
          `二维码申请仅有类型数量或缺少具体申请类型，无法还原申请类型：需负责人明确所选类型，不得由数量猜测（业务键/类别独立申请，不强制 ECC）`,
        ),
      );
    }
  }
  // QR/Ship-to 申请为独立申请：不因缺少 ECC 产生项目关联错误（目录无 ECC 字段，天然不校验）。
}

/** 目标库覆盖冲突（8.33）：人工目标 / 缺少可信基线 / 目标被修改均阻止覆盖。 */
function validateTargetConflicts(
  plan: NormalizedImportPlan,
  target: TargetConflictReader,
  byRowId: Map<string, NormalizedRow>,
  problems: ImportProblem[],
): void {
  // 项目 + 合同金额。
  for (const project of plan.projects) {
    const contract = target.contractByEcc(project.ecc);
    if (!contract) continue;
    const row = byRowId.get(project.rows[0]?.rowId ?? '') ?? project.rows[0];
    const expectedKey = `contract|${project.ecc}`;
    const checkBaseline = (): void => {
      const baseline = target.baselineFor(`project|${project.ecc}`);
      if (baseline === null) {
        problems.push(
          problem(
            row,
            'TARGET_CONFLICT',
            'contract.usd_tax_amount_cents',
            `项目「${project.ecc}」为目标库迁移记录但缺少可信目标快照基线（import_record_audit），无法安全覆盖`,
            { target: { table: 'projects', targetId: contract.projectId, missingBaseline: true, manualOrForeignSource: false }, businessKey: project.ecc },
          ),
        );
        return;
      }
      const current = target.projectSnapshotHash(contract.projectId);
      if (current !== baseline) {
        problems.push(
          problem(
            row,
            'TARGET_CONFLICT',
            'contract.usd_tax_amount_cents',
            `项目「${project.ecc}」自上次迁移后被人工/外部修改（目标快照不一致，含合同金额），不覆盖`,
            { target: { table: 'projects', targetId: contract.projectId, missingBaseline: false, manualOrForeignSource: false }, businessKey: project.ecc },
          ),
        );
      }
    };
    if (contract.importSourceKey !== expectedKey) {
      problems.push(
        problem(
          row,
          'TARGET_CONFLICT',
          'contract.ecc',
          `项目「${project.ecc}」在目标库已存在人工或其他来源记录，无法安全覆盖`,
          { target: { table: 'contracts', targetId: contract.id, missingBaseline: false, manualOrForeignSource: true }, businessKey: project.ecc },
        ),
      );
    } else {
      checkBaseline();
    }
  }

  // 服务单号：forward-fix 或目标唯一占用冲突。
  for (const order of plan.serviceOrders) {
    if (isEmpty(order.serviceOrderNo)) continue;
    const row = byRowId.get(order.rows[0]?.rowId ?? '') ?? order.rows[0];
    const key = planSourceKey(`so|${order.serviceOrderNo}`, order.rows[0]);
    const existing = target.findRecordBySourceKey('service_orders', key);
    if (existing) {
      checkForwardFixBaseline(
        target,
        row,
        existing.id,
        'service_orders',
        'service_order.service_order_no',
        `开单记录（服务单号 ${order.serviceOrderNo}）`,
        key,
        () => target.serviceOrderSnapshotHash(existing.id),
        problems,
        order.serviceOrderNo,
      );
    } else if (target.hasServiceOrderNo(order.serviceOrderNo)) {
      problems.push(
        problem(
          row,
          'TARGET_CONFLICT',
          'service_order.service_order_no',
          `服务单号「${order.serviceOrderNo}」在目标库已存在人工或其他来源记录，无法安全覆盖`,
          { target: { table: 'service_orders', targetId: null, missingBaseline: false, manualOrForeignSource: true }, businessKey: order.serviceOrderNo },
        ),
      );
    }
  }

  // 掉票：仅同来源键 forward-fix 基线检查。
  for (const invoice of plan.invoices) {
    const row = byRowId.get(invoice.rows[0]?.rowId ?? '') ?? invoice.rows[0];
    const key = planSourceKey(`invoice|${invoice.ecc}`, invoice.rows[0]);
    const existing = target.findRecordBySourceKey('invoices', key);
    if (existing) {
      checkForwardFixBaseline(
        target,
        row,
        existing.id,
        'invoices',
        'invoice.amount_cents',
        `掉票记录（ECC ${invoice.ecc}）`,
        key,
        () => target.invoiceSnapshotHash(existing.id),
        problems,
        invoice.ecc,
      );
    }
  }

  // 物流费用：仅同来源键 forward-fix 基线检查（含批次运输公司）。
  for (const fee of plan.logisticsFees) {
    const row = byRowId.get(fee.rows[0]?.rowId ?? '') ?? fee.rows[0];
    const key = planSourceKey('lf', fee.rows[0]);
    const existing = target.findRecordBySourceKey('logistics_fees', key);
    if (existing) {
      checkForwardFixBaseline(
        target,
        row,
        existing.id,
        'logistics_fees',
        'logistics_fee.transport_company',
        `物流费用记录（ECC ${fee.ecc ?? '-'}）`,
        key,
        () => target.logisticsFeeSnapshotHash(existing.id),
        problems,
        fee.ecc,
      );
    }
  }

  // 序列号地址更新：仅同来源键 forward-fix 基线检查（不创建/修改 Ship-to 主数据）。
  for (const update of plan.serialAddressUpdates) {
    const row = byRowId.get(update.rows[0]?.rowId ?? '') ?? update.rows[0];
    const key = planSourceKey('sau', update.rows[0]);
    const existing = target.findRecordBySourceKey('serial_address_updates', key);
    if (existing) {
      checkForwardFixBaseline(
        target,
        row,
        existing.id,
        'serial_address_updates',
        'serial_address_update.new_site_address',
        `序列号地址更新记录（序列号 ${update.serialNo}）`,
        key,
        () => target.serialAddressUpdateSnapshotHash(existing.id),
        problems,
        update.serialNo,
      );
    }
  }

  // 二维码申请：仅同来源键 forward-fix 基线检查（含申请类型）。
  for (const qr of plan.qrRequests) {
    const row = byRowId.get(qr.rows[0]?.rowId ?? '') ?? qr.rows[0];
    const key = planSourceKey('qr', qr.rows[0]);
    const existing = target.findRecordBySourceKey('qr_requests', key);
    if (existing) {
      checkForwardFixBaseline(
        target,
        row,
        existing.id,
        'qr_requests',
        'qr_request.type_code',
        `二维码申请记录（申请人 ${qr.applicant}）`,
        key,
        () => target.qrRequestSnapshotHash(existing.id),
        problems,
        null,
      );
    }
  }

  // Ship-to 申请：同来源键 forward-fix + Account ID 目标唯一占用冲突。
  for (const req of plan.shipToRequests) {
    const row = byRowId.get(req.rows[0]?.rowId ?? '') ?? req.rows[0];
    const key = planSourceKey('str', req.rows[0]);
    const existing = target.findRecordBySourceKey('ship_to_requests', key);
    if (existing) {
      checkForwardFixBaseline(
        target,
        row,
        existing.id,
        'ship_to_requests',
        'ship_to_request.account_id',
        `Ship-to 申请记录（客户 ${req.customerName}）`,
        key,
        () => target.shipToRequestSnapshotHash(existing.id),
        problems,
        req.accountId,
      );
    } else if (!isEmpty(req.accountId) && target.hasAccountId(req.accountId!)) {
      problems.push(
        problem(
          row,
          'TARGET_CONFLICT',
          'ship_to_request.account_id',
          `Account ID「${req.accountId}」已在目标库 Ship-to 主数据或既有申请中使用，无法安全写入`,
          { target: { table: 'ship_to_requests', targetId: null, missingBaseline: false, manualOrForeignSource: true }, businessKey: req.accountId },
        ),
      );
    }
  }
}

/** forward-fix 基线检查：缺少可信基线或目标被修改 → TARGET_CONFLICT。 */
function checkForwardFixBaseline(
  target: TargetConflictReader,
  row: NormalizedRow,
  targetId: string,
  table: string,
  field: string,
  label: string,
  sourceKey: string,
  currentSnapshot: () => string,
  problems: ImportProblem[],
  businessKey: string | null,
): void {
  const baseline = target.baselineFor(sourceKey);
  if (baseline === null) {
    problems.push(
      problem(
        row,
        'TARGET_CONFLICT',
        field,
        `${label}为目标库迁移记录但缺少可信目标快照基线（import_record_audit），无法安全覆盖`,
        { target: { table, targetId, missingBaseline: true, manualOrForeignSource: false }, businessKey },
      ),
    );
    return;
  }
  const current = currentSnapshot();
  if (current !== baseline) {
    problems.push(
      problem(
        row,
        'TARGET_CONFLICT',
        field,
        `${label}自上次迁移后被人工/外部修改（目标快照不一致），不覆盖`,
        { target: { table, targetId, missingBaseline: false, manualOrForeignSource: false }, businessKey },
      ),
    );
  }
}

/** 类别声明与空导入资格（8.34）。 */
function validateDeclarations(plan: NormalizedImportPlan, declared: ValidationOptions['declared'], problems: ImportProblem[]): void {
  for (const category of IMPORT_CATEGORIES) {
    const d = declared[category];
    if (d === undefined) {
      problems.push({
        code: 'UNDECLARED_CATEGORY',
        severity: 'error',
        category,
        recordKey: null,
        field: null,
        gridRow: null,
        businessKey: null,
        sourcePosition: null,
        message: `类别「${IMPORT_CATEGORY_LABELS[category]}」未声明有数据或本次无数据：任一未声明类别阻止进入最终确认`,
      });
    } else if (d === 'data' && plan.recordCounts[category] === 0) {
      problems.push({
        code: 'DECLARED_DATA_EMPTY',
        severity: 'error',
        category,
        recordKey: null,
        field: null,
        gridRow: null,
        businessKey: null,
        sourcePosition: null,
        message: `类别「${IMPORT_CATEGORY_LABELS[category]}」声明为有数据但规范化记录数为零，请检查输入或改声明本次无数据`,
      });
    } else if (d === 'none' && plan.recordCounts[category] > 0) {
      // Oracle 二次复审 #1：声明本次不导入但该类别存在源行 → 阻断（含先 none 后 paste/file 补行场景）。
      problems.push({
        code: 'DECLARED_NONE_WITH_ROWS',
        severity: 'error',
        category,
        recordKey: null,
        field: null,
        gridRow: null,
        businessKey: null,
        sourcePosition: null,
        message: `类别「${IMPORT_CATEGORY_LABELS[category]}」声明为本次不导入但存在 ${plan.recordCounts[category]} 行源数据，请先删除该类行或改为「有数据」`,
      });
    }
  }
  const total = IMPORT_CATEGORIES.reduce((sum, c) => sum + plan.recordCounts[c], 0);
  if (total === 0) {
    problems.push({
      code: 'EMPTY_IMPORT',
      severity: 'error',
      category: null,
      recordKey: null,
      field: null,
      gridRow: null,
      businessKey: null,
      sourcePosition: null,
      message: '七类数据均确认无数据且规范化记录总数为零：本次没有可导入的历史记录，禁止提交',
    });
  }
}

function computeEligibility(problems: ImportProblem[]): { eligible: boolean; blockingReasons: string[] } {
  const blocking = problems.filter((p) => p.severity === 'error' || p.severity === 'conflict');
  return {
    eligible: blocking.length === 0,
    blockingReasons: [...new Set(blocking.map((p) => p.message))],
  };
}

/** 完整校验（7 类跨表；校验期间只读目标库，零业务写入）。 */
export function validatePlan(rows: readonly NormalizedRow[], options: ValidationOptions): ValidationResult {
  const plan = buildPlanFromRows(rows);
  const byRowId = new Map(rows.map((r) => [r.rowId, r]));
  const problems: ImportProblem[] = [];

  for (const row of rows) validateRowFields(row, problems);
  validateAggregatedProjects(plan, byRowId, problems);
  validateDeclarations(plan, options.declared, problems);

  // ECC 聚合来源冲突（8.29）：候选值 + 来源位置，不自动覆盖。
  for (const sc of plan.sourceConflicts) {
    const row = byRowId.get(sc.recordKeys[0] ?? '') ?? null;
    problems.push({
      code: 'SOURCE_CONFLICT',
      severity: 'conflict',
      category: 'project',
      recordKey: row?.rowId ?? null,
      field: sc.field,
      gridRow: row?.sourceRow ?? null,
      businessKey: sc.ecc,
      sourcePosition: sc.candidates[0]?.sourcePosition ?? null,
      message: `目标字段「${sc.fieldLabel}」（${sc.field}）在多个来源取值不同，不自动覆盖，需负责人选择候选或修正`,
      candidates: sc.candidates,
    });
  }

  // 缺 ECC 的项目源行（无法聚合，报告必填错误）。
  for (const row of plan.orphanProjectRows) {
    problems.push(
      problem(row, 'MISSING_ECC', 'contract.ecc', '项目/合同数据缺少 ECC（聚合主键），补齐前不可提交'),
    );
  }

  validateEccReferences(plan, options.target, byRowId, problems);
  validateCrossClass(plan, options.target, byRowId, problems);
  validateBoundaries(plan, byRowId, problems);
  if (options.target !== undefined) {
    validateTargetConflicts(plan, options.target, byRowId, problems);
  }

  const { eligible, blockingReasons } = computeEligibility(problems);
  return { plan, problems, eligible, blockingReasons };
}

/**
 * 局部重校验（8.34）：只重校验受影响记录与受影响 ECC。
 * 跨类唯一性、目标冲突与金额对账仍在完整校验阶段统一执行（design D23）。
 */
export function validateAffected(
  rows: readonly NormalizedRow[],
  affected: AffectedSelection,
  options: ValidationOptions,
): ImportProblem[] {
  const byRowId = new Map(rows.map((r) => [r.rowId, r]));
  const affectedEccs = new Set(affected.eccs);
  const affectedRowIds = new Set(affected.rowIds);
  const problems: ImportProblem[] = [];

  const touched = rows.filter(
    (r) => affectedRowIds.has(r.rowId) || (r.businessKey !== null && affectedEccs.has(r.businessKey)),
  );
  for (const row of touched) validateRowFields(row, problems);

  // 受影响 ECC 的项目聚合冲突与同项目序列号唯一性。
  const plan = buildPlanFromRows(rows);
  for (const sc of plan.sourceConflicts) {
    if (!affectedEccs.has(sc.ecc)) continue;
    const row = byRowId.get(sc.recordKeys[0] ?? '') ?? null;
    problems.push({
      code: 'SOURCE_CONFLICT',
      severity: 'conflict',
      category: 'project',
      recordKey: row?.rowId ?? null,
      field: sc.field,
      gridRow: row?.sourceRow ?? null,
      businessKey: sc.ecc,
      sourcePosition: sc.candidates[0]?.sourcePosition ?? null,
      message: `目标字段「${sc.fieldLabel}」（${sc.field}）在多个来源取值不同，不自动覆盖，需负责人选择候选或修正`,
      candidates: sc.candidates,
    });
  }
  for (const project of plan.projects) {
    if (!affectedEccs.has(project.ecc)) continue;
    const firstRow = byRowId.get(project.rows[0]?.rowId ?? '') ?? project.rows[0];
    if (isEmpty(project.customerName)) {
      problems.push(
        problem(firstRow, 'MISSING_REQUIRED_FIELD', 'contract.customer_name', '目标字段「客户名称」（contract.customer_name）必填缺失'),
      );
    }
    const seen = new Set<string>();
    for (const inst of project.instruments) {
      if (isEmpty(inst.serialNo)) continue;
      if (seen.has(inst.serialNo!)) {
        const row = byRowId.get(inst.rows[0]?.rowId ?? '') ?? inst.rows[0];
        problems.push(
          problem(
            row,
            'DUPLICATE_SERIAL_IN_PROJECT',
            'instrument.serial_no',
            `序列号「${inst.serialNo}」在项目「${project.ecc}」内重复，违反同项目序列号唯一性`,
          ),
        );
      }
      seen.add(inst.serialNo!);
    }
  }

  // 受影响 ECC 的掉票/物流费用引用校验。
  const planEccs = new Set(plan.projects.map((p) => p.ecc));
  const checkEccRef = (ecc: string | null, row: NormalizedRow, field: string): void => {
    if (isEmpty(ecc)) return;
    if (!planEccs.has(ecc!) && (options.target === undefined || !options.target.hasEcc(ecc!))) {
      problems.push(
        problem(row, 'UNRESOLVED_ECC_REFERENCE', field, `ECC「${ecc}」未在本次计划或目标库中唯一匹配，无法关联搬迁项目`),
      );
    }
  };
  for (const invoice of plan.invoices) {
    if (!affectedEccs.has(invoice.ecc) && !affectedRowIds.has(invoice.rows[0]?.rowId ?? '')) continue;
    checkEccRef(invoice.ecc, byRowId.get(invoice.rows[0]?.rowId ?? '') ?? invoice.rows[0], 'invoice.ecc');
  }
  for (const fee of plan.logisticsFees) {
    if (!affectedEccs.has(fee.ecc ?? '') && !affectedRowIds.has(fee.rows[0]?.rowId ?? '')) continue;
    checkEccRef(fee.ecc, byRowId.get(fee.rows[0]?.rowId ?? '') ?? fee.rows[0], 'logistics_fee.ecc');
  }

  return problems;
}
