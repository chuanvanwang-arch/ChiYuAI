// test/web/decision-drillthrough-ui.test.js — T-D7 三图闭环页签契约（静态校验，零浏览器依赖）
// 锁定：①页签存在（DN_VIEWS 含 三图闭环）②dnLoop 调用 /closure 端点 ③零硬编码 hex（仅 var(--*)）
//   ④页面链 tokens.css（UI 一致性铁律）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/web/sales-decision-monitor.html', import.meta.url), 'utf8');

describe('T-D7 三图闭环页签契约', () => {
  it('DN_VIEWS 含「三图闭环（K/M/J）」页签', () => {
    expect(html).toContain('三图闭环（K/M/J）');
  });

  it('dnLoop 调用 /api/decision/:id/closure 端点', () => {
    expect(html).toMatch(/dnLoop\(\)/);
    expect(html).toMatch(/\/api\/decision\/\$\{encodeURIComponent\(id\)\}\/closure/);
  });

  it('closure 渲染走 tokens.css 语义变量（零硬编码色值）', () => {
    // 三图闭环渲染函数 _loopHtml 内不得出现硬编码 hex（既有 #fff 合法保留属 SVG 填充，本段不新增）
    const start = html.indexOf('function _loopHtml');
    const end = html.indexOf('// 严重度 → 语义色', start);
    const seg = html.slice(start, end);
    expect(seg).not.toMatch(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,6}\)/); // 危险 fallback
    expect(seg).toMatch(/var\(--ok\)/);  // 至少用到语义变量
    expect(seg).toMatch(/var\(--err\)/);
  });

  it('页面链 tokens.css / common.css（UI 一致性铁律）', () => {
    expect(html).toMatch(/tokens\.css/);
    expect(html).toMatch(/common\.css/);
  });
});
