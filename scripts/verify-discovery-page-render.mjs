// scripts/verify-discovery-page-render.mjs — 线索发现工作台「看得懂/渲染得出来」的运行期验证器
//
// 为什么需要（2026-09-18 用户实报「看不懂」，附截图圈出候选池表头 + 「暂无已评分候选」）：
//   本页有两处**响应形状错配 / 哑空态**，静态契约测试全绿也发现不了：
//   ① 候选池空态只写「暂无已评分候选」：不区分「鉴权失败」与「真的 0 条」，不解释数据从哪来、下一步做什么；
//      且两张表**未套 common.css 的 .table 类** ⇒ 空表时 5 个表头挤成一行文字，被读成一句乱话。
//   ② 定向拓客读**顶层** `data.items`，而后端信封是 `{ok, data:{items,error,...}}`（executor.js:233 + routes.js:3718）
//      ⇒ items 恒 undefined ⇒ **即使数据源真返回字段也永远渲染不出来**，draft_id 恒显示 '-'。
//      同库正确范式见 lead-pool.html:263 `(data.data || data)`。
//   实测抓包证据：响应 `{"ok":true,"data":{"draft_id":"069de8e3-…","provider":"gaode","count":0,"items":[]}}`
//      而页面显示 `画像字段 0 项（draft_id=-）`。
//
// 判据（每条都能被变异体打红）：
//   ① 候选池真 0 条 ⇒ 空态**自解释**（含数据来源字段名 / 与定向拓客的区别 / 触发入口链接）；
//   ② 候选池鉴权/网络失败 ⇒ 文案与「真的 0 条」**可区分**（不得伪装成空数据）；
//   ③ 两张表带 `.table` 类（表头有 padding/分行，不塌缩成一行文字）；
//   ④ 画像有数据（正确信封 data.data）⇒ **必须渲染出行**（这是本页恒空的核心回归闸）；
//   ⑤ 画像 0 条 ⇒ 归因到「源已调用但未返回」，而不是「未执行」；
//   ⑥ 后端返回 error ⇒ 显式暴露「未执行」+ 错误码（不得伪装成「预期 fail-open」）；
//   ⑦ draft_id 取自 `data.data`（不得恒为 '-'）。
//
// 用法：
//   node scripts/verify-discovery-page-render.mjs                        # 验真实页面
//   DISC_HTML=tmp/_mut.html node scripts/verify-discovery-page-render.mjs # 验变异体（自证鉴别力）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const htmlRel = process.env.DISC_HTML || 'src/web/discovery.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
console.log('被测页面:', htmlRel);

let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  🔴 ' + msg); } };

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('🔴 未找到 <script type="module">（锚点失效）'); process.exit(1); }
const script = m[1].split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n');
if (/^\s*import\s/m.test(script)) { console.log('🔴 import 未剥离干净'); process.exit(1); }

const STUB = `
const __els = {};
function mkEl(id) {
  const el = {
    id, hidden: null, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    className: '', _h: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(t, fn) { el._h[t] = fn; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { return c; }, querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, scrollIntoView() {},
  };
  return el;
}
globalThis.__els = __els;
globalThis.document = {
  getElementById: (id) => (__els[id] ||= mkEl(id)), activeElement: { id: null },
  createElement: (t) => mkEl(t), querySelector: () => null, querySelectorAll: () => [],
};
globalThis.location = { href: '', pathname: '/discovery.html', search: '' };
globalThis.window = globalThis;
globalThis.alert = (s) => { globalThis.__alert = String(s); };
globalThis.localStorage = { getItem: () => 'stub-token', setItem() {}, removeItem() {}, clear() {} };
// 预创建页面脚本会触碰的元素（桩是懒创建的，探针若直接下标访问会先崩 → 假红）；
// 并从 HTML 播种 <select> 默认选中值与 hidden 初值 —— 替身形状必须与真实页面初始态一致。
for (const id of ['candidate-tbody','dpName','dpDomain','dpEmail','dpProvider','dpSearch','dpTbody','dpStatus','dpResult']) __els[id] = mkEl(id);
globalThis.__seed = globalThis.__seed || {};
for (const [id, v] of Object.entries(globalThis.__seed)) __els[id].value = v;
__els['dpResult'].hidden = true;
`;

