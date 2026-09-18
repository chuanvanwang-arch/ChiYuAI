// scripts/verify-crm-sync-console-render.mjs — CRM 同步配置页「UI 合规 + 渲染得出来 + 保存不破坏配置」的运行期验证器
//
// 为什么需要（2026-09-18 用户截图圈出黄色说明块，要求「新增页面必须使用项目 UI」）：
//   本页是后加的页面，写的时候绕过了 UI 架构级封死（docs/specs/2026-09-05-ui-authoring-rules.md），
//   静态契约测试全绿也发现不了：
//   ① 页内重声明设计系统保留类（.card / .tabs button / table,th,td / input,select）⇒ 改单源组件时本页不跟随；
//   ② 控件全是裸 <input>/<select>/<button>（含 JS 模板串直出）⇒ 违反 R4/R7，pre-commit 被拦；
//   ③ 自造黄色告警块 .note（background:var(--warn) 实底）⇒ 深色专业风里唯一一块亮黄；
//   ④ 引用 var(--warn-ink, #a16207) —— tokens.css 里**没有** --warn-ink，且自带浅色 fallback（铁律禁止）。
//
// 用**现网真实配置**反证出的两个数据级缺陷（GET /api/config/* 实抓，不是推断）：
//   ⑤ `identity` 在 config_store['sync-mappings'] 里是**对象** `{external_id_field:"id"}`
//      （消费方 mapping.js:24 / mount.js:222 读 `def.identity?.external_id_field`），
//      而页面把它当字符串 input 渲染 ⇒ 输入框显示 `[object Object]`（用户截图底部可见），
//      collect() 又把它当字符串写回 ⇒ **点一次「保存当前页」就把 6 条映射的 identity 降级成字符串**，
//      external_id 解析静默回退 row.id（无报错、无告警）——本页最贵的一条。
//   ⑥ 信任档说明写死「默认 L1 只读」，真实 default_level = "L3"（启用回写）⇒ 界面与配置相互撒谎。
//
// 判据（每条都能被变异体打红，见 --selftest）：
//   ⓪  自造黄色告警块已移除（剥注释后无 class="note"；页内 style 无 .note 自身规则）+ 描述行走 R6 位点
//   ⓪b 全控件 crm-*（静态 HTML 段 + JS 模板串双向；type="hidden" 豁免）
//   ⓪c 不在页内重声明设计系统保留类/裸标签（R3）
//   ⓪d 只准用 tokens.css 已定义变量，且不得自带浅色 fallback
//   ⓪e 用到的 class 在本页实际引用的表 + 组件库 + 页内 style 里都有定义（防零样式静默失效）
//   ⓪f 渲染模板 class ↔ collect() 选择器 双向一致（防字段漂移导致保存静默清空）
//   ①  映射配置有真值（6 条 / 30 字段行）⇒ 必须渲染出对应卡片与行（核心回归闸）
//   ②  identity 渲染成标量主键字段，**产物中不得出现 [object Object]**
//   ③  identity 保存写回**对象**形状（保留原对象其他键，仅覆盖 external_id_field）
//   ④  信任档渲染配置真值（label 与三列权限位来自 levels），且不再写死档位说明
//   ⑤  同步状态有游标行 ⇒ 必须渲染；取数失败 ⇒ 与「真的空」可区分；键未播种 ⇒ 不白屏
//   ⑥  禁裸 alert（统一 toast）
//   ⑦  常驻可见文案 ≤160 字（防「一堆说明」回流）
//
// 用法：
//   node scripts/verify-crm-sync-console-render.mjs                          # 验真实页面
//   SYNC_HTML=tmp/_mut.html node scripts/verify-crm-sync-console-render.mjs  # 验变异体
//   node scripts/verify-crm-sync-console-render.mjs --selftest               # 变异自证（证明探针有鉴别力）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);
const htmlRel = process.env.SYNC_HTML || 'src/web/crm-sync-console.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
const readRel = (rel) => { try { return readFileSync(new URL(rel, ROOT), 'utf8'); } catch { return ''; } };
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// ⚠ 否定断言必须先剥注释/脚本/样式：注释里出现的字面量不算「用了」
const stripAll = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const script = (html.match(/<script type="module">([\s\S]*?)<\/script>/) || [, ''])[1];
const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const markupOnly = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

