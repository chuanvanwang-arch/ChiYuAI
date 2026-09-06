# /agents 智能体运行监控台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CRM-ai-native 新增一个只读的「智能体运行监控台」页面 `/agents`，展示 3 个 agent 的六条装配断言状态、能力摘要与事件域实时健康，闭环 A 组「治理视图·智能体运行监控台」缺口。

**Architecture:** 新建静态页 `src/web/agents.html`（复用 `sales-decision-monitor.html` 卡片/徽标范式），路由补 `/agents` 别名；扩展 `GET /api/agents` 附加 `specs` 摘要使页面无需硬编码元数据；纯函数 `renderAgents(data)` 放 `src/portal/agentsPage.js`（与 `detailSections.js`/`scoring.js` 同范式，vitest 直接测）。前端每 5s 轮询 + 拉 `/api/realtime/health`。不含写操作。

**Tech Stack:** Node 22 + Express 4 + 原生 ESM 浏览器模块 + vitest 3（node 环境）。

---

## File Structure

- `src/portal/agentsPage.js` — 纯函数 `renderAgents(data)`：输入 `{ agents, assembly, specs, health }`，返回监控台 HTML 字符串；含 `agentOk(results)` 判定与降级标注逻辑。
- `src/web/agents.html` — 监控台页面：引入 `agentsPage.js` 挂全局，轮询 `/api/agents` + `/api/realtime/health`，渲染状态条 + agent 卡片网格。
- `src/http/routes.js` — 扩展 `GET /api/agents` 附加 `specs`；新增 `GET /agents` 与 `GET /agents.html` 静态别名。
- `src/web/nav.js` — 侧栏新增「🤖 智能体监控」入口。
- `test/web/agentsPage.test.js` — TDD 单测：覆盖 3 agent 渲染、ok/fail 徽标、六断言 chip、降级标注、空数据降级。

---

### Task 1: 写 agentsPage 失败测试（RED）

