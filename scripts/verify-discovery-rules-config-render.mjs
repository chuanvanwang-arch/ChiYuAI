// scripts/verify-discovery-rules-config-render.mjs — 线索发现·拓客规则页「UI 合规 + 渲染得出来 + 保存不破坏配置」运行期验证器
//
// 为什么需要（2026-09-18 用户截图圈出亮黄说明块，要求「新增页面必须使用项目 UI」）：
//   本页是后加的页面，写的时候绕过了 UI 架构级封死（docs/specs/2026-09-05-ui-authoring-rules.md），
//   静态契约测试（test/web/discoveryRulesPage.test.js 14 条）全绿也发现不了：
//   ① 自造黄色说明块 .note（background:var(--warn) 实底）—— 深色专业风里唯一一块亮黄，用户截图圈出；
//   ② 页内重声明设计系统保留类（.tabs / .tabs button / .panel）⇒ 改单源组件时本页不跟随（R3）；
//   ③ 21 处裸 <button>/<input>/<textarea>/<select>（含 JS 模板串直出）⇒ 违反 R4/R7，pre-commit 被拦；
//   ④ `document.querySelectorAll('.tabs button')` —— crm-tab 的可视按钮在组件 shadow 内，
//      light DOM 查询**恒为空** ⇒ tab 点了没反应（区间切换死区）；
//   ⑤ 页首「主动拓客（对话驱动）」块是 class="panel" 且**无 .active**，而页内 style 写了 `.panel{display:none}`
//      ⇒ 该块**永远不可见**（整段说明是死内容，且它写着「按上方配置」而配置其实在下方）；
//   ⑥ 付费源授权弹层用裸 window.prompt() —— 原生弹窗不受全站主题控制、不可校验、不可访问；
//   ⑦ <datalist> 与 crm-* 不可组合（shadow 内 input 无法关联 light DOM 的 <datalist>，
//      项目内 propagation-hub.html:236 已实证并改为自绘下拉）—— 本页三处 datalist 迁 crm-* 后即成死标记。
//
// 用**现网真实配置**反证出的一个数据级缺陷（GET /api/config/discovery-rules 实抓，不是推断）：
//   ⑧ `qixin / anysite / xinbang` 在 config_store 里是 `enabled: true`（**这就是「显式授权」的落库形态**：
//      src/config/discoveryRules.js:6「付费源需显式授权 + 填 key」、test/config/providerEnabled.test.js ③④
//      「config_store override {id, enabled:true} 合并后即 enabled」）。
//      而原实现 renderProviders 无论真值一律渲染「未勾选 + disabled」，collect() 又写死
//      `enabled: p.scope === 'paid' ? false : ...` ⇒ **点一次「保存变更」（哪怕只改 ICP 行业）
//      就静默撤销全部已授权的付费源**，无报错、无提示、无日志；后果是线索发现/主动拓客失去这三个源。
//      同族先例：crm-sync-console.html 的 identity 字符串降级（同为「保存即破坏配置」）。
//
// 判据（每条都能被变异体打红，见 --selftest）：
//   ⓪  自造黄色告警块已移除（剥注释后无 class="note"；页内 style 无 .note 自身规则）+ 描述行走 R6 位点
//   ⓪b 全控件 crm-*（静态 HTML 段 + JS 模板串双向；type="hidden" 豁免）
//   ⓪c 不在页内重声明设计系统保留类（R3）
//   ⓪d 只准用 tokens.css 已定义变量，且不得自带浅色 fallback
//   ⓪e 用到的 class 在本页实际引用的表 + 组件库 + 页内 style 里都有定义（防零样式静默失效）
//   ⓪e2 crm-button 上的变体类必须在 components.js shadow 内被镜像（否则 light DOM 规则穿不过 shadow ⇒ 变体样式静默丢失）
//   ⓪f 渲染模板 class ↔ collect() 读取选择器 双向一致（防字段漂移导致保存静默清空）
//   ⓪g 死区：每个 .panel 必须隶属某个 tab 分区（id="panel-*"）—— 否则在 .dr-panel{display:none} 下永不显示
//   ⓪h 禁 <datalist>（与 crm-* 不可组合）／禁裸 alert/prompt/confirm（原生弹窗）
//   ①  tab 切换真接线：点 crm-tab ⇒ 对应分区 .on、其余关闭（原实现 light DOM 查询恒空 = 点了没反应）
//   ②  现网真值渲染：11 个数据源 / 7 条信号 / ICP 真值全部落到产物
//   ③  付费源授权保真：渲染色 = 配置真值；保存 payload **不得**把已授权的付费源清零（本页最贵的一条）
//   ④  系统级数据源可写：勾选变化确实被保存（保真不等于冻结）
//   ⑤  playbooks 往返保真（表格编辑器 → 模型 → payload）
//   ⑥  未配置(404) 与 加载失败 分流，不得互相伪装（假绿防护）
//   ⑦  常驻可见文案回归上限（防「一堆说明」继续膨胀）
//
// 用法：
//   node scripts/verify-discovery-rules-config-render.mjs                          # 验真实页面
//   DR_HTML=tmp/_mut.html node scripts/verify-discovery-rules-config-render.mjs     # 验变异体
//   node scripts/verify-discovery-rules-config-render.mjs --selftest                # 变异自证
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);
const htmlRel = process.env.DR_HTML || 'src/web/discovery-rules.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
const readRel = (rel) => { try { return readFileSync(new URL(rel, ROOT), 'utf8'); } catch { return ''; } };
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// ⚠ 否定断言必须先剥注释/脚本/样式：注释里出现的字面量不算「用了」
const stripAll = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const script = (html.match(/<script type="module">([\s\S]*?)<\/script>/) || [, ''])[1];
const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const markupOnly = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const componentsJs = readRel('src/web/components.js');

