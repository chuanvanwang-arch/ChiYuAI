// test/business-tier-tenant.integration.test.js
// 验证 id18 业务分级配置按 tenant_id 隔离读取（修复前：computeBusinessTier 无 tenant 过滤，
//   决策引擎跨租户混读全表 → 同名客户/项目被任一本租户高 tier 全局抬升 = 多租户纯度红线破坏）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../src/db.js';
import { computeBusinessTier } from '../src/decision/decisionRepo.js';

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
