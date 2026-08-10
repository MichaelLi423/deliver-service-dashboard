import type { SerialAddressUpdate } from './serial-address-update';

/**
 * serial-address-update 仓储接口（领域服务依赖）。
 * SQLite 实现见 local-data-persistence/serial-address-update-repositories.ts。
 */

export interface SerialAddressUpdateRepository {
  findById(id: string): SerialAddressUpdate | undefined;
  save(update: SerialAddressUpdate): void;
  listAll(): SerialAddressUpdate[];
  /** 确认后删除一条更新事实（5.2：不触碰仪器/项目/Ship-to，实际关联以剩余最近事实为准）。 */
  deleteById(id: string): void;
}

/**
 * 搬迁仪器只读事实源：instrumentId 有值时校验序列号与登记仪器一致；
 * 独立保存（无 instrumentId）时不读取仪器。
 * 实现可复用 relocation-execution 的 SqliteInstrumentRepository。
 */
export interface InstrumentAddressReader {
  findById(id: string):
    | { id: string; projectId: string; serialNo: string | null }
    | undefined;
}
