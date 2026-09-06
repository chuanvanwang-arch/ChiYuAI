// db/seed/tenant-users-demo.js
// DEMO 演示租户「初始账号」引导 —— 与 tenant-users-training.js 完全同构。
// 范式：pgcrypto crypt + gen_salt('bf') 哈希，明文永不出库（对应 db/seed-users.sql）。
// 幂等：username 唯一，已存在则跳过。tenant_id 锁定 acme-demo，与 tenant-profile 同源隔离。
// 账号：admin（治理）/ sales（业务演示）/ manager（审批演示）。
import { queryWrite } from '../../src/db.js';
import { DEMO_TENANT } from './tenant-profile-demo.js';

export const DEMO_ADMIN_USERNAME = 'acme_demo_admin';
export const DEMO_ADMIN_PASSWORD = 'DemoAdmin@2026!';
export const DEMO_SALES_USERNAME = 'acme_demo_sales01';
export const DEMO_SALES_PASSWORD = 'DemoSales@2026!';
export const DEMO_MANAGER_USERNAME = 'acme_demo_manager';
export const DEMO_MANAGER_PASSWORD = 'DemoMgr@2026!';

export async function seedDemoUsers(tenantId = DEMO_TENANT) {
  const users = [
    { username: DEMO_ADMIN_USERNAME, password: DEMO_ADMIN_PASSWORD, role: 'admin', display: 'DEMO 平台管理员' },
    { username: DEMO_SALES_USERNAME, password: DEMO_SALES_PASSWORD, role: 'sales', display: 'DEMO 演示销售员' },
    { username: DEMO_MANAGER_USERNAME, password: DEMO_MANAGER_PASSWORD, role: 'manager', display: 'DEMO 审批经理' },
  ];
  let inserted = 0;
  for (const u of users) {
    const r = await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id, enabled)
       SELECT $1, crypt($2, gen_salt('bf')), $3, $4, $5, $6, true
       WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
      [u.username, u.password, u.role, u.display, tenantId, tenantId]
    );
    inserted += (r.rowCount ?? 0);
  }
  return inserted; // 新建行数（0=全已存在，幂等）
}