**Files:**
- Create: `test/web/agentsPage.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { renderAgents, agentAssemblyOk } from '../../src/portal/agentsPage.js';

const fixture = {
  agents: ['crm-copilot', 'deal-coach', 'lead-miner'],
  assembly: {
    ok: true,
    results: [
      { agent: 'crm-copilot', assertion: 'permission_closure', ok: true, detail: 'data-particle-read ⊆ actions' },
      { agent: 'crm-copilot', assertion: 'action_in_registry', ok: true, detail: 'data-particle-read' },
      { agent: 'crm-copilot', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-nl-to-action' },
      { agent: 'crm-copilot', assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' },
      { agent: 'crm-copilot', assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' },
      { agent: 'crm-copilot', assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' },
      { agent: 'deal-coach', assertion: 'permission_closure', ok: false, detail: 'crm-deal-advance ⊆ actions' },
      { agent: 'deal-coach', assertion: 'action_in_registry', ok: true, detail: 'crm-deal-advance' },
      { agent: 'deal-coach', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-deal-advance-advice' },
      { agent: 'deal-coach', assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' },
      { agent: 'deal-coach', assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' },
      { agent: 'deal-coach', assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' },
      { agent: 'lead-miner', assertion: 'permission_closure', ok: true, detail: 'data-particle-read ⊆ actions' },
      { agent: 'lead-miner', assertion: 'action_in_registry', ok: true, detail: 'data-particle-read' },
      { agent: 'lead-miner', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-intelligence-mining' },
      { agent: 'lead-miner', assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' },
      { agent: 'lead-miner', assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' },
      { agent: 'lead-miner', assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' },
    ],
    failed: [{ agent: 'deal-coach', assertion: 'permission_closure', ok: false, detail: 'crm-deal-advance ⊆ actions' }],
  },
  specs: {
    'crm-copilot': { name: 'crm-copilot', derivedFrom: 'taskFlow:crm-nl-to-action', autonomy: 'recommend', actionCount: 5, skillCallCount: 2, actions: ['data-particle-read', 'data-particle-create'], skillCalls: ['data-particle-read'] },
    'deal-coach': { name: 'deal-coach', derivedFrom: 'taskFlow:crm-deal-advance-advice', autonomy: 'recommend', actionCount: 3, skillCallCount: 1, actions: ['data-particle-read', 'crm-deal-advance'], skillCalls: ['data-particle-read'] },
    'lead-miner': { name: 'lead-miner', derivedFrom: 'taskFlow:crm-intelligence-mining', autonomy: 'recommend', actionCount: 3, skillCallCount: 1, actions: ['data-particle-read', 'data-particle-create'], skillCalls: ['data-particle-read'] },
  },
  health: { ok: true, ts: 123, domains: ['task', 'trace', 'approval', 'particle', 'payment', 'decision'] },
};

test('renders all 3 agent names', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('crm-copilot');
  expect(html).toContain('deal-coach');
  expect(html).toContain('lead-miner');
});

test('marks agent with failing assertion as fail (red)', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('data-section="agent"');
  expect(agentAssemblyOk(fixture.assembly.results.filter(r => r.agent === 'deal-coach'))).toBe(false);
  expect(agentAssemblyOk(fixture.assembly.results.filter(r => r.agent === 'crm-copilot'))).toBe(true);
});

test('renders six assertion chips per agent', () => {
  const html = renderAgents(fixture);
  ['permission_closure', 'action_in_registry', 'derived_from', 'kg_ready', 'skill_validated', 'evaluator_ready']
    .forEach(a => expect(html).toContain(`data-assertion="${a}"`));
});

test('flags degraded assertions with warn badge (not green pass)', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('degraded:');
});

test('renders health domains strip', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('task');
  expect(html).toContain('decision');
});

test('empty data degrades gracefully', () => {
  const html = renderAgents({ agents: [], assembly: { ok: true, results: [], failed: [] }, specs: {}, health: { ok: true, domains: [] } });
  expect(html).toContain('无智能体');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/web/agentsPage.test.js`
Expected: FAIL（`Cannot find module '../../src/portal/agentsPage.js'`）

- [ ] **Step 3: 提交（RED 基线，可选）**

```bash
git add test/web/agentsPage.test.js && git commit -m "test(agents): RED — agentsPage 监控台渲染单测"
```

---

### Task 2: 实现 agentsPage.js（GREEN）

**Files:**
- Create: `src/portal/agentsPage.js`

- [ ] **Step 1: 写最小实现**

