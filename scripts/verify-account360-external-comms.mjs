// scripts/verify-account360-external-comms.mjs — account-360「外部沟通维度」区块的**运行期**验证器
// 为什么需要：静态 grep 能证明"代码里有这个区块"，但证明不了**它在真实执行路径上被渲染出来**
//   （TDZ / 作用域 / 选择器 / 分支条件错一处，grep 全绿而页面永远空白——本项目头号「假绿+死区」形态）。
// 做法：抽出 src/web/account-360.html 的**内联模块脚本**，剥掉两行 import，注入最小 DOM 桩与 api 桩，
//   落入 tmp/ 后真实 import 执行；断言 profileRoot 里真的出现了 .pg-extcomms-card。
// 零新依赖（仓库 vitest 跑 node env，无 jsdom），不触网、不连库。
//
// 用法：
//   node scripts/verify-account360-external-comms.mjs              # 验真实页面
//   A360_HTML=tmp/_mut.html node scripts/verify-...mjs             # 验变异体（自证鉴别力）
//
// 鉴别力自检（2026-09-17 实测，变异体在 tmp/ 生成、不触碰仓库文件）：
//   ① 移除区块注入（区块没接线）      → 🔴 15 项失败
//   ② 只读 3 键（漏读 wechat_intents）→ 🔴  3 项失败
//   ③ 去掉 esc（外部内容裸输出）      → 🔴  2 项失败   ← 场景 C 专为堵住此盲区而加
//   ⚠ 教训：③ 最初**绿**——「断言源码含 esc(x)」只是静态层，运行期不转义照样通过。
//     故本校验器必须保留场景 C（XSS 载荷 → 断言 &lt; 转义 + 无裸标签）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
// 变异验证支持：A360_HTML 指向页面副本 → 不触碰仓库文件即可自证探针鉴别力（判据⑬）
const htmlRel = process.env.A360_HTML || 'src/web/account-360.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
console.log('被测页面:', htmlRel);

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ✅ ' : '  🔴 ') + msg); if (!cond) failures++; }

// ── 抽取内联模块脚本（第一个 <script type="module"> 无 src 的那个）──
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('🔴 未找到内联模块脚本'); process.exit(1); }
const pageCode = m[1]
  .replace(/^\s*import[^\n]*\n/gm, '')   // 剥 import（页面依赖 /portal/api.js、/portal/layout.js）
  .replace(/injectLayout\(\);/, '');     // 页面外壳注入（探针不验壳）

// ── 最小 DOM 桩 ──
const DOM_STUB = `
function mkEl(tag = 'div') {
  const el = {
    tagName: tag, className: '', innerHTML: '', textContent: '', hidden: false, value: '', children: [],
    dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}
const __els = { 'profile-root': mkEl(), 'insight-root': mkEl(), 'history-root': mkEl(), 'account-select': mkEl() };
globalThis.document = {
  getElementById: (id) => __els[id] || null,
  createElement: (t) => mkEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.location = { search: globalThis.__SEARCH, pathname: '/account-360.html', href: 'http://localhost/account-360.html' + globalThis.__SEARCH };
globalThis.history = { replaceState() {} };
globalThis.injectLayout = () => {};
globalThis.api = globalThis.__api;
globalThis.__els = __els;
`;

// ── api 桩：按 URL 分派 ──
function apiStub(accountPayload) {
  return `globalThis.__api = async (url) => {
    if (url.startsWith('/api/particles?type=CRM_ACCOUNT')) {
      return { items: [{ id: 'acc-1', slug: 'probe-acc', type: 'CRM_ACCOUNT', title: '探针客户', payload: ${JSON.stringify(accountPayload)} }] };
    }
    if (url.startsWith('/api/page/account-360')) return { html: '<div class="pg-profile">画像正文</div>' };
    return {};
  };`;
}

async function runCase(name, accountPayload) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL(`_a360_runtime_${name}.mjs`, dir);
  const body = [
    '// 自动生成（探针产物，勿手改）',
    `globalThis.__SEARCH = '?id=probe-acc&tab=profile';`,
    apiStub(accountPayload),
    DOM_STUB,
    'await (async () => {',
    pageCode,
    '})();',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  await import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now());
}

function cardIn(root) {
  return (root.children || []).find((c) => c.className === 'pg-extcomms-card') || null;
}

