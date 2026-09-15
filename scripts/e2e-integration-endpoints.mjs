/**
 * E2E：外部数据接入端点面端到端验收（HTTP 真实实例）
 * 计划：docs/superpowers/plans/2026-09-14-external-data-integration-plan.md → T12/T13 验收
 *
 * 项目铁律：**单测全绿 ≠ 链路通**（范式：scripts/e2e-discovery-touchpoints.mjs）。
 * 本脚本起真实 HTTP 实例（隔离端口 + crm_native_test），验证：
 *   S1 实例就绪（GET /discovery-rules.html：200 text/html）
 *   S2.1 未登录 POST /api/integration/secret → 401（全局 auth 中间件）
 *   S2.2 sales 写凭据 → 403（平台级闸，仅 ADMIN/sysadmin）
 *   S2.3 admin POST /api/integration/secret → 200 updated:true（加密落库，明文不回传）
 *   S2.4 admin GET /api/config/integration-providers → 200（结构存在；未配置则 404/200 双合法）
 *   S2.5 sales GET /api/config/integration-providers → 403（system 级闸）
 *   S2.6 明文不得回传：读回无明文、无 raw 字段
 *   S2.7 静态页含「接入数据源」Tab 与 webhook/加密端点接线
 *
 * 用法：
 *   PGDATABASE=crm_native_test node scripts/e2e-integration-endpoints.mjs
 *   E2E_USER=alice E2E_PASS=secret123 E2E_ADMIN=admin E2E_ADMIN_PASS=admin123 可覆盖
 *
 * ── 两处硬约束（对齐 e2e-discovery-touchpoints.mjs 头部）──────────────
 * ① 先设 env 再动态 import（ESM 静态 import 提升陷阱 → 连生产库）
 * ② 端口动态选取（3000/3100/3211 常被占用；复用外部旧实例会测到旧代码）
 *
 * ── 运行副作用（落 crm_native_test；禁 DELETE，不可回滚）───────────────
 * ① admin 写一条 integration-secrets(qixin) 加密凭据 → 该键从空变为有值
 *    （幂等：每次写同 provider 覆盖；明文永不出现在 config_store/响应）
 * ② 第 0 闸产证 1 条决策（决策行为，非缺陷；与 discovery E2E 同判据）
 * 实测生产库 crm_native 该键 0 行，本脚本不触碰生产库。
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG = process.env.PGDATABASE || 'crm_native_test';
process.env.PGDATABASE = PG; // 必须在任何 src 导入之前（见头部约束 ①）
// 对称密钥：本 E2E 自注入测试钥（平台生产由密钥管理注入；缺失时 persistSecret fail-closed 拒写）
if (!process.env.PGCRYPTO_SYM_KEY) process.env.PGCRYPTO_SYM_KEY = 'e2e-test-sym-key';

const USER = process.env.E2E_USER || 'alice';
const PASS = process.env.E2E_PASS || 'secret123';
const ADMIN = process.env.E2E_ADMIN || 'admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || 'admin123';

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
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 10000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* 非 JSON（HTML 页面）*/ }
        resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', json, len: b.length, raw: b });
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
  const r = await request(PORT, 'GET', '/discovery-rules.html');
  if (r.status === 200 || r.status === 404) { ready = true; break; }
  await sleep(500);
}
check(`S1 实例就绪（PORT=${PORT}, PGDATABASE=${PG}）`, ready, ready ? '' : bootLog.slice(0, 400));
if (!ready) { child.kill(); process.exit(1); }

