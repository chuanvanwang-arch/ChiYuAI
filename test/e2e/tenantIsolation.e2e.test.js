// test/e2e/tenantIsolation.e2e.test.js — 租户设置完全隔离 E2E（2026-09-05 用户裁决「完全独立不共享」）
// 详细设计 docs/superpowers/plans/2026-09-05-tenant-config-full-isolation.md Task 8 Step 1
// 验证核心闭环：① 租户 A/B 播 8 键全量；② A 改销售阈值 → B 读回原值（互不污染）；
//           ③ 缺键 autoSeed 落租户（_seeded 标记）；④ 权限：写按 scopeOf（永不通配）、读按 scopeTenant
// 清理：只删本测试创建的租户 A/B（禁 DELETE 铁律适用生产业务数据；测试自有数据可清理）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/config/configStore.js';
import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js';
import { queryWrite } from '../../src/db.js';
import { scopeTenant, scopeOf } from '../../src/http/tenantScope.js';

const A = 'e2e-iso-a';
const B = 'e2e-iso-b';

beforeAll(async () => {
  // 幂等清理上次运行残留（禁 DELETE 铁律不适用：本测试自有租户，仅删本测试创建的行）
  await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id IN ($1,$2)`, [A, B]).catch(() => {});
  await seedTenantDefaults(A, { all: true });
  await seedTenantDefaults(B, { all: true });
});

afterAll(async () => {
  // 清理测试租户行（自产自销，不触碰其它租户）
  await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id IN ($1,$2)`, [A, B]).catch(() => {});
});

describe('租户设置完全隔离 E2E', () => {
  it('租户 A 改销售阈值 → 租户 B 读回原值（互不污染）', async () => {
    await writeConfig('sales-thresholds', { bantcc: { pass: 0.999 } }, { tenantId: A, decisionId: null });
    const a = await readConfig('sales-thresholds', { tenantId: A });
    const b = await readConfig('sales-thresholds', { tenantId: B });
    expect(a.value.bantcc.pass).toBe(0.999);
    expect(b.value.bantcc.pass).not.toBe(0.999);
  });

  it('租户缺键 autoSeed 后完全自有（含 _seeded 标记）', async () => {
    // 用未播种的全新租户 C（不触发 beforeAll 的 seed 8 键）→ 读缺键触发 autoSeed 落 C 行 + _seeded 标记
    const C = 'e2e-iso-c-fresh';
    const c = await readConfig('approval-config', { tenantId: C });
    expect(c.value._seeded).toBe('system-template');
  });

  it('8 键全量播种：A 与 B 各自独立行存在', async () => {
    const keys = await queryWrite(
      `SELECT key FROM crm.config_store WHERE tenant_id=$1 ORDER BY key`,
      [A]
    );
    // 8 键契约（2026-09-05 用户裁决含 context-routing）
    expect(keys.rows.length).toBeGreaterThanOrEqual(8);
    const ks = keys.rows.map((r) => r.key);
    for (const k of ['sales-thresholds', 'named-account-targets', 'approval-config',
      'behavior-standard', 'finance-receivables', 'decision-retro',
      'agent-event-trigger', 'context-routing']) {
      expect(ks).toContain(k);
    }
  });

  it('权限闭环：admin 读通配 '*' 视界（system 模板），写按自身租户（scopeOf）', () => {
    const admin = { role: 'admin', tenantId: 'system' };
    const sales = { role: 'sales', tenantId: 'acme-chem' };
    expect(scopeTenant(admin)).toBe('*');
    expect(scopeOf(admin)).toBe('system');
    expect(scopeTenant(sales)).toBe('acme-chem');
    expect(scopeOf(sales)).toBe('acme-chem');
  });
});
