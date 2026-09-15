import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync('src/web/home.html', 'utf8');

describe('home 页今日信号卡（对齐 Rox Home）', () => {
  it('卡片存在且含「今日信号」标题与 id', () => {
    expect(html).toContain('今日信号');
    expect(html).toMatch(/id="signals"/);
  });

  it('wall() 并行 fetch 含 signals 视角（/api/workbench?view=signals）', () => {
    expect(html).toContain('/api/workbench?view=signals');
  });

  it('信号卡渲染逻辑存在（open/high 计数 + 全绿兜底）', () => {
    expect(html).toContain('sigRows');
    expect(html).toContain("status==='open'");
    expect(html).toContain('全绿');
  });
});
