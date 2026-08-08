import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workbench-interface 桌面布局静态约束',()=>{
  const css=readFileSync(join(process.cwd(),'src/renderer/styles.css'),'utf8');
  it('正文与表格保持 14px 基线，辅助信息保持 12px',()=>{expect(css).toContain('font-size:14px');expect(css).toContain('font-size:12px');expect(css).toContain('.queue table,.data-table');});
  it('1024 附近不产生页面级横向溢出，宽表格在容器内滚动',()=>{expect(css).toContain('body{margin:0;min-width:0');expect(css).toContain('overflow-x:hidden');expect(css).toContain('.table-scroll{max-width:100%;overflow-x:auto}');expect(css).toContain('@media(max-width:1030px)');});
  it('1440 为主布局基准且上下文不遮挡队列',()=>{expect(css).toContain('max-width:1600px');expect(css).toContain('grid-template-columns:minmax(0,1fr) 330px');expect(css).toContain('.context{position:sticky');});
  it('提供 reduced motion 降级',()=>{expect(css).toContain('@media(prefers-reduced-motion:reduce)');});
});
