import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wizardCss = readFileSync(resolve('src/renderer/history-import/wizard.css'), 'utf8');
const gridCss = readFileSync(resolve('src/renderer/history-import/virtual-grid.css'), 'utf8');
const wizardSource = readFileSync(resolve('src/renderer/history-import/wizard.tsx'), 'utf8');

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('history import 1024/1440 renderer layout and accessibility contracts', () => {
  it('全窗口和内部网格各自约束横向滚动，不使用会制造页面横溢的 100vw', () => {
    expect(wizardCss).toContain('.hiw-workspace,.hiw-home,.hiw-interrupted-result{width:100%;max-width:100%;overflow-x:hidden}');
    expect(wizardCss).toMatch(/grid-template-columns:260px minmax\(580px,1fr\) 320px/);
    expect(wizardCss).toMatch(/@media\(max-width:1100px\).*grid-template-columns:220px minmax\(560px,1fr\)/s);
    expect(gridCss).toMatch(/\.history-grid-viewport\{[^}]*overflow:auto/);
    expect(`${wizardCss}${gridCss}`).not.toContain('100vw');
  });

  it('正文、辅助状态和关键颜色组合达到既定字号与 WCAG AA 对比基线', () => {
    expect(wizardCss).toContain('font:14px/1.5');
    expect(wizardCss).toContain('.hiw-step-state,.hiw-sheet-state,.hiw-match,.hiw-issue-kind{font-size:11px}');
    expect(contrast('#245f56', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#596964', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#92362f', '#f8e6e3')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#80520b', '#f9edcf')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#315f80', '#e4edf4')).toBeGreaterThanOrEqual(4.5);
  });

  it('错误、冲突、警告和提交恢复状态始终带文字，不以颜色作为唯一反馈', () => {
    expect(wizardSource).toContain("{ error: '错误', conflict: '冲突', warning: '警告' }");
    expect(wizardSource).toContain('没有产生部分导入');
    expect(wizardSource).toContain('整批导入已完整成功');
    expect(wizardSource).toContain('aria-label="键盘操作说明"');
    expect(wizardSource).toContain('role="status"');
  });
});
