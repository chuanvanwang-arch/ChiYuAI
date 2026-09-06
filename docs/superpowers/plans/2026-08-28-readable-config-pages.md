# 配置中心 3 个 readable 项深度管理页（11 LLM / 15 七维 / 20 池配置）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为配置中心 3 个 readonly/readable 项交付深度管理页——当前它们在 config.html 聚合页仅「可读取」（一键查看摘要），本次补齐**独立管理页**：LLM 配置（provider/model/key/temp 编辑）、七维设计（决策场景七维评估维度配置编辑）、池配置（pick/recycle 规则编辑）。**后端三端点 GET/PUT 已全部就位（核实如下），本次纯前端交付**——新增 3 个 Render 子模块 + 3 个页面 + routes 静态段 + configCenter 3 项翻 ready。

**后端现状核实（证据，无需改后端）：**
| 项 | 端点 | 写路径 | 决策闸 | 证据 |
|---|---|---|---|---|
| 11 LLM | `GET/PUT /api/config/llm` | configRouter key=llm | 第0闸 requireDecision（config-change 降级事件） | routes.js:79 `createConfigRouter({key:'llm', role:'sysadmin'})`；configRouter.js produceDecision |
| 15 七维 | `GET/PUT /api/config/seven-dim` | configRouter key=seven-dim | 第0闸 + **decisionScene='scene-quote' 七维拦截**（缺 context 422 missing_context） | routes.js:80 |
| 20 池 | `GET/PUT /api/pool-config` | setPoolConfig(orgId, patch) | getPoolConfig 幂等补默认；patch 对象校验 | routes.js:267-284 |

**架构纪律（2026-08-27 QA 教训，不可破）：**
1. **渲染纯函数子模块** `*Render.js`（零服务端 import，浏览器 ESM 可加载）——页面 import **必须指向子模块**（混合文件顶层含 express/db import → 浏览器 ESM 崩溃）。
2. 写经决策第0闸（configRouter 已内置，页面无需额外处理；池的 setPoolConfig 由后端保障）。
3. **sysadmin 权限**：GET 已读（readable），PUT 由 configRouter 行为兜底；页面仅暴露编辑表单，不做 DELETE。
4. 页面 import 子模块 + `/web/nav.js`；`Content-Type:text/javascript` 静态段。

**范围（YAGNI）：**
- ✅ 3 个独立管理页（llm.html / seven-dim.html / pool-config.html），各自拉取→渲染表单→保存（PUT）。
- ✅ 字段白名单校验纯函数（防任意 JSON 注入，对齐 systemSettings 范式）。
- ✅ configCenter 3 项 `readable→ready`（page 指向新页）。
- ❌ 不改后端端点（三端点已就位）；❌ 不做池的 org 多租户切换（默认 org-hq）。

---

## 文件结构

- 新建 `src/portal/llmConfigRender.js`：`LLM_FIELDS/validateLlmPatch/renderLlmForm`（provider select + model 输入 + key 密码框 + temp 数字）
- 新建 `src/portal/sevenDimRender.js`：`SEVEN_KEYS/validateSevenDimPatch/renderSevenDimForm`（七维维度编辑）
- 新建 `src/portal/poolConfigRender.js`：`POOL_KEYS/validatePoolPatch/renderPoolForm`（pickRule/recycleAfterDays）
- 新建 `src/web/llm.html`、`src/web/seven-dim.html`、`src/web/pool-config.html`（各自拉取→渲染→PUT 保存→15s 刷新）
- 修改 `src/http/routes.js`：3 个页路由 + `/llm` `/seven-dim` `/pool-config` 302 + 3 个 Render 静态段
- 修改 `src/portal/configCenter.js`：11/15/20 三项 `readable→ready`（page + endpoint）
- 修改 `src/web/nav.js`：3 个入口（LLM 配置 / 七维设计 / 池配置）
- 新建 `test/web/readableConfig.test.js`：3 组渲染/校验测试（RED→GREEN）

---

### Task 1: 3 组渲染纯函数 + 校验（RED→GREEN）

**Files:**
- Create: `test/web/readableConfig.test.js`
- Create: `src/portal/llmConfigRender.js`、`src/portal/sevenDimRender.js`、`src/portal/poolConfigRender.js`

- [ ] **Step 1: 写失败测试**

