# 实施计划：CRM 平台 UI 架构级封死（Web Component 单一来源 + lint/hook）

- **日期**：2026-08-29
- **依据 SPEC**：`docs/specs/2026-08-29-ui-arch-lock-design.md`（已批准）
- **性质**：writing-plans 产物；本文件含每批完整代码，可直接执行。
- **提交说明**：沙箱无 git 凭证，AI 不提交；每批完成后由用户本地 `git add` / `git commit`（建议每批独立一 commit）。

---

## §0 与 SPEC 的实现澄清（偏离 / 修正）

| # | SPEC 原文 | 本计划修正 | 原因 |
|---|---|---|---|
| C1 | §3.1 `crm-input`「包裹式 `crm-input > input`，slot 投影」 | `crm-input` / `crm-textarea` 改为**属性驱动**：`<crm-input placeholder="…" value="…">`，shadow 内单元素 + 属性 mirror（light DOM 不写 `<input>`） | `<input>`/`<textarea>` **不能含子节点**，slot 投影到 input 内部无效（HTML 语义非法）。`crm-select` 仍用 slot 投影（`<select><option>` 合法）。不影响 G1–G4。 |
| C2 | §3.2 `crm-tab` 内部 `<button><slot></slot></button>` | 保留；`active` 属性经 mirror 映射到 shadow button 的 `className`（`.tab.active`），保证高亮与现有 `.tab.active` 视觉一致 | shadow 隔离，light `.crm-tab.active` 样式无法穿透 shadow，必须 mirror |
| C3 | §2.1 仅在 `layout.js` 顶部 `import './components.js'` | 额外：**迁移脚本给每个 html 的 `<head>` 注入 `<script type="module" src="/portal/components.js"></script>`**（若缺失） | 约 50 页经 layout.js，但 home.html / portal-stage3-mockup.html 等少数页未引入 layout.js；head 注入与 layout.js import 双重保障，components.js 用 `customElements.get` 守卫防重复定义报错 |
| C4 | §2.4 提供 `.stylelintrc.json` + `scripts/ui-lint.mjs` | **以 `scripts/ui-lint.mjs` 为主**（零依赖自写正则扫描，可在 pre-commit/CI 直接跑）；`.stylelintrc.json` 仅作约定留存，不依赖 npm 安装 | stylelint 对 HTML 内联 `<style>` 需额外插件，环境无 npm 安装权限；自写脚本零依赖、可立即执行、报错即停 |

> C1–C4 均为实现细节澄清，未改变 SPEC 的「架构级封死」目标与 G1–G4 验收口径。

---

## §1 文件清单与分批（对应 SPEC §7）

| 批 | 新建/改动文件 | 验收 |
|---|---|---|
| 1 | `src/web/tokens.css`（补全局基底）· `src/web/util.js`（新建）· `src/web/components.js`（新建） | 单组件本地页验证：无白底、value/事件透传 |
| 2 | `scripts/migrate-ui-wc.mjs`（新建）+ 业务页（pipeline / account-360 / my-todo / sales-decision-monitor / 5 详情页）迁移 | 关键页冒烟通过 |
| 3 | 其余 40+ 页迁移 + 本地类清理（`common.css` 沉淀） | 全站无白底 / 散写 |
| 4 | `scripts/ui-lint.mjs`（新建）· `.stylelintrc.json`（新建）· `.git/hooks/pre-commit`（新建） | lint 拦违规、可独立运行 |
| 5 | 回归：关键页浏览器冒烟 + 后端 vitest 全量 | 视觉一致、无回归 |

**不改动**：`layout.js` 顶栏/侧栏逻辑（仅追加 components.js 引入）、`routes.js`、后端。

---

## 批 1：基础件（tokens 基底 + util + components）

### 1.1 `src/web/tokens.css` 顶部补全局基底（在 `:root{…}` 前插入）

```css
/* ── UI 封死全局基底（2026-08-29）：color-scheme:dark + 原生元素深色兜底 ──
   作用：WC 迁移空窗期，未覆盖的原生 select/input/textarea/button 也深色，白底从根消失。
   WC 全面铺开后保留为安全网。 */
:root{ color-scheme: dark; }
select,input,textarea,button{
  background:var(--panel); color:var(--ink);
  border:1px solid var(--line); border-radius:8px;
  font-family:var(--font); font-size:14px;
}
select:focus,input:focus,textarea:focus,button:focus{ outline:2px solid var(--ac); outline-offset:1px; }
```

