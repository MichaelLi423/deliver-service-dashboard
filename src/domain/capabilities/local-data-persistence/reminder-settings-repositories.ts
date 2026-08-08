import type { DatabaseSync } from 'node:sqlite';
import type { ReminderSettingsRepository } from '../workbench-todos';
import { mapConstraintError } from './repositories';

/**
 * workbench-todos SQLite 仓储（tasks 6.3 落库）。
 *
 * 临期窗口配置持久化到 app_settings（v1 已建表，默认未来 7 个自然日），
 * 键为 reminder_upcoming_window_days；未配置时返回 null 由领域层取默认值。
 * 配置立即生效于后续到期分类。
 */
const WINDOW_KEY = 'reminder_upcoming_window_days';

export class SqliteReminderSettingsRepository implements ReminderSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getUpcomingWindowDays(): number | null {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(WINDOW_KEY) as { value: string } | undefined;
    if (!row) return null;
    const days = Number(row.value);
    return Number.isInteger(days) && days >= 0 ? days : null;
  }

  setUpcomingWindowDays(days: number): void {
    try {
      this.db
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(WINDOW_KEY, String(days), new Date().toISOString());
    } catch (err) {
      throw mapConstraintError(err, `临期窗口配置保存失败`);
    }
  }
}
