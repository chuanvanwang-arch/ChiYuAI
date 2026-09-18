// scripts/verify-channel-config-feedback.mjs — 通道配置台「点确认接入到底有没有反应」的运行期验证器
//
// 为什么需要（2026-09-18 用户实报缺陷）：
//   原实现把成功/失败/校验错误**一律**写进 `<p class="hint" id="out">`（灰字、与周围静态说明同色同字号），
//   且该行实机落在视口底边（y=719 / 视口高 720）⇒ 用户点了「确认接入」后唯一的变化是一行
//   **与说明文字无法区分的灰字**；重复点击文本一字不变 ⇒ 用户读作「点了就没有反应了」。
//   `test/web/channelConfigPage.test.js` 是**静态契约测试**（grep 字符串），它当时全绿——
//   绿在「页面上有 /api/channels/connect 这个串」，死在「用户点了看不见任何东西」。
//   故本探针**真跑**页面 onclick（抽 <script type="module"> + DOM 桩 + fetch 桩），断言**渲染结果**。
//
// 判据（每条都能被变异体打红）：
//   ① 校验失败（非法 JSON / 缺字段）⇒ 状态区 show+err、错在**凭据框原位**标红、光标聚焦该框、**不发请求**；
//   ② 提交中 ⇒ 状态区 busy 且按钮 disabled + 文案「提交中…」（点了立刻有反馈）；
//   ③ 任何一次点击后，状态区都必须处于 show 态（不存在「点了什么都不变」的分支）；
//   ④ 后端返回失败 ⇒ err 态 + 按钮恢复可点 + 凭据框**不清空**（便于就地改错）；
//   ⑤ 成功 ⇒ ok 态 + 凭据框清空（明文不驻留 DOM）；
//   ⑥ 多行引导（guidedHint 的「↳ …」）落在 pre-wrap 容器里，不被压成一行。
//
// 用法：
//   node scripts/verify-channel-config-feedback.mjs              # 验真实页面
//   CHANNEL_HTML=tmp/_mut.html node scripts/verify-channel-config-feedback.mjs   # 验变异体（自证鉴别力）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const htmlRel = process.env.CHANNEL_HTML || 'src/web/channel-config.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
console.log('被测页面:', htmlRel);

let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  🔴 ' + msg); } };

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('🔴 未找到 <script type="module">（锚点失效）'); process.exit(1); }
// 去掉真实 import（/portal/layout.js、/portal/api.js 需服务端与浏览器），改由桩提供
const script = m[1].split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n');
if (/^\s*import\s/m.test(script)) { console.log('🔴 import 未剥离干净'); process.exit(1); }

// ── DOM 桩：够页面用即可（className / textContent / value / focus / disabled / scrollIntoView）──
const STUB = `
const __els = {};
globalThis.__focused = null;
globalThis.__scrolled = [];
function mkEl(id) {
  const el = {
    id, hidden: null, value: '', textContent: (globalThis.__seed || {})[id] || '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    className: '', _cls: {},
    classList: {
      add(c) { el._cls[c] = 1; }, remove(c) { delete el._cls[c]; }, contains(c) { return !!el._cls[c]; },
      toggle(c, on) { if (on === undefined ? !el._cls[c] : on) el._cls[c] = 1; else delete el._cls[c]; },
    },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { return c; }, querySelector() { return null; }, querySelectorAll() { return []; },
    focus() { globalThis.__focused = el.id; },
    scrollIntoView() { globalThis.__scrolled.push(el.id); },
  };
  return el;
}
globalThis.__els = __els;
globalThis.document = {
  getElementById: (id) => (__els[id] ||= mkEl(id)), activeElement: { id: null },
  createElement: (t) => mkEl(t), querySelector: () => null, querySelectorAll: () => [],
};
globalThis.location = { href: '', pathname: '/channel-config.html', search: '' };
globalThis.window = globalThis;
globalThis.URLSearchParams = URLSearchParams;
`;