> 注意：`tokens.css` 已有 `:root{…}` 定义变量；本段插在其**之前**，不改动既有变量。

### 1.2 `src/web/util.js`（新建，金额/数字唯一来源 — SPEC §2.5）

```js
// src/web/util.js — 格式化单一来源（根治 SPEC R3：金额/数字 JS 拼接乱序）
export const fmtMoney = (n, { sign = false } = {}) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const s = v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return (sign && v > 0 ? '+' : '') + '¥' + s; // 单位右置、无空格粘连
};
export const fmtNum = (n, unit = '') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN') + (unit ? ' ' + unit : '');
};
export const fmtPct = (n, digits = 1) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v * 100).toLocaleString('zh-CN', { maximumFractionDigits: digits }) + '%';
};
```

### 1.3 `src/web/components.js`（新建，全部 `crm-*` 纯样式壳 — SPEC §3）

```js
// src/web/components.js — Web Component 单一来源（纯样式壳；注册幂等，可重复 import）
// 形态契约（SPEC §3.3）：shadow DOM 仅做样式隔离，value/disabled/事件 100% 透传冒泡。
// 自定义元素不改事件传播链，无需手动 redispatch；shadow 内原生元素事件自动冒泡出 host。

const T = `  /* tokens 引用（与 common.css 同源） */
  :host{ display:inline-block; }
  select,input,textarea,button{
    width:100%; box-sizing:border-box;
    background:var(--panel); color:var(--ink);
    border:1px solid var(--line); border-radius:8px;
    padding:8px 10px; font-size:13px; font-family:var(--font); outline:none;
  }
  select{ color-scheme:dark; appearance:auto; cursor:pointer; }
  select:focus,input:focus,textarea:focus,button:focus{ border-color:var(--ac); }
  button{ background:var(--panel); cursor:pointer; font-weight:600; }
  button.primary{ background:var(--ac); border-color:var(--ac); color:var(--on-ac); }
  button.ghost{ background:transparent; color:var(--mut); }
  button.danger{ background:transparent; border-color:var(--err); color:var(--err); }
  button[disabled]{ opacity:.5; cursor:not-allowed; }`;

const CARD = `:host{ display:block; }
  .card{ background:var(--panel); border:1px solid var(--line);
    border-radius:var(--radius-lg); padding:16px; box-shadow:var(--shadow); }`;
const TABLE = `:host{ display:block; }
  .wrap{ background:var(--panel); border:1px solid var(--line);
    border-radius:var(--radius-lg); overflow:auto; }
  table{ width:100%; border-collapse:collapse; font-size:13px; }
  th,td{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th{ color:var(--mut); font-weight:600; }
  tr:hover td{ background:#16233b; }`;
const TABS = `:host{ display:block; }
  .tabs{ display:flex; gap:2px; border-bottom:1px solid var(--line); margin-bottom:14px; }
  .tab{ padding:9px 14px; font-size:13px; color:var(--mut); cursor:pointer;
    border-bottom:2px solid transparent; background:transparent; border-top:none;
    border-left:none; border-right:none; font-family:var(--font); }
  .tab.on,.tab.active{ color:var(--ac); border-bottom-color:var(--ac); }`;

function defineIf(name, cls){ if (!customElements.get(name)) customElements.define(name, cls); }

// ── crm-select：slot 投影 light <option> 进 shadow <select> ──
class CrmSelect extends HTMLElement {
  static observedAttributes = ['value', 'disabled'];
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const s = document.createElement('select');
    const slot = document.createElement('slot');
    s.appendChild(slot);
    const style = document.createElement('style'); style.textContent = T;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.append(style, s);
    if (this.hasAttribute('value')) s.value = this.getAttribute('value');
    if (this.hasAttribute('disabled')) s.disabled = true;
  }
  get value(){ return this.shadowRoot?.querySelector('select')?.value ?? ''; }
  set value(v){ const s = this.shadowRoot?.querySelector('select'); if (s) s.value = v ?? ''; }
  attributeChangedCallback(n, _o, v){
    const s = this.shadowRoot?.querySelector('select'); if (!s) return;
    if (n === 'value') s.value = v ?? '';
    if (n === 'disabled') s.disabled = this.hasAttribute('disabled');
  }
}
// ── crm-input：属性驱动（shadow 单 input），C1 修正 ──
class CrmInput extends HTMLElement {
  static observedAttributes = ['placeholder', 'value', 'disabled', 'type'];
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const i = document.createElement('input');
    const style = document.createElement('style'); style.textContent = T;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.append(style, i);
    for (const a of ['placeholder', 'value', 'disabled', 'type']) this._apply(a, this.getAttribute(a));
  }
  _apply(n, v){
    const i = this.shadowRoot?.querySelector('input'); if (!i) return;
    if (n === 'disabled') i.disabled = this.hasAttribute('disabled');
    else if (n === 'type') i.type = v || 'text';
    else i[n] = v ?? '';
  }
  get value(){ return this.shadowRoot?.querySelector('input')?.value ?? ''; }
  set value(v){ const i = this.shadowRoot?.querySelector('input'); if (i) i.value = v ?? ''; }
  attributeChangedCallback(n, _o, v){ this._apply(n, v); }
}
// ── crm-textarea：属性驱动（shadow 单 textarea），C1 修正 ──
class CrmTextarea extends HTMLElement {
  static observedAttributes = ['placeholder', 'value', 'disabled'];
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const t = document.createElement('textarea');
    const style = document.createElement('style'); style.textContent = T;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.append(style, t);
    for (const a of ['placeholder', 'value', 'disabled']) this._apply(a, this.getAttribute(a));
  }
  _apply(n, v){
    const t = this.shadowRoot?.querySelector('textarea'); if (!t) return;
    if (n === 'disabled') t.disabled = this.hasAttribute('disabled');
    else t[n] = v ?? '';
  }
  get value(){ return this.shadowRoot?.querySelector('textarea')?.value ?? ''; }
  set value(v){ const t = this.shadowRoot?.querySelector('textarea'); if (t) t.value = v ?? ''; }
  attributeChangedCallback(n, _o, v){ this._apply(n, v); }
}
// ── crm-button：shadow <button><slot></slot></button> ──
class CrmButton extends HTMLElement {
  static observedAttributes = ['variant', 'disabled'];
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const b = document.createElement('button');
    const slot = document.createElement('slot'); b.appendChild(slot);
    const style = document.createElement('style'); style.textContent = T;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.append(style, b);
    if (this.hasAttribute('variant')) b.className = this.getAttribute('variant');
    if (this.hasAttribute('disabled')) b.disabled = true;
  }
  attributeChangedCallback(n, _o, v){
    const b = this.shadowRoot?.querySelector('button'); if (!b) return;
    if (n === 'variant') b.className = v || '';
    if (n === 'disabled') b.disabled = this.hasAttribute('disabled');
  }
}
// ── crm-card / crm-table / crm-tabs / crm-tab：slot 投影容器 ──
class CrmCard extends HTMLElement {
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const d = document.createElement('div'); d.className = 'card';
    d.appendChild(document.createElement('slot'));
    const style = document.createElement('style'); style.textContent = CARD;
    this.attachShadow({ mode: 'open' }); this.shadowRoot.append(style, d);
  }
}
class CrmTable extends HTMLElement {
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const w = document.createElement('div'); w.className = 'wrap';
    w.appendChild(document.createElement('slot'));
    const style = document.createElement('style'); style.textContent = TABLE;
    this.attachShadow({ mode: 'open' }); this.shadowRoot.append(style, w);
  }
}
class CrmTabs extends HTMLElement {
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const d = document.createElement('div'); d.className = 'tabs';
    d.appendChild(document.createElement('slot'));
    const style = document.createElement('style'); style.textContent = TABS;
    this.attachShadow({ mode: 'open' }); this.shadowRoot.append(style, d);
  }
}
class CrmTab extends HTMLElement {
  static observedAttributes = ['active', 'variant'];
  connectedCallback(){
    if (this._inited) return; this._inited = true;
    const b = document.createElement('button'); b.className = 'tab';
    b.appendChild(document.createElement('slot'));
    const style = document.createElement('style'); style.textContent = TABS;
    this.attachShadow({ mode: 'open' }); this.shadowRoot.append(style, b);
    if (this.hasAttribute('active')) b.classList.add('active'); // C2
  }
  attributeChangedCallback(n, _o, v){
    const b = this.shadowRoot?.querySelector('button'); if (!b) return;
    if (n === 'active') b.classList.toggle('active', this.hasAttribute('active'));
  }
}

