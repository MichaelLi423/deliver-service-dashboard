import type { DatabaseSync } from 'node:sqlite';
import { Money, formatCents } from '../domain/core/money';
import { ValidationError } from '../domain/core/errors';
import { SystemClock, assertValidBusinessDate } from '../domain/core/time';
import { CustomerService, ProjectService, isFormallyEntered, type ProjectStatusOrCancelled } from '../domain/capabilities/relocation-project-lifecycle';
import { ExecutionService, type BatchQuoteInput, type WorkType } from '../domain/capabilities/relocation-execution';
import { ServiceOrderService } from '../domain/capabilities/service-order-recording';
import { ReminderService } from '../domain/capabilities/workbench-todos';
import { ShipToService } from '../domain/capabilities/ship-to-management';
import { DamageRepairService, type DamageItemStatus, type PartCurrency, type PartStatus } from '../domain/capabilities/damage-repair-tracking';
import { SerialAddressUpdateService } from '../domain/capabilities/serial-address-update';
import { QrRequestService, type QrRequestTypeCode } from '../domain/capabilities/qr-request-tracking';
import { FinancialClosureService } from '../domain/capabilities/project-financial-closure';
import { ReportingService, type ReportMetricKey, type ReportModel } from '../domain/capabilities/operational-reporting';
import {
  SqliteActivityDamageLinkRepository, SqliteActivityEngineerRepository, SqliteActivityRepository,
  SqliteBatchChangeHistoryRepository, SqliteBatchRepository, SqliteContractAmountReader,
  SqliteContractRepository, SqliteCustomerRepository, SqliteDamageInstrumentReader,
  SqliteDamageRepairItemRepository, SqliteInstrumentAddressReader, SqliteInstrumentRepository,
  SqliteInvoiceReadRepository, SqliteInvoiceRepository, SqliteLogisticsFeeRepository,
  SqliteProjectRepository, SqliteQrRequestRepository, SqliteReminderSettingsRepository,
  SqliteRepairActivityReader, SqliteReportingFactReader, SqliteSerialAddressUpdateRepository,
  SqliteServiceOrderRepository, SqliteShipToAddressReader, SqliteShipToRepository,
  SqliteShipToRequestRepository, SqliteWorkFactRepository,
  WorkbenchReadRepository,
} from '../domain/capabilities/local-data-persistence';
import { readBusinessRevision } from '../domain/capabilities/local-data-persistence/identity';
import type {
  AccountSessionInfo, BatchEditPayload, ProjectUpdatePayload, ProjectWizardPayload, ReportDto, ReportFilterDto, ShipToRequestDto,
  ShipToRequestInputDto, ShipToRequestResultDto, ShipToRequestStatus, WorkbenchActionPayload,
  WorkbenchV2IndependentPageDto, WorkbenchV2IndependentPageRequest, WorkbenchV2InvalidateTag,
  WorkbenchV2LookupPageDto, WorkbenchV2LookupPageRequest, WorkbenchV2MutationRequest,
  WorkbenchV2MutationResult, WorkbenchV2OverviewDto, WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto, WorkbenchV2ProjectPageRequest, WorkbenchV2SectionPageDto,
  WorkbenchV2SectionPageRequest,
} from '../shared/ipc';
import type { ShipToRequest as ShipToRequestRecord } from '../domain/capabilities/ship-to-management/ship-to';

/** IPC 金额边界解析：renderer 提交十进制字符串（如 "1234.56"），主进程按 Money 精确解析为分
 * （HALF_UP、拒绝负数与非法格式，全程不使用二进制浮点）。空/缺失按 0 处理，
 * 是否允许 0 由各领域校验决定（仅合同 USD 含税金额允许 0）。
 */
const parseAmountInput = (value: unknown): bigint => {
  const raw = String(value ?? '').trim();
  if (raw === '') return 0n;
  return Money.parse(raw).cents;
};
const text = (v: unknown): string => String(v ?? '').trim();
const optional = (v: unknown): string | undefined => text(v) || undefined;
/**
 * IPC 业务日期边界：renderer 提交 yyyy-mm-dd（business date），主进程仅校验格式后原样透传，
 * 绝不转换为 ISO（design D30：业务时间仅记录业务日期；审计/技术时间保留精确 ISO）。
 * 空/缺失返回 undefined，由调用方决定 null（清空）或 undefined（未提交）语义。
 */
const businessDate = (v: unknown, fieldName: string): string | undefined => {
  const raw = optional(v);
  if (raw === undefined) return undefined;
  assertValidBusinessDate(raw, fieldName);
  return raw;
};