// ── 现网真实配置（2026-09-18 实抓 GET /api/config/discovery-rules，system 租户）──
// 替身形状必须与真实返回值一致：「替身形状掩缺陷」是本仓最高频的假绿形态。
const REAL_RULES = {
  icp: { geo: ['CN'], industries: ['industrial_coatings', 'chemical', 'additives'], min_headcount: 50, min_confidence: 0.6 },
  providers: [
    { id: 'email-verify', kind: 'email/phone',       scope: 'system',           costTier: 1, enabled: true },
    { id: 'web-research', kind: 'web/serp',          scope: 'system',           costTier: 0, enabled: true },
    { id: 'tender',       kind: 'internal-signal',   scope: 'system',           costTier: 0, enabled: true },
    { id: 'gaode',        kind: 'geo_firmographics', scope: 'system',           costTier: 1, enabled: true },
    { id: 'attio',        kind: 'firmographics',     scope: 'system-candidate', costTier: 2, enabled: false },
    { id: 'zhizao',       kind: 'biz-verify',        scope: 'system-candidate', costTier: 1, enabled: false },
    { id: 'clearbit',     kind: 'firmographics',     scope: 'paid',             costTier: 3, enabled: false },
    { id: 'linkedin',     kind: 'social',            scope: 'paid',             costTier: 3, enabled: false },
    { id: 'qixin',        kind: 'firmographics',     scope: 'paid',             costTier: 2, enabled: true },
    { id: 'anysite',      kind: 'firmographics',     scope: 'paid',             costTier: 2, enabled: true },
    { id: 'xinbang',      kind: 'social',            scope: 'paid',             costTier: 2, enabled: true },
  ],
  signals: {
    tech_adopt: { weight: 0.6 }, tender_match: { weight: 0.8 }, funding_round: { weight: 0.9 },
    social_content: { weight: 0.4 }, hiring_icp_role: { weight: 0.7 }, website_redesign: { weight: 0.3 },
    leadership_change: { weight: 0.5 },
  },
  duplicate_criteria: { CRM_ACCOUNT: [['external_id'], ['domain'], ['linkedin_url'], ['name']], CRM_CONTACT: [['external_id'], ['email']] },
  playbooks: [],
};
// 「已授权」的付费源（config_store 真值）与出厂默认（D1 铁律恒 false）——
//   这两者必须区分：前者是授权落库、后者是出厂态。原实现把两者混为一谈（一律 false）。
const REAL_PAID_AUTHORIZED = ['qixin', 'anysite', 'xinbang'];
const REAL_PAID_DEFAULTS_OFF = ['clearbit', 'linkedin'];
const REAL_RULES_WITH_PB = {
  ...REAL_RULES,
  playbooks: [{ name: 'tender-first', match: 'tender_match&&funding_round', data: ['tender', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] }],
};

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
  const head = (html.match(/<header class="page-head"[\s\S]*?<\/header>/) || [''])[0];
  ok(!/page-sub/.test(head), 'R6：页眉内不含描述行（页眉只保留标题）');
  ok(/<\/header>\s*<p class="page-sub">/.test(html), 'R6：描述行以 .page-sub 紧随页眉之后');
  ok(!/var\(--warn\)/.test(clean), '不再有 --warn 实底块（黄块唯一来源）');
}

// ── ⓪b 控件必须 crm-*（R4 静态 + R7 动态）──────────────────────────
console.log('\n【⓪b 控件全 crm-*（R4 静态 / R7 动态直出）】');
{
  const BARE = /<(button|input|select|textarea)\b(?![^>]*type="hidden")/gi;
  const markupHits = [...markupOnly.matchAll(BARE)].map((m) => m[1]);
  ok(markupHits.length === 0, `静态 HTML 段无裸控件（实际：${JSON.stringify(markupHits)}）`);
  const tplHits = [...script.matchAll(/<(button|input|select|textarea)\b/gi)].map((m) => m[1]);
  ok(tplHits.length === 0, `JS 模板串无裸控件（R7 历史最大逃逸面；实际：${JSON.stringify(tplHits)}）`);
  for (const tag of ['crm-input', 'crm-select', 'crm-textarea', 'crm-checkbox', 'crm-button', 'crm-tabs', 'crm-tab']) {
    ok(html.includes('<' + tag), `使用组件 <${tag}>`);
  }
}

