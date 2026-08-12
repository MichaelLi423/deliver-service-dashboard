import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript CLI module has no declaration file.
import { capabilityFromSpecPath } from '../../scripts/build-verification-matrix.mjs';

describe('验证矩阵 capability 路径解析', () => {
  it('对 macOS 与 Windows 风格 spec 路径生成相同 capability key', () => {
    expect(capabilityFromSpecPath('/repo/openspec/specs/workbench-interface/spec.md')).toBe('workbench-interface');
    expect(capabilityFromSpecPath('C:\\repo\\openspec\\specs\\workbench-interface\\spec.md')).toBe('workbench-interface');
  });
});