export class WorkbenchFacade {
  private readonly projects: SqliteProjectRepository;
  private readonly contracts: SqliteContractRepository;
  private readonly instruments: SqliteInstrumentRepository;
  private readonly batches: SqliteBatchRepository;
  private readonly activities: SqliteActivityRepository;
  private readonly workFacts: SqliteWorkFactRepository;
  private readonly fees: SqliteLogisticsFeeRepository;
  private readonly orders: SqliteServiceOrderRepository;
  private readonly invoices: SqliteInvoiceRepository;
  private readonly damageItems: SqliteDamageRepairItemRepository;
  private readonly shipRequests: SqliteShipToRequestRepository;
  private readonly serialUpdates: SqliteSerialAddressUpdateRepository;
  private readonly qrRequests: SqliteQrRequestRepository;

  constructor(
    private readonly db: DatabaseSync,
    private readonly session: () => AccountSessionInfo,
    /** 测试/接线可注入的服务覆盖（事务感知仓储，用于验证原子性）。 */
    private readonly injected?: { shipToService?: ShipToService },
  ) {
    this.projects = new SqliteProjectRepository(db);
    this.contracts = new SqliteContractRepository(db);
    this.instruments = new SqliteInstrumentRepository(db);
    this.batches = new SqliteBatchRepository(db);
    this.activities = new SqliteActivityRepository(db);
    this.workFacts = new SqliteWorkFactRepository(db);
    this.fees = new SqliteLogisticsFeeRepository(db);
    this.orders = new SqliteServiceOrderRepository(db);
    this.invoices = new SqliteInvoiceRepository(db);
    this.damageItems = new SqliteDamageRepairItemRepository(db);
    this.shipRequests = new SqliteShipToRequestRepository(db);
    this.serialUpdates = new SqliteSerialAddressUpdateRepository(db);
    this.qrRequests = new SqliteQrRequestRepository(db);
  }

  // ---------------------------------------------------------------------------
  // Ship-to 申请：按 requestId 线性推进的独立命令（仅返回受影响申请，不携带任何快照）。
  // ---------------------------------------------------------------------------

  /** 创建 Ship-to 申请：同客户同新址已有申请时返回既有记录（不自动 submit、不重复创建）。 */
  createShipToRequest(input: ShipToRequestInputDto): ShipToRequestResultDto {
    const request = this.shipToService().createRequest(input, this.actor());
    return { request: serializeShipToRequest(request) };
  }
  /** 提交既有申请：待提交 → 处理中（记录首次提交时间，计一次工作量）。 */
  submitShipToRequest(requestId: string): ShipToRequestResultDto {
    const request = this.shipToService().submit(requestId, this.actor());
    return { request: serializeShipToRequest(request) };
  }

  // ---------------------------------------------------------------------------
  // Oracle #10：工作台 v2 有界读取（snapshot 已删除，工作台只经 v2 读取）。
  // 全部读取经 WorkbenchReadRepository 的 SQL 有界实现（分页 + 聚合，禁止全量扫描）。
  // ---------------------------------------------------------------------------

  private v2Reader(): WorkbenchReadRepository {
    const reminder = this.reminderService();
    return new WorkbenchReadRepository(this.db, {
      today: new SystemClock().today(),
      windowDays: reminder.getUpcomingWindowDays(),
    });
  }

  v2Overview(): WorkbenchV2OverviewDto {
    return this.v2Reader().overview();
  }

  v2ProjectPage(request: WorkbenchV2ProjectPageRequest): WorkbenchV2ProjectPageDto {
    return this.v2Reader().projectPage(request);
  }

  v2ProjectDetail(projectId: string): WorkbenchV2ProjectDetailDto {
    return this.v2Reader().projectDetail(projectId);
  }

  v2SectionPage(request: WorkbenchV2SectionPageRequest): WorkbenchV2SectionPageDto {
    return this.v2Reader().sectionPage(request);
  }

  v2IndependentPage(request: WorkbenchV2IndependentPageRequest): WorkbenchV2IndependentPageDto {
    return this.v2Reader().independentPage(request);
  }

  v2LookupPage(request: WorkbenchV2LookupPageRequest): WorkbenchV2LookupPageDto {
    return this.v2Reader().lookupPage(request);
  }

  // ---------------------------------------------------------------------------
  // Oracle #10：普通写动作的 v2 有界 mutation 入口。
  // 复用下方 write* 写逻辑（与 v1 完全一致），但绝不调用 snapshot()——
  // 返回 businessRevision + invalidate tags + 受影响的实体引用（bounded）。
  // ---------------------------------------------------------------------------