```js
// test/web/readableConfig.test.js
import { test, expect } from 'vitest';
import { LLM_FIELDS, validateLlmPatch, renderLlmForm } from '../../src/portal/llmConfigRender.js';
import { SEVEN_KEYS, validateSevenDimPatch, renderSevenDimForm } from '../../src/portal/sevenDimRender.js';
import { POOL_KEYS, validatePoolPatch, renderPoolForm } from '../../src/portal/poolConfigRender.js';

// —— LLM ——
test('LLM_FIELDS 白名单', () => {
  expect(LLM_FIELDS).toEqual(expect.arrayContaining(['provider', 'model', 'temp']));
});
test('validateLlmPatch 合法/非法', () => {
  expect(validateLlmPatch({ provider: 'siliconflow', model: 'deepseek-v4', temp: 0.7 }).ok).toBe(true);
  expect(validateLlmPatch({ unknown: 1 }).ok).toBe(false);
  expect(validateLlmPatch({ temp: 99 }).ok).toBe(false); // temp 越界
});
test('renderLlmForm 含 provider select + temp 输入', () => {
  const html = renderLlmForm({ provider: 'siliconflow', model: 'deepseek-v4', temp: 0.7 });
  expect(html).toContain('provider');
  expect(html).toContain('deepseek-v4');
  expect(html).toContain('temp');
});
test('renderLlmForm 未配置空态', () => {
  expect(renderLlmForm(null)).toContain('未配置');
});

// —— 七维 ——
test('SEVEN_KEYS 白名单', () => {
  expect(SEVEN_KEYS).toEqual(expect.arrayContaining(['context', 'knowledge', 'memory']));
});
test('validateSevenDimPatch 合法/非法', () => {
  expect(validateSevenDimPatch({ context: 2, knowledge: 3 }).ok).toBe(true);
  expect(validateSevenDimPatch({ unknown: 1 }).ok).toBe(false);
});
test('renderSevenDimForm 含维度输入', () => {
  const html = renderSevenDimForm({ context: 2 });
  expect(html).toContain('context');
  expect(html).toContain('value="2"');
});

// —— 池 ——
test('POOL_KEYS 白名单', () => {
  expect(POOL_KEYS).toEqual(expect.arrayContaining(['pickRule', 'recycleAfterDays']));
});
test('validatePoolPatch 合法/非法', () => {
  expect(validatePoolPatch({ pickRule: 'oldest', recycleAfterDays: 30 }).ok).toBe(true);
  expect(validatePoolPatch({ unknown: 1 }).ok).toBe(false);
  expect(validatePoolPatch({ recycleAfterDays: -1 }).ok).toBe(false);
});
test('renderPoolForm 含 pickRule select + recycle 数字', () => {
  const html = renderPoolForm({ pickRule: 'oldest', recycleAfterDays: 30 });
  expect(html).toContain('pickRule');
  expect(html).toContain('oldest');
  expect(html).toContain('recycleAfterDays');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/readableConfig.test.js 2>&1 | tail -12`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现 3 个 Render 子模块**

```js
// src/portal/llmConfigRender.js — LLM 配置（第 11 项）渲染纯函数子模块
// 零服务端 import（浏览器 ESM 可加载）。写经 configRouter 第0闸（后端）。
export const LLM_FIELDS = ['provider', 'model', 'temp'];
const PROVIDERS = ['siliconflow', 'deepseek', 'openai', 'azure'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function validateLlmPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !LLM_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${LLM_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('provider' in patch) {
    if (!PROVIDERS.includes(patch.provider)) errors.push(`provider 须为 ${PROVIDERS.join('/')}`);
    else n.provider = patch.provider;
  }
  if ('model' in patch) {
    if (typeof patch.model !== 'string' || !patch.model.trim() || patch.model.length > 128) errors.push('model 须为 1–128 字字符串');
    else n.model = patch.model.trim();
  }
  if ('temp' in patch) {
    const t = patch.temp;
    if (typeof t !== 'number' || !isFinite(t) || t < 0 || t > 2) errors.push('temp 须为 0–2 的数值');
    else n.temp = t;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

export function renderLlmForm(v) {
  if (!v) return '<div class="empty">LLM 配置未设置（首次 PUT 后生效）</div>';
  const sel = (cur) => PROVIDERS.map((p) => `<option value="${p}" ${cur === p ? 'selected' : ''}>${p}</option>`).join('');
  return `<form id="llmf">
    <label>Provider</label><select name="provider">${sel(v.provider)}</select>
    <label>Model</label><input name="model" value="${esc(v.model || '')}" maxlength="128" />
    <label>Temperature</label><input name="temp" type="number" step="0.1" min="0" max="2" value="${esc(v.temp ?? 0.7)}" />
    <button class="btn" type="submit">保存</button>
  </form>`;
}
```

