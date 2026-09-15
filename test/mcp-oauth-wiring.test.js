// test/mcp-oauth-wiring.test.js — 接线守卫：真实 deps 装配非空 + 真实 HTTP 入口可达
// 设计：docs/2026-09-15-mcp-oauth-design.md §7.2
// 用途：防止「测试注入替身全绿、生产构造传空对象 → 运行期 500」的伪绿。
import { describe, it, expect } from 'vitest';
import { buildOAuthDeps } from '../src/mcp/oauth.js';
import { readFileSync } from 'node:fs';

describe('buildOAuthDeps 装配完整性', () => {
  const d = buildOAuthDeps();

  it('config 含全部时长/scope 字段', () => {
    expect(d.config).toBeTruthy();
    for (const k of ['accessTtlMs', 'refreshTtlMs', 'codeTtlMs', 'scope', 'allowedRedirectSchemes']) {
      expect(d.config[k], `config.${k} 缺失`).toBeDefined();
    }
  });

  it('store 的每个函数都已定义（不是空对象）', () => {
    for (const fn of [
      'insertClient', 'getClient', 'touchClient', 'verifyUser',
      'insertCode', 'getCode', 'consumeCode',
      'insertRefresh', 'getRefresh', 'markRefreshUsed', 'revokeChain',
    ]) {
      expect(typeof d.store?.[fn], `store.${fn} 未接线`).toBe('function');
    }
  });

  it('issueIdentity 与 originOf 已接线', () => {
    expect(typeof d.issueIdentity).toBe('function');
    expect(typeof d.originOf).toBe('function');
  });

  it('originOf 用真实请求对象能产出 origin', () => {
    expect(d.originOf({ headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': '81.70.184.198' } }))
      .toBe('http://81.70.184.198');
  });
});

describe('startMcpHttp 源码接线断言（防手工重构成空装配）', () => {
  const src = readFileSync(new URL('../src/mcp/server.js', import.meta.url), 'utf8');

  it('挂载了 OAuth 路由（createOAuthRouter + buildOAuthDeps）', () => {
    expect(src).toContain('createOAuthRouter');
    expect(src).toContain('buildOAuthDeps');
    expect(src).toContain("from './oauth.js'");
  });

  it('挂载了 /mcp HTTP 层鉴权闸', () => {
    expect(src).toContain('createMcpAuthGate');
    expect(src).toContain("from './httpAuth.js'");
  });

  it('闸受 MCP_CONFIG.oauth.enabled 控制（可回滚）', () => {
    expect(src).toMatch(/oauth\??\.enabled/);
  });

  it('OAuth 路由挂载早于 /mcp 路由（否则同路径冲突）', () => {
    const oauthIdx = src.indexOf('createOAuthRouter');
    const mcpIdx = src.indexOf('MCP_CONFIG.transport.streamableHttp.path, createMcpAuthGate');
    expect(oauthIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(oauthIdx).toBeLessThan(mcpIdx);
  });

  it('HTTP 入口挂了 urlencoded（OAuth 端点按 RFC 6749 用表单编码，缺失即生产全量 invalid_request）', () => {
    expect(src).toContain('express.urlencoded');
  });

  it('HTTP 端口可用 MCP_PORT 覆盖（冒烟/多实例并跑不抢占 3001）', () => {
    expect(src).toMatch(/process\.env\.MCP_PORT/);
  });

  // 2026-09-15 端到端实测暴露的死接线：MCP SDK 把原始 HTTP 头放在 `extra.requestInfo.headers`
  // （server/webStandardStreamableHttp.js:479），server.js 原先读 `extra.headers` → 恒 `{}` →
  // extractToken 永远取不到 `Authorization: Bearer` → gateway 恒返 gate:'auth_required'。
  // CLI 因走 params.api_token 未受影响，故该缺陷长期潜伏；而 OAuth 的 access_token 只存在于
  // HTTP 头 → 不修则 OAuth 全链路打通也依然不可用。此断言防回退。
  it('工具处理器从 extra.requestInfo.headers 取头（勿退回 extra.headers，否则 OAuth Bearer 到不了工具层）', () => {
    expect(src).toContain('extra?.requestInfo?.headers');
    // 三处处理器（读 / 写 / 敏感读）都必须如此
    expect((src.match(/extra\?\.requestInfo\?\.headers/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  // 出站工具层必须复用 extractToken 的双源语义（params.api_token + Bearer 头），否则 CLI 断链
  it('OAuth 工具层凭证解析复用 extractToken（双源：api_token / Bearer 头）', () => {
    const gw = readFileSync(new URL('../src/mcp/gateway.js', import.meta.url), 'utf8');
    expect(gw).toContain('extractToken');
  });
});