  v2Mutate(request: WorkbenchV2MutationRequest): WorkbenchV2MutationResult {
    let changed: WorkbenchV2MutationResult['changed'] = null;
    let extraTags: WorkbenchV2InvalidateTag[] = [];
    switch (request.op) {
      case 'create_project': {
        const ref = this.writeCreateProject(request.payload as ProjectWizardPayload);
        changed = { projectId: ref.projectId, created: true };
        break;
      }
      case 'update_project': {
        const update = request.payload as ProjectUpdatePayload;
        const ref = this.writeUpdateProject(update.projectId, update);
        changed = { projectId: ref.projectId };
        if (update.customerName !== undefined) {
          // 客户重关联可能登记新客户，客户 lookup 需要重读。
          extraTags.push('lookup:customers');
        }
        break;
      }
      case 'submit_action': {
        const action = request.action!;
        // 请求顶层 projectId 未写入 action 时补齐（writeSubmitAction 以 payload.projectId 为归属）。
        if (action.projectId === undefined && request.projectId) {
          action.projectId = request.projectId;
        }
        const ref = this.writeSubmitAction(action);
        changed = { projectId: ref.projectId };
        switch (action.type) {
          case 'serial_address':
            extraTags.push('independent:serial_address');
            break;
          case 'qr_request':
            extraTags.push('independent:qr_request');
            break;
          case 'ship_to':
            extraTags.push('lookup:ship_to_requests');
            break;
          default:
            break;
        }
        break;
      }
      case 'set_reminder':
        this.writeSetReminder(request.projectId!, request.reminderAt ?? null, request.reminderNote ?? null);
        changed = { projectId: request.projectId };
        break;
      case 'clear_reminder':
        this.writeClearReminder(request.projectId!);
        changed = { projectId: request.projectId };
        break;
      case 'adjust_status':
        this.writeAdjustStatus(request.projectId!, request.status!);
        changed = { projectId: request.projectId, status: request.status };
        break;
      case 'cancel_project':
        this.writeCancelProject(request.projectId!, request.time!, request.reason!);
        changed = { projectId: request.projectId, status: 'cancelled' };
        break;
      case 'ship_to_complete': {
        const record = this.writeCompleteShipToRequest(request.requestId!, request.accountId!);
        extraTags.push('lookup:ship_to_requests');
        changed = {
          requestId: record.id,
          status: record.status,
          accountId: record.accountId,
        };
        break;
      }
      case 'invoice_edit': {
        const ref = this.writeEditInvoice(request.invoiceId!, request.invoicedAt!, request.amount!);
        changed = { projectId: ref.projectId, invoiceId: ref.invoiceId };
        break;
      }
      case 'invoice_revoke': {
        const ref = this.writeRevokeInvoice(request.invoiceId!, request.time!, request.reason!);
        changed = { projectId: ref.projectId, invoiceId: ref.invoiceId, status: 'revoked' };
        break;
      }
      case 'batch_edit': {
        const edit = request.payload as BatchEditPayload;
        const ref = this.writeEditBatch(edit);
        changed = { projectId: ref.projectId, batchId: ref.batchId };
        break;
      }
      default:
        throw new ValidationError('V2_MUTATION_UNKNOWN', `未知的 v2 mutation 操作: ${String((request as { op?: unknown }).op)}`);
    }
    const tags: WorkbenchV2InvalidateTag[] = ['overview', 'projects'];
    if (changed?.projectId) {
      tags.push(`project:${changed.projectId}`, `sections:${changed.projectId}`);
    }
    tags.push(...extraTags);
    return {
      businessRevision: readBusinessRevision(this.db),
      invalidated: [...new Set(tags)],
      changed,
    };
  }

  // ---------------------------------------------------------------------------
  // Oracle #10：写逻辑抽取（v1 snapshot 与 v2 mutation 共用，v2 路径不调用 snapshot()）。
  // 旧 API 仅为 UI 迁移暂留，后续随旧 UI 一并删除。
  // ---------------------------------------------------------------------------