// ── 现网真实配置（2026-09-18 实抓 GET /api/config/sync-mappings|sync-trust、/api/monitor/sync）──
// 替身形状必须与真实返回值一致：「替身形状掩缺陷」是本仓最高频的假绿形态。
const REAL_MAPPINGS = {
  version: 1,
  mappings: [
    { object: 'account', particle_type: 'CRM_ACCOUNT', direction: 'in', identity: { external_id_field: 'id' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'industry', particle: 'industry' }, { external: 'region', particle: 'region' }, { external: 'size', particle: 'size' }, { external: 'source', particle: 'source' }, { external: 'rating', particle: 'rating' }, { external: 'domains', particle: 'domains' }, { external: 'business_title', particle: 'business_title' }] },
    { object: 'lead', particle_type: 'CRM_DEAL', direction: 'in', identity: { external_id_field: 'id' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'stage', particle: 'stage' }, { external: 'owner', particle: 'owner' }, { external: 'source', particle: 'source' }] },
    { object: 'opportunity', particle_type: 'CRM_DEAL', direction: 'in', identity: { external_id_field: 'id' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'stage', particle: 'stage' }, { external: 'amount', particle: 'amount' }, { external: 'account_id', particle: 'account_id' }, { external: 'close_date', particle: 'expected_close_date' }] },
    { object: 'contract', particle_type: 'CRM_CONTRACT', direction: 'in', identity: { external_id_field: 'id' },
      fields: [{ external: 'contract_no', particle: 'contract_no' }, { external: 'amount', particle: 'amount' }, { external: 'start_date', particle: 'start_date' }, { external: 'end_date', particle: 'end_date' }, { external: 'approval_status', particle: 'approval_status' }] },
    { object: 'product', particle_type: 'CRM_PRODUCT', direction: 'in', identity: { external_id_field: 'id' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'unit', particle: 'unit' }, { external: 'category', particle: 'category' }, { external: 'list_price', particle: 'list_price' }] },
    { object: 'quotation', particle_type: 'CRM_QUOTATION', direction: 'in', identity: { external_id_field: 'id' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'amount', particle: 'amount' }, { external: 'valid_until', particle: 'valid_until' }, { external: 'approval_status', particle: 'approval_status' }] },
  ],
};
const REAL_MAPPING_COUNT = 6;
const REAL_FIELD_ROWS = 30; // 8+4+5+5+4+4
const REAL_TRUST = {
  levels: {
    L1: { label: '只读观察期', allow_read: true, allow_upsert: false, allow_writeback: false },
    L2: { label: '批量入库', allow_read: true, allow_upsert: true, allow_writeback: false, decision_granularity: 'per_run' },
    L3: { label: '启用回写', allow_read: true, allow_upsert: true, allow_writeback: true, decision_granularity: 'per_run', first_n_batches_require_human: 3 },
  },
  version: 1, default_level: 'L3', writeback_auto_approved: false, writeback_fields_whitelist: [],
};
const REAL_SYNC = { rows: [], lag: 0, success_rate: 0, conflict: 0, writeback: 0, degraded: 0 };

let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  🔴 ' + msg); } };
console.log('被测页面:', htmlRel);
if (!script) { console.log('🔴 未找到 <script type="module">（锚点失效）'); process.exit(1); }

// ── ⓪ 自造黄色告警块 ────────────────────────────────────────────────
console.log('\n【⓪ 自造黄色告警块（.note 实底）已移除】');
{
  const clean = stripCssComments(html);
  ok(!/class="[^"]*\bnote\b[^"]*"/.test(clean), 'DOM 中无 class="note" 元素（用户截图圈出的亮黄块）');
  ok(!/(^|[},])\s*\.note\s*(?=[,{:])/m.test(stripCssComments(styleBlock)), '页内 style 不再定义 .note 自身规则');
  const head = (html.match(/<header class="page-head">[\s\S]*?<\/header>/) || [''])[0];
  ok(!/page-sub/.test(head), 'R6：页眉内不含描述行（页眉只保留标题）');
  ok(/<\/header>\s*<p\s+class="page-sub"/.test(html), 'R6：描述行以 .page-sub 紧随页眉之后（允许带 title 等属性）');
}

