// test/http/follow-reminder-mount.test.js — 告警模块抽离跨页契约 + 路由可达
// 范式：createApp().fetch（真实 PG plm_test）；纯静态资源/页面断言，无业务种子依赖
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';

let app;
beforeAll(() => { app = createApp(); });

describe('GET /portal/followReminder.js 静态可达', () => {
  it('返回 200 且 Content-Type 为 text/javascript', async () => {
    const res = await app.fetch('/portal/followReminder.js');
    expect(res.status).toBe(200);
    // 注意：app.fetch 适配器 res.headers 是 Node 原生对象（小写键），非 Headers 实例
    expect(res.headers['content-type'] || '').toContain('text/javascript');
    const body = await res.text();
    expect(body).toContain('renderFollowKpis');
    expect(body).toContain('renderFollowTable');
  });
});

describe('跨页契约', () => {
  it('客户跟踪页含 follow-table-host 挂载区且引用复用模块', async () => {
    const res = await app.fetch('/named-accounts.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="follow-table-host"');
    expect(html).toContain('/portal/followReminder.js');
  });
  it('工作台首页引用复用模块', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('/portal/followReminder.js');
  });
  it('S02 首页受控渲染无回归（客户跟踪 collapse 仍在）', async () => {
    const res = await app.fetch('/api/page/home');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.html).toContain('客户跟踪');
  });
});
