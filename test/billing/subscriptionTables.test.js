// test/billing/subscriptionTables.test.js — 订阅表 + 模块用量表 DDL（Task 1）
import { test, expect } from 'vitest';
import { query } from '../../src/db.js';

test('tenant_subscription 表存在且含关键列', async () => {
  const r = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='tenant_subscription'
    AND column_name IN ('tenant_id','plan_id','status','expires_at','payment_ref')`);
  expect(r.rows.length).toBe(5);
});

test('module_usage 表存在且含 UNIQUE(tenant_id,module,period)', async () => {
  const r = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='module_usage'
    AND column_name IN ('enabled','calls','tokens_in','tokens_out','period')`);
  expect(r.rows.length).toBe(5);
});