// ── ⓪b 控件必须 crm-*（R4 静态 + R7 动态）──────────────────────────
console.log('\n【⓪b 控件全 crm-*（R4 静态 / R7 动态直出）】');
{
  const BARE = /<(button|input|select|textarea)\b(?![^>]*type="hidden")/gi;
  const markupHits = [...markupOnly.matchAll(BARE)].map((m) => m[1]);
  ok(markupHits.length === 0, `静态 HTML 段无裸控件（实际：${JSON.stringify(markupHits)}）`);
  const tplHits = [...script.matchAll(/<(button|input|select|textarea)\b/gi)].map((m) => m[1]);
  ok(tplHits.length === 0, `JS 模板串无裸控件（R7 历史最大逃逸面；实际：${JSON.stringify(tplHits)}）`);
  for (const tag of ['crm-input', 'crm-select', 'crm-button', 'crm-tabs', 'crm-tab']) {
    ok(html.includes('<' + tag), `使用组件 <${tag}>`);
  }
  ok(/<crm-button id="save" class="btn-primary">/.test(html), '主操作按钮 = crm-button + btn-primary（组件 shadow 内已镜像该变体）');
}

// ── ⓪c 不重声明设计系统保留类（R3）──────────────────────────────────
console.log('\n【⓪c 页内 style 不重声明设计系统保留类（R3）】');
{
  const RESERVED = ['btn', 'select', 'input', 'textarea', 'button', 'card', 'table', 'tab', 'tabs', 'badge', 'chip', 'toast', 'panel'];
  const css = stripCssComments(styleBlock);
  const redeclared = RESERVED.filter((c) =>
    new RegExp(`(?:^|[},])\\s*\\.${c}\\s*(?=[,{:])`, 'm').test(css) ||
    new RegExp(`(?:^|[},])\\s*${c}\\s*(?=[,{])`, 'm').test(css));
  ok(redeclared.length === 0, `无保留类/裸标签被重声明（实际：${JSON.stringify(redeclared)}）`);
  ok(!/(^|\n)\s*(table|th|td)\s*[,{]/m.test(css), '不重声明 table/th/td 元素选择器（改用 common.css .table）');
  ok(/class="table"/.test(html), '表格引用单源 .table 类');
  ok(/class="panel sync-map map"/.test(script), '映射卡引用单源 .panel 类');
}

// ── ⓪d token 有效性（防未定义变量 + 浅色 fallback）──────────────────
console.log('\n【⓪d 只用 tokens.css 已定义变量，且不自带浅色 fallback】');
{
  const tokens = stripCssComments(readRel('src/web/tokens.css'));
  const defined = new Set([...tokens.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
  const pool = stripCssComments(html);
  const used = [...new Set([...pool.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]))];
  const undef = used.filter((v) => !defined.has(v));
  ok(undef.length === 0, `引用变量全部已在 tokens.css 定义（未定义：${JSON.stringify(undef)}）`);
  const LIGHT = /^#(f{3,6}|f8fafc)$/i;
  const lightFallback = [...pool.matchAll(/var\(--[\w-]+\s*,\s*([^)]+)\)/g)]
    .map((m) => m[1].trim()).filter((v) => LIGHT.test(v) || /^white$/i.test(v));
  ok(lightFallback.length === 0, `var() 不携带浅色 fallback（实际：${JSON.stringify(lightFallback)}）`);
}

// ── ⓪e 类名有效性（用了不存在的类 = 零样式静默失效）────────────────
console.log('\n【⓪e 用到的 class 都有样式定义（防零样式静默失效）】');
{
  // 纪律：① 只扫本页实际引用的样式表（+ 组件库 shadow 内镜像的变体类）；② 必须剥 CSS 注释
  let css = '';
  for (const m of html.matchAll(/<link[^>]+href="\/portal\/([^"]+\.css)"/g)) css += stripCssComments(readRel('src/web/' + m[1]));
  css += stripCssComments(readRel('src/web/components.js'));
  const SEL = /\.([a-zA-Z][\w-]*)(?=\s*[,{:.\[])/g;
  const defined = new Set();
  for (const m of (css + '\n' + stripCssComments(styleBlock)).matchAll(SEL)) defined.add(m[1]);
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    // ⚠ 模板串里的插值 class（class="${cond ? 'good' : 'bad'}"）不能整段当类名 —
    //   否则会抽出 `${m.degraded` `?` `'good'` 这类碎片，制造**探针自身假红**。
    //   处理：字面量串里的标识符算 used（它们确实会成为真实类名），插值整段丢掉，只留静态片段。
    for (const t of m[1].matchAll(/\?\s*'([a-zA-Z][\w-]*)'\s*:\s*'([a-zA-Z][\w-]*)'/g)) { used.add(t[1]); used.add(t[2]); }
    for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean)) {
      if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c);
    }
  }
  // 仅作 JS 选择器钩子、不承载视觉的类（判据落在下面的 ⓪f「模板 ↔ collect 双向一致」）
  const JS_HOOK = new Set(['map', 'm-obj', 'm-pt', 'm-id', 'm-dir', 'm-del', 'm-addf', 'f-row', 'f-ext', 'f-par', 'f-del']);
  const missing = [...used].filter((c) => !defined.has(c) && !JS_HOOK.has(c));
  ok(missing.length === 0, `所有 class 均有样式定义（未定义：${JSON.stringify(missing)}）`);
  ok(defined.has('sect-title') && defined.has('page-sub'), '分区/描述走单源 .sect-title / .page-sub');
}

