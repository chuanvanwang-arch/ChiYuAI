// test/http/todo-finance.test.js — S05 T3 逾期自动催收待办（TDD：先失败后实现）
// 验证：逾期 PAYMENT_PLAN 在 /api/page/todo?role=finance 派生 action='催收'；sales 视角不含
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

let app;
beforeAll(() => { app = createApp(); });

const financeToken = issueToken({ username: 'fin-demo', role: 'finance', display_name: '财务演示' });
const salesToken = issueToken({ username: 'sales-demo', role: 'sales', display_name: '销售演示' });
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

// 自造 合同 + 逾期回款计划（plan_end 过去、plan_status pending）
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a1111111-1111-1111-1111-111111111111','system','CRM_CONTRACT','ct-demo','食品礼盒框架合同','signed',
     '{"name":"食品礼盒框架合同","stage":"contract","amount":1500000}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00'),
    ('a2222222-2222-2222-2222-222222222222','system','CRM_PAYMENT_PLAN','plan-demo','食品礼盒框架-首付款','pending',
     '{"contract_id":"a1111111-1111-1111-1111-111111111111","plan_amount":500000,"plan_end":"2026-08-15","plan_status":"pending"}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00')`);
});

async function getJson(path, opts = {}) {
  const res = await app.fetch(path, opts);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* 非 JSON 容错 */ }
  return { status: res.status, body };
}

describe('S05 T3 逾期催收待办派生（finance 视角）', () => {
  it('finance 视角出现 action=催收 待办行', async () => {
    const { status, body } = await getJson('/api/page/todo?role=finance', auth(financeToken));
    expect(status).toBe(200);
    const rows = body.data?.components?.table?.rows || [];
    expect(rows.some((x) => x.action === '催收')).toBe(true);
  });

  it('sales 视角不含催收待办', async () => {
    const { status, body } = await getJson('/api/page/todo?role=sales', auth(salesToken));
    expect(status).toBe(200);
    const rows = body.data?.components?.table?.rows || [];
    expect(rows.some((x) => x.action === '催收')).toBe(false);
  });
});