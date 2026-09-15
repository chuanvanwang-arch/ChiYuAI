// test/mcp-oauth-token.test.js — /oauth/token（authorization_code）：PKCE + 一次性 + 严格匹配
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.6
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createOAuthRouter, buildOAuthDeps } from '../src/mcp/oauth.js';
import { resolveIdentity } from '../src/mcp/auth.js';
import { query, queryWrite } from '../src/db.js';
import { base64UrlSha256 } from '../src/mcp/oauthCrypto.js';

const SUF = Math.random().toString(36).slice(2, 10);
const CID = `oauth_tk_${SUF}`;
const URI = 'workbuddy://workbuddy/mcp/connector:tk/oauth/callback';
const USER = `tk_${SUF}`;
const PW = 'P@ssw0rd!';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = base64UrlSha256(VERIFIER);

let app;
beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createOAuthRouter(buildOAuthDeps()));
  await queryWrite(`INSERT INTO crm.oauth_client (client_id, redirect_uris) VALUES ($1, $2::jsonb)`,
    [CID, JSON.stringify([URI])]);
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Tk', true, true)`, [USER, PW]);
});

async function call(method, path, body, form = false) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const opts = { method, headers: {}, redirect: 'manual' };
      if (body !== undefined) {
        if (form) {
          opts.headers['content-type'] = 'application/x-www-form-urlencoded';
          opts.body = new URLSearchParams(body).toString();
        } else {
          opts.headers['content-type'] = 'application/json';
          opts.body = JSON.stringify(body);
        }
      }
      fetch(`http://127.0.0.1:${port}${path}`, opts)
        .then(async (r) => resolve({ status: r.status, json: await r.json().catch(() => null), location: r.headers.get('location') }))
        .finally(() => server.close());
    });
  });
}

// 走完 authorize 拿到授权码
async function getCode() {
  const r = await call('POST', '/oauth/authorize', {
    response_type: 'code', client_id: CID, redirect_uri: URI, state: 's',
    code_challenge: CHALLENGE, code_challenge_method: 'S256', username: USER, password: PW,
  }, true);
  return new URL(r.location).searchParams.get('code');
}

describe('POST /oauth/token · authorization_code', () => {
  it('正确 code + verifier → 返回 access/refresh，access 可 resolveIdentity 且 actor 正确', async () => {
    const code = await getCode();
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER,
    }, true);
    expect(r.status).toBe(200);
    expect(r.json.token_type).toBe('Bearer');
    expect(r.json.expires_in).toBe(28800);
    expect(r.json.access_token).toMatch(/^crm_[a-f0-9]{32}_[a-f0-9]{48}$/);
    expect(r.json.refresh_token).toMatch(/^crmr_[a-f0-9]{64}$/);
    expect(r.json.scope).toBe('mcp');

    const ctx = await resolveIdentity(r.json.access_token);
    expect(ctx.degraded).toBe(false);
    expect(ctx.actor).toBe(USER);
    expect(ctx.role).toBe('sales');
  });

  it('identity 的 scopes 记录 issued_by=oauth 与 client_id（供渠道隔离吊销）', async () => {
    const code = await getCode();
    await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER,
    }, true);
    const id = (await query(
      `SELECT id FROM crm.mcp_identity WHERE actor=$1 ORDER BY created_at DESC LIMIT 1`, [USER])).rows[0].id;
    const sc = (await query(`SELECT scopes FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0].scopes;
    expect(sc.issued_by).toBe('oauth');
    expect(sc.client_id).toBe(CID);
  });

  it('错误 code_verifier → 400 invalid_grant（PKCE 拦住）', async () => {
    const code = await getCode();
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI,
      code_verifier: 'x'.repeat(43),
    }, true);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_grant');
  });

  it('同一 code 二次交换 → 400 invalid_grant（CAS 一次性）', async () => {
    const code = await getCode();
    const body = { grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER };
    expect((await call('POST', '/oauth/token', body, true)).status).toBe(200);
    const again = await call('POST', '/oauth/token', body, true);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe('invalid_grant');
  });

  it('并发同一 code 双请求 → 恰好一个成功（CAS 原子性）', async () => {
    const code = await getCode();
    const body = { grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER };
    const [a, b] = await Promise.all([
      call('POST', '/oauth/token', body, true),
      call('POST', '/oauth/token', body, true),
    ]);
    expect([a, b].filter((r) => r.status === 200).length).toBe(1);
  });

  it('redirect_uri 不一致 → 400 且【不消费】该 code（后续用正确的还能换成功）', async () => {
    const code = await getCode();
    const bad = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID, redirect_uri: 'https://evil.com/cb', code_verifier: VERIFIER,
    }, true);
    expect(bad.status).toBe(400);
    expect((await query(
      `SELECT consumed_at FROM crm.oauth_code WHERE actor=$1 ORDER BY created_at DESC LIMIT 1`, [USER]
    )).rows[0].consumed_at).toBeNull();
    const good = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER,
    }, true);
    expect(good.status).toBe(200);
  });

  it('client_id 不一致 → 400 invalid_grant', async () => {
    const code = await getCode();
    const CID2 = `oauth_tk2_${SUF}`;
    await queryWrite(`INSERT INTO crm.oauth_client (client_id, redirect_uris) VALUES ($1, $2::jsonb)`,
      [CID2, JSON.stringify([URI])]);
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID2, redirect_uri: URI, code_verifier: VERIFIER,
    }, true);
    expect(r.status).toBe(400);
  });

  it('未知 client_id → 400 invalid_client', async () => {
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code: 'crmc_x', client_id: 'oauth_ghost',
      redirect_uri: URI, code_verifier: VERIFIER,
    }, true);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_client');
  });

  it('过期 code → 400 invalid_grant', async () => {
    const code = await getCode();
    await queryWrite(`UPDATE crm.oauth_code SET expires_at = now() - interval '1 minute' WHERE actor=$1`, [USER]);
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER,
    }, true);
    expect(r.status).toBe(400);
  });

  it('缺参 → 400 invalid_request', async () => {
    const r = await call('POST', '/oauth/token', { grant_type: 'authorization_code', client_id: CID }, true);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_request');
  });

  it('未知 grant_type → 400 unsupported_grant_type', async () => {
    const r = await call('POST', '/oauth/token', { grant_type: 'password', username: USER, password: PW }, true);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unsupported_grant_type');
  });
});
