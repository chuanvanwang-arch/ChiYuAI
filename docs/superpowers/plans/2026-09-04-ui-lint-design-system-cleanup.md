# UI 架构级 Lint 清理（ui-lint.mjs 36 警告收敛）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `scripts/ui-lint.mjs` 当前 36 处警告（item3 样式漂移 13 + item7 JS 模板裸控件 23）收敛为 `node scripts/ui-lint.mjs --strict` 零警告零错误，并根治"盲转 crm-* 会破坏 FormData 表单"的根因（增强 `components.js` 表单关联 FACE）。

**Architecture:** 单源修复——先增强共享组件 `src/web/components.js`（4 个表单控件成为 Form Associated Custom Element + 镜像全部按钮变体类 + 提交按钮 requestSubmit 转发），再迁移 9 个页面（4 个删样式漂移、5 个转 crm-*）。所有控件视觉经 `common.css` 单源或页内前缀类保证零回归。

**Tech Stack:** 原生 Web Components（ElementInternals / formAssociatedCallback / setFormValue）、纯 CSS、零依赖。`ui-lint.mjs` 静态校验（无 DOM 测试库，浏览器冒烟由人工在 localhost:3000 验证）。

---

## 文件结构

- Modify: `src/web/components.js`（FACE 增强 + 按钮变体镜像 + 提交按钮 requestSubmit）
- Modify: `src/web/named-account-manage.html`（删 .tabs/.tab/.tab.active/.badge/.btn 重声明 + 删冗余 select,input）
- Modify: `src/web/named-accounts.html`（删 tab 规则 + 删 .empty-hint .btn + .card→.ncard 重命名）
- Modify: `src/web/pipeline.html`（删 .toast/.toast.show）
- Modify: `src/web/receivables.html`（.ov .card→.ov .rcard 重命名 + JS class 同步）
- Modify: `src/web/meta-attr-drawer.html`（预览 input→crm-input）
- Modify: `src/web/ontology.html`（addBtn + 表单内 input/select/checkbox/button→crm-*）
- Modify: `src/web/portal-stage3-mockup.html`（.cta 按钮→crm-button）
- Modify: `src/web/sales-decision-monitor.html`（textarea/button→crm-*）
- Modify: `src/web/users.html`（工具栏 input/select/button + 表单内控件→crm-*）
- Test: 无 Node DOM 测试库，组件 FACE 以浏览器冒烟验证（Task 4 验收 2）
- Doc: `docs/2026-09-04-ui-lint-cleanup-impl-log.md`

---

### Task 1: components.js FACE 增强 + 按钮变体镜像 + 提交按钮 requestSubmit

**Files:**
- Modify: `src/web/components.js`

- [ ] **Step 1: 扩展 `T` 样式（按钮变体镜像，含页面用到的 .snap-write-btn/.cta/.dn-close/.dn-drawer-close）**

在 `const T = \`...\`` 末尾（现有 `button.sec{...}` 之后）追加：

```css
  button.snap-write-btn{ background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:2px 8px; font-size:11px; color:var(--ac); cursor:pointer; }
  button.cta{ width:100%; border:1px solid var(--accent); color:var(--accent); background:var(--panel); border-radius:9px; padding:8px; font-weight:600; cursor:pointer; }
  button.cta:active{ background:var(--accent-soft); }
  button.dn-close{ background:var(--panel); border:1px solid var(--line); color:var(--ink); border-radius:6px; width:28px; height:28px; line-height:1; font-size:16px; cursor:pointer; margin-left:12px; }
  button.dn-close:hover{ color:var(--err); }
  button.dn-drawer-close{ background:transparent; border:1px solid var(--line); color:var(--ink); border-radius:6px; width:28px; height:28px; font-size:16px; cursor:pointer; }
  button.dn-drawer-close:hover{ color:var(--err); border-color:var(--err); }
```

- [ ] **Step 2: CrmSelect 加 FACE**

将 `class CrmSelect extends HTMLElement {` 改为 `class CrmSelect extends HTMLElement {` 并加 `static formAssociated = true;`，在 `connectedCallback` 开头 `this._inited = true;` 之后加 `this._internals = this.attachInternals(); this._defaultValue = this.getAttribute('value') ?? '';`，并在 `_syncOptions()` 末尾与 `value` setter 中调用 `_syncForm()`。新增方法：

