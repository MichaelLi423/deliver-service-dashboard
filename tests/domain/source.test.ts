import { describe, expect, it } from 'vitest';
import { ValidationError, createFactMeta, isManual, validateFactMeta } from '../../src/domain/core/source';
import { EXAMPLE_AUDIT_TIME, EXAMPLE_BUSINESS_TIME, importFact, makeAccount, manualFact, systemFact } from '../helpers/fact-builder';

describe('事实来源与归属（tasks 1.5 / D4 / workbench-access）', () => {
  it('业务时间与审计时间分离保存', () => {
    const meta = createFactMeta({
      source: 'manual',
      businessAt: EXAMPLE_BUSINESS_TIME,
      auditAt: EXAMPLE_AUDIT_TIME,
      actor: makeAccount(),
    });
    expect(meta.businessAt).toBe(EXAMPLE_BUSINESS_TIME);
    expect(meta.auditAt).toBe(EXAMPLE_AUDIT_TIME);
    expect(meta.businessAt).not.toBe(meta.auditAt);
  });

  it('业务时间为 yyyy-mm-dd 且必须是真实日历日期，审计时间仍为带偏移 ISO', () => {
    expect(() =>
      createFactMeta({ source: 'manual', businessAt: '2026-07-15T10:30:00+08:00', actor: makeAccount() }),
    ).toThrow(ValidationError);
    expect(() =>
      createFactMeta({ source: 'manual', businessAt: '2026-02-30', actor: makeAccount() }),
    ).toThrow(ValidationError);
    expect(() =>
      createFactMeta({ source: 'manual', businessAt: '2026-13-01', actor: makeAccount() }),
    ).toThrow(ValidationError);
    // 审计时间必须为带偏移 ISO（不允许业务日期）
    expect(() =>
      createFactMeta({ source: 'manual', businessAt: '2026-07-15', auditAt: '2026-07-15', actor: makeAccount() }),
    ).toThrow(ValidationError);
  });

  it('手工录入事实必须携带当前登录账号的内部 ID 与用户名快照', () => {
    const meta = manualFact({ businessAt: EXAMPLE_BUSINESS_TIME });
    expect(meta.source).toBe('manual');
    expect(meta.actor).toEqual({ accountId: 'account-1', username: '负责人甲' });
    expect(isManual(meta)).toBe(true);
    expect(() =>
      createFactMeta({ source: 'manual', businessAt: EXAMPLE_BUSINESS_TIME }),
    ).toThrow(ValidationError);
  });

  it('系统自动记录事实不归属账号', () => {
    const meta = systemFact();
    expect(meta.source).toBe('system');
    expect(meta.actor).toBeNull();
  });

  it('迁移导入事实不归属本地账号（迁移不计手工录入）', () => {
    const meta = importFact({ businessAt: '2026-05-10' });
    expect(meta.source).toBe('import');
    expect(meta.actor).toBeNull();
    expect(isManual(meta)).toBe(false);
    // 校验函数同样拒绝 import + actor 的组合
    expect(() =>
      validateFactMeta({
        source: 'import',
        businessAt: EXAMPLE_BUSINESS_TIME,
        auditAt: EXAMPLE_AUDIT_TIME,
        actor: makeAccount(),
      }),
    ).toThrow(ValidationError);
  });

  it('事实来源归属影响历史统计（用户名快照不因改名变化）', () => {
    const earlier = manualFact({ actor: makeAccount('account-1', '老用户名') });
    const laterRename = makeAccount('account-1', '新用户名');
    expect(earlier.actor!.username).toBe('老用户名');
    expect(earlier.actor!.accountId).toBe(laterRename.accountId);
    // 历史统计按动作记录中的快照归属，不因以后用户名修改而动态变化
    expect(earlier.actor!.username).not.toBe('新用户名');
  });
});