function build(tag) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL(`_disc_render_${tag}.mjs`, dir);
  // 播种 <select id="dpProvider"> 的**真实默认选中值**（首个 option），否则桩里是空串，
  //   会把「默认项语义」这类缺陷遮掉（替身形状 ≠ 真实初始态 = 假绿同族）。
  const sel = html.match(/<select id="dpProvider">[\s\S]*?<option value="([^"]*)"/);
  const seed = { dpProvider: sel ? sel[1] : '' };
  writeFileSync(file, [
    '// 自动生成（探针产物，勿手改）',
    `globalThis.__seed = ${JSON.stringify(seed)};`,
    'globalThis.__reqs = [];',
    'globalThis.__alert = null;',
    '// ⚠ 不得无条件重置探针输入：主脚本在 build() 前设好的 __nextGet/__nextFetch 会被抹掉，',
    '//   导致「失败分支」实际跑成「空数据分支」—— 探针自身制造假红/假绿的经典形态。',
    'if (globalThis.__nextGet === undefined) globalThis.__nextGet = null;',
    'if (globalThis.__nextFetch === undefined) globalThis.__nextFetch = null;',
    'globalThis.fetch = () => { globalThis.__reqs.push(1); return globalThis.__nextFetch(); };',
    'const injectLayout = () => {};',
    'const get = async (u) => (globalThis.__nextGet ? globalThis.__nextGet() : { items: [] });',
    STUB, script,
  ].join('\n'), 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now() + '_' + tag);
}

const tick = (n = 4) => new Promise((r) => setTimeout(r, n));
const resp = (body) => Promise.resolve({ ok: true, json: async () => body });
const candTbody = () => globalThis.__els['candidate-tbody']?.innerHTML || '';
const dpTbody = () => globalThis.__els['dpTbody']?.innerHTML || '';
const dpStatus = () => globalThis.__els['dpStatus']?.textContent || '';
// 剥注释/脚本/样式/标签 → 纯可见文本（用于「文案预算」闸）
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ── ⓪ 文案预算：把「干净」变成可回归判据 ─────────────────────────────
// 2026-09-18 用户二次反馈「显示了一堆说明，完全看不懂，这个页面需要干净点，无用信息删除」。
// 事实：上一轮为治「看不懂」补的自解释文案（3 条 triggerBar 说明 + 定向拓客 6 句 + 空态 4 条 bullet）
//   总量 ≈360 字，属**把机制原理当用户信息常驻显示**；且三条说明绑定的 div 全仓零 JS 消费，
//   只能写死假值（写死的数据源名会与配置中心真实配置相互撒谎）。改判据：文案有**预算**。
console.log('\n【⓪ 页面文案预算（防「一堆说明」回流）】');
{
  const text = strip(html);
  ok(text.length <= 160, `常驻可见文案 ≤160 字（实际 ${text.length} 字）`);
  const tb = (html.match(/<section id="triggerBar"[\s\S]*?<\/section>/) || [''])[0];
  ok(!/class="sub"/.test(tb), 'triggerBar 内无解释性 .sub 行（本轮删除的三条说明不得回流）');
  ok(!/id="icp-summary"|id="data-source-badges"|id="last-run-at"/.test(html),
    '三个零消费说明性死元素（icp-summary / data-source-badges / last-run-at）不得回流');
  ok(!/fail-open/.test(strip(html)), '常驻文案不解释内部容错机制（fail-open 属工程事实，非用户信息）');
}