```js
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      this._internals.setFormValue(name, this._select?.value ?? '');
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ if (this._select) this._select.value = this._defaultValue; this._syncForm(); }
```

在 `value` setter `set value(v){ if (this._select) this._select.value = v ?? ''; }` 末尾加 `this._syncForm();`。在 `_syncOptions()` 的 `if (target) s.value = target;` 之后加 `this._syncForm();`。

- [ ] **Step 3: CrmInput 加 FACE**

`class CrmInput extends HTMLElement {` 加 `static formAssociated = true;`。`connectedCallback` 中 `this._inited = true;` 后加 `this._internals = this.attachInternals(); this._defaultValue = this.getAttribute('value') ?? '';`。在 `i.addEventListener('input', ...)` 之后加 `i.addEventListener('input', () => this._syncForm());`。新增：

```js
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      const v = this.shadowRoot?.querySelector('input')?.value ?? '';
      this._internals.setFormValue(name, v);
      if (this.hasAttribute('required')) this._internals.setValidity(v ? {} : { valueMissing: true }, v ? '' : '必填', this.shadowRoot.querySelector('input'));
      else this._internals.setValidity({});
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ const i = this.shadowRoot?.querySelector('input'); if (i) i.value = this._defaultValue; this._syncForm(); }
```

在 `value` setter 末加 `this._syncForm();`，在 `attributeChangedCallback` 末加 `if (n === 'value' || n === 'required') this._syncForm();`。

- [ ] **Step 4: CrmTextarea 加 FACE（同 CrmInput，textarea 元素）**

`class CrmTextarea extends HTMLElement {` 加 `static formAssociated = true;`，`connectedCallback` 加 `this._internals = this.attachInternals(); this._defaultValue = this.getAttribute('value') ?? '';`，`t.addEventListener('input', ...)` 后加 `t.addEventListener('input', () => this._syncForm());`，新增 `_syncForm/formAssociatedCallback/formResetCallback`（元素 querySelector('textarea')），`value` setter 末加 `this._syncForm();`，`attributeChangedCallback` 末加 `if (n === 'value' || n === 'required') this._syncForm();`。

- [ ] **Step 5: CrmCheckbox 加 FACE（仅勾选时参与 FormData）**

`class CrmCheckbox extends HTMLElement {` 加 `static formAssociated = true;`，`connectedCallback` 加 `this._internals = this.attachInternals();`，在 change 监听后加 `i.addEventListener('change', () => this._syncForm());`。新增：

```js
    _syncForm(){
      const name = this.getAttribute('name');
      if (!name || !this._internals) return;
      const i = this.shadowRoot?.querySelector('input');
      if (i && i.checked) this._internals.setFormValue(name, i.value || 'on');
      else this._internals.setFormValue(name, null);
    }
    formAssociatedCallback(){ this._syncForm(); }
    formResetCallback(){ const i = this.shadowRoot?.querySelector('input'); if (i) i.checked = this.hasAttribute('checked'); this._syncForm(); }
```

在 `checked` setter 末加 `this._syncForm();`，`attributeChangedCallback` 末加 `if (n === 'checked') this._syncForm();`。

- [ ] **Step 6: CrmButton 支持 type=submit → requestSubmit 转发**

`class CrmButton extends HTMLElement {` 的 `observedAttributes` 加 `'type'`。`connectedCallback` 中 `if (this.hasAttribute('disabled')) b.disabled = true;` 后加：

```js
      if (this.getAttribute('type') === 'submit') {
        b.type = 'submit';
        this.addEventListener('click', () => {
          if (this.getAttribute('type') === 'submit') this.closest('form')?.requestSubmit();
        });
      }
```

`attributeChangedCallback` 加 `if (n === 'type') { b.type = v === 'submit' ? 'submit' : 'button'; }`。

