// test/web/discoveryPage.test.js — Task 13: 前台线索发现工作台页面（只读面）
// 范式：test/web/billing.smoke.test.js（fs 读文件断言，零 DB）
// 断言面：三区 id / 只读端点串 / C2 glass-box 展示位 / 禁 DELETE / serve 路径 / portal 令牌引入
import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const pageFile = new URL('../../src/web/discovery.html', import.meta.url);
const html = readFileSync(pageFile, 'utf8');

describe('discovery.html 前台线索发现工作台（只读面）', () => {
  it('含三区：triggerBar / candidatePool / glassBoxDrawer', () => {
    expect(html).toContain('id="triggerBar"');
    expect(html).toContain('id="candidatePool"');
    expect(html).toContain('id="glassBoxDrawer"');
  });

  it('只调只读端点 GET /api/discovery/candidates', () => {
    expect(html).toContain('/api/discovery/candidates');
    // 页面内不得出现对 POST / PUT / DELETE 该端点的裸调用（写走 MCP 两阶段 + 第0闸）
    expect(/fetch\([^)]*\/(api\/discovery\/candidates)[^)]*,\s*\{[^}]*method\s*:\s*['"](POST|PUT|DELETE)['"]/i.test(html)).toBe(false);
  });

  it('含 C2 glass-box 展示位：why_narrative / icp_fit_score / rule_ref', () => {
    expect(html).toContain('why_narrative');
    expect(html).toContain('icp_fit_score');
    expect(html).toContain('rule_ref');
    expect(html).toContain('j_score');
  });

  it('无 DELETE 关键字（禁 DELETE 铁律）', () => {
    expect(/\bdelete\b|\bDELETE\b/.test(html)).toBe(false);
  });

  it('页面 serve 路径正确（src/web/discovery.html 存在）', () => {
    expect(existsSync(pageFile)).toBe(true);
  });

  it('引入 portal 令牌（受控页既有范式）', () => {
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
  });
});
