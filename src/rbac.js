// src/rbac.js — RBAC 辅助：解析平台责任 sysadmin 归属（设计 §D2）
// 解析 用户名/邮箱 → 一个已存在的 role='sysadmin' 用户；非 sysadmin / 不存在均返回 null。
import { query } from './db.js';

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
