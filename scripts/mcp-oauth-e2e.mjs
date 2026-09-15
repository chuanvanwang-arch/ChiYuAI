// scripts/mcp-oauth-e2e.mjs — MCP OAuth 端到端验证（单测全绿 ≠ 链路通）
// 设计：docs/2026-09-15-mcp-oauth-design.md §10
//
// 用法：
//   本地：PGDATABASE=crm_native_test MCP_PORT=3100 node src/mcp/server.js --http
//         node scripts/mcp-oauth-e2e.mjs                    # 默认 http://127.0.0.1:3100
//   生产：node scripts/mcp-oauth-e2e.mjs --base http://81.70.184.198 --user <u> --pass <p>
//         （凭据建议改用环境变量 MCP_OAUTH_USER / MCP_OAUTH_PASS，避免落到命令行历史）
// 判据：全部用例 PASS 才算链路通；任一 FAIL 退出码非 0。
//
// ⚠ 与实施计划的差异（有意修正）：计划正文里用 `require('node:crypto')` 生成 PKCE challenge，
//   但本文件是 ESM（.mjs），`require` 未定义 → 运行期 ReferenceError，全部用例崩。此处改为具名 import。
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const BASE = (arg('--base', process.env.MCP_OAUTH_BASE || 'http://127.0.0.1:3100')).replace(/\/+$/, '');
const USER = arg('--user', process.env.MCP_OAUTH_USER || 'alice');
const PASS = arg('--pass', process.env.MCP_OAUTH_PASS || 'secret123');
const CLIENT_NAME = 'mcp-oauth-e2e';
const REDIRECT = 'workbuddy://workbuddy/mcp/connector:e2e/oauth/callback';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

// PKCE verifier/challenge：与 src/mcp/oauthCrypto.js 同算法，此处**独立实现**（形成交叉验证，
// 避免「测试复用被测实现」导致的同错双绿）。
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const VERIFIER = b64url(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 40)));
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());

async function j(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

async function form(path, obj) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(obj).toString(),
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, json: parsed, text, headers: res.headers };
}