// ── ⓪f 模板 ↔ collect 字段契约双向一致 ─────────────────────────────
console.log('\n【⓪f 渲染模板 class ↔ collect() 读取选择器 双向一致】');
{
  for (const c of ['m-obj', 'm-pt', 'm-id', 'm-dir', 'f-ext', 'f-par']) {
    ok(new RegExp(`class="[^"]*\\b${c}\\b`).test(script), `${c} 在渲染模板中产出`);
    ok(new RegExp(`querySelector(?:All)?\\('\\.${c}'`).test(script), `${c} 在 collect() 中被读取`);
  }
  ok(/el\.dataset\.idx/.test(script), '映射卡带 data-idx（保存时据此取回原对象做形状保真）');
}

// ── 运行桩：抽出页面脚本，用真数据跑真渲染分支 ──────────────────────
const STUB = `
const __els = {};
function mkEl(id) {
  const el = {
    id, hidden: null, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    className: '', _h: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(t, fn) { el._h[t] = fn; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, toggleAttribute() {},
    appendChild(c) { return c; }, insertAdjacentHTML() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, scrollIntoView() {},
  };
  return el;
}
globalThis.__els = __els;
globalThis.document = {
  getElementById: (id) => (__els[id] ||= mkEl(id)), activeElement: { id: null },
  createElement: (t) => mkEl(t), querySelector: () => null, querySelectorAll: () => [],
};
globalThis.location = { href: '', pathname: '/crm-sync-console.html', search: '' };
globalThis.window = globalThis;
globalThis.alert = (s) => { globalThis.__alert = String(s); };
globalThis.localStorage = { getItem: () => 'stub-token', setItem() {}, removeItem() {}, clear() {} };
// 预创建页面脚本会触碰的元素（桩懒创建会让探针自己先崩 → 假红）
for (const id of ['status','app','err','summary','save','tabs','toast']) __els[id] = mkEl(id);
`;

function build(tag) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL(`_sync_render_${tag}.mjs`, dir);
  writeFileSync(file, [
    '// 自动生成（探针产物，勿手改）',
    // ⚠ 不得无条件重置：主脚本在 build() 前设好的 __nextGet 会被抹掉，
    //   使「失败分支」实际跑成「空数据分支」—— 探针自身制造假绿的经典形态。
    'if (globalThis.__nextGet === undefined) globalThis.__nextGet = null;',
    `const get = async (u) => {
      if (globalThis.__nextGet) return globalThis.__nextGet(u);
      const url = String(u || '');
      if (url.includes('/api/monitor/sync')) return globalThis.__sync || { rows: [] };
      return globalThis.__cfg || { value: {} };
    };`,
    'const put = async (p, body) => { globalThis.__lastPut = { path: p, body }; return globalThis.__putResult || { ok: true }; };',
    'const injectLayout = () => {};',
    STUB,
    script.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n'),
  ].join('\n'), 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now() + '_' + tag);
}
const tick = (n = 6) => new Promise((r) => setTimeout(r, n));
const appHtml = () => globalThis.__els['app']?.innerHTML || '';
const statusHtml = () => globalThis.__els['status']?.innerHTML || '';
// 走页面真实的 tab 点击处理器切到 trust（不绕过分支）
const switchTab = (name) => globalThis.__els['tabs']._h.click({ target: { closest: () => ({ dataset: { tab: name } }) } });
// 走页面真实的保存处理器，拿回 collect() 真正提交的 payload
const clickSave = () => globalThis.__els['save']._h.click();

