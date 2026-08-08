import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 临时目录/临时 SQLite 文件辅助（真实临时数据库，验证关闭重开等场景）。
 */

export function makeTempDir(prefix = 'workbench-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeTempDbPath(dir?: string): string {
  return join(dir ?? makeTempDir(), `test-${Math.random().toString(36).slice(2, 8)}.db`);
}

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
}

/** 清理单文件及其 WAL/SHM 附属。 */
export function cleanupDbFile(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
}