```js
// src/portal/sevenDimRender.js — 七维设计配置（第 15 项）渲染纯函数子模块
// 零服务端 import。决策场景七维评估维度（scene-quote 拦截依赖，后端校验）。
export const SEVEN_KEYS = ['context', 'knowledge', 'memory', 'action', 'governance', 'evaluation', 'feedback'];
function esc(s) { /* 同 llmConfigRender */ }
export function validateSevenDimPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !SEVEN_KEYS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑维度: ${unknown.join(', ')}（仅 ${SEVEN_KEYS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效维度'] };
  const errors = [];
  const n = {};
  for (const k of SEVEN_KEYS) {
    if (k in patch) {
      const val = patch[k];
      if (typeof val !== 'number' || !isFinite(val) || val < 0 || val > 5) errors.push(`${k} 须为 0–5 的维度分`);
      else n[k] = val;
    }
  }
  return { ok: errors.length === 0, errors, normalized: n };
}
export function renderSevenDimForm(v = {}) {
  if (!v || !Object.keys(v).length) return '<div class="empty">七维设计未配置（首 PUT 后生效）</div>';
  const rows = SEVEN_KEYS.map((k) => `<label>${esc(k)}<input type="number" min="0" max="5" name="${k}" value="${esc(v[k] ?? 0)}" /></label>`).join('');
  return `<form id="sd7f">${rows}<button class="btn" type="submit">保存</button></form>`;
}
```

```js
// src/portal/poolConfigRender.js — 池配置（第 20 项）渲染纯函数子模块
// 零服务端 import。线索池/商机池 pick/recycle 规则（setPoolConfig 后端持久化）。
export const POOL_KEYS = ['pickRule', 'recycleAfterDays'];
const PICK_RULES = ['oldest', 'newest', 'random', 'priority'];
function esc(s) { /* 同 llmConfigRender */ }
export function validatePoolPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !POOL_KEYS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${POOL_KEYS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('pickRule' in patch) {
    if (!PICK_RULES.includes(patch.pickRule)) errors.push(`pickRule 须为 ${PICK_RULES.join('/')}`);
    else n.pickRule = patch.pickRule;
  }
  if ('recycleAfterDays' in patch) {
    const d = patch.recycleAfterDays;
    if (!Number.isInteger(d) || d < 1 || d > 3650) errors.push('recycleAfterDays 须为 1–3650 的整数（天）');
    else n.recycleAfterDays = d;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}
export function renderPoolForm(v = {}) {
  if (!v || !Object.keys(v).length) return '<div class="empty">池配置未设置（getPoolConfig 幂等补默认）</div>';
  const sel = (cur) => PICK_RULES.map((p) => `<option value="${p}" ${cur === p ? 'selected' : ''}>${p}</option>`).join('');
  return `<form id="poolf">
    <label>领取规则</label><select name="pickRule">${sel(v.pickRule)}</select>
    <label>回收天数</label><input name="recycleAfterDays" type="number" min="1" max="3650" value="${esc(v.recycleAfterDays ?? 30)}" />
    <button class="btn" type="submit">保存</button>
  </form>`;
}
```

- [ ] **Step 4: 运行测试确认 GREEN（9/9）**

### Task 2: routes.js 页路由 + 3 个 Render 静态段

**Files:**
- Modify: `src/http/routes.js`

- [ ] **Step 1: 在 pool-config 端点段后追加页路由 + 静态段**

