// src/commands/call.js — 通用转发（只读）
import { mcpCall } from '../mcpClient.js';
import { assertReadOnly } from '../guard.js';
import { loadCredentials } from '../credentials.js';
import { DEFAULT_ENDPOINT } from '../endpoints.js';

export async function callTool(args) {
  const [tool, jsonRaw] = args;
  if (!tool) { console.error('用法: crm-cli call <tool> [json]'); process.exit(2); }
  let params = {};
  if (jsonRaw) { try { params = JSON.parse(jsonRaw); } catch { console.error('参数 JSON 解析失败'); process.exit(2); } }
  assertReadOnly(tool); // 红线：在任何网络请求之前
  const c = loadCredentials();
  if (!c) { console.error('未登录：请先 crm-cli auth login'); process.exit(1); }
  const out = await mcpCall({ endpointId: c.endpoint || DEFAULT_ENDPOINT, basic: { user: c.user, pass: c.pass }, token: c.apiToken, tool, params });
  console.log(JSON.stringify(out, null, 2));
}
