# 审批流配置页（item 17）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为配置中心第 17 项「审批流配置」交付一个可列 / 编 / 存四域审批流的管理页，完全复用 RBAC / business-tier 范式（专属表 `crm.approval_flow` + 专属 Router `createApprovalFlowRouter` + portal 渲染模块 + `approval-flow.html` + 4 域种子），写操作经决策第0闸，无 DELETE。

**Architecture:** 数据后端为用户拍板确定的 `crm.approval_flow` 表（`db/migrate-config.sql:26`，列 `flow_id/name/description/stages JSONB/enabled`）；`stages` 为顺序审批关卡链 `[{stage,role,action,auto_allowed}]`。Router 工厂与渲染纯函数同置于 `src/portal/approvalFlow.js`（与 `rbacMatrix.js` 同构），经 `routes.js` 挂载 `GET/PUT /api/approval-flows` + 页面路由 + `/portal/approvalFlow.js` 模块挂载；页面纯前端拉取渲染、PUT 保存经决策闸。该表与引擎粒子模型（`CRM_APPROVAL_*`）脱节属已知限制（spec §0.3/§10），本计划不打通。

**Tech Stack:** Node 22 ESM + Express 4 + vitest 3（globals OFF，测试须 `import { test, expect } from 'vitest'`）+ PostgreSQL 16（`crm.approval_flow`）。

---

### File Structure

| 文件 | 责任 | 操作 |
|------|------|------|
| `src/portal/approvalFlow.js` | 渲染纯函数 `renderApprovalFlows/renderStages/approvalFlowSummary/domainLabel/validateStages` + Router 工厂 `createApprovalFlowRouter`（含 `router.handlers` 注入式测试入口） | 新建（Task 1 建渲染；Task 2 追加 Router） |
| `test/web/approvalFlow.test.js` | portal 渲染单测 + handler 注入单测（共 ≈14 例） | 新建 |
| `src/http/routes.js` | 挂载 Router + `/approval-flow` 页路由 + `/portal/approvalFlow.js` 模块 | 修改（Task 3） |
| `src/web/approval-flow.html` | 拉取 `/api/approval-flows` 渲染表格 + 每流 `stages` 内联编辑 + 保存 | 新建（Task 4） |
| `src/portal/configCenter.js` | 第 17 项 `status:'pending'→'ready'`、补 `page/endpoint` | 修改（Task 5） |
| `db/seed.sql` + `db/test-setup.sql` | 幂等写入 4 域流 `deal/quote/contract/invoice` | 修改（Task 6） |

约定（沿用 RBAC 范式）：
- Router 工厂放在 portal 模块内，`app.use(createApprovalFlowRouter({}))` 挂载。
- 写经决策第0闸：`produceDecision` 先 `requireDecision('config-change', ctx)`，异常降级 `recordDecisionEvent`。
- 无 DELETE（铁律）。

---

### Task 1: 渲染纯函数 + 失败测试 → 实现

**Files:**
- Create: `src/portal/approvalFlow.js`
- Test: `test/web/approvalFlow.test.js`

- [ ] **Step 1: 写失败测试（渲染部分）**

