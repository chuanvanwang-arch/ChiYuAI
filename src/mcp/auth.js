// src/mcp/auth.js — 凭证解析（零信任：token → actor 映射；绝不索身份、角色自推断）
// 设计输入：总体设计 §6.13 安全红线 + docs/2026-08-26-crm-role-confirm-permission-design.md
//         + docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md §4（身份基线：持久查表）
//
// 绝对红线：AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）
// 详见 scripts/.env.example 与 scripts/setup-credentials.ps1。
import { MCP_CONFIG } from './config.js';
import { query, queryWrite } from '../db.js';
import { newStructuredToken, parseTokenId } from './tokenFormat.js';

// 解析 MCP 请求携带的凭证 → { actor, role, degraded, degraded_reason, prompt_needed }
// 降级触发条件（OR）：
//   1) 完全无凭证  2) 凭证未知  3) 自推断置信度不足（由调用方判定，此处仍判定为未知）
function mk(actor, role, degraded, degraded_reason, prompt_needed) {
  return { actor, role, degraded, degraded_reason, prompt_needed };
}

// 持久查表解析身份（替代 config.apiToken 内存静态查表；token 用 pgcrypto crypt 比对，明文不出 node）
// 返回 { actor, role, degraded, degraded_reason, prompt_needed, identity_id, person_id, scopes }
//
// 2026-09-01 性能改造（设计 docs/2026-09-01-mcp-token-lookup-design.md §4.4）：
//   旧实现 WHERE token_hash = crypt($1, token_hash) 以每行哈希为 salt，无法走索引
//   → 全表扫描 + 每行一次 blowfish crypt，成本随登录次数线性增长（生产 110 行 ≈500ms/次，
//   测试库 1300+ 行 ≈4.6s/次）。新实现三段式：
//     ① 格式闸：明文解析不出 identity_id 即降级，零 DB 查询（旧格式 token 在此被拒，成本恒定）
//     ② 主键定位：WHERE id = $1 走 mcp_identity_pkey，O(1)
//     ③ 单次校验：同一条 SQL 内 (token_hash = crypt($2, token_hash)) AS tok_ok，只对该行做一次 crypt
export async function resolveIdentity(token) {
  if (!token) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '无凭证：未携带 token', true);
  // ① 格式闸：旧格式（裸 48 hex）与非法格式在此被拒，不产生任何 DB 查询
  const id = parseTokenId(token);
  if (!id) {
    return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true,
      '凭证格式无效：请重新 crm_login 领取新凭证', true);
  }
  // ②③ 主键定位 + 单次 crypt 校验（一次往返；tok_ok 为 false 即明文不匹配或行不存在）
  const r = await query(
    `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at, tenant_id,
            (token_hash = crypt($2, token_hash)) AS tok_ok
       FROM crm.mcp_identity WHERE id = $1`,
    [id, token]
  );
  const row = r.rows[0];
  if (!row || !row.tok_ok || !row.enabled) {
    return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：凭证未配置或已失效', true);
  }
  if (row.revoked_at) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, 'token 已吊销', true);
  if (row.expires_at && row.expires_at < new Date()) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, 'token 已过期', true);
  const base = mk(row.actor, row.role_tag, false, null, false);
  base.identity_id = row.id;
  base.person_id = row.person_id;
  base.scopes = row.scopes && typeof row.scopes === 'object' ? row.scopes : {};
  base.tenant_id = row.tenant_id || 'system';
  // F4（方案 C）：sysadmin 写范围收敛——注入 write_scope/deny_business_write 供 MCP 层短路业务写。
  // 设计：docs/2026-09-06-rbac-f4-design.md §C3。业务写由第 1 闸（enforceScope governance 分支）双拒；
  // 治理写仍走第 0 闸（executor.js:28 缺 decision_id 拒 → HITL）。
  if (row.role_tag === 'sysadmin') {
    base.scopes = { ...base.scopes, write_scope: 'governance', deny_business_write: true };
  }
  return base;
}

