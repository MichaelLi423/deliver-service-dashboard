import { ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import { assertValidIso, monthOfIso, SystemClock, type Clock } from '../../core/time';
import {
  QR_REQUEST_TYPE_CODES,
  type QrRequest,
  type QrRequestInput,
  type QrRequestTypeCode,
  type QrRequestWorkloadRow,
} from './qr-request';
import type { QrRequestRepository } from './qr-request-repositories';

/**
 * qr-request-tracking 领域服务（tasks 4.9~4.10）。
 *
 * - 独立模块：申请只保存申请人、申请时间与选中类型，不关联搬迁仪器、不关联搬迁项目。
 * - 申请不设状态流转：一经保存即为一条完整记录。
 * - 工作量按申请记录 × 去重后的选中类型计数；同一条内相同类型只计一次，
 *   不同申请中的相同类型分别计数；重复申请保留完整历史。
 * 手工记录绑定当前登录账号归属快照。
 */
export class QrRequestService {
  constructor(
    private readonly requests: QrRequestRepository,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /** 发起一条二维码申请（多选类型，同条内去重；不设状态）。 */
  createRequest(input: QrRequestInput, actor: ActorSnapshot): QrRequest {
    const applicant = assertRequiredText(input.applicant, '申请人');
    if (input.types.length === 0) {
      throw new ValidationError('QR_TYPES_REQUIRED', '二维码申请至少选择一个申请类型');
    }
    const types = [...new Set(input.types)];
    for (const type of types) {
      this.assertTypeCode(type);
    }
    const requestedAt = input.requestedAt ?? this.now();
    assertValidIso(requestedAt, '申请时间');
    const now = this.now();
    const request: QrRequest = {
      id: newInternalId(),
      applicant,
      requestedAt,
      types,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
    };
    this.requests.save(request);
    return request;
  }

  /** 全部申请（历史完整保留，不覆盖、不删除）。 */
  listRequests(): QrRequest[] {
    return this.requests.listAll();
  }

  /**
   * 申请工作量：一条申请记录内每个去重后的选中类型各计一次；
   * 同一条内相同类型只计一次，不同申请中的相同类型分别计数。
   */
  countWorkloadByType(): QrRequestWorkloadRow[] {
    const counts = new Map<QrRequestTypeCode, number>();
    for (const request of this.requests.listAll()) {
      for (const type of new Set(request.types)) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([typeCode, count]) => ({ typeCode, count }));
  }

  /** 申请量按申请时间所属月份归属。 */
  countByMonth(): { month: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const request of this.requests.listAll()) {
      const month = monthOfIso(request.requestedAt);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return [...counts.entries()].map(([month, count]) => ({ month, count }));
  }

  private assertTypeCode(type: QrRequestTypeCode): void {
    if (!(QR_REQUEST_TYPE_CODES as readonly string[]).includes(type)) {
      throw new ValidationError('ILLEGAL_QR_TYPE', `申请类型仅限九类固定代码`);
    }
  }

  private now(): string {
    return this.clock.nowIso();
  }
}
