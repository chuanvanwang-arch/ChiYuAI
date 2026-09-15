// src/mcp/httpAuth.js — /mcp HTTP 层鉴权闸（触发客户端 OAuth 发现链的唯一开关）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.7
//
// 为什么必须在 HTTP 层：MCP_CONFIG.security.requireAuth 的判定在 tool-call 层
// （src/mcp/gateway.js:149 / :250 / :322），返回的是 HTTP 200 携带 { gate:'auth_required' }。
// 客户端据此不认为需要重新授权 → 静默续期链路失效。故 401 + WWW-Authenticate: Bearer
// resource_metadata 必须在此层产出；gateway 永远不会产出该响应头。
//
// allowlist（无凭据放行）：
//   - initialize：协议握手。crm-native-cli 无 token 也要能握手，否则登录入口死锁。
//   - tools/call[name=crm_login]：外部智能体首次接入验证入口。
//   - notifications/*：单向后通知。
// 副作用：未授权客户端的首个 401 出现在 tools/list，而非 initialize（不是闸失效）。
import { extractToken, resolveIdentity as defaultResolveIdentity } from './auth.js';
import { deriveOrigin } from './oauth.js';

const EXEMPT_METHODS = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled']);

export function isAuthExempt(body) {
  if (!body || typeof body !== 'object') return true;      // GET/DELETE 无 JSON-RPC body → 交会话查找兜底
  const method = body.method;
  if (typeof method !== 'string' || !method) return true;
  if (EXEMPT_METHODS.has(method)) return true;
  if (method.startsWith('notifications/')) return true;
  if (method === 'tools/call' && body.params?.name === 'crm_login') return true;
  return false;
}

export function buildChallenge(origin) {
  return `Bearer realm="crm-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

function unauthorized(res, origin) {
  res.set('WWW-Authenticate', buildChallenge(origin));
  return res.status(401).json({ error: 'invalid_token' });
}

export function createMcpAuthGate(deps = {}) {
  const {
    resolveIdentity = defaultResolveIdentity,
    originOf = deriveOrigin,
  } = deps;

  return async function mcpAuthGate(req, res, next) {
    const origin = originOf(req);
    // 必须复用 extractToken：它同时覆盖 params.api_token 与 Authorization: Bearer 双源。
    // 只认 Bearer 头会直接打断 crm-native-cli（CLI 走 api_token 参数，见 packages/crm-native-cli/src/commands/auth.js:38）。
    const token = extractToken(req.body?.params || {}, req.headers || {});
    try {
      if (isAuthExempt(req.body)) {
        // 免鉴权方法：无凭据直接放行；带凭据仍需校验（过期 token 的 SSE 重连要拿到 401 才能触发续期）
        if (!token) return next();
      } else if (!token) {
        return unauthorized(res, origin);
      }
      const id = await resolveIdentity(token);
      if (!id || id.degraded) return unauthorized(res, origin);
      res.locals.mcpIdentity = id;     // 供下游复用，避免重复解析
      return next();
    } catch (e) {
      // fail-closed：任何解析异常一律拒绝，不静默放行
      console.error('[mcp] auth gate 异常（fail-closed）:', e?.message || e);
      return unauthorized(res, origin);
    }
  };
}
