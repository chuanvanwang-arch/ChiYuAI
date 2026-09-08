// src/commands/auth.js — auth login / auth status
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { saveCredentials, loadCredentials } from '../credentials.js';
import { resolveEndpoint, diagnoseUnreachable, DEFAULT_ENDPOINT } from '../endpoints.js';
import { mcpCall } from '../mcpClient.js';

// ⚠ 零信任：口令只在终端交互读取，绝不回显、绝不写入日志、绝不经聊天传递
async function promptSecret(rl, label) {
  output.write(`${label}: `);
  return new Promise((resolve) => {
    const wasRaw = input.isRaw || false;
    if (input.setRawMode) input.setRawMode(true);
    let v = '';
    const onData = (ch) => {
      const s = String(ch);
      if (s === '\n' || s === '\r' || s === '\u0004') {
        input.off('data', onData);
        if (input.setRawMode) input.setRawMode(wasRaw);
        output.write('\n');
        resolve(v);
      } else if (s === '\u007f') { v = v.slice(0, -1); }
      else { v += s; }
    };
    input.on('data', onData);
  });
}

export async function authLogin(args = {}) {
  const id = args.endpoint || DEFAULT_ENDPOINT;
  const ep = resolveEndpoint(id);
  const rl = createInterface({ input, output });
  try {
    const user = (await rl.question(`CRM 用户名 (端点 ${id} ${ep.url}): `)).trim();
    const pass = await promptSecret(rl, 'CRM 密码（不回显）');
    if (!user || !pass) { console.error('用户名与密码均不能为空'); process.exit(2); }

    // 应用层鉴权：调用 crm_login 换取 api_token（MCP requireAuth=true）
    const res = await mcpCall({
      endpointId: id, basic: { user, pass }, tool: 'crm_login',
      params: { username: user, password: pass },
    });
    const token = res?.api_token || res?.token;
    if (!token) { console.error('crm_login 未返回 api_token'); process.exit(1); }

    saveCredentials({
      endpoint: id, user, pass,
      apiToken: token,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000, // 与 MCP tokenTtlMs 8h 对齐
    });
    console.log(`已登录：端点 ${id}（${ep.url}），凭据存于 ~/.crm-cli/credentials`);
  } catch (e) {
    console.error(diagnoseUnreachable(id, e));
    process.exit(1);
  } finally { rl.close(); }
}

export async function authStatus() {
  const c = loadCredentials();
  if (!c?.apiToken || (c.expiresAt && c.expiresAt < Date.now())) {
    console.log(JSON.stringify({ status: 'invalid', reason: c ? 'token 已过期，请重新 auth login' : '未登录' }));
    process.exit(1);
  }
  try {
    // 探活统一走 tools/list：注册表内无 crm_ping 工具
    await mcpCall({ endpointId: c.endpoint, basic: { user: c.user, pass: c.pass }, token: c.apiToken, listTools: true });
    console.log(JSON.stringify({ status: 'valid', endpoint: c.endpoint }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'invalid', reason: e.message }));
    process.exit(1);
  }
}