function build(tag) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL(`_channel_feedback_${tag}.mjs`, dir);
  // 按钮初始文案来自**页面标记**（不来自脚本）——桩若不播种，`btn.textContent` 起点为空，
  //   「提交后还原文案」就会被替身形状掩盖（假红/假绿的同一族：替身 ≠ 真实初始态）。
  const seed = {};
  for (const m2 of html.matchAll(/<button[^>]*\bid="([\w-]+)"[^>]*>([^<]*)</g)) seed[m2[1]] = m2[2].trim();
  writeFileSync(file, [
    '// 自动生成（探针产物，勿手改）',
    `globalThis.__seed = ${JSON.stringify(seed)};`,
    'globalThis.__reqs = [];',
    'globalThis.__nextFetch = null;   // 由用例设置：() => Promise<response>',
    'globalThis.fetch = (url, init) => {',
    '  globalThis.__reqs.push({ url: String(url), init });',
    '  return globalThis.__nextFetch ? globalThis.__nextFetch() : Promise.resolve({ ok: true, json: async () => ({ ok: true, channels: [] }) });',
    '};',
    'globalThis.__getCalls = [];',
    'const injectLayout = () => {};',
    'const get = async (u) => { globalThis.__getCalls.push(u); return { channels: [] }; };',
    STUB, script,
  ].join('\n'), 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now() + '_' + tag);
}

const tick = (n = 3) => new Promise((r) => setTimeout(r, n));

// 准备：装模块 → 填表 → 返回页面桩句柄
//   ⚠ 元素是**懒创建**的（页面只在自己代码里取过的 id 才会出现桩对象），故一律经 getElementById 取，
//     不能直接下标访问 `__els['f-label']`——否则探针自身先崩（假红）。
async function prep(tag, { kind = 'generic-email', label = 'wangchuan08@inspur.com', cred = '', trust = 'L3' } = {}) {
  globalThis.__reqs = [];
  await build(tag);
  await tick();
  const el = (id) => globalThis.document.getElementById(id);
  el('f-kind').value = kind;
  el('f-label').value = label;
  el('f-trust').value = trust;
  el('f-cred').value = cred;
  return { el };
}
const clickConnect = ({ el }) => el('connect').onclick();