  private writeCreateProject(input: ProjectWizardPayload): { projectId: string } {
    let projectId = '';
    this.transaction(() => {
      const actor = this.actor();
      const projectService = this.projectService();
      const customerRepo = new SqliteCustomerRepository(this.db);
      const customer = customerRepo.findByName(input.customerName.trim()) ?? new CustomerService(customerRepo).register(input.customerName);
      const project = projectService.createPendingProject();
      projectId = project.id;
      projectService.linkCustomer(project.id, customer.id);
      projectService.setRegion(project.id, input.region);
      projectService.updateBasicInfo(project.id, { oldSiteContact: input.oldSiteContact, newSiteContact: input.newSiteContact, oldSiteAddress: input.oldSiteAddress, newSiteAddress: input.newSiteAddress, contractStartDate: input.contractStartDate, contractEndDate: input.contractEndDate });
      projectService.updateExecutionPreparation(project.id, {
        planVisitAt: input.planVisitAt ? businessDate(input.planVisitAt, '计划上门日期') ?? null : null,
        planTransportAt: input.planTransportAt ? businessDate(input.planTransportAt, '计划运输日期') ?? null : null,
        siteConfirmed: input.siteConfirmed,
      });
      const execution = this.executionService();
      execution.registerInstrument(project.id, { name:input.instrumentName, model:input.model, ups:input.ups, qrRequested:false }, actor);
      projectService.confirmScope(project.id);
      // ECC 是是否正式进单的唯一依据：携带非空 ECC 一律按正式进单落库（与 intent 无关），
      // 此时必须补建合同（正式进单前置校验要求）。
      const ecc = text(input.ecc);
      if ((input.contractAmount ?? '') !== '' || input.intent === 'formal' || ecc !== '') {
        projectService.attachContract(project.id);
        this.financialService().setContractUsdTaxAmount(project.id, parseAmountInput(input.contractAmount));
      }
      if (input.serviceOrderNo) {
        if (!input.engineers?.trim()) throw new Error('填写服务单号时参与工程师必填；项目与开单均未保存');
        new ServiceOrderService(this.orders, this.projects).recordOrder({ orderType:'relocation', serviceOrderNo:input.serviceOrderNo, engineer:input.engineers, customerName:input.customerName, projectId:project.id, note:input.serviceOrderNote }, actor);
      }
      // 保存路径（intent 仅约束无 ECC 场景）：
      // - 有非空 ECC：必须正式进单（entryAt 有值、formallyEntered=true），并把主状态推进为
      //   待执行（不得仍为待进单）；即使 intent=pre_entry_execution 也不保留未进单先执行标签；
      // - 无 ECC：只允许 intent=pre_entry_execution（经理批复原因必填，沿用既有校验），结果
      //   status=pending_entry、preEntryExecution=true、formallyEntered=false；
      // - intent=formal 无 ECC：继续报 ECC_REQUIRED；
      // - intent=draft（或缺失）无 ECC：安全明确错误，不静默创建待进单项目。
      if (ecc !== '') {
        projectService.formalEntry(project.id, { ecc, entryAt: businessDate(input.entryAt, '进单日期'), finalConfirmableAmountCents: (input.finalAmount ?? '') === '' ? undefined : parseAmountInput(input.finalAmount) });
        const advanced = projectService.adjustStatus(project.id, 'pending_execution');
        if (!advanced.ok) throw new Error(advanced.errors.join('；'));
      } else if (input.intent === 'formal') {
        projectService.formalEntry(project.id, { ecc: '', entryAt: businessDate(input.entryAt, '进单日期'), finalConfirmableAmountCents: (input.finalAmount ?? '') === '' ? undefined : parseAmountInput(input.finalAmount) });
      } else if (input.intent === 'pre_entry_execution') {
        projectService.setPreEntryExecution(project.id, { reason: input.approvalReason ?? '', missingItems: input.missingItems ?? '' });
      } else {
        throw new ValidationError('DRAFT_NOT_ALLOWED', '普通草稿创建已停用：无 ECC 的项目请选择「未进单先执行」并填写经理批复原因');
      }
      if (input.actualInstallDoneAt) projectService.recordActualInstallDone(project.id, businessDate(input.actualInstallDoneAt, '实际装机完成日期') ?? '');
    });
    return { projectId };
  }

