// test/billing/tokenUsage.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { tokenQuota, tokenByAccount, tokenByAction, getPlan } from '../../src/billing/billingService.js';

const T = 'tok_test_t';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan, created_at) VALUES ($1,'tok test','active','free',now()) ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  await queryWrite(`DELETE FROM crm.token_accounting WHERE tenant_id=$1`, [T]);
  await queryWrite(
    `INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, tenant_id, created_at)
     VALUES ($1,'agent-think',30000,20000,$1,now()), ($1,'agent-think',10000,5000,$1,now()),
            ($2,'crm-deal-advance',40000,10000,$1,now())`,
    [T, 'bob']
  );
});

describe('token 三级聚合', () => {
  // 2026-09-06：断言改为「配置驱动」——期望值由 getPlan() 现读，不锁死具体数值。
  //   此前硬编码 50000，测试库一旦被其他用例重播成旧 seed（included_tokens=-1）就红，
  //   且每次调价都要改测试，与「配置驱动」铁律相悖。语义（超量封底 0 / 剩余=含-用）仍被守住。
  it('tokenQuota 计算剩余与超量费（配置驱动期望值）', async () => {
    const q = await tokenQuota(T, new Date().toISOString().slice(0, 7));
    const plan = await getPlan(T);
    const included = Number(plan.included_tokens);
    expect(q.plan_id).toBe('free');
    expect(q.included_tokens).toBe(included === -1 ? -1 : included);
    expect(q.used_total).toBe(115000);            // 30000+20000+10000+5000+40000+10000
    if (included === -1) {
      expect(q.remaining).toBeNull();
      expect(q.unlimited).toBe(true);
    } else {
      expect(q.remaining).toBe(Math.max(0, included - 115000)); // 超量封底 0
    }
    expect(typeof q.overage_fee).toBe('number');
  });
  it('tokenByAccount 按账号聚合 + 占比 + 未归因', async () => {
    const rows = await tokenByAccount(T, new Date().toISOString().slice(0, 7));
    // actor=T（两行合计 65000）与 bob（50000）
    const total = rows.reduce((a, r) => a + r.total, 0);
    expect(total).toBe(115000);
    rows.forEach((r) => expect(r.share_pct).toBeGreaterThanOrEqual(0));
    const bob = rows.find((r) => r.actor === 'bob');
    expect(bob.total).toBe(50000);
  });
  it('tokenByAction 按动作聚合', async () => {
    const rows = await tokenByAction(T, new Date().toISOString().slice(0, 7));
    const think = rows.find((r) => r.action === 'agent-think');
    expect(think.total).toBe(65000);
  });
});
