// test/leadPoolProspectingTab.test.js — 公海池页「主动拓客」Tab（T8）UI 契约单测
// 覆盖：页面路由注册 + 拓客 Tab 节点 + 调三个 prospecting action 端点契约 + action 在 registry。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/http/server.js';

const app = createApp();

describe('lead-pool.html 主动拓客 Tab（T8）', () => {
  it('GET /lead-pool.html 返回 HTML 且含拓客 Tab 与 action 端点契约', async () => {
    const r = await app.fetch('/lead-pool.html');
    expect(r.status).toBe(200);
    const ct = r.headers['content-type'] || '';
    expect(ct).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toContain('主动拓客');
    expect(body).toContain('/api/action/prospecting-search');
    expect(body).toContain('/api/action/prospecting-select');
    expect(body).toContain('/api/action/prospecting-confirm');
  }, 30000);

  it('HTML 源码含 Tab 切换结构与三个 action fetch 调用', () => {
    const html = readFileSync('src/web/lead-pool.html', 'utf8');
    expect(html).toContain('data-panel="panel-prospecting"');
    expect(html).toContain("fetch('/api/action/prospecting-search'");
    expect(html).toContain("fetch('/api/action/prospecting-select'");
    expect(html).toContain("fetch('/api/action/prospecting-confirm'");
  }, 30000);

  it('prospecting 三个 action 已在 registry（端点可达前提）', async () => {
    const { getAction } = await import('../src/action/registry.js');
    const { seedProspectingActions } = await import('../src/action/prospectingActions.js');
    seedProspectingActions();
    for (const n of ['prospecting-search', 'prospecting-select', 'prospecting-confirm']) {
      expect(getAction(n), n).not.toBeNull();
    }
  }, 30000);
});
