import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(resolve('src/renderer/styles.css'), 'utf8');

describe('project detail profile visual structure', () => {
  it('uses a compact command and always-visible summary above the folded profile', () => {
    expect(styles).toMatch(/\.detail-command-bar\{[^}]*border-left:3px solid var\(--brand\)[^}]*background:var\(--soft\)/);
    expect(styles).toMatch(/\.detail-summary\{[^}]*grid-template-columns:[^}]*background:#f7faf9/);
    expect(styles).toMatch(/\.project-profile\{[^}]*border:1px solid var\(--line\)[^}]*background:var\(--raised\)/);
  });
  it('uses semantic overview groups instead of the global ruled fact grid', () => {
    expect(styles).toContain('.overview-groups{display:grid');
    expect(styles).toMatch(/\.overview-group\{[^}]*border:1px solid var\(--line\)[^}]*background:var\(--raised\)/);
    expect(styles).toMatch(/\.overview-group dl\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*gap:12px 18px/);
    expect(styles).toMatch(/\.overview-group dd\.is-missing\{[^}]*color:var\(--faint\)/);
  });

  it('keeps related-record counts compact and responsive', () => {
    expect(styles).toMatch(/\.overview-records dl\{[^}]*grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
    expect(styles).toContain('.overview-groups{grid-template-columns:repeat(2,minmax(0,1fr))}');
    expect(styles).toContain('.overview-group dl{grid-template-columns:minmax(0,1fr)}');
    expect(styles).toContain('.detail-summary{grid-template-columns:repeat(3,minmax(0,1fr))}');
  });
});