// 从**渲染产物**反解出映射卡替身，供 collect() 遍历。
// 为什么不用手写死值：collect() 读的是「刚渲染出来的 DOM」，
// 手写替身会验成「探针自己以为的形状」——替身形状 ≠ 真实产物，是同族假绿形态。
function mapProxies() {
  const h = appHtml();
  const heads = [...h.matchAll(/class="panel sync-map map" data-idx="(-?\d+)"/g)];
  return heads.map((m, i) => {
    const seg = h.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : h.length);
    const pick = (cls) => ((seg.match(new RegExp(`class="${cls}[^"]*"[^>]*value="([^"]*)"`)) || [, ''])[1]);
    const dirSeg = (seg.match(/class="m-dir[^"]*"[^>]*>([\s\S]*?)<\/crm-select>/) || [, ''])[1];
    const val = {
      'm-obj': pick('m-obj'), 'm-pt': pick('m-pt'), 'm-id': pick('m-id'),
      'm-dir': (dirSeg.match(/<option value="([^"]+)" selected/) || [, 'in'])[1],
    };
    const rows = [...seg.matchAll(/<tr class="f-row">([\s\S]*?)<\/tr>/g)].map((r) => {
      const g = (cls) => ((r[1].match(new RegExp(`class="${cls}[^"]*"[^>]*value="([^"]*)"`)) || [, ''])[1]);
      return { querySelector: (s) => ({ value: g(s.slice(1)) }) };
    });
    return {
      dataset: { idx: m[1] },
      querySelector: (s) => (s.startsWith('.') && s.slice(1) in val ? { value: val[s.slice(1)] } : null),
      querySelectorAll: (s) => (s === '.f-row' ? rows : []),
    };
  });
}

// ── ① 映射有真值 ⇒ 必须渲染出行 ────────────────────────────────────
console.log(`\n【① sync-mappings 真值（${REAL_MAPPING_COUNT} 条 / ${REAL_FIELD_ROWS} 字段行）→ 必须渲染出来】`);
globalThis.__nextGet = null;
globalThis.__sync = REAL_SYNC;
globalThis.__cfg = { value: REAL_MAPPINGS };
await build('real'); await tick();
{
  const h = appHtml();
  const cards = (h.match(/class="panel sync-map map"/g) || []).length;
  ok(cards === REAL_MAPPING_COUNT, `渲染出 ${REAL_MAPPING_COUNT} 张映射卡（实际 ${cards}）`);
  const rows = (h.match(/class="f-row"/g) || []).length;
  ok(rows === REAL_FIELD_ROWS, `渲染出 ${REAL_FIELD_ROWS} 个字段行（实际 ${rows}）`);
  ok(/m-obj[^>]*value="account"/.test(h), 'object 值已回填（account）');
  ok(/m-pt[^>]*value="CRM_ACCOUNT"/.test(h), 'particle_type 值已回填（CRM_ACCOUNT）');
  ok(/m-dir/.test(h) && /selected/.test(h), 'direction 下拉回填选中项');
  ok(/f-ext[^>]*value="business_title"/.test(h), '字段行 external 已回填（account 末列 business_title）');
  ok(/f-par[^>]*value="business_title"/.test(h), '字段行 particle 已回填');
}

// ── ② identity 渲染成标量（原实现显示 [object Object]）──────────────
console.log('\n【② identity（对象形状）→ 渲染主键字段标量，产物无 [object Object]】');
{
  const h = appHtml();
  ok(!h.includes('[object Object]'), '渲染产物不含 [object Object]（用户截图底部可见的缺陷）');
  const n = (h.match(/m-id[^>]*value="id"/g) || []).length;
  ok(n === REAL_MAPPING_COUNT, `${REAL_MAPPING_COUNT} 条映射主键字段均已回填为 id（实际 ${n}）`);
}

