// test/mcp-login.test.js — 外部智能体首次接入强制用户名密码验证（docs/2026-08-29-mcp-forced-login-design.md）
// 设计：crm_login 校验 crm.crm_users + 颁发 mcp_identity token；admin 拒绝；禁用拒绝；返回 token 可续读。
import { describe, it, expect, beforeAll } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import { mcpLogin } from '../src/mcp/auth.js';
import { seedActions } from '../src/action/seed-actions.js';
import { mcpReadDirect } from '../src/mcp/gateway.js';

const SUF = Math.random().toString(36).slice(2, 8);
const BIZ = `biz_${SUF}`;
const DIS = `dis_${SUF}`;
const ADM = `adm_${SUF}`;
const PW = 'P@ssw0rd!';

beforeAll(async () => {
  seedActions();
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'Biz', true),
            ($3, crypt($2, gen_salt('bf')), 'sales', 'Dis', false),
            ($4, crypt($2, gen_salt('bf')), 'admin', 'Adm', true)`,
    [BIZ, PW, DIS, ADM]
  );
});

describe('mcpLogin · 用户名密码验证', () => {
  it('正确业务账号 + 密码 → 返回结构化 token（ok=true, crm_<id32>_<secret48>）', async () => {
    const r = await mcpLogin({ username: BIZ, password: PW });
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^crm_[a-f0-9]{32}_[a-f0-9]{48}$/);
    expect(r.role).toBe('sales');
    expect(r.display_name).toBe('Biz');
  });

  it('错误密码 → 拒绝(401)', async () => {
    const r = await mcpLogin({ username: BIZ, password: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('未知账号 → 拒绝(401)', async () => {
    const r = await mcpLogin({ username: 'nobody_x', password: PW });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('禁用账号 → 拒绝(403)', async () => {
    const r = await mcpLogin({ username: DIS, password: PW });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('admin 账号 → 拒绝(403) 提示用业务账号', async () => {
    const r = await mcpLogin({ username: ADM, password: PW });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toContain('业务账号');
  });

  it('缺少参数 → 拒绝(400)', async () => {
    const r = await mcpLogin({ username: BIZ });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('返回的 token 可续读（持 token 调用 mcpReadDirect 不触发 auth_required）', async () => {
    const login = await mcpLogin({ username: BIZ, password: PW });
    expect(login.ok).toBe(true);
    const r = await mcpReadDirect('data-particle-read', { type: 'CRM_DEAL', limit: 3 }, { authorization: `Bearer ${login.token}` });
    expect(r.gate).not.toBe('auth_required');
    expect(r.ok).toBe(true);
  });
});