`test/web/approvalFlow.test.js`：
```js
import { test, expect } from 'vitest';
import {
  DOMAIN_LABELS,
  domainLabel,
  renderApprovalFlows,
  renderStages,
  approvalFlowSummary,
  validateStages,
} from '../../src/portal/approvalFlow.js';

const FLOWS = [
  { flow_id: 'deal', name: '商机审批流', description: 'd', enabled: true,
    stages: [{ stage: 1, role: 'manager', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'admin', action: 'approve', auto_allowed: false }] },
  { flow_id: 'quote', name: '报价审批流', description: 'q', enabled: true,
    stages: [{ stage: 1, role: 'presales', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'manager', action: 'approve', auto_allowed: false }] },
  { flow_id: 'contract', name: '合同审批流', description: 'c', enabled: false,
    stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'contract_admin', action: 'approve', auto_allowed: false }] },
  { flow_id: 'invoice', name: '发票审批流', description: 'i', enabled: true,
    stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'finance', action: 'approve', auto_allowed: false }] },
];

test('DOMAIN_LABELS 含 4 个域', () => {
  expect(Object.keys(DOMAIN_LABELS)).toEqual(['deal', 'quote', 'contract', 'invoice']);
});

test('domainLabel 映射域→中文', () => {
  expect(domainLabel('deal')).toBe('商机');
  expect(domainLabel('quote')).toBe('报价');
  expect(domainLabel('contract')).toBe('合同');
  expect(domainLabel('invoice')).toBe('发票');
  expect(domainLabel('unknown')).toBe('unknown');
});

test('renderApprovalFlows 渲染 4 行 + 启用/停用徽标', () => {
  const html = renderApprovalFlows(FLOWS);
  for (const id of ['deal', 'quote', 'contract', 'invoice']) {
    expect(html).toContain(`data-flow="${id}"`);
  }
  expect(html).toContain('已启用'); // deal
  expect(html).toContain('已停用'); // contract
});

test('renderStages 渲染关卡 role/action/auto_allowed', () => {
  const html = renderStages(FLOWS[0].stages);
  expect(html).toContain('manager');
  expect(html).toContain('approve');
  expect(html).toContain('type="checkbox"'); // auto_allowed 开关
});

test('approvalFlowSummary 统计流数/启用数/关卡数', () => {
  const s = approvalFlowSummary(FLOWS);
  expect(s.count).toBe(4);
  expect(s.enabled).toBe(3); // deal/quote/invoice
  expect(s.stages).toBe(8);  // 4 × 2
});

test('validateStages 合法/非法', () => {
  expect(validateStages(FLOWS[0].stages)).toBe(true);
  expect(validateStages('not-array')).toBe(false);
  expect(validateStages([{ stage: 1, action: 'approve' }])).toBe(false); // 缺 role
  expect(validateStages([{ stage: 1, role: 'manager' }])).toBe(false);   // 缺 action
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/approvalFlow.test.js`
Expected: FAIL（`Cannot find module '../../src/portal/approvalFlow.js'` 或导出缺失）

- [ ] **Step 3: 实现 `src/portal/approvalFlow.js`（仅渲染纯函数）**

