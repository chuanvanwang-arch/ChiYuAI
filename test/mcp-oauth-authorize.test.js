// test/mcp-oauth-authorize.test.js — /oauth/authorize GET(登录页) + POST(发码)
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.4 / §3.5
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createOAuthRouter, buildOAuthDeps } from '../src/mcp/oauth.js';
import { query, queryWrite } from '../src/db.js';
import { sha256Hex, base64UrlSha256 } from '../src/mcp/oauthCrypto.js';

const SUF = Math.random().toString(36).slice(2, 10);
const CID = `oauth_az_${SUF}`;
const URI = 'workbuddy://workbuddy/mcp/connector:az/oauth/callback';
const USER = `az_${SUF}`;
const PW = 'P@ssw0rd!';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = base64UrlSha256(VERIFIER);

let app;
beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));   // 表单 POST
  app.use(createOAuthRouter(buildOAuthDeps()));
  await queryWrite(`INSERT INTO crm.oauth_client (client_id, redirect_uris) VALUES ($1, $2::jsonb)`,
    [CID, JSON.stringify([URI])]);
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Az', true, true)`, [USER, PW]);
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
        .then(async (r) => resolve({ status: r.status, text: await r.text(), location: r.headers.get('location') }))
        .finally(() => server.close());
    });
  });
}

const goodParams = () => ({
  response_type: 'code', client_id: CID, redirect_uri: URI,
  state: 'st-1', code_challenge: CHALLENGE, code_challenge_method: 'S256',
});

describe('GET /oauth/authorize', () => {
  it('参数合法 → 200 渲染登录页，含 hidden 协议参数', async () => {
    const r = await call('GET', `/oauth/authorize?${new URLSearchParams(goodParams())}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="code_challenge"');
    expect(r.text).toContain(`value="${CHALLENGE}"`);
  });

  it('未知 client_id → 400 错误页且无 Location（不 302）', async () => {
    const r = await call('GET', `/oauth/authorize?${new URLSearchParams({ ...goodParams(), client_id: 'oauth_nope' })}`);
    expect(r.status).toBe(400);
    expect(r.location).toBeNull();
    expect(r.text).toContain('无法完成授权');
  });

  it('redirect_uri 与注册值不符 → 400 且无 Location', async () => {
    const r = await call('GET', `/oauth/authorize?${new URLSearchParams({ ...goodParams(), redirect_uri: 'https://evil.com/cb' })}`);
    expect(r.status).toBe(400);
    expect(r.location).toBeNull();
  });

  it('缺 code_challenge → 400（PKCE 强制）', async () => {
    const p = goodParams(); delete p.code_challenge;
    const r = await call('GET', `/oauth/authorize?${new URLSearchParams(p)}`);
    expect(r.status).toBe(400);
    expect(r.text).toContain('code_challenge');
  });

  it('code_challenge_method=plain → 400（只接受 S256）', async () => {
    const r = await call('GET', `/oauth/authorize?${new URLSearchParams({ ...goodParams(), code_challenge_method: 'plain' })}`);
    expect(r.status).toBe(400);
  });

  it('response_type 非 code → 400', async () => {
    const r = await call('GET', `/oauth/authorize?${new URLSearchParams({ ...goodParams(), response_type: 'token' })}`);
    expect(r.status).toBe(400);
  });
});

describe('POST /oauth/authorize', () => {
  it('正确账密 → 302 到 redirect_uri 且带 code 与 state；库中只存 sha256(code)', async () => {
    const r = await call('POST', '/oauth/authorize', { ...goodParams(), username: USER, password: PW }, true);
    expect(r.status).toBe(302);
    expect(r.location.startsWith(`${URI}?code=crmc_`)).toBe(true);
    expect(r.location).toContain('state=st-1');
    const code = new URL(r.location).searchParams.get('code');
    const row = await query(`SELECT actor FROM crm.oauth_code WHERE code_hash=$1`, [sha256Hex(code)]);
    expect(row.rows[0].actor).toBe(USER);
    // 明文绝不落库
    expect((await query(`SELECT 1 FROM crm.oauth_code WHERE code_hash=$1`, [code])).rows.length).toBe(0);
  });

  it('错误密码 → 401 登录页且无 Location；不产生授权码', async () => {
    const before = (await query(`SELECT count(*)::int n FROM crm.oauth_code`)).rows[0].n;
    const r = await call('POST', '/oauth/authorize', { ...goodParams(), username: USER, password: 'bad' }, true);
    expect(r.status).toBe(401);
    expect(r.location).toBeNull();
    expect(r.text).toContain('账号或密码不正确');
    expect((await query(`SELECT count(*)::int n FROM crm.oauth_code`)).rows[0].n).toBe(before);
  });

  it('未知账号与错误密码返回完全一致的文案（防枚举）', async () => {
    const a = await call('POST', '/oauth/authorize', { ...goodParams(), username: 'nobody_z', password: PW }, true);
    const b = await call('POST', '/oauth/authorize', { ...goodParams(), username: USER, password: 'bad' }, true);
    expect(a.text).toBe(b.text);
  });

  it('admin 账号 → 拒（继承 src/mcp/auth.js admin 禁登 MCP）', async () => {
    const ADM = `azadm_${SUF}`;
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), 'admin', 'Adm', true, true)`, [ADM, PW]);
    const r = await call('POST', '/oauth/authorize', { ...goodParams(), username: ADM, password: PW }, true);
    expect(r.status).toBe(401);
    expect(r.text).toContain('业务账号');
  });

  it('POST 重放非法 redirect_uri → 400 且无 Location（不信任 hidden 回传）', async () => {
    const r = await call('POST', '/oauth/authorize',
      { ...goodParams(), redirect_uri: 'https://evil.com/cb', username: USER, password: PW }, true);
    expect(r.status).toBe(400);
    expect(r.location).toBeNull();
  });

  it('授权时【不】铸 access token（token 只在 /oauth/token 铸 —— 计划校准 C1）', async () => {
    const before = (await query(`SELECT count(*)::int n FROM crm.mcp_identity WHERE actor=$1`, [USER])).rows[0].n;
    await call('POST', '/oauth/authorize', { ...goodParams(), username: USER, password: PW }, true);
    const after = (await query(`SELECT count(*)::int n FROM crm.mcp_identity WHERE actor=$1`, [USER])).rows[0].n;
    expect(after).toBe(before);
  });
});
