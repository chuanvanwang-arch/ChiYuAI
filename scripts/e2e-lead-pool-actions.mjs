/**
 * E2E：线索公海池（S0/S0P）动作族端到端验收（HTTP + MCP stdio）
 * 设计文档：docs/2026-09-11-lead-public-pool-tenant-design.md
 * 实施计划：docs/superpowers/plans/2026-09-11-lead-public-pool-tenant.md（Task 1–10）
 *
 * 项目铁律：**单测全绿 ≠ 链路通**。本脚本起真实 HTTP 实例 + 真实 MCP stdio，
 * 验证池动作族真的通了（范式：scripts/e2e-discovery-touchpoints.mjs）。
 *
 * 用法：
 *   node scripts/e2e-lead-pool-actions.mjs
 *   E2E_USER=alice E2E_PASS=secret123 E2E_ADMIN=admin E2E_ADMIN_PASS=admin123 node scripts/e2e-lead-pool-actions.mjs
 *
 * ── 三处硬约束（继承 e2e-discovery-touchpoints.mjs:12-18，勿改）────────────
 * ① **先设 env 再动态 import**：ESM 静态 import 会被提升，`src/db.js` 会在
 *    `PGDATABASE` 赋值前初始化 → 连生产库 `crm_native`。故下方一律 `await import()`。
 * ② **端口动态选取**：3000/3100/3211 常被既有实例占用，硬编码必 EADDRINUSE；
 *    且复用外部旧实例会测到旧代码（假绿）。故本脚本自起实例。
 * ③ **PGDATABASE 必须落测试库**：脚本内置生产库护栏（见 Step 0），命中即退出。
 *
 * ── 运行副作用（落 crm_native_test；禁 DELETE，不可回滚）─────────────────
 * ① fixture 为**幂等 upsert**（`stable_key LIKE 'e2e-pool-%'`），复跑不增行；
 * ② 被测动作会真实改写 fixture 的 stage/pool 字段——**这正是被测行为**；
 * ③ 每次 phase1 mint 决策 + 写 mcp_identity 行（设计行为）；
 * ④ 断言后把 fixture 复位到初始态（幂等 upsert 完成，复跑可重复）。
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG = process.env.PGDATABASE || 'crm_native_test';
process.env.PGDATABASE = PG; // 必须在动态 import 之前（见头部约束 ①）

const USER = process.env.E2E_USER || 'alice';
const PASS = process.env.E2E_PASS || 'secret123';
const ADMIN = process.env.E2E_ADMIN || 'admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || 'admin123';

// ─── 结果收集（范式同 e2e-discovery-touchpoints.mjs:50-54）───
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function request(port, method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* 非 JSON（HTML 页面）*/ }
        resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', json, len: b.length });
      });
    });
    req.on('error', (e) => resolve({ status: -1, err: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -2, err: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// ═══ Step 0：生产库护栏 + fixture 幂等造数 ═══
console.log('\n── Step 0: 生产库护栏 + fixture ──');
const { query, queryWrite } = await import('../src/db.js');
{
  const r = await query('SELECT current_database() AS db');
  const db = r.rows[0]?.db;
  check(`S0.1 落测试库（PGDATABASE=${PG}）`, db === PG,
    `实际 db=${db}${db === 'crm_native' ? '  ⛔ 命中生产库，脚本中止' : ''}`);
  if (db !== PG || db === 'crm_native') { process.exit(1); }
}

/** fixture 幂等 upsert：stable_key='e2e-pool-*'。禁 DELETE → 只增改。 */
async function upsertDeal(key, payload, { tenantId = 'system' } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.particles (tenant_id, type, slug, title, state, payload, stable_key)
     VALUES ($1, 'CRM_DEAL', $2, $3, 'ACTIVE', $4::jsonb, $2)
     ON CONFLICT (stable_key) DO UPDATE
       SET payload = EXCLUDED.payload, title = EXCLUDED.title, updated_at = now()
     RETURNING id, payload`,
    [tenantId, key, payload.name || key, JSON.stringify(payload)]
  );
  return r.rows[0];
}
async function readDeal(key) {
  const r = await query(`SELECT id, payload FROM crm.particles WHERE stable_key=$1`, [key]);
  return r.rows[0] || null;
}

const DEPARTED = 'e2e-departed-owner';
// 真实租户（非 system）——离职回收 `crm-lead-reclaim-bulk` 的主要正向路径用。
// 动机：该动作用户恒为 system 租户（crm_users.alice.tenant_id='system'）→ 被「禁 system 通配」闸设计性拒绝，
//   经 MCP 无法覆盖 → 正向路径改由真实租户 ctx 直驱 executor（S4.10b），MCP 侧只验安全闸（S4.10）。
const T2_TENANT = 'e2e-pool-tenant';
const T2_KEY = 'e2e-pool-reclaim-t2';
const T2_PAYLOAD = { name: 'E2E他租户离职线索', stage: 'S0P', owner_id: DEPARTED, pool_type: 'new' };
const FIXTURES = {
  'e2e-pool-return-s1':   { name: 'E2E退回线索S1', stage: 'S1', owner_id: USER, pool_type: 'new', qualified_at: '2026-09-01T00:00:00.000Z', qualified_by: USER },
  'e2e-pool-archive-s7':  { name: 'E2E战败线索S7', stage: 'S7', owner_id: USER, pool_type: 'new' },
  'e2e-pool-reopen-lost': { name: 'E2E战败公海', stage: 'S0', owner_id: null, pool_type: 'lost', last_terminal_stage: 'S7' },
  'e2e-pool-reclaim-a':   { name: 'E2E离职线索A', stage: 'S0P', owner_id: DEPARTED, pool_type: 'new' },
  'e2e-pool-reclaim-b':   { name: 'E2E离职线索B', stage: 'S1', owner_id: DEPARTED, pool_type: 'new' },
  'e2e-pool-public-s0':   { name: 'E2E公海线索(勿动)', stage: 'S0', owner_id: null, pool_type: 'new' },
  'e2e-pool-inplay-s3':   { name: 'E2E在跟线索S3', stage: 'S3', owner_id: USER, pool_type: 'new' },
};
let fixturesReady = true;
try {
  for (const [k, p] of Object.entries(FIXTURES)) await upsertDeal(k, p);
  const n = await query(`SELECT count(*)::int AS n FROM crm.particles WHERE stable_key LIKE 'e2e-pool-%'`);
  check(`S0.2 fixture 幂等就绪（${Object.keys(FIXTURES).length} 条）`, n.rows[0].n >= Object.keys(FIXTURES).length,
    `库内 e2e-pool-* 共 ${n.rows[0].n} 行`);
} catch (e) {
  fixturesReady = false;
  check('S0.2 fixture 造数', false, e.message.slice(0, 200));
}
if (!fixturesReady) process.exit(1);

// ═══ Step 1：自起隔离实例 ═══
console.log('\n── Step 1: 起隔离 HTTP 实例 ──');
const PORT = await freePort();
const child = spawn(process.execPath, ['src/http/server.js'], {
  cwd: REPO_ROOT,
  env: { ...process.env, PORT: String(PORT), PGDATABASE: PG, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
child.stdout.on('data', (d) => (bootLog += d));
child.stderr.on('data', (d) => (bootLog += d));

let ready = false;
for (let i = 0; i < 40; i++) {
  const r = await request(PORT, 'GET', '/login.html');
  if (r.status === 200 || r.status === 404) { ready = true; break; }
  await sleep(500);
}
check(`S1.1 实例就绪（PORT=${PORT}, PGDATABASE=${PG}）`, ready, ready ? '' : bootLog.slice(0, 400));
if (!ready) { child.kill(); process.exit(1); }

const login = async (u, pw) => (await request(PORT, 'POST', '/api/auth/login', { username: u, password: pw })).json;

try {
  // ═══ Step 2：HTTP 后台池配置面（T5）═══
  console.log('\n── Step 2: HTTP 后台池配置面 (/api/pool-config) ──');
  const adminTok = (await login(ADMIN, ADMIN_PASS))?.token;
  const userTok = (await login(USER, PASS))?.token;
  check('S2.0 admin/user 登录取得 token', !!adminTok && !!userTok, `admin=${!!adminTok} ${USER}=${!!userTok}`);

  const anonGet = await request(PORT, 'GET', '/api/pool-config');
  check('S2.1 未登录 GET → 401', anonGet.status === 401, `status=${anonGet.status}`);

  // 配置中心注册表闸（configCenter.js CONFIG_ITEMS）：pool-config = 系统级 → 非 admin 403（正向确认，非缺陷）
  const salesGet = await request(PORT, 'GET', '/api/pool-config', null, userTok);
  check('S2.2 sales(alice) GET → 403（配置中心系统级闸：池配置仅 ADMIN）',
    salesGet.status === 403, `status=${salesGet.status} ${JSON.stringify(salesGet.json).slice(0, 70)}`);

  const get1 = await request(PORT, 'GET', '/api/pool-config', null, adminTok);
  const pools1 = get1.json?.config?.pools;
  const POOL_IDS = ['pool-new', 'pool-nurture', 'pool-lost'];
  check('S2.3 admin GET → 200 且三池齐备（new/nurture/lost）+ 回显 tenantId（按租户隔离）',
    get1.status === 200 && Array.isArray(pools1) && POOL_IDS.every((id) => pools1.some((p) => p.id === id))
      && typeof get1.json?.tenantId === 'string' && get1.json.tenantId.length > 0,
    `status=${get1.status} pools=${JSON.stringify((pools1 || []).map((p) => p.id))} tenantId=${get1.json?.tenantId}`);

  // 白名单：未知键必须被拒（页面可编辑键 = 引擎消费键）
  const badKey = await request(PORT, 'PUT', '/api/pool-config',
    { pools: [{ id: 'pool-new', pick_rule: { not_an_engine_key: 1 } }] }, adminTok);
  check('S2.4 PUT 非引擎键 → 400（validatePoolPatch 白名单）',
    badKey.status === 400, `status=${badKey.status} err=${(badKey.json?.error || '').slice(0, 90)}`);

  // 边界：daily_limit=0 越界（1–999）
  const badRange = await request(PORT, 'PUT', '/api/pool-config',
    { pools: [{ id: 'pool-new', pick_rule: { daily_limit: 0 } }] }, adminTok);
  check('S2.5 PUT daily_limit=0 → 400（边界 1–999）',
    badRange.status === 400, `status=${badRange.status} err=${(badRange.json?.error || '').slice(0, 90)}`);

  // 合法写入 + round-trip 深比较
  const want = { id: 'pool-new', pick_rule: { daily_limit: 7, pick_interval_hours: 12 }, recycle_rule: { recycle_days: 45 } };
  const put = await request(PORT, 'PUT', '/api/pool-config', { pools: [want] }, adminTok);
  check('S2.6 PUT 合法三键 → 200 updated:true', put.status === 200 && put.json?.updated === true,
    `status=${put.status} updated=${put.json?.updated} err=${(put.json?.error || '').slice(0, 80)}`);

  const get2 = await request(PORT, 'GET', '/api/pool-config', null, adminTok);
  const pn = (get2.json?.config?.pools || []).find((p) => p.id === 'pool-new') || {};
  const rtOk = pn.pick_rule?.daily_limit === 7 && pn.pick_rule?.pick_interval_hours === 12 && pn.recycle_rule?.recycle_days === 45;
  check('S2.7 GET round-trip 三键落库一致（admin 读自身租户）', rtOk,
    `daily_limit=${pn.pick_rule?.daily_limit} interval=${pn.pick_rule?.pick_interval_hours} recycle_days=${pn.recycle_rule?.recycle_days} status=${get2.status}`);

  // 复原（幂等：把 fixture 改动的键写回默认，避免污染后续人工使用）
  await request(PORT, 'PUT', '/api/pool-config',
    { pools: [{ id: 'pool-new', pick_rule: { daily_limit: 10, pick_interval_hours: 24 }, recycle_rule: { recycle_days: 30 } }] }, adminTok);

  // ═══ Step 3：HTTP 公海口径（T9 / P0）═══
  console.log('\n── Step 3: 公海口径与待办排除（P0）───');
  // view=follow（待跟进视图）；缺省 view=approval（审批视图）→ 不传恒 0 条（假绿）
  const todo = await request(PORT, 'GET', '/api/my-todo?view=follow', null, userTok);
  // 受控渲染契约：行数据落在 data.components.table.rows（**不是** todos/items → 取错恒空=假绿）
  const rows = todo.json?.data?.components?.table?.rows || [];
  const blob = JSON.stringify(rows);
  const stageOf = async (key) => (await readDeal(key))?.payload?.stage;

  // P0 正向基准（anti-fake-green）：在跟线索必须**在**待办里，否则「公海不在」是假绿
  const inPlayShown = /E2E在跟线索S3/.test(blob);
  const publicShown = /E2E公海线索/.test(blob);

  check('S3.1 正向基准：在跟线索(S3)在待办中（防「全空假绿」）',
    inPlayShown, `status=${todo.status} view=${todo.json?.view} rows=${rows.length} 匹配S3=${inPlayShown}`);
  check('S3.2 P0：公海线索(S0 无主) **不在**待办中（isPoolStage 显式排除）',
    !publicShown, `公海 fixture 出现在待办=${publicShown}（若为 true 即 P0 复发）`);

  const board = await request(PORT, 'GET', '/api/business/board', null, userTok);
  const bj = board.json || {};
  check('S3.3 业务看板返回 publicPool(公海) 与 privateLeads(私海) 双口径',
    board.status === 200 && bj.publicPool !== undefined && bj.privateLeads !== undefined,
    `status=${board.status} keys=${Object.keys(bj).slice(0, 12).join(',')}`);

  // ═══ Step 3.5：公海池页面链路（T1/T2 端点真跑）═══
  // 演示数据 alice 为 system 租户；GET 端点经 scopeTenant 走 isWild（可见全部 S0）。
  // pick 端点 fail-closed 会拦 system 租户（P1-1 残留代价：缺真实租户不静默得全权益）；
  //   真实租户销售走 actionExecutor 直驱（生产路径）完成认领闭环。
  console.log('\n── Step 3.5: 公海池页面链路 (/api/lead-pool + pick) ──');
  const PAGE_KEY = 'e2e-pool-pageflow-s0';
  // alice 为 sales 角色 → scopeTenant 返回 'system'（非 isWild '*'），GET 仅可见 system 租户 S0；
  //   故 fixture 落 system 租户，使其出现在 alice 的公海列表（演示数据 alice 即 system 租户）。
  await upsertDeal(PAGE_KEY, { name: 'E2E页面链路公海', stage: 'S0', owner_id: null, pool_type: 'new' });
  const pageId = (await readDeal(PAGE_KEY))?.id;
  check('S3.5.0 页面链路 fixture 就绪', !!pageId, `id=${pageId}`);

  const lp1 = await request(PORT, 'GET', '/api/lead-pool', null, userTok);
  check('S3.5.1 GET /api/lead-pool → 200 且含新建 S0（truncated=false）',
    lp1.status === 200 && Array.isArray(lp1.json?.items) && lp1.json.items.some((x) => x.id === pageId) && lp1.json.truncated === false,
    `status=${lp1.status} total=${lp1.json?.total} hasItem=${lp1.json?.items?.some((x) => x.id === pageId)} truncated=${lp1.json?.truncated}`);

  const pk = await request(PORT, 'POST', `/api/lead-pool/${pageId}/pick`, null, userTok);
  check('S3.5.2 POST pick（demo system 租户）→ 400 fail-closed（gate=plan_entitlement_missing_tenant）',
    pk.status === 400 && pk.json?.gate === 'plan_entitlement_missing_tenant',
    `status=${pk.status} gate=${pk.json?.gate} err=${(pk.json?.error || '').slice(0, 60)}`);

  // 认领闭环：crm-lead-pick 动作（system 租户 ctx 豁免跨租户）S0 → S0P，且从公海列表消失
  const { seedActions: sa2 } = await import('../src/action/seed-actions.js');
  const { actionExecutor: ex2 } = await import('../src/action/executor.js');
  sa2();
  const pkR = await ex2.dispatch('crm-lead-pick', { deal_id: pageId, owner_id: 'e2e-picker' },
    { tenantId: 'system', actor: 'e2e-picker', channel: 'mcp' });
  const afterPick = await readDeal(PAGE_KEY);
  const lp2 = await request(PORT, 'GET', '/api/lead-pool', null, userTok);
  check('S3.5.3 认领 → S0→S0P 且从公海列表消失（页面链路闭环）',
    pkR.ok === true && afterPick?.payload?.stage === 'S0P' && !lp2.json?.items?.some((x) => x.id === pageId),
    `ok=${pkR.ok} stage=${afterPick?.payload?.stage} stillInPool=${lp2.json?.items?.some((x) => x.id === pageId)}`);

  await upsertDeal(PAGE_KEY, { name: 'E2E页面链路公海', stage: 'S0', owner_id: null, pool_type: 'new' }); // 复位
} finally {
  child.kill();
}

// ═══ Step 4：MCP 工具面与相位协议（真实 stdio）═══
console.log('\n── Step 4: MCP 工具面与相位协议 (stdio) ──');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: PG },
  cwd: REPO_ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-lead-pool-actions', version: '1.0.0' });
function unpack(r) {
  if (!r.content?.[0]?.text) return r;
  try { return JSON.parse(r.content[0].text); } catch { return { ok: false, raw: r.content[0].text.slice(0, 200) }; }
}
// 写 phase1 契约（deferDecisionMint 动作，2026-09-11 方案 H）：phase1 只发确认单、**不代 mint**
//   → form.decision_id 必为 null；decision_id 由 handler 在 phase2 产生（见 S4.7–S4.10b 的 rN.data.decision_id）。
const phase1Ok = (p) => p?.ok === true
  && typeof p.confirm_token === 'string' && p.confirm_token.length > 0
  && p.form?.code === 'CONFIRM_REQUIRED'
  && (p.form?.decision_id === null || p.form?.decision_id === undefined);

const POOL_ACTIONS = ['crm-lead-return', 'crm-deal-archive-to-pool', 'crm-lead-reclaim-bulk', 'crm-deal-reopen'];

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const t of POOL_ACTIONS) check(`S4.1 tools/list 含 ${t}`, names.includes(t), `共 ${names.length} 个工具`);

  // reserved 正向确认：pick/recycle 是内部/调度动作，**不应**对外暴露
  const reserved = ['crm-lead-pick', 'crm-lead-recycle'];
  check('S4.2 reserved 动作(pick/recycle) **不在**工具面（设计：统一走 crm-deal-advance）',
    reserved.every((n) => !names.includes(n)), `pick=${names.includes('crm-lead-pick')} recycle=${names.includes('crm-lead-recycle')}`);

  // 负向基准：无 token ⇒ 闸门真拦（判据必须 ok!==true）
  for (const t of ['crm-lead-return', 'crm-deal-archive-to-pool', 'crm-lead-reclaim-bulk', 'crm-deal-reopen']) {
    const a = unpack(await client.callTool({ name: t, arguments: { deal_id: 'x', user_id: 'x' } }));
    check(`S4.3 ${t} 无 token → ok===false && gate=auth_required`,
      a.ok === false && a.gate === 'auth_required', JSON.stringify(a).slice(0, 120));
  }

  const lg = unpack(await client.callTool({ name: 'crm_login', arguments: { username: USER, password: PASS } }));
  check(`S4.4 crm_login(${USER}) → ok===true 且有 token`, lg.ok === true && !!lg.token, `role=${lg.role}`);
  const auth = { api_token: lg.token };

  // ─── 相位协议：phase1（取确认单）→ phase2（确认执行）───
  const ids = {};
  for (const k of Object.keys(FIXTURES)) ids[k] = (await readDeal(k))?.id;
  check('S4.5 fixture id 就绪', Object.values(ids).every(Boolean), JSON.stringify(ids).slice(0, 200));

  const phase1s = {};
  const p1Cases = [
    ['crm-lead-return', 'e2e-pool-return-s1', { deal_id: ids['e2e-pool-return-s1'], reason_code: 'no_budget', note: 'e2e' }],
    ['crm-deal-archive-to-pool', 'e2e-pool-archive-s7', { deal_id: ids['e2e-pool-archive-s7'], reason: 'e2e 战败归档' }],
    ['crm-lead-reclaim-bulk', 'e2e-pool-reclaim-a', { user_id: DEPARTED, reason: 'e2e 离职回收' }],
    ['crm-deal-reopen', 'e2e-pool-reopen-lost', { deal_id: ids['e2e-pool-reopen-lost'], reason: 'e2e 重开' }],
  ];
  for (const [act, key, args] of p1Cases) {
    const r = unpack(await client.callTool({ name: act, arguments: { ...auth, ...args } }));
    phase1s[act] = r;
    check(`S4.6 ${act} phase1 → ok:true + CONFIRM_REQUIRED + confirm_token（deferDecisionMint：不代 mint）`,
      phase1Ok(r),
      `ok=${r.ok} gate=${r.gate || '-'} code=${r.code || '-'} form.code=${r.form?.code || '-'} form.decision_id=${r.form?.decision_id ?? 'null'} confirm_token=${r.confirm_token ? 'yes' : 'no'}`);
  }

  // ─── phase2：真实执行 + DB 终态断言 ───
  async function phase2(act) {
    const t = phase1s[act]?.confirm_token;
    if (!t) return { skipped: true };
    return unpack(await client.callTool({ name: act, arguments: { ...auth, confirm_token: t } }));
  }

  // ① 退回：S1 → S0（质量判据，未超期也可退），落 nurture 池
  const r1 = await phase2('crm-lead-return');
  const d1 = await readDeal('e2e-pool-return-s1');
  check('S4.7 crm-lead-return phase2 → ok:true + handler 内 mint 决策，DB 终态 S1→S0（owner 清空 / 资格作废）',
    r1.ok === true && !!r1.data?.decision_id && d1?.payload?.stage === 'S0' && !d1?.payload?.owner_id
      && d1?.payload?.qualified_at === null && !!d1?.payload?.prev_owner_id && !!d1?.payload?.returned_at,
    `ok=${r1.ok} did=${r1.data?.decision_id ? 'yes' : 'no'} stage=${d1?.payload?.stage} owner=${d1?.payload?.owner_id} prev=${d1?.payload?.prev_owner_id} pool_type=${d1?.payload?.pool_type} err=${(r1.error || '').slice(0, 80)}`);

  // ② 归档：S7 → S0 + lost（留战败事实供重开恢复）
  const r2 = await phase2('crm-deal-archive-to-pool');
  const d2 = await readDeal('e2e-pool-archive-s7');
  check('S4.8 crm-deal-archive-to-pool phase2 → ok:true + mint 决策，DB 终态 S7→S0+lost（留 last_terminal_stage）',
    r2.ok === true && !!r2.data?.decision_id && d2?.payload?.stage === 'S0' && d2?.payload?.pool_type === 'lost'
      && d2?.payload?.last_terminal_stage === 'S7' && !d2?.payload?.owner_id,
    `ok=${r2.ok} did=${r2.data?.decision_id ? 'yes' : 'no'} stage=${d2?.payload?.stage} pool_type=${d2?.payload?.pool_type} last_terminal=${d2?.payload?.last_terminal_stage} err=${(r2.error || '').slice(0, 80)}`);

  // ③ 重开：S0+lost → S0P（重走 BANT；出池恢复 prev_pool）
  const r3 = await phase2('crm-deal-reopen');
  const d3 = await readDeal('e2e-pool-reopen-lost');
  check('S4.9 crm-deal-reopen phase2 → ok:true + mint 决策，DB 终态 S0(lost)→S0P（重走 BANT）',
    r3.ok === true && !!r3.data?.decision_id && d3?.payload?.stage === 'S0P' && (d3?.payload?.reopen_count || 0) >= 1,
    `ok=${r3.ok} did=${r3.data?.decision_id ? 'yes' : 'no'} stage=${d3?.payload?.stage} reopen_count=${d3?.payload?.reopen_count} err=${(r3.error || '').slice(0, 80)}`);

  // ④ 离职批量回收·负向（MCP / system 租户）：alice 的 MCP 身份租户 = 'system'
  //    → 被「禁 system 通配」安全闸**设计性**拒绝（防一次误操作扫全库）。这不是缺陷，是本动作的租户边界。
  //    零副作用是实质断言：拒绝必须发生在任何写入之前。
  const r4 = await phase2('crm-lead-reclaim-bulk');
  const d4a = await readDeal('e2e-pool-reclaim-a');
  const d4b = await readDeal('e2e-pool-reclaim-b');
  check('S4.10 crm-lead-reclaim-bulk 在 system 租户被安全闸拒绝（禁 system 通配）且**零副作用**',
    r4.ok === false && /真实租户|system 通配/.test(r4.error || '')
      && d4a?.payload?.stage === 'S0P' && d4a?.payload?.owner_id === DEPARTED
      && d4b?.payload?.stage === 'S1' && d4b?.payload?.owner_id === DEPARTED,
    `ok=${r4.ok} err=${(r4.error || '').slice(0, 70)} a.stage=${d4a?.payload?.stage} a.owner=${d4a?.payload?.owner_id} b.stage=${d4b?.payload?.stage} b.owner=${d4b?.payload?.owner_id}`);

  // ④b 离职批量回收·正向（真实租户，直驱 executor）：MCP 登录用户恒 system 租户 ⇒ 无法经 MCP 覆盖，
  //    故用真实租户 ctx 直驱 actionExecutor（真跑 handler + 真写库 + 真 mint 决策）。
  //    同时验证**租户隔离**：只回收本租户线索，system 租户同 owner 的两条 fixture 不受影响。
  const { actionExecutor } = await import('../src/action/executor.js');
  const { seedActions } = await import('../src/action/seed-actions.js');
  seedActions();
  await upsertDeal(T2_KEY, T2_PAYLOAD, { tenantId: T2_TENANT });
  const rt = await actionExecutor.dispatch('crm-lead-reclaim-bulk',
    { user_id: DEPARTED, reason: 'e2e 离职回收(真实租户)' },
    { tenantId: T2_TENANT, actor: ADMIN, channel: 'mcp' });
  const rd = rt?.data || {};
  const dT2 = await readDeal(T2_KEY);
  const dSys = await readDeal('e2e-pool-reclaim-a');
  check('S4.10b crm-lead-reclaim-bulk 正向（真实租户）：本租户 S0P→S0 解绑，**他租户不受影响**（租户隔离）',
    rt.ok === true && rd.count >= 1 && !!rd.decision_id
      && dT2?.payload?.stage === 'S0' && !dT2?.payload?.owner_id && dT2?.payload?.prev_owner_id === DEPARTED
      && dSys?.payload?.stage === 'S0P' && dSys?.payload?.owner_id === DEPARTED,
    `ok=${rt.ok} count=${rd.count} did=${rd.decision_id ? 'yes' : 'no'} t2.stage=${dT2?.payload?.stage} t2.owner=${dT2?.payload?.owner_id} sys.stage=${dSys?.payload?.stage} err=${(rt.error || '').slice(0, 70)}`);

  // ⑤ 负向：非法 reason_code 必须被拒（phase2 才执行 handler）
  //    诚实判据：phase1 未通过 ⇒ 本用例**无法判定**（不得因 ok===false 而假绿）
  const badP1 = unpack(await client.callTool({ name: 'crm-lead-return',
    arguments: { ...auth, deal_id: ids['e2e-pool-inplay-s3'], reason_code: 'NOT_A_REASON' } }));
  const chain1 = !!badP1.confirm_token;
  const badP2 = chain1
    ? unpack(await client.callTool({ name: 'crm-lead-return', arguments: { ...auth, confirm_token: badP1.confirm_token } }))
    : null;
  const d5 = await readDeal('e2e-pool-inplay-s3');
  check('S4.11 非法 reason_code → 拒绝且**不落库**（缺陷零副作用）',
    chain1 && badP2?.ok === false && d5?.payload?.stage === 'S3',
    chain1 ? `ok=${badP2?.ok} stage=${d5?.payload?.stage} err=${(badP2?.error || badP2?.raw || '').slice(0, 90)}`
           : '前置失败：phase1 未通过（第 0 闸缺陷）→ 本用例无法判定');

  // ⑥ 前置条件闸：S3（在跟）不可退回（仅 S0P/S1）
  const p1gate = unpack(await client.callTool({ name: 'crm-lead-return',
    arguments: { ...auth, deal_id: ids['e2e-pool-inplay-s3'], reason_code: 'other' } }));
  const chain2 = !!p1gate.confirm_token;
  const p2gate = chain2
    ? unpack(await client.callTool({ name: 'crm-lead-return', arguments: { ...auth, confirm_token: p1gate.confirm_token } }))
    : null;
  const d6 = await readDeal('e2e-pool-inplay-s3');
  check('S4.12 阶段闸：S3 不可退回（仅 S0P/S1）且不改数据',
    chain2 && p2gate?.ok === false && d6?.payload?.stage === 'S3',
    chain2 ? `ok=${p2gate?.ok} stage=${d6?.payload?.stage} err=${(p2gate?.error || p2gate?.raw || '').slice(0, 90)}`
           : '前置失败：phase1 未通过（第 0 闸缺陷）→ 本用例无法判定');
} catch (e) {
  check('S4 MCP 通道', false, e.message);
} finally {
  await client.close().catch(() => {});
}

// ═══ Step 5：fixture 复位（幂等，供复跑）═══
console.log('\n── Step 5: fixture 复位 ──');
try {
  for (const [k, p] of Object.entries(FIXTURES)) await upsertDeal(k, p);
  await upsertDeal(T2_KEY, T2_PAYLOAD, { tenantId: T2_TENANT });   // 真实租户 fixture 同步复位
  const r = await query(`SELECT count(*)::int AS n FROM crm.particles WHERE stable_key LIKE 'e2e-pool-%'`);
  check('S5.1 fixture 复位为初始态（复跑可重复）', r.rows[0].n >= Object.keys(FIXTURES).length + 1, `共 ${r.rows[0].n} 行`);
} catch (e) {
  check('S5.1 fixture 复位', false, e.message.slice(0, 160));
}

// ═══ 汇总 ═══
const failed = results.filter((r) => !r.pass);
console.log(`\n════ E2E 结果：${results.length - failed.length}/${results.length} 通过 ════`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