```js
// src/portal/agentsPage.js — /agents 监控台纯渲染函数（node + 浏览器共用 ESM）
const ASSERTIONS = ['permission_closure', 'action_in_registry', 'derived_from', 'kg_ready', 'skill_validated', 'evaluator_ready'];
const ASSERTION_LABEL = {
  permission_closure: '权限闭包', action_in_registry: 'Action在册', derived_from: '溯源存在',
  kg_ready: 'KG就绪', skill_validated: 'SKILL校验', evaluator_ready: '评估器就绪',
};

export function agentAssemblyOk(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every(r => r.ok);
}

function isDegraded(detail) {
  return typeof detail === 'string' && detail.startsWith('degraded:');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderAgentCard(agentId, data) {
  const spec = data.specs?.[agentId] || {};
  const results = (data.assembly?.results || []).filter(r => r.agent === agentId);
  const ok = agentAssemblyOk(results);
  const autonomy = esc(spec.autonomy || '');
  const chips = ASSERTIONS.map(a => {
    const r = results.find(x => x.assertion === a) || {};
    const pass = r.ok;
    const degraded = isDegraded(r.detail);
    const cls = pass ? (degraded ? 'warn' : 'ok') : 'fail';
    const label = ASSERTION_LABEL[a] || a;
    const tip = esc(r.detail || '');
    return `<span class="chip ${cls}" data-assertion="${a}" title="${tip}">${label}${degraded ? ' ⚠' : ''}</span>`;
  }).join('');
  const actions = (spec.actions || []).map(esc).join('、') || '—';
  const derived = esc(spec.derivedFrom || '—');
  return `<div class="gate" data-section="agent">
    <h3>${esc(spec.name || agentId)} <span class="badge ${ok ? 'ok' : 'fail'}">${ok ? '装配通过' : '装配失败'}</span></h3>
    <div class="stage">autonomy: ${autonomy} · derivedFrom: ${derived}</div>
    <div class="chips">${chips}</div>
    <div class="metrics">
      <span class="metric">actions <b>${spec.actionCount ?? 0}</b></span>
      <span class="metric">skillCalls <b>${spec.skillCallCount ?? 0}</b></span>
    </div>
    <div class="actions">能力: ${actions}</div>
  </div>`;
}

export function renderAgents(data = {}) {
  const agents = data.agents || [];
  const overallOk = data.assembly?.ok !== false;
  const failedCount = (data.assembly?.failed || []).length;
  const health = (data.health?.domains || []).map(d => `<span class="chip ok">${esc(d)}</span>`).join('') || '<span class="chip">无</span>';
  const cards = agents.length
    ? agents.map(id => renderAgentCard(id, data)).join('')
    : '<div class="empty">无智能体</div>';
  return `<div class="statusbar">
    <span class="badge ${overallOk ? 'ok' : 'fail'}">总装配 ${overallOk ? '通过' : '失败'}</span>
    <span>智能体 <b>${agents.length}</b> · 失败断言 <b>${failedCount}</b></span>
    <span class="health">事件域: ${health}</span>
  </div>
  <div class="gates">${cards}</div>`;
}
```

- [ ] **Step 2: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/web/agentsPage.test.js`
Expected: PASS（6/6）

- [ ] **Step 3: 提交**

```bash
git add src/portal/agentsPage.js test/web/agentsPage.test.js && git commit -m "feat(agents): 监控台纯渲染函数 renderAgents + 单测 GREEN"
```

---

### Task 3: 扩展 /api/agents 附加 specs

**Files:**
- Modify: `src/http/routes.js:148-151`

- [ ] **Step 1: 改 handler**

```js
  // 装配校验 + Agent 状态 + specs 摘要（监控台用，避免前端硬编码）
  app.get('/api/agents', async (req, res) => {
    const asm = await assertAgentAssembly();
    res.json({
      agents: Object.keys(agentSpecs),
      assembly: asm,
      specs: Object.fromEntries(Object.entries(agentSpecs).map(([id, s]) => [id, {
        name: s.identity.name,
        derivedFrom: s.identity.derivedFrom,
        autonomy: s.identity.autonomy,
        actionCount: s.capabilities.actions.length,
        skillCallCount: s.capabilities.skillCalls.length,
        actions: s.capabilities.actions,
        skillCalls: s.capabilities.skillCalls,
      }])),
    });
  });
```

- [ ] **Step 2: 语法校验**

Run: `node --check src/http/routes.js`
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
git add src/http/routes.js && git commit -m "feat(agents): /api/agents 附加 specs 摘要供监控台消费"
```

---

### Task 4: 新建 agents.html 页面 + 路由别名 + 导航入口

**Files:**
- Create: `src/web/agents.html`
- Modify: `src/http/routes.js`（新增 `/agents` + `/agents.html` 静态别名）
- Modify: `src/web/nav.js`（新增入口）

