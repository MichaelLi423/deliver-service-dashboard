import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * 可注入文件系统（backup/restore 测试用）。
 * 只声明本能力实际用到的能力，避免与第三方文件系统接口耦合。
 */
export interface FsLike {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  unlinkSync(path: string): void;
  copyFileSync(src: string, dest: string): void;
  renameSync(oldPath: string, newPath: string): void;
  writeFileSync(path: string, data: string): void;
  statSync(path: string): { isFile(): boolean };
}

export const nodeFsLike: FsLike = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
  readdirSync: (p) => nodeFs.readdirSync(p),
  unlinkSync: (p) => nodeFs.unlinkSync(p),
  copyFileSync: (s, d) => nodeFs.copyFileSync(s, d),
  renameSync: (o, n) => nodeFs.renameSync(o, n),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  statSync: (p) => nodeFs.statSync(p),
};

export const pathJoin = nodePath.join;