```js
// src/portal/approvalFlow.js — 审批流配置（第 17 项）
// 渲染纯函数（浏览器 + vitest 共用）+ 表驱动 GET/PUT 端点（决策第0闸）
// 数据后端：crm.approval_flow（db/migrate-config.sql:26）；与引擎粒子模型脱节（spec §0.3）
export const DOMAIN_LABELS = {
  deal: '商机',
  quote: '报价',
  contract: '合同',
  invoice: '发票',
};

export function domainLabel(d) {
  return DOMAIN_LABELS[d] || d;
}

// stages 校验：数组，且每项含 stage(数字串)/role(串)/action(串)
export function validateStages(stages) {
  if (!Array.isArray(stages)) return false;
  return stages.every(
    (s) => s && typeof s === 'object' && s.stage != null && typeof s.role === 'string' && typeof s.action === 'string'
  );
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderStages(stages = []) {
  if (!stages.length) return `<div class="stages empty">（无关卡）</div>`;
  const rows = stages
    .map((s, i) => {
      const checked = s.auto_allowed ? 'checked' : '';
      return `<div class="stage-row" data-idx="${i}">
        <span class="stg-no">${esc(s.stage)}</span>
        <input class="stg-role" value="${esc(s.role)}" placeholder="role" />
        <input class="stg-action" value="${esc(s.action)}" placeholder="action" />
        <label class="stg-auto"><input type="checkbox" class="stg-auto-chk" ${checked} /> 自动通过</label>
      </div>`;
    })
    .join('');
  return `<div class="stages">${rows}</div>`;
}

export function renderApprovalFlows(flows = []) {
  if (!flows.length) return `<div class="empty">尚未配置任何审批流（crm.approval_flow）</div>`;
  const rows = flows
    .map((f) => {
      const enabledBadge = f.enabled
        ? `<span class="badge ok">已启用</span>`
        : `<span class="badge off">已停用</span>`;
      return `<tr class="flow-row" data-flow="${esc(f.flow_id)}">
        <td class="fid">${esc(f.flow_id)}</td>
        <td class="fname">${esc(f.name)}</td>
        <td class="fdomain">${esc(domainLabel(f.flow_id))}</td>
        <td class="fenabled">${enabledBadge}</td>
        <td class="fstages">${renderStages(f.stages)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="flow-table"><thead><tr>
      <th>流ID</th><th>名称</th><th>域</th><th>状态</th><th>审批关卡</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

export function approvalFlowSummary(flows = []) {
  const list = flows || [];
  const enabled = list.filter((f) => f.enabled).length;
  const stages = list.reduce((n, f) => n + (Array.isArray(f.stages) ? f.stages.length : 0), 0);
  return { count: list.length, enabled, stages };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/approvalFlow.test.js`
Expected: PASS（6 例渲染测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/portal/approvalFlow.js test/web/approvalFlow.test.js
git commit -m "feat(approval-flow): 渲染纯函数 + 单测（item 17 渲染层）"
```

---

### Task 2: Router 工厂 + handler 测试

**Files:**
- Modify: `src/portal/approvalFlow.js`（追加 Router 工厂）
- Test: `test/web/approvalFlow.test.js`（追加 handler 单测）

- [ ] **Step 1: 追加失败测试（handler 部分）到 `test/web/approvalFlow.test.js` 末尾**

```js
import { createApprovalFlowRouter } from '../../src/portal/approvalFlow.js';

function makeDeps(over = {}) {
  const rows = {
    deal: { flow_id: 'deal', name: '商机审批流', description: 'd', enabled: true,
      stages: [{ stage: 1, role: 'manager', action: 'approve', auto_allowed: false }] },
  };
  return {
    listFlows: async () => Object.values(rows).map((r) => ({ ...r })),
    getFlow: async (id) => rows[id] || null,
    upsertFlow: async (flow) => { rows[flow.flow_id] = { ...flow }; return { ...flow }; },
    produceDecision: over.produceDecision || (async () => ({ decision_id: 'd1' })),
  };
}

test('GET /api/approval-flows 返回流列表', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  let cap = null;
  const res = { json: (x) => { cap = x; return x; } };
  await router.handlers.list({}, res);
  expect(cap.flows.length).toBe(1);
  expect(cap.flows[0].flow_id).toBe('deal');
});

test('PUT /api/approval-flows upsert 触发 produceDecision', async () => {
  let decided = null;
  const deps = makeDeps({ produceDecision: async (d) => { decided = d; return { decision_id: 'd2' }; } });
  const router = createApprovalFlowRouter(deps);
  const res = { json: (x) => x };
  const body = { flow_id: 'quote', name: '报价审批流', stages: [{ stage: 1, role: 'presales', action: 'approve' }], enabled: true };
  await router.handlers.put({ body }, res);
  expect(decided).not.toBeNull();
  expect(decided.flow_id).toBe('quote');
});

test('PUT 缺 flow_id → 400', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { name: 'x', stages: [] } }, res);
  expect(status).toBe(400);
});

test('PUT stages 非法 → 400', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { flow_id: 'bad', name: 'x', stages: [{ stage: 1 }] } }, res);
  expect(status).toBe(400);
});

test('Router 不含 DELETE 路由（铁律：绝对禁删）', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/approvalFlow.test.js`
Expected: FAIL（`createApprovalFlowRouter` 未定义）

- [ ] **Step 3: 在 `src/portal/approvalFlow.js` 末尾追加 Router 工厂**

```js
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';

const defaultDeps = {
  listFlows: async () => {
    const r = await query(`SELECT flow_id, name, description, stages, enabled FROM crm.approval_flow ORDER BY flow_id`);
    return r.rows;
  },
  getFlow: async (id) => {
    const r = await query(`SELECT flow_id, name, description, stages, enabled FROM crm.approval_flow WHERE flow_id=$1`, [id]);
    return r.rows[0] || null;
  },
  upsertFlow: async (flow) => {
    const r = await query(
      `INSERT INTO crm.approval_flow (flow_id, name, description, stages, enabled, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())
       ON CONFLICT (flow_id) DO UPDATE SET name=$2, description=$3, stages=$4::jsonb, enabled=$5, updated_at=now()
       RETURNING flow_id, name, description, stages, enabled`,
      [flow.flow_id, flow.name, flow.description ?? null, JSON.stringify(flow.stages), flow.enabled !== false]
    );
    return r.rows[0];
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createApprovalFlowRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const handlers = {
    list: async (req, res) => {
      try {
        const flows = await D.listFlows();
        res.json({ flows });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    get: async (req, res) => {
      try {
        const flow = await D.getFlow(req.params.id);
        if (!flow) return res.status(404).json({ error: '审批流不存在' });
        res.json({ flow });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const { flow_id, name, description, stages, enabled } = req.body || {};
        if (!flow_id || !name) return res.status(400).json({ error: 'flow_id / name 必填' });
        if (!validateStages(stages)) return res.status(400).json({ error: 'stages 必须为 [{stage,role,action}] 数组' });
        const decision = await D.produceDecision({ flow_id, name });
        const flow = await D.upsertFlow({ flow_id, name, description, stages, enabled });
        res.json({ ok: true, flow, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/approval-flows', handlers.list);
  router.get('/api/approval-flows/:id', handlers.get);
  router.put('/api/approval-flows/:id', handlers.put);
  router.handlers = handlers; // 注入式测试（无 delete）
  return router;
}
```

> 注意：`src/portal/approvalFlow.js` 顶部 Task 1 已写 `export` 渲染函数但未 `import` express；本步追加的 import 必须放在**文件顶部**（与现有 `export const DOMAIN_LABELS` 之间无冲突；ESM 允许 import 在模块任意顶层位置，但规范起见把 import 置于文件最前）。实现时把 `import { Router }...` / `import { query }...` / `import { requireDecision }...` / `import { recordDecisionEvent }...` 四行移到文件第一行起，渲染函数紧随其后。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/approvalFlow.test.js`
Expected: PASS（渲染 6 + handler 5 = 11 例；Task 1 的 6 例 + 本步 5 例）

- [ ] **Step 5: 提交**

```bash
git add src/portal/approvalFlow.js test/web/approvalFlow.test.js
git commit -m "feat(approval-flow): Router 工厂 + 决策第0闸 + handler 单测（item 17 端点）"
```

---

### Task 3: routes.js 挂载 Router + 页面路由 + 模块

**Files:**
- Modify: `src/http/routes.js`

- [ ] **Step 1: 添加 import（在 `routes.js:31` `import { createRbacRouter }...` 之后）**

```js
import { createApprovalFlowRouter } from '../portal/approvalFlow.js';
```

- [ ] **Step 2: 挂载 Router（在 `routes.js:58` `app.use(createRbacRouter({}));` 之后）**

```js
  app.use(createApprovalFlowRouter({}));
```

- [ ] **Step 3: 添加页面路由 + 模块挂载（在 `routes.js:788` `app.get('/portal/rbacMatrix.js'...)` 之后）**

```js
  app.get('/approval-flow.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/approval-flow.html', import.meta.url))));
  app.get('/approval-flow', (req, res) => res.redirect('/approval-flow.html'));
  app.get('/portal/approvalFlow.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/approvalFlow.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 4: 冒烟验证（需本地 PG 起服务手动确认；沙箱仅保证语法）**

Run: `cd D:/system/CRM-ai-native && node -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: 打印 `routes OK`（无模块解析/语法错误）

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js
git commit -m "feat(approval-flow): routes 挂载 /api/approval-flows + /approval-flow 页 + portal 模块"
```

---

### Task 4: 页面 approval-flow.html

**Files:**
- Create: `src/web/approval-flow.html`

- [ ] **Step 1: 写页面（复用 rbac.html 风格 + 审批流编辑器）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>审批流配置 · 配置中心</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 0; background: #f4f6f8; color: #1f2933; }
  header { background: #1e3a5f; color: #fff; padding: 14px 20px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 17px; margin: 0; }
  .sub { font-size: 12px; opacity: .8; }
  .wrap { padding: 18px 20px; max-width: 1280px; margin: 0 auto; }
  .panel { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 16px; }
  .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  button { background: #1e3a5f; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button.sec { background: #647489; }
  button:hover { opacity: .9; }
  #status { font-size: 12px; color: #647489; }
  table.flow-table { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.flow-table th, table.flow-table td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  table.flow-table thead th { background: #eef2f7; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 12px; }
  .badge.ok { background: #d6f5dd; color: #137333; }
  .badge.off { background: #fde2e2; color: #a3321f; }
  .stages { display: flex; flex-direction: column; gap: 4px; }
  .stage-row { display: flex; gap: 6px; align-items: center; }
  .stg-no { width: 22px; text-align: center; color: #647489; }
  .stg-role, .stg-action { padding: 3px 5px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 12px; }
  .stg-role { width: 110px; }
  .stg-action { width: 90px; }
  .note { background: #fff7e6; border: 1px solid #ffe0a3; color: #8a5a00; padding: 10px 12px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; }
  .empty { color: #8a94a6; padding: 12px; }
</style>
</head>
<body>
<header>
  <h1>⚙️ 审批流配置</h1>
  <span class="sub">四域审批流定义（deal/quote/contract/invoice）· 写经决策第0闸</span>
</header>
<div class="wrap">
  <div class="note">说明：本页管理 <b>crm.approval_flow</b> 表。每流含顺序审批关卡链（stage/role/action/auto_allowed）。修改关卡后点「保存变更」，写操作经决策第0闸（无决策不写）。<b>已知限制</b>：该表与引擎粒子模型（CRM_APPROVAL_*）当前脱节，不实时驱动运行态审批行为。</div>
  <div class="panel">
    <div class="toolbar">
      <button id="saveBtn">保存变更</button>
      <button class="sec" id="reloadBtn">重新加载</button>
      <span id="status">就绪</span>
    </div>
    <div id="flows" class="empty">加载中…</div>
  </div>
</div>

<script type="module">
  import { renderApprovalFlows } from '/portal/approvalFlow.js';

  let current = [];

  async function load() {
    const r = await fetch('/api/approval-flows');
    const d = await r.json();
    current = d.flows || [];
    document.getElementById('flows').innerHTML = renderApprovalFlows(current);
    document.getElementById('status').textContent = `已加载 ${current.length} 个审批流`;
  }

  // 收集页面编辑后的 stages → 构造 PUT payload 列表
  function collect() {
    return current.map((f) => {
      const tr = document.querySelector(`tr.flow-row[data-flow="${f.flow_id}"]`);
      const stageRows = [...tr.querySelectorAll('.stage-row')];
      const stages = stageRows.map((sr, i) => ({
        stage: i + 1,
        role: sr.querySelector('.stg-role').value,
        action: sr.querySelector('.stg-action').value,
        auto_allowed: sr.querySelector('.stg-auto-chk').checked,
      }));
      const enabled = !tr.querySelector('.fenabled').textContent.includes('停用');
      return { flow_id: f.flow_id, name: f.name, description: f.description, stages, enabled };
    });
  }

  document.getElementById('saveBtn').addEventListener('click', async () => {
    const payloads = collect();
    if (!confirm(`确认保存 ${payloads.length} 个审批流？（写操作经决策第0闸）`)) return;
    let ok = 0, fail = 0;
    for (const p of payloads) {
      const r = await fetch(`/api/approval-flows/${p.flow_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      if (r.ok) ok++; else fail++;
    }
    document.getElementById('status').textContent = `保存完成：成功 ${ok} / 失败 ${fail}`;
    if (fail === 0) await load();
  });

  document.getElementById('reloadBtn').addEventListener('click', load);
  load();
</script>
<script type="module">import '/portal/nav.js';</script>
</body>
</html>
```

- [ ] **Step 2: 提交**

```bash
git add src/web/approval-flow.html
git commit -m "feat(approval-flow): approval-flow.html 管理页（item 17 前端）"
```

---

### Task 5: 配置中心第 17 项翻 ready

**Files:**
- Modify: `src/portal/configCenter.js:15`

- [ ] **Step 1: 修改 CONFIG_ITEMS 第 17 项**

将 `src/portal/configCenter.js` 第 15 行：
```js
  { id: 17, name: '审批流配置', group: '治理', status: 'pending', page: null, endpoint: null, note: '六层=粒子设计，无配置页' },
```
改为：
```js
  { id: 17, name: '审批流配置', group: '治理', status: 'ready', page: '/approval-flow.html', endpoint: '/api/approval-flows', note: '四域审批流定义（deal/quote/contract/invoice），写经决策第0闸' },
```

- [ ] **Step 2: 运行 configCenter 既有测试确认无回归**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/configCenter.test.js`
Expected: PASS（既有 7 例；本改仅翻转 status 字段，不影响既有断言——若既有测试对第17项做 pending 断言需同步，见 Step 3）

- [ ] **Step 3: 若既有 configCenter 测试含对 item 17 的 pending 断言，同步更新为 ready**

检索 `test/web/configCenter.test.js` 中 `id: 17` 或 `'审批流'` 相关断言，改为期望 `status === 'ready'` 且 `page === '/approval-flow.html'`。

- [ ] **Step 4: 提交**

```bash
git add src/portal/configCenter.js test/web/configCenter.test.js
git commit -m "feat(approval-flow): 配置中心第 17 项翻 ready 可跳转"
```

---

### Task 6: 4 域种子

**Files:**
- Modify: `db/seed.sql`（末尾追加）
- Modify: `db/test-setup.sql`（末尾追加，保持测试与种子一致）

- [ ] **Step 1: 在 `db/seed.sql` 末尾追加（幂等 UPSERT）**

```sql
-- 审批流配置种子（item 17，G21 四审批域；与引擎粒子模型脱节属已知限制）
INSERT INTO crm.approval_flow (flow_id, name, description, stages, enabled) VALUES
  ('deal', '商机审批流', '商机推进至赢单前的两级审批',
   '[{"stage":1,"role":"manager","action":"approve","auto_allowed":false},{"stage":2,"role":"admin","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('quote', '报价审批流', '报价单发出前审批',
   '[{"stage":1,"role":"presales","action":"approve","auto_allowed":false},{"stage":2,"role":"manager","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('contract', '合同审批流', '合同签署前审批',
   '[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"contract_admin","action":"approve","auto_allowed":false}]'::jsonb, TRUE),
  ('invoice', '发票审批流', '发票开具前审批',
   '[{"stage":1,"role":"sales","action":"approve","auto_allowed":false},{"stage":2,"role":"finance","action":"approve","auto_allowed":false}]'::jsonb, TRUE)
ON CONFLICT (flow_id) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, stages=EXCLUDED.stages, enabled=EXCLUDED.enabled, updated_at=now();
```

- [ ] **Step 2: 在 `db/test-setup.sql` 末尾追加相同 4 条（保证 vitest 真实 PG 起服务时与种子一致）**

同上 SQL 块原样追加到 `db/test-setup.sql` 末尾。

- [ ] **Step 3: 提交**

```bash
git add db/seed.sql db/test-setup.sql
git commit -m "feat(approval-flow): 四域审批流种子（deal/quote/contract/invoice）"
```

---

### Task 7: 全量测试 + 冒烟

**Files:** 无新建，仅验证

- [ ] **Step 1: 运行全量 web 测试**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/`
Expected: PASS（基线 44 + 本计划 11 = 55 例 web 测试全绿；其余 test/ 套件不回归）

- [ ] **Step 2: 运行全量测试套件（确认无跨模块回归）**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run`
Expected: 全绿（基线 ≈398 → ≈409；若基线因环境波动见历史 note，关注新增 approvalFlow 11 例全绿即可）

- [ ] **Step 3: 冒烟（本地 PG 起服务手动验证，沙箱仅语法）**

```bash
cd D:/system/CRM-ai-native && npm start &
# 另开：curl -s localhost:3000/api/approval-flows | head
# 期望返回 4 个流（deal/quote/contract/invoice）
# curl -s -X PUT localhost:3000/api/approval-flows/deal -H 'Content-Type: application/json' \
#   -d '{"flow_id":"deal","name":"商机审批流","stages":[{"stage":1,"role":"manager","action":"approve"}],"enabled":true}' | head
# 期望 ok:true
```

- [ ] **Step 4: 更新工作日志**

向 `D:/system/CRM-ai-native/.workbuddy/memory/2026-08-27.md` 追加：item 17 审批流配置完成（portal+router+page+seed+test 共 11 例，基线 44→55）。

---

## Self-Review（对照 spec）

1. **Spec 覆盖**：
   - §1 数据后端 `crm.approval_flow` → Task 3/6 ✓
   - §2 Router `GET/PUT /api/approval-flows` + 决策第0闸 + 无 DELETE → Task 2 ✓（handler 测试含 delete 缺失断言）
   - §3 portal 渲染 `renderApprovalFlows/renderStages/approvalFlowSummary` + 域标签 → Task 1 ✓
   - §4 页面 `approval-flow.html` 拉取/编辑/保存 → Task 4 ✓
   - §5 4 域种子 → Task 6 ✓
   - §6 测试 TDD RED→GREEN → 各 Task ✓
   - §7 验收 → Task 7 ✓
   - §0.3/§10 已知限制（与引擎脱节）→ Task 4 note + Task 1 文件头注释 ✓
2. **Placeholder 扫描**：无 TBD/TODO；每步含完整代码。
3. **类型一致性**：`stages` 结构 `{stage,role,action,auto_allowed}` 在 seed / 渲染 / 校验 / handler 全程一致；`flow_id` 为 PK 且 PUT body 必含；`validateStages` 在 Task 1 定义、Task 2 复用；`produceDecision` 返回 `{decisionId, ok}` 与 RBAC 同构。

> 已知取舍（spec §2.3）：代码实际角色集无 `executive`，deal 第二关暂用 `admin` 占位；如需改角色请告知。