  /**
   * 更新项目资料（v2 update_project）：同一事务内复用现有领域命令原子落库。
   * - 普通资料（客户重关联/区域/联系人/地址/合同起止/计划上门运输/现场确认）任何状态可更新；
   * - ECC / 进单时间 / 合同金额 / 最终可确认金额更正仅允许已正式进单项目（待进单项目必须走
   *   core/formalEntry 语义，update_project 不绕过正式进单校验，避免绕过财务闭环）；
   * - 已取消项目禁止任何资料更新（终态）；
   * - 三态输入：undefined=未提交、null=显式清空（仅可空字段；ECC/进单时间 null 视为未提交，
   *   金额 null 解析为 0 交由领域校验决定是否接受）、有值=覆盖；布尔显式传 false。
   */
  private writeUpdateProject(projectId: string, update: ProjectUpdatePayload): { projectId: string } {
    this.transaction(() => {
      const projectService = this.projectService();
      const project = this.projects.findById(projectId);
      if (!project) {
        throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
      }
      if (project.status === 'cancelled') {
        throw new ValidationError('CANCELLED_PROJECT', '已取消项目禁止修改项目资料');
      }
      const formallyEntered = isFormallyEntered(project);

      // 客户重关联：按去除首尾空白后的名称全局唯一匹配，不存在则登记新客户并关联。
      if (update.customerName !== undefined) {
        const name = update.customerName.trim();
        if (name === '') {
          throw new ValidationError('CUSTOMER_NAME_REQUIRED', '客户名称必填');
        }
        const customerRepo = new SqliteCustomerRepository(this.db);
        const customer = customerRepo.findByName(name) ?? new CustomerService(customerRepo).register(name);
        projectService.linkCustomer(projectId, customer.id);
      }

      // 基础字段与合同起止日期（缺省取现值合并；截止不得早于开始由领域校验）。
      // 字段名兼容：renderer 新契约使用 contractStartDate/contractEndDate，旧名 contractStartAt/
      // contractEndAt 继续接受（保留既有调用方）。
      const contractStartDate = update.contractStartDate !== undefined
        ? update.contractStartDate
        : (update as ProjectUpdatePayload & { contractStartAt?: string | null }).contractStartAt;
      const contractEndDate = update.contractEndDate !== undefined
        ? update.contractEndDate
        : (update as ProjectUpdatePayload & { contractEndAt?: string | null }).contractEndAt;
      if (
        update.oldSiteContact !== undefined || update.newSiteContact !== undefined ||
        update.oldSiteAddress !== undefined || update.newSiteAddress !== undefined ||
        contractStartDate !== undefined || contractEndDate !== undefined
      ) {
        const current = this.projects.findById(projectId)!;
        projectService.updateBasicInfo(projectId, {
          oldSiteContact: update.oldSiteContact !== undefined ? update.oldSiteContact : current.oldSiteContact,
          newSiteContact: update.newSiteContact !== undefined ? update.newSiteContact : current.newSiteContact,
          oldSiteAddress: update.oldSiteAddress !== undefined ? update.oldSiteAddress : current.oldSiteAddress,
          newSiteAddress: update.newSiteAddress !== undefined ? update.newSiteAddress : current.newSiteAddress,
          contractStartDate: contractStartDate ?? current.contractStartDate ?? '',
          contractEndDate: contractEndDate ?? current.contractEndDate ?? '',
        });
      }

      if (update.region !== undefined) projectService.setRegion(projectId, update.region);

      // 执行准备：计划上门/运输日期（null=清空，业务日期 yyyy-mm-dd）与现场确认（显式 false=清除）。
      if (update.plannedVisitAt !== undefined || update.plannedTransportAt !== undefined || update.siteConfirmed !== undefined) {
        projectService.updateExecutionPreparation(projectId, {
          planVisitAt: update.plannedVisitAt === undefined ? undefined : update.plannedVisitAt === null ? null : businessDate(update.plannedVisitAt, '计划上门日期'),
          planTransportAt: update.plannedTransportAt === undefined ? undefined : update.plannedTransportAt === null ? null : businessDate(update.plannedTransportAt, '计划运输日期'),
          siteConfirmed: update.siteConfirmed,
        });
      }

      // 以下更正仅允许已正式进单项目；待进单项目必须走 core/formalEntry 语义。
      // 进单日期字段名兼容：新契约 entryAt，旧名 enteredAt 继续接受。
      const entryAt = update.entryAt !== undefined
        ? update.entryAt
        : (update as ProjectUpdatePayload & { enteredAt?: string | null }).enteredAt;
      if (
        !formallyEntered &&
        (update.ecc !== undefined || entryAt !== undefined || update.contractUsdTaxAmount !== undefined || update.finalConfirmableAmount !== undefined)
      ) {
        throw new ValidationError(
          'UPDATE_REQUIRES_FORMAL_ENTRY',
          'ECC、进单日期、合同金额与最终可确认金额更正仅允许已正式进单项目；待进单项目请使用正式进单/补齐核心资料',
        );
      }

      // ECC/进单日期为必填业务字段，null 视为未提交（不可清空）。
      if (update.ecc != null) projectService.updateEcc(projectId, update.ecc);
      if (entryAt != null && entryAt !== '') projectService.setEntryAt(projectId, businessDate(entryAt, '进单日期') ?? '');
      // 合同金额允许 0、拒绝负数（领域 5.1）；最终可确认金额必须 > 0 且不低于累计有效掉票（领域 5.4），
      // 空串/null 解析为 0，由领域校验拒绝非法清空。
      if (update.contractUsdTaxAmount !== undefined) this.financialService().setContractUsdTaxAmount(projectId, parseAmountInput(update.contractUsdTaxAmount));
      if (update.finalConfirmableAmount !== undefined) this.financialService().setFinalConfirmableAmount(projectId, parseAmountInput(update.finalConfirmableAmount));
    });
    return { projectId };
  }

