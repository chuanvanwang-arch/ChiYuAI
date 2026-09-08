// src/commands/account.js — 语义化只读 ②
import { mcpCall } from '../mcpClient.js';
import { assertReadOnly } from '../guard.js';
import { loadCredentials } from '../credentials.js';
import { DEFAULT_ENDPOINT } from '../endpoints.js';

export async function accountShow(args) {
  const name = args[0];
  if (!name) { console.error('用法: crm-cli account show <客户名称>'); process.exit(2); }
  assertReadOnly('crm-account-360');
  const c = loadCredentials();
  if (!c) { console.error('未登录：请先 crm-cli auth login'); process.exit(1); }
  const out = await mcpCall({ endpointId: c.endpoint || DEFAULT_ENDPOINT, basic: { user: c.user, pass: c.pass }, token: c.apiToken, tool: 'crm-account-360', params: { name } });
  console.log(`客户：${out?.name || name}`);
  console.log('关键联系人：', (out?.contacts || []).map((x) => x.name).join('、') || '（无）');
  console.log('在跟商机：', (out?.deals || []).map((d) => `${d.code}/${d.stage}`).join('、') || '（无）');
}