- [ ] **Step 7: 运行 ui-lint 确认组件文件不引入新警告（components.js 不在 src/web/*.html，不影响；此步仅 sanity）**

Run: `node scripts/ui-lint.mjs 2>&1 | tail -5`
Expected: 通过（无架构级违规），警告数仍 36（页面未改）。

- [ ] **Step 8: Commit**

```bash
git add src/web/components.js
git commit -m "feat(ui): components.js 表单关联 FACE + 按钮变体镜像 + 提交按钮 requestSubmit"
```

---

### Task 2: Type B 4 文件样式漂移清理

**Files:**
- Modify: `src/web/named-account-manage.html`
- Modify: `src/web/named-accounts.html`
- Modify: `src/web/pipeline.html`
- Modify: `src/web/receivables.html`

- [ ] **Step 1: named-account-manage.html — 删保留类重声明**

删除 `<style>` 中以下行（回落 common.css）：
- `.tabs { ... }` / `.tab { ... }` / `.tab.active { ... }`（第 15-17 行）
- `.badge { ... }`（第 37 行，红色错误徽标→common.css 强调色，可接受）
- `select, input { ... }`（第 39 行，冗余，light DOM 无裸控件）
- `.btn { ... }` / `.btn.ghost { ... }` / `.btn.danger { ... }`（第 40-42 行）

保留其余（.kpis/.kpi/.banner/.page-actions 等）。

- [ ] **Step 2: named-accounts.html — 删 tab 规则 + 删 .empty-hint .btn + .card→.ncard**

- 删除第 17-21 行（`.tabs`/`.tab`/`.tab:hover:not(.locked)`/`.tab.active`/`.tab.locked`）→ 回落 common.css `.tabs/.tab/.tab.on,.tab.active`（locked 暗化提示丢失，属已批准 canonical 对齐）。
- 删除第 58 行 `.empty-hint .btn { margin-top: 10px; }`（死规则，清空按钮已非裸 `<button>`）。
- 第 63 行 `.card { ... }` → `.ncard { ... }`（同内容）；第 64 行 `.card h3 { ... }` → `.ncard h3 { ... }`。
- JS 生成处 `class="card"` → `class="ncard"`（render 中 3 处：第 330/362/376 行附近含 `<div class="card"` 的模板串）。

- [ ] **Step 3: pipeline.html — 删 .toast 重声明**

删除第 28-29 行 `.toast { ... }` / `.toast.show { ... }` → 回落 common.css `.toast`/`.toast.err`（位置由 bottom-center 变 bottom-right，属已批准 canonical 对齐）。保留 `.btn-primary`/`.field`/`.sheet` 等（均含连字符或非保留类）。

- [ ] **Step 4: receivables.html — .ov .card→.ov .rcard 重命名**

- 第 14 行 `.ov .card { ... }` → `.ov .rcard { ... }`（同内容）
- 第 15 行 `.ov .card .v { ... }` → `.ov .rcard .v { ... }`
- 第 16 行 `.ov .card .k { ... }` → `.ov .rcard .k { ... }`
- JS 生成处 `class="card"` → `class="rcard"`（overview 模板 4 处 + 失败兜底 1 处）。

- [ ] **Step 5: 运行 ui-lint 确认 item3 清零**

Run: `node scripts/ui-lint.mjs 2>&1 | tail -8`
Expected: 警告数由 13 降至 0（item3 全清），item7 仍 23。

- [ ] **Step 6: Commit**

```bash
git add src/web/named-account-manage.html src/web/named-accounts.html src/web/pipeline.html src/web/receivables.html
git commit -m "style(ui): 收敛 4 页本地样式漂移，回落 common.css 单源（item3 清零）"
```

---

### Task 3: Type A 5 文件动态控件迁移

**Files:**
- Modify: `src/web/meta-attr-drawer.html`
- Modify: `src/web/ontology.html`
- Modify: `src/web/portal-stage3-mockup.html`
- Modify: `src/web/sales-decision-monitor.html`
- Modify: `src/web/users.html`

- [ ] **Step 1: meta-attr-drawer.html — 预览 input→crm-input**

第 54 行 `<input placeholder="预览输入 ${slug}" style="width:100%;padding:6px;border:1px solid var(--line);border-radius:6px">` →
`<crm-input placeholder="预览输入 ${slug}" style="width:100%"></crm-input>`（内边距由 shadow T 提供，视觉一致；无表单，安全）。

- [ ] **Step 2: ontology.html — addBtn + 表单控件→crm-***

- 第 59 行 `<button id="addBtn" class="btn" style="float:right">+ 新增词汇</button>` → `<crm-button id="addBtn" class="btn" style="float:right">+ 新增词汇</crm-button>`
- 第 71 行 `<input name="term" ... />` → `<crm-input name="term" ... ></crm-input>`（保留 placeholder/value/required 属性透传）
- 第 72 行 `<select name="type">` → `<crm-select name="type">`（选项保留）
- 第 77 行 `<select name="layer">` → `<crm-select name="layer">`
- 第 81 行 `<input type="checkbox" name="state" value="INACTIVE" ${...}checked.../>` → `<crm-checkbox name="state" value="INACTIVE" ${...}checked...}></crm-checkbox>`
- 第 82 行 `<button class="btn" type="submit">${...}</button>` → `<crm-button class="btn" type="submit">${...}</crm-button>`
- 第 83 行 `<button class="btn ghost" type="button" onclick="...">取消</crm-button>` → `<crm-button class="btn ghost" type="button" onclick="...">取消</crm-button>`

- [ ] **Step 3: portal-stage3-mockup.html — .cta 按钮→crm-button**

第 179 行 `<button class="cta" data-nl="${nl}">怎么切入 → 命令栏</button>` →
`<crm-button class="cta" data-nl="${nl}">怎么切入 → 命令栏</crm-button>`（`.cta` 样式已在 Task1 镜像进 T；JS `el.querySelectorAll('.cta')` 仍能选中 crm-button 宿主）。

- [ ] **Step 4: sales-decision-monitor.html — textarea/button→crm-***

- 第 874 行 `<textarea id="loop-retro" ...></textarea>` → `<crm-textarea id="loop-retro" ...></crm-textarea>`
- 第 875 行 `<button class="snap-write-btn" onclick="attribRetro('${_esc(scenarioId)}')">提交复盘(C1)</button>` → `<crm-button class="snap-write-btn" onclick="attribRetro('${_esc(scenarioId)}')">提交复盘(C1)</crm-button>`
- 第 912 行 `<button class="snap-write-btn" onclick="manualOutcomeWriteFor('${_esc(d.decision_id)}')">补录</button>` → `<crm-button class="snap-write-btn" onclick="manualOutcomeWriteFor('${_esc(d.decision_id)}')">补录</crm-button>`
- 第 1291 行 `<button class="btn" onclick="dnReassemble()">触发装配（sysadmin）</button>` → `<crm-button class="btn" onclick="dnReassemble()">触发装配（sysadmin）</crm-button>`
- 第 1403 行 `<button class="btn" ... onclick="openDnModal('${_esc(id)}')">打开完整决策网络</button>` → `<crm-button class="btn" ... onclick="openDnModal('${_esc(id)}')">打开完整决策网络</crm-button>`
- 第 1626 行 `<button class="dn-drawer-close" onclick="closeDnDrawer()">×</button>` → `<crm-button class="dn-drawer-close" onclick="closeDnDrawer()">×</crm-button>`
- 第 1895 行 `<button class="dn-close" onclick="closeDnModal()">×</button>` → `<crm-button class="dn-close" onclick="closeDnModal()">×</crm-button>`
- 第 2023 行 `<button onclick="openDnModal('${_esc(d.decision_id)}')">查看决策网络</button>` → `<crm-button onclick="openDnModal('${_esc(d.decision_id)}')">查看决策网络</crm-button>`

- [ ] **Step 5: users.html — 工具栏 + 表单控件→crm-***

工具栏（render 模板）：
- 第 74 行 `<button id="addBtn" class="btn">+ 新建用户</button>` → `<crm-button id="addBtn" class="btn">+ 新建用户</crm-button>`
- 第 76 行 `<select id="tenantSel">${tenantOptions()}</select>` → `<crm-select id="tenantSel">${tenantOptions()}</crm-select>`
- 第 83 行 `<button class="btn" id="batchEnable">批量启用</button>` → `<crm-button class="btn" id="batchEnable">批量启用</crm-button>`
- 第 84 行 `<button class="btn" id="batchFreeze">批量冻结</button>` → `<crm-button class="btn" id="batchFreeze">批量冻结</crm-button>`
- 第 85 行 `<input type="datetime-local" id="expInput" title="有效期至" />` → `<crm-input type="datetime-local" id="expInput" title="有效期至"></crm-input>`
- 第 86 行 `<button class="btn" id="batchExpire">设置有效期</button>` → `<crm-button class="btn" id="batchExpire">设置有效期</crm-button>`
- 第 89 行 `<button class="btn ghost" id="clearSel">清空选择</button>` → `<crm-button class="btn ghost" id="clearSel">清空选择</crm-button>`

表单（uf 模板）：
- 第 135 行 `<input name="username" ... required />` → `<crm-input name="username" ... required></crm-input>`
- 第 136 行 `<input name="display_name" ... />` → `<crm-input name="display_name" ...></crm-input>`
- 第 137 行 `<input name="password" type="password" ... />` → `<crm-input name="password" type="password" ...></crm-input>`
- 第 138 行 `<select name="role">${roleOpts}</select>` → `<crm-select name="role">${roleOpts}</crm-select>`
- 第 139 行 `<input name="org_id" ... />` → `<crm-input name="org_id" ...></crm-input>`
- 第 140 行 `<input type="checkbox" name="enabled" value="true" ${enChecked}/>` → `<crm-checkbox name="enabled" value="true" ${enChecked}></crm-checkbox>`
- 第 141 行 `<input type="datetime-local" name="expires_at" value="${...}" />` → `<crm-input type="datetime-local" name="expires_at" value="${...}"></crm-input>`
- 第 142 行 `<button class="btn" type="submit">${...}</button>` → `<crm-button class="btn" type="submit">${...}</crm-button>`
- 第 143 行 `<button class="btn ghost" type="button" onclick="...">取消</crm-button>` → `<crm-button class="btn ghost" type="button" onclick="...">取消</crm-button>`

- [ ] **Step 6: 运行 ui-lint --strict 确认全清**

Run: `node scripts/ui-lint.mjs --strict 2>&1 | tail -8`
Expected: 通过（无架构级违规，无警告），exit 0。

- [ ] **Step 7: Commit**

```bash
git add src/web/meta-attr-drawer.html src/web/ontology.html src/web/portal-stage3-mockup.html src/web/sales-decision-monitor.html src/web/users.html
git commit -m "feat(ui): 5 页动态控件迁移 crm-*（item7 清零，FACE 保 FormData）"
```

---

### Task 4: 验收 + 实施记录

**Files:**
- Doc: `docs/2026-09-04-ui-lint-cleanup-impl-log.md`

- [ ] **Step 1: 全量 ui-lint --strict 复核**

Run: `node scripts/ui-lint.mjs --strict`
Expected: 0 错误 0 警告，exit 0。

- [ ] **Step 2: 人工浏览器冒烟（localhost:3000，本环境无浏览器自动化，列清单由用户验证）**

- ontology：新增词汇/编辑停用 → 提交后后端收到 term/type/layer/state 非空字段（FACE FormData 生效）。
- users：新建用户/编辑保存/批量启用冻结设置有效期 → FormData 取到 username/display_name/password/role/org_id/enabled/expires_at。
- sales-decision-monitor：复盘提交、补录、决策网络打开/关闭按钮样式正常（.snap-write-btn/.dn-close/.dn-drawer-close 镜像生效）。
- pipeline：新建商机弹窗（已用 crm-input）提交取到字段（FACE 正向修复）。
- 视觉回归：4 个样式漂移页回落 common.css canonical（tabs/card/toast/badge 风格统一），无空白/错位。

- [ ] **Step 3: 写实施记录**

写 `docs/2026-09-04-ui-lint-cleanup-impl-log.md`：记录改动文件、验收结果、`--strict` 输出、浏览器冒烟清单与状态。

- [ ] **Step 4: Commit**

```bash
git add docs/2026-09-04-ui-lint-cleanup-impl-log.md
git commit -m "docs(ui): ui-lint 清理实施记录（--strict 0 警告，FACE 保 FormData）"
```

---

## 自检（Self-Review）

- 规格覆盖：item3（13 处）由 Task2 清零；item7（23 处）由 Task3 清零；FormData 陷阱由 Task1 FACE 根除；提交按钮由 Task1 requestSubmit 转发。
- 占位符：无。
- 类型一致：各 crm-* 的 `name`/`value`/`type`/`checked`/`required` 透传与既有组件属性表一致（components.js 既有 `_apply`/`observedAttributes` 已支持）。
- 风险：Task1 改共享组件影响所有 crm-* 页，故 Task4 列全站浏览器冒烟（本环境无法自动跑，需用户在 localhost:3000 验证）。