// 建立 MCP 会话：StreamableHTTP 要求先 initialize 拿 `mcp-session-id`，
// 后续 tools/list / tools/call 必须带该头，否则被拒 `400 Server not initialized`。
// ⚠ 这正是首轮跑出的假绿来源：不带会话时 tools/list 返回 400，
//   而「断言 status !== 401」会把它误判为通过。故本脚本对成功路径一律断言 200。
async function mcpSession(token) {
  const base = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const initRes = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: base,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: CLIENT_NAME, version: '1.0' } },
    }),
  });
  const sid = initRes.headers.get('mcp-session-id') || '';
  const initText = await initRes.text();
  const headers = { ...base, ...(sid ? { 'mcp-session-id': sid } : {}) };
  let id = 1;
  const call = async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await res.text();
    return { status: res.status, text, json: parseMcpResult(text) };
  };
  // 协议要求 initialize 后发 initialized 通知（失败不阻断，仅记录）
  try {
    await fetch(`${BASE}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  } catch { /* 通知失败不影响后续断言 */ }
  return { sid, initStatus: initRes.status, initText, call };
}

// 单次裸调（不建会话）：仅用于探测 HTTP 层闸的行为（无 token → 401 / initialize → 放行）。
const mcpCall = (body, token) => j('POST', '/mcp', body, {
  accept: 'application/json, text/event-stream',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

// 解析 MCP StreamableHTTP 响应（可能是 JSON，也可能是 SSE 的 `event: message\ndata: {…}`），
// 再解出工具自身返回的 JSON 文本（tools.js 以 content[0].text = JSON.stringify(结果) 返回）。
function parseMcpResult(raw) {
  const text = String(raw || '');
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  let env = null;
  try { env = JSON.parse(dataLine ? dataLine.slice(6) : text); } catch { return null; }
  const inner = env?.result?.content?.[0]?.text;
  if (typeof inner !== 'string') return env?.result ?? env;
  try { return JSON.parse(inner); } catch { return { raw: inner }; }
}

console.log(`\n=== MCP OAuth E2E @ ${BASE} ===\n`);

// ---------- 负向 ----------
console.log('[负向]');
const noTok = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
check('N1 /mcp 无 token → 401', noTok.status === 401, `got ${noTok.status}`);
const wwwAuth = noTok.headers.get('www-authenticate') || '';
check('N2 /mcp 401 带 WWW-Authenticate: Bearer resource_metadata',
  /Bearer/.test(wwwAuth) && /resource_metadata=/.test(wwwAuth), wwwAuth || '(无该响应头)');

// N2b allowlist 反证：initialize 必须无 token 可达（否则 CLI 登录入口死锁）
const initRes = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } } });
check('N2b initialize 无 token → 200（allowlist 放行，CLI 入口不死锁）',
  initRes.status === 200, `got ${initRes.status}`);

// N2c：crm_login 工具必须无 token 可达（登录入口，否则 CLI 首次接入死锁）。
//   此处用**故意无效的占位凭据**，仅验证「闸未拦」，不涉及任何真实口令。
const loginProbe = await mcpCall({
  jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'crm_login', arguments: { username: '__e2e_probe__', password: '__e2e_probe__' } },
});
check('N2c crm_login 无 token 可达（HTTP 非 401，闸未误伤登录入口）',
  loginProbe.status !== 401, `got ${loginProbe.status} body=${loginProbe.text.slice(0, 120)}`);

const badReg = await j('POST', '/oauth/register', { redirect_uris: ['https://evil.com/cb'] });
check('N3 register 远端 https → 400 invalid_redirect_uri',
  badReg.status === 400 && badReg.json?.error === 'invalid_redirect_uri', JSON.stringify(badReg.json));

const reg = await j('POST', '/oauth/register', { client_name: CLIENT_NAME, redirect_uris: [REDIRECT] });
check('N4 register 合法回调 → 201 且返回 client_id', reg.status === 201 && !!reg.json?.client_id, JSON.stringify(reg.json));
const CID = reg.json?.client_id;

const unknownCode = await form('/oauth/token', {
  grant_type: 'authorization_code', code: 'crmc_x', client_id: CID,
  redirect_uri: REDIRECT, code_verifier: VERIFIER,
});
check('N5 未知 code → 400 invalid_grant',
  unknownCode.status === 400 && unknownCode.json?.error === 'invalid_grant', JSON.stringify(unknownCode.json));

const badAuth = await j('GET', `/oauth/authorize?response_type=code&client_id=oauth_ghost&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
check('N6 authorize 未知 client → 400 且无 Location（不 302）',
  badAuth.status === 400 && !badAuth.headers.get('location'),
  `status=${badAuth.status} loc=${badAuth.headers.get('location')}`);

const badRefresh = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'crmr_' + '0'.repeat(64), client_id: CID });
check('N7 未知 refresh → 400 invalid_grant',
  badRefresh.status === 400 && badRefresh.json?.error === 'invalid_grant', JSON.stringify(badRefresh.json));

// ---------- 正向 4 ----------
console.log('\n[正向]');
const meta = await j('GET', '/.well-known/oauth-protected-resource');
check('P1 protected-resource metadata 200 且 resource 指向本 BASE',
  meta.status === 200 && meta.json?.resource === `${BASE}/mcp`, JSON.stringify(meta.json));
const asMeta = await j('GET', '/.well-known/oauth-authorization-server');
check('P2 authorization-server metadata 200 且含 token_endpoint',
  asMeta.status === 200 && !!asMeta.json?.token_endpoint, JSON.stringify(asMeta.json));

const azRes = await form('/oauth/authorize', {
  response_type: 'code', client_id: CID, redirect_uri: REDIRECT, state: 'e2e',
  code_challenge: CHALLENGE, code_challenge_method: 'S256', username: USER, password: PASS,
});
const loc = azRes.headers.get('location') || '';
const code = loc ? new URL(loc).searchParams.get('code') : null;
check('P3 authorize 账密正确 → 302 带 code 与 state',
  azRes.status === 302 && !!code && loc.includes('state=e2e'), `status=${azRes.status} loc=${loc.slice(0, 80)}`);

