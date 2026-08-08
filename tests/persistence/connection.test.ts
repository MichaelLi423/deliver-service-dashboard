import { describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteCustomerRepository,
  SqliteContractRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

describe('本地 SQLite 持久化（tasks 1.9 / D17）', () => {
  it('关闭并重开应用后数据保留（真实临时 SQLite）', () => {
    const dir = makeTempDir();
    try {
      // 第一次启动：建库 + 写入客户与待进单项目
      const first = bootstrapDatabase({ dataDir: dir });
      const customer = new CustomerService(new SqliteCustomerRepository(first.db)).register(
        '华东医药',
      );
      const projects = new ProjectService(
        new SqliteProjectRepository(first.db),
        new SqliteContractRepository(first.db),
      );
      const project = projects.createPendingProject();
      expect(customer.id).toBeTruthy();
      expect(project.id).toBeTruthy();

      closeDatabase(first.db);

      // 关闭并重新打开：数据保留
      const second = bootstrapDatabase({ dataDir: dir });
      const repo = new SqliteCustomerRepository(second.db);
      expect(repo.findByName('华东医药')?.id).toBe(customer.id);
      const projectRepo = new SqliteProjectRepository(second.db);
      expect(projectRepo.findById(project.id)?.status).toBe('pending_entry');
      closeDatabase(second.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('连接启用 WAL / foreign_keys / busy_timeout', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(journal.journal_mode).toBe('wal');
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
      const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(busy.timeout).toBe(5000);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('数据库位于本机数据目录（不依赖远程存储）', () => {
    const dir = makeTempDir();
    try {
      const { dbPath } = bootstrapDatabase({ dataDir: dir });
      expect(dbPath.endsWith('workbench.db')).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
