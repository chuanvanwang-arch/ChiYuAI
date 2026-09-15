// scripts/e2e-prospecting-anysite.mjs
// 实跑：MCP 对话链路驱动的主动拓客，重点验证「新增付费源 anysite.io 成功调取」。
// 链路：MCP stdio → gateway → actionExecutor → prospecting-search/select/confirm
//   search 经 anysite 适配器真实 fetch 本地桩 api.anysite.io → 候选 → select → confirm(两阶段) → S0 入池。
// 注：真实 anysite.io 沙箱不可达；本地桩替代其 HTTP 端点，适配器真实 fetch/字段映射/fail-open 全跑。
// 凭据走 env ANY_SITE_KEY（credentialVault 系统级单 key 回退路径，合法凭据源）。
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG = process.env.PGDATABASE || 'crm_native_test';
process.env.PGDATABASE = PG; // 必须在动态 import src/db 之前（ESM 静态提升陷阱）

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// 本地 anysite.io 桩（替代真实 api.anysite.io；适配器真实 fetch 它）
function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      console.log(`  [stub] 收到请求: ${req.method} ${req.url}`);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url.includes('/token/statistic')) {
          return res.end(JSON.stringify({ detail: 'ok', remaining_quota: 100 }));
        }
        if (req.url.includes('/api/linkedin/search/users')) {
          // 返回 LinkedIn 风格人员/企业画像（带采购/研发信号，便于观测）
          return res.end(JSON.stringify({
            data: [
              { name: '青羽智行科技有限公司', title: '采购总监', company: '青羽智行', email: 'buyer@qy.com' },
              { name: '演示涂料工厂', title: '研发总监', company: '演示涂料', email: 'rnd@paint.com' },
              { name: '样例工业设备', title: '总经理', company: '样例设备', email: 'gm@eq.com' },
            ],
          }));
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function unpack(r) {
  if (!r.content?.[0]?.text) return r;
  try { return JSON.parse(r.content[0].text); } catch { return { ok: false, raw: r.content[0].text.slice(0, 200) }; }
}

const USER = 'alice';
const PASS = 'secret123';

async function main() {
  const stub = await startStub();
  const STUB_PORT = stub.address().port;
  const ANY_SITE_API = `http://127.0.0.1:${STUB_PORT}`;
  const ANY_SITE_KEY = 'e2e-dummy-key';
  console.log(`\n── anysite 本地桩就绪：ANY_SITE_API=${ANY_SITE_API} ──`);

  // MCP stdio 子进程（直连 executor，不经过 HTTP 后端）
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp/server.js', '--stdio'],
    env: { ...process.env, PGDATABASE: PG, ANY_SITE_API, ANY_SITE_KEY },
    cwd: REPO_ROOT,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'e2e-prospecting-anysite', version: '1.0.0' });
  await client.connect(transport);
  console.log('── MCP stdio 已连接 ──');

  // 登录
  const lg = unpack(await client.callTool({ name: 'crm_login', arguments: { username: USER, password: PASS } }));
  check('M1 crm_login → ok + token', lg.ok === true && !!lg.token, `role=${lg.role}`);
  if (!lg.ok) { await client.close(); stub.close(); return; }
  const auth = { api_token: lg.token };

  // 启用 anysite + 降低 fit_threshold（anysite search 返回人员无信号字段，fit_score=0，需阈值=0 才不过滤）
  const { writeConfig } = await import('../src/config/configStore.js');
  const { query } = await import('../src/db.js');
  // 查出 alice 的 MCP 身份真实租户（ctx.tenantId 取自 mcp_identity.tenant_id），把配置写到**该租户**而非假定 system
  const ident = await query(`SELECT tenant_id FROM crm.mcp_identity WHERE actor=$1 ORDER BY created_at DESC LIMIT 1`, [USER]);
  const TENANT = ident.rows[0]?.tenant_id || 'system';
  await writeConfig('prospecting-rules', {
    sources: { anysite: { enabled: true, weight: 0.2 } },
    fit_threshold: 0,
    candidate_limit: 50,
  }, { tenantId: TENANT, updatedBy: 'e2e' });
  const back = await (await import('../src/config/configStore.js')).readConfig('prospecting-rules', { tenantId: TENANT });
  console.log(`── 已写 config_store[prospecting-rules]（tenant=${TENANT}）：anysite.enabled=${back?.value?.sources?.anysite?.enabled}, fit_threshold=${back?.value?.fit_threshold} ──`);

  // 工具面含 prospecting 三工具
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const t of ['prospecting-search', 'prospecting-select', 'prospecting-confirm']) {
    check(`M2 tools/list 含 ${t}`, names.includes(t), `共 ${names.length} 个工具`);
  }

  // search（读，单次）→ MCP 网关包成 {ok, data:{session_id, candidates}}
  const icp = { industries: ['工业涂料', '设备制造'], min_headcount: 50, min_revenue_y: 1e8, geo: ['CN'] };
  const s = unpack(await client.callTool({ name: 'prospecting-search', arguments: { ...auth, query: icp } }));
  const sd = s.data || s;
  check('M3 prospecting-search → ok + session_id + candidates', s.ok === true && !!sd.session_id && Array.isArray(sd.candidates),
    `session=${sd.session_id} total=${sd.total} n=${sd.candidates?.length}`);
  const anysiteCands = (sd.candidates || []).filter((c) => c.provider === 'anysite' || c.source === 'anysite');
  check('M4 ⭐ anysite.io 成功调取：候选含 provider=anysite', anysiteCands.length > 0,
    `anysite候选=${anysiteCands.length} 样例=${JSON.stringify(anysiteCands[0] || {}).slice(0, 120)}`);
  if (anysiteCands.length === 0) {
    console.log('   [debug] search 全量响应:', JSON.stringify(sd).slice(0, 500));
    console.log('   （anysite 未返回候选，终止后续）');
    await writeConfig('prospecting-rules', { sources: { anysite: { enabled: false } }, fit_threshold: 0.6 }, { tenantId: TENANT, updatedBy: 'e2e' });
    await client.close(); stub.close(); return;
  }

  const sessionId = sd.session_id;
  const ids = anysiteCands.map((c) => c.id);

  // select（读，单次）→ {ok, data:{selected_ids,...}}
  const sel = unpack(await client.callTool({ name: 'prospecting-select', arguments: { ...auth, session_id: sessionId, selected_ids: ids } }));
  const seld = sel.data || sel;
  check('M5 prospecting-select → ok + 圈选回显', sel.ok === true && Array.isArray(seld.selected_ids) && seld.selected_ids.length === ids.length,
    `selected=${seld.selected_ids?.length}`);

  // confirm（写，两阶段）：phase1 → confirm_token
  const p1 = unpack(await client.callTool({ name: 'prospecting-confirm', arguments: { ...auth, session_id: sessionId, confirmed_ids: ids } }));
  check('M6 prospecting-confirm phase1 → ok + CONFIRM_REQUIRED + confirm_token（第0闸+两阶段）',
    p1.ok === true && typeof p1.confirm_token === 'string' && p1.confirm_token.length > 0
      && (p1.form?.code === 'CONFIRM_REQUIRED' || p1.code === 'CONFIRM_REQUIRED'),
    `ok=${p1.ok} code=${p1.form?.code || p1.code} token=${p1.confirm_token ? 'yes' : 'no'}`);
  if (!p1.confirm_token) { await client.close(); stub.close(); return; }

  // phase2 → 执行（executor 自动 mint decision_id 过第0闸）
  const p2 = unpack(await client.callTool({ name: 'prospecting-confirm', arguments: { ...auth, confirm_token: p1.confirm_token } }));
  const dealIds = (p2.data?.results || p2.results || []).filter((r) => r && r.deal_id).map((r) => r.deal_id);
  check('M7 prospecting-confirm phase2 → ok + 入池结果（含 decision_id）',
    p2.ok === true && dealIds.length > 0 && !!((p2.data?.results?.[0] || p2.results?.[0])?.decision_id),
    `ok=${p2.ok} 入池数=${dealIds.length} 首决策=${((p2.data?.results?.[0] || p2.results?.[0])?.decision_id || '').slice(0, 8)} err=${(p2.error || p2.gate || '').slice(0, 160)}`);

  // DB 终态：确认落入 S0 公海（source=prospecting）
  let allS0 = true, detail = '';
  for (const id of dealIds) {
    const r = await query(`SELECT payload FROM crm.particles WHERE id=$1 AND type='CRM_DEAL'`, [id]);
    const p = r.rows[0]?.payload || {};
    const okStage = p.stage === 'S0' && p.source === 'prospecting' && !!p.pooled_at;
    if (!okStage) allS0 = false;
    detail += ` ${id.slice(0, 8)}:stage=${p.stage},source=${p.source};`;
  }
  check('M8 DB 终态：S0 公海（source=prospecting, pooled_at 已写）', allS0 && dealIds.length > 0, detail.slice(0, 200));

  // 复原 config（幂等：恢复默认）
  await writeConfig('prospecting-rules', { sources: { anysite: { enabled: false } }, fit_threshold: 0.6 }, { tenantId: TENANT, updatedBy: 'e2e' });
  console.log('── 已复原 config_store[prospecting-rules]（anysite.enabled=false, fit_threshold=0.6）──');

  await client.close();
  stub.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n═══ 结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
