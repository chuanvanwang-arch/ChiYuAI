import { describe, it, expect } from 'vitest';
import { mcpLogin, buildMcpCtx } from '../src/mcp/auth.js';
import { migrateTenant } from '../db/migrate-tenant.js';
import { query } from '../src/db.js';

const rnd = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe('MCP 租户解析', () => {
  it('M1 登录 alice(system) 后 mcp_identity.tenant_id 落库 = system', async () => {
    const r = await mcpLogin({ username: 'alice', password: 'secret123' });
    expect(r.ok).toBe(true);
    const id = await query(
      `SELECT tenant_id FROM crm.mcp_identity WHERE token_hash = crypt($1, token_hash)`,
      [r.token]
    );
    expect(id.rows[0].tenant_id).toBe('system');
  }, 15000);

  it('M2 acme 租户用户登录 → buildMcpCtx().tenantId === acme（证明非硬编码）', async () => {
    const acmeUser = `mt_acme_${rnd()}`;
    await query(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'MT Acme', true, 'acme')`,
      [acmeUser, 'secret123']
    );
    const r = await mcpLogin({ username: acmeUser, password: 'secret123' });
    expect(r.ok).toBe(true);
    const ctx = await buildMcpCtx({ token: r.token });
    expect(ctx.tenantId).toBe('acme');
  });

  it('M3 显式传 tenantId=system 时身份租户优先（验证 gateway 删硬编码无副作用）', async () => {
    const acmeUser = `mt_acme2_${rnd()}`;
    await query(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'MT Acme2', true, 'acme')`,
      [acmeUser, 'secret123']
    );
    const r = await mcpLogin({ username: acmeUser, password: 'secret123' });
    const ctx = await buildMcpCtx({ token: r.token, tenantId: 'system' });
    expect(ctx.tenantId).toBe('acme'); // 身份 tenant_id 优先于显式 'system' 兜底
  });

  it('M4 老 token 软迁移：mcp_identity 无 NULL tenant_id 且 migrateTenant 幂等（禁删）', async () => {
    // 注：mcp_identity.tenant_id 为 NOT NULL DEFAULT 'system'，物理上不可能存在 NULL 行；
    // §6 迁移（UPDATE ... WHERE tenant_id IS NULL）是防御性幂等兜底，正常影响 0 行、绝不 DELETE。
    // 本用例验证真实不变式：迁移后全表无 NULL，且迁移函数幂等、非抛错。
    const { rows: ins } = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
       VALUES (gen_random_uuid(), crypt('x', gen_salt('bf')), 'alice', NULL, 'sales', '{}'::jsonb, now() + interval '1 hour')
       RETURNING id, tenant_id`
    );
    expect(ins[0].tenant_id).toBe('system'); // NOT NULL DEFAULT 保证非空
    const nullBefore = await query(`SELECT count(*)::int AS n FROM crm.mcp_identity WHERE tenant_id IS NULL`);
    expect(nullBefore.rows[0].n).toBe(0); // 迁移前已无 NULL
    await migrateTenant(); // 不应抛错（含 §6 段）
    const after = await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [ins[0].id]);
    expect(after.rows[0].tenant_id).toBe('system');
    // 幂等：再跑一次不应报错、值不变
    await migrateTenant();
    const after2 = await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [ins[0].id]);
    expect(after2.rows[0].tenant_id).toBe('system');
    const nullAfter = await query(`SELECT count(*)::int AS n FROM crm.mcp_identity WHERE tenant_id IS NULL`);
    expect(nullAfter.rows[0].n).toBe(0); // 迁移后无 NULL
  });
});