// ── 场景 A：账户有 4 通道 enrichment（应渲染时间线）──
console.log('场景 A：有通道信号 → 渲染时间线');
await runCase('withdata', {
  name: '探针客户', domains: ['probe.com'],
  enrichment: {
    email_intent: [{ external_id: 'e1', kind: 'contact_change', ts: '2026-09-17T08:00:00Z', subject: '报价沟通', domain: 'probe.com', participants: ['buyer@probe.com'] }],
    schedule: [{ external_id: 'c1', kind: 'meeting_confirmed', ts: '2026-09-18T10:00:00Z', subject: '现场拜访', domain: 'probe.com', participants: [] }],
    meeting_intents: [{ external_id: 'm1', kind: 'meeting_confirmed', ts: '2026-09-19T14:00:00Z', subject: '技术交流纪要', domain: 'probe.com', participants: [] }],
    wechat_intents: [{ external_id: 'w1', kind: 'contact_change', ts: '2026-09-20T09:00:00Z', subject: '企微群消息', domain: 'probe.com', participants: [] }],
  },
});
{
  const card = cardIn(globalThis.__els['profile-root']);
  ok(!!card, '画像区真实挂载了 .pg-extcomms-card（运行期，非 grep）');
  const h = card ? card.innerHTML : '';
  ok(h.includes('外部沟通维度'), '标题渲染');
  ok(h.includes('4 条'), '条数＝4（四键合并）');
  ok(['邮件', '日程', '会议', '企业微信'].every((x) => h.includes(x)), '四个通道标签全部出现');
  ok(h.includes('报价沟通') && h.includes('现场拜访') && h.includes('技术交流纪要') && h.includes('企微群消息'), '四条主题全部渲染');
  ok(h.indexOf('企微群消息') < h.indexOf('报价沟通'), '时间倒序（2026-09-20 在 08-17 之前）');
  ok(h.includes('buyer@probe.com'), '参与者渲染');
  ok(h.includes('不写回客户侧系统'), '只读语义明示');
}

// ── 场景 B：账户无 enrichment（应渲染空态，且空态可行动）──
console.log('场景 B：无通道信号 → 空态非死区');
await runCase('empty', { name: '探针客户', domains: ['probe.com'] });
{
  const card = cardIn(globalThis.__els['profile-root']);
  ok(!!card, '空态同样挂载了 .pg-extcomms-card（区块不因无数据而消失）');
  const h = card ? card.innerHTML : '';
  ok(h.includes('外部沟通维度'), '标题渲染');
  ok(h.includes('暂无外部沟通信号'), '说明"为什么空"');
  ok(h.includes('不影响核心功能'), '说明未接入不阻塞核心功能');
  ok(h.includes('/channel-config.html') && h.includes('/onboarding-guide.html'), '给出可行动入口（配置台/向导）');
}

// ── 场景 C：XSS 载荷（外部内容是**不可信输入**，必须转义后才进 innerHTML）──
// 变异验证暴露：仅断言源码含 `esc(x)` 属静态层，运行期不转义照样绿 ⇒ 本场景补运行期鉴别力。
console.log('场景 C：外部内容含注入载荷 → 必须被转义');
await runCase('xss', {
  name: '探针客户', domains: ['probe.com'],
  enrichment: {
    email_intent: [{
      external_id: 'x1', kind: 'contact_change', ts: '2026-09-21T08:00:00Z',
      subject: '<img src=x onerror=alert(1)>报价',
      domain: 'probe.com', participants: ['<script>alert(2)</script>@probe.com'],
    }],
  },
});
{
  const card = cardIn(globalThis.__els['profile-root']);
  const h = card ? card.innerHTML : '';
  ok(!!card && h.includes('&lt;img'), '主题被转义（&lt;img 出现）');
  ok(!h.includes('<img src=x'), '原始标签未裸输出（无 <img src=x）');
  ok(!h.includes('<script>'), '参与者中的 <script> 未裸输出');
}

// ── 场景 D：防双份守卫（renderer 已输出同 class → 不再叠加）──
console.log('场景 D：防双份（区块已存在时不重复注入）');
{
  // 直接单测守卫表达式的语义：querySelector 命中 → 不再 append
  const guard = /if\s*\(!profileRoot\.querySelector\('\.pg-extcomms-card'\)\)\s*\{\s*profileRoot\.appendChild\(renderExternalComms\(cur\)\);/.test(pageCode);
  ok(guard, '守卫表达式存在且形式正确（renderer 与 JS 注入二选一）');
}

console.log(failures ? `\n🔴 ${failures} 项失败` : '\n✅ 全部通过（区块在真实执行路径上被渲染）');
process.exitCode = failures ? 1 : 0;