// 注册（幂等）
export function registerComponents(){
  defineIf('crm-select', CrmSelect);
  defineIf('crm-input', CrmInput);
  defineIf('crm-textarea', CrmTextarea);
  defineIf('crm-button', CrmButton);
  defineIf('crm-card', CrmCard);
  defineIf('crm-table', CrmTable);
  defineIf('crm-tabs', CrmTabs);
  defineIf('crm-tab', CrmTab);
}
registerComponents();
```

### 1.4 `layout.js` 顶部追加引入（SPEC §2.1，C3 冗余）

在 `layout.js` 第 1 行注释后、import 段前插入：
```js
import { registerComponents } from './components.js';
registerComponents();
```
> `components.js` 顶层已自执行 `registerComponents()`，`layout.js` 再 import 仅触发模块副作用（幂等）。

---

## 批 2：迁移脚本 + 业务页迁移

### 2.1 `scripts/migrate-ui-wc.mjs`（新建，一次性，可重跑幂等）

算法（逐文件、逐规则；仅改静态 HTML 结构，跳过含 `${` 的 JS 模板串行）：

1. **head 注入 components.js**（C3）：若 `<head>` 内无 `/portal/components.js`，在 `</head>` 前插入
   `<script type="module" src="/portal/components.js"></script>`。
2. **裸 `<select …>…</select>` → `<crm-select …>…</crm-select>`**（标签名替换，保留属性与 `<option>` 子节点）。
3. **裸 `<input …>` → `<crm-input …></crm-input>`**（C1：去掉内部内容，转成对标签，保留属性）。
4. **裸 `<textarea …>…</textarea>` → `<crm-textarea …>…</crm-textarea>`**。
5. **button 分类**：
   - 含 `class="tab"` 或属性 `data-view` / `data-page-tab` / `data-v` → `<crm-tab …>`（保留属性与文本）；
   - 其余 `<button>` → `<crm-button>`。
6. **本地类清理（标记 + 删除空定义）**：识别 `<style>` 中已知本地组件类（白名单 `LOCAL_CLASSES = ['kpi-block','insight-overview','stage-drawer','gate','dn-','cal-','wb-container','pg-form','pg-attr-field']` 前缀匹配），删除其空/孤立定义块；**具体样式迁移 `common.css` 由人工完成**（脚本仅报告，不自动搬）。
7. **金额/数字拼接替换**（JS 块静态）：`'¥'+n.toLocaleString(...)` / `'¥'+n` → `fmtMoney(n)`；`n+'¥'` / `n.toLocaleString()+'¥'` → `fmtMoney(n)`；并在文件引入处补 `import { fmtMoney, fmtNum } from '/portal/util.js'`（若尚未引入）。
8. **跳过规则**：含 `${` 的行视为 JS 模板串，跳过标签替换（避免误伤动态生成），仅记录到 `migrate-report.log` 供人工复核。

输出：每文件改动清单 + `migrate-report.log`（含跳过项与本地类清单）。

### 2.2 业务页人工适配点（迁移脚本后逐页核对）

| 页 | 关键适配 |
|---|---|
| `pipeline.html` | `ndCustTier`/`ndProjTier` 的 `change` 联动（SPEC R-script）：迁移后 `querySelector('#ndCustTier')` 拿 crm-select，`.value`/`.addEventListener('change')` 仍可用（§3.3 透传）。`ndAmount` number input → crm-input `type="number"`。`¥'+n.toLocaleString` → `fmtMoney`。`.kpi-block/.insight-overview/.stage-drawer` 本地类删，结构改 `crm-card`。 |
| `account-360.html` | `#account-select` → `crm-select`；「800,000 ¥」渲染 → `fmtMoney` 单位右置。 |
| `my-todo.html` / `workbench.html` | `<button class="tab" data-view=…>` → `<crm-tab data-view=…>`；JS 取 `.tab` 改 `.crm-tab` 或保留 `[data-view]` 选择器（属性透传）。 |
| `sales-decision-monitor.html` | 3 个裸 select → crm-select；`#calibration select` 局部定义删；`<button class="tab" data-page-tab>` → crm-tab；动态生成的 `<button class="dn-tab ...">`（模板串）脚本跳过，人工改或保留（dn-* 为网络图专用，可留白名单）。 |
| 详情页（deal/quotation/contract/order/payment/invoice） | 各自裸 select/input/button → crm-*；金额渲染 → fmtMoney。 |

> 每页迁移独立，单页 `git checkout` 可回退（SPEC §4.4）。

---

## 批 3：全站 40+ 页迁移 + 本地类清理

- 复用 `scripts/migrate-ui-wc.mjs` 跑全站 57 个 html（排除批 2 已处理）。
- 本地类最终清理：把 `common.css` 缺少但多页共用的卡片/表格样式沉淀进 `common.css`（如 `.kpi-grid`/`.insight` 等），页面 `<style>` 删除对应定义。
- 人工复核 `migrate-report.log` 的跳过项（JS 模板串内的标签 / `#ddd` 内联浅灰）。

---

## 批 4：lint / hook 硬拦截（SPEC §2.4，C4 以 ui-lint.mjs 为主）

### 4.1 `scripts/ui-lint.mjs`（新建，零依赖，pre-commit/CI 直接跑）

检查项：
1. 每个 `src/web/*.html` 的 `<head>` 必须含 `/portal/components.js` + `/portal/tokens.css` + `/portal/common.css`。
2. `<title>` 不含 emoji（正则 `/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u`）。
3. `<style>` 内禁止非白名单 class 选择器：白名单 = `common.css` 已有类（从 common.css 解析 `.xxx`） + `crm-*` + 页级骨架（`.page-head/.sect/.ph-*` 等） + 动画/布局微调（`@keyframes`/`.fadein`/`.kpi-*` 等允许集，由 `ALLOW` 数组固定）。
4. 裸 `<select`/`<input`/`<textarea`/`<button`（不在 `<crm-*` 内、非 JS 模板串） → 失败并报告文件+行号。
5. 退出码：有违规 `process.exit(1)`，否则 0。

### 4.2 `.stylelintrc.json`（新建，约定留存）

```json
{
  "rules": {
    "selector-class-pattern": "^[a-z][a-z0-9-]*$",
    "comment-empty-line-before": "always"
  },
  "ignoreFiles": ["src/web/page.css"]
}
```
> 仅作约定；真正拦截以 `ui-lint.mjs` 为准（C4）。

### 4.3 `.git/hooks/pre-commit`（新建，用户本地安装）

```sh
#!/bin/sh
# UI 架构级封死：提交前拦截违规（SPEC §2.4）
node scripts/ui-lint.mjs
if [ $? -ne 0 ]; then
  echo "❌ UI lint 失败：请先修复上述违规（见 scripts/ui-lint.mjs 输出）。"
  exit 1
fi
```
> 用户本地 `chmod +x .git/hooks/pre-commit` 启用。

---

## 批 5：回归与验收（SPEC §5）

- **G1**：全站无白色原生控件（下拉框/输入框/按钮深色一致）—— 浏览器逐页冒烟（关键页：pipeline / account-360 / my-todo / sales-decision-monitor / 5 详情页 / config / seven-dim / decision-scenarios）。
- **G2**：`node scripts/ui-lint.mjs` 全绿（无散写非白名单 class、无裸元素）。
- **G3**：金额统一 `fmtMoney`（单位右置、无空格粘连）；数字统一 `fmtNum`。
- **G4**：现有交互（`change/input/表单提交`）正常——纯样式壳保证；重点验 `pipeline` 的 `ndCustTier` 联动、`my-todo` tab 切换、`sales-decision-monitor` 校准 select。
- **回归**：后端 vitest 全量（398 基线）确保无回归；前端无单测，靠关键页实测。

---

## §2 风险应对（SPEC §6）

| 风险 | 缓解（本计划细化） |
|---|---|
| R-slot（change 冒泡） | 内部真 select/input/button 原生冒泡，不手动 redispatch；`crm-select.value` getter 读 shadow select；逐页测 change 链路 |
| R-mirror（value/disabled 同步） | 仅 mirror `observedAttributes` 精确集合；`connectedCallback` 末尾补 mirror 一次 |
| R-script（误伤） | 跳过含 `${` 的模板串行；单页 `git checkout` 回退；`migrate-report.log` 留痕 |
| R-safari（兼容性） | 统一独立 `crm-*` 标签，不用 `is=` customized built-in |
| form 提交（crm-* 非 form-associated） | 本平台表单多为 JS 手动读 `.value`，影响小；如需 `formAssociated` 后续增强（不在本批范围） |
