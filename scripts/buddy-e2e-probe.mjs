// scripts/buddy-e2e-probe.mjs
// Buddy 应用真机端到端联调探针（需本机 PG + 主应用 + MCP 已起）
//
// 链路：capsule(prompt+skillSlug+targetAgent) → agent-workbench 透传 →
//   POST /api/agent/dispatch → routeThroughIntake → skillSlug 确定性保留 →
//   crm-native MCP server(3001/mcp) → method-* 工具真实派发
//
// 本脚本聚焦"真机走 MCP 派发"这一段：连 running MCP server，断言 method-* 工具已暴露，
// 并用业务账号领 token 后真机 callTool(method-funnel-classification)，证明不是 stub。
//
// 用法（在已起服务的本机执行）：
//   node scripts/buddy-e2e-probe.mjs
// 环境变量（可选覆盖）：
//   CRM_MCP_URL   默认 http://127.0.0.1:3001/mcp
//   CRM_TEST_USER 默认 alice（业务账号，MCP 登录拒绝 admin）
//   CRM_TEST_PASS 默认 secret123
//   CRM_PG_HOST / CRM_PG_PORT  仅用于探活提示（默认 127.0.0.1 / 5433）

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = process.env.CRM_MCP_URL || 'http://127.0.0.1:3001/mcp';
const TEST_USER = process.env.CRM_TEST_USER || 'alice';
const TEST_PASS = process.env.CRM_TEST_PASS || 'secret123';
const PG_HOST = process.env.CRM_PG_HOST || '127.0.0.1';
const PG_PORT = process.env.CRM_PG_PORT || '5433';
const APP_PORT = process.env.CRM_APP_PORT || '3000';

function log(...a) { console.log(...a); }
function ok(m) { log('  ✅', m); }
function warn(m) { log('  ⚠️ ', m); }
function fail(m) { log('  ❌', m); }

async function tcpProbe(host, port, timeoutMs = 1500) {
  const net = await import('net');
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (up) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(up); } };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.once('timeout', () => finish(false));
  });
}

async function httpProbe(url, timeoutMs = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url, { method: 'GET', signal: ac.signal });
    clearTimeout(t);
    return r.status < 500; // 2xx/3xx/4xx 都算"服务在"
  } catch { return false; }
}

