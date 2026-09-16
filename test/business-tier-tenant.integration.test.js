// test/business-tier-tenant.integration.test.js
// 验证 id18 业务分级配置按 tenant_id 隔离读取（修复前：computeBusinessTier 无 tenant 过滤，
//   决策引擎跨租户混读全表 → 同名客户/项目被任一本租户高 tier 全局抬升 = 多租户纯度红线破坏）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../src/db.js';
import { computeBusinessTier } from '../src/decision/decisionRepo.js';
import { businessTierRepo } from '../src/portal/businessTier.js';

const TA = 'tier-iso-a';
const TB = 'tier-iso-b';
const PROBE = 'leak-probe'; // 仅本测试使用的唯一 dimension_value，避免污染 system 读取

beforeAll(async () => {
  // 两租户对同名客户配置**相反** tier：A=HIGH、B=LEAD。修复前两者会被 Math.max 混读抬升为 HIGH。
  await query(
    `INSERT INTO crm.business_tier_config (dimension, dimension_value, tier, scope, tenant_id)
     VALUES ('customer', $1, 'HIGH', 'tenant', $2), ('customer', $1, 'LEAD', 'tenant', $3)
     ON CONFLICT (tenant_id, dimension, dimension_value) DO UPDATE SET tier=EXCLUDED.tier`,
    [PROBE, TA, TB]
  );
});

afterAll(async () => {
  await query(`DELETE FROM crm.business_tier_config WHERE tenant_id IN ($1, $2)`, [TA, TB]);
});

describe('computeBusinessTier 跨租户隔离', () => {
  it('租户 A 读取仅命中 A 行（HIGH），不受 B 行（LEAD）影响', async () => {
    expect(await computeBusinessTier({ customer: PROBE, tenantId: TA })).toBe('HIGH');
  });

  it('租户 B 读取仅命中 B 行（LEAD），不被 A 行（HIGH）全局抬升', async () => {
    expect(await computeBusinessTier({ customer: PROBE, tenantId: TB })).toBe('LEAD');
  });

  it('缺省 tenantId=system → 不命中测试租户行（隔离生效，回退 null 而非泄漏 HIGH）', async () => {
    expect(await computeBusinessTier({ customer: PROBE })).toBe(null);
  });

  it('同租户两维取高风险优先（HIGH>NORMAL>LEAD）', async () => {
    // A 租户另加 project=critical=HIGH，与 customer=leak-probe=HIGH → 仍 HIGH
    await query(
      `INSERT INTO crm.business_tier_config (dimension, dimension_value, tier, scope, tenant_id)
       VALUES ('project', 'critical', 'HIGH', 'tenant', $1)
       ON CONFLICT (tenant_id, dimension, dimension_value) DO UPDATE SET tier=EXCLUDED.tier`,
      [TA]
    );
    expect(await computeBusinessTier({ customer: PROBE, project: 'critical', tenantId: TA })).toBe('HIGH');
  });
});

// ── A4 撤回 / 到期：把「可撤回」真正接到执行面上（2026-09-16 T21）──
// 这是本次改动**最关键的负向哨兵**：若 computeBusinessTier 漏了 revoked 过滤，
// "撤回"就退化成"只往表里写了个字段"——配置面显示已撤回、决策里照旧生效，
// 是最危险的一类假绿（看起来具备了撤回能力，实际没有）。
// 必须打真 DB：mock 只能证明 handler 调了函数，证明不了 SQL 过滤真的生效。
// 走的全是生产代码路径（businessTierRepo = 真实 deps），不是测试自己重写的 SQL。
const TC = 'tier-revoke-x';
const VC = 'revoke-probe';

describe('A4 撤回 / 到期对自主边界判定生效（负向哨兵）', () => {
  beforeAll(async () => {
    await query(`DELETE FROM crm.business_tier_config WHERE tenant_id=$1`, [TC]);
  });

  afterAll(async () => {
    await query(`DELETE FROM crm.business_tier_config WHERE tenant_id=$1`, [TC]);
    await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [TC]);
  });

  it('① 写入（过真实 upsertTier）→ 生效，且授权元数据落库（D2 修复证据）', async () => {
    const row = await businessTierRepo.upsertTier(
      'customer', VC, 'HIGH',
      { tenantId: TC, username: 'alice' }, { decisionId: 'dec-verify-a4' }
    );
    expect(await computeBusinessTier({ customer: VC, tenantId: TC })).toBe('HIGH'); // 正向基线
    // 修复前：决策产生了但只回显不落库 → 这两行断言必然失败
    expect(row.decision_id).toBe('dec-verify-a4');
    expect(row.approved_by).toBe('alice');
    expect(row.approved_at).toBeTruthy();
  });

  it('② 撤回后 → 不再参与判定（负向判据：必须变 null）', async () => {
    const row = await businessTierRepo.revokeTier(
      'customer', VC, '测试撤回', { tenantId: TC, username: 'alice' }, { decisionId: 'dec-revoke' }
    );
    expect(row.revoked_at).toBeTruthy();
    expect(await computeBusinessTier({ customer: VC, tenantId: TC })).toBe(null);
  });

  it('②b 撤回不得洗掉批准溯源（decision_id 仍是批准那次，不是撤回来的）', async () => {
    const r = await query(
      `SELECT decision_id, approved_by, revoked_reason FROM crm.business_tier_config
        WHERE tenant_id=$1 AND dimension='customer' AND dimension_value=$2`,
      [TC, VC]
    );
    expect(r.rows[0].decision_id).toBe('dec-verify-a4');
    expect(r.rows[0].approved_by).toBe('alice');
    expect(r.rows[0].revoked_reason).toBe('测试撤回');
  });

  it('③ 重复撤回幂等 → 返回 null（不报错、不重复写）', async () => {
    expect(await businessTierRepo.revokeTier('customer', VC, 'x', { tenantId: TC, username: 'alice' })).toBe(null);
  });

  it('④ 重新保存 = 复活（零 DELETE 下恢复生效的唯一途径）', async () => {
    const row = await businessTierRepo.upsertTier(
      'customer', VC, 'NORMAL', { tenantId: TC, username: 'bob' }, { decisionId: 'dec-reapprove' }
    );
    expect(row.revoked_at).toBe(null);
    expect(row.approved_by).toBe('bob'); // 新的批准人接管，审计面不会停在旧人身上
    expect(await computeBusinessTier({ customer: VC, tenantId: TC })).toBe('NORMAL');
  });

  it('⑤ 到期 → 不参与判定；未到期对照 → 正常参与（防"假通过")', async () => {
    await businessTierRepo.upsertTier(
      'customer', VC, 'HIGH', { tenantId: TC, username: 'bob' },
      { decisionId: 'dec-expired', expiresAt: '2020-01-01T00:00:00Z' }
    );
    expect(await computeBusinessTier({ customer: VC, tenantId: TC })).toBe(null);
    // 同族负向对照：证明上一条的 null 来自"过期"而不是别的偶然原因
    await businessTierRepo.upsertTier(
      'customer', VC, 'HIGH', { tenantId: TC, username: 'bob' },
      { decisionId: 'dec-future', expiresAt: '2099-01-01T00:00:00Z' }
    );
    expect(await computeBusinessTier({ customer: VC, tenantId: TC })).toBe('HIGH');
  });
});