  private writeSubmitAction(payload: WorkbenchActionPayload): { projectId?: string } {
    const v = payload.values; const actor = this.actor(); const projectId = payload.projectId ?? '';
    // 二维码仓储自身以事务原子保存申请与多选类型，避免外层重复开启事务。
    if (payload.type === 'qr_request') {
      new QrRequestService(this.qrRequests).createRequest({
        applicant: text(v.applicant),
        requestedAt: businessDate(v.requestedAt, '申请日期') ?? '',
        types: (Array.isArray(v.types) ? v.types : []) as QrRequestTypeCode[],
      }, actor);
      return {};
    }
    this.transaction(() => {
      switch (payload.type) {
        case 'batch': {
          // 快速记录搬迁批次：同一事务原子创建批次与其唯一一笔物流费用（每批次仅一笔）。
          // 仅两个价格口径——budgetPrice=合同预算价 → batch.originalPriceCents + fee.budgetPriceCents；
          // dealPrice=物流成交价 → batch.discountedPriceCents + fee.dealPriceCents +
          // fee.logisticsCostCents（物流成交价即最终实际费用）。
          // planTransportDate/appliedAt/budgetPrice/dealPrice 必填，transportCompany 可选。
          const execution = this.executionService();
          const planTransportDate = optional(v.planTransportDate) ?? null;
          if (planTransportDate === null) {
            throw new ValidationError('BATCH_PLAN_TRANSPORT_DATE_REQUIRED', '快速记录搬迁批次：计划运输日期必填');
          }
          const appliedAt = businessDate(v.appliedAt, '物流费用申请（登记）日期');
          if (appliedAt === undefined) {
            throw new ValidationError('LOGISTICS_APPLIED_AT_REQUIRED', '快速记录搬迁批次：物流费用申请（登记）日期必填');
          }
          const budgetPriceCents = parseAmountInput(v.budgetPrice);
          const dealPriceCents = parseAmountInput(v.dealPrice);
          if (budgetPriceCents <= 0n) {
            throw new ValidationError('LOGISTICS_BUDGET_PRICE_REQUIRED', '快速记录搬迁批次：合同预算价必填且必须大于 0');
          }
          if (dealPriceCents <= 0n) {
            throw new ValidationError('LOGISTICS_DEAL_PRICE_REQUIRED', '快速记录搬迁批次：物流成交价必填且必须大于 0');
          }
          const batch = execution.createBatch(projectId, actor);
          execution.updateBatchQuote(batch.id, {
            planTransportDate,
            transportCompany: optional(v.transportCompany) ?? null,
            originalPriceCents: budgetPriceCents,
            discountedPriceCents: dealPriceCents,
          }, actor);
          execution.recordLogisticsFee(batch.id, {
            appliedAt,
            budgetPriceCents,
            dealPriceCents,
            logisticsCostCents: dealPriceCents,
          }, actor);
          break;
        }
        case 'instrument': this.executionService().registerInstrument(projectId,{name:text(v.name),model:optional(v.model),serialNo:optional(v.serialNo),batchId:optional(v.batchId),ups:Boolean(v.ups),qrRequested:Boolean(v.qrRequested)},actor); break;
        case 'visit': { const e=text(v.engineers).split(/[、,，]/).filter(Boolean); const a=this.executionService().createActivity(projectId,businessDate(v.visitAt,'到访日期')??null,e,actor); const ids=Array.isArray(v.instrumentIds)?v.instrumentIds.map(String):[text(v.instrumentId)].filter(Boolean); const types=Array.isArray(v.workTypes)?v.workTypes as WorkType[]:[text(v.workType) as WorkType]; for(const id of ids) for(const type of types){this.executionService().startWorkFact(a.id,id,type,actor); if(v.status==='done')this.executionService().completeWorkFact(a.id,id,type,actor);} break; }
        case 'order': new ServiceOrderService(this.orders,this.projects).recordOrder({orderType:text(v.orderType) as 'relocation'|'certification'|'parts_by_mail'|'pm',serviceOrderNo:text(v.serviceOrderNo),orderedAt:businessDate(v.orderedAt,'开单日期') ?? '',engineer:text(v.engineer),customerName:text(v.customerName),projectId:text(v.orderType)==='relocation'?projectId:null,note:optional(v.note)},actor); break;
        case 'logistics': this.executionService().recordLogisticsFee(text(v.batchId),{appliedAt:businessDate(v.appliedAt,'物流费用申请（登记）日期') ?? '',budgetPriceCents:parseAmountInput(v.budgetPrice),dealPriceCents:parseAmountInput(v.dealPrice),logisticsCostCents:parseAmountInput(v.logisticsCost)},actor); break;
        case 'acceptance': this.projectService().markAcceptance(projectId,text(v.reportDate)); break;
        case 'invoice': this.financialService().recordInvoice(projectId,{invoicedAt:businessDate(v.invoicedAt,'掉票日期') ?? '',amountCents:parseAmountInput(v.amount)},actor); break;
        case 'ship_to': {
          const service=this.shipToService();
          const request=service.createRequest({customerName:text(v.customerName),newSiteAddress:text(v.newSiteAddress)},actor);
          const target=text(v.status) as ShipToRequestStatus;
          // 幂等组合推进（以持久化后的最新状态为准，不依赖本地陈旧对象）：
          // pending 才 submit；processing 只允许 complete（需 Account ID）；completed 只返回不回退。
          if(request.status==='pending_submit'&&target==='processing') service.submit(request.id,actor);
          if(request.status==='pending_submit'&&target==='completed'){ service.submit(request.id,actor); service.complete(request.id,text(v.accountId),actor); }
          if(request.status==='processing'&&target==='completed') service.complete(request.id,text(v.accountId),actor);
          break;
        }
        case 'damage': { const service=this.damageService(); const item=service.registerItem(text(v.instrumentId),{damageReason:optional(v.damageReason),partNumber:text(v.partNumber),partQuantity:Number(v.partQuantity),partAmountCents:parseAmountInput(v.partAmount),partCurrency:text(v.partCurrency) as PartCurrency,partRequestedAt:businessDate(v.partRequestedAt,'备件申请日期') ?? null,partStatus:text(v.partStatus) as PartStatus,repairNote:optional(v.repairNote),registeredAt:businessDate(v.registeredAt,'事项登记日期') ?? ''},actor); const status=text(v.issueStatus) as DamageItemStatus; if(status&&status!=='untreated')service.updateIssueStatus(item.id,status,optional(v.closeReason)??null,actor); if(v.partStatus==='used')service.setPartStatus(item.id,'used',actor); break; }
        case 'core': { const ps=this.projectService(); if(!this.contracts.findByProjectId(projectId)) ps.attachContract(projectId); this.financialService().setContractUsdTaxAmount(projectId,parseAmountInput(v.contractAmount)); ps.formalEntry(projectId,{ecc:text(v.ecc),entryAt:businessDate(v.entryAt,'进单日期') ?? '',finalConfirmableAmountCents:optional(v.finalAmount)?parseAmountInput(v.finalAmount):undefined}); break; }
        case 'serial_address': new SerialAddressUpdateService(this.serialUpdates,new SqliteInstrumentAddressReader(this.db)).register(text(v.instrumentId),{customerName:text(v.customerName),newSiteAddress:text(v.newSiteAddress),serialNo:text(v.serialNo),accountId:text(v.accountId),updatedAt:businessDate(v.updatedAt,'更新日期') ?? ''},actor); break;
        case 'qr_request': break;
      }
    });
    return projectId ? { projectId } : {};
  }