// P3b 同一 code 换两次：第二次必须失败（一次性消费 CAS）
const tok = await form('/oauth/token', {
  grant_type: 'authorization_code', code: code || '', client_id: CID,
  redirect_uri: REDIRECT, code_verifier: VERIFIER,
});
check('P4 token 交换 → 200 且返回 access + refresh',
  tok.status === 200 && !!tok.json?.access_token && !!tok.json?.refresh_token, JSON.stringify(tok.json).slice(0, 200));

const codeReplay = await form('/oauth/token', {
  grant_type: 'authorization_code', code: code || '', client_id: CID,
  redirect_uri: REDIRECT, code_verifier: VERIFIER,
});
check('P4b 同一 code 二次交换 → 400 invalid_grant（一次性消费）',
  codeReplay.status === 400, JSON.stringify(codeReplay.json).slice(0, 160));

// ---------- 续期 3 ----------
if (tok.json?.refresh_token) {
  console.log('\n[续期]');
  const r2 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: CID });
  check('P5 refresh 轮转 → 200 且 refresh 已更换',
    r2.status === 200 && !!r2.json?.refresh_token && r2.json.refresh_token !== tok.json.refresh_token,
    JSON.stringify(r2.json).slice(0, 160));

  // 建带凭据的 MCP 会话（StreamableHTTP 两段式：initialize → 带 mcp-session-id 调用）
  const sess = await mcpSession(r2.json?.access_token);
  check('P6 持 access token initialize → 200 且取得 mcp-session-id',
    sess.initStatus === 200 && !!sess.sid, `init=${sess.initStatus} sid=${sess.sid || '(空)'}`);

  const list = await sess.call('tools/list', {});
  check('P7 带会话 tools/list → 200 且返回工具清单',
    list.status === 200 && Array.isArray(list.json?.tools) && list.json.tools.length > 0,
    `status=${list.status} tools=${list.json?.tools?.length ?? 'n/a'}`);

  // P8 真实工具调用（设计 §10 T7 契约：ok=true）。
  //   ⚠ 这条是**本脚本唯一能抓获「工具面≠可用」的用例**：2026-09-15 首轮实测中，
  //   HTTP 层闸与带会话 tools/list 全绿，但 tools/call 恒返 {ok:false,gate:'auth_required'}——
  //   根因是 MCP SDK 把头放在 extra.requestInfo.headers 而 server.js 读 extra.headers
  //   （`Authorization: Bearer` 从未到达工具层；CLI 走 params.api_token 故长期潜伏）。
  //   仅断言 tools/list 会得恒假绿，故此处必须实打一次业务读。
  const realCall = await sess.call('tools/call', {
    name: 'data-particle-read', arguments: { type: 'deal' },
  });
  check('P8 真实工具调用 data-particle-read → ok=true（非 auth_required）',
    realCall.json?.ok === true,
    `status=${realCall.status} body=${JSON.stringify(realCall.json).slice(0, 180)}`);

  const replay = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: CID });
  check('P9 旧 refresh 重放 → 400 invalid_grant（整链吊销生效）',
    replay.status === 400, JSON.stringify(replay.json).slice(0, 160));
}

// ---------- 可选：审计真相源核对（--db，仅本地/可直连库时）----------
if (args.includes('--db')) {
  console.log('\n[审计]');
  try {
    process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
    const { query } = await import('../src/db.js');
    const { rows } = await query(
      `SELECT actor, count(*)::int AS n FROM crm.events
        WHERE domain='mcp' AND type='mcp.oauth.token_issued' AND actor=$1
        GROUP BY actor`, [USER]);
    check(`A1 crm.events 中 actor 为真实用户名 ${USER}`,
      rows.length === 1 && rows[0].n > 0, JSON.stringify(rows));
  } catch (e) {
    check('A1 crm.events 审计核对', false, `查询失败：${e?.message || e}`);
  }
}

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
