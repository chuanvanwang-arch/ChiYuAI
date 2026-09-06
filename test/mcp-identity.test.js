// test/mcp-identity.test.js — crm.mcp_identity 表 schema 验证 + issueToken 颁发幂等
// 设计输入：docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md §3
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { issueToken } from '../src/mcp/issueToken.js';

describe('crm.mcp_identity schema', () => {
  it('表 crm.mcp_identity 已存在且列齐全', async () => {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema='crm' AND table_name='mcp_identity'
         ORDER BY column_name`,
      []
    );
    const cols = r.rows.map(x => x.column_name).sort();
    // 2026-09-01 基线同步：多租户改造（docs/2026-08-31-multi-tenant-design.md）为
    // crm.mcp_identity 新增 tenant_id 列（凭证归属租户），schema 断言需同步，否则恒红。
    expect(cols).toEqual(
      ['actor', 'created_at', 'enabled', 'expires_at', 'id', 'person_id', 'revoked_at', 'role_tag', 'scopes', 'tenant_id', 'token_hash'].sort()
    );
  });
});

describe('issueToken', () => {
  // 用唯一 actor 避免与库中既有行（如 wangchuan/exec 调试遗留）幂等碰撞
  const uniq = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

  it('颁发新 actor 并入库（tokenPlain 为明文串）', async () => {
    const actor = uniq('t2a');
    const { tokenPlain, identityId, alreadyExists } = await issueToken({ actor, roleTag: 'exec', scopes: {} });
    expect(alreadyExists).toBe(false);
    expect(typeof tokenPlain).toBe('string');
    expect(tokenPlain.length).toBeGreaterThan(16);
    const r = await query(
      `SELECT actor, role_tag, enabled FROM crm.mcp_identity WHERE id=$1`,
      [identityId]
    );
    expect(r.rows[0]).toMatchObject({ actor, role_tag: 'exec', enabled: true });
  });

  it('幂等：重复颁发同 actor+role 不新增行，且不再返回明文', async () => {
    const actor = uniq('t2b');
    const first = await issueToken({ actor, roleTag: 'exec', scopes: {} });
    const before = (await query(`SELECT count(*)::int n FROM crm.mcp_identity WHERE actor=$1`, [actor])).rows[0].n;
    const again = await issueToken({ actor, roleTag: 'exec', scopes: {} });
    const after = (await query(`SELECT count(*)::int n FROM crm.mcp_identity WHERE actor=$1`, [actor])).rows[0].n;
    expect(after).toBe(before);
    expect(again.alreadyExists).toBe(true);
    expect(again.tokenPlain).toBeNull();
    expect(again.identityId).toBe(first.identityId);
  });
});
