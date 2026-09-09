// db/seed/tenant-users-meddev.js
// 新行业上线 Runbook · Step 5：医疗器械行业初始销售员账号（最终交付物）。
// 账号落 crm.crm_users，tenant_id=acme-meddev；pgcrypto crypt 哈希，明文永不出库/不写日志。
// 幂等（WHERE NOT EXISTS）；生产环境应经 user-rbac-admin 通道落库并强制首登改密。
import { pathToFileURL } from 'url';
import { queryWrite } from '../../src/db.js';
import { MEDDEV_TENANT } from './tenant-profile-meddev.js';

export const MEDDEV_INITIAL_SALES_USERNAME = 'meddev_sales01';
export const MEDDEV_INITIAL_SALES_PASSWORD = 'Meddev@2026!'; // 初始密码，交付后须改密

export async function seedMeddevSalesUser(tenantId = MEDDEV_TENANT,
  { username = MEDDEV_INITIAL_SALES_USERNAME, password = MEDDEV_INITIAL_SALES_PASSWORD } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id, enabled, activated)
     SELECT $1, crypt($2, gen_salt('bf')), 'sales', $3, $4, $5, true, true
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, '医疗器械行业初始销售员', tenantId, tenantId]
  );
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}

// Windows 适配（2026-09-09 实践实证）：win32 下 import.meta.url 与 process.argv[1]
// 在盘符大小写/路径分隔符上不一致，裸比较永不成立 → 直跑静默无操作。
// 归一化守卫范式：scripts/seed-tenant-master-data.mjs:116-118
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  seedMeddevSalesUser().then((n) => { console.log('seeded meddev sales user, inserted=', n); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
