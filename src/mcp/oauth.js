// src/mcp/oauth.js — MCP OAuth 授权服务器（RFC 9728 / 8414 / 7591 / OAuth 2.1 + PKCE）
// 设计：docs/2026-09-15-mcp-oauth-design.md
//
// 架构：授权服务器与资源服务器同驻 crm-mcp（:3001），发现链与端点同进程同源。
// 用法：
//   - 测试：createOAuthRouter(deps) 注入替身（纯工厂，无模块级副作用）
//   - 生产：createOAuthRouter(buildOAuthDeps())（真实 store / issueIdentity / emit）
// 参考 src/http/calibrationRouter.js 的注入式路由惯例。
import express from 'express';
import { MCP_CONFIG } from './config.js';
import { newClientId, newOpaqueToken, sha256Hex, verifyPkce, CODE_PREFIX, REFRESH_PREFIX } from './oauthCrypto.js';
import { renderLoginPage, renderErrorPage } from './oauthPage.js';
import * as oauthStore from './oauthStore.js';
import { issueMcpIdentity } from './auth.js';
import { recordEvent } from '../events/recordEvent.js';

// ---------- 审计事件（落 crm.events 真相源 + 内存总线广播）----------
// ⚠ 注意：src/events/bus.js 的 emit(domain,type,payload) **只做进程内广播、不落库**；
//   crm.events 的唯一落库收敛点是 recordEvent()（先落库、后广播，避免「幽灵事件」）。
//   因此 OAuth 的审计事件走本函数，而不是直接调 bus.emit。
//   签名与 bus.emit 对齐为 (domain, type, payload)，避免调用处出现「两参数 → type 被写成对象」的错位。
export async function emitAudit(domain, type, payload = {}) {
  return recordEvent({
    domain,
    type,
    actor: payload?.actor || 'system',
    tenantId: payload?.tenant_id || null,
    payload,
  });
}

// ---------- origin 派生（不硬编码主机名）----------
// OAuth metadata 的 issuer / resource 必须与客户端实际访问的 origin 一致，
// 否则出现「metadata 指向域名、客户端用 IP 访问 → 校验失败」。
export function deriveOrigin(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const proto = first(req?.headers?.['x-forwarded-proto']) || (req?.secure ? 'https' : 'http');
  const host = first(req?.headers?.['x-forwarded-host']) || first(req?.headers?.host) || '127.0.0.1';
  return `${proto}://${host}`;
}

// ---------- redirect_uri 白名单（防开放重定向，fail-closed）----------
export function isAllowedRedirectUri(uri, config = MCP_CONFIG.oauth) {
  if (typeof uri !== 'string' || !uri) return false;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;                        // 禁 fragment：防参数拼接歧义
  if (u.username || u.password) return false;      // 禁 userinfo：防 https://evil@127.0.0.1 混淆
  // 回环：仅允许 http（本地调试），不允许 https 远端冒用回环主机名
  if (config.allowLoopbackRedirect) {
    const h = u.hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') {
      return u.protocol === 'http:';
    }
  }
  const scheme = u.protocol.replace(/:$/, '');
  const schemes = config.allowedRedirectSchemes || [];
  if (!schemes.includes(scheme)) return false;
  if (scheme === 'workbuddy') {
    // 形如 workbuddy://workbuddy/mcp/connector:<id>/oauth/callback
    return u.hostname === 'workbuddy'
      && /^\/mcp\/connector:[^/]+\/oauth\/callback$/.test(u.pathname);
  }
  return false;
}

