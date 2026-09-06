// test/billing/refundReconcile.test.js — 退款 + 对账（需 PG，测试库 crm_native_test）
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { queryWrite, query } from '../../src/db.js';
import { requestRefund } from '../../src/billing/refundService.js';
import { runReconcile } from '../../src/billing/reconcileService.js';

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ('__rf','__rf','active','pro') ON CONFLICT (tenant_id) DO UPDATE SET plan='pro'`);
  await queryWrite(`INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, provider, amount, status) VALUES ('ro1','otrf','__rf','pro','wechat',99.00,'paid')`);
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at, online_order_no) VALUES ('__rf','pro','active', now()+interval '1 month','otrf') ON CONFLICT DO NOTHING`);
});
afterAll(async () => {
  await queryWrite(`DELETE FROM crm.billing_reconcile_diff WHERE out_trade_no IN ('otrf','x1')`);
  await queryWrite(`DELETE FROM crm.payment_order WHERE tenant_id='__rf'`);
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id='__rf'`);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id='__rf'`);
});

describe('refund', () => {
  test('requestRefund（mock 网关）写 refunded + 订阅转 grace', async () => {
    const r = await requestRefund({ outTradeNo: 'otrf', reason: 'test', gatewayFn: async () => ({ refund_id: 'rf1', status: 'SUCCESS' }) });
    expect(r.ok).toBe(true);
    const po = await query(`SELECT status FROM crm.payment_order WHERE out_trade_no='otrf'`);
    expect(po.rows[0].status).toBe('refunded');
    const sub = await query(`SELECT status FROM crm.tenant_subscription WHERE online_order_no='otrf'`);
    expect(sub.rows[0].status).toBe('grace');
  });
  test('requestRefund 非 paid 订单 → 拒绝', async () => {
    const r = await requestRefund({ outTradeNo: 'nonexist', gatewayFn: async () => ({ status: 'SUCCESS' }) });
    expect(r.ok).toBe(false);
  });
});

describe('reconcile', () => {
  test('runReconcile（mock 账单）写差异表', async () => {
    const diff = [{ out_trade_no: 'x1', kind: 'missing_local', amount: '99.00' }];
    const r = await runReconcile({ fetchBillFn: async () => diff, period: '2026-09' });
    expect(r.written).toBe(1);
    const rows = await query(`SELECT * FROM crm.billing_reconcile_diff WHERE period='2026-09'`);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
  });
});
