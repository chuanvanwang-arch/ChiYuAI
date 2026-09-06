// S05 T2/T5 收尾回归：财务应收两个页面路由须已注册（sendFile 实时读 src/web）
// 早期漏注册导致 404（config.html id29「打开编辑」跳 /finance-receivables.html 也 404）
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';

let app;
beforeAll(() => { app = createApp(); });

async function getHtml(path) {
  const res = await app.fetch(path);
  const text = await res.text();
  return { status: res.status, text };
}

describe('S05 财务应收页面路由', () => {
  it('GET /receivables.html → 200 且含看板标记', async () => {
    const { status, text } = await getHtml('/receivables.html');
    expect(status).toBe(200);
    expect(text).toContain('财务应收看板');
  });

  it('GET /finance-receivables.html → 200 且含配置标记', async () => {
    const { status, text } = await getHtml('/finance-receivables.html');
    expect(status).toBe(200);
    expect(text).toContain('财务应收配置');
  });
});
