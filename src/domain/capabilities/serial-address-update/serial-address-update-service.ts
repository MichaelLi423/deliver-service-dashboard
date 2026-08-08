import { ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import { assertValidIso, monthOfIso, SystemClock, type Clock } from '../../core/time';
import type {
  SerialAddressUpdate,
  SerialAddressUpdateFilter,
  SerialAddressUpdateInput,
} from './serial-address-update';
import type {
  InstrumentAddressReader,
  SerialAddressUpdateRepository,
} from './serial-address-update-repositories';

/**
 * serial-address-update 领域服务（tasks 4.3）。
 *
 * - 逐台登记更新事实：客户名称、新址地址、序列号、Account ID 与更新时间均必填。
 * - 项目级新址仅作默认计划，不自动成为仪器实际关联新址；实际关联以最近一条
 *   更新事实为准；未登记更新事实的仪器不视为已关联新址。
 * - 更新事实不创建、修改或删除不可变 Ship-to 主数据。
 * - 更新时间必填、默认当前时间并可补录历史时间。
 * - 序列号非空且与登记的搬迁仪器一致，不引入未确认的序列号格式约束。
 * 手工登记绑定当前登录账号归属快照。
 */
export class SerialAddressUpdateService {
  constructor(
    private readonly updates: SerialAddressUpdateRepository,
    private readonly instruments: InstrumentAddressReader,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /** 逐台登记一条序列号地址更新事实。 */
  register(instrumentId: string, input: SerialAddressUpdateInput, actor: ActorSnapshot): SerialAddressUpdate {
    const instrument = this.instruments.findById(instrumentId);
    if (!instrument) {
      throw new ValidationError('INSTRUMENT_NOT_FOUND', `搬迁仪器不存在: ${instrumentId}`);
    }
    const customerName = assertRequiredText(input.customerName, '客户名称');
    const newSiteAddress = assertRequiredText(input.newSiteAddress, '新址地址');
    const serialNo = assertRequiredText(input.serialNo, '序列号');
    const accountId = assertRequiredText(input.accountId, 'Account ID');
    // 序列号与登记的搬迁仪器一致（仪器无序列号占位时无法匹配，拒绝登记）
    if (instrument.serialNo === null || instrument.serialNo === '') {
      throw new ValidationError('INSTRUMENT_SERIAL_EMPTY', '该搬迁仪器尚无序列号，无法登记序列号地址更新');
    }
    if (serialNo !== instrument.serialNo) {
      throw new ValidationError(
        'SERIAL_NO_MISMATCH',
        `序列号「${serialNo}」与该搬迁仪器登记序列号「${instrument.serialNo}」不一致`,
      );
    }
    const updatedAt = input.updatedAt ?? this.now();
    assertValidIso(updatedAt, '更新时间');
    const now = this.now();
    const update: SerialAddressUpdate = {
      id: newInternalId(),
      instrumentId,
      customerName,
      newSiteAddress,
      serialNo,
      accountId,
      updatedAt,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
    };
    this.updates.save(update);
    return update;
  }

  /**
   * 仪器实际关联新址：以最近一条更新事实为准（按更新时间，同时刻按登记先后）。
   * 未登记更新事实返回 null（不视为已关联新址；项目级新址不替代）。
   */
  getActualAddress(instrumentId: string): SerialAddressUpdate | null {
    return this.latestByInstrument(instrumentId);
  }

  /** 更新事实列表与筛选：按客户、新址地址、序列号、Account ID 或更新时间。 */
  list(filter?: SerialAddressUpdateFilter): SerialAddressUpdate[] {
    let rows = this.updates.listAll();
    if (filter) {
      if (filter.customerName !== undefined) {
        rows = rows.filter((r) => r.customerName.includes(filter.customerName!.trim()));
      }
      if (filter.newSiteAddress !== undefined) {
        rows = rows.filter((r) => r.newSiteAddress.includes(filter.newSiteAddress!.trim()));
      }
      if (filter.serialNo !== undefined) {
        rows = rows.filter((r) => r.serialNo === filter.serialNo!.trim());
      }
      if (filter.accountId !== undefined) {
        rows = rows.filter((r) => r.accountId === filter.accountId!.trim());
      }
      if (filter.updatedAt !== undefined) {
        const key = filter.updatedAt.trim();
        rows = rows.filter((r) => r.updatedAt.startsWith(key));
      }
    }
    return rows;
  }

  /** 按更新时间所属月份计数（每条更新事实按更新时间归属）。 */
  countByMonth(): { month: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const row of this.updates.listAll()) {
      const month = monthOfIso(row.updatedAt);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return [...counts.entries()].map(([month, count]) => ({ month, count }));
  }

  private latestByInstrument(instrumentId: string): SerialAddressUpdate | null {
    let latest: SerialAddressUpdate | null = null;
    for (const row of this.updates.listAll()) {
      if (row.instrumentId !== instrumentId) continue;
      if (
        latest === null ||
        row.updatedAt > latest.updatedAt ||
        (row.updatedAt === latest.updatedAt && row.createdAt > latest.createdAt)
      ) {
        latest = row;
      }
    }
    return latest;
  }

  private now(): string {
    return this.clock.nowIso();
  }
}
