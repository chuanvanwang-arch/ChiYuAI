// test/integration/insmedi-sales-user.test.js
// 验证 Runbook「最终交付物」：讲师资源型渠道中介行业初始销售员的用户名+密码可登录、且租户隔离正确。
import { describe, it, expect, beforeAll } from 'vitest';
import { seedInsMediProfile } from '../../db/seed/tenant-profile-insmedi.js';
import {
  seedInsMediSalesUser,
  INSMEDI_INITIAL_SALES_USERNAME,
  INSMEDI_INITIAL_SALES_PASSWORD,
} from '../../db/seed/tenant-users-insmedi.js';
import { login } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

describe('讲师资源型渠道中介行业初始销售员（Runbook 最终交付物）', () => {
  beforeAll(async () => {
    await seedInsMediProfile('acme-insmedi'); // Runbook §2：先写 tenant-profile
    await seedInsMediSalesUser('acme-insmedi'); // Runbook §10：再建初始销售员
  });

  it('初始凭据可登录，role=sales 且 tenantId=acme-insmedi', async () => {
    const r = await login({ username: INSMEDI_INITIAL_SALES_USERNAME, password: INSMEDI_INITIAL_SALES_PASSWORD });
    expect(r.ok).toBe(true);
    expect(r.role).toBe('sales');
    expect(r.tenantId).toBe('acme-insmedi'); // token 正确携带讲师资源型渠道中介租户，跨租户隔离
    expect(r.display_name).toBe('讲师资源型渠道中介行业初始销售员');
  });

  it('错误密码被拒', async () => {
    const r = await login({ username: INSMEDI_INITIAL_SALES_USERNAME, password: 'wrong-pass' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('讲师资源型渠道中介账号与 crm 租户账号零交叉（username 唯一 + tenant 隔离）', async () => {
    const alice = await login({ username: 'alice', password: 'secret123' });
    expect(alice.ok).toBe(true);
    expect(alice.tenantId).toBe('system'); // crm 平台引导账号属 system 租户
    // 讲师资源型渠道中介销售员行确属 acme-insmedi，不在 system
    const { rows } = await query(
      `SELECT tenant_id FROM crm.crm_users WHERE username=$1`, [INSMEDI_INITIAL_SALES_USERNAME]);
    expect(rows[0].tenant_id).toBe('acme-insmedi');
  });

  it('初始用户名/密码即交付物值', () => {
    // 锁定 Runbook 文档与代码一致：交付物就是这两个常量
    expect(INSMEDI_INITIAL_SALES_USERNAME).toBe('insmedi_sales01');
    expect(INSMEDI_INITIAL_SALES_PASSWORD).toBe('Insmedi@2026!');
  });
});