  private writeSetReminder(projectId: string, at: string | null, note: string | null): void {
    this.reminderService().setReminder(projectId, { at: at ? businessDate(at, '提醒日期') ?? null : null, note }, this.actor());
  }

  private writeClearReminder(projectId: string): void {
    this.reminderService().clearReminder(projectId, this.actor());
  }

  private writeAdjustStatus(projectId: string, status: ProjectStatusOrCancelled): void {
    if (status === 'cancelled') {
      throw new ValidationError('CANCEL_VIA_COMMAND', '取消项目请使用 cancelProject 命令（须填写取消时间与原因）');
    }
    const result = this.projectService().adjustStatus(projectId, status);
    if (!result.ok) throw new Error(result.errors.join('；'));
  }

  private writeCancelProject(projectId: string, time: string, reason: string): void {
    this.transaction(() => {
      this.projectService().cancelProject(projectId, { time: businessDate(time, '取消日期') ?? '', reason });
    });
  }

  private writeCompleteShipToRequest(requestId: string, accountId: string): ShipToRequestRecord {
    let request: ShipToRequestRecord | null = null;
    this.transaction(() => {
      request = this.shipToService().complete(requestId, accountId, this.actor());
    });
    return request!;
  }

  /**
   * 编辑搬迁批次（v2 batch_edit，同一事务内原子落库）：
   * - 计划运输日期/运输公司写批次；
   * - 合同预算价 → batch.originalPriceCents + fee.budgetPriceCents；
   * - 物流成交价 → batch.discountedPriceCents + fee.dealPriceCents + fee.logisticsCostCents
   *   （物流成交价即最终实际费用，updateLogisticsFee 时同时覆盖实际费用口径）。
   * - 不允许修改 appliedAt：契约不含该字段，updateLogisticsFee 亦不更新申请（登记）时间，
   *   编辑前后归属月份不变。
   * - 历史批次无 fee 时编辑价格明确报错（不虚构申请时间创建费用）；仅批次字段仍可编辑。
   */
  private writeEditBatch(edit: BatchEditPayload): { projectId: string; batchId: string } {
    let projectId = '';
    this.transaction(() => {
      const execution = this.executionService();
      const actor = this.actor();
      const batch = this.batches.findById(edit.batchId);
      if (!batch) {
        throw new ValidationError('BATCH_NOT_FOUND', `搬迁批次不存在: ${edit.batchId}`);
      }
      projectId = batch.projectId;
      const quote: BatchQuoteInput = {};
      if (edit.planTransportDate !== undefined) {
        const raw = text(edit.planTransportDate);
        quote.planTransportDate = raw === '' ? null : raw;
      }
      if (edit.transportCompany !== undefined) {
        quote.transportCompany = edit.transportCompany === null ? null : text(edit.transportCompany);
      }
      if (edit.budgetPrice !== undefined || edit.dealPrice !== undefined) {
        const fee = this.fees.findByBatchId(batch.id);
        if (!fee) {
          throw new ValidationError(
            'BATCH_EDIT_REQUIRES_FEE',
            '该批次尚无实际物流费用记录，无法编辑合同预算价/物流成交价；历史批次请先补录物流费用（编辑契约不虚构申请时间）',
          );
        }
        const budgetPriceCents = edit.budgetPrice !== undefined ? parseAmountInput(edit.budgetPrice) : fee.budgetPriceCents;
        const dealPriceCents = edit.dealPrice !== undefined ? parseAmountInput(edit.dealPrice) : fee.dealPriceCents;
        quote.originalPriceCents = budgetPriceCents;
        quote.discountedPriceCents = dealPriceCents;
        execution.updateLogisticsFee(fee.id, {
          budgetPriceCents,
          dealPriceCents,
          logisticsCostCents: dealPriceCents,
        }, actor);
      }
      execution.updateBatchQuote(batch.id, quote, actor);
    });
    return { projectId, batchId: edit.batchId };
  }

