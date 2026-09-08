// src/commands/deal.js — 语义化只读 ①
import { mcpCall } from '../mcpClient.js';
import { assertReadOnly } from '../guard.js';
import { loadCredentials } from '../credentials.js';
import { DEFAULT_ENDPOINT } from '../endpoints.js';

export async function dealList(args) {
  const stageIdx = args.indexOf('--stage');
  const params = stageIdx !== -1 ? { stage: args[stageIdx + 1] } : {};
  assertReadOnly('crm-funnel-classify');
  const c = loadCredentials();
  if (!c) { console.error('未登录：请先 crm-cli auth login'); process.exit(1); }
  // 真实只读工具：crm-funnel-classify（按阶段分布），无独立的 crm-deal-list 工具
  const out = await mcpCall({ endpointId: c.endpoint || DEFAULT_ENDPOINT, basic: { user: c.user, pass: c.pass }, token: c.apiToken, tool: 'crm-funnel-classify', params });
  // 字段映射以真实返回为准：首次联调时用 crm-cli call crm-funnel-classify '{}' 核对后固化
  const rows = Array.isArray(out) ? out : (out?.items || out?.rows || out?.deals || []);
  if (rows.length === 0) { console.error('返回空集合：请确认端点、租户与筛选条件（空集合不等于成功）'); process.exit(1); }
  console.log(['商机号', '阶段', '金额', '客户'].join('\t'));
  for (const r of rows) console.log([r.code || r.id, r.stage, r.amount, r.account_name || r.account].join('\t'));
}
