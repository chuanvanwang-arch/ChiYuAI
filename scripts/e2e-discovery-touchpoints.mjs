/**
 * E2E：线索发现触点面端到端验收（HTTP + MCP 双通道）
 * 计划：docs/superpowers/plans/2026-09-10-lead-discovery-engine.md → Task 20
 *
 * 项目铁律：**单测全绿 ≠ 链路通**。本脚本起真实 HTTP 实例 + 真实 MCP stdio，
 * 验证四条触点面真的通了（范式：scripts/e2e-dialog-advice.mjs）。
 *
 * 用法：
 *   node scripts/e2e-discovery-touchpoints.mjs
 *   E2E_USER=alice E2E_PASS=secret123 E2E_ADMIN=admin E2E_ADMIN_PASS=admin123 node scripts/e2e-discovery-touchpoints.mjs
 *
 * ── 两处硬约束（2026-09-11 实测得出，勿改）──────────────────────────────
 * ① **先设 env 再动态 import**：ESM 静态 import 会被提升，若本文件顶部静态
 *    `import { DEFAULT_DISCOVERY_RULES } from '../src/config/discoveryRules.js'`，
 *    则 `src/db.js` 会在 `PGDATABASE` 赋值前初始化 → 连生产库 `crm_native`
 *    （实测会打印「⚠ 未设置 PGDATABASE」警告）。故下方用 `await import()`。
 * ② **端口动态选取**：3000/3100/3211 常被本项目既有实例占用，硬编码必
 *    EADDRINUSE；且复用外部旧实例会测到旧代码（假绿）。故本脚本自起实例。
 *
 * ── 运行副作用（落 crm_native_test；禁 DELETE，不可回滚）───────────────
 * ① Step 2 的 PUT 真写 `config_store(system,'discovery-rules')`，写入值 =
 *    `DEFAULT_DISCOVERY_RULES`（与出厂默认等价 ⇒ 语义零变更；幂等）。
 *    副作用：该键从「未配置 → GET 404」变为「已配置 → GET 200」，故 GET 断言
 *    设计为**幂等双合法**（404 或 200 均通过）。
 * ② 每次 MCP phase1（无 confirm_token）经决策第 0 闸 mint 各 1 条决策 + memory
 *    记录（设计行为，非缺陷）。
 * 实测生产库 `crm_native` 该键 0 行，本脚本不触碰生产库。
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

const { DEFAULT_DISCOVERY_RULES } = await import('../src/config/discoveryRules.js');

// ─── 结果收集（范式同 e2e-dialog-advice.mjs:15-19）───
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── HTTP 小工具（不用 curl：本机带 HTTP_PROXY 会 502）───
function request(port, method, p, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 10000 }, (res) => {
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
  const r = await request(PORT, 'GET', '/discovery.html');
  if (r.status === 200 || r.status === 404) { ready = true; break; }
  await sleep(500);
}
check(`S1 实例就绪（PORT=${PORT}, PGDATABASE=${PG}）`, ready, ready ? '' : bootLog.slice(0, 400));
if (!ready) { child.kill(); process.exit(1); }

try {
  // ═══ Step 2：HTTP 后台配置面 ═══
  console.log('\n── Step 2: HTTP 后台配置面 (/api/config/discovery-rules) ──');
  const login = async (u, pw) => (await request(PORT, 'POST', '/api/auth/login', { username: u, password: pw })).json;
  const adminTok = (await login(ADMIN, ADMIN_PASS))?.token;
  const userTok = (await login(USER, PASS))?.token;
  check('S2.0 admin/user 登录取得 token', !!adminTok && !!userTok,
    `admin=${!!adminTok} ${USER}=${!!userTok}`);

  // ① 未登录 → 401（全局 auth 中间件先拦，不是 403）
  const anon = await request(PORT, 'GET', '/api/config/discovery-rules');
  check('S2.1 未登录 GET → 401', anon.status === 401, `status=${anon.status} ${JSON.stringify(anon.json)}`);

  // ② admin GET → 幂等双合法（首跑未配置 404；复跑已配置 200 且结构完整）
  const pre = await request(PORT, 'GET', '/api/config/discovery-rules', null, adminTok);
  const preOk = pre.status === 404
    || (pre.status === 200 && ['icp', 'providers', 'signals'].every((k) => pre.json?.value?.[k] !== undefined));
  check('S2.2 admin GET → 404(未配置) 或 200(结构完整)',
    preOk, `status=${pre.status}${pre.status === 404 ? ' 未配置（端点不回退出厂默认）' : ''}`);

  // ③ 角色闸：alice(sales) → 403
  const denied = await request(PORT, 'GET', '/api/config/discovery-rules', null, userTok);
  check('S2.3 alice(sales) GET → 403（租户级需 tan_admin/sysadmin/ADMIN）',
    denied.status === 403, `status=${denied.status} ${JSON.stringify(denied.json)}`);

  // ④ 结构校验前置：缺 icp/providers/signals → 400
  const bad = await request(PORT, 'PUT', '/api/config/discovery-rules', { value: { playbooks: [] } }, adminTok);
  check('S2.4 PUT 缺结构键 → 400 且点名 icp', bad.status === 400 && /icp/.test(bad.json?.error || ''),
    `status=${bad.status} ${JSON.stringify(bad.json)}`);

  // ⑤ PUT 完整结构 → 200 updated:true，响应含 decision 键（值恒 null，勿断言非空）
  const value = structuredClone({ ...DEFAULT_DISCOVERY_RULES });
  const put = await request(PORT, 'PUT', '/api/config/discovery-rules', { value }, adminTok);
  check('S2.5 PUT 完整结构 → 200 updated:true 且含 decision 键',
    put.status === 200 && put.json?.updated === true && 'decision' in (put.json || {}),
    `status=${put.status} updated=${put.json?.updated} decision=${JSON.stringify(put.json?.decision)}（恒 null：第0闸降级产证）`);

  // ⑥ round-trip：必须**深比较**（JSON.stringify 会因键序误判不等）
  const post = await request(PORT, 'GET', '/api/config/discovery-rules', null, adminTok);
  let roundTrip = false;
  let rtErr = '';
  try { assert.deepStrictEqual(post.json?.value, value); roundTrip = true; } catch (e) { rtErr = e.message.split('\n')[0]; }
  check('S2.6 GET round-trip 深比较相等', post.status === 200 && roundTrip,
    `status=${post.status} ${rtErr}`);

  // ⑦ 幂等：复跑同值 PUT 仍成功
  const put2 = await request(PORT, 'PUT', '/api/config/discovery-rules', { value }, adminTok);
  check('S2.7 复跑 PUT 幂等 → 200 updated:true',
    put2.status === 200 && put2.json?.updated === true, `status=${put2.status}`);

  // ═══ Step 3：HTTP 前台面 ═══
  console.log('\n── Step 3: HTTP 前台面 ──');
  const c1 = await request(PORT, 'GET', '/api/discovery/candidates');
  check("S3.1 未登录 candidates → 403 {error:'auth required'}（非 auth_required）",
    c1.status === 403 && c1.json?.error === 'auth required', `status=${c1.status} ${JSON.stringify(c1.json)}`);

  const c2 = await request(PORT, 'GET', '/api/discovery/candidates', null, userTok);
  check('S3.2 登录后 candidates → 200 且 items 为数组',
    c2.status === 200 && Array.isArray(c2.json?.items), `status=${c2.status} items=${JSON.stringify(c2.json?.items)?.slice(0, 60)}`);

  const pg1 = await request(PORT, 'GET', '/discovery.html');
  check('S3.3 /discovery.html → 200 text/html',
    pg1.status === 200 && /text\/html/.test(pg1.ct), `status=${pg1.status} ct=${pg1.ct} len=${pg1.len}`);

  const pg2 = await request(PORT, 'GET', '/discovery-rules.html');
  check('S3.4 /discovery-rules.html → 200 text/html',
    pg2.status === 200 && /text\/html/.test(pg2.ct), `status=${pg2.status} ct=${pg2.ct} len=${pg2.len}`);
} finally {
  child.kill();
}

// ═══ Step 4：MCP 工具面（真实 stdio）═══
console.log('\n── Step 4: MCP 工具面 (stdio) ──');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: PG },
  cwd: REPO_ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-discovery-touchpoints', version: '1.0.0' });
// 统一解包：非法 JSON 或网关拒绝（gate=xxx）都会让 ok!==true，必须显式暴露而非静默通过
function unpack(r) {
  if (!r.content?.[0]?.text) return r;
  try { return JSON.parse(r.content[0].text); } catch { return { ok: false, raw: r.content[0].text.slice(0, 200) }; }
}
// 写 phase1 契约：声明 decisionScenario 的写 Action，有 token + 无 confirm_token ⇒ mint 后发确认单
const phase1Ok = (p) => p?.ok === true
  && typeof p.confirm_token === 'string' && p.confirm_token.length > 0
  && p.form?.code === 'CONFIRM_REQUIRED'
  && !!p.form?.decision_id;

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const TARGETS = ['discovery-run', 'discovery-enrich', 'discovery-research'];
  for (const t of TARGETS) check(`S4.1 tools/list 含 ${t}`, names.includes(t), `共 ${names.length} 个工具`);

  // ② 负向基准：无 token ⇒ 闸门真拦（判据必须 ok!==true，只判 gate 字段存在会假绿）
  const anon = unpack(await client.callTool({ name: 'discovery-run', arguments: { seed: { name: 'e2e-probe' } } }));
  check('S4.2 discovery-run 无 token → ok===false && gate=auth_required',
    anon.ok === false && anon.gate === 'auth_required', JSON.stringify(anon).slice(0, 160));

  // ③ 登录
  const lg = unpack(await client.callTool({ name: 'crm_login', arguments: { username: USER, password: PASS } }));
  check(`S4.3 crm_login(${USER}) → ok===true 且有 token`, lg.ok === true && !!lg.token,
    `role=${lg.role} token=${lg.token ? 'yes' : 'no'}`);
  if (!lg.ok || !lg.token) throw new Error('无法登录，MCP 写通道断言中止');
  const auth = { api_token: lg.token };

  // ④ 有 token、不带 confirm_token ⇒ phase1 发确认单（ok===true + form.code=CONFIRM_REQUIRED + decision_id）
  const run = unpack(await client.callTool({
    name: 'discovery-run',
    arguments: { ...auth, seed: { name: 'e2e-probe', domain: 'e2e.example.com' } },
  }));
  check('S4.4 discovery-run 有 token/无 confirm_token → ok:true + CONFIRM_REQUIRED + decision_id',
    phase1Ok(run), `ok=${run.ok} confirm_token=${run.confirm_token ? 'yes' : 'no'} form.code=${run.form?.code} decision_id=${run.form?.decision_id || '(无)'}`);

  // ⑤ 另两个 Action 同判据（独立断言）
  const enr = unpack(await client.callTool({ name: 'discovery-enrich', arguments: { ...auth, account_id: 'e2e-probe' } }));
  check('S4.5 discovery-enrich 有 token/无 confirm_token → 同判据', phase1Ok(enr),
    `ok=${enr.ok} form.code=${enr.form?.code} decision_id=${enr.form?.decision_id || '(无)'}`);

  const res = unpack(await client.callTool({ name: 'discovery-research', arguments: { ...auth, account_id: 'e2e-probe', brief: 'e2e' } }));
  check('S4.6 discovery-research 有 token/无 confirm_token → 同判据', phase1Ok(res),
    `ok=${res.ok} form.code=${res.form?.code} decision_id=${res.form?.decision_id || '(无)'}`);
} catch (e) {
  check('S4 MCP 通道', false, e.message);
} finally {
  await client.close().catch(() => {});
}

// ═══ Step 5：buddy 绑定 + 插件包（子进程，断言退出码）═══
console.log('\n── Step 5: buddy 绑定 + 插件包 ──');
function runCmd(cmd, args, label) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: `${label}: ${e.code || e.message}` }));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const bind = await runCmd(process.execPath, ['scripts/buddy-capsule-binding-check.mjs'], 'buddy-capsule-binding-check');
check('S5.1 buddy 胶囊绑定校验 rc===0', bind.code === 0,
  bind.code === 0 ? (bind.out.match(/\d+\/\d+/g) || []).slice(-1)[0] || '' : bind.out.slice(-240));

// python 解释器探测（Windows 下 python/py/python3 皆有变体）
let pyRes = { code: -1, out: 'no python interpreter found' };
for (const py of [process.env.PYTHON, 'python', 'python3', 'py'].filter(Boolean)) {
  const r = await runCmd(py, ['-c', 'print(1)'], py);
  if (r.code === 0) { pyRes = await runCmd(py, ['scripts/verify-plugin-zips.py'], py); break; }
}
check('S5.2 插件包校验 verify-plugin-zips.py rc===0', pyRes.code === 0,
  pyRes.code === 0 ? (pyRes.out.match(/全部校验通过|verdict[^\n]*/i) || ['ok'])[0] : pyRes.out.slice(-240));

// ═══ 汇总 ═══
const failed = results.filter((r) => !r.pass);
console.log(`\n════ E2E 结果：${results.length - failed.length}/${results.length} 通过 ════`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