// ── ⓪c 不重声明设计系统保留类（R3）──────────────────────────────────
console.log('\n【⓪c 页内 style 不重声明设计系统保留类（R3）】');
{
  const RESERVED = ['btn', 'select', 'input', 'textarea', 'button', 'card', 'table', 'tab', 'tabs', 'badge', 'chip', 'toast', 'panel'];
  const css = stripCssComments(styleBlock);
  // 判据 = 「该保留类自身被定义」（.x 后紧跟 , { : . [），而非被用作后代选择器前缀
  const redeclared = RESERVED.filter((c) => new RegExp(`\\.${c}\\s*(?=[,{:.\\[])`, 'm').test(css));
  ok(redeclared.length === 0, `无保留类在页内重声明（实际：${JSON.stringify(redeclared)}）`);
  ok(!/(^|\n)\s*(table|th|td)\s*[,{]/m.test(css), '不重声明 table/th/td 元素选择器（改用 common.css .table）');
  ok(/class="table"/.test(html), '表格引用单源 .table 类');
  ok(/class="panel dr-panel/.test(html), '分区引用单源 .panel 类 + 页内私有 .dr-panel 承载显隐');
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
  css += stripCssComments(componentsJs);
  const SEL = /\.([a-zA-Z][\w-]*)(?=\s*[,{:.\[])/g;
  const defined = new Set();
  for (const m of (css + '\n' + stripCssComments(styleBlock)).matchAll(SEL)) defined.add(m[1]);
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    // ⚠ 模板串里的插值 class（class="${cond ? 'a' : 'b'}"）不能整段当类名 —— 会抽出碎片制造探针自身假红
    for (const t of m[1].matchAll(/\?\s*'([a-zA-Z][\w-]*)'\s*:\s*'([a-zA-Z][\w-]*)'/g)) { used.add(t[1]); used.add(t[2]); }
    for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean)) {
      if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c);
    }
  }
  // 仅作 JS 选择器钩子、不承载视觉的类（判据落在 ⓪f「模板 ↔ collect 双向一致」）
  const JS_HOOK = new Set(['pb-row', 'pb-name', 'pb-match', 'pb-data', 'pb-ai', 'pb-action', 'pb-del']);
  const missing = [...used].filter((c) => !defined.has(c) && !JS_HOOK.has(c));
  ok(missing.length === 0, `所有 class 均有样式定义（未定义：${JSON.stringify(missing)}）`);
  ok(defined.has('sect-title') && defined.has('page-sub'), '分区/描述走单源 .sect-title / .page-sub');
  ok(defined.has('dr-panel') && defined.has('hint') && defined.has('field'), '页内私有类有自身规则（不靠后代选择器充数）');
}

