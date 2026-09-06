// test/mcp-auth.test.js — 凭证解析扩展单测（Task 1）
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveApiToken, extractToken, buildMcpCtx, loadEnvToken, resolveIdentity } from '../src/mcp/auth.js';
import { MCP_CONFIG } from '../src/mcp/config.js';

describe('resolveApiToken · 降级可见性', () => {
  beforeEach(() => { delete process.env.CRM_API_TOKEN; });

  it('完全无凭证 → 降级 sales + prompt_needed=true', () => {
    const r = resolveApiToken(null);
    expect(r.degraded).toBe(true);
    expect(r.role).toBe('sales');
    expect(r.degraded_reason).toContain('无凭证');
    expect(r.prompt_needed).toBe(true);
  });

  it('未知 token → 降级 sales + prompt_needed=true', () => {
    const r = resolveApiToken('not-a-real-token');
    expect(r.degraded).toBe(true);
    expect(r.prompt_needed).toBe(true);
    expect(r.degraded_reason).toContain('未知');
  });

  it('合法 demo token → 不降级，返回 actor/role', () => {
    const tok = Object.keys(MCP_CONFIG.apiToken)[0];
    const r = resolveApiToken(tok);
    expect(r.degraded).toBe(false);
    expect(r.prompt_needed).toBe(false);
    expect(r.actor).toBe('wangchuan');
    expect(r.role).toBe('sales');
  });
});

describe('extractToken · 环境变量源', () => {
  it('params.api_token 优先', () => {
    expect(extractToken({ api_token: 'abc' }, {})).toBe('abc');
  });
  it('Bearer header 次之', () => {
    expect(extractToken({}, { authorization: 'Bearer xyz' })).toBe('xyz');
  });
  it('均无 → 回退 process.env.CRM_API_TOKEN', () => {
    process.env.CRM_API_TOKEN = 'env-tok-123';
    expect(extractToken({}, {})).toBe('env-tok-123');
    delete process.env.CRM_API_TOKEN;
  });
});

describe('loadEnvToken · 环境变量注入 apiToken 映射', () => {
  it('CRM_API_TOKEN=actor:role → resolveApiToken 解析成功', () => {
    process.env.CRM_API_TOKEN = 'alice:manager';
    loadEnvToken();
    const r = resolveApiToken('alice:manager');
    expect(r.degraded).toBe(false);
    expect(r.actor).toBe('alice');
    expect(r.role).toBe('manager');
    delete process.env.CRM_API_TOKEN;
  });
});

describe('buildMcpCtx · prompt_needed 透传', () => {
  it('无凭证 ctx 携带 degraded + prompt_needed', async () => {
    const ctx = await buildMcpCtx({ token: null });
    expect(ctx.degraded).toBe(true);
    expect(ctx.prompt_needed).toBe(true);
    expect(ctx.role).toBe('sales');
  });
});

describe('resolveIdentity', () => {
  it('命中 owner token → role=exec, degraded=false', async () => {
    const { issueToken } = await import('../src/mcp/issueToken.js');
    // 用唯一 actor 避免与 DB 中既有 wangchuan+exec 行幂等碰撞（issueToken 零信任：明文仅首发入库）
    const actor = `owner_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'exec', scopes: {} });
    const r = await resolveIdentity(tokenPlain);
    expect(r.role).toBe('exec');
    expect(r.degraded).toBe(false);
    expect(r.actor).toBe(actor);
  });

  it('无 token → 降级 sales', async () => {
    const r = await resolveIdentity(null);
    expect(r.role).toBe('sales');
    expect(r.degraded).toBe(true);
  });

  it('未知 token → 降级 sales', async () => {
    const r = await resolveIdentity('deadbeef'.repeat(12));
    expect(r.role).toBe('sales');
    expect(r.degraded).toBe(true);
  });

  it('过期 token → 降级 sales', async () => {
    const { issueToken } = await import('../src/mcp/issueToken.js');
    const actor = `exp_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'sales', scopes: {}, expiresAt: new Date(Date.now() - 1000) });
    const r = await resolveIdentity(tokenPlain);
    expect(r.role).toBe('sales');
    expect(r.degraded).toBe(true);
  });
});

describe('buildMcpCtx identity injection', () => {
  it('owner token → ctx 含 identity_id/person_id/scopes', async () => {
    const { issueToken } = await import('../src/mcp/issueToken.js');
    const actor = `ctx_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain, identityId } = await issueToken({ actor, roleTag: 'exec', scopes: { deny_domains: ['CRM_CUSTOMER'] } });
    const ctx = await buildMcpCtx({ token: tokenPlain });
    expect(ctx.identity_id).toBe(identityId);
    expect(ctx.role).toBe('exec');
    expect(ctx.scopes).toEqual({ deny_domains: ['CRM_CUSTOMER'] });
  });

  it('无 token → ctx 缺 identity_id 且 degraded', async () => {
    const ctx = await buildMcpCtx({ token: null });
    expect(ctx.identity_id).toBeUndefined();
    expect(ctx.degraded).toBe(true);
    expect(ctx.role).toBe('sales');
  });
});
