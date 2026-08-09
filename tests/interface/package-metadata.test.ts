import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Windows 安装包元数据', () => {
  it('提供 Squirrel 生成 NuGet Authors 所需的 author', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { author?: string | { name?: string } };
    const author = typeof packageJson.author === 'string'
      ? packageJson.author
      : packageJson.author?.name;

    expect(author?.trim()).toBe('搬迁服务工作台团队');
  });
});