// ── ⓪b 类名有效性：用了 CSS 里不存在的类 = 零样式静默失效 ─────────────────
// 本轮真根因（用户截图「挤成一坨」）：页面用 .pg-card / .pg-title / .toolbar / .sub 四个类，
//   实测 tokens.css + common.css + page.css **均无定义**（站点里是 .card/.panel/.sect-title/.page-sub，
//   而 .toolbar 是全站页面级约定、须页内声明）。类名写错没有任何报错 —— 测试全绿、页面塌陷，
//   属「静默失效」：断言必须落在**类定义是否存在**上，而非「页面里出现了某个类名字符串」。
console.log('\n【⓪b 类名有效性（防「用了不存在的类」的零样式静默失效）】');
{
  // ⚠ 两条纪律（否则判据自身假绿）：
  //   ① 只扫**本页实际引用的**样式表 + 页内 <style>（扫全站会把本页拿不到的类算成"已定义"）；
  //   ② 必须**剥离 CSS 注释** —— 注释里出现的类名不是定义（common.css:119 的「描述行(.sub)已移除」若算数，
  //      `.sub` 就会被判为有效类，而它在本页是零样式死类）。
  let css = '';
  const refs = [...html.matchAll(/<link[^>]+href="\/portal\/([^"]+\.css)"/g)].map((m) => m[1]);
  for (const f of refs) {
    try { css += readFileSync(new URL('src/web/' + f, ROOT), 'utf8'); } catch { /* 缺文件不致命 */ }
  }
  const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  css = stripCssComments(css);
  const inline = stripCssComments((html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '');
  // 只认「类选择器自身被定义」：.class 之后必须紧跟 , { : . [（`\s*` 允许「td.empty-cell {」这种）
  //   排除 `.toolbar input{…}` 这类后代选择器 —— 它给内部元素加样式，不等于定义了 .toolbar 本身。
  const SEL = /\.([a-zA-Z][\w-]*)(?=\s*[,{:.\[])/g;
  const defined = new Set();
  for (const m of css.matchAll(SEL)) defined.add(m[1]);
  for (const m of inline.matchAll(SEL)) defined.add(m[1]);
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c);
  }
  // 白名单：C2 抽屉尚未接线，样式待随功能落地（本轮未动，非本次缺陷）
  const KNOWN_UNSTYLED = new Set(['drawer']);
  const missing = [...used].filter((c) => !defined.has(c) && !KNOWN_UNSTYLED.has(c));
  ok(missing.length === 0, `所有 class 均有样式定义（未定义：${JSON.stringify(missing)}）`);
  ok(used.has('panel') && used.has('sect-title'), '分区改用站点单源组件 .panel + .sect-title');
  ok(![...used].some((c) => ['pg-card', 'pg-title'].includes(c)), '.pg-card / .pg-title（全站无定义）不得回流');
}

// ── ① 候选池：真 0 条 ⇒ 自解释空态（但须在预算内）──────────────────
console.log('\n【① 候选池真 0 条 → 空态必须自解释，且精简】');
globalThis.__nextGet = async () => ({ items: [] });
await build('empty'); await tick();
{
  const h = candTbody();
  ok(/候选池暂无/.test(h), '空态文案已给出（非静默空表）');
  ok(/线索发现|AI 对话/.test(h), '一句话说明数据从哪来（用户可读，不复述内部技能名 discovery-run）');
  ok(/href="\/buddy"/.test(h), '给出可点的触发入口（不是只报空）');
  ok(strip(h).length <= 60, `空态文案 ≤60 字（实际 ${strip(h).length} 字）— 防再次膨胀成说明书`);
  ok(/候选池读取失败/.test(candTbody()) === false, '真 0 条不被误判为失败');
  ok(/不入候选池/.test(html), '「定向拓客不产候选」在定向拓客区**就近**声明（替代空态里的长段澄清）');
}

// ── ② 候选池：取数失败 ⇒ 与「真的 0 条」可区分 ─────────────────────
console.log('\n【② 候选池取数失败 → 必须区别于空数据】');
globalThis.__nextGet = async () => { throw new Error('auth required'); };
await build('err'); await tick();
{
  const h = candTbody();
  ok(/候选池读取失败/.test(h), '显式报「读取失败」（原实现 render([]) 伪装成空数据）');
  ok(/auth required/.test(h), '带上真实原因（不再吞错误）');
  ok(/候选池暂无/.test(h) === false, '失败态与空数据态文案不混用');
}

// ── ③ 表样式类（表头不塌缩成一行文字）+ 表头可读性 ─────────────────
console.log('\n【③ 表格样式类 + 表头可读性】');
{
  ok(/id="candidate-table"[^>]*class="table"|class="table"[^>]*id="candidate-table"/.test(html), 'candidate-table 套了 .table');
  ok(/id="dpTable"[^>]*class="table"|class="table"[^>]*id="dpTable"/.test(html), 'dpTable 套了 .table');
  ok(/empty-cell/.test(html), '空态使用左对齐多行样式类（承载「为什么空 + 去哪触发」）');
  // 用户上一份截图圈出的正是表头「公司 ICP 适配分 信号 why_narrative 来源」—— why_narrative 是内部字段名。
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1].trim()).filter(Boolean);
  ok(!heads.some((t) => /[a-z]_[a-z]/i.test(t)), `表头用中文而非内部字段名（实际 ${JSON.stringify(heads)}）`);
}

