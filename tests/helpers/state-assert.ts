import { expect } from 'vitest';
import type {
  TransitionResult,
} from '../../src/domain/capabilities/relocation-project-lifecycle/lifecycle';
import type { ProjectStatusOrCancelled } from '../../src/domain/capabilities/relocation-project-lifecycle/states';

/**
 * 状态校验断言辅助（tasks 1.4）。
 */

export function expectStatus(
  result: TransitionResult,
  expected: ProjectStatusOrCancelled,
): asserts result is Extract<TransitionResult, { ok: true }> {
  expect(result.ok, `期望状态流转成功为 ${expected}`).toBe(true);
  if (result.ok) {
    expect(result.status).toBe(expected);
  }
}

export function expectReason(
  result: TransitionResult,
  reason: string,
): void {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.reason).toBe(reason);
  }
}

export function expectRejected(
  result: TransitionResult,
  errorContains?: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    if (errorContains) {
      expect(result.errors.join('；')).toContain(errorContains);
    } else {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  }
}
