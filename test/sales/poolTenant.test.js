// test/sales/poolTenant.test.js — pool-config 租户隔离（G4）
// 设计：docs/2026-09-05-tenant-config-full-isolation-design.md §A-4
// 语义：池配置挂在 CRM_ORGANIZATION 粒子 payload.pool_config；读/写都必须限定 tenant_id（scopeTenant/scopeOf）。
// 2026-09-05：既有实现 getPoolConfig 查无租户限定、setPoolConfig UPDATE 无 tenant 条件、routes 硬编码 system → 全局共享。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPoolConfig, setPoolConfig, DEFAULT_POOL_CONFIG } from '../../src/sales/pool.js';
import { queryWrite } from '../../src/db.js';

const SYS_TENANT = 'system';
const T = 'e2e-tenant-pool';
const ORG = 'org-hq';

// 为 system 与租户 T 各建组织粒子（幂等；真实业务缺粒子时 getPoolConfig 回默认）并清理 pool_config（测试隔离）
async function resetOrgs() {
  for (const [tenantId, idSuffix] of [[SYS_TENANT, 'sys'], [T, 't']]) {
    await queryWrite(
      `INSERT INTO crm.particles (id, slug, title, type, tenant_id, payload, state)
       SELECT $1::uuid, $2, $4, 'CRM_ORGANIZATION', $3, '{}'::jsonb, 'ACTIVE'
       ON CONFLICT DO NOTHING`,
      ['e9e2e000-0000-0000-0000-' + (idSuffix === 'sys' ? '0000000000a1' : '0000000000a2'), ORG, tenantId, ORG]
    ).catch(() => {});
    await queryWrite(
      `UPDATE crm.particles SET payload = payload - 'pool_config' WHERE slug=$1 AND type='CRM_ORGANIZATION' AND tenant_id=$2`,
      [ORG, tenantId]
    ).catch(() => {});
  }
}

describe('pool-config 租户隔离', () => {
  beforeAll(async () => {
    await resetOrgs();
  });

  it('租户写 pool 配置不污染 system（setPoolConfig 带 tenantId）', async () => {
    // system 组织先写基线
    await setPoolConfig(ORG, { pick_rule: { daily_limit: 5 } }, { tenantId: SYS_TENANT });
    // 租户写入不同值
    await setPoolConfig(ORG, { pick_rule: { daily_limit: 1 } }, { tenantId: T });
    const t = await getPoolConfig(ORG, { tenantId: T });
    expect(t.pick_rule.daily_limit).toBe(1);
    const s = await getPoolConfig(ORG, { tenantId: SYS_TENANT });
    expect(s.pick_rule.daily_limit).toBe(5);
  });

  it('缺少租户组织粒子 → 返回默认池配置（幂等补默认）', async () => {
    const cfg = await getPoolConfig(ORG, { tenantId: 'e2e-tenant-nopool' });
    expect(cfg.pick_rule.daily_limit).toBe(DEFAULT_POOL_CONFIG.pick_rule.daily_limit);
  });

  afterAll(async () => {
    // 清理测试残留（精确到测试租户；禁删铁律 → 只清 pool_config 键值，不删粒子行）
    await queryWrite(
      `UPDATE crm.particles SET payload = payload - 'pool_config' WHERE slug=$1 AND type='CRM_ORGANIZATION' AND tenant_id IN ($2,$3)`,
      [ORG, SYS_TENANT, T]
    ).catch(() => {});
  });
});
