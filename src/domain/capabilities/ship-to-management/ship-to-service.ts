import { UniquenessError, ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import { SystemClock, toMonthKey, type BusinessDate, type Clock } from '../../core/time';
import type {
  ShipTo,
  ShipToRequest,
  ShipToRequestInput,
  ShipToRequestWorkloadRow,
} from './ship-to';
import type {
  ShipToAddressReader,
  ShipToRepository,
  ShipToRequestRepository,
} from './ship-to-repositories';

/**
 * ship-to-management 领域服务（tasks 4.1~4.2）。
 *
 * - Ship-to 为不可变主数据：创建后禁止修改，Account ID 全局唯一，引用保持稳定。
 * - Ship-to 申请只记录客户名称与新址地址，不关联搬迁仪器、不保存地址快照；
 *   状态线性流转（待提交→处理中→已完成），不支持退回或取消。
 * - 首次实际提交计一次工作量；待提交草稿不计，后续状态更新不重复计数。
 * - 目的地址变化时重新申请新 Ship-to，不更新或覆盖原记录。
 * - 批次与项目仅汇总展示所涉 Ship-to；申请未完成不阻塞搬迁项目任何状态流转。
 *
 * 所有手工记录绑定当前登录账号归属快照（design D12）。
 */
export class ShipToService {
  constructor(
    private readonly shipTos: ShipToRepository,
    private readonly requests: ShipToRequestRepository,
    private readonly reader: ShipToAddressReader,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  // ---- Ship-to 不可变主数据 ----

  /**
   * 创建不可变 Ship-to（由申请补入 Account ID 完成时创建）。
   * Account ID 全局唯一：与已有 Ship-to 或已完成申请重复时拒绝创建。
   * exceptRequestId 用于申请完成场景：当前申请即将写入同一 Account ID。
   * originRequestId 为产生该 Ship-to 的申请（5.4：完成申请时回填来源；
   * 系统外/legacy 直接创建时为 null，不猜测）。
   * 本模块不提供任何 Ship-to 修改方法：创建后不可修改，目的地址变化重新申请。
   */
  createShipTo(
    accountId: string,
    customerName: string,
    newSiteAddress: string,
    exceptRequestId?: string,
    originRequestId?: string | null,
  ): ShipTo {
    const acc = assertRequiredText(accountId, 'Account ID');
    this.assertAccountIdUnique(acc, exceptRequestId);
    const shipTo: ShipTo = {
      id: newInternalId(),
      accountId: acc,
      customerName,
      newSiteAddress,
      createdAt: this.now(),
      originRequestId: originRequestId === undefined ? null : originRequestId,
    };
    this.shipTos.save(shipTo);
    return shipTo;
  }

  /** Account ID 全局唯一：不得与已有 Ship-to 或已完成申请的 Account ID 重复。 */
  assertAccountIdUnique(accountId: string, exceptRequestId?: string): void {
    if (this.shipTos.findByAccountId(accountId)) {
      throw new UniquenessError('ACCOUNT_ID_UNIQUE', `Account ID「${accountId}」已存在`);
    }
    const existing = this.requests.findByAccountId(accountId);
    if (existing && existing.id !== exceptRequestId) {
      throw new UniquenessError('ACCOUNT_ID_UNIQUE', `Account ID「${accountId}」已存在`);
    }
  }

  // ---- Ship-to 申请 ----

  /**
   * 创建 Ship-to 申请：仅记录客户名称与新址地址，不关联搬迁仪器、不保存地址快照；
   * 同一客户同一新址地址一条申请，客户或新址不同分别创建。
   * 客户名称与新址地址去除首尾空白后保存；同客户同新址在任一状态（待提交/处理中/
   * 已完成）已存在申请时返回既有申请、不重复创建（spec「同客户同新址只创建一条申请」）。
   */
  createRequest(input: ShipToRequestInput, actor: ActorSnapshot): ShipToRequest {
    const customerName = assertRequiredText(input.customerName, '客户名称');
    const newSiteAddress = assertRequiredText(input.newSiteAddress, '新址地址');
    const existing = this.requests.findByCustomerAndAddress(customerName, newSiteAddress);
    if (existing) {
      return existing;
    }
    const now = this.now();
    const request: ShipToRequest = {
      id: newInternalId(),
      customerName,
      newSiteAddress,
      accountId: null, // 创建时 Account ID 可空
      status: 'pending_submit',
      submittedAt: null,
      completedAt: null,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.requests.save(request);
    return request;
  }

  /**
   * 首次实际提交：待提交 → 处理中，记录提交时间（计一次工作量）。
   * 不支持退回或取消；待提交草稿不计工作量。
   */
  submit(requestId: string, actor: ActorSnapshot): ShipToRequest {
    const request = this.requireRequest(requestId);
    if (request.status !== 'pending_submit') {
      throw new ValidationError(
        'SHIP_TO_REQUEST_NOT_SUBMITTABLE',
        request.status === 'completed'
          ? '已完成申请不可再次提交'
          : '申请已提交（处理中），状态线性流转不可退回',
      );
    }
    request.status = 'processing';
    request.submittedAt = request.submittedAt ?? this.today(); // 首次提交日期，之后不再改写
    this.touch(request, actor);
    this.requests.save(request);
    return request;
  }

  /**
   * 补入系统外返回的 Account ID 并进入已完成：处理中 → 已完成。
   * - 补入前申请处于处理中（线性流转，不可跳过提交）。
   * - Account ID 必填且全局唯一（不得与已有 Ship-to 或申请重复）。
   * - 补入的 Account ID 创建/对应不可变的 Ship-to。
   */
  complete(requestId: string, accountId: string, actor: ActorSnapshot): ShipToRequest {
    const request = this.requireRequest(requestId);
    if (request.status !== 'processing') {
      throw new ValidationError(
        'SHIP_TO_REQUEST_NOT_COMPLETABLE',
        '仅处理中的申请可补入 Account ID 进入已完成（线性流转）',
      );
    }
    const acc = assertRequiredText(accountId, 'Account ID');
    this.assertAccountIdUnique(acc, request.id);
    request.accountId = acc;
    request.status = 'completed';
    request.completedAt = this.today();
    this.touch(request, actor);
    this.requests.save(request);
    // 补入的 Account ID 创建/对应不可变 Ship-to；回填来源申请（5.4：删除策略
    // 凭 ship_tos.origin_request_id 证明该 Ship-to 仅由本申请产生）。
    this.createShipTo(acc, request.customerName, request.newSiteAddress, request.id, request.id);
    return request;
  }

  listRequests(): ShipToRequest[] {
    return this.requests.listAll();
  }

  listShipTos(): ShipTo[] {
    return this.shipTos.listAll();
  }

  /** 首次实际提交工作量：按提交日期所属月份归属，待提交草稿不计。 */
  countWorkloadByMonth(): ShipToRequestWorkloadRow[] {
    const counts = new Map<string, number>();
    for (const request of this.requests.listAll()) {
      if (request.submittedAt === null) continue; // 从未实际提交的草稿不计
      const month = toMonthKey(request.submittedAt);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return [...counts.entries()].map(([month, count]) => ({ month, count }));
  }

  // ---- 批次与项目仅汇总展示所涉 Ship-to ----

  /** 某批次仅汇总展示所涉 Ship-to（不为批次维护独立唯一地址）。 */
  listShipTosForBatch(batchId: string): ShipTo[] {
    return this.listShipTosForInstruments(this.reader.listInstrumentIdsByBatch(batchId));
  }

  /** 某搬迁项目仅汇总展示所涉 Ship-to（不为项目维护独立唯一地址）。 */
  listShipTosForProject(projectId: string): ShipTo[] {
    return this.listShipTosForInstruments(this.reader.listInstrumentIdsByProject(projectId));
  }

  private listShipTosForInstruments(instrumentIds: string[]): ShipTo[] {
    if (instrumentIds.length === 0) return [];
    const shipToIds = this.reader.listDestinationShipToIds(instrumentIds);
    const result: ShipTo[] = [];
    for (const id of shipToIds) {
      const shipTo = this.shipTos.findById(id);
      if (shipTo && !result.some((s) => s.id === shipTo.id)) {
        result.push(shipTo);
      }
    }
    return result;
  }

  // ---- 内部辅助 ----

  private requireRequest(requestId: string): ShipToRequest {
    const request = this.requests.findById(requestId);
    if (!request) {
      throw new ValidationError('SHIP_TO_REQUEST_NOT_FOUND', `Ship-to 申请不存在: ${requestId}`);
    }
    return request;
  }

  private touch(request: ShipToRequest, actor: ActorSnapshot): void {
    request.operatorAccountId = actor.accountId;
    request.operatorUsername = actor.username;
    request.updatedAt = this.now();
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}
