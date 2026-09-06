// test/portal-pages.test.js — 门户双页路由冒烟
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/http/server.js';

let app;
beforeAll(() => { app = createApp(); });

describe('门户双页路由', () => {
  it('GET /home.html 返回登录页与状态墙', async () => {
    const res = await app.fetch('/home.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('登录');
    expect(html).toContain('系统状态墙');
  });
  it('GET /home 重定向到 /home.html', async () => {
    const res = await app.fetch('/home');
    expect([301, 302]).toContain(res.status);
  });
  it('GET / 返回 AI 作战室主页含「今日优先」与 copilot', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('今日优先');
    expect(html).toContain('copilot');
  });
  it('GET / 含线索池配置面板', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('线索池配置');
  });
});