// ── ④ 画像有数据（正确信封）⇒ 必须渲染出行 ───────────────────────
console.log('\n【④ 画像返回 1 条（信封 data.data）→ 必须渲染出该行】');
async function clickSearch() {
  globalThis.__els['dpName'].value = '北京海底捞';
  await globalThis.__els['dpSearch']._h.click();
  await tick(8);
}
globalThis.__nextGet = async () => ({ items: [] });
globalThis.__nextFetch = () => resp({ ok: true, data: { provider: 'gaode', kind: 'enrich', count: 1, draft_id: 'd-1', items: [{ field: 'industry', value: '餐饮', confidence: 0.9, provider: 'gaode' }] } });
await build('hit'); await tick();
await clickSearch();
{
  const h = dpTbody();
  ok(/industry/.test(h) && /餐饮/.test(h), '字段行已渲染（原实现恒空 → 这是本页恒空的核心回归闸）');
  ok(/0\.90/.test(h), '置信度渲染');
  ok(/draft_id=d-1/.test(dpStatus()), `draft_id 取自 data.data（实际状态行：${JSON.stringify(dpStatus().slice(0, 60))}）`);
  ok(/未执行/.test(h) === false, '有数据时不显示「未执行」');
}

// ── ⑤ 画像 0 条 ⇒ 归因「源已调用但未返回」 ───────────────────────
console.log('\n【⑤ 画像 0 条（源已调用）→ 归因准确】');
globalThis.__nextGet = async () => ({ items: [] });
globalThis.__nextFetch = () => resp({ ok: true, data: { provider: 'gaode', kind: 'enrich', count: 0, draft_id: 'd-2', items: [] } });
await build('zero'); await tick();
await clickSearch();
{
  const h = dpTbody();
  ok(/源已调用但未返回任何字段/.test(h), '归因到「源调用了但没数据」（而非「未执行」）');
  ok(/GAODE_KEY/.test(h), '给出可执行的凭据指引（高德需环境变量）');
  ok(/未执行/.test(h) === false, '不得与「未执行」混淆');
}

// ── ⑥ 后端 error ⇒ 显式暴露「未执行」 ────────────────────────────
console.log('\n【⑥ 后端 error（ok:true + error）→ 必须显式暴露】');
globalThis.__nextGet = async () => ({ items: [] });
globalThis.__nextFetch = () => resp({ ok: true, data: { provider: 'bogus', kind: 'enrich', count: 0, items: [], error: 'provider_not_enabled_or_unknown' } });
await build('gate'); await tick();
await clickSearch();
{
  const h = dpTbody();
  ok(/未执行/.test(h), '显式说明「本次没有真正发起取数」');
  ok(/provider_not_enabled_or_unknown/.test(h), '暴露后端错误码（不再吞成「预期 fail-open」）');
  ok(/预期 fail-open；/.test(h) === false || /未执行/.test(h), '不与「预期 fail-open」空态混同');
}

// ── ⑦ 下拉默认项不得是空值（空串恒 provider_not_enabled_or_unknown）──
console.log('\n【⑦ 数据源下拉默认值】');
{
  const noEmpty = !/<option value="">/.test(html);
  ok(noEmpty, '下拉无 value="" 选项（后端 allowIds:[provider] 精确匹配，空串必然解析失败）');
  ok(/<option value="gaode"/.test(html), 'gaode 作为首个可选项（默认选中）');
}

console.log(`\n===== 探针结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