  private writeEditInvoice(invoiceId: string, invoicedAt: string, amount: string): { invoiceId: string; projectId: string } {
    let projectId = '';
    this.transaction(() => {
      const invoice = this.financialService().editInvoice(invoiceId, { invoicedAt: businessDate(invoicedAt, '掉票日期') ?? '', amountCents: parseAmountInput(amount) }, this.actor());
      projectId = invoice.projectId;
    });
    return { invoiceId, projectId };
  }

  private writeRevokeInvoice(invoiceId: string, revokedAt: string, reason: string): { invoiceId: string; projectId: string } {
    let projectId = '';
    this.transaction(() => {
      const invoice = this.financialService().revokeInvoice(invoiceId, { revokedAt: businessDate(revokedAt, '撤销日期') ?? '', revokeReason: reason }, this.actor());
      projectId = invoice.projectId;
    });
    return { invoiceId, projectId };
  }

  report(filter:ReportFilterDto):ReportModel { return new ReportingService(new SqliteReportingFactReader(this.db)).buildReport(filter); }
  reportDto(filter:ReportFilterDto):ReportDto { return serializeReport(this.report(filter)); }
  drillDown(metric:string,filter:ReportFilterDto):Array<Record<string,string|number|boolean|null>> { return serializeRows(new ReportingService(new SqliteReportingFactReader(this.db)).getMetricDetails(metric as ReportMetricKey,filter)); }

  private actor(){const s=this.session();return{accountId:s.accountId,username:s.username};}
  private projectService(){return new ProjectService(this.projects,this.contracts,new SqliteInvoiceReadRepository(this.db));}
  private reminderService(){return new ReminderService(this.projects,new SqliteReminderSettingsRepository(this.db));}
  private executionService(){return new ExecutionService(this.batches,this.instruments,new SqliteBatchChangeHistoryRepository(this.db),this.activities,new SqliteActivityEngineerRepository(this.db),this.workFacts,this.fees,{onExecutionStarted:(id)=>{this.projectService().adjustStatus(id,'executing',{executionStarted:true});}});}
  private financialService(){return new FinancialClosureService(this.projects,this.contracts,this.invoices,{reevaluateStatus:(id)=>{this.projectService().adjustStatus(id,this.projects.findById(id)?.status??'pending_entry');}});}
  private shipToService(){return this.injected?.shipToService ?? new ShipToService(new SqliteShipToRepository(this.db),this.shipRequests,new SqliteShipToAddressReader(this.db));}
  private damageService(){return new DamageRepairService(this.damageItems,new SqliteActivityDamageLinkRepository(this.db),new SqliteDamageInstrumentReader(this.db),new SqliteRepairActivityReader(this.db),new SqliteContractAmountReader(this.db));}
  private transaction(work:()=>void){this.db.exec('BEGIN');try{work();this.db.exec('COMMIT');}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}}
}

/**
 * ReportModel → IPC DTO 的显式序列化器：递归把所有 bigint 转换为十进制字符串，
 * 禁止依赖 structured clone 直接传 bigint、也不允许 Number(bigint) 精度退化；
 * 计数/百分比保持 number。导出仍消费领域 ReportModel（内部 BigInt），不受此序列化影响。
 */
function deepSerialize(value: unknown): unknown {
  if (typeof value === 'bigint') return formatCents(value);
  if (Array.isArray(value)) return value.map(deepSerialize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepSerialize(v)]),
    );
  }
  return value;
}
function serializeRows(rows: unknown[]): Array<Record<string,string|number|boolean|null>> {
  return rows.map((row) => deepSerialize(row) as Record<string,string|number|boolean|null>);
}
function serializeShipToRequest(r:ShipToRequestRecord):ShipToRequestDto {
  return {id:r.id,customerName:r.customerName,newSiteAddress:r.newSiteAddress,accountId:r.accountId,status:r.status,submittedAt:r.submittedAt,completedAt:r.completedAt};
}
function serializeReport(report:ReportModel):ReportDto {
  const section=(key:string,label:string,rows:unknown[])=>({key,label,rows:serializeRows(rows)});
  return {range:report.range,filters:report.filters,generatedAt:report.generatedAt,sections:[section('project_pipeline','项目管道',report.pipeline),section('entry_amount_by_region','各区域新项目进单金额',report.entryAmountByRegion),section('monthly_invoice_amount','月度掉票',report.monthlyInvoices),section('monthly_service_order_count','月度开单量',report.monthlyServiceOrders),section('damage_repair_stats','损坏维修统计',report.damageSummary),section('monthly_logistics','月度物流费用',report.monthlyLogistics),section('ship_to_request_workload','Ship-to 申请工作量',report.shipToWorkload),section('qr_request_workload','二维码申请工作量',report.qrWorkload),section('serial_address_update_count','序列号地址更新记录数',report.serialAddressUpdates)]};
}