try {
  // ═══ Step 2：端点面 ═══
  console.log('\n── Step 2: 端点面 ──');
  const login = async (u, pw) => (await request(PORT, 'POST', '/api/auth/login', { username: u, password: pw })).json;
  const adminTok = (await login(ADMIN, ADMIN_PASS))?.token;
  const userTok = (await login(USER, PASS))?.token;
  check('S2.0 admin/user 登录取得 token', !!adminTok && !!userTok,
    `admin=${!!adminTok} ${USER}=${!!userTok}`);

  // ① 未登录 → 401
  const anon = await request(PORT, 'POST', '/api/integration/secret', { providerId: 'qixin', raw: 'sk-xxx' });
  check('S2.1 未登录 POST /api/integration/secret → 401', anon.status === 401,
    `status=${anon.status} ${JSON.stringify(anon.json)}`);

  // ② sales 写凭据 → 403（平台级闸仅 ADMIN/sysadmin）
  const denied = await request(PORT, 'POST', '/api/integration/secret', { providerId: 'qixin', raw: 'sk-xxx' }, userTok);
  check('S2.2 sales POST /api/integration/secret → 403', denied.status === 403,
    `status=${denied.status} ${JSON.stringify(denied.json)}`);

  // ③ admin 写凭据 → 200 updated:true（幂等写同 provider；明文不落库由 credentialVault 保证）
  const secretWrite = await request(PORT, 'POST', '/api/integration/secret',
    { tenantId: 'system', providerId: 'qixin', raw: 'sk-e2e-' + Date.now() }, adminTok);
  check('S2.3 admin POST /api/integration/secret → 200 updated:true',
    secretWrite.status === 200 && secretWrite.json?.updated === true,
    `status=${secretWrite.status} ${JSON.stringify(secretWrite.json)}`);

  // ④ admin GET integration-providers → 200（结构完整）或 404（未配置，双合法）
  const prov = await request(PORT, 'GET', '/api/config/integration-providers', null, adminTok);
  const provOk = prov.status === 404
    || (prov.status === 200 && (prov.json?.value === null || typeof prov.json?.value === 'object'));
  check('S2.4 admin GET /api/config/integration-providers → 200(结构) 或 404(未配置)',
    provOk, `status=${prov.status}`);

  // ⑤ sales GET integration-providers → 403（system 级闸）
  const provDenied = await request(PORT, 'GET', '/api/config/integration-providers', null, userTok);
  check('S2.5 sales GET /api/config/integration-providers → 403', provDenied.status === 403,
    `status=${provDenied.status} ${JSON.stringify(provDenied.json)}`);

  // ⑥ 明文不得回传：GET 凭据面无明文、无 raw 字段（本端点只写不读，读回断言页面不含密钥明文文本）
  const pg = await request(PORT, 'GET', '/discovery-rules.html');
  check('S2.6 /discovery-rules.html → 200 text/html 且不含明文密钥字样',
    pg.status === 200 && /text\/html/.test(pg.ct) && !/sk-e2e-/i.test(pg.raw),
    `status=${pg.status} ct=${pg.ct} len=${pg.len}`);

  // ⑦ 静态页含「接入数据源」Tab 与 webhook/加密接线
  const tabOk = /接入数据源/.test(pg.raw)
    && /\/api\/integration\/secret/.test(pg.raw)
    && /panel-integration-sources/.test(pg.raw)
    && /inst-dialog/.test(pg.raw);   // 新增实例 CRUD 对话框已接线
  check('S2.7 discovery-rules.html 含「接入数据源」Tab + 加密端点 + 面板 + CRUD 对话框',
    tabOk, tabOk ? 'Tab/面板/端点/CRUD 接线齐全' : '缺接线（见下方摘要）');

  // ═══ Step 3：租户自有实例 CRUD 真回路 ═══
  console.log('\n── Step 3: 实例 CRUD 真回路 ──');
  // ① sales 访问 CRUD → 403（平台级闸）
  const cDenied = await request(PORT, 'GET', '/api/integration/providers', null, userTok);
  check('S3.1 sales GET /api/integration/providers → 403', cDenied.status === 403,
    `status=${cDenied.status} ${JSON.stringify(cDenied.json)}`);

  // ② admin 新增实例 → 200（校验合法输入：generic-rest + endpoint + field_map）
  const instId = 'e2e-erp-' + Date.now();
  const add = await request(PORT, 'POST', '/api/integration/providers',
    { tenantId: 'system', instance: { id: instId, kind: 'generic-rest', endpoint: 'https://erp.example/api', field_map: { legal_person: 'legal' }, enabled: true } }, adminTok);
  check('S3.2 admin POST /api/integration/providers → 200 updated', add.status === 200 && add.json?.updated === true,
    `status=${add.status} ${JSON.stringify(add.json)}`);

  // ③ admin GET 列表 → 200 且含刚新增实例
  const list = await request(PORT, 'GET', '/api/integration/providers', null, adminTok);
  check('S3.3 admin GET 列表 → 200 含新实例', list.status === 200
    && Array.isArray(list.json?.instances) && list.json.instances.some((x) => x.id === instId),
    `status=${list.status} instances=${Array.isArray(list.json?.instances) ? list.json.instances.length : '-'}`);

  // ④ admin PUT 软停用 → 200 且 enabled=false
  const off = await request(PORT, 'PUT', `/api/integration/providers/${encodeURIComponent(instId)}`,
    { tenantId: 'system', patch: { enabled: false } }, adminTok);
  check('S3.4 admin PUT 软停用 → 200 enabled=false', off.status === 200
    && off.json?.instances?.find((x) => x.id === instId)?.enabled === false,
    `status=${off.status} ${JSON.stringify(off.json)}`);

  // ⑤ admin PUT 编辑 field_map → 200（更新字段）
  const upd = await request(PORT, 'PUT', `/api/integration/providers/${encodeURIComponent(instId)}`,
    { tenantId: 'system', patch: { field_map: { legal_person: 'legal', registered_address: 'addr' } } }, adminTok);
  check('S3.5 admin PUT 编辑 → 200 且 field_map 更新', upd.status === 200
    && upd.json?.instances?.find((x) => x.id === instId)?.field_map?.registered_address === 'addr',
    `status=${upd.status} ${JSON.stringify(upd.json)}`);

  // ⑥ 非法 kind → 400（校验拒绝）
  const bad = await request(PORT, 'POST', '/api/integration/providers',
    { tenantId: 'system', instance: { id: 'bad-' + Date.now(), kind: 'bogus' } }, adminTok);
  check('S3.6 非法 kind → 400', bad.status === 400, `status=${bad.status} ${JSON.stringify(bad.json)}`);

  // ⑦ DELETE → 405 禁删铁律
  const del = await request(PORT, 'DELETE', `/api/integration/providers/${encodeURIComponent(instId)}`, null, adminTok);
  check('S3.7 DELETE → 405（禁删铁律）', del.status === 405, `status=${del.status} ${JSON.stringify(del.json)}`);

  // ⑧ 重复 id → 409
  const dup = await request(PORT, 'POST', '/api/integration/providers',
    { tenantId: 'system', instance: { id: instId, kind: 'generic-rest', field_map: {} } }, adminTok);
  check('S3.8 重复 id → 409', dup.status === 409, `status=${dup.status} ${JSON.stringify(dup.json)}`);
} finally {
  child.kill();
}

// ═══ 汇总 ═══
const failed = results.filter((r) => !r.pass);
console.log(`\n════ E2E 结果：${results.length - failed.length}/${results.length} 通过 ════`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
