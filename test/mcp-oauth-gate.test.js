// test/mcp-oauth-gate.test.js — /mcp HTTP 层鉴权闸
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.7
//
// 为什么必须在 HTTP 层：gateway 的 requireAuth 在 tool-call 层返回 HTTP 200 + {gate:'auth_required'}，
// 客户端据此不认为需要重新授权 → 静默续期失效。401 + WWW-Authenticate 是触发 OAuth 发现链的唯一开关。
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createMcpAuthGate, isAuthExempt } from '../src/mcp/httpAuth.js';
import { issueMcpIdentity } from '../src/mcp/auth.js';
import { queryWrite } from '../src/db.js';

const SUF = Math.random().toString(36).slice(2, 10);
const USER = `gt_${SUF}`;
let app;
let validToken;
let expiredToken;

beforeAll(async () => {
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
     VALUES ($1, crypt('P@ssw0rd!', gen_salt('bf')), 'sales', 'Gt', true, true)`, [USER]);
  validToken = (await issueMcpIdentity({ username: USER, role: 'sales', issuedBy: 'crm_login' })).tokenPlain;
  const other = `gt2_${SUF}`;
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled, activated)
     VALUES ($1, crypt('P@ssw0rd!', gen_salt('bf')), 'sales', 'Gt2', true, true)`, [other]);
  expiredToken = (await issueMcpIdentity({ username: other, role: 'sales', issuedBy: 'crm_login', ttlMs: -1000 })).tokenPlain;

  app = express();
  app.use(express.json());
  app.use('/mcp', createMcpAuthGate());
  // 探针路由：能到这里说明闸放行
  app.all('/mcp', (req, res) => res.status(200).json({ reached: true }));
});

async function call(body, headers = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const opts = {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      };
      fetch(`http://127.0.0.1:${port}/mcp`, opts)
        .then(async (r) => resolve({ status: r.status, json: await r.json().catch(() => null), wwwAuth: r.headers.get('www-authenticate') }))
        .finally(() => server.close());
    });
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '1' } } };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const loginCall = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crm_login', arguments: { username: 'x', password: 'y' } } };

describe('isAuthExempt', () => {
  it('initialize / notifications/* / tools/call[crm_login] 免鉴权', () => {
    expect(isAuthExempt(init)).toBe(true);
    expect(isAuthExempt({ method: 'notifications/initialized' })).toBe(true);
    expect(isAuthExempt(loginCall)).toBe(true);
  });
  it('tools/list / 其他 tools/call 不免鉴权', () => {
    expect(isAuthExempt(list)).toBe(false);
    expect(isAuthExempt({ method: 'tools/call', params: { name: 'data-particle-read' } })).toBe(false);
  });
  it('无 body（GET/DELETE）视为免鉴权，由会话查找兜底', () => {
    expect(isAuthExempt(undefined)).toBe(true);
  });
});

describe('/mcp HTTP 层闸', () => {
  it('initialize 无 token → 200（allowlist，CLI 兼容所需）', async () => {
    const r = await call(init);
    expect(r.status).toBe(200);
    expect(r.json.reached).toBe(true);
  });

  it('tools/call[crm_login] 无 token → 200（登录入口必须无凭据可达）', async () => {
    expect((await call(loginCall)).status).toBe(200);
  });

  it('tools/list 无 token → 401 + WWW-Authenticate: Bearer resource_metadata（触发 OAuth 发现链）', async () => {
    const r = await call(list, { 'x-forwarded-proto': 'http', 'x-forwarded-host': '81.70.184.198' });
    expect(r.status).toBe(401);
    expect(r.wwwAuth).toContain('Bearer');
    expect(r.wwwAuth).toContain('realm="crm-mcp"');
    expect(r.wwwAuth).toContain('resource_metadata="http://81.70.184.198/.well-known/oauth-protected-resource"');
    expect(r.json.reached).toBeUndefined();
  });

  it('tools/list 有效 Bearer token → 200', async () => {
    const r = await call(list, { authorization: `Bearer ${validToken}` });
    expect(r.status).toBe(200);
    expect(r.json.reached).toBe(true);
  });

  it('tools/list 过期 token → 401（不是 200 + gate:auth_required）', async () => {
    const r = await call(list, { authorization: `Bearer ${expiredToken}` });
    expect(r.status).toBe(401);
    expect(r.wwwAuth).toContain('Bearer');
  });

  it('tools/list 非法格式 token → 401', async () => {
    expect((await call(list, { authorization: 'Bearer not-a-token' })).status).toBe(401);
  });

  it('tools/list token 走 params.api_token 亦有效（crm-native-cli 兼容，不得只认 Bearer 头）', async () => {
    const r = await call({ ...list, params: { api_token: validToken } });
    expect(r.status).toBe(200);
    expect(r.json.reached).toBe(true);
  });

  it('initialize 带过期 token → 401（有凭据就要校验，供 SSE 重连触发续期）', async () => {
    expect((await call(init, { authorization: `Bearer ${expiredToken}` })).status).toBe(401);
  });

  it('initialize 带有效 token → 200', async () => {
    expect((await call(init, { authorization: `Bearer ${validToken}` })).status).toBe(200);
  });

  it('resolveIdentity 抛异常时 fail-closed（401 而非 200）', async () => {
    const app2 = express();
    app2.use(express.json());
    app2.use('/mcp', createMcpAuthGate({
      resolveIdentity: async () => { throw new Error('db down'); },
      originOf: () => 'http://x',
    }));
    app2.all('/mcp', (req, res) => res.status(200).json({ reached: true }));
    const status = await new Promise((resolve) => {
      const server = app2.listen(0, () => {
        fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list),
        }).then((r) => resolve(r.status)).finally(() => server.close());
      });
    });
    expect(status).toBe(401);
  });
});
