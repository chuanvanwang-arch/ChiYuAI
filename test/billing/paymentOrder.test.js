// test/billing/paymentOrder.test.js — payment_order 表 + online_order_no 锚点（需 PG）
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ('__po','__po','active','pro') ON CONFLICT (tenant_id) DO UPDATE SET plan='pro'`);
});
afterAll(async () => {
  await queryWrite(`DELETE FROM crm.payment_order WHERE tenant_id='__po'`);
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id='__po'`);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id='__po'`);
});

describe('payment_order', () => {
  test('INSERT pending 订单 + out_trade_no 唯一', async () => {
    const r = await queryWrite(
      `INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, provider, amount, status)
       VALUES ('o1','ot1','__po','pro','wechat',99.00,'pending') RETURNING id`, []);
    expect(r.rows[0].id).toBeTruthy();
    await expect(queryWrite(
      `INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, provider, amount, status)
       VALUES ('o2','ot1','__po','pro','wechat',99.00,'pending')`, [])).rejects.toThrow();
  });
  test('tenant_subscription.online_order_no 锚点可写', async () => {
    const r = await queryWrite(
      `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at, online_order_no)
       VALUES ('__po','pro','active', now()+interval '1 month','ot1') RETURNING online_order_no`, []);
    expect(r.rows[0].online_order_no).toBe('ot1');
  });
});
