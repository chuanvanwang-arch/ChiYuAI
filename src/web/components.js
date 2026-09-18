// src/web/components.js — Web Component 单一来源（纯样式壳；注册幂等，可重复 import）
// 形态契约（SPEC §3.3）：shadow DOM 仅做样式隔离，value/disabled 100% 透传。
// 事件透传：click 等 composed:true 事件自动冒泡出 host；但 change/input 的 composed 为 false，
// 不会穿过 shadow 边界，故各表单组件需在 shadow 内监听并以 composed:true 手动转发（见 connectedCallback）。
// 修正计划 §2 R-slot「不手动 redispatch」的错误假设——否则外部 change/input 联动全部失效。

const T = `  /* tokens 引用（与 common.css 同源，CSS 变量穿透 shadow 边界） */
  :host{ display:inline-block; }
  select,input,textarea,button{
    width:100%; box-sizing:border-box;
    background:var(--panel); color:var(--ink);
    border:1px solid var(--line); border-radius:8px;
    padding:8px 10px; font-size:13px; font-family:var(--font); outline:none;
  }
  select{ color-scheme:dark; appearance:auto; cursor:pointer; }
  /* 弹层（<option> 列表）须单独着色：只设 select 的 background 不覆盖弹层，
     而 color 会被 option 继承浅色 → 浅字落白底不可读（2026-09-16 用户截图实证）。
     shadow 内无法继承宿主样式，故与 tokens.css 同口径在此显式成对声明 background+color。 */
  select option,select optgroup{ background:var(--panel); color:var(--ink); }
  select:focus,input:focus,textarea:focus,button:focus{ border-color:var(--ac); }
  button{ background:var(--panel); cursor:pointer; font-weight:600; }
  button.primary{ background:var(--ac); border-color:var(--ac); color:var(--on-ac); }
  button.ghost{ background:transparent; color:var(--mut); }
  button.danger{ background:transparent; border-color:var(--err); color:var(--err); }
  button[disabled]{ opacity:.5; cursor:not-allowed; }
  /* 透传宿主 class 后须在 shadow 内重定义按钮变体：页内 .btn-primary/.ok/.cancel/.drawer-close/.btn-ghost 等
     选择器位于 light DOM，无法穿透 shadow 边界，故在 shadow 内镜像同名规则，保证迁移后视觉一致 */
  button.btn-primary{ background:var(--ac); border:0; color:#fff; font-weight:600; }
  button.btn-ghost{ background:transparent; color:var(--mut); }
  button.ok{ background:var(--ac); border-color:var(--ac); color:#fff; font-weight:600; }
  button.cancel{ background:var(--panel); color:var(--mut); }
  button.drawer-close{ border:0; background:transparent; color:var(--mut); font-size:16px; line-height:1; cursor:pointer; }
  button.drawer-close:hover{ color:var(--ac); }
  button.sec{ background:transparent; color:var(--mut); }
  /* 设计系统保留类 .btn 在 shadow 内镜像：crm-button class="btn" 须保持 common.css 的 .btn 观感 */
  button.btn{ display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:8px; padding:7px 14px; font-size:13px; font-weight:600; cursor:pointer; transition:border-color .15s,background .15s; }
  button.btn:hover{ border-color:var(--ac); }
  button.btn.primary{ background:var(--ac); border-color:var(--ac); color:var(--on-ac); }
  button.btn.primary:hover{ background:var(--ac-hover); }
  button.btn.ghost{ background:transparent; color:var(--mut); }
  button.btn.danger{ background:transparent; border-color:var(--err); color:var(--err); }
  /* 页内按钮变体镜像（宿主 class 透传到 shadow button 后方可生效）：补齐各页用到的非保留变体 */
  button.snap-write-btn{ background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:2px 8px; font-size:11px; color:var(--ac); cursor:pointer; }
  button.cta{ width:100%; border:1px solid var(--accent); color:var(--accent); background:var(--panel); border-radius:9px; padding:8px; font-weight:600; cursor:pointer; }
  button.cta:active{ background:var(--accent-soft); }
  button.on{ background:var(--ac); color:var(--on-ac); border-color:var(--ac); }
  button.dn-close{ background:var(--panel); border:1px solid var(--line); color:var(--ink); border-radius:6px; width:28px; height:28px; line-height:1; font-size:16px; cursor:pointer; margin-left:12px; }
  button.dn-close:hover{ color:var(--err); }
  button.dn-drawer-close{ background:transparent; border:1px solid var(--line); color:var(--ink); border-radius:6px; width:28px; height:28px; font-size:16px; cursor:pointer; }
  button.dn-drawer-close:hover{ color:var(--err); border-color:var(--err); }`;

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

