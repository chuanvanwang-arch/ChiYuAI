// test/mcp-oauth-register.test.js — RFC 9728 / 8414 metadata + RFC 7591 动态注册
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.1–§3.3
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createOAuthRouter, deriveOrigin, isAllowedRedirectUri, buildOAuthDeps } from '../src/mcp/oauth.js';

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use(createOAuthRouter(buildOAuthDeps()));
});

async function call(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const opts = { method, headers: { ...headers } };
      if (body !== undefined) {
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      fetch(`http://127.0.0.1:${port}${path}`, opts)
        .then(async (r) => resolve({ status: r.status, json: await r.json().catch(() => null) }))
        .finally(() => server.close());
    });
  });
}

describe('deriveOrigin', () => {
  it('优先 X-Forwarded-Proto / X-Forwarded-Host', () => {
    expect(deriveOrigin({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'crm.example.com' } }))
      .toBe('https://crm.example.com');
  });
  it('多值头取第一个', () => {
    expect(deriveOrigin({ headers: { 'x-forwarded-proto': 'http, https', host: '81.70.184.198' } }))
      .toBe('http://81.70.184.198');
  });
  it('无转发头时回落到 Host + 连接协议', () => {
    expect(deriveOrigin({ headers: { host: '127.0.0.1:3001' }, secure: false }))
      .toBe('http://127.0.0.1:3001');
  });
});

describe('isAllowedRedirectUri', () => {
  it('workbuddy custom scheme 合法回调 → true', () => {
    expect(isAllowedRedirectUri('workbuddy://workbuddy/mcp/connector:crm-native/oauth/callback')).toBe(true);
  });
  it('回环 http（带端口）→ true', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:8976/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:3000/cb')).toBe(true);
  });
  it('远端 https → false（防开放重定向）', () => {
    expect(isAllowedRedirectUri('https://evil.com/cb')).toBe(false);
  });
  it('回环但 https → false（回环只允许 http）', () => {
    expect(isAllowedRedirectUri('https://127.0.0.1/cb')).toBe(false);
  });
  it('含 fragment → false', () => {
    expect(isAllowedRedirectUri('workbuddy://workbuddy/mcp/connector:x/oauth/callback#frag')).toBe(false);
  });
  it('含 userinfo → false（防 scheme 混淆）', () => {
    expect(isAllowedRedirectUri('https://evil.com@127.0.0.1/cb')).toBe(false);
  });
  it('workbuddy scheme 但 host/path 不符 → false', () => {
    expect(isAllowedRedirectUri('workbuddy://workbuddy/anything')).toBe(false);
    expect(isAllowedRedirectUri('workbuddy://evil.com/mcp/connector:x/oauth/callback')).toBe(false);
  });
  it('非字符串 / 非法 URL / 危险 scheme → false', () => {
    expect(isAllowedRedirectUri('')).toBe(false);
    expect(isAllowedRedirectUri(null)).toBe(false);
    expect(isAllowedRedirectUri('not a url')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
  });
});

describe('GET /.well-known/oauth-protected-resource（RFC 9728）', () => {
  it('resource 指向 <origin>/mcp，authorization_servers 含 origin', async () => {
    const r = await call('GET', '/.well-known/oauth-protected-resource', undefined,
      { 'x-forwarded-proto': 'http', 'x-forwarded-host': '81.70.184.198' });
    expect(r.status).toBe(200);
    expect(r.json.resource).toBe('http://81.70.184.198/mcp');
    expect(r.json.authorization_servers).toEqual(['http://81.70.184.198']);
    expect(r.json.scopes_supported).toEqual(['mcp']);
    expect(r.json.bearer_methods_supported).toEqual(['header']);
  });

  it('路径插入式变体 /…-resource/mcp 同样可用（RFC 9728 §3.1）', async () => {
    const r = await call('GET', '/.well-known/oauth-protected-resource/mcp');
    expect(r.status).toBe(200);
    expect(r.json.resource).toMatch(/\/mcp$/);
  });
});

describe('GET /.well-known/oauth-authorization-server（RFC 8414）', () => {
  it('端点清单完整，与 PKCE public client 一致', async () => {
    const r = await call('GET', '/.well-known/oauth-authorization-server', undefined,
      { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'crm.example.com' });
    expect(r.status).toBe(200);
    expect(r.json.issuer).toBe('https://crm.example.com');
    expect(r.json.authorization_endpoint).toBe('https://crm.example.com/oauth/authorize');
    expect(r.json.token_endpoint).toBe('https://crm.example.com/oauth/token');
    expect(r.json.registration_endpoint).toBe('https://crm.example.com/oauth/register');
    expect(r.json.code_challenge_methods_supported).toEqual(['S256']);
    expect(r.json.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(r.json.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });

  it('openid-configuration 别名同样返回端点清单', async () => {
    const r = await call('GET', '/.well-known/openid-configuration');
    expect(r.status).toBe(200);
    expect(r.json.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
  });
});

describe('POST /oauth/register（RFC 7591 动态注册）', () => {
  it('合法 redirect_uri → 201 且返回 client_id（oauth_<32hex>）', async () => {
    const r = await call('POST', '/oauth/register', {
      client_name: 'WorkBuddy',
      redirect_uris: ['workbuddy://workbuddy/mcp/connector:crm-native/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    expect(r.status).toBe(201);
    expect(r.json.client_id).toMatch(/^oauth_[a-f0-9]{32}$/);
    expect(r.json.token_endpoint_auth_method).toBe('none');
    expect(r.json.redirect_uris).toEqual(['workbuddy://workbuddy/mcp/connector:crm-native/oauth/callback']);
  });

  it('远端 https redirect_uri → 400 invalid_redirect_uri 且不落库', async () => {
    const r = await call('POST', '/oauth/register', { redirect_uris: ['https://evil.com/cb'] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_redirect_uri');
  });

  it('redirect_uris 缺失 / 空 → 400', async () => {
    expect((await call('POST', '/oauth/register', {})).status).toBe(400);
    expect((await call('POST', '/oauth/register', { redirect_uris: [] })).status).toBe(400);
  });

  it('白名单混合时整批拒绝（任一非法即拒，不做部分接受）', async () => {
    const r = await call('POST', '/oauth/register', {
      redirect_uris: ['workbuddy://workbuddy/mcp/connector:x/oauth/callback', 'https://evil.com/cb'],
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_redirect_uri');
  });

  it('未传 grant_types 时回落默认值', async () => {
    const r = await call('POST', '/oauth/register', {
      redirect_uris: ['workbuddy://workbuddy/mcp/connector:y/oauth/callback'],
    });
    expect(r.status).toBe(201);
    expect(r.json.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });
});
