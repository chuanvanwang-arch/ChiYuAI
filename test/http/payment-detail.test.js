// test/http/payment-detail.test.js — S11 回款详情 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/payment-detail?paymentId= 返回 renderPage(S11_SCHEMA) 产物，含真实回款字段/计划vs实收
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 回款计划 + 回款记录 最小闭环
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a1111111-1111-1111-1111-111111111111','system','CRM_PAYMENT_PLAN','plan-demo','食品礼盒框架-首付款','pending',
     '{"contract_id":"c1111111-1111-1111-1111-111111111111","plan_amount":500000,"plan_end":"2026-08-15","plan_status":"pending"}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00')`);
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a2222222-2222-2222-2222-222222222222','system','CRM_PAYMENT_RECORD','pay-demo','食品礼盒框架-首付款实收','recorded',
     '{"contract_id":"c1111111-1111-1111-1111-111111111111","paid_amount":300000,"paid_at":"2026-08-12T09:00:00+08:00","voucher":"https://example.com/voucher/HT-2026-demo.pdf"}',
     '2026-08-12T09:00:00+08:00','2026-08-12T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S11 回款详情 受控渲染（真实数据）', () => {
  it('GET /api/page/payment-detail?paymentId= 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/payment-detail?paymentId=a1111111-1111-1111-1111-111111111111');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('pg-subtable');
  });

  it('属性字段注入真实回款值（编号/计划金额来自真实 payload）', async () => {
    const { body } = await getJson('/api/page/payment-detail?paymentId=a1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('plan-demo'); // payment_no ← payload slug
    expect(body.html).toContain('500000');    // due_amount ← payload.plan_amount
  });

  it('计划 vs 实收 subtable 来自关联回款记录推导（paid/gap/status）', async () => {
    const { body } = await getJson('/api/page/payment-detail?paymentId=a1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('pg-subtable');
    expect(body.html).toContain('200000');      // gap = plan_amount(500000) - paid_amount(300000)
    expect(body.html).toContain('recorded');     // 关联记录状态
    expect(body.html).toContain('食品礼盒框架-首付款'); // 计划主行 mainColumn 值
  });

  it('goal-form 渲染登记回款入口', async () => {
    const { body } = await getJson('/api/page/payment-detail?paymentId=a1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('pg-form');
    expect(body.html).toContain('POST /api/page/from-nl'); // goal-form action
    expect(body.html).toContain('登记本次回款');            // placeholder
  });

  it('静态页 /payment-detail.html 含 #payment-root 注入锚点', async () => {
    const res = await app.fetch('/payment-detail.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="payment-root"');
  });

  it('无 id 时默认取首条回款计划（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/payment-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-attr-field');
  });
});
