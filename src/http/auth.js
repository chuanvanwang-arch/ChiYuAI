// src/http/auth.js — 最小可行认证（HMAC 自签 token，复用 Node 内置 crypto）
import crypto from 'node:crypto';
import { query } from '../db.js';

const SECRET = process.env.PORTAL_JWT_SECRET || 'crm-portal-dev-secret';

export function issueToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('bad signature');
  }
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { throw new Error('bad payload'); }
}

export function extractToken(req) {
  const h = req.headers?.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function login({ username, password } = {}) {
  if (!username || !password) return { ok: false, status: 400, error: 'username and password required' };
  // 登录闸：仅启用且未过期的账号可登录（冻结/有效期经用户管理页设置，NULL=永久）
  // 支持用户名或邮箱双登录标识（email 列由 migration-login-email-column.sql 维护）
  const { rows } = await query(
    `SELECT username, password_hash, role, display_name, tenant_id, activated
     FROM crm.crm_users
     WHERE (username=$1 OR email=$1) AND enabled IS TRUE AND (expires_at IS NULL OR expires_at > now())`, [username]);
  if (!rows.length) return { ok: false, status: 401, error: 'invalid credentials（账号不存在/已禁用/已过期）' };
  const u = rows[0];
  // 激活闸（2026-09-04 注册闭环）：自助注册账号未激活前禁止登录
  if (u.activated === false) return { ok: false, status: 401, error: '账号未激活，请先通过邮箱/手机激活后再登录' };
  // 租户停用闸（T9，V10）：suspended/retired 租户拒绝登录（401），数据保留
  const tRes = await query(
    `SELECT status FROM crm.tenants WHERE tenant_id=$1`, [u.tenant_id || 'system']
  ).catch(() => ({ rows: [] }));
  const tStatus = tRes.rows[0]?.status || 'active'; // 注册表缺失 → 放行（存量兼容，fail-open）
  if (tStatus !== 'active') return { ok: false, status: 401, error: 'invalid credentials（租户已停用）' };
  const { rows: v } = await query(`SELECT crypt($1, $2) = $2 AS ok`, [password, u.password_hash]);
  if (!v[0].ok) return { ok: false, status: 401, error: 'invalid credentials' };
  const token = issueToken({ username: u.username, role: u.role, display_name: u.display_name, tenantId: u.tenant_id || 'system' });
  return { ok: true, status: 200, token, role: u.role, display_name: u.display_name, tenantId: u.tenant_id || 'system' };
}

export function resolveMe(req) {
  const token = extractToken(req);
  if (!token) return { ok: false, status: 401, error: 'missing token' };
  try {
    const p = verifyToken(token);
    // hasExplicitTenant：token 里**是否真的带了** tenantId。
    //   必需性（2026-09-18）：`tenantId` 对缺失情形兜底为 'system'，使调用方**无法区分**
    //   「显式 system 租户」与「压根没带租户」。二者语义相反（前者是合法租户、后者应 fail-closed），
    //   合流后只能一刀切 —— 正是 `routes.js:1285` 原写法（`!me.tenantId || me.tenantId === 'system'`）
    //   把 system 租户的销售也拦掉、导致公海认领闭环不可用的根因。
    return { ok: true, status: 200, role: p.role, display_name: p.display_name, username: p.username, tenantId: p.tenantId || 'system', hasExplicitTenant: !!p.tenantId };
  } catch {
    return { ok: false, status: 401, error: 'invalid token' };
  }
}
