// db/seed/tenant-users-consult.js
// 新行业上线 Runbook · Step 5：企业管理咨询行业初始销售员账号（最终交付物）。
// 账号落 crm.crm_users，tenant_id=acme-consult；pgcrypto crypt 哈希，明文永不出库/不写日志。
// 幂等（WHERE NOT EXISTS）；生产环境应经 user-rbac-admin 通道落库并强制首登改密。
import { queryWrite } from '../../src/db.js';
import { CONSULT_TENANT } from './tenant-profile-consult.js';

export const CONSULT_INITIAL_SALES_USERNAME = 'consult_sales01';
export const CONSULT_INITIAL_SALES_PASSWORD = 'Consult@2026!'; // 初始密码，交付后须改密

export async function seedConsultSalesUser(tenantId = CONSULT_TENANT,
  { username = CONSULT_INITIAL_SALES_USERNAME, password = CONSULT_INITIAL_SALES_PASSWORD } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id, enabled, activated)
     SELECT $1, crypt($2, gen_salt('bf')), 'sales', $3, $4, $5, true, true
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, '企业管理咨询行业初始销售员', tenantId, tenantId]
  );
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedConsultSalesUser().then((n) => { console.log('seeded consult sales user, inserted=', n); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
