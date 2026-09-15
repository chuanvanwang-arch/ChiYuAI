// test/mcp-oauth-refresh.test.js — refresh 轮转与重放整链吊销
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.6 / §5.3
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createOAuthRouter, buildOAuthDeps } from '../src/mcp/oauth.js';
import { resolveIdentity } from '../src/mcp/auth.js';
import { query, queryWrite } from '../src/db.js';
import { base64UrlSha256 } from '../src/mcp/oauthCrypto.js';

const SUF = Math.random().toString(36).slice(2, 10);
const CID = `oauth_rf_${SUF}`;
const URI = 'workbuddy://workbuddy/mcp/connector:rf/oauth/callback';
const USER = `rf_${SUF}`;
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
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Rf', true, true)`, [USER, PW]);
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

// 完整授权一次，返回 { access_token, refresh_token }
async function authorizeAndExchange(username = USER) {
  const a = await call('POST', '/oauth/authorize', {
    response_type: 'code', client_id: CID, redirect_uri: URI, state: 's',
    code_challenge: CHALLENGE, code_challenge_method: 'S256', username, password: PW,
  }, true);
  const code = new URL(a.location).searchParams.get('code');
  const t = await call('POST', '/oauth/token', {
    grant_type: 'authorization_code', code, client_id: CID, redirect_uri: URI, code_verifier: VERIFIER,
  }, true);
  return t.json;
}

const refresh = (refresh_token, clientId = CID) =>
  call('POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token, client_id: clientId }, true);

describe('POST /oauth/token · refresh_token', () => {
  it('有效 refresh → 新 access + 新 refresh（轮转），新 access 可解析身份', async () => {
    const { refresh_token } = await authorizeAndExchange();
    const r = await refresh(refresh_token);
    expect(r.status).toBe(200);
    expect(r.json.access_token).toMatch(/^crm_/);
    expect(r.json.refresh_token).toMatch(/^crmr_/);
    expect(r.json.refresh_token).not.toBe(refresh_token);      // 必须轮转
    const ctx = await resolveIdentity(r.json.access_token);
    expect(ctx.degraded).toBe(false);
    expect(ctx.actor).toBe(USER);
  });

  it('同一 chain 连续轮转多次均可成功（30 天在线）', async () => {
    let { refresh_token } = await authorizeAndExchange();
    for (let i = 0; i < 3; i++) {
      const r = await refresh(refresh_token);
      expect(r.status).toBe(200);
      refresh_token = r.json.refresh_token;
    }
  });

  it('旧 refresh 重放 → 400 且整链吊销（连仍新鲜的叶子也失效）', async () => {
    const u = `rf_replay_${SUF}`;
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Rp', true, true)`, [u, PW]);
    const first = (await authorizeAndExchange(u)).refresh_token;
    const second = (await refresh(first)).json.refresh_token;

    const replay = await refresh(first);                       // 重放已被轮转的旧值
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe('invalid_grant');

    const afterReplay = await refresh(second);                 // 整链吊销：叶子也失效
    expect(afterReplay.status).toBe(400);
    expect(afterReplay.json.error).toBe('invalid_grant');

    const r = await query(
      `SELECT count(*)::int total, count(revoked_at)::int revoked
         FROM crm.oauth_refresh WHERE actor=$1`, [u]);
    expect(r.rows[0].total).toBeGreaterThan(0);
    expect(r.rows[0].revoked).toBe(r.rows[0].total);
  });

  it('重放落审计事件 mcp.oauth.refresh_replay', async () => {
    const before = (await query(
      `SELECT count(*)::int n FROM crm.events WHERE type='mcp.oauth.refresh_replay'`)).rows[0].n;
    const u = `rf_audit_${SUF}`;
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Ra', true, true)`, [u, PW]);
    const t = await authorizeAndExchange(u);
    await refresh(t.refresh_token);        // 正常轮转
    await refresh(t.refresh_token);        // 重放
    const after = (await query(
      `SELECT count(*)::int n FROM crm.events WHERE type='mcp.oauth.refresh_replay'`)).rows[0].n;
    expect(after).toBeGreaterThan(before);
  });

  it('未知 refresh_token → 400 invalid_grant', async () => {
    const r = await refresh(`crmr_${'0'.repeat(64)}`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_grant');
  });

  it('已吊销 refresh → 400 invalid_grant', async () => {
    const { refresh_token } = await authorizeAndExchange();
    await queryWrite(
      `UPDATE crm.oauth_refresh SET revoked_at = now()
        WHERE token_hash = encode(digest($1,'sha256'),'hex')`, [refresh_token]);
    expect((await refresh(refresh_token)).status).toBe(400);
  });

  it('过期 refresh → 400 invalid_grant', async () => {
    const { refresh_token } = await authorizeAndExchange();
    await queryWrite(
      `UPDATE crm.oauth_refresh SET expires_at = now() - interval '1 second'
        WHERE token_hash = encode(digest($1,'sha256'),'hex')`, [refresh_token]);
    expect((await refresh(refresh_token)).status).toBe(400);
  });

  it('缺 refresh_token / client_id → 400 invalid_request', async () => {
    expect((await call('POST', '/oauth/token',
      { grant_type: 'refresh_token', client_id: CID }, true)).json.error).toBe('invalid_request');
    expect((await call('POST', '/oauth/token',
      { grant_type: 'refresh_token', refresh_token: 'crmr_x' }, true)).json.error).toBe('invalid_request');
  });

  it('换 client_id 使用他人 refresh → 400 invalid_grant', async () => {
    const CID2 = `oauth_rf2_${SUF}`;
    await queryWrite(`INSERT INTO crm.oauth_client (client_id, redirect_uris) VALUES ($1, $2::jsonb)`,
      [CID2, JSON.stringify([URI])]);
    const { refresh_token } = await authorizeAndExchange();
    expect((await refresh(refresh_token, CID2)).status).toBe(400);
  });

  it('并发双请求同一 refresh → 恰好一个成功（CAS 轮转原子性）', async () => {
    const { refresh_token } = await authorizeAndExchange();
    const [a, b] = await Promise.all([refresh(refresh_token), refresh(refresh_token)]);
    expect([a, b].filter((r) => r.status === 200).length).toBe(1);
  });
});