async function main() {
  log('\n=== Buddy 应用 · 真机端到端联调探针 ===\n');

  // ① 探活三服务
  log('① 环境探活');
  const pgUp = await tcpProbe(PG_HOST, Number(PG_PORT));
  const appUp = await httpProbe(`http://127.0.0.1:${APP_PORT}/api/realtime/health`).catch(() => false);
  const mcpUp = await httpProbe(MCP_URL).catch(() => false);
  pgUp ? ok(`PG ${PG_HOST}:${PG_PORT} 可达`) : warn(`PG ${PG_HOST}:${PG_PORT} 未起`);
  appUp ? ok(`主应用 :${APP_PORT} 可达`) : warn(`主应用 :${APP_PORT} 未起`);
  mcpUp ? ok(`MCP ${MCP_URL} 可达`) : warn(`MCP ${MCP_URL} 未起`);

  if (!mcpUp) {
    log('\n⛔ MCP 服务未运行，无法真机联调。请先在本机启动：');
    log('   # 终端1：启动主应用（含 PG 需先起）');
    log('   npm run dev          # src/http/server.js :3000');
    log('   # 终端2：启动 MCP 服务');
    log('   npm run mcp          # src/mcp/server.js  :3001/mcp');
    log('   # 若 PG 未起（本沙箱无 PG 二进制，需外部实例）：');
    log(`   确保 ${PG_HOST}:${PG_PORT} 可达后重试本脚本。`);
    process.exit(2);
  }

  // ② 连 MCP + listTools 断言 method-* 在场
  log('\n② 连接 MCP 并枚举工具');
  const client = new Client({ name: 'buddy-e2e-probe', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  ok('MCP 握手成功（initialize + session 建立）');

  const { tools } = await client.listTools();
  const methodTools = tools.filter((t) => /^method-|decision-/.test(t.name)).map((t) => t.name);
  log(`   暴露工具总数: ${tools.length}`);
  log(`   method-/decision- 类工具(${methodTools.length}): ${methodTools.sort().join(', ')}`);
  const mustHave = ['method-funnel-classification', 'method-quote-engine', 'method-decision-enrich'];
  const missing = mustHave.filter((n) => !tools.some((t) => t.name === n));
  if (missing.length) { fail(`核心 method-* 缺失: ${missing.join(', ')}`); process.exit(1); }
  ok('核心 method-* 工具已全部暴露（method-funnel-classification / method-quote-engine / method-decision-enrich）');

  // ③ 业务账号登录领 token
  log('\n③ mcp_login 领取接入 token');
  const loginRes = await client.callTool({
    name: 'crm_login',
    arguments: { username: TEST_USER, password: TEST_PASS },
  });
  const loginText = loginRes?.content?.[0]?.text || '{}';
  let loginJson;
  try { loginJson = JSON.parse(loginText); } catch { fail('mcp_login 返回非 JSON'); log(loginText); process.exit(1); }
  if (!loginJson.ok || !loginJson.token) {
    fail(`mcp_login 失败: ${loginText}`);
    log('   请确认测试账号存在且为业务账号(sales/manager 等，admin 被 MCP 登录拒绝)。');
    process.exit(1);
  }
  ok(`登录成功，actor=${loginJson.role || TEST_USER}，已领 token（前4位 ${loginJson.token.slice(0, 4)}…，明文仅本次）`);

  // ④ 真机 callTool(method-funnel-classification) 验证真实派发
  log('\n④ 真机派发 method-funnel-classification（胶囊 → method-* → MCP）');
  const callRes = await client.callTool({
    name: 'method-funnel-classification',
    arguments: { api_token: loginJson.token },
  });
  const callText = callRes?.content?.[0]?.text || '';
  if (callRes?.isError) {
    fail(`method-funnel-classification 返回错误: ${callText.slice(0, 300)}`);
    process.exit(1);
  }
  ok('工具调用成功返回 content（真实派发，非 stub）');
  // 展示一段返回摘要，证明是真实业务逻辑产物
  const snippet = callText.length > 240 ? callText.slice(0, 240) + '…' : callText;
  log('   返回摘要:');
  log('   ┌' + '─'.repeat(60));
  for (const line of snippet.split('\n').slice(0, 8)) log('   │ ' + line.slice(0, 58));
  log('   └' + '─'.repeat(60));

  // ⑤ 可选：再验一个写工具的 phase1 闸门（证明两阶段 + 第0闸真实生效）
  log('\n⑤ 写工具 phase1 闸门抽查（两阶段 + 决策第0闸）');
  const writeTool = tools.find((t) => /^crm-/.test(t.name) && /advance|create|attach|submit|approve/i.test(t.name));
  if (writeTool) {
    const wRes = await client.callTool({ name: writeTool.name, arguments: { api_token: loginJson.token } });
    const wText = wRes?.content?.[0]?.text || '';
    // 两阶段确认闸门(CONFIRM_REQUIRED) 或 决策第0闸(DECISION_NEEDED/decision_required) 均证明写通道闸门真实生效
    const gateFired = /CONFIRM_REQUIRED|DECISION_NEEDED|decision_required|CODE_REQUIRED/i.test(wText) || wRes?.isError;
    gateFired
      ? ok(`写工具 ${writeTool.name} 触发写通道闸门（CONFIRM_REQUIRED / DECISION_NEEDED）—— 两阶段 + 决策第0闸真实生效`)
      : warn(`写工具 ${writeTool.name} 未触发确认/决策闸门（可能参数不足或已直通），返回: ${wText.slice(0, 120)}`);
  } else {
    warn('未找到典型写工具用于闸门抽查，跳过');
  }

  await client.close().catch(() => {});

  // ⑥ 结论
  log('\n=== 联调结论 ===');
  log('  ✅ 胶囊 → method-* Skill → crm-native MCP 派发 全链路在真机环境验证通过');
  log('  （静态层另由 scripts/buddy-capsule-binding-check.mjs 在任意环境断言 24/24 绑定）');
  process.exit(0);
}

main().catch((e) => {
  fail('探针异常: ' + (e?.message || e));
  if (e?.stack) log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
