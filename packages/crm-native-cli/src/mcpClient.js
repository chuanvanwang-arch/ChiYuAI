// src/mcpClient.js — StreamableHTTP JSON-RPC 客户端（零依赖）
import { resolveEndpoint, diagnoseUnreachable } from './endpoints.js';

let injectedFetch = null;
export const __setFetch = (f) => { injectedFetch = f; };
const doFetch = (...a) => (injectedFetch || fetch)(...a);

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

export function parseRpcBody(contentType, text) {
  if (String(contentType).includes('text/event-stream')) {
    const line = text.split('\n').map((s) => s.trim()).find((s) => s.startsWith('data:'));
    const payload = line ? line.slice(5).trim() : text;
    return JSON.parse(payload).result;
  }
  return JSON.parse(text).result;
}

async function rpc({ ep, basic, token, sessionId, method, params, id }) {
  const headers = { ...BASE_HEADERS };
  // 网络层：nginx Basic Auth（生产档必须 http，否则证书不匹配会丢 Authorization）
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.user}:${basic.pass}`).toString('base64')}`;
  else if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await doFetch(ep.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const nextSession = res.headers?.get?.('mcp-session-id') || sessionId;
  return { result: parseRpcBody(res.headers?.get?.('content-type') || 'application/json', text), nextSession };
}

export async function mcpCall({ endpointId, basic, token, tool, params = {}, listTools = false }) {
  const ep = resolveEndpoint(endpointId);
  let sessionId;
  try {
    const init = await rpc({ ep, basic, token, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crm-native-cli', version: '1.0.0' },
    }, id: 1 });
    sessionId = init.nextSession;
    await rpc({ ep, basic, token, sessionId, method: 'notifications/initialized', params: {}, id: 2 });
    if (listTools) {
      const r = await rpc({ ep, basic, token, sessionId, method: 'tools/list', params: {}, id: 3 });
      return r.result;
    }
    // 应用层鉴权：token 走 arguments.api_token（与 Basic 头共存；extractToken 中 params 优先）
    const merged = token ? { ...params, api_token: token } : params;
    const r = await rpc({ ep, basic, token, sessionId, method: 'tools/call', params: { name: tool, arguments: merged }, id: 4 });
    return r.result?.content?.[0]?.text ? JSON.parse(r.result.content[0].text) : r.result;
  } catch (e) {
    throw Object.assign(new Error(diagnoseUnreachable(endpointId, e)), { cause: e });
  }
}