```js
  // 配置中心 3 个 readable→ready 管理页（11 LLM / 15 七维 / 20 池）
  app.get('/llm.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/llm.html', import.meta.url))));
  app.get('/llm', (req, res) => res.redirect('/llm.html'));
  app.get('/portal/llmConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/llmConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/seven-dim.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/seven-dim.html', import.meta.url))));
  app.get('/seven-dim', (req, res) => res.redirect('/seven-dim.html'));
  app.get('/portal/sevenDimRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/sevenDimRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/pool-config.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/pool-config.html', import.meta.url))));
  app.get('/pool-config', (req, res) => res.redirect('/pool-config.html'));
  app.get('/portal/poolConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/poolConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 2: 语法冒烟** `routes OK`

### Task 3: 3 个页面

**Files:**
- Create: `src/web/llm.html`、`src/web/seven-dim.html`、`src/web/pool-config.html`

- [ ] **Step 1: 创建 3 页（同构：拉取→渲染表单→PUT 保存→回显决策→15s 刷新）**

```html
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>LLM 配置</title>
<style> body{font-family:system-ui;margin:24px;background:#fafafa;color:#222}
label{display:block;margin:10px 0 4px;font-size:13px;color:#475569}
input,select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px}
button{padding:7px 16px;border:0;border-radius:7px;background:#165dff;color:#fff;margin-top:14px;cursor:pointer}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;max-width:560px;margin:16px auto}
.muted{color:#86909c;font-size:13px}</style></head>
<body>
<div class="panel"><h2>🤖 LLM 配置</h2><p class="muted">写经决策第0闸 + sysadmin · GET/PUT /api/config/llm</p><div id="app">加载中…</div></div>
<script type="module">
import { renderLlmForm, validateLlmPatch } from '/portal/llmConfigRender.js';
import '/web/nav.js';
const TOKEN = localStorage.getItem('crm_token');
const app = document.getElementById('app');
if (!TOKEN) location.href = '/home.html';
async function load() {
  try {
    const r = await fetch('/api/config/llm', { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status === 404) { app.innerHTML = renderLlmForm(null); bind(); return; }
    const j = await r.json();
    if (!r.ok) { app.innerHTML = `<p class="muted">加载失败：${j.error || r.status}</p>`; return; }
    app.innerHTML = renderLlmForm(j.value) + `<p class="muted">决策 ${String(j.decision || '').slice(0, 8)}…</p>`;
    bind();
  } catch (e) { app.innerHTML = `<p class="muted">${e.message}</p>`; }
}
function bind() {
  const f = document.getElementById('llmf');
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const value = { provider: fd.get('provider'), model: fd.get('model'), temp: Number(fd.get('temp')) };
    const v = validateLlmPatch(value);
    if (!v.ok) { alert('校验失败：' + v.errors.join('; ')); return; }
    const r = await fetch('/api/config/llm', { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v.normalized }) });
    const j = await r.json();
    alert(r.ok ? `已保存（决策 ${String(j.decision || '').slice(0, 8)}…）` : ('失败：' + (j.error || r.status)));
    load();
  };
}
load();
setInterval(() => { if (TOKEN) load(); }, 15000);
</script></body></html>
```
> seven-dim.html / pool-config.html 同构（import 各自 Render、fetch `/api/config/seven-dim` / `/api/pool-config`、表单 id `sd7f` / `poolf`；七维 PUT `{value: v.normalized}`、池 PUT `{patch: v.normalized}`——池端点 body 键是 `patch` 非 `value`，见 routes.js:277）。

### Task 4: configCenter 3 项翻 ready + nav 入口

**Files:**
- Modify: `src/portal/configCenter.js`（11/15/20 三行）
- Modify: `src/web/nav.js`

- [ ] **Step 1: configCenter 三项翻 ready**

```js
{ id: 11, name: 'LLM 配置', group: '运营', status: 'ready', page: '/llm.html', endpoint: '/api/config/llm', note: 'provider/model/temp 编辑，写经决策第0闸+sysadmin' },
{ id: 15, name: '七维设计', group: '智能体', status: 'ready', page: '/seven-dim.html', endpoint: '/api/config/seven-dim', note: '七维评估维度 0–5 编辑（scene-quote 拦截依赖）' },
{ id: 20, name: '池配置', group: '运营', status: 'ready', page: '/pool-config.html', endpoint: '/api/pool-config', note: 'pick/recycle 规则编辑，setPoolConfig 持久化' },
```

- [ ] **Step 2: nav.js 追加 3 入口（配置中心前）**

```js
{ href: '/llm.html', label: '🤖 LLM 配置' },
{ href: '/seven-dim.html', label: '📐 七维设计' },
{ href: '/pool-config.html', label: '🗂 池配置' },
```

- [ ] **Step 3: configCenter.test.js 如有断言需同步（readable 计数变化）**

### Task 5: 全量回归 + 冒烟 + 工作日志

- [ ] **Step 1: `test/web/readableConfig.test.js` 9/9 绿 + test/web 全量（182+9=191）**
- [ ] **Step 2: routes.js 加载冒烟 `routes OK`**
- [ ] **Step 3: 工作日志追加 `.workbuddy/memory/2026-08-28.md`**

## 验收口径

- `test/web/readableConfig.test.js` **10/10 绿**（实现时补 1 例 renderPoolForm 非法 recycle 边界）；`test/web` 全量 **201/201**（21 文件）
- `/llm` `/seven-dim` `/pool-config` 可读可编可存（PUT 走 configRouter 第0闸 / setPoolConfig），**无 DELETE**
- configCenter 三项 `readable→ready`；配置中心 **18 项全 ready**
- 3 页 import 均指向 Render 子模块（浏览器 ESM 可加载）

## 已知限制

- 池配置写 body 键是 `patch`（非 `value`，对齐 routes.js:277 setPoolConfig 契约）；LLM/七维写 body 键是 `value`。
- 七维写经 scene-quote 七维拦截：缺 context 维度时后端可能 422 `missing_context`——页面回显后端 error。
- LLM key（密钥）不在本页编辑（security 考量，仅 provider/model/temp；密钥走 users 或环境变量）。