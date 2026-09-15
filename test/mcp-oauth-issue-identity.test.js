// test/mcp-oauth-issue-identity.test.js — 颁发收口 issueMcpIdentity 的吊销范围收敛
// 设计：docs/2026-09-15-mcp-oauth-design.md §7.1（含实施计划校准 C3）
// 目标：crm_login 与 oauth 两条渠道互不吊销对方 token，消除「CLI 登录踢掉 OAuth 会话」的静默掉线。
import { describe, it, expect } from 'vitest';
import { issueMcpIdentity, resolveIdentity } from '../src/mcp/auth.js';
import { parseTokenId } from '../src/mcp/tokenFormat.js';
import { query, queryWrite } from '../src/db.js';

const SUF = Math.random().toString(36).slice(2, 10);
const A = `ii_${SUF}`;
const CLIENT = `oauth_ii_${SUF}`;
const URI = 'workbuddy://workbuddy/mcp/connector:x/oauth/callback';

async function linkClient(clientId = CLIENT) {
  await queryWrite(
    `INSERT INTO crm.oauth_client (client_id, redirect_uris) VALUES ($1, $2::jsonb)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, JSON.stringify([URI])]);
}
async function alive(actor, since) {
  const r = await query(
    `SELECT id, scopes FROM crm.mcp_identity
      WHERE actor=$1 AND revoked_at IS NULL AND created_at >= $2`, [actor, since]);
  return r.rows;
}

describe('issueMcpIdentity · 渠道隔离', () => {
  it('oauth 渠道不吊销同 actor 的 crm_login token', async () => {
    await linkClient();
    const t0 = new Date(Date.now() - 1000);
    const cli = await issueMcpIdentity({ username: A, role: 'sales', issuedBy: 'crm_login' });
    await issueMcpIdentity({ username: A, role: 'sales', issuedBy: 'oauth', clientId: CLIENT });
    const rows = await alive(A, t0);
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.id === cli.id)).toBe(true);
  });

  it('crm_login 渠道不吊销 oauth token（双向隔离）', async () => {
    await linkClient();
    const t0 = new Date(Date.now() - 1000);
    const b = `ii2_${SUF}`;
    const oauthTok = await issueMcpIdentity({ username: b, role: 'sales', issuedBy: 'oauth', clientId: CLIENT });
    await issueMcpIdentity({ username: b, role: 'sales', issuedBy: 'crm_login' });
    const rows = await alive(b, t0);
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.id === oauthTok.id)).toBe(true);
  });

  it('oauth 渠道重复颁发（同 actor 同 client）→ 旧 oauth token 被软吊销（轮转不留僵尸）', async () => {
    await linkClient();
    const c = `ii3_${SUF}`;
    const first = await issueMcpIdentity({ username: c, role: 'sales', issuedBy: 'oauth', clientId: CLIENT });
    const second = await issueMcpIdentity({ username: c, role: 'sales', issuedBy: 'oauth', clientId: CLIENT });
    const r = await query(`SELECT revoked_at FROM crm.mcp_identity WHERE id=$1`, [first.id]);
    expect(r.rows[0].revoked_at).not.toBeNull();
    const ctx = await resolveIdentity(second.tokenPlain);
    expect(ctx.degraded).toBe(false);
    expect(ctx.actor).toBe(c);
  });

  it('oauth 渠道不吊销「不同 client」的 oauth token', async () => {
    const C2 = `oauth_ii2_${SUF}`;
    await linkClient(CLIENT);
    await linkClient(C2);
    const d = `ii4_${SUF}`;
    const c1tok = await issueMcpIdentity({ username: d, role: 'sales', issuedBy: 'oauth', clientId: CLIENT });
    await issueMcpIdentity({ username: d, role: 'sales', issuedBy: 'oauth', clientId: C2 });
    const r = await query(`SELECT revoked_at FROM crm.mcp_identity WHERE id=$1`, [c1tok.id]);
    expect(r.rows[0].revoked_at).toBeNull();
  });

  it('crm_login 渠道重复颁发 → 旧 crm_login token 被软吊销（保持既有语义）', async () => {
    const e = `ii5_${SUF}`;
    const first = await issueMcpIdentity({ username: e, role: 'sales', issuedBy: 'crm_login' });
    await issueMcpIdentity({ username: e, role: 'sales', issuedBy: 'crm_login' });
    const r = await query(`SELECT revoked_at FROM crm.mcp_identity WHERE id=$1`, [first.id]);
    expect(r.rows[0].revoked_at).not.toBeNull();
  });

  it('历史 token（scopes 无 issued_by）在 crm_login 渠道下仍被吊销（向后兼容）', async () => {
    const f = `ii6_${SUF}`;
    const legacy = await issueMcpIdentity({ username: f, role: 'sales', issuedBy: 'crm_login' });
    await queryWrite(`UPDATE crm.mcp_identity SET scopes='{}'::jsonb WHERE id=$1`, [legacy.id]);
    await issueMcpIdentity({ username: f, role: 'sales', issuedBy: 'crm_login' });
    const r = await query(`SELECT revoked_at FROM crm.mcp_identity WHERE id=$1`, [legacy.id]);
    expect(r.rows[0].revoked_at).not.toBeNull();
  });

  it('token 形如 crm_<id32>_<secret48> 且 parseTokenId 可解析（access_token 契约稳定）', async () => {
    const g = `ii7_${SUF}`;
    const t = await issueMcpIdentity({ username: g, role: 'sales', issuedBy: 'oauth', clientId: CLIENT });
    expect(t.tokenPlain).toMatch(/^crm_[a-f0-9]{32}_[a-f0-9]{48}$/);
    expect(parseTokenId(t.tokenPlain)).toBe(t.id);
  });

  it('scopes 记录 issued_by / client_id，且 sysadmin 治理标记不丢', async () => {
    const h = `ii8_${SUF}`;
    const t = await issueMcpIdentity({ username: h, role: 'sysadmin', issuedBy: 'oauth', clientId: CLIENT });
    const r = await query(`SELECT scopes FROM crm.mcp_identity WHERE id=$1`, [t.id]);
    expect(r.rows[0].scopes).toMatchObject({
      issued_by: 'oauth', client_id: CLIENT,
      write_scope: 'governance', deny_business_write: true,
    });
  });
});