// ── ③ 保存写回对象形状（在 ① 的同一渲染上下文里做「渲染值 → 保存值」往返）──
console.log('\n【③ 保存：identity 写回对象形状（禁字符串降级）】');
{
  globalThis.__lastPut = null;
  globalThis.__putResult = { ok: true };
  const cards = mapProxies();
  ok(cards.length === REAL_MAPPING_COUNT, `保存前可从渲染产物取回 ${REAL_MAPPING_COUNT} 张卡（实际 ${cards.length}）`);
  globalThis.__els['app'].querySelectorAll = (sel) => (sel === '.map' ? cards : []);
  clickSave(); await tick(10);
  const body = globalThis.__lastPut?.body;
  ok(Boolean(body), '保存处理器确实提交了 payload（未被静默吞掉）');
  const ms = body?.value?.mappings || [];
  ok(ms.length === REAL_MAPPING_COUNT, `提交 ${REAL_MAPPING_COUNT} 条映射（实际 ${ms.length}）`);
  const i0 = ms[0]?.identity;
  ok(Boolean(i0) && typeof i0 === 'object' && !Array.isArray(i0), `identity 写回对象形状（实际 ${JSON.stringify(i0)}）`);
  ok(i0?.external_id_field === 'id', 'identity.external_id_field 保真（消费方 mapping.js:24 只读这个键）');
  ok(!ms.some((m) => typeof m.identity === 'string'), '无一条映射的 identity 退化成字符串（原缺陷形态）');
  ok(ms[0]?.object === 'account' && ms[0]?.particle_type === 'CRM_ACCOUNT', 'object / particle_type 保真');
  ok(ms[0]?.fields?.length === 8, `字段行往返保真（account 8 条，实际 ${ms[0]?.fields?.length}）`);
  ok(ms[0]?.fields?.[7]?.external === 'business_title', '字段内容保真（末列 business_title）');
  ok(body?.value?.version === 1, 'version 保留（未被覆盖成 undefined）');
}

// ── ④ 信任档渲染配置真值 ───────────────────────────────────────────
console.log('\n【④ sync-trust 渲染配置真值（禁写死档位说明）】');
globalThis.__nextGet = null;
globalThis.__sync = REAL_SYNC;
globalThis.__cfg = { value: REAL_TRUST };
await build('trust'); await tick();
switchTab('trust'); await tick();
{
  const h = appHtml();
  ok(/只读观察期/.test(h), 'L1 label 取自配置（只读观察期）');
  ok(/批量入库/.test(h), 'L2 label 取自配置（批量入库）');
  ok(/启用回写/.test(h), 'L3 label 取自配置（启用回写）');
  ok(/value="L3"/.test(h), '当前档位 = 配置的 default_level（L3）');
  ok(/回写客户 CRM/.test(h), '三列权限位表头（读入 / 批量入库 / 回写客户 CRM）');
  const deny = (h.match(/禁止/g) || []).length;
  ok(deny >= 2, `权限位渲染真值（禁止出现 ${deny} 次：L1 禁入库禁回写、L2 禁回写）`);
  ok(!/默认 <b>L1 只读<\/b>/.test(html), '删除写死的「默认 L1 只读」（真实 default_level=L3，属假信息）');
  ok(/TRUST_LEVELS/.test(script), '保留未播种时的档位兜底（不因缺配置白屏）');
}

// ── ⑤ 同步状态三分支 ───────────────────────────────────────────────
console.log('\n【⑤ 同步状态：有游标行 ⇒ 渲染；真 0 条 ⇒ 自解释空态；取数失败 ⇒ 可区分】');
globalThis.__nextGet = null;
globalThis.__cfg = { value: REAL_MAPPINGS };
globalThis.__sync = { rows: [{ provider: 'gaode', object: 'account', status: 'ok', read: 3, created: 1, updated: 2, skipped: 0, conflicted: 0, lag_ms: 120000 }], lag: 120000, success_rate: 1, conflict: 0, degraded: 0 };
await build('rows'); await tick();
{
  const h = statusHtml();
  ok(/gaode/.test(h) && /account/.test(h), '有游标行 ⇒ 渲染出该行（原实现只写空态文案）');
  ok(/2 分钟前/.test(h), '滞后按分钟渲染');
  ok(!/尚未跑过/.test(h), '有数据时不显示空态');
}
globalThis.__sync = REAL_SYNC;
await build('empty'); await tick();
{
  const h = statusHtml();
  ok(/尚未跑过/.test(h) && !/<tbody>/.test(h), '真 0 行 ⇒ 空态已给出（非静默空表）');
  ok(/尚未跑过|尚未跑/.test(h), '空态说明「尚未跑过」（与「接入但无增量」可区分）');
  ok(!/读取失败/.test(h), '真 0 条不被误判为失败');
}
globalThis.__nextGet = async (u) => { if (String(u).includes('/api/monitor/sync')) throw new Error('auth required'); return { value: REAL_MAPPINGS }; };
await build('err'); await tick();
{
  const h = statusHtml();
  ok(/读取失败/.test(h), '取数失败 ⇒ 显式报错');
  ok(/auth required/.test(h), '带真实原因（不吞错）');
  ok(!/尚未跑过/.test(h), '失败态不伪装成空数据');
}
globalThis.__nextGet = null;
globalThis.__cfg = { value: null };
await build('noseed'); await tick();
{
  ok(appHtml().length > 0, '配置键未播种（value=null）⇒ 渲染空态而非白屏');
  ok(/'mappings'|加映射/.test(appHtml()), '空配置下仍给出「+ 加映射」入口（可自助建档，不是死页）');
}

