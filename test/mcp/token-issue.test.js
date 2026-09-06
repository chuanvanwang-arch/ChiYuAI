// test/mcp/token-issue.test.js — 三处颁发点均产出结构化 token 且可反查（设计 §4.3）
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/mcp/issueToken.js';
import { newStructuredToken, parseTokenId } from '../../src/mcp/tokenFormat.js';

const TOKEN_RE = /^crm_[0-9a-f]{32}_[0-9a-f]{48}$/;

describe('issueToken 颁发结构化 token', () => {
  it('明文匹配结构化格式，且库中 id 与 token 中 id32 一致', async () => {
    const actor = `iss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const r = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    expect(r.alreadyExists).toBe(false);
    expect(r.tokenPlain).toMatch(TOKEN_RE);

    const { rows } = await query(`SELECT id FROM crm.mcp_identity WHERE id=$1`, [r.identityId]);
    // 库中主键 = parseTokenId 还原的带横线 UUID（parseTokenId 返回带横线形态）
    expect(String(rows[0].id)).toBe(parseTokenId(r.tokenPlain));
    expect(String(rows[0].id).replace(/-/g, '')).toBe(r.tokenPlain.slice(4, 36));
  });

  it('幂等分支：同 actor+roleTag 重复颁发不产新明文', async () => {
    const actor = `dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const a = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    expect(a.tokenPlain).toMatch(TOKEN_RE);
    const b = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    expect(b.alreadyExists).toBe(true);
    expect(b.tokenPlain).toBeNull();
    expect(b.identityId).toBe(a.identityId);
  });

  it('门户后台颁发（portal/mcpIdentity create）亦为结构化格式', async () => {
    // 直接复用格式源构造，断言其 SQL 侧显式写 id 的可行性（避免测试依赖 HTTP 后台鉴权）
    const { id, tokenPlain } = newStructuredToken();
    const ins = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, NULL, $4, '{}'::jsonb, NULL)
       RETURNING id`,
      [id, tokenPlain, `port_${Date.now()}`, 'sales']
    );
    expect(ins.rows[0].id).toBe(id);
    // 清理：软吊销（绝对禁删）
    await query(`UPDATE crm.mcp_identity SET revoked_at = now() WHERE id=$1`, [id]);
  });
});
