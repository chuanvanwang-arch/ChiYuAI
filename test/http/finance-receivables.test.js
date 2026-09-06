// test/http/finance-receivables.test.js — S05 T1 财务应收聚合端点（TDD：先失败后实现）
// 验证：GET /api/finance/receivables 返回合同维应收余额/逾期天数/账龄分层/发票对账；角色闸仅 finance
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

let app;
beforeAll(() => { app = createApp(); });

// 角色 token：resolveMe 仅解 token payload（auth.js:45 同步），不含 DB 校验 → issueToken 直接铸造
const financeToken = issueToken({ username: 'fin-demo', role: 'finance', display_name: '财务演示' });
const salesToken = issueToken({ username: 'sales-demo', role: 'sales', display_name: '销售演示' });
const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理员' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

// plm_test 无种子，自造 合同 + 回款计划(逾期) + 回款记录(部分) + 发票 最小闭环
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a1111111-1111-1111-1111-111111111111','system','CRM_CONTRACT','ct-demo','食品礼盒框架合同','signed',
     '{"name":"食品礼盒框架合同","stage":"contract","amount":1500000}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00'),
    ('a2222222-2222-2222-2222-222222222222','system','CRM_PAYMENT_PLAN','plan-demo','食品礼盒框架-首付款','pending',
     '{"contract_id":"a1111111-1111-1111-1111-111111111111","plan_amount":500000,"plan_end":"2026-08-15","plan_status":"pending"}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00'),
    ('a3333333-3333-3333-3333-333333333333','system','CRM_PAYMENT_RECORD','pay-demo','食品礼盒框架-首付款实收','recorded',
     '{"contract_id":"a1111111-1111-1111-1111-111111111111","paid_amount":300000,"paid_at":"2026-08-12T09:00:00+08:00","voucher":"https://example.com/voucher/HT-2026-demo.pdf"}',
     '2026-08-12T09:00:00+08:00','2026-08-12T09:00:00+08:00'),
    ('a4444444-4444-4444-4444-444444444444','system','CRM_INVOICE','inv-demo','食品礼盒框架-发票','open',
     '{"contract_id":"a1111111-1111-1111-1111-111111111111","invoice_amount":500000,"reconcile_status":"open"}',
     '2026-08-13T09:00:00+08:00','2026-08-13T09:00:00+08:00')`);
});

async function getJson(path, opts = {}) {
  const res = await app.fetch(path, opts);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* 非 JSON（如 express 404 HTML）→ 空 body */ }
  return { status: res.status, body };
}

describe('GET /api/finance/receivables 财务应收聚合（S05 T1）', () => {
  it('finance 角色返回合同维应收余额/逾期/账龄/发票对账', async () => {
    const { status, body } = await getJson('/api/finance/receivables', auth(financeToken));
    expect(status).toBe(200);
    expect(Array.isArray(body.contracts)).toBe(true);
    const c = body.contracts[0];
    expect(c).toHaveProperty('contract_id');
    expect(c).toHaveProperty('receivable');      // Σplan − Σpaid = 500000−300000 = 200000
    expect(c.receivable).toBe(200000);
    expect(c).toHaveProperty('plan_total');
    expect(c.plan_total).toBe(500000);
    expect(c).toHaveProperty('paid_total');
    expect(c.paid_total).toBe(300000);
    expect(c).toHaveProperty('overdue_days');    // plan_end 2026-08-15 → 已逾期
    expect(typeof c.overdue_days).toBe('number');
    expect(c).toHaveProperty('overdue');
    expect(c.overdue).toBe(true);
    expect(c).toHaveProperty('aging_bucket');    // 字符串档位（0-30/31-60/…）
    expect(typeof c.aging_bucket).toBe('string');
    expect(c).toHaveProperty('invoice_status');
    expect(c.invoice_status).toBe('open');
  });

  it('非 finance 角色返回 403', async () => {
    const { status } = await getJson('/api/finance/receivables', auth(salesToken));
    expect(status).toBe(403);
  });

  it('admin 角色可代查（superuser 视角看只读看板，不破坏业务边界）', async () => {
    const { status, body } = await getJson('/api/finance/receivables', auth(adminToken));
    expect(status).toBe(200);
    expect(Array.isArray(body.contracts)).toBe(true);
    expect(body.contracts[0]?.receivable).toBe(200000);
  });

  it('差额超阈值合同触发 payment_gap 告警（T4 端到端：finance 拉取后 alertStore 落库）', async () => {
    const { listAlerts, resetAlertStore } = await import('../../src/alerts/alertStore.js');
    resetAlertStore();
    await getJson('/api/finance/receivables', auth(financeToken));
    const alerts = listAlerts();
    // 种子：plan_total=500000 / paid_total=300000 → receivable=200000，缺口占比 40% ≥ 5% 阈值 → payment_gap 必现
    expect(alerts.some((a) => a.kind === 'payment_gap' && a.payload?.contract_id === 'a1111111-1111-1111-1111-111111111111')).toBe(true);
  });
});