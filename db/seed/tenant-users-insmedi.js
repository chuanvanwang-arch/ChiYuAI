// db/seed/tenant-users-insmedi.js
// 讲师资源型渠道中介行业租户「初始销售员」引导账号 —— 与"新行业上线 Runbook §10"的最终交付物对齐。
// 范式：与 db/seed-users.sql 一致（pgcrypto crypt + gen_salt('bf') 哈希，明文永不出库）。
// 幂等：username 唯一，已存在则跳过。tenant_id 锁定 acme-insmedi，与 tenant-profile 画像同源隔离。
// 注意：此为「初始/引导」账号，首次登录后应由用户自行改密（平台无强制改密流程，交付时须口头/书面提示）。
import { queryWrite } from '../../src/db.js';
import { INSMEDI_TENANT } from './tenant-profile-insmedi.js';

// 初始销售员凭据（交付物）：用户名 + 初始密码
export const INSMEDI_INITIAL_SALES_USERNAME = 'insmedi_sales01';
export const INSMEDI_INITIAL_SALES_PASSWORD = 'Insmedi@2026!';

export async function seedInsMediSalesUser(tenantId = INSMEDI_TENANT, { username = INSMEDI_INITIAL_SALES_USERNAME, password = INSMEDI_INITIAL_SALES_PASSWORD } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id)
     SELECT $1, crypt($2, gen_salt('bf')), 'sales', $3, $4, $5
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, '讲师资源型渠道中介行业初始销售员', tenantId, tenantId]
  );
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}
