// db/seed/tenant-users-consult2.js
// 新行业上线 Runbook · Step 5：企业管理咨询行业第二家租户（acme-consult2）初始销售员账号。
// 账号落 crm.crm_users，tenant_id=acme-consult2；pgcrypto crypt 哈希，明文永不出库/不写日志。
// 幂等（WHERE NOT EXISTS）；生产环境应经 user-rbac-admin 通道落库并强制首登改密。
import { pathToFileURL } from 'url';
import { queryWrite } from '../../src/db.js';

export const CONSULT2_INITIAL_SALES_USERNAME = 'consult2_sales01';
export const CONSULT2_INITIAL_SALES_PASSWORD = 'Consult2@2026!'; // 初始密码，交付后须改密

export async function seedConsult2SalesUser(tenantId,
  { username = CONSULT2_INITIAL_SALES_USERNAME, password = CONSULT2_INITIAL_SALES_PASSWORD } = {}) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id, enabled, activated)
     SELECT $1, crypt($2, gen_salt('bf')), 'sales', $3, $4, $5, true, true
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, '企业管理咨询行业初始销售员（第二租户）', tenantId, tenantId]
  );
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}

export const CONSULT2_ZHANGQIANG_USERNAME = 'zhangqiang';
export const CONSULT2_ZHANGQIANG_PASSWORD = 'Zhangqiang@2026!'; // 初始密码，交付后须改密
export const CONSULT2_LILI_USERNAME = 'lili';
export const CONSULT2_LILI_PASSWORD = 'Lili@2026!'; // 初始密码，交付后须改密

// 通用租户用户播种（幂等）：按指定 role 落 crm.crm_users
export async function seedConsult2User(tenantId,
  { username, password, role, displayName } = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!username || !password || !role) throw new Error('username/password/role are required');
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id, enabled, activated)
     SELECT $1, crypt($2, gen_salt('bf')), $3, $4, $5, $6, true, true
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, role, displayName, tenantId, tenantId]
  );
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}

export async function seedConsult2Zhangqiang(tenantId) {
  return seedConsult2User(tenantId, {
    username: CONSULT2_ZHANGQIANG_USERNAME,
    password: CONSULT2_ZHANGQIANG_PASSWORD,
    role: 'sales',
    displayName: '张强（企业管理咨询2·销售）',
  });
}

export async function seedConsult2Lili(tenantId) {
  return seedConsult2User(tenantId, {
    username: CONSULT2_LILI_USERNAME,
    password: CONSULT2_LILI_PASSWORD,
    role: 'finance',
    displayName: '李莉（企业管理咨询2·财务）',
  });
}

// Windows 适配（2026-09-09 实践实证）：win32 下 import.meta.url 与 process.argv[1]
// 在盘符大小写/路径分隔符上不一致，裸比较永不成立 → 直跑静默无操作。
// 归一化守卫范式：scripts/seed-tenant-master-data.mjs:116-118
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  const tenantId = process.argv[2];
  if (!tenantId) { console.error('Usage: node db/seed/tenant-users-consult2.js <tenantId>'); process.exit(1); }
  seedConsult2SalesUser(tenantId).then((n) => { console.log('seeded consult2 sales user, inserted=', n); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
