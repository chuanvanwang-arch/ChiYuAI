// test/http/quotation-detail.test.js — S08 报价详情 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/quotation-detail?quoteId= 返回 renderPage(S08_SCHEMA) 产物，含真实报价字段/明细行/历史版本
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 报价 最小闭环（含 items 明细行）
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('f1111111-1111-1111-1111-111111111111','system','CRM_QUOTATION','quote-contracted','食品礼盒框架报价','ACTIVE',
     '{"name":"食品礼盒框架报价","deal_id":"d3333333-3333-3333-3333-333333333333","valid_until":"2026-12-31","amount":1500000,"items":[{"product_id":"p-folding-box","qty":50000,"unit_price":30,"discount":0.05,"tax":0.13}],"approval_status":"approved","invalid":false}',
     '2026-07-22T09:00:00+08:00','2026-07-22T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S08 报价详情 受控渲染（真实数据）', () => {
  it('GET /api/page/quotation-detail?quoteId= 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/quotation-detail?quoteId=f1111111-1111-1111-1111-111111111111');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('pg-subtable');
    expect(body.html).toContain('pg-table');
  });

  it('属性字段注入真实报价值（单号/总金额/有效期来自真实 payload）', async () => {
    const { body } = await getJson('/api/page/quotation-detail?quoteId=f1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('食品礼盒框架报价'); // quote_no ← name
    expect(body.html).toContain('1500000');          // total_amount ← amount
    expect(body.html).toContain('2026-12-31');        // valid_until
  });

  it('报价明细行 subtable 来自真实 items（product/qty）', async () => {
    const { body } = await getJson('/api/page/quotation-detail?quoteId=f1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('p-folding-box');
    expect(body.html).toContain('50000');            // qty
  });

  it('历史版本 table 含真实金额', async () => {
    const { body } = await getJson('/api/page/quotation-detail?quoteId=f1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('1500000');          // amount
  });

  it('静态页 /quotation-detail.html 含 #quote-root 注入锚点', async () => {
    const res = await app.fetch('/quotation-detail.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="quote-root"');
  });

  it('无 id 时默认取首条报价（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/quotation-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-attr-field');
  });
});