console.log('\n【① 非法 JSON（用户截图同形态：把密码填进 JSON 框）】');
{
  const P = await prep('badjson', { cred: 'admin123' });
  const el = P.el;
  await clickConnect(P);
  await tick();
  ok(globalThis.__reqs.length === 0, '不发请求（本地拦下，省一次必然被拒的往返）');
  ok(/\bshow\b/.test(el('out').className) && /\berr\b/.test(el('out').className), `状态区 show+err 态（实际 "${el('out').className}"）`);
  ok(/\berr\b/.test(el('cred-hint').className), `错误提示写在凭据框**原位**（#cred-hint 实际 "${el('cred-hint').className}"）`);
  ok(el('f-cred').className === 'bad', `出错的凭据框被标红（class="${el('f-cred').className}"）`);
  ok(globalThis.__focused === 'f-cred', '光标聚焦到出错的凭据框（用户视线与改错点同一处）');
  ok(/host/.test(el('cred-hint').textContent) && /\{/.test(el('cred-hint').textContent), '给出本通道必填键与可照抄示例（可执行，不是一句「非法 JSON」）');
  ok(el('out').textContent.trim().length > 0, `状态区有文案：${JSON.stringify(el('out').textContent.slice(0, 40))}`);
  ok(globalThis.__scrolled.includes('out'), '状态区出现后滚入视野（不再落在视口底边外）');
  // 同形态重复点击：状态必须被**重新施加**（不是「第二次点了什么都不发生」）
  el('out').className = '';
  await clickConnect(P);
  await tick();
  ok(/\berr\b/.test(el('out').className), '重复点击同样失败时，状态区被重新施加（不会「点了没反应」）');
}

console.log('\n【② 合法 JSON 但缺必填字段】');
{
  const P = await prep('missing', { cred: JSON.stringify({ user: 'a@b.com' }) });
  const el = P.el;
  await clickConnect(P);
  await tick();
  ok(globalThis.__reqs.length === 0, '不发请求');
  ok(/\berr\b/.test(el('out').className) && /host/.test(el('cred-hint').textContent), '状态区报错 + 原位点出缺哪个字段');
  ok(el('f-cred').className === 'bad' && globalThis.__focused === 'f-cred', '标红 + 聚焦同一处');
}

console.log('\n【③ 提交中：点了立刻有反馈 + 按钮不可重复点】');
{
  const P = await prep('busy', { cred: JSON.stringify({ host: 'imap.x.test', user: 'a@b.com', pass: 'p' }) });
  const el = P.el;
  let release;
  globalThis.__nextFetch = () => new Promise((r) => { release = () => r({ ok: true, json: async () => ({ ok: false, error: 'connect_failed:ENOTFOUND' }) }); });
  const p = clickConnect(P);
  await tick();
  ok(/\bbusy\b/.test(el('out').className), `提交中状态区为 busy（实际 "${el('out').className}"）`);
  ok(el('connect').disabled === true, '提交中按钮 disabled（防重复提交）');
  ok(el('connect').textContent === '提交中…', `按钮文案立即变化（实际 "${el('connect').textContent}"）`);
  ok(globalThis.__reqs.length === 1, '恰好发出 1 次请求');
  // 提交中重复点击：不得叠加请求
  await clickConnect(P);
  ok(globalThis.__reqs.length === 1, '提交中重复点击不叠加请求');
  release();
  await p; await tick();

  console.log('\n【④ 后端失败：err 态 + 按钮恢复 + 凭据保留可改错】');
  ok(/\berr\b/.test(el('out').className), '失败 → err 态');
  ok(/接入失败/.test(el('out').textContent), `失败文案可见：${JSON.stringify(el('out').textContent.slice(0, 50))}`);
  ok(el('connect').disabled === false, '按钮恢复可点（不变成砖）');
  ok(el('connect').textContent === '确认接入', `按钮文案还原（实际 "${el('connect').textContent}"）`);
  ok(el('f-cred').value !== '', '失败时凭据框**保留**输入（便于就地改错，不必重敲）');
}

console.log('\n【⑤ 成功：ok 态 + 明文不驻留 DOM】');
{
  const P = await prep('okcase', { cred: JSON.stringify({ host: 'imap.x.test', user: 'a@b.com', pass: 'p' }) });
  const el = P.el;
  globalThis.__nextFetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true, stored: true, hint: '首次只读（L1）' }) });
  await clickConnect(P);
  await tick(6);
  ok(/\bok\b/.test(el('out').className), `成功 → ok 态（实际 "${el('out').className}"）`);
  ok(/已提交/.test(el('out').textContent), `成功文案：${JSON.stringify(el('out').textContent.slice(0, 40))}`);
  ok(el('f-cred').value === '', '成功后清空凭据框（明文不驻留 DOM）');
}

console.log('\n【⑥ 反馈区语义与样式锚点（否则「可见」会在下次改版悄悄退化）】');
{
  ok(/id="out"[^>]*role="status"/.test(html) || /role="status"[^>]*id="out"/.test(html), '#out 是 role=status（无障碍读屏可播报）');
  ok(/aria-live="polite"/.test(html), '#out 带 aria-live（状态变化被播报）');
  ok(/white-space:\s*pre-wrap/.test(html), '状态区 pre-wrap（多行「↳ 下一步」不被压成一行）');
  ok(/\.status\.err[^}]*--err/.test(html), '.status.err 走 --err 令牌（与灰字说明可区分）');
  ok(/\.status\.err[^}]*--err-soft/.test(html), 'err 底走 --err-soft 令牌（不自带 rgba 色值）');
  ok(!/id="out"[^>]*class="hint"/.test(html), '#out 不再沿用 .hint（灰字＝静态说明的样式）');
  ok(/button\[disabled\]/.test(html), '按钮 disabled 有可见样式（否则「已禁用」看起来仍可点）');
}

console.log(`\n${fail === 0 ? '✅' : '🔴'} 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