export function resolveApiToken(token) {
  if (!token) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '无凭证：未携带 token', true);
  const entry = MCP_CONFIG.apiToken[token];
  if (!entry) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：凭证未配置或已失效', true);
  return mk(entry.actor, entry.role || MCP_CONFIG.security.minPrivilegeFallback, false, null, false);
}

// 从 MCP 工具调用上下文中提取凭证（参数 api_token / Bearer header / 环境变量 三源）
export function extractToken(params = {}, headers = {}) {
  if (params && params.api_token) return params.api_token;
  const auth = headers?.authorization || headers?.Authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  if (process.env.CRM_API_TOKEN) return process.env.CRM_API_TOKEN; // 环境变量兜底（绝不记录/回显）
  return null;
}

// 将 CRM_API_TOKEN 环境变量（格式 "actor:role"）注入运行时 apiToken 映射
// 安全：仅注册映射，token 字符串不进入任何日志/响应
export function loadEnvToken() {
  const raw = process.env.CRM_API_TOKEN;
  if (!raw) return;
  const [actor, role] = String(raw).split(':');
  if (actor && role) MCP_CONFIG.apiToken[raw] = { actor, role };
}

// 组装执行 ctx（MCP → Action ctx；角色由 resolveIdentity 持久查表解析，不向客户端索身份）
export async function buildMcpCtx({ token, actor: explicitActor, tenantId: explicitTenantId = 'system', decisionId = null, channel = 'mcp' } = {}) {
  const r = await resolveIdentity(token);
  const { actor, role, degraded, degraded_reason, prompt_needed, identity_id, person_id, scopes, tenant_id } = r;
  const finalActor = explicitActor || actor;
  // 优先级：身份查表 tenant_id > 显式入参兜底(默认 system) > 硬编码 system
  const finalTenantId = tenant_id || explicitTenantId || 'system';
  return {
    tenantId: finalTenantId,
    actor: finalActor,
    role,                      // 身份基线解析（mcp_identity 持久绑定，不再内存静态降级）
    channel,                   // 'mcp' —— 触发写白名单闸（对话式之外的另一外部通道）
    degraded,                  // 降级标志（无凭证/未知 → true）
    degraded_reason,           // 降级原因（供显式弹窗文案）
    prompt_needed,             // 是否需要向用户提示补完凭证（对齐 CordysCRM 截图）
    decision_id: decisionId,   // 写通道第0闸：无决策不写
    identity_id,               // 持久身份 id（mcp_identity.id，可追溯）
    person_id,                 // 真实身份 id（CRM_PERSON / crm_users，可空）
    scopes,                    // 身份级域收窄 { deny_domains:[...] }
  };
}

// 绝对红线：AI 永远不在对话中接收或显示密钥明文。
// 凭证补完仅经三安全通道：.env 模板 / 环境变量 / PowerShell 命令（见 scripts/）。
// verifyTokenPrefix 仅比对前 4 位，绝不接触完整 token。
export function verifyTokenPrefix(claimedPrefix) {
  const raw = process.env.CRM_API_TOKEN || '';
  return typeof claimedPrefix === 'string' && raw.startsWith(claimedPrefix);
}

// F4-3：sysadmin 写 token 标记治理写范围；业务写由 executor 第1闸 enforceScope 双闸拒（HTTP+MCP 同源）。
// 其余角色返回空 scopes（不加治理标记，行为不变）。
export function writeScopesForRole(role) {
  if (role === 'sysadmin') return { write_scope: 'governance', deny_business_write: true };
  return {};
}

