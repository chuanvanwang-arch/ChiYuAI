// scripts/verify-onboarding-guide-hints.mjs — 接入向导的**运行期**验证器
//
// 为什么需要：本页有两类只能靠「真跑」证明的事——
//   ① 拒因引导（假失败）：163 IMAP 拒的是「授权码机制」，若页面只显示 auth_failed，用户会去反复改密码。
//   ② 三形态路径（P2 §5.4）：A/B 两条路**不得**在本页收集凭据；页面默认必须落在 A（用户第一眼看不到密码框）。
//   grep 字符串只能证明它在文件里，证明不了**会被走到、不会被无关通道误触发**。
// 做法：抽出 <script type="module">，注入 DOM 桩与 fetch 桩，按真实操作顺序驱动（切路径 → 填值 → 下一步 → 验证），
//   断言渲染文本、**请求体**（source_kind / credentials）与面板可见性。零新依赖、不触网。
//
// 用法：
//   node scripts/verify-onboarding-guide-hints.mjs                            # 验真实页面
//   ONBOARD_HTML=tmp/_mut.html node scripts/verify-onboarding-guide-hints.mjs # 验变异体（自证鉴别力）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const htmlRel = process.env.ONBOARD_HTML || 'src/web/onboarding-guide.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
console.log('被测页面:', htmlRel);

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ✅ ' : '  🔴 ') + msg); if (!cond) failures++; }

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('🔴 未找到 <script type="module">（锚点失效）'); process.exit(1); }
const script = m[1];
ok(/guidedHint\s*\(/.test(script), 'doVerify 已接入 guidedHint（拒因引导确实被调用，非死代码）');

const STUB = `
const __els = {};
function mkEl(id) {
  const cls = new Set();
  return {
    id, hidden: null, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: {
      toggle(c, on) { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) cls.add(c); else cls.delete(c); },
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), _set: cls,
    },
    _ev: {},
    addEventListener(ev, fn) { this._ev[ev] = fn; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { return c; }, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
globalThis.__els = __els;
globalThis.__mk = {};                 // 各路径下的通道勾选（探针注入）
globalThis.__reqs = [];               // 真实发出的请求（断言请求体）
globalThis.document = {
  getElementById: (id) => (__els[id] ||= mkEl(id)),
  createElement: (t) => mkEl(t), querySelector: () => null,
  querySelectorAll: (sel) => {
    const s = String(sel);
    if (s.includes('panel-connector')) return globalThis.__mk.connector || [];
    if (s.includes('panel-local-bridge')) return globalThis.__mk['local-bridge'] || [];
    return [];
  },
};
globalThis.location = { href: '', pathname: '/onboarding-guide.html', search: '' };
// Node ≥21 的 globalThis.navigator 是只读 getter（直接赋值抛 TypeError）→ 必须 defineProperty
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (t) => { globalThis.__copied = t; } } }, configurable: true, writable: true,
});
globalThis.window = globalThis;
`;

function build({ resp, expectUrl = '/api/channels/connect' }) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL('_onboard_hint.mjs', dir);
  writeFileSync(file, [
    '// 自动生成（探针产物，勿手改）',
    'globalThis.fetch = async (url, init) => {',
    '  globalThis.__reqs.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });',
    `  if (String(url).includes(${JSON.stringify(expectUrl)})) return { ok: true, status: 200, json: async () => (${JSON.stringify(resp)}) };`,
    '  return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };',
    '};',
    STUB,
    script,
    'globalThis.__page = { els: __els };',
  ].join('\n'), 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now());
}

/**
 * @param {object} o
 * @param {string} o.path      接入路径（'connector' | 'local-bridge' | 'direct'）；不传＝用页面默认（应为 A）
 * @param {object} o.fill      direct 路径下要填的表单字段
 * @param {object} o.resp      /api/channels/connect 的桩响应
 * @param {boolean} o.skipNextStep 默认会点「下一步」（让 collect() 真正跑）
 */
async function runVerify({ path, fill = {}, resp, boxes = null, skipNextStep = false }) {
  await build({ resp });
  // ⚠ 必须在 build() **之后**注入勾选：STUB 会把 __mk 重置为空对象（顺序反了就永远是 0 个请求）
  if (boxes) globalThis.__mk = boxes;
  const els = globalThis.__els;
  if (path) {
    const btn = els['m-' + path]?.onclick;
    if (typeof btn !== 'function') { console.log(`  🔴 未找到路径切换按钮 m-${path}`); failures++; return { out: '', reqs: [] }; }
    btn();
  }
  for (const [id, v] of Object.entries(fill)) globalThis.document.getElementById(id).value = v;
  if (!skipNextStep) {
    // ⚠ 必须先点「下一步」（to2）让 collected 被 collect() 填充——直接点「验证」时 collected 恒为空。
    const to2 = els['to2']?.onclick;
    if (typeof to2 === 'function') to2();
  }
  const h = els['doVerify']?.onclick;
  if (typeof h !== 'function') { console.log('  🔴 doVerify 未绑定 handler'); failures++; return { out: '', reqs: [] }; }
  try { await h(); } catch (e) {
    console.log('  🔴 handler 抛错（页面在真实浏览器同样会中断）:', e?.message || e);
    failures++;
  }
  return { out: els['verifyOut'].textContent || '', reqs: globalThis.__reqs.filter((r) => r.url.includes('/api/channels/connect')) };
}
const mkBoxes = (vals) => vals.map((v) => ({ value: v, checked: true }));

