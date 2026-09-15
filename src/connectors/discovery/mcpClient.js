// src/connectors/discovery/mcpClient.js
// 轻量 MCP StreamableHTTP 客户端：把外部 MCP 服务器（如 anysite）接入 discovery 适配器。
// 设计铁律：
//   1. 每次调用独立 connect → call → close（会话无状态，避免长连接/会话 id 管理复杂度）；
//   2. 工具级错误（isError / data.error）由调用方兜底（fail-open），本模块只负责传输层；
//   3. 传输层异常（连接/超时）抛错，由适配器 catch 后 fail-open。
// 复用 @modelcontextprotocol/sdk（项目既有依赖），不引入新依赖。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function withClient(url, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'crm-mcp-bridge', version: '1.0.0' });
  await client.connect(transport);
  try {
    await client.notification({ method: 'notifications/initialized' });
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// 调用任意 MCP 工具，返回 { isError, data }（data 已尽力 JSON.parse 文本结果）
export async function callMcpTool(url, tool, args = {}) {
  return withClient(url, async (client) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = (res?.content || [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { isError: !!res?.isError, data };
  });
}

// 工具列表（健康/能力探测用）
export async function listMcpTools(url) {
  return withClient(url, async (client) => {
    const r = await client.listTools();
    return (r?.tools || []).map((t) => t.name);
  });
}
