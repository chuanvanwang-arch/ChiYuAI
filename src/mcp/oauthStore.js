// src/mcp/oauthStore.js — OAuth 持久化层（本项目 OAuth 相关 SQL 的唯一落点）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.3 / §3.6 / §4
//
// 铁律：
//   1) 绝对禁 DELETE —— 一次性消费用 CAS UPDATE（consumed_at / used_at），吊销用 revoked_at。
//   2) 授权码与 refresh token 只落 sha256 哈希，明文永不入库、永不进日志。
//   3) 所有函数 fail-closed：查不到 / 校验不过返回 null 或 { ok:false }，不做默认放行。
import { query, queryWrite } from '../db.js';

// ---------- 客户端（DCR 注册产物）----------
export async function insertClient({ clientId, clientName = null, redirectUris, grantTypes }) {
  const { rows } = await queryWrite(
    `INSERT INTO crm.oauth_client (client_id, client_name, redirect_uris, grant_types)
     VALUES ($1, $2, $3::jsonb, $4::jsonb)
     RETURNING client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method`,
    [clientId, clientName, JSON.stringify(redirectUris), JSON.stringify(grantTypes)]
  );
  return rows[0];
}

export async function getClient(clientId) {
  if (!clientId) return null;
  const { rows } = await query(
    `SELECT client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method,
            created_at, last_used_at, disabled_at
       FROM crm.oauth_client WHERE client_id = $1`, [clientId]);
  return rows[0] || null;
}

export async function touchClient(clientId) {
  await queryWrite(`UPDATE crm.oauth_client SET last_used_at = now() WHERE client_id = $1`, [clientId]);
}

// ---------- 登录凭据校验（语义对齐 src/mcp/auth.js:129 mcpLogin）----------
// 顺序有意调整：先校验密码，再报 enabled/activated/admin —— 避免「未证明密码」阶段就泄漏账号状态。
export async function verifyUser({ username, password } = {}) {
  const GENERIC = '账号或密码不正确';
  if (!username || !password) return { ok: false, message: '请输入账号与密码' };
  const { rows } = await query(
    `SELECT username, password_hash, role, display_name, enabled, activated, tenant_id
       FROM crm.crm_users WHERE username = $1`, [username]);
  if (!rows.length) return { ok: false, message: GENERIC };
  const u = rows[0];
  const { rows: v } = await query(`SELECT crypt($1, $2) = $2 AS ok`, [password, u.password_hash]);
  if (!v[0].ok) return { ok: false, message: GENERIC };
  // 以下判定发生在密码已验证之后，不构成用户名枚举面
  if (u.enabled === false) return { ok: false, message: '账号已禁用' };
  if (u.activated === false) return { ok: false, message: '账号尚未激活，请先通过邮箱/手机激活后再登录 MCP' };
  if (u.role === 'admin') {
    return { ok: false, message: 'admin 仅限 HTTP 后台；请以业务账号(sales/manager/presales/exec/finance/contract_admin)登录 MCP' };
  }
  return { ok: true, username: u.username, role: u.role, display_name: u.display_name, tenant_id: u.tenant_id || 'system' };
}

// ---------- 授权码（一次性，CAS 消费）----------
// ⚠ 过期时刻一律由 DB 时钟推进：now() + ttlMs。禁止用 Node 的 new Date(Date.now()+ttlMs)。
//   原因（2026-09-15 实测）：本机 PG 时钟比宿主 Node 时钟快 139s（Node 12:27:31Z / DB 12:29:50Z）。
//   若写入用 Node 时钟、判定用 DB 时钟（consumeCode 的 expires_at > now()），TTL 会被静默吃掉偏差量，
//   60s 的测试 TTL 直接「出生即过期」。写入与读取共用 DB 时钟 = 单一事实源，天然免疫时钟偏差。
export async function insertCode({ codeHash, clientId, actor, tenantId = 'system', roleTag, redirectUri, codeChallenge, scope = 'mcp', ttlMs }) {
  await queryWrite(
    `INSERT INTO crm.oauth_code
       (code_hash, client_id, actor, tenant_id, role_tag, redirect_uri, code_challenge, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9::bigint * interval '1 millisecond'))`,
    [codeHash, clientId, actor, tenantId, roleTag, redirectUri, codeChallenge, scope, ttlMs]
  );
}

// 只读，不消费 —— 供 router 先校验 client_id / redirect_uri 再消费，避免「参数不符却烧掉码」
export async function getCode(codeHash) {
  if (!codeHash) return null;
  const { rows } = await query(
    `SELECT code_hash, client_id, actor, tenant_id, role_tag, redirect_uri, code_challenge,
            code_challenge_method, scope, expires_at, consumed_at
       FROM crm.oauth_code WHERE code_hash = $1`, [codeHash]);
  return rows[0] || null;
}

// CAS 原子消费：consumed_at IS NULL 是唯一守卫，并发双请求只有一个能 RETURNING 到行
export async function consumeCode(codeHash) {
  const { rows } = await queryWrite(
    `UPDATE crm.oauth_code SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING code_hash, client_id, actor, tenant_id, role_tag, redirect_uri, scope`,
    [codeHash]);
  return rows[0] || null;
}

// ---------- refresh token（轮转链）----------
// 同 insertCode：expires_at 由 DB 时钟推进（now() + ttlMs），与 markRefreshUsed 的 expires_at > now() 同源。
export async function insertRefresh({ tokenHash, clientId, actor, tenantId = 'system', roleTag, scope = 'mcp', chainId = null, ttlMs }) {
  const { rows } = await queryWrite(
    `INSERT INTO crm.oauth_refresh
       (token_hash, client_id, actor, tenant_id, role_tag, scope, chain_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::uuid, gen_random_uuid()),
             now() + ($8::bigint * interval '1 millisecond'))
     RETURNING chain_id`,
    [tokenHash, clientId, actor, tenantId, roleTag, scope, chainId, ttlMs]);
  return rows[0];
}

export async function getRefresh(tokenHash) {
  if (!tokenHash) return null;
  // expired 由 DB 时钟判定（校准 C4）：调用方不得用 Node 时钟与 expires_at 相比，
  // 否则时钟偏差会把仍有效的 token 误判为过期（或反之）。持久化层是唯一知道可信「现在」的地方。
  const { rows } = await query(
    `SELECT token_hash, client_id, actor, tenant_id, role_tag, scope, chain_id,
            rotated_to, expires_at, used_at, revoked_at,
            (expires_at <= now()) AS expired
       FROM crm.oauth_refresh WHERE token_hash = $1`, [tokenHash]);
  return rows[0] || null;
}

// CAS 轮转：used_at IS NULL AND revoked_at IS NULL AND 未过期 三者同时成立才成功。
// 返回 null 即「已被轮转 / 已吊销 / 已过期 / 并发竞争失败」——调用方一律按 invalid_grant 处理。
export async function markRefreshUsed(tokenHash, rotatedToHash) {
  const { rows } = await queryWrite(
    `UPDATE crm.oauth_refresh SET used_at = now(), rotated_to = $2
      WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING chain_id, client_id, actor, tenant_id, role_tag, scope`,
    [tokenHash, rotatedToHash]);
  return rows[0] || null;
}

// 整链吊销：一次 UPDATE 覆盖 chain 上所有未吊销行（重放检测的处置动作）
export async function revokeChain(chainId) {
  if (!chainId) return 0;
  const { rowCount } = await queryWrite(
    `UPDATE crm.oauth_refresh SET revoked_at = now()
      WHERE chain_id = $1 AND revoked_at IS NULL`, [chainId]);
  return rowCount;
}
