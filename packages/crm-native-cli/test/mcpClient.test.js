import { describe, it, expect, beforeEach } from 'vitest';
import { mcpCall, parseRpcBody, __setFetch } from '../src/mcpClient.js';

describe('MCP 客户端', () => {
  beforeEach(() => { __setFetch(null); });

  it('initialize 后携带 Mcp-Session-Id，并发送 notifications/initialized', async () => {
    const calls = [];
    __setFetch(async (url, opt) => {
      const body = JSON.parse(opt.body);
      calls.push({ url, method: body.method, headers: opt.headers });
      const isInit = body.method === 'initialize';
      return {
        ok: true, status: 200,
        headers: { get: (k) => (isInit && k.toLowerCase() === 'mcp-session-id' ? 'sess-1' : 'application/json') },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }),
      };
    });
    await mcpCall({ endpointId: 'prod', basic: { user: 'a', pass: 'b' }, tool: 'crm-account-360', params: { name: 'XX 制造' } });
    expect(calls[0].method).toBe('initialize');
    expect(calls.some((c) => c.method === 'notifications/initialized')).toBe(true);
    expect(calls.at(-1).method).toBe('tools/call');
    expect(calls.at(-1).headers['Mcp-Session-Id']).toBe('sess-1');
  });

  it('Basic 与 api_token 共存：Authorization 为 Basic，token 走 arguments', async () => {
    let last;
    __setFetch(async (url, opt) => {
      last = { headers: opt.headers, body: JSON.parse(opt.body) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) };
    });
    await mcpCall({ endpointId: 'prod', basic: { user: 'admin', pass: 'p' }, token: 'T', tool: 'x', params: { q: 1 } });
    expect(last.headers.Authorization).toMatch(/^Basic /);
    const call = last.body;
    // api_token 必须落在工具 arguments 内（服务端 extractToken 从 arguments 取，非 JSON-RPC params）
    expect(call.params.arguments.api_token).toBe('T');
  });

  it('SSE 与 JSON 两种响应都能解析', () => {
    expect(parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toEqual({ a: 1 });
    expect(parseRpcBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n')).toEqual({ a: 2 });
  });
});
