import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';

/**
 * 测试夹具：最小 ZIP 构造器 + exceljs 工作簿构造器。
 * 用于 zip-preflight（8.19）与文件/粘贴等价（8.26）的聚焦测试。
 * 只构造合成数据，不读取任何真实 docs 工作簿。
 */

export interface ZipEntryInput {
  name: string;
  data: Buffer | string;
  /** 0=store，8=deflate，其它值用于构造非法压缩方法。 */
  method?: number;
  /** 覆盖中央目录/本地头声明的展开字节数（构造超限声明，不改变实际数据）。 */
  declaredUncompressed?: number;
}

function u16(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * 构造最小合法 ZIP（store/deflate；中央目录与本地头一致，crc 正确）。
 * 用于构造正常 .xlsx 与恶意/异常 ZIP（路径穿越、宏、外链、超限、坏压缩方法）。
 */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method === undefined ? 8 : e.method;
    // 非法 method（非 0/8）时仍按原样写入数据，预检只读中央目录、不应展开数据。
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const declaredUncompressed = e.declaredUncompressed ?? raw.length;
    const localHeader = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(method),
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(comp.length),
      u32(declaredUncompressed),
      u16(name.length),
      u16(0), // extra length
      name,
    ]);
    chunks.push(localHeader, comp);
    centralDir.push(
      Buffer.concat([
        u32(0x02014b50), // central directory signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(method),
        u16(0), // mod time
        u16(0), // mod date
        u32(crc),
        u32(comp.length),
        u32(declaredUncompressed),
        u16(name.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        name,
      ]),
    );
    offset += localHeader.length + comp.length;
  }
  const cd = Buffer.concat(centralDir);
  const end = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // cd start disk
    u16(centralDir.length), // entries on disk
    u16(centralDir.length), // total entries
    u32(cd.length), // cd size
    u32(offset), // cd offset
    u16(0), // comment length
  ]);
  return Buffer.concat([...chunks, cd, end]);
}

/** 构造一个可被 exceljs 与预检正常解析的合成 .xlsx。 */
export async function buildXlsx(
  sheets: Array<{ name: string; rows: Array<Array<string | number | Date | boolean | null>> }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      ws.addRow(row);
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