// 浏览器外（Node/vitest 无 jsdom）导出一个空注册函数，避免 class extends HTMLElement 触发 ReferenceError。
export function registerComponents(){}

const IS_BROWSER = typeof window !== 'undefined' && typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined';

if (IS_BROWSER) {
  function defineIf(name, cls){ if (!customElements.get(name)) customElements.define(name, cls); }

  // ── crm-select：shadow <select> 镜像 light DOM <option> ──
  // 原 slot 投影方案在 select 元素内无效：浏览器不会把 <slot> 的分配节点当作 option 渲染标签。
  // 改为 MutationObserver 同步克隆，外部 set innerHTML 仍然工作，且选中态、change 事件均正常。
  class CrmSelect extends HTMLElement {
    static formAssociated = true;
    static observedAttributes = ['value', 'disabled'];
    connectedCallback(){
      if (this._inited) return; this._inited = true;
      const s = document.createElement('select');
      const style = document.createElement('style'); style.textContent = T;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.append(style, s);
      this._select = s;
      this._internals = this.attachInternals();
      this._defaultValue = this.getAttribute('value') ?? '';
      this._syncOptions();
      if (this.hasAttribute('value')) s.value = this.getAttribute('value');
      if (this.hasAttribute('disabled')) s.disabled = true;
      // change 事件 composed:false，手动以 composed:true 转发出 host，外部监听可收到（target=host）
      s.addEventListener('change', () => this.dispatchEvent(new Event('change', { bubbles: true, composed: true })));
      s.addEventListener('change', () => this._syncForm());
      this._mo = new MutationObserver(() => this._syncOptions());
      this._mo.observe(this, { childList: true, subtree: true, characterData: true });
    }
    _syncOptions(){
      const s = this._select; if (!s) return;
      const oldVal = s.value;
      s.innerHTML = '';
      for (const opt of this.querySelectorAll('option')) s.appendChild(opt.cloneNode(true));
      // 优先保持原选中，否则回退到宿主 value 属性，再回退到 light DOM 中带 selected 的 option
      const target = this.getAttribute('value') ?? this.querySelector('option[selected]')?.value ?? oldVal;
      if (target) s.value = target;
      this._syncForm();
    }
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      this._internals.setFormValue(this._select?.value ?? '');
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ if (this._select) this._select.value = this._defaultValue; this._syncForm(); }
    get value(){ return this._select?.value ?? ''; }
    set value(v){ if (this._select) this._select.value = v ?? ''; this._syncForm(); }
    // 覆盖 innerHTML：外部 set innerHTML 后必须立即同步 shadow options，
    // 否则 MutationObserver 异步回调会导致紧接着的 value 赋值失败（shadow 尚无 option）。
    get innerHTML(){ return super.innerHTML; }
    set innerHTML(v){ super.innerHTML = v; this._syncOptions(); }
    attributeChangedCallback(n, _o, v){
      const s = this._select; if (!s) return;
      if (n === 'value') s.value = v ?? '';
      if (n === 'disabled') s.disabled = this.hasAttribute('disabled');
    }
    disconnectedCallback(){ this._mo?.disconnect(); }
  }
  // ── crm-input：属性驱动（shadow 单 input），C1 修正 ──
  class CrmInput extends HTMLElement {
    static formAssociated = true;
    static observedAttributes = ['placeholder', 'value', 'disabled', 'type', 'min', 'max', 'step', 'required', 'name', 'readonly', 'autocomplete', 'inputmode'];
    connectedCallback(){
      if (this._inited) return; this._inited = true;
      const i = document.createElement('input');
      const style = document.createElement('style'); style.textContent = T;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.append(style, i);
      this._internals = this.attachInternals();
      this._defaultValue = this.getAttribute('value') ?? '';
      for (const a of ['placeholder', 'value', 'disabled', 'type', 'min', 'max', 'step', 'readonly', 'autocomplete']) this._apply(a, this.getAttribute(a));
      // input 事件 composed:false，手动以 composed:true 转发出 host
      i.addEventListener('input', () => this.dispatchEvent(new Event('input', { bubbles: true, composed: true })));
      i.addEventListener('input', () => this._syncForm());
    }
    _apply(n, v){
      const i = this.shadowRoot?.querySelector('input'); if (!i) return;
      if (n === 'disabled') i.disabled = this.hasAttribute('disabled');
      else if (n === 'type') i.type = v || 'text';
      else if (n === 'min') i.min = v ?? '';
      else if (n === 'max') i.max = v ?? '';
      else if (n === 'step') i.step = v ?? '';
      else if (n === 'readonly') i.readOnly = this.hasAttribute('readonly');
      else if (n === 'inputmode') i.inputMode = v ?? 'text';
      else i[n] = v ?? '';
      if (n === 'value' || n === 'required') this._syncForm();
    }
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      const v = this.shadowRoot?.querySelector('input')?.value ?? '';
      this._internals.setFormValue(v);
      if (this.hasAttribute('required')) this._internals.setValidity(v ? {} : { valueMissing: true }, v ? '' : '必填', this.shadowRoot.querySelector('input'));
      else this._internals.setValidity({});
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ const i = this.shadowRoot?.querySelector('input'); if (i) i.value = this._defaultValue; this._syncForm(); }
    get value(){ return this.shadowRoot?.querySelector('input')?.value ?? ''; }
    set value(v){ const i = this.shadowRoot?.querySelector('input'); if (i) i.value = v ?? ''; this._syncForm(); }
    attributeChangedCallback(n, _o, v){ this._apply(n, v); }
  }
  // ── crm-checkbox：shadow <label><input type=checkbox><slot></slot></label> ──
  class CrmCheckbox extends HTMLElement {
    static formAssociated = true;
    static observedAttributes = ['checked', 'disabled', 'value', 'name'];
    connectedCallback(){
      if (this._inited) return; this._inited = true;
      const i = document.createElement('input'); i.type = 'checkbox';
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--ink);font-size:13px;';
      lbl.appendChild(i);
      lbl.appendChild(document.createElement('slot'));
      const style = document.createElement('style');
      style.textContent = `:host{ display:inline-flex; }
        input{ accent-color:var(--ac); width:16px; height:16px; cursor:pointer; }
        :host([disabled]){ opacity:.5; cursor:not-allowed; }`;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.append(style, lbl);
      this._internals = this.attachInternals();
      if (this.hasAttribute('value')) i.value = this.getAttribute('value');
      if (this.hasAttribute('checked')) i.checked = true;
      if (this.hasAttribute('disabled')) i.disabled = true;
      // change 事件 composed:false，手动以 composed:true 转发出 host，外部监听可收到
      i.addEventListener('change', () => this.dispatchEvent(new Event('change', { bubbles: true, composed: true })));
      i.addEventListener('change', () => this._syncForm());
      // 点击宿主或投影文字（非内部 input）时同步切换，恢复 <label> 包裹 input 的“点文字切换”行为。
      // ⚠ 判据必须用 composedPath 而非 e.target：shadow 事件离开 shadow root 时 target 被重定向为宿主，
      //   宿主侧监听器读到的 e.target **恒等于宿主自身**，`e.target !== i` 恒真 ⇒
      //   真实鼠标点内部 input（复选框方块）会「原生切换 + JS 再切回」= 净零，复选框勾不上（2026-09-18 真实 Chromium 实证）。
      //   composedPath() 保留原始派发路径，能正确区分「点的是内部 input」与「点的是宿主/文字」。
      this.addEventListener('click', (e) => {
        if (!e.composedPath().includes(i)) {
          i.checked = !i.checked;
          i.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
      });
    }
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      const i = this.shadowRoot?.querySelector('input');
      if (i && i.checked) this._internals.setFormValue(i.value || 'on');
      else this._internals.setFormValue(null);
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ const i = this.shadowRoot?.querySelector('input'); if (i) i.checked = this.hasAttribute('checked'); this._syncForm(); }
    get checked(){ return this.shadowRoot?.querySelector('input')?.checked ?? false; }
    set checked(v){ const i = this.shadowRoot?.querySelector('input'); if (i) i.checked = !!v; this._syncForm(); }
    get value(){ return this.shadowRoot?.querySelector('input')?.value ?? ''; }
    set value(v){ const i = this.shadowRoot?.querySelector('input'); if (i) i.value = v ?? ''; }
    attributeChangedCallback(n, _o, v){
      const i = this.shadowRoot?.querySelector('input'); if (!i) return;
      if (n === 'checked') i.checked = this.hasAttribute('checked');
      if (n === 'disabled') i.disabled = this.hasAttribute('disabled');
      if (n === 'checked' || n === 'value') this._syncForm();
    }
  }
  // ── crm-textarea：属性驱动（shadow 单 textarea），C1 修正 ──
  class CrmTextarea extends HTMLElement {
    static formAssociated = true;
    static observedAttributes = ['placeholder', 'value', 'disabled', 'required', 'name', 'rows'];
    connectedCallback(){
      if (this._inited) return; this._inited = true;
      const t = document.createElement('textarea');
      const style = document.createElement('style'); style.textContent = T;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.append(style, t);
      this._internals = this.attachInternals();
      this._defaultValue = this.getAttribute('value') ?? '';
      for (const a of ['placeholder', 'value', 'disabled']) this._apply(a, this.getAttribute(a));
      // input 事件 composed:false，手动以 composed:true 转发出 host
      t.addEventListener('input', () => this.dispatchEvent(new Event('input', { bubbles: true, composed: true })));
      t.addEventListener('input', () => this._syncForm());
    }
    _apply(n, v){
      const t = this.shadowRoot?.querySelector('textarea'); if (!t) return;
      if (n === 'disabled') t.disabled = this.hasAttribute('disabled');
      else if (n === 'rows') t.rows = Math.max(1, parseInt(v, 10) || 2); // rows 属性透传（2026-09-05 修复：此前被忽略导致恒 2 行）
      else t[n] = v ?? '';
      if (n === 'value' || n === 'required') this._syncForm();
    }
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      const v = this.shadowRoot?.querySelector('textarea')?.value ?? '';
      this._internals.setFormValue(v);
      if (this.hasAttribute('required')) this._internals.setValidity(v ? {} : { valueMissing: true }, v ? '' : '必填', this.shadowRoot.querySelector('textarea'));
      else this._internals.setValidity({});
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ const t = this.shadowRoot?.querySelector('textarea'); if (t) t.value = this._defaultValue; this._syncForm(); }
    get value(){ return this.shadowRoot?.querySelector('textarea')?.value ?? ''; }
    set value(v){ const t = this.shadowRoot?.querySelector('textarea'); if (t) t.value = v ?? ''; this._syncForm(); }
    attributeChangedCallback(n, _o, v){ this._apply(n, v); }
  }
  // ── crm-button：shadow <button><slot></slot></button> ──
  class CrmButton extends HTMLElement {
    static observedAttributes = ['class', 'variant', 'disabled', 'type'];
    connectedCallback(){
      if (this._inited) return; this._inited = true;
      const b = document.createElement('button');
      const slot = document.createElement('slot'); b.appendChild(slot);
      const style = document.createElement('style'); style.textContent = T;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.append(style, b);
      // 透传宿主 class 到内部 button（页内 .btn-primary/.ok/.cancel/.drawer-close 等样式须抵达 shadow 才生效）
      b.className = this.getAttribute('class') || this.getAttribute('variant') || '';
      if (this.hasAttribute('disabled')) b.disabled = true;
      // 提交按钮：自定义元素非表单提交控件，点击 host 时程序化 requestSubmit（兼容既有 onsubmit 处理器 + 原生校验）
      if (this.getAttribute('type') === 'submit') {
        b.type = 'submit';
        this.addEventListener('click', () => {
          if (this.getAttribute('type') === 'submit') this.closest('form')?.requestSubmit();
        });
      }
    }
    attributeChangedCallback(n, _o, v){
      const b = this.shadowRoot?.querySelector('button'); if (!b) return;
      if (n === 'class') b.className = v || this.getAttribute('variant') || '';
      if (n === 'variant') b.className = this.getAttribute('class') || v || '';
      if (n === 'disabled') b.disabled = this.hasAttribute('disabled');
      if (n === 'type') b.type = v === 'submit' ? 'submit' : 'button';
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
  registerComponents = function(){
    defineIf('crm-select', CrmSelect);
    defineIf('crm-input', CrmInput);
    defineIf('crm-checkbox', CrmCheckbox);
    defineIf('crm-textarea', CrmTextarea);
    defineIf('crm-button', CrmButton);
    defineIf('crm-card', CrmCard);
    defineIf('crm-table', CrmTable);
    defineIf('crm-tabs', CrmTabs);
    defineIf('crm-tab', CrmTab);
  };
  registerComponents();
}
