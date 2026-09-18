// src/rbac.js — RBAC 辅助：经销商联邦闸 + 平台责任 sysadmin 归属
import { query } from './db.js';
import { readConfig as _readConfig } from './config/configStore.js';

// 平台级 kill-switch：feature:dealer-portal.enabled（默认 false，新租户不自动开）
export async function isFeatureOn({ readConfig = _readConfig } = {}) {
  const row = await readConfig('feature:dealer-portal', { tenantId: 'system' });
  return !!(row && row.value && row.value.enabled === true);
}

// canManageDealers(actor, vendorTenant):
//   仅厂商租户的 channel_manager / ten_admin 可管经销商；功能总闸关闭 → false；跨租户 → false。
export async function canManageDealers(actor, vendorTenant, { readConfig = _readConfig } = {}) {
  if (!actor) return false;
  if (!(await isFeatureOn({ readConfig }))) return false;
  const role = actor.role || (Array.isArray(actor.roles) ? actor.roles[0] : null);
  if (role !== 'channel_manager' && role !== 'ten_admin') return false;
  if (actor.tenantId && vendorTenant && actor.tenantId !== vendorTenant) return false;
  return true;
}

// resolveSysadminRef(identifier):
//   identifier: 用户名或邮箱（大小写/前后空格归一化）
//   返回 { user_id, username: display_name }（username 字段承载 display_name），或 null
export async function resolveSysadminRef(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return null;
  const { rows } = await query(
    `SELECT user_id, display_name FROM crm.crm_users
     WHERE (lower(username)=$1 OR lower(email)=$1) AND role='sysadmin'`,
    [id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { user_id: r.user_id, username: r.display_name };
}
