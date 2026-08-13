import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(resolve('src/renderer/styles.css'), 'utf8');

describe('data management menu visual contract', () => {
  it('菜单行重置原生按钮外观，并使用无描边的柔和状态', () => {
    expect(styles).toMatch(/\.data-menu-panel button\{[^}]*appearance:none[^}]*border:0[^}]*background:transparent[^}]*box-shadow:none/);
    expect(styles).toMatch(/\.data-menu-panel button\{[^}]*display:flex[^}]*align-items:center[^}]*height:36px[^}]*padding:0 11px[^}]*line-height:20px/);
    expect(styles).toMatch(/\.data-menu-panel button:hover,\.data-menu-panel button:focus-visible\{[^}]*background:var\(--brand-soft\)[^}]*box-shadow:none/);
    expect(styles).toMatch(/\.data-menu-panel button\.danger-text:hover,\.data-menu-panel button\.danger-text:focus-visible\{[^}]*background:var\(--red-soft\)/);
  });

  it('浮层使用细边框、紧凑留白和克制阴影', () => {
    expect(styles).toMatch(/\.data-menu-panel\{[^}]*padding:4px[^}]*border:1px solid var\(--line\)[^}]*box-shadow:0 8px 24px/);
    expect(styles).toMatch(/\.data-menu-divider\{[^}]*height:1px[^}]*margin:4px 7px[^}]*background:var\(--line\)/);
  });

  it('打开动画克制，并尊重减少动态效果偏好', () => {
    expect(styles).toContain('animation:data-menu-open .16s cubic-bezier(.2,0,0,1)');
    expect(styles).toMatch(/@keyframes data-menu-open\{from\{opacity:0;transform:translateY\(-4px\) scale\(\.985\)\}to\{opacity:1;transform:translateY\(0\) scale\(1\)\}\}/);
    expect(styles).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.data-menu-panel\{animation:none\}/);
  });
});