// ---------- 路由工厂 ----------
export function createOAuthRouter(deps = {}) {
  const {
    config = MCP_CONFIG.oauth,
    store = oauthStore,
    originOf = deriveOrigin,
    issueIdentity = issueMcpIdentity,
    emit = emitAudit,
  } = deps;

  const router = express.Router();

  // ---- RFC 9728：受保护资源 metadata ----
  // 路径插入式变体（/.well-known/oauth-protected-resource/mcp）一并支持（RFC 9728 §3.1）
  const resourceMetadata = (req, res) => {
    const origin = originOf(req);
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [config.scope],
      bearer_methods_supported: ['header'],
    });
  };
  router.get('/.well-known/oauth-protected-resource', resourceMetadata);
  router.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  // ---- RFC 8414：授权服务器 metadata（openid-configuration 作别名保险）----
  const asMetadata = (req, res) => {
    const origin = originOf(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],   // public client + PKCE
      scopes_supported: [config.scope],
    });
  };
  router.get('/.well-known/oauth-authorization-server', asMetadata);
  router.get('/.well-known/openid-configuration', asMetadata);

  // ---- RFC 7591：动态客户端注册 ----
  router.post('/oauth/register', async (req, res, next) => {
    try {
      const body = req.body || {};
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u) => typeof u === 'string')
        : [];
      if (!redirectUris.length) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
      }
      const bad = redirectUris.find((u) => !isAllowedRedirectUri(u, config));
      if (bad) {
        // 任一非法即整批拒绝，不做部分接受（避免「合法值掩盖非法值」）
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri not allowed' });
      }
      const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
        ? body.grant_types.filter((g) => typeof g === 'string')
        : ['authorization_code', 'refresh_token'];
      const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : null;
      const clientId = newClientId();
      const row = await store.insertClient({ clientId, clientName, redirectUris, grantTypes });
      res.status(201).json({
        client_id: row.client_id,
        client_name: row.client_name,
        redirect_uris: row.redirect_uris,
        grant_types: row.grant_types,
        token_endpoint_auth_method: 'none',     // 永不签发 client_secret
      });
    } catch (e) { next(e); }
  });

  // ---- 授权请求参数读取（GET query / POST form 同形）----
  const readAuthParams = (src = {}) => ({
    response_type: src.response_type,
    client_id: src.client_id,
    redirect_uri: src.redirect_uri,
    state: src.state,
    code_challenge: src.code_challenge,
    code_challenge_method: src.code_challenge_method,
    scope: src.scope,
    username: src.username,
    password: src.password,
  });

  // 校验授权请求：返回 null 表示通过，否则返回错误文案。
  // 任一不过都必须「渲染错误页」而非 302 —— 否则成为开放重定向放大器（RFC 6749 §4.1.2.1）。
  async function validateAuthRequest(p) {
    if (p.response_type !== 'code') return 'response_type 必须为 code';
    if (!p.client_id) return '缺少 client_id';
    const client = await store.getClient(p.client_id);
    if (!client || client.disabled_at) return '未知或已禁用的 client_id';
    const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    if (!p.redirect_uri || !uris.includes(p.redirect_uri)) return 'redirect_uri 与注册值不匹配';
    if (!p.code_challenge) return '缺少 code_challenge（PKCE 必须）';
    if (p.code_challenge_method !== 'S256') return 'code_challenge_method 必须为 S256';
    return null;
  }

  // ---- GET /oauth/authorize：渲染登录页 ----
  router.get('/oauth/authorize', async (req, res, next) => {
    try {
      const p = readAuthParams(req.query);
      const err = await validateAuthRequest(p);
      if (err) return res.status(400).type('html').send(renderErrorPage(err));
      return res.status(200).type('html').send(renderLoginPage({ params: p }));
    } catch (e) { next(e); }
  });

  // ---- POST /oauth/authorize：校验凭据 → 发码 → 302 ----
  router.post('/oauth/authorize', async (req, res, next) => {
    try {
      const p = readAuthParams(req.body || {});
      const err = await validateAuthRequest(p);
      if (err) return res.status(400).type('html').send(renderErrorPage(err));

      const user = await store.verifyUser({ username: p.username, password: p.password });
      if (!user.ok) {
        return res.status(401).type('html').send(renderLoginPage({ params: p, error: user.message }));
      }

      // 注意：此处【不】铸 access token（计划校准 C1）——授权时铸出的明文无法安全留到 token 端点返回。
      // 身份在 /oauth/token 交换时铸，顺带消除「授权后不交换」产生的孤儿 token 行。
      const code = newOpaqueToken(CODE_PREFIX);
      await store.insertCode({
        codeHash: sha256Hex(code),
        clientId: p.client_id,
        actor: user.username,
        tenantId: user.tenant_id,
        roleTag: user.role,
        redirectUri: p.redirect_uri,
        codeChallenge: p.code_challenge,
        scope: config.scope,
        ttlMs: config.codeTtlMs,
      });
      await store.touchClient(p.client_id);

      const sep = p.redirect_uri.includes('?') ? '&' : '?';
      const statePart = p.state ? `&state=${encodeURIComponent(p.state)}` : '';
      return res.redirect(302, `${p.redirect_uri}${sep}code=${encodeURIComponent(code)}${statePart}`);
    } catch (e) { next(e); }
  });

  // ---- POST /oauth/token ----
  // 统一错误：一律 400 + 简洁 error，不泄漏「code 不存在」与「PKCE 不匹配」的区别
  const bad = (res, error) => res.status(400).json({ error, error_description: 'authorization request rejected' });

  async function grantAuthorizationCode(b, res) {
    if (!b.code || !b.client_id || !b.redirect_uri || !b.code_verifier) return bad(res, 'invalid_request');
    const client = await store.getClient(b.client_id);
    if (!client || client.disabled_at) return bad(res, 'invalid_client');

    const row = await store.getCode(sha256Hex(b.code));
    if (!row) return bad(res, 'invalid_grant');
    if (row.client_id !== b.client_id) return bad(res, 'invalid_grant');
    // redirect_uri 必须在【消费之前】校验，否则参数不符会白烧掉授权码
    if (row.redirect_uri !== b.redirect_uri) return bad(res, 'invalid_grant');
    if (row.consumed_at) return bad(res, 'invalid_grant');
    // 过期判定【只】由 consumeCode 的 DB 侧 `expires_at > now()` 承担（唯一权威、且与写入同用 DB 时钟）。
    // 此处刻意不做 `new Date(row.expires_at).getTime() <= Date.now()` 的预检：那是「DB 写入值 vs Node 时钟」
    // 的跨时钟比较（校准 C4），时钟偏差方向不利时会把仍有效的码误判为过期、造成偶发 invalid_grant。
    // 去掉预检后行为完全等价：过期码在 consumeCode 同样返回 null → 同一个 invalid_grant。
    if (!verifyPkce(b.code_verifier, row.code_challenge)) return bad(res, 'invalid_grant');

    const consumed = await store.consumeCode(row.code_hash);     // CAS：并发双请求只有一个 RETURNING 到行
    if (!consumed) return bad(res, 'invalid_grant');

    // 计划校准 C1：access token 在此铸（授权阶段不铸），明文只经本响应返回一次
    const issued = await issueIdentity({
      username: consumed.actor, role: consumed.role_tag, tenantId: consumed.tenant_id,
      issuedBy: 'oauth', clientId: b.client_id, ttlMs: config.accessTtlMs,
    });
    const refreshRaw = newOpaqueToken(REFRESH_PREFIX);
    await store.insertRefresh({
      tokenHash: sha256Hex(refreshRaw), clientId: b.client_id, actor: consumed.actor,
      tenantId: consumed.tenant_id, roleTag: consumed.role_tag, scope: consumed.scope,
      chainId: null, ttlMs: config.refreshTtlMs,
    });
    await store.touchClient(b.client_id);
    if (emit) {
      await emit('mcp', 'mcp.oauth.token_issued', {
        actor: consumed.actor, client_id: b.client_id, tenant_id: consumed.tenant_id,
        grant: 'authorization_code',
      });
    }
    return res.json({
      access_token: issued.tokenPlain,
      token_type: 'Bearer',
      expires_in: Math.floor(config.accessTtlMs / 1000),
      refresh_token: refreshRaw,
      scope: consumed.scope,
    });
  }

  async function grantRefreshToken(b, res) {
    if (!b.refresh_token || !b.client_id) return bad(res, 'invalid_request');
    const client = await store.getClient(b.client_id);
    if (!client || client.disabled_at) return bad(res, 'invalid_client');

    const hash = sha256Hex(b.refresh_token);
    const row = await store.getRefresh(hash);
    if (!row || row.client_id !== b.client_id) return bad(res, 'invalid_grant');
    if (row.revoked_at) return bad(res, 'invalid_grant');

    // 重放检测（先于过期判定）：已被轮转过（used_at 非空）却再次使用 → 判定泄露，吊销整链。
    // 顺序有意如此：已轮转 + 已过期 的旧值是最典型的重放样本，必须走吊销而非静默放过。
    if (row.used_at) {
      const revoked = await store.revokeChain(row.chain_id);
      if (emit) {
        await emit('mcp', 'mcp.oauth.refresh_replay', {
          actor: row.actor, client_id: b.client_id, tenant_id: row.tenant_id,
          chain_id: row.chain_id, revoked,
        });
      }
      return bad(res, 'invalid_grant');
    }
    // 过期判定用持久化层给出的 DB 时钟结论（row.expired），不做 Node 时钟比较（校准 C4）。
    // 未使用 + 已过期 = 用户授权后从未交换、自然过期 → 直接拒，不吊销链、不误报重放事件。
    if (row.expired) return bad(res, 'invalid_grant');

    // 轮转：CAS 占用旧行（并发双请求只有一个成功）
    const nextRaw = newOpaqueToken(REFRESH_PREFIX);
    const nextHash = sha256Hex(nextRaw);
    const rotated = await store.markRefreshUsed(hash, nextHash);
    if (!rotated) {
      // 落到这里说明并发竞争失败：与重放同风险，整链吊销（fail-closed）
      const revoked = await store.revokeChain(row.chain_id);
      if (emit) {
        await emit('mcp', 'mcp.oauth.refresh_replay', {
          actor: row.actor, client_id: b.client_id, tenant_id: row.tenant_id,
          chain_id: row.chain_id, revoked, reason: 'concurrent_rotation',
        });
      }
      return bad(res, 'invalid_grant');
    }
    try {
      await store.insertRefresh({
        tokenHash: nextHash, clientId: b.client_id, actor: row.actor, tenantId: row.tenant_id,
        roleTag: row.role_tag, scope: row.scope, chainId: row.chain_id, ttlMs: config.refreshTtlMs,
      });
    } catch (e) {
      // 旧行已标记 used、新行未落库 → 该链不可再续期。整链吊销，让用户重新授权（fail-closed，不留半开状态）
      await store.revokeChain(row.chain_id);
      throw e;
    }

    const issued = await issueIdentity({
      username: row.actor, role: row.role_tag, tenantId: row.tenant_id,
      issuedBy: 'oauth', clientId: b.client_id, ttlMs: config.accessTtlMs,
    });
    await store.touchClient(b.client_id);
    if (emit) {
      await emit('mcp', 'mcp.oauth.token_issued', {
        actor: row.actor, client_id: b.client_id, tenant_id: row.tenant_id, grant: 'refresh_token',
      });
    }
    return res.json({
      access_token: issued.tokenPlain,
      token_type: 'Bearer',
      expires_in: Math.floor(config.accessTtlMs / 1000),
      refresh_token: nextRaw,
      scope: row.scope,
    });
  }

  router.post('/oauth/token', async (req, res, next) => {
    try {
      const b = req.body || {};
      if (b.grant_type === 'authorization_code') return await grantAuthorizationCode(b, res);
      if (b.grant_type === 'refresh_token') return await grantRefreshToken(b, res);
      return bad(res, 'unsupported_grant_type');
    } catch (e) { next(e); }
  });

  return router;
}

// ---------- 生产装配（真实依赖）----------
// 与 createOAuthRouter 分离：工厂保持纯，装配集中在此，由 test/mcp-oauth-wiring.test.js 守卫非空。
export function buildOAuthDeps() {
  return {
    config: MCP_CONFIG.oauth,
    store: oauthStore,
    issueIdentity: issueMcpIdentity,
    emit: emitAudit,
    originOf: deriveOrigin,
  };
}
