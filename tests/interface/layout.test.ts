import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workbench-interface 桌面布局静态约束',()=>{
  const css=readFileSync(join(process.cwd(),'src/renderer/styles.css'),'utf8');
  it('正文与表格保持 14px 基线，辅助信息保持 12px',()=>{expect(css).toContain('font-size:14px');expect(css).toContain('font-size:12px');expect(css).toContain('.queue table,.data-table');});
  it('1024 附近不产生页面级横向溢出，宽表格在容器内滚动',()=>{expect(css).toContain('body{margin:0;min-width:0');expect(css).toContain('overflow-x:hidden');expect(css).toContain('.table-scroll{max-width:100%;overflow-x:auto}');expect(css).toContain('@media(max-width:1030px)');});
  it('1440 为主布局基准且上下文不遮挡队列',()=>{expect(css).toContain('max-width:1600px');expect(css).toContain('grid-template-columns:minmax(0,1fr) 330px');expect(css).toContain('.context{position:sticky');});
  it('提供 reduced motion 降级',()=>{expect(css).toContain('@media(prefers-reduced-motion:reduce)');});
  it('生命周期阶段使用原型的分层交互样式而不是浏览器默认按钮',()=>{expect(css).toContain('.workbench-v2 .stage[aria-pressed="true"]');expect(css).toContain('.workbench-v2 .stage.not-entered[aria-pressed="true"]');});
  it('独立模块抽屉给记录区稳定宽度，并在较窄桌面改为单列',()=>{expect(css).toContain('.wide-drawer{width:min(1120px,calc(100vw - 24px))');expect(css).toContain('grid-template-columns:minmax(340px,.78fr) minmax(460px,1.22fr)');expect(css).toContain('@media(max-width:900px)');expect(css).toContain('.wide-drawer .module-layout{grid-template-columns:minmax(0,1fr)}');});
  it('数据管理入口与主导航共用高度、选中反馈和下拉层级',()=>{expect(css).toContain('.data-menu{height:100%;display:flex;align-items:stretch}');expect(css).toContain('.data-menu summary:hover,.data-menu[open] summary');expect(css).toContain('min-width:176px');});
});
