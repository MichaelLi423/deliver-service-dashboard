import type { SerialAddressUpdate } from './serial-address-update';

/**
 * serial-address-update 仓储接口（领域服务依赖）。
 * SQLite 实现见 local-data-persistence/serial-address-update-repositories.ts。
 */

export interface SerialAddressUpdateRepository {
  findById(id: string): SerialAddressUpdate | undefined;
  save(update: SerialAddressUpdate): void;
  listAll(): SerialAddressUpdate[];
}

/**
 * 搬迁仪器只读事实源：校验序列号与登记仪器一致。
 * 实现可复用 relocation-execution 的 SqliteInstrumentRepository。
 */
export interface InstrumentAddressReader {
  findById(id: string):
    | { id: string; projectId: string; serialNo: string | null }
    | undefined;
}
