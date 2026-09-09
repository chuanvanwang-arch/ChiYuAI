import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { query, queryWrite } from '../../src/db.js';
import { ensureDefaultSubscription } from '../../src/billing/subscriptionService.js';

const T = 'test_free_sub_' + Date.now();
const T_HAS = 'test_free_has_' + Date.now();
const T_PROV = 'test_free_prov_' + Date.now();

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT DO NOTHING`, [T]);
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT DO NOTHING`, [T_HAS]);
  // T_HAS 已有 starter 订阅 → 模拟「已定义订阅」
  await queryWrite(
    `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, started_at, expires_at, created_at, updated_at)
     VALUES ($1,'starter','active',now(),now()+interval '1 month',now(),now())`,
    [T_HAS]
  );
});

afterAll(async () => {
  // 仅清理本测试在 crm_native_test 创建的临时数据，绝不触碰生产库
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id IN ($1,$2,$3)`, [T, T_HAS, T_PROV]);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id IN ($1,$2,$3)`, [T, T_HAS, T_PROV]);
});

function diffMonths(expires, started) {
  return Math.round((new Date(expires) - new Date(started)) / (1000 * 60 * 60 * 24 * 30));
}

describe('ensureDefaultSubscription', () => {
  it('无订阅租户 → 插入 free/active 且周期 3 月', async () => {
    const r = await ensureDefaultSubscription(T);
    assert.strictEqual(r.created, true);
    const rows = await query(`SELECT plan_id,status,started_at,expires_at FROM crm.tenant_subscription WHERE tenant_id=$1`, [T]);
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0].plan_id, 'free');
    assert.strictEqual(rows.rows[0].status, 'active');
    assert.ok(Math.abs(diffMonths(rows.rows[0].expires_at, rows.rows[0].started_at) - 3) <= 1, 'expires 应为 started+约3月');
  });

  it('重跑幂等 → 不新增', async () => {
    const r = await ensureDefaultSubscription(T);
    assert.strictEqual(r.created, false);
    const rows = await query(`SELECT count(*)::int n FROM crm.tenant_subscription WHERE tenant_id=$1`, [T]);
    assert.strictEqual(rows.rows[0].n, 1);
  });

  it('已有 starter 订阅 → 不插 free', async () => {
    const r = await ensureDefaultSubscription(T_HAS);
    assert.strictEqual(r.created, false);
    const rows = await query(`SELECT plan_id FROM crm.tenant_subscription WHERE tenant_id=$1`, [T_HAS]);
    assert.ok(rows.rows.every(x => x.plan_id !== 'free'), '不应插入 free 行');
  });

  it('provisionTenant 开通新租户 → 自动获 free/active 订阅', async () => {
    const { provisionTenant } = await import('../../db/seed/tenantDefaults.js');
    await provisionTenant(T_PROV, { all: true });
    const rows = await query(`SELECT plan_id,status FROM crm.tenant_subscription WHERE tenant_id=$1`, [T_PROV]);
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0].plan_id, 'free');
    assert.strictEqual(rows.rows[0].status, 'active');
  });
});
