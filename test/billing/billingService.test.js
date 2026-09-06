// test/billing/billingService.test.js — 聚合/出账/缴费/对账（T4）
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { issueStatement, pay, reconcile, computeStatement, exportCsv } from '../../src/billing/billingService.js';

const T = '__bt'; const PERIOD = '2026-09';

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'__bt','active','pro') ON CONFLICT (tenant_id) DO UPDATE SET plan='pro', status='active'`, [T]);
  await queryWrite(`INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, tenant_id) VALUES ($1,'x','sales','x',true,$2) ON CONFLICT (username) DO UPDATE SET enabled=true, tenant_id=$2`, [`__bt_u`, T]);
  await queryWrite(`INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, tenant_id) VALUES ($1,'crm-deal-advance',1200000,800000,$2)`, [T, T]);
});

afterAll(async () => {
  await queryWrite(`DELETE FROM crm.billing_payment WHERE tenant_id=$1`, [T]);
  await queryWrite(`DELETE FROM crm.billing_statement WHERE tenant_id=$1`, [T]);
  await queryWrite(`DELETE FROM crm.token_accounting WHERE tenant_id=$1`, [T]);
  await queryWrite(`DELETE FROM crm.crm_users WHERE username=$1`, ['__bt_u']);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [T]);
});

describe('billingService', () => {
  test('computeStatement 聚合（pro 档：按席位单线，token_fee 恒 0）', async () => {
    const s = await computeStatement(T, PERIOD);
    expect(s.tenant_id).toBe(T);
    expect(s.seat_count).toBe(1);
    expect(s.token_fee).toBe(0); // 2026-09-04 模型修订：无独立 Token 超量费
    expect(s.seat_fee).toBeCloseTo(Number(s.seat_unit_price ?? 2980) * 1, 2); // 席位 × 单席价
  });

  test('issue + pay 流转 + reconcile', async () => {
    const st = await issueStatement(T, PERIOD, 'monthly', 15);
    expect(st.status).toBe('issued');
    const r = await pay(st.id, { method: 'bank_transfer', note: 'test' });
    expect(r.ok).toBe(true);
    const rec = await reconcile(PERIOD);
    expect(rec.find((x) => x.status === 'paid')).toBeTruthy();
  });

  test('exportCsv 单租户', async () => {
    const csv = await exportCsv(PERIOD, T);
    expect(csv.startsWith('tenant_id,period,total_fee,status')).toBe(true);
    expect(csv).toContain(T);
  });
});
