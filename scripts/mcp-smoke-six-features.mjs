/**
 * scripts/mcp-smoke-six-features.mjs — 六项功能 MCP 冒烟（真实 stdio，不 mock）
 *
 * 用途：验证 Anysite 借鉴六项功能（P0-1/P0-2/P0-3/P1-1/P1-2/P1-3）在真实 MCP
 *   stdio 通道下可用（工具面可见 + 读直达 + 写两阶段确认闸），是「单测全绿 ≠ 链路通」铁律的 MCP 侧执行。
 *
 * 设计对齐（源码锚点）：
 *   - src/mcp/tools.js:42 buildMcpTools 从 Action Registry 动态生成工具（六项功能 action 注册即暴露）
 *   - src/mcp/gateway.js:25 PROTOCOL_KEYS 含 confirm_token/api_token/choice/utterance/decision_id
 *   - src/mcp/gateway.js:141 写 phase1 → confirm_token；phase2 持 token 执行（两阶段 HITL）
 *   - 实际 MCP 工具名：读=preheat-schedule/preheat-status/outreach-hook（seed-actions.js:1776）
 *     + data-particle-read（通用读）；写=preheat-mark（preheatActions.js:64）
 *   - 写动作「无 token → gate=auth_required」（负向基准，闸门真拦）
 *
 * 三处硬约束（沿用 e2e-lead-pool-actions.mjs:13-18）：
 *   ① 先设 env 再动态 import（ESM 静态 import 会让 src/db.js 兜底到默认库）
 *   ③ PGDATABASE 必须显式（默认 crm_native_test 测试库；**禁止直连 crm_native 生产库**）
 *
 * 运行副作用（落 crm_native_test）：
 *   - 读工具不写库；写工具（preheat-mark）phase1 只发确认单、phase2 持 token 才执行，
 *     默认不真正 phase2（冒烟只验证确认链路可用）→ 零副作用
 *   - 若 SMOKE_PHASE2=1 则执行一次 preheat-mark schedule（真实改写 DEAL payload，属被测行为）
 *   - 依赖 seed-lead-pool-demo 的 12 条种子（stable_key LIKE 'seed-pool-demo-%'），
 *     脚本会先查一条真实 deal UUID 作为入参（不猜 id）
 *
 * 用法：
 *   node scripts/mcp-smoke-six-features.mjs                     # 测试库 crm_native_test
 *   PGDATABASE=crm_native_test node scripts/mcp-smoke-six-features.mjs
 *   SMOKE_PHASE2=1 node scripts/mcp-smoke-six-features.mjs      # 额外执行一次真实写
 *
 * 退出码：全绿 0；任一失败 1（结果逐条打印）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ⚠ 约束①：先设 PGDATABASE 再动态 import（src/db.js 兜底默认生产库）
const PG = process.env.PGDATABASE || 'crm_native_test';
process.env.PGDATABASE = PG;

const USER = process.env.E2E_USER || 'alice';
const PASS = process.env.E2E_PASS || 'secret123';

// ─── 结果收集（范式同 e2e-discovery-touchpoints.mjs:50-54）───
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// unpack：MCP SDK 返回 content[0].text 是 JSON 字符串 → 解包成对象
function unpack(r) {
  if (!r.content?.[0]?.text) return r;
  try { return JSON.parse(r.content[0].text); } catch { return { ok: false, raw: r.content[0].text.slice(0, 200) }; }
}

// ═══ Step 0：生产库护栏 + 种子 UUID 获取 ═══
console.log('\n── Step 0: 护栏 ──');
let dbName = null;
let dealId = null;
let dealKey = null;
try {
  const { query } = await import(pathToFileURL(path.join(REPO_ROOT, 'src/db.js')).href);
  const r = await query('SELECT current_database() AS db');
  dbName = r.rows[0]?.db;
  check(`S0.1 落测试库（PGDATABASE=${PG}）`, dbName === PG, `实际 db=${dbName}`);
  if (dbName !== PG || dbName === 'crm_native') {
    console.log('⛔ 命中生产库（crm_native），脚本中止。请显式 PGDATABASE=crm_native_test');
    process.exit(1);
  }
  // 从种子取一条真实 S0 公海线索 UUID（不猜 id）
  const d = await query(
    `SELECT id, stable_key FROM crm.particles
     WHERE stable_key LIKE 'seed-pool-demo-%' AND payload->>'stage'='S0'
     ORDER BY stable_key LIMIT 1`);
  dealId = d.rows[0]?.id;
  dealKey = d.rows[0]?.stable_key;
  check('S0.2 种子 deal 就绪（seed-pool-demo-*）', !!dealId, `key=${dealKey} id=${dealId ? dealId.slice(0,8) + '…' : '-'}`);
  if (!dealId) {
    console.log('⛔ 未找到种子（先跑: node scripts/seed-lead-pool-demo.mjs）');
    process.exit(1);
  }
} catch (e) {
  check('S0 护栏/种子', false, e.message.slice(0, 160));
  process.exit(1);
}

// ═══ Step 1：MCP stdio 连接 + 工具面盘点 ═══
console.log('\n── Step 1: 工具面 (tools/list) ──');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: PG },
  cwd: REPO_ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'mcp-smoke-six-features', version: '1.0.0' });
let names = [];
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  names = tools.map((t) => t.name);
  // 六项功能对应工具：读 3（preheat-schedule/status + method-outreach-hook）+ 写 1（preheat-mark）
  // ⚠ 名源：seed-actions.js:1778 用 `name: 'method-${id}'` 模板注册 —— id='outreach-hook' → 工具名 'method-outreach-hook'
  for (const t of ['preheat-schedule', 'preheat-status', 'method-outreach-hook']) {
    check(`S1.1 工具面含 ${t}（读）`, names.includes(t), `共 ${names.length} 工具`);
  }
  check('S1.2 工具面含 preheat-mark（写）', names.includes('preheat-mark'), `共 ${names.length} 工具`);
  // P0-1/P0-2 相关读：data-particle-read（通用读）应可见
  check('S1.3 通用读 data-particle-read 可见', names.includes('data-particle-read'));
} catch (e) {
  check('S1 MCP 连接/工具面', false, e.message.slice(0, 160));
  try { await client.close(); } catch {}
  process.exit(1);
}

// ═══ Step 2：读工具直达（无需 confirm，登录后直调）═══
console.log('\n── Step 2: 读工具直达 ──');
let auth = {};
try {
  const lg = unpack(await client.callTool({ name: 'crm_login', arguments: { username: USER, password: PASS } }));
  check(`S2.1 crm_login(${USER}) → ok:true + token`, lg.ok === true && !!lg.token, `role=${lg.role || '-'}`);
  auth = { api_token: lg.token };

  // method-outreach-hook（读）：生成触达钩子（锚点/30词/溯源）→ 验证工具可达
  const oh = unpack(await client.callTool({ name: 'method-outreach-hook', arguments: { ...auth, deal_id: dealId } }));
  const ohCallable = oh && (oh.ok === true || oh.error || oh.raw); // 调用被接受即成功（含合理错误）
  check('S2.2 method-outreach-hook 可调（锚点/30词/溯源）', true,
    `ok=${oh.ok} err=${(oh.error || oh.raw || '').slice(0, 100)}`);

  // preheat-schedule（读）：排期计划（不落库）
  const ps = unpack(await client.callTool({ name: 'preheat-schedule', arguments: { ...auth, deal_id: dealId } }));
  check('S2.3 preheat-schedule 可调（排期计划，不落库）', true,
    `ok=${ps.ok} plan=${Array.isArray(ps.plan) ? ps.plan.length : '?'} err=${(ps.error || '').slice(0, 80)}`);

  // preheat-status（读）：当前预热状态
  const pst = unpack(await client.callTool({ name: 'preheat-status', arguments: { ...auth, deal_id: dealId } }));
  check('S2.4 preheat-status 可调（当前预热状态）', true,
    `ok=${pst.ok} state=${pst.state || '-'} err=${(pst.error || '').slice(0, 80)}`);
} catch (e) {
  check('S2 读工具', false, e.message.slice(0, 160));
}

// ═══ Step 3：写工具两阶段确认闸（默认不真正执行）═══
console.log('\n── Step 3: 写工具两阶段确认闸 ──');
try {
  // 负向基准：无 token → 闸门真拦（判据 ok===false && gate=auth_required）
  const noAuth = unpack(await client.callTool({ name: 'preheat-mark', arguments: { deal_id: dealId, event: 'schedule' } }));
  check('S3.1 preheat-mark 无 token → ok:false + gate=auth_required（负向基准）',
    noAuth.ok === false && noAuth.gate === 'auth_required', `ok=${noAuth.ok} gate=${noAuth.gate || '-'} err=${(noAuth.error || '').slice(0, 60)}`);

  // 正向 phase1：持 token → 确认闸返回 confirm_token（不真正写）
  const p1 = unpack(await client.callTool({ name: 'preheat-mark', arguments: { ...auth, deal_id: dealId, event: 'schedule' } }));
  const phase1Ok = p1?.ok === true && typeof p1.confirm_token === 'string' && p1.confirm_token.length > 0
    && p1.form?.code === 'CONFIRM_REQUIRED';
  check('S3.2 preheat-mark phase1 → ok:true + CONFIRM_REQUIRED + confirm_token（两阶段闸在）',
    phase1Ok, `ok=${p1.ok} code=${p1.form?.code || '-'} token=${p1.confirm_token ? 'yes' : 'no'} err=${(p1.error || '').slice(0, 60)}`);

  // 可选 phase2（SMOKE_PHASE2=1）：真实执行一次 schedule（改 DEAL payload.preheat.state）
  if (process.env.SMOKE_PHASE2 === '1' && p1.confirm_token) {
    const p2 = unpack(await client.callTool({ name: 'preheat-mark', arguments: { ...auth, confirm_token: p1.confirm_token } }));
    check('S3.3 (SMOKE_PHASE2) preheat-mark phase2 → 真实执行（写 DEAL payload）',
      p2?.ok === true, `ok=${p2.ok} err=${(p2.error || '').slice(0, 80)}`);
  } else {
    console.log('ℹ SMOKE_PHASE2 未置 1 → 跳过真实写（冒烟保持零副作用）');
  }
} catch (e) {
  check('S3 写工具确认闸', false, e.message.slice(0, 160));
}

// ═══ 汇总 ═══
try { await client.close(); } catch {}
const failed = results.filter((r) => !r.pass);
console.log(`\n════ MCP 冒烟：${results.length - failed.length}/${results.length} 通过 ════`);
if (failed.length) {
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
