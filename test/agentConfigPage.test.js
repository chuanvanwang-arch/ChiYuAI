// test/agentConfigPage.test.js — 智能体配置页 (agent-config.html) UI 契约单测
// 覆盖：页面路由注册、HTML 源码不再误用 api.js 的 get() 返回值、端点返回 JSON。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';

const app = createApp();

describe('agent-config.html 页面与 /api/agent-config 契约', () => {
  it('GET /agent-config.html 返回 HTML 且包含智能体配置内容', async () => {
    const r = await app.fetch('/agent-config.html');
    expect(r.status).toBe(200);
    const ct = r.headers['content-type'] || '';
    expect(ct).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toContain('智能体配置');
    expect(body).toContain('/api/agent-config');
  }, 30000);

  it('HTML 源码使用 api.js 契约（get 返回 JSON，不调用 .text/.json/.ok）', async () => {
    const html = readFileSync('src/web/agent-config.html', 'utf8');
    const script = html.split('<script type="module">')[1] || '';
    // api.js get() 已解析 JSON；页面不应再对返回值调用 Response 方法
    expect(script).not.toMatch(/r\.text\(\)/);
    expect(script).not.toMatch(/r\.json\(\)/);
    expect(script).not.toMatch(/!r\.ok/);
    expect(script).toContain("await get('/api/agent-config')");
  }, 30000);

  it('GET /api/agent-config 返回 JSON 装配摘要', async () => {
    const tok = issueToken({ username: 'admin1', role: 'admin', tenantId: 'system' });
    const r = await app.fetch('/api/agent-config', { headers: { authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    const ct = r.headers['content-type'] || '';
    expect(ct).toMatch(/application\/json/);
    const j = await r.json();
    expect(Array.isArray(j.agents)).toBe(true);
    expect(typeof j.specs).toBe('object');
    expect(Array.isArray(j.assembly)).toBe(true);
  }, 30000);
});