- [ ] **Step 1: 写 agents.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>智能体运行监控台</title>
<style>
  body { font-family: system-ui; margin: 24px; background:#fafafa; color:#222; }
  h2 { margin:0 0 4px; }
  .sub { color:#666; font-size:13px; margin-bottom:16px; }
  .statusbar { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:10px 14px; border:1px solid #ddd; border-radius:8px; background:#fff; margin-bottom:16px; }
  .statusbar .health { color:#666; font-size:12px; }
  .gates { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; }
  .gate { border:1px solid #ddd; border-radius:8px; padding:12px 14px; background:#fff; }
  .gate h3 { margin:0 0 4px; font-size:14px; }
  .gate .stage { color:#666; font-size:12px; margin-bottom:6px; }
  .chips { display:flex; gap:4px; flex-wrap:wrap; margin:8px 0; }
  .chip { font-size:11px; padding:2px 7px; border-radius:10px; border:1px solid #ccc; background:#f5f5f5; }
  .chip.ok { background:#dcfce7; color:#166534; border-color:#86efac; }
  .chip.warn { background:#fef3c7; color:#92400e; border-color:#fde68a; }
  .chip.fail { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
  .metrics { display:flex; gap:10px; margin:6px 0; }
  .metric { background:#eef; border-radius:4px; padding:2px 8px; font-size:12px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px; font-weight:600; }
  .badge.ok { background:#dcfce7; color:#166534; }
  .badge.fail { background:#fee2e2; color:#991b1b; }
  .actions { font-size:12px; color:#475569; margin-top:4px; }
  .empty { color:#888; padding:24px; }
  #err { color:#c00; font-size:12px; }
</style>
</head>
<body>
<h2>🤖 智能体运行监控台</h2>
<div class="sub">六条装配断言实时状态 · 每 5s 自动刷新 · 降级标注以 ⚠ 区分</div>
<div id="err"></div>
<div id="board">加载中…</div>
<script>
  async function load(){
    try{
      const [a,h]=await Promise.all([
        fetch('/api/agents').then(r=>r.json()),
        fetch('/api/realtime/health').then(r=>r.json()).catch(()=>({domains:[]}))
      ]);
      document.getElementById('board').innerHTML = window.renderAgents({ ...a, health: h });
    }catch(e){ document.getElementById('err').textContent='加载失败: '+e.message; }
  }
  load(); setInterval(load, 5000);
</script>
<script type="module">
  import '/portal/agentsPage.js';
  window.renderAgents = (await import('/portal/agentsPage.js')).renderAgents;
</script>
</body>
</html>
```

- [ ] **Step 2: routes.js 补静态别名（紧邻 particle-detail 路由）**

```js
  app.get('/agents.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agents.html', import.meta.url))));
  app.get('/agents', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agents.html', import.meta.url))));
```

- [ ] **Step 3: nav.js 新增入口（在「🔍 粒子详情」之后）**

```js
  { href: '/agents', label: '🤖 智能体监控' },
```

- [ ] **Step 4: 语法/冒烟校验**

Run: `node --check src/http/routes.js && node --check src/portal/agentsPage.js`
Expected: 均通过
Run（起服务冒烟）:
```bash
PORT=3998 node src/http/server.js & sleep 3
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:3998/agents
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:3998/portal/agentsPage.js
curl -s http://localhost:3998/api/agents | head -c 120; echo
pkill -f "src/http/server.js"
```
Expected: `/agents` → `200 text/html`；`/portal/agentsPage.js` → `200 text/javascript`；`/api/agents` 含 `specs`。

- [ ] **Step 5: 提交**

```bash
git add src/web/agents.html src/http/routes.js src/web/nav.js && git commit -m "feat(agents): 监控台页面 /agents + 路由别名 + 导航入口"
```

---

### Task 5: 回归相关测试

**Files:**
- Test: `test/web/agentsPage.test.js`, `test/web/detailSections.test.js`

- [ ] **Step 1: 运行 web 模块测试**

Run: `node node_modules/vitest/vitest.mjs run test/web/`
Expected: PASS（agentsPage 6/6 + detailSections 11/11）

- [ ] **Step 2: 提交（若本步有修复）

```bash
git add -A && git commit -m "test(agents): 回归 web 模块单测通过"
```
