// scripts/smoke-propagation-hub.mjs
// 「参数传播中枢」修复后一键自检：验证 4 个 tab 依赖的 API 是否真的挂载并可达。
// 触发场景：routes.js 曾漏挂 registerPropagationRoutes(app, pool)，导致全部 propagation API 401/404、
//            propagation-hub.html 的 ①继承视图 / ④已落地 等 tab 调 API 失败、界面停留在空白/加载失败。
// 用法：重启 server 后执行 `node scripts/smoke-propagation-hub.mjs`
import { writeFileSync } from 'node:fs';

const HOST = 'http://localhost:3000';
const out = [];
function log(s) { out.push(s); console.log(s); }

async function get(pathname, headers = {}) {
  const r = await fetch(`${HOST}${pathname}`, { headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, raw: text };
}
async function login() {
  const r = await fetch(`${HOST}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

let failures = 0;
function check(name, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  log('--- 1. 登录 ---');
  const token = await login();
  check('拿到 admin token', !!token, `len=${token.length}`);

  log('--- 2. ① 继承视图 API (/api/config/inherit-matrix) ---');
  const inh = await get('/api/config/inherit-matrix', { authorization: `Bearer ${token}` });
  check('inherit-matrix HTTP 200', inh.status === 200, `status=${inh.status}`);
  check('inherit-matrix 返回矩阵结构', !!inh.json && Array.isArray(inh.json.tenants) && inh.json.entries !== undefined);

  log('--- 3. ④ 已落地 API (/api/propagation/actions) ---');
  const act = await get('/api/propagation/actions', { authorization: `Bearer ${token}` });
  check('actions HTTP 200', act.status === 200, `status=${act.status}`);
  check('actions 返回列表结构', !!act.json && Array.isArray(act.json.items));

  log('--- 4. ③ 推广候选 API (/api/propagation/suggestions) ---');
  const sug = await get('/api/propagation/suggestions', { authorization: `Bearer ${token}` });
  check('suggestions HTTP 200', sug.status === 200, `status=${sug.status}`);

  log('--- 5. ② 下发草稿 HTML 可达 (/propagation-hub.html) ---');
  const html = await get('/propagation-hub.html');
  check('propagation-hub.html HTTP 200', html.status === 200, `status=${html.status}`);

  log('');
  if (failures === 0) {
    log('✅ 全部通过：参数传播中枢路由已挂载，4 个 tab 依赖的 API 全部可达。浏览器强刷 Ctrl+Shift+R 即可看到 ①继承视图 / ④已落地 真实渲染。');
  } else {
    log(`❌ ${failures} 项失败。`);
    log('   若 inherit-matrix / actions 返回 401 或 404 → server 未重启（修复需重启后生效）。');
    log('   重启命令（PowerShell）：在 CRM-ai-native 目录重启启动 server 的进程。');
  }
} catch (e) {
  log('🔥 脚本异常: ' + e.message);
  failures++;
}

writeFileSync('scripts/_smoke_propagation_out.txt', out.join('\n'));
process.exit(failures === 0 ? 0 : 1);