// ── ⓪e2 crm-button 变体类可达性（shadow 边界）──────────────────────
console.log('\n【⓪e2 crm-button 上的变体类必须在 components.js shadow 内被镜像】');
{
  // 背景：crm-button 把宿主 class 复制到 shadow 内 <button>，但 light DOM 的规则**穿不过 shadow 边界**；
  //   组件只镜像了白名单变体（button.btn / button.btn.primary / button.sec …）。
  //   页面若写 class="crm-btn"（页内自定义）⇒ 组件 shadow 内无对应规则 ⇒ 按钮退化成默认观感（静默）。
  const mirrored = new Set();
  for (const m of componentsJs.matchAll(/button\.((?:[a-zA-Z][\w-]*)(?:\.[a-zA-Z][\w-]*)*)\s*(?=[,{:])/g)) {
    for (const c of m[1].split('.')) mirrored.add(c);
  }
  ok(mirrored.has('btn'), 'shadow 内已镜像 .btn 基类（自检：镜像清单解析有效）');
  // 仅作 JS 钩子、不承载视觉的类不参与（判据落在 ⓪e / ⓪f）
  const HOOK = new Set(['pb-del', 'pb-row']);
  const hosts = [...script.matchAll(/<crm-button[^>]*class="([^"]*)"/g)].map((m) => m[1])
    .concat([...markupOnly.matchAll(/<crm-button[^>]*class="([^"]*)"/g)].map((m) => m[1]));
  const bad = [];
  for (const cls of hosts) for (const c of cls.split(/\s+/).filter(Boolean)) if (!mirrored.has(c) && !HOOK.has(c)) bad.push(c);
  ok(bad.length === 0, `crm-button 变体类全部可达（不可达：${JSON.stringify([...new Set(bad)])}）`);
  ok(!/class="[^"]*\bcrm-btn\b/.test(html), '.crm-btn（页内自定义类，shadow 不可达）不得使用');
  ok(!/^\s*\.crm-btn\s*\{/m.test(stripCssComments(styleBlock)), '页内不再定义 .crm-btn');
}

// ── ⓪f 模板 ↔ collect 字段契约双向一致 ─────────────────────────────
console.log('\n【⓪f 渲染模板 class/属性 ↔ collect() 读取选择器 双向一致】');
{
  for (const c of ['pb-name', 'pb-match', 'pb-data', 'pb-ai', 'pb-action']) {
    ok(new RegExp(`class="[^"]*\\b${c}\\b`).test(script), `${c} 在渲染模板中产出`);
  }
  ok(/querySelectorAll\('crm-input\[data-i\]'\)/.test(script), 'playbooks 行在 collect 侧按 crm-input[data-i] 读取');
  ok(/querySelectorAll\('crm-input\[data-signal\]'\)/.test(script), 'signals 在 collect 侧按 crm-input[data-signal] 读取');
  ok(/querySelector\(\s*[`'"]crm-checkbox\[data-provider=/.test(script), 'providers 在 collect 侧按 crm-checkbox[data-provider] 读取');
  ok(/data-provider="\$\{esc\(p\.id\)\}"/.test(script), 'providers 渲染侧产出 data-provider（与 collect 侧同源）');
  ok(/data-signal="\$\{esc\(k\)\}"/.test(script), 'signals 渲染侧产出 data-signal（与 collect 侧同源）');
}

// ── ⓪g 死区：.panel 必须隶属 tab 分区 ───────────────────────────────
console.log('\n【⓪g 每个 .panel 必须隶属某个 tab 分区（否则永不显示）】');
{
  // 背景：页内 `.dr-panel{display:none}` + tab 只给 id 形如 panel-<key> 的分区加 .on。
  //   原实现页首有一块 class="panel"（无 id、无 .on）的「主动拓客（对话驱动）」说明 ⇒ 永远 display:none，
  //   且它自称「按上方配置」而配置其实在下方 —— 死内容 + 错误指向。
  const panelTags = [...markupOnly.matchAll(/<(?:section|div)\b[^>]*class="[^"]*\bpanel\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  const orphan = panelTags.filter((t) => !/id="panel-[\w-]+"/.test(t));
  ok(orphan.length === 0, `无游离 .panel（不会显示的死块；实际 ${orphan.length} 处：${JSON.stringify(orphan.map((t) => t.slice(0, 60)))}）`);
  ok(!/主动拓客（对话驱动）/.test(markupOnly), '页首不可见的「主动拓客（对话驱动）」死块已移除');
  ok(/主动拓客/.test(html), '「主动拓客」用法在 ICP 分区**就近**声明（不丢失功能指引）');
}

// ── ⓪h 禁 datalist / 原生弹窗 ───────────────────────────────────────
console.log('\n【⓪h 禁 <datalist>（与 crm-* 不可组合）／禁裸 alert|prompt|confirm】');
{
  ok(!/<datalist\b/i.test(markupOnly), '无 <datalist>（shadow 内 input 无法关联 light DOM 的 datalist，已实证失效）');
  // 先剥字符串字面量再查调用（`'prompt('` 作为文案不算调用）
  const noStr = script.replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  for (const fn of ['alert', 'prompt', 'confirm']) {
    ok(!new RegExp(`(^|[^.\\w])${fn}\\s*\\(`).test(noStr), `脚本内无裸 ${fn}() 调用`);
  }
  ok(/id="auth-dialog"/.test(html), '付费源授权改用项目内弹层（#auth-dialog）');
}

// ── 运行桩：抽出页面脚本，用现网真数据跑真渲染分支 ──────────────────
// 路由表由真实 HTML 解析得出（不手写替身），DOM 查询「按渲染产物即时反解」——
// 手写替身会验成「探针自己以为的形状」，与真实产物不一致即为同族假绿。
const TABS_INIT = [...html.matchAll(/<crm-tab([^>]*?)data-tab="([^"]+)"/g)].map((m) => ({ tab: m[2], active: /\bactive\b/.test(m[1]) }));
const PANELS_INIT = [...html.matchAll(/<section\b[^>]*>/g)]
  .map((m) => m[0])
  .filter((t) => /id="panel-[\w-]+"/.test(t))
  .map((t) => ({ id: (t.match(/id="(panel-[\w-]+)"/) || [, ''])[1], on: /\bdr-panel on\b/.test(t) }));

const STUB = `
const __els = {};
function mkEl(id) {
  const set = new Set();
  const el = {
    id, hidden: null, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    className: '', _h: {}, _attrs: {},
    classList: {
      add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
    },
    addEventListener(t, fn) { (el._h[t] || (el._h[t] = [])).push(fn); },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    toggleAttribute(k, force) { const has = k in el._attrs; const on = force === undefined ? !has : !!force; if (on) el._attrs[k] = ''; else delete el._attrs[k]; return on; },
    appendChild(c) { return c; }, insertAdjacentHTML() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, scrollIntoView() {}, showModal() { el.open = true; }, close() { el.open = false; },
  };
  return el;
}
function __attrsOf(seg, name) {
  const m = new RegExp(name + '="([^"]*)"').exec(seg);
  return m ? m[1] : null;
}
// 从**渲染产物**反解 providers 复选框（首次访问即固化 ⇒ 允许测试改写，模拟用户勾选）
function __parseProviders() {
  const h = __els['providers-body'] ? __els['providers-body'].innerHTML : '';
  const out = {};
  for (const m of h.matchAll(/<crm-checkbox data-provider="([^"]+)"([^>]*)>/g)) {
    const seg = m[2];
    const e = mkEl('prov-' + m[1]);
    e.dataset.provider = m[1];
    e.checked = /\\bchecked\\b/.test(seg);
    e.disabled = /\\bdisabled\\b/.test(seg);
    out[m[1]] = e;
  }
  return out;
}
function __parseSignals() {
  const h = __els['signals-body'] ? __els['signals-body'].innerHTML : '';
  return [...h.matchAll(/<crm-input type="range" data-signal="([^"]+)"[^>]*value="([^"]*)">/g)].map((m) => {
    const e = mkEl('sig-' + m[1]);
    e.dataset.signal = m[1];
    e.value = m[2];
    return e;
  });
}
const __tabs = SEQ_TABS.map((t) => { const e = mkEl('tab-' + t.tab); e.dataset.tab = t.tab; if (t.active) e.setAttribute('active', ''); return e; });
const __panels = SEQ_PANELS.map((p) => { const e = mkEl(p.id); if (p.on) e.classList.add('on'); return e; });
let __provCache = null;
globalThis.__tabs = __tabs; globalThis.__panels = __panels;
globalThis.__fire = (el, type, ev) => { for (const f of (el._h[type] || [])) f(ev || {}); };
globalThis.document = {
  getElementById: (id) => (__els[id] || (__els[id] = mkEl(id))), activeElement: { id: null },
  createElement: (t) => mkEl(t),
  querySelector: (s) => {
    const m = /^crm-checkbox\\[data-provider="([^"]+)"\\]$/.exec(s);
    if (m) { if (!__provCache) __provCache = __parseProviders(); return __provCache[m[1]] || null; }
    return null;
  },
  querySelectorAll: (s) => {
    if (s === 'crm-tab[data-tab]') return __tabs;
    if (s === '.dr-panel') return __panels;
    if (s === 'crm-input[data-signal]') return __parseSignals();
    return [];
  },
};
globalThis.location = { href: '', pathname: '/discovery-rules.html', search: '' };
globalThis.window = globalThis;
globalThis.__els = __els;
globalThis.localStorage = { getItem: () => 'stub-token', setItem() {}, removeItem() {}, clear() {} };
__els['providers-body'] = mkEl('providers-body');
__els['signals-body'] = mkEl('signals-body');
__els['intsrc-body'] = mkEl('intsrc-body');
__els['inst-body'] = mkEl('inst-body');
__els['pb-body'] = mkEl('pb-body');
`;

function build(tag) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL(`_dr_render_${tag}.mjs`, dir);
  writeFileSync(file, [
    '// 自动生成（探针产物，勿手改）',
    `const SEQ_TABS = ${JSON.stringify(TABS_INIT)};`,
    `const SEQ_PANELS = ${JSON.stringify(PANELS_INIT)};`,
    // ⚠ 不得无条件重置：主脚本在 build() 前设好的 __nextGet 会被抹掉，
    //   使「失败分支」实际跑成「空数据分支」—— 探针自身制造假绿的经典形态。
    'if (globalThis.__nextGet === undefined) globalThis.__nextGet = null;',
    `const get = async (u) => {
      if (globalThis.__nextGet) return globalThis.__nextGet(u);
      const url = String(u || '');
      if (url.includes('/api/integration/providers')) return globalThis.__integ || { instances: [] };
      return globalThis.__cfg || { value: {} };
    };`,
    'const put = async (p, body) => { globalThis.__lastPut = { path: p, body }; return globalThis.__putResult || { ok: true, value: body && body.value, decision: "d-1" }; };',
    'const post = async (p, body) => { globalThis.__lastPost = { path: p, body }; return { ok: true }; };',
    'const injectLayout = () => {};',
    STUB,
    script.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n'),
  ].join('\n'), 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now() + '_' + tag);
}
const tick = (n = 10) => new Promise((r) => setTimeout(r, n));
const providersHtml = () => globalThis.__els['providers-body']?.innerHTML || '';
const signalsHtml = () => globalThis.__els['signals-body']?.innerHTML || '';
const statusText = () => globalThis.__els['status']?.textContent || '';
const readonlyHint = () => globalThis.__els['readonlyHint']?.textContent || '';
const pbPreview = () => globalThis.__els['pb-preview']?.textContent || '';
const panelOn = (id) => globalThis.__panels.find((p) => p.id === id)?.classList.contains('on');
// 走页面真实的 tab 点击处理器切分区（不绕过分支）
const clickTab = (key) => {
  const t = globalThis.__tabs.find((x) => x.dataset.tab === key);
  if (!t) return false;
  globalThis.__fire(t, 'click', {});
  return true;
};
const clickSave = async () => { globalThis.__lastPut = null; globalThis.__fire(globalThis.__els['saveBtn'], 'click', {}); await tick(12); };

// ── ① tab 切换真接线 ───────────────────────────────────────────────
console.log('\n【① tab 切换真接线（原实现 light DOM 查询恒空 = 点了没反应）】');
globalThis.__nextGet = null;
globalThis.__cfg = { value: REAL_RULES };
await build('real'); await tick();
{
  ok(globalThis.__tabs.length === 6, `解析出 6 个 crm-tab（实际 ${globalThis.__tabs.length}）`);
  ok(panelOn('panel-icp') === true, '初始：面板 1（目标客户画像）.on');
  ok(clickTab('signals') === true, '点第 3 个 crm-tab 走真实处理器');
  ok(panelOn('panel-signals') === true, '面板 3 已 .on');
  ok(panelOn('panel-icp') === false, '面板 1 已关闭（互斥切换）');
  clickTab('integration-sources');
  ok(panelOn('panel-integration-sources') === true, '面板 6 已 .on');
  ok(globalThis.__tabs.filter((t) => t.getAttribute('active') !== null).length === 1, '选中态唯一（active 属性）');
}

// ── ② 现网真值渲染 ─────────────────────────────────────────────────
console.log('\n【② 现网真值（11 数据源 / 7 信号 / ICP）→ 必须渲染出来】');
const buildReal = async () => { globalThis.__nextGet = null; globalThis.__cfg = { value: REAL_RULES }; globalThis.__integ = { instances: [] }; await build('st' + (++buildReal.n)); await tick(); };
buildReal.n = 0;
await buildReal();
{
  const ph = providersHtml();
  const n = (ph.match(/data-provider="/g) || []).length;
  ok(n === REAL_RULES.providers.length, `渲染 ${REAL_RULES.providers.length} 行数据源（实际 ${n}）`);
  const sh = signalsHtml();
  const sn = (sh.match(/data-signal="/g) || []).length;
  ok(sn === Object.keys(REAL_RULES.signals).length, `渲染 ${Object.keys(REAL_RULES.signals).length} 条信号（实际 ${sn}）`);
  ok(/社媒内容/.test(sh), '信号用中文显示名（非裸 key）');
  ok(/type="range"[^>]*value="0\.9"/.test(sh), '信号权重回填真值（funding_round 0.9）');
  ok(globalThis.__els['icp-industries'].value === 'industrial_coatings, chemical, additives', 'ICP 行业回填真值');
  ok(globalThis.__els['icp-headcount'].value === 50, 'ICP 员工规模回填真值（50）');
  ok(globalThis.__els['icp-confidence'].value === 0.6, 'ICP 置信度回填真值（0.6）');
  ok(/linkedin_url/.test(globalThis.__els['dup-account'].value), '企业去重规则回填真值（JSON 二维数组）');
  ok(/external_id/.test(globalThis.__els['dup-contact'].value), '联系人去重规则回填真值');
}

// ── ③ 付费源授权保真（本页最贵的一条）──────────────────────────────
console.log('\n【③ 付费源：渲染色 = 配置真值；保存 payload 不得把已授权源清零】');
{
  const ph = providersHtml();
  const cb = (id) => (ph.match(new RegExp(`<crm-checkbox data-provider="${id}"([^>]*)>`)) || [, ''])[1];
  const rowOf = (id) => (ph.split('<tr').find((s) => s.includes(`data-provider="${id}"`)) || '');
  for (const id of REAL_PAID_AUTHORIZED) {
    ok(/\bchecked\b/.test(cb(id)), `${id}（config_store 已授权 enabled:true）渲染为**已勾选**`);
  }
  for (const id of REAL_PAID_DEFAULTS_OFF) {
    ok(!/\bchecked\b/.test(cb(id)), `${id}（出厂/未授权）渲染为未勾选`);
  }
  ok(/（付费，已授权）/.test(ph) && /（付费，待授权）/.test(ph), '付费源状态文案区分「已授权 / 待授权」（不再一律写「需授权」）');
  ok(!/class="disabled"/.test(rowOf('qixin')), '已授权的付费源行不再整体置灰');
  ok(/class="disabled"/.test(rowOf('clearbit')), '未授权的付费源行仍置灰（视觉区分保留）');

  await clickSave();
  const body = globalThis.__lastPut?.body;
  ok(Boolean(body), '保存处理器确实提交了 payload（未被静默吞掉）');
  const provs = body?.value?.providers || [];
  ok(provs.length === REAL_RULES.providers.length, `提交 ${REAL_RULES.providers.length} 个数据源（实际 ${provs.length}）`);
  const on = provs.filter((p) => p.enabled).map((p) => p.id).sort();
  for (const id of REAL_PAID_AUTHORIZED) {
    ok(provs.find((p) => p.id === id)?.enabled === true,
      `保存后 ${id} 仍 enabled:true（**原缺陷：被静默清零**）`);
  }
  ok(on.includes('tender') && on.includes('gaode'), '系统级数据源启用态保真（tender/gaode）');
  ok(provs.find((p) => p.id === 'qixin')?.scope === 'paid', 'provider 其余字段（scope）保真');
}

// ── ④ 系统级数据源可写（保真 ≠ 冻结）───────────────────────────────
console.log('\n【④ 系统级数据源：勾选变化确实被保存（保真 ≠ 冻结）】');
{
  const box = document.querySelector('crm-checkbox[data-provider="tender"]');
  ok(Boolean(box), '取回 tender 的复选框替身（按渲染产物反解）');
  box.checked = false;                       // 模拟用户取消勾选
  await clickSave();
  const provs = globalThis.__lastPut?.body?.value?.providers || [];
  ok(provs.find((p) => p.id === 'tender')?.enabled === false, '取消勾选后 tender 保存为 enabled:false（用户动作被尊重）');
  ok(provs.find((p) => p.id === 'qixin')?.enabled === true, '同一次保存中已授权付费源仍未被清零');
  box.checked = true;                        // 还原
}

// ── ⑤ playbooks 往返保真 ───────────────────────────────────────────
console.log('\n【⑤ playbooks 表格编辑器往返保真】');
globalThis.__nextGet = null;
globalThis.__cfg = { value: REAL_RULES_WITH_PB };
globalThis.__integ = { instances: [] };
await build('pb'); await tick();
{
  ok(/tender-first/.test(pbPreview()), '只读 JSON 预览渲染出策略名');
  ok(/"data"[\s\S]*tender/.test(pbPreview()), '数组字段（data）已序列化为数组');
  ok(/"match": "tender_match&&funding_round"/.test(pbPreview()), 'match 字段保真');
  await clickSave();
  const pbs = globalThis.__lastPut?.body?.value?.playbooks || [];
  ok(pbs.length === 1, `提交 1 条策略（实际 ${pbs.length}）`);
  ok(pbs[0]?.name === 'tender-first', '策略名保真');
  ok(Array.isArray(pbs[0]?.data) && pbs[0].data.join(',') === 'tender,gaode', 'data 数组保真（未退化成字符串）');
  ok(pbs[0]?.action?.[0] === 'method-followup-engine', 'action 数组保真');
  ok(globalThis.__lastPut?.body?.value?.icp?.min_headcount === 50, '同一次保存中 ICP 保真');
}

// ── ⑥ 未配置(404) 与 加载失败 分流 ─────────────────────────────────
console.log('\n【⑥ 未配置(404) 与 加载失败 必须可区分（假绿防护）】');
{
  globalThis.__nextGet = async () => { const e = new Error('not configured'); e.status = 404; throw e; };
  globalThis.__integ = { instances: [] };
  await build('404'); await tick();
  ok(/尚未配置/.test(statusText()), '404 ⇒ 报「尚未配置」（正常态）');
  ok(/出厂默认值，尚未保存/.test(readonlyHint()), '404 ⇒ 说明当前展示出厂默认');
  ok(!/加载失败/.test(statusText()), '404 不得伪装成加载失败');
  // 出厂默认态下无付费源被授权（D1：出厂恒 false）
  const ph = providersHtml();
  ok(!/\bchecked\b/.test((ph.match(/<crm-checkbox data-provider="qixin"([^>]*)>/) || [, ''])[1]),
    '出厂默认态：qixin 未勾选（D1 铁律：出厂付费源恒 false）');

  globalThis.__nextGet = async () => { const e = new Error('auth required'); e.status = 403; throw e; };
  await build('403'); await tick();
  ok(/加载失败（HTTP 403）/.test(statusText()), '403 ⇒ 报「加载失败（HTTP 403）」（故障态）');
  ok(/auth required/.test(statusText()), '带真实原因（不吞错）');
  ok(!/尚未配置/.test(statusText()), '故障不得伪装成未配置');
  ok(/仅供参考/.test(readonlyHint()), '失败态显式声明下方是出厂默认仅供参考');
}

// ── ⑦ 文案预算：常驻区 ≤160 字 + 全页回归上限 ───────────────────────
console.log('\n【⑦ 文案预算：常驻区 ≤160 字 + 全页回归上限】');
{
  // 判据分两档（2026-09-18 口径）：
  //   ① 常驻区 = 页眉 + 描述行（**不被 tab 隐藏、任何时刻都在屏幕上**）——按项目 ≤160 字 规则卡；
  //   ② 全页可见文案 = 各 tab 分区 hint 之和 —— 属「按需阅读」（点开该 tab 才出现），
  //      故不套 160 字，只设**回归上限**锁住不再膨胀（原「自动策略」块单块 241 字 = 字段级说明书常驻，
  //      已按「机制原理不进常驻区／就近声明优于远程解释」收敛为表头 + placeholder）。
  const resident = stripAll((html.match(/<header class="page-head"[\s\S]*?<\/header>\s*<p class="page-sub">[\s\S]*?<\/p>/) || [''])[0]);
  ok(resident.length <= 160, `常驻区（页眉 + 描述行）≤160 字（实际 ${resident.length} 字）`);
  const text = stripAll(html);
  // 上限口径：常驻区 57 字 + 6 个 tab 分区（默认隐藏、点开才读）≈1300 ⇒ 1400 为回归上限（锁住不再膨胀）。
  //   不为凑整数字删减可用信息（那是优化指标而非优化用户体验）；要再降须先裁掉某个分区的实质说明。
  const CAP = 1400;
  ok(text.length <= CAP, `全页可见文案 ≤${CAP} 字回归上限（实际 ${text.length} 字）`);
  // 「自动策略」块曾被写成字段级说明书（241 字）；契约要求「出厂不预置」被保留，但不再承载语法手册
  const pbHint = stripAll((html.match(/<div class="hint" data-page-node-id="gLc8zBxGiPuSsR33HeQxdX">([\s\S]*?)<\/div>/) || [, ''])[1]);
  ok(pbHint.length <= 80, `自动策略 hint ≤80 字（实际 ${pbHint.length} 字）—— 语法走表头/placeholder 就近声明`);
  ok(/出厂不预置/.test(pbHint), '「出厂不预置」提示保留（[] 是正常态而非故障）');
}

console.log(`\n===== 探针结果：${pass} 通过 / ${fail} 失败 =====`);

// ── 变异自证：探针必须能把「已知缺陷形态」逐类打红 ────────────────────
if (process.argv.includes('--selftest')) {
  console.log('\n【变异自证】基线必须全绿，且每个变异体必须被打红');
  if (fail) { console.log('🔴 基线非全绿（' + fail + ' 条失败），自证无意义'); process.exit(1); }
  const MUTS = [
    { name: '黄块回流（page-sub → .note 实底块）', from: '<p class="page-sub">', to: '<div class="note">' },
    { name: '付费源授权静默清零（保存即撤销已授权源）', from: "if (p.scope === 'paid') return { ...p, enabled: p.enabled === true };", to: "if (p.scope === 'paid') return { ...p, enabled: false };" },
    { name: '付费源渲染色写死（界面与配置相互撒谎）', from: "const tail = paid ? (p.enabled ? ' <span class=\"muted\">（付费，已授权）</span>' : ' <span class=\"muted\">（付费，待授权）</span>') : '';", to: "const tail = paid ? ' <span class=\"muted\">（付费，需授权）</span>' : '';" },
    { name: 'tab 死区（crm-tab → light DOM 恒空查询）', from: "document.querySelectorAll('crm-tab[data-tab]')", to: "document.querySelectorAll('.tabs button')" },
    { name: '控件退化（crm-checkbox → 裸 input）', from: '<crm-checkbox data-provider="${esc(p.id)}"', to: '<input data-provider="${esc(p.id)}"' },
    { name: 'shadow 不可达变体类（btn → crm-btn）', from: 'class="btn primary" id="pb-add"', to: 'class="crm-btn" id="pb-add"' },
    { name: '重声明保留类 .panel', from: '.dr-panel { display: none; }', to: '.dr-panel { display: none; }\n  .panel { border: 0; }' },
    { name: '未定义 token + 浅色 fallback', from: '.hint { color: var(--mut);', to: '.hint { color: var(--warn-ink, #a16207);' },
    { name: 'datalist 回流（与 crm-* 不可组合）', from: '<div class="sect-title" data-page-node-id="HU1j8il85iNUTF8Wyq2SEx">', to: '<datalist id="x"></datalist><div class="sect-title" data-page-node-id="HU1j8il85iNUTF8Wyq2SEx">' },
    { name: '死区面板回流（.panel 无 id）', from: '  <crm-tabs data-page-node-id="bRGy0GJQQ9zhHkJgPSZYcZ">', to: '  <div class="panel">从来不可见</div>\n  <crm-tabs data-page-node-id="bRGy0GJQQ9zhHkJgPSZYcZ">' },
  ];
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  let bad = 0;
  for (const [i, mu] of MUTS.entries()) {
    if (!html.includes(mu.from)) {
      console.log(`  🔴 变异 ${i + 1}「${mu.name}」未生效：源串未匹配（探针与页面已漂移，自证失效）`);
      bad++; continue;
    }
    const file = new URL(`_dr_mut_${i + 1}.html`, dir);
    writeFileSync(file, html.replace(mu.from, mu.to), 'utf8');
    const r = spawnSync(process.execPath, ['scripts/verify-discovery-rules-config-render.mjs'],
      { env: { ...process.env, DR_HTML: 'tmp/_dr_mut_' + (i + 1) + '.html' }, encoding: 'utf8' });
    const hit = r.status === 1;
    if (!hit) bad++;
    console.log(`  ${hit ? '✅' : '🔴'} 变异 ${i + 1}「${mu.name}」${hit ? '被打红（探针有鉴别力）' : '未被发现（探针假绿！）'}`);
  }
  console.log(bad ? `\n🔴 变异自证未通过：${bad} 项` : `\n✅ 变异自证通过：${MUTS.length}/${MUTS.length} 类缺陷均被打红`);
  process.exit(bad ? 1 : 0);
}

process.exit(fail ? 1 : 0);
