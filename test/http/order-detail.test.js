// test/http/order-detail.test.js — S10 订单详情 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/order-detail?orderId= 返回 renderPage(S10_SCHEMA) 产物，含真实订单字段/履约节点
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 订单 最小闭环
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('b2111111-1111-1111-1111-111111111111','system','CRM_ORDER','order-contracted','食品礼盒首批量产订单','shipped',
     '{"order_no":"SO-2026-001","deal_id":"d3333333-3333-3333-3333-333333333333","contract_id":"c1111111-1111-1111-1111-111111111111","amount":500000,"status":"shipped"}',
     '2026-08-05T09:00:00+08:00','2026-08-15T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S10 订单详情 受控渲染（真实数据）', () => {
  it('GET /api/page/order-detail?orderId= 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/order-detail?orderId=b2111111-1111-1111-1111-111111111111');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('pg-subtable');
  });

  it('属性字段注入真实订单值（单号/金额来自真实 payload）', async () => {
    const { body } = await getJson('/api/page/order-detail?orderId=b2111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('SO-2026-001'); // order_no ← payload.order_no
    expect(body.html).toContain('500000');      // order_amount ← payload.amount
  });

  it('履约节点 subtable 来自订单状态推导（node/plan/actual/status）', async () => {
    const { body } = await getJson('/api/page/order-detail?orderId=b2111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('履约节点');      // subtable title
    expect(body.html).toContain('pg-subtable');
    expect(body.html).toContain('已完成');        // 推导节点状态（shipped → 已完成）
  });

  it('goal-form 渲染推进入口', async () => {
    const { body } = await getJson('/api/page/order-detail?orderId=b2111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('pg-form');
    expect(body.html).toContain('POST /api/page/from-nl'); // goal-form action
    expect(body.html).toContain('推进订单到下一履约节点'); // placeholder
  });

  it('静态页 /order-detail.html 含 #order-root 注入锚点', async () => {
    const res = await app.fetch('/order-detail.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="order-root"');
  });

  it('无 id 时默认取首条订单（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/order-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-attr-field');
  });
});