// ── ⑥ 禁裸 alert（统一 toast）──────────────────────────────────────
console.log('\n【⑥ 禁裸 alert，统一 toast（规范 §5）】');
{
  // 先剥字符串字面量再查调用（`'alert('` 作为文案不算调用；`toast(` 里的 oast( 不匹配）
  const noStr = script.replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  ok(!/(^|[^.\w])alert\s*\(/.test(noStr), '脚本内无裸 alert() 调用');
  ok(/id="toast"/.test(html), '页面含统一 toast 容器');
  ok(/(^|[},])\s*#toast\s*(?=[,{:])/m.test(stripCssComments(styleBlock)), 'toast 显隐由页内 ID 规则承载（不重声明保留类 .toast）');
}

// ── ⑦ 文案预算 ─────────────────────────────────────────────────────
console.log('\n【⑦ 常驻可见文案预算 ≤160 字】');
{
  const text = stripAll(html);
  ok(text.length <= 160, `常驻可见文案 ≤160 字（实际 ${text.length} 字）`);
}

// ── ⑧ 技术标识符不得直出给用户（2026-09-18 用户截图圈注）────────────────
// 判据设计要点：**可见文本**只取「文本节点」＋「placeholder」——
//   ⚠ 必须先剥 `title="…"`：降级到 tooltip（鼠标悬停/排查可见、常驻不可见）是本轮**允许**的修法，
//     不剥 title 会把正确修法判成缺陷（探针自身假红）；
//   ⚠ 不得直接对整段 script 做否定断言：脚本里满是 API 路径/选择器/变量名，用户看不到。
console.log('\n【⑧ 技术标识符不得直出给用户（可降级到 title 供排查）】');
{
  const src = [markupOnly, script].join('\n').replace(/\btitle="[^"]*"/g, '');
  // ⚠ 文本节点只取**同一行内**的 `>…<`：`[^<>]+` 允许跨行时，JS 的箭头函数 `=>` 会把整段函数体
  //   当成「文本」捕进来（实测误报 `typeof id === 'object'`）——判据自身制造假红。
  // ⚠ 再剥离 `${…}` 插值：插值是运行期数据/变量，不是**静态文案**；
  //   对象名/通道名（${esc(r.object)} / ${esc(r.provider)}）是否中文化属数据域议题，不由本判据兜。
  // ⚠ HTML 注释一并剥掉（注释不是用户可见文案；不剥会用示例注释把正确实现判红）。
  const textNodes = [...src.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/>([^<>\n]+)</g)]
    .map((m) => m[1].replace(/\$\{[^}]*\}/g, ' ')).join(' ');
  const ph = [...src.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]).join(' ');
  const visible = textNodes + ' ' + ph;

  const TERMS = [
    ['scopeTenant', /\bscopeTenant\b/],
    ['scopeOf', /\bscopeOf\b/],
    ['crm.sync_cursor（表名）', /crm\.sync_cursor/],
    ['direction 字面量语法', /direction\s*:/],
    ['fail-closed', /fail-closed/],
    ['mapping 层', /mapping\s*层/],
    ['trust_level（字段名）', /\btrust_level\b/],
    ['英文标签 object', /\bobject\b/],
    ['英文标签 particle_type', /\bparticle_type\b/],
    ['英文标签 direction', /\bdirection\b/],
    ['英文表头 external', /\bexternal\b/],
    ['英文表头 particle', /\bparticle\b/],
    ['英文表头 provider', /\bprovider\b/],
  ];
  for (const [name, re] of TERMS) {
    ok(!re.test(visible), `可见文本不含技术标识符「${name}」`);
  }

  // 反向判据：术语必须**仍可排查**（降级到 title，而不是删除）—— 防「为过判据而删信息」
  ok(/title="[^"]*scopeTenant/.test(html) && /title="[^"]*scopeOf/.test(html), 'scopeTenant/scopeOf 降级到 title（保留可排查性，未删除）');
  ok(/title="[^"]*crm\.sync_cursor/.test(html), '表名 crm.sync_cursor 降级到 title');
  ok(/title="[^"]*(direction|fail-closed)/.test(html), '白名单语义（direction / fail-closed）降级到 title');
  ok(/title="[^"]*(object|particle_type|direction)/.test(html), '字段名（object / particle_type / direction）降级到 label 的 title');

  // 后端状态值是英文标识符，必须经映射中文化（未登记值原样兜底，不吞成空白）
  ok(/const STATUS_LABEL\s*=/.test(script), '存在状态中文化映射表 STATUS_LABEL');
  ok(!/esc\(r\.status\)/.test(script), '状态值经 statusText() 中文化，不直出 r.status');

  // tab 显示名不得携带配置键（配置键只留 title 与 KEYS 常量）
  const tabs = [...html.matchAll(/<crm-tab[^>]*>([^<]*)<\/crm-tab>/g)].map((m) => m[1].trim());
  ok(tabs.length >= 2 && !tabs.some((t) => /sync-/.test(t)), `tab 显示名为用户词、不含配置键（实际：${JSON.stringify(tabs)}）`);
}

