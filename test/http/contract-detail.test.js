// test/http/contract-detail.test.js — S09 合同详情 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/contract-detail?contractId= 返回 renderPage(S09_SCHEMA) 产物，含真实合同字段/回款计划/发票
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 合同 + 回款计划 + 发票 最小闭环
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('c1111111-1111-1111-1111-111111111111','system','CRM_CONTRACT','contract-contracted','食品礼盒框架合同','effective',
     '{"contract_no":"HT-2026-001","deal_id":"d3333333-3333-3333-3333-333333333333","quotation_id":"f1111111-1111-1111-1111-111111111111","amount":1500000,"start_date":"2026-08-01","end_date":"2027-07-31","approval_status":"effective"}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00')`);
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('91111111-1111-1111-1111-111111111111','system','CRM_PAYMENT_PLAN','plan-contracted-1','食品礼盒框架-首付款','pending',
     '{"contract_id":"c1111111-1111-1111-1111-111111111111","plan_amount":500000,"plan_end":"2026-08-15","plan_status":"pending"}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00')`);
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('92222222-2222-2222-2222-222222222222','system','CRM_PAYMENT_PLAN','plan-contracted-2','食品礼盒框架-尾款','pending',
     '{"contract_id":"c1111111-1111-1111-1111-111111111111","plan_amount":1000000,"plan_end":"2027-07-31","plan_status":"pending"}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00')`);
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('94444444-4444-4444-4444-444444444444','system','CRM_INVOICE','invoice-contracted-1','食品礼盒框架发票','reconciled',
     '{"invoice_no":"INV-2026-001","invoice_type":"增值税专用发票","invoice_amount":500000,"invoice_date":"2026-08-15","contract_id":"c1111111-1111-1111-1111-111111111111","reconcile_status":"reconciled"}',
     '2026-08-15T09:00:00+08:00','2026-08-16T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S09 合同详情 受控渲染（真实数据）', () => {
  it('GET /api/page/contract-detail?contractId= 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/contract-detail?contractId=c1111111-1111-1111-1111-111111111111');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('pg-subtable');
  });

  it('属性字段注入真实合同值（编号/金额/签订日期来自真实 payload）', async () => {
    const { body } = await getJson('/api/page/contract-detail?contractId=c1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('HT-2026-001'); // contract_no ← payload.contract_no
    expect(body.html).toContain('1500000');      // contract_amount ← payload.amount
    expect(body.html).toContain('2026-08-01');    // sign_date ← payload.start_date
  });

  it('回款计划/发票 subtable 来自真实粒子（type/due/amount/status）', async () => {
    const { body } = await getJson('/api/page/contract-detail?contractId=c1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('回款计划');      // payment plan type
    expect(body.html).toContain('500000');        // plan_amount / invoice_amount
    expect(body.html).toContain('2026-08-15');    // plan_end / invoice_date (due)
    expect(body.html).toContain('reconciled');    // invoice reconcile_status
  });

  it('条款风险 reasoning-trace 渲染静态步骤', async () => {
    const { body } = await getJson('/api/page/contract-detail?contractId=c1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('pg-trace');
    expect(body.html).toContain('条款解析');
  });

  // T6（死信息活体化）：S09 reasoning-trace 注入真状态
  it('S09 reasoning-trace 真状态（种子无条款字段+有逾期回款计划 → 条款 idle / 回款 warn / 修订 pending）', async () => {
    const { body } = await getJson('/api/page/contract-detail?contractId=c1111111-1111-1111-1111-111111111111');
    const steps = body.data?.components?.['reasoning-trace']?.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s.label)).toEqual(['条款解析', '回款风险', '修订建议']);
    // 种子 contract 无 clauses/terms/payment_terms → hasClause=false → 条款解析 idle（schema 写死是 ok）
    expect(steps[0].status).toBe('idle');
    // 首付款 plan_end=2026-08-15（当前 2026-08-29 已过期）且 pending 未付 → hasOverduePlan=true
    expect(steps[1].status).toBe('warn');
    expect(steps[2].status).toBe('pending');
    // 渲染层消费注入态
    expect(body.html).toContain('data-trace-step="pending"');
  });

  it('静态页 /contract-detail.html 含 #contract-root 注入锚点', async () => {
    const res = await app.fetch('/contract-detail.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="contract-root"');
  });

  it('无 id 时默认取首条合同（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/contract-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-attr-field');
  });
});
