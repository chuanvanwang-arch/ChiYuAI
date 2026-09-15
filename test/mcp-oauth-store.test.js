// test/mcp-oauth-store.test.js — OAuth 持久化层（客户端注册 / 授权码 CAS / refresh 轮转）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.3 / §3.6 / §4
import { describe, it, expect, beforeAll } from 'vitest';
import * as store from '../src/mcp/oauthStore.js';
import { sha256Hex } from '../src/mcp/oauthCrypto.js';
import { query, queryWrite } from '../src/db.js';

const SUF = Math.random().toString(36).slice(2, 10);
const CID = `oauth_store_${SUF}`;
const URI = 'workbuddy://workbuddy/mcp/connector:test/oauth/callback';
const PW = 'P@ssw0rd!';
const USER = `st_${SUF}`;

beforeAll(async () => {
  await store.insertClient({
    clientId: CID, clientName: 'test', redirectUris: [URI],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Store', true, true)`, [USER, PW]);
});

describe('oauthStore · client', () => {
  it('insertClient 后 getClient 可读回 redirect_uris（jsonb 已解析为数组）', async () => {
    const c = await store.getClient(CID);
    expect(c.client_id).toBe(CID);
    expect(Array.isArray(c.redirect_uris)).toBe(true);
    expect(c.redirect_uris).toEqual([URI]);
    expect(c.disabled_at).toBeNull();
  });

  it('getClient 未知 id → null', async () => {
    expect(await store.getClient('oauth_nope')).toBeNull();
  });

  it('touchClient 写 last_used_at', async () => {
    await store.touchClient(CID);
    expect((await store.getClient(CID)).last_used_at).not.toBeNull();
  });
});

describe('oauthStore · verifyUser（登录凭据，语义对齐 mcpLogin）', () => {
  it('正确凭据 → ok=true 且返回 role/tenant_id', async () => {
    const r = await store.verifyUser({ username: USER, password: PW });
    expect(r.ok).toBe(true);
    expect(r.role).toBe('sales');
    expect(r.username).toBe(USER);
  });

  it('错误密码 → ok=false（统一文案）', async () => {
    const r = await store.verifyUser({ username: USER, password: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('账号或密码不正确');
  });

  it('未知账号 → 与错误密码完全同一文案（防用户名枚举）', async () => {
    const a = await store.verifyUser({ username: 'nobody_x', password: PW });
    const b = await store.verifyUser({ username: USER, password: 'wrong' });
    expect(a.message).toBe(b.message);
  });

  it('admin 账号 → 拒（继承 src/mcp/auth.js:139）', async () => {
    const ADM = `adm_${SUF}`;
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), 'admin', 'Adm', true, true)`, [ADM, PW]);
    const r = await store.verifyUser({ username: ADM, password: PW });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('业务账号');
  });

  it('未激活账号（密码正确）→ 拒并提示激活', async () => {
    const INACT = `inact_${SUF}`;
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Inact', true, false)`, [INACT, PW]);
    const r = await store.verifyUser({ username: INACT, password: PW });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('激活');
  });

  it('禁用账号（密码正确）→ 拒', async () => {
    const DIS = `dis_${SUF}`;
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Dis', false, true)`, [DIS, PW]);
    expect((await store.verifyUser({ username: DIS, password: PW })).ok).toBe(false);
  });
});

describe('oauthStore · 授权码一次性消费（CAS）', () => {
  const H = `h_${SUF}`;

  it('insertCode → getCode 可读；consumeCode 首次成功、二次返回 null', async () => {
    await store.insertCode({
      codeHash: H, clientId: CID, actor: USER, tenantId: 'system', roleTag: 'sales',
      redirectUri: URI, codeChallenge: 'chal', scope: 'mcp', ttlMs: 300000,
    });
    const row = await store.getCode(H);
    expect(row.consumed_at).toBeNull();
    expect(row.actor).toBe(USER);

    expect(await store.consumeCode(H)).not.toBeNull();
    expect(await store.consumeCode(H)).toBeNull();          // CAS：已消费再消费必失败
    expect((await store.getCode(H)).consumed_at).not.toBeNull();
  });

  it('已过期授权码 → consumeCode 直接失败（不消费）', async () => {
    const H2 = `h2_${SUF}`;
    await store.insertCode({
      codeHash: H2, clientId: CID, actor: USER, tenantId: 'system', roleTag: 'sales',
      redirectUri: URI, codeChallenge: 'chal', scope: 'mcp', ttlMs: -1000,
    });
    expect(await store.consumeCode(H2)).toBeNull();
    expect((await store.getCode(H2)).consumed_at).toBeNull();
  });
});

describe('oauthStore · refresh 轮转与整链吊销', () => {
  it('insertRefresh（chainId=null）自动生成 chain；markRefreshUsed 首次成功二次失败', async () => {
    const h1 = sha256Hex(`r1_${SUF}`);
    const { chain_id } = await store.insertRefresh({
      tokenHash: h1, clientId: CID, actor: USER, tenantId: 'system', roleTag: 'sales',
      scope: 'mcp', ttlMs: 1000 * 60,
    });
    expect(chain_id).toBeTruthy();

    const h2 = sha256Hex(`r2_${SUF}`);
    const ok = await store.markRefreshUsed(h1, h2);
    expect(ok).not.toBeNull();
    expect(ok.chain_id).toBe(chain_id);
    expect(await store.markRefreshUsed(h1, h2)).toBeNull();      // 已轮转
    expect((await store.getRefresh(h1)).rotated_to).toBe(h2);
  });

  it('revokeChain 一次吊销链上全部未吊销行', async () => {
    const holder = sha256Hex(`r3_${SUF}`);
    const { chain_id } = await store.insertRefresh({
      tokenHash: holder, clientId: CID, actor: USER, tenantId: 'system',
      roleTag: 'sales', scope: 'mcp', ttlMs: 1000 * 60,
    });
    const leaf = sha256Hex(`r4_${SUF}`);
    await store.insertRefresh({
      tokenHash: leaf, clientId: CID, actor: USER, tenantId: 'system',
      roleTag: 'sales', scope: 'mcp', chainId: chain_id, ttlMs: 1000 * 60,
    });
    expect(await store.revokeChain(chain_id)).toBe(2);
    expect((await store.getRefresh(holder)).revoked_at).not.toBeNull();
    expect((await store.getRefresh(leaf)).revoked_at).not.toBeNull();
  });

  it('过期 refresh → markRefreshUsed 失败（不轮转）', async () => {
    const h = sha256Hex(`r5_${SUF}`);
    await store.insertRefresh({
      tokenHash: h, clientId: CID, actor: USER, tenantId: 'system',
      roleTag: 'sales', scope: 'mcp', ttlMs: -1000,
    });
    expect(await store.markRefreshUsed(h, 'next')).toBeNull();
    expect((await store.getRefresh(h)).used_at).toBeNull();
  });
});