console.log(`\n===== 探针结果：${pass} 通过 / ${fail} 失败 =====`);

// ── 变异自证：探针必须能把「已知缺陷形态」逐类打红 ────────────────────
if (process.argv.includes('--selftest')) {
  console.log('\n【变异自证】基线必须全绿，且每个变异体必须被打红');
  if (fail) { console.log('🔴 基线非全绿（' + fail + ' 条失败），自证无意义'); process.exit(1); }
  const MUTS = [
    { name: '黄块回流（page-sub → .note 实底块）', from: '<p class="page-sub" title="配置键：sync-mappings / sync-trust">', to: '<div class="note">' },
    { name: '控件退化（crm-input → 裸 input）', from: '<crm-input class="m-obj', to: '<input class="m-obj' },
    { name: 'identity 字符串降级（保存即破坏配置）', from: 'identity: idf ? { ...prevId, external_id_field: idf } : {},', to: "identity: (el.querySelector('.m-id')?.value || '')," },
    { name: '重声明保留类 .card', from: '.sync-map { margin-bottom: 12px; }', to: '.sync-map { margin-bottom: 12px; }\n  .card { border: 0; }' },
    { name: '未定义 token + 浅色 fallback', from: '.hint { color: var(--mut); font-size: 12px; margin: 4px 0; }', to: '.hint { color: var(--warn-ink, #a16207); font-size: 12px; margin: 4px 0; }' },
    { name: '技术标识符回流（tab 显示名带配置键 sync-mappings）', from: 'title="配置键：sync-mappings">字段映射</crm-tab>', to: '>字段映射（sync-mappings）</crm-tab>' },
    { name: '技术标识符回流（英文标签 object）', from: 'title="字段名：object">外部对象', to: 'title="字段名：object">object' },
    { name: '技术标识符回流（表名直出 crm.sync_cursor）', from: 'title="判据表：crm.sync_cursor（无本租户行即视为未跑过）">', to: '>' },
    { name: '状态值英文直出（statusText → r.status）', from: '${esc(statusText(r.status))}', to: '${esc(r.status)}' },
  ];
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  let bad = 0;
  for (const [i, mu] of MUTS.entries()) {
    if (!html.includes(mu.from)) {
      console.log(`  🔴 变异 ${i + 1}「${mu.name}」未生效：源串未匹配（探针与页面已漂移，自证失效）`);
      bad++; continue;
    }
    const file = new URL(`_sync_mut_${i + 1}.html`, dir);
    writeFileSync(file, html.replace(mu.from, mu.to), 'utf8');
    const r = spawnSync(process.execPath, ['scripts/verify-crm-sync-console-render.mjs'],
      { env: { ...process.env, SYNC_HTML: 'tmp/_sync_mut_' + (i + 1) + '.html' }, encoding: 'utf8' });
    const hit = r.status === 1;
    if (!hit) bad++;
    console.log(`  ${hit ? '✅' : '🔴'} 变异 ${i + 1}「${mu.name}」${hit ? '被打红（探针有鉴别力）' : '未被发现（探针假绿！）'}`);
  }
  console.log(bad ? `\n🔴 变异自证未通过：${bad} 项` : `\n✅ 变异自证通过：${MUTS.length}/${MUTS.length} 个变异体均被打红`);
  process.exit(bad ? 1 : 0);
}

process.exit(fail ? 1 : 0);
