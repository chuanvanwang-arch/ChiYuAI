// test/integration/chemical-sales-user.test.js
// 验证 Runbook「最终交付物」：化工行业初始销售员的用户名+密码可登录、且租户隔离正确。
import { describe, it, expect, beforeAll } from 'vitest';
import { seedChemicalProfile } from '../../db/seed/tenant-profile-chemical.js';
import {
  seedChemicalSalesUser,
  CHEM_INITIAL_SALES_USERNAME,
  CHEM_INITIAL_SALES_PASSWORD,
} from '../../db/seed/tenant-users-chemical.js';
import { login } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

describe('化工行业初始销售员（Runbook 最终交付物）', () => {
  beforeAll(async () => {
    await seedChemicalProfile('acme-chem'); // Runbook §2：先写 tenant-profile
    await seedChemicalSalesUser('acme-chem'); // Runbook §10：再建初始销售员
  });

  it('初始凭据可登录，role=sales 且 tenantId=acme-chem', async () => {
    const r = await login({ username: CHEM_INITIAL_SALES_USERNAME, password: CHEM_INITIAL_SALES_PASSWORD });
    expect(r.ok).toBe(true);
    expect(r.role).toBe('sales');
    expect(r.tenantId).toBe('acme-chem'); // token 正确携带化工租户，跨租户隔离
    expect(r.display_name).toBe('化工行业初始销售员');
  });

  it('错误密码被拒', async () => {
    const r = await login({ username: CHEM_INITIAL_SALES_USERNAME, password: 'wrong-pass' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('化工账号与 crm 租户账号零交叉（username 唯一 + tenant 隔离）', async () => {
    const alice = await login({ username: 'alice', password: 'secret123' });
    expect(alice.ok).toBe(true);
    expect(alice.tenantId).toBe('system'); // crm 平台引导账号属 system 租户
    // 化工销售员行确属 acme-chem，不在 system
    const { rows } = await query(
      `SELECT tenant_id FROM crm.crm_users WHERE username=$1`, [CHEM_INITIAL_SALES_USERNAME]);
    expect(rows[0].tenant_id).toBe('acme-chem');
  });

  it('初始用户名/密码即交付物值', () => {
    // 锁定 Runbook 文档与代码一致：交付物就是这两个常量
    expect(CHEM_INITIAL_SALES_USERNAME).toBe('chem_sales01');
    expect(CHEM_INITIAL_SALES_PASSWORD).toBe('Chem@2026!');
  });
});