console.log('\n场景 A（C 平台直连）：邮箱 auth_failed —— 163 真实现场：服务端拒因＝需授权码');
{
  const { out } = await runVerify({
    path: 'direct',
    fill: { email: 'watchm@163.com', pass: 'not-a-code' },
    resp: { ok: false, error: 'auth_failed', probe: 'imap_login', missing: null, hint: 'A1 NO LOGIN Login error or password error' },
  });
  ok(/auth_failed/.test(out), '如实显示 auth_failed（不粉饰）');
  ok(/Login error or password error/.test(out), '透出服务端原话（用户可判读真因）');
  ok(/客户端授权码/.test(out), '点明真因：163/126/QQ 须用「客户端授权码」——不让人反复改密码');
}

console.log('\n场景 B（C）：探测通过 → 不得出现「授权码」提示（否则是噪音误报）');
{
  const { out } = await runVerify({
    path: 'direct', fill: { email: 'ok@company.com', pass: 'code' },
    resp: { ok: true, verified: true, stored: false, probe: 'imap_login' },
  });
  ok(/✅/.test(out), '显示探测通过');
  ok(!/客户端授权码/.test(out), '未误报授权码引导');
}

console.log('\n场景 C（C）：凭据不全（缺 host）→ 显示缺哪个字段，且不得误报为「授权码问题」');
{
  const { out } = await runVerify({
    path: 'direct', fill: { email: 'a@b', pass: 'x' },
    resp: { ok: false, error: 'credentials_incomplete', probe: 'imap_login', missing: ['host'], hint: null },
  });
  ok(/credentials_incomplete/.test(out), '如实显示 credentials_incomplete');
  ok(/缺：host/.test(out), '显示缺哪个字段（用户知道改哪里）');
  ok(!/客户端授权码/.test(out), '缺字段 ≠ 授权码问题（两种失败不可混为一谈）');
}

console.log('\n场景 D（C）：非邮箱通道 auth_failed → 不得套用邮箱授权码话术（跨通道误报）');
{
  const { out } = await runVerify({
    path: 'direct', fill: { cal: 'https://caldav.example.com/dav/' },
    resp: { ok: false, error: 'auth_failed', probe: 'caldav_propfind', missing: null, hint: 'http 401' },
  });
  ok(/auth_failed/.test(out), '日历通道如实显示 auth_failed');
  ok(!/客户端授权码/.test(out), '日历失败不套邮箱话术（引导必须按通道区分）');
}

console.log('\n场景 E（A 连接器，默认路径）：不填任何凭据也能走通，且**不得**上传凭据');
{
  const { out, reqs } = await runVerify({
    boxes: { connector: mkBoxes(['generic-email', 'generic-calendar']) },
    resp: { ok: true, verified: false, pending: true, stored: false, source_kind: 'connector', method: 'user_side_connector' },
  });
  ok(reqs.length === 2, `按勾选发出 2 个请求（实际 ${reqs.length}）`);
  ok(reqs.every((r) => r.body && r.body.source_kind === 'connector'), '请求体显式携带 source_kind=connector');
  ok(reqs.every((r) => r.body && r.body.credentials === null), 'A 路径**不上传**任何凭据（这正是该形态的意义）');
  ok(/待你在自己那侧确认/.test(out), '如实显示「待确认」而非「已验证」');
  ok(!/平台侧探测通过/.test(out), '不把未验证显示成平台已验证（假绿红线）');
  const els = globalThis.__els;
  ok(els['m-connector'].classList.contains('on'), '默认落在 A 连接器路径（用户第一眼看到的是引导，不是密码框）');
  const P = (id) => globalThis.document.getElementById(id);
  ok(P('panel-direct').hidden === true, '默认隐藏 C 路径的密码表单');
  ok(P('panel-connector').hidden === false, '默认显示 A 路径引导面板');
}

console.log('\n场景 F（B 本机桥）：给出可复制命令，凭据留本机');
{
  const { out, reqs } = await runVerify({
    path: 'local-bridge', boxes: { 'local-bridge': mkBoxes(['generic-email']) }, fill: { email: 'watchm@163.com' },
    resp: { ok: true, verified: false, pending: true, stored: false, source_kind: 'local-bridge', method: 'user_side_local' },
  });
  const cmd = globalThis.__els['localCmd'].textContent || '';
  ok(/himalaya/.test(cmd), '给出具体可执行的 CLI（himalaya），不是「请自行配置」');
  ok(/993/.test(cmd), '命令含真实端口（IMAP over TLS）');
  ok(/watchm@163\.com/.test(cmd), '按用户填的邮箱生成命令（不是写死的示例）');
  ok(/客户端授权码/.test(cmd), '命令里点明国内邮箱须用授权码（否则用户照抄必然失败）');
  ok(reqs.length === 1 && reqs[0].body.source_kind === 'local-bridge', '请求体携带 source_kind=local-bridge');
  ok(reqs.every((r) => r.body.credentials === null), 'B 路径不上传凭据');
  ok(/待你在自己那侧确认/.test(out), 'B 路径同样如实显示「待确认」');
}

console.log('\n场景 G：切到 C 路径后，密码表单必须真的出现（反向判据：隐藏不能变成永久不可达）');
{
  await build({ resp: { ok: true } });
  const els = globalThis.__els;
  const btn = els['m-direct'].onclick;
  btn();
  const P = (id) => globalThis.document.getElementById(id);
  ok(P('panel-direct').hidden === false, '切到 C 后密码表单可见（用户确实能选这条路）');
  ok(P('panel-connector').hidden === true, '同时收起 A 面板（三条路并存会让用户在 A 路径下把密码填进 C 的表单）');
  ok(globalThis.__els['m-direct'].classList.contains('on'), 'C 卡呈选中态');
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n🔴 ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
