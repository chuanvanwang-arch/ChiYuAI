// test/mcp-oauth-schema.test.js — OAuth 三张表 schema 验证
// 设计：docs/2026-09-15-mcp-oauth-design.md §4（含计划校准 C1/C2）
import { describe, it, expect } from 'vitest';
import { query, queryWrite } from '../src/db.js';

async function colsOf(table) {
  const r = await query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name=$1 ORDER BY column_name`, [table]);
  return r.rows.map(x => x.column_name).sort();
}

describe('crm.oauth_* schema', () => {
  it('crm.oauth_client 列齐全', async () => {
    expect(await colsOf('oauth_client')).toEqual(
      ['client_id', 'client_name', 'redirect_uris', 'grant_types',
       'token_endpoint_auth_method', 'created_at', 'last_used_at', 'disabled_at'].sort()
    );
  });

  it('crm.oauth_code 列齐全，且不含 identity_id（校准 C1/C2）', async () => {
    const cols = await colsOf('oauth_code');
    expect(cols).toEqual(
      ['code_hash', 'client_id', 'actor', 'tenant_id', 'role_tag', 'redirect_uri',
       'code_challenge', 'code_challenge_method', 'scope', 'expires_at', 'consumed_at', 'created_at'].sort()
    );
    expect(cols).not.toContain('identity_id');
  });

  it('crm.oauth_refresh 列齐全', async () => {
    expect(await colsOf('oauth_refresh')).toEqual(
      ['token_hash', 'client_id', 'actor', 'tenant_id', 'role_tag', 'scope', 'chain_id',
       'rotated_to', 'expires_at', 'used_at', 'revoked_at', 'created_at'].sort()
    );
  });

  it('code_challenge_method 有 S256 约束（plain 被库直接拒绝）', async () => {
    const cid = `oauth_schema_${Math.random().toString(36).slice(2, 10)}`;
    await queryWrite(
      `INSERT INTO crm.oauth_client (client_id, redirect_uris)
       VALUES ($1, '["workbuddy://workbuddy/mcp/connector:x/oauth/callback"]'::jsonb)`, [cid]);
    await expect(
      queryWrite(
        `INSERT INTO crm.oauth_code
           (code_hash, client_id, actor, role_tag, redirect_uri, code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, 'a', 'sales', 'r', 'c', 'plain', now() + interval '5 minutes')`,
        [`h_plain_${cid}`, cid])
    ).rejects.toThrow();
  });
});