// 颁发 MCP 身份（唯一落点：crm_login 工具 与 OAuth /oauth/token 共用，避免两份逻辑漂移）
// 设计：docs/2026-09-15-mcp-oauth-design.md §7.1
//
// 软吊销范围按颁发渠道收敛（否则两条渠道会互相踢掉对方，造成间歇性、难复现的掉线）：
//   issuedBy='oauth'     → 只吊销该 actor 下【同 client 的 oauth token】（轮转不留僵尸）
//   issuedBy='crm_login' → 吊销该 actor 其余全部【非 oauth 渠道】token（保持既有语义；
//                          历史 token 的 scopes 无 issued_by，经 COALESCE 判定为 crm_login，仍被吊销）
// 注：mcp_identity 列结构不可变（test/mcp-identity.test.js 做全列断言），故渠道标记落 scopes jsonb。
export async function issueMcpIdentity({
  username, role, tenantId = 'system',
  issuedBy = 'crm_login', clientId = null, ttlMs = null,
} = {}) {
  const { id, tokenPlain } = newStructuredToken();
  const ttl = ttlMs || MCP_CONFIG.security.tokenTtlMs || 8 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttl);
  const scopes = { ...writeScopesForRole(role), issued_by: issuedBy };   // F4-3：sysadmin 治理写标记
  if (clientId) scopes.client_id = clientId;

  await queryWrite(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, tenant_id, expires_at)
     VALUES ($1, crypt($2, gen_salt('bf')), $3, NULL, $4, $5, $6, $7)`,
    [id, tokenPlain, username, role, JSON.stringify(scopes), tenantId, expiresAt]
  );

  if (issuedBy === 'oauth') {
    await queryWrite(
      `UPDATE crm.mcp_identity SET revoked_at = now()
        WHERE actor = $1 AND revoked_at IS NULL AND id <> $2
          AND scopes->>'issued_by' = 'oauth' AND scopes->>'client_id' = $3`,
      [username, id, clientId]
    );
  } else {
    await queryWrite(
      `UPDATE crm.mcp_identity SET revoked_at = now()
        WHERE actor = $1 AND revoked_at IS NULL AND id <> $2
          AND COALESCE(scopes->>'issued_by', 'crm_login') <> 'oauth'`,
      [username, id]
    );
  }
  return { id, tokenPlain, expiresAt, role };
}

// 外部智能体首次接入验证：用户名 + 密码 → 颁发 MCP 接入 token（零信任：明文仅本次返回）
// 设计：docs/2026-08-29-mcp-forced-login-design.md
// 纪律：复用 crm.crm_users 密码体系（pgcrypto crypt 比对）；明文 token 仅返回一次；库仅存 crypt 哈希；
//       admin 仅限 HTTP 后台（role_context_profile 无 admin，FK 约束 + 最小权限）；每次登录发新 token 并软吊销旧。
export async function mcpLogin({ username, password } = {}) {
  if (!username || !password) return { ok: false, status: 400, error: 'username and password required' };
  const { rows } = await query(
    `SELECT username, password_hash, role, display_name, enabled, activated, tenant_id FROM crm.crm_users WHERE username=$1`, [username]);
  if (!rows.length) return { ok: false, status: 401, error: 'invalid credentials' };
  const u = rows[0];
  if (u.enabled === false) return { ok: false, status: 403, error: 'account disabled' };
  if (u.activated === false) return { ok: false, status: 403, error: 'account not activated: 请先通过邮箱/手机激活后再登录 MCP' };
  const { rows: v } = await query(`SELECT crypt($1, $2) = $2 AS ok`, [password, u.password_hash]);
  if (!v[0].ok) return { ok: false, status: 401, error: 'invalid credentials' };
  if (u.role === 'admin') {
    return { ok: false, status: 403,
      error: 'admin 仅限 HTTP 后台；请以业务账号(sales/manager/presales/exec/finance/contract_admin)登录 MCP' };
  }
  // 颁发收口：与 OAuth /oauth/token 共用同一函数（唯一差异是渠道标记）
  const issued = await issueMcpIdentity({
    username: u.username, role: u.role, tenantId: u.tenant_id || 'system', issuedBy: 'crm_login',
  });
  return { ok: true, status: 200, token: issued.tokenPlain, role: u.role, display_name: u.display_name };
}
