// scripts/verify-onboarding-guide-hints.mjs — 接入向导「服务端拒因 → 可执行下一步」的**运行期**验证器
//
// 为什么需要：本轮修的是**假失败**——163 IMAP 拒的是「授权码机制」，但页面只显示 `auth_failed`，
//   用户（真实反馈路径）会去反复改密码。要证明「真因与操作路径真的渲染到页面」，
//   grep `客户端授权码` 只能证明字符串在文件里，证明不了**它会被走到 / 不会被无关通道误触发**。
// 做法：把 <script type="module"> 整段抽出来，注入 DOM 桩与 fetch 桩，真跑 `doVerify.onclick`，
//   断言 verifyOut 的真实输出文本（含 ✅/⛔/缺字段/授权码引导）。
// 零新依赖、不触网：fetch 全部由桩返回。
//
// 用法：
//   node scripts/verify-onboarding-guide-hints.mjs                          # 验真实页面
//   ONBOARD_HTML=tmp/_mut.html node scripts/verify-onboarding-guide-hints.mjs  # 验变异体（自证鉴别力）
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
  return {
    id, hidden: null, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { return c; }, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
globalThis.__els = __els;
globalThis.document = {
  getElementById: (id) => (__els[id] ||= mkEl(id)),
  createElement: (t) => mkEl(t), querySelector: () => null, querySelectorAll: () => [],
};
globalThis.location = { href: '', pathname: '/onboarding-guide.html', search: '' };
globalThis.window = globalThis;
`;

function build({ credsResp, expectUrl }) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL('_onboard_hint.mjs', dir);
  writeFileSync(file, [
    '// 自动生成（探针产物，勿手改）',
    'globalThis.fetch = async (url) => {',
    `  if (String(url).includes(${JSON.stringify(expectUrl)})) return { ok: true, status: 200, json: async () => (${JSON.stringify(credsResp)}) };`,
    '  return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) };',
    '};',
    STUB,
    script,
    'globalThis.__page = { els: __els };',
  ].join('\n'), 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now());
}

// 场景执行：填必填字段 → 触发真实 doVerify
async function runVerify({ credsResp, fill, expectUrl = '/api/channels/connect' }) {
  await build({ credsResp, expectUrl });
  const els = globalThis.__els;
  // 元素是懒创建的（页面只在 collect() 里取）→ 先经 document.getElementById 预热出桩对象再填值
  for (const [id, v] of Object.entries(fill)) globalThis.document.getElementById(id).value = v;
  // ⚠ 必须先点「下一步」（to2）让 collected 被 collect() 填充——直接点「验证」时 collected 恒为空，
  //   会静默走「未填写任何通道」分支（探针自身踩到的假红：不是页面坏，是没按真实操作顺序驱动）。
  const to2 = els['to2']?.onclick;
  if (typeof to2 === 'function') to2();
  const h = els['doVerify']?.onclick;
  if (typeof h !== 'function') { console.log('  🔴 doVerify 未绑定 handler'); failures++; return ''; }
  try {
    await h();
  } catch (e) {
    console.log('  🔴 handler 抛错（页面在真实浏览器同样会中断）:', e?.message || e);
    failures++;
  }
  const out = els['verifyOut'].textContent || '';
  if (!out) console.log('  ↳ 调试：verifyOut 为空；handler 存在=', typeof h === 'function');
  return out;
}

console.log('\n场景 A：邮箱 auth_failed（163 真实现场：服务端拒因＝需授权码）');
{
  const out = await runVerify({
    fill: { email: 'watchm@163.com', pass: 'not-a-code' },
    credsResp: { ok: false, error: 'auth_failed', probe: 'imap_login', missing: null, hint: 'A1 NO LOGIN Login error or password error' },
  });
  ok(/auth_failed/.test(out), '如实显示 auth_failed（不粉饰）');
  ok(/Login error or password error/.test(out), '透出服务端原话（用户可判读真因）');
  ok(/客户端授权码/.test(out), '点明真因：163/126/QQ 须用「客户端授权码」——不让人反复改密码');
  ok(/imap\.163\.com/.test(String(JSON.stringify(globalThis.__els['email'])) + out) || /邮箱/.test(out), '该项标注为邮箱通道');
}

console.log('\n场景 B：邮箱探测通过 → 不得出现「授权码」提示（否则是噪音误报）');
{
  const out = await runVerify({
    fill: { email: 'ok@company.com', pass: 'code' },
    credsResp: { ok: true, verified: true, stored: false, probe: 'imap_login' },
  });
  ok(/✅/.test(out), '显示探测通过');
  ok(!/客户端授权码/.test(out), '未误报授权码引导');
}

console.log('\n场景 C：凭据不全（缺 host）→ 显示缺哪个字段，且不得误报为「授权码问题」');
{
  const out = await runVerify({
    fill: { email: 'a@b', pass: 'x' },
    credsResp: { ok: false, error: 'credentials_incomplete', probe: 'imap_login', missing: ['host'], hint: null },
  });
  ok(/credentials_incomplete/.test(out), '如实显示 credentials_incomplete');
  ok(/缺：host/.test(out), '显示缺哪个字段（用户知道改哪里）');
  ok(!/客户端授权码/.test(out), '缺字段 ≠ 授权码问题（两种失败不可混为一谈）');
}

console.log('\n场景 D：非邮箱通道 auth_failed → 不得套用邮箱授权码话术（跨通道误报）');
{
  const out = await runVerify({
    fill: { cal: 'https://caldav.example.com/dav/' },
    credsResp: { ok: false, error: 'auth_failed', probe: 'caldav_propfind', missing: null, hint: 'http 401' },
  });
  ok(/auth_failed/.test(out), '日历通道如实显示 auth_failed');
  ok(!/客户端授权码/.test(out), '日历失败不套邮箱话术（引导必须按通道区分）');
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n🔴 ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
