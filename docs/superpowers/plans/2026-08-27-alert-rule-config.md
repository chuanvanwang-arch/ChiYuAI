# 预警规则配置页（item 21 · DB 持久化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为配置中心第 21 项「预警规则配置」交付管理页，使 5 类业务告警规则（deal_stuck / lead_overdue / forecast_breach / approval_bottleneck / payment_due）可在界面启停 + 编辑阈值 + 选严重度/目标角色，写经决策第0闸、绝对禁删，并新建 `crm.alert_rule` 表做持久化（内存缓存为实时热路径，DB 为持久源，启动水合）。

**Architecture:** 沿用 RBAC / business-tier / approval-flow 同构范式——专属 Router `createAlertRuleConfigRouter`（位于 `src/portal/alertRuleConfig.js`）+ 渲染纯函数 + `alert-rules.html` 页 + 配置中心项翻 ready。预警引擎热路径 `alertHook.js:22` 同步读 `alertRegistry.js` 内存缓存（`listAlertRules/evaluateForEvent` 签名**不变**，否则破坏 `test/alert.test.js` T1/T4）；DB 持久化仅作异步旁路：PUT 改缓存后 `persistAlertRule` 落库，启动 `hydrateAlertRules()` 回填缓存，未建表则回退 `DEFAULT_RULES`。

**Tech Stack:** Node 22 + ESM + Express 4 + Express Router + PostgreSQL（`crm.alert_rule`）；门户 ESM 模块（`/portal/*.js`，`Content-Type:text/javascript`）浏览器与 vitest 共用；vitest（globals OFF，须 `import {test,expect} from 'vitest'`）。

**硬约束（不可破）：** `alertRegistry.js` 的 `listAlertRules / setRuleEnabled / enabledAlertRules / evaluateForEvent / resetAlertRegistry` 签名与同步语义一律不动；DB 访问只能经新增异步函数（`persistAlertRule` / `hydrateAlertRules`），不得同步阻塞热路径。

---

## 文件结构

- 新建 `src/portal/alertRuleConfig.js`：渲染纯函数（`KIND_LABELS / renderAlertRules / renderCheckParams / alertRuleSummary / validateCheckParams`）+ `createAlertRuleConfigRouter` + `hydrateAlertRules`
- 修改 `src/alerts/alertRegistry.js`：新增 `updateAlertRule(kind, patch)` 同步缓存函数（**不 import db.js**）
- 修改 `db/migrate-config.sql`：追加 `crm.alert_rule` 建表（幂等）
- 修改 `db/seed.sql` + `db/test-setup.sql`：追加 5 类种子
- 修改 `src/http/routes.js`：import + `app.use(createAlertRuleConfigRouter({}))` + 页路由 + portal 模块挂载 + `createRoutes` 内 hydrate 调用
- 新建 `src/web/alert-rules.html`：拉取→渲染→编辑→保存
- 修改 `src/portal/configCenter.js`：第 21 项 `pending→ready` + 补 `page/endpoint`
- 新建 `test/web/alertRuleConfig.test.js`：渲染 ~6 例 + handler ~6 例

---

### Task 1: 渲染纯函数 + 渲染测试（RED→GREEN）

**Files:**
- Create: `src/portal/alertRuleConfig.js`
- Test: `test/web/alertRuleConfig.test.js`

- [ ] **Step 1: 写失败渲染测试**

```js
// test/web/alertRuleConfig.test.js
import { test, expect } from 'vitest';
import {
  KIND_LABELS, kindLabel, renderCheckParams, renderAlertRules, alertRuleSummary, validateCheckParams,
} from '../../src/portal/alertRuleConfig.js';

const RULES = [
  { kind: 'deal_stuck', match: { particleTypes: ['CRM_DEAL'], actions: ['stage_update'] }, check_params: { stuck_days: 30 }, severity: 'medium', target_role: 'sales', enabled: true, version: 1 },
  { kind: 'lead_overdue', match: { particleTypes: ['CRM_DEAL'], actions: ['followup'] }, check_params: { overdue_days: 30 }, severity: null, target_role: null, enabled: false, version: 1 },
];

test('KIND_LABELS / kindLabel', () => {
  expect(KIND_LABELS.deal_stuck).toBe('商机停滞');
  expect(kindLabel('lead_overdue')).toBe('线索逾期');
  expect(kindLabel('unknown')).toBe('unknown');
});

test('renderCheckParams 渲染已知阈值字段', () => {
  const html = renderCheckParams('deal_stuck', { stuck_days: 30 });
  expect(html).toContain('stuck_days');
  expect(html).toContain('value="30"');
});

test('renderAlertRules 表格含 5 关键字段', () => {
  const html = renderAlertRules(RULES);
  expect(html).toContain('deal_stuck');
  expect(html).toContain('商机停滞');
  expect(html).toContain('checked'); // enabled 开关
  expect(html).toContain('severity');
  expect(html).toContain('target_role');
});

test('renderAlertRules 空态', () => {
  expect(renderAlertRules([])).toContain('尚未配置任何预警规则');
});

test('alertRuleSummary 统计', () => {
  expect(alertRuleSummary(RULES)).toEqual({ count: 2, enabled: 1 });
});

test('validateCheckParams 合法/非法', () => {
  expect(validateCheckParams({ stuck_days: 30 })).toBe(true);
  expect(validateCheckParams(null)).toBe(false);
  expect(validateCheckParams([1, 2])).toBe(false);
  expect(validateCheckParams('x')).toBe(false);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/alertRuleConfig.test.js 2>&1 | tail -15`
Expected: FAIL（`Cannot find module '../../src/portal/alertRuleConfig.js'`）

- [ ] **Step 3: 实现渲染纯函数**

```js
// src/portal/alertRuleConfig.js — 预警规则配置（第 21 项）
// 渲染纯函数（浏览器 + vitest 共用）。预览引擎实时事实源 = alertRegistry 内存缓存；
// DB（crm.alert_rule）为持久源，异步落库 + 启动水合（见 createAlertRuleConfigRouter / hydrateAlertRules）
export const KIND_LABELS = {
  deal_stuck: '商机停滞',
  lead_overdue: '线索逾期',
  forecast_breach: '预测缺口',
  approval_bottleneck: '审批瓶颈',
  payment_due: '回款到期',
};

export function kindLabel(k) {
  return KIND_LABELS[k] || k;
}

// check_params 阈值编辑（按 kind 渲染对应字段，通用遍历对象键）
export function renderCheckParams(kind, check_params = {}) {
  const cp = check_params || {};
  const keys = Object.keys(cp);
  if (!keys.length) return `<div class="cp empty">（无阈值）</div>`;
  const rows = keys
    .map((key) => `<label class="cp-row"><span class="cp-key">${esc(key)}</span><input type="number" class="cp-val" data-key="${esc(key)}" value="${esc(cp[key])}" /></label>`)
    .join('');
  return `<div class="cp" data-kind="${esc(kind)}">${rows}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderAlertRules(rules = []) {
  if (!rules.length) return `<div class="empty">尚未配置任何预警规则（crm.alert_rule）</div>`;
  const rows = rules
    .map((r) => {
      const enabledChk = r.enabled ? 'checked' : '';
      return `<tr class="rule-row" data-kind="${esc(r.kind)}">
        <td class="rkind">${esc(r.kind)}</td>
        <td class="rlabel">${esc(kindLabel(r.kind))}</td>
        <td class="renabled"><label><input type="checkbox" class="r-enabled" ${enabledChk} /> 启用</label></td>
        <td class="rcp">${renderCheckParams(r.kind, r.check_params)}</td>
        <td class="rsev"><select class="r-severity">
          <option value="">默认</option>
          <option value="low"${r.severity === 'low' ? ' selected' : ''}>低</option>
          <option value="medium"${r.severity === 'medium' ? ' selected' : ''}>中</option>
          <option value="high"${r.severity === 'high' ? ' selected' : ''}>高</option>
        </select></td>
        <td class="rrole"><select class="r-target_role">
          <option value="">默认</option>
          <option value="sales"${r.target_role === 'sales' ? ' selected' : ''}>sales</option>
          <option value="manager"${r.target_role === 'manager' ? ' selected' : ''}>manager</option>
          <option value="finance"${r.target_role === 'finance' ? ' selected' : ''}>finance</option>
          <option value="contract_admin"${r.target_role === 'contract_admin' ? ' selected' : ''}>contract_admin</option>
          <option value="presales"${r.target_role === 'presales' ? ' selected' : ''}>presales</option>
          <option value="ops"${r.target_role === 'ops' ? ' selected' : ''}>ops</option>
        </select></td>
      </tr>`;
    })
    .join('');
  return `<table class="rule-table"><thead><tr>
    <th>规则</th><th>名称</th><th>启用</th><th>阈值(check_params)</th><th>严重度</th><th>目标角色</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

export function alertRuleSummary(rules = []) {
  const list = rules || [];
  const enabled = list.filter((r) => r.enabled).length;
  return { count: list.length, enabled };
}

// check_params 校验：必须为非空普通对象（非数组、非 null）
export function validateCheckParams(cp) {
  return cp && typeof cp === 'object' && !Array.isArray(cp);
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/alertRuleConfig.test.js 2>&1 | tail -15`
Expected: PASS（6/6）

- [ ] **Step 5: 提交**

```bash
git add src/portal/alertRuleConfig.js test/web/alertRuleConfig.test.js
git commit -m "feat(alert-rule): 渲染纯函数+6测试"
```

---

### Task 2: updateAlertRule（同步缓存） + Router 工厂 + handler 测试（RED→GREEN）

**Files:**
- Modify: `src/alerts/alertRegistry.js` （追加 `updateAlertRule`）
- Modify: `src/portal/alertRuleConfig.js` （追加 `createAlertRuleConfigRouter` + `hydrateAlertRules`）
- Test: `test/web/alertRuleConfig.test.js` （追加 handler 测试）

- [ ] **Step 1: 在 alertRegistry.js 追加同步缓存更新函数（不 import db.js）**

```js
// 追加到 src/alerts/alertRegistry.js 末尾（在 evaluateForEvent 之后）
// 配置页写入口：同步改内存缓存（引擎热路径实时读）；DB 落库由 Router 异步旁路负责
export function updateAlertRule(kind, patch = {}) {
  const rule = rules.find((r) => r.kind === kind);
  if (!rule) return { ok: false, error: 'rule_not_found' };
  if (patch.enabled !== undefined) rule.enabled = !!patch.enabled;
  if (patch.check_params !== undefined) {
    if (!patch.check_params || typeof patch.check_params !== 'object' || Array.isArray(patch.check_params))
      return { ok: false, error: 'invalid_check_params' };
    rule.check_params = { ...rule.check_params, ...patch.check_params };
  }
  if (patch.severity !== undefined) rule.severity = patch.severity || null;
  if (patch.target_role !== undefined) rule.target_role = patch.target_role || null;
  return { ok: true, rule: { ...rule } };
}
```

- [ ] **Step 2: 追加失败 handler 测试**

```js
// 追加到 test/web/alertRuleConfig.test.js
import { createAlertRuleConfigRouter } from '../../src/portal/alertRuleConfig.js';
import { resetAlertRegistry, updateAlertRule } from '../../src/alerts/alertRegistry.js';

function makeDeps(over = {}) {
  const persisted = [];
  return {
    listRules: () => [{ kind: 'deal_stuck', check_params: { stuck_days: 30 }, enabled: true }],
    updateCache: (kind, patch) => updateAlertRule(kind, patch),
    persist: async (kind, patch) => { persisted.push({ kind, patch }); return { ok: true }; },
    produceDecision: async () => ({ decisionId: 'd-1', ok: true }),
    _persisted: persisted,
    ...over,
  };
}

beforeEach(() => resetAlertRegistry());

test('GET /api/alert-rules 返回 listRules', async () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  let body = null;
  const res = { json: (p) => { body = p; return res; }, status: () => res };
  await router.handlers.list({}, res);
  expect(body.rules).toBeDefined();
  expect(Array.isArray(body.rules)).toBe(true);
});

test('PUT 未知 kind → 404', async () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put({ params: { kind: 'nope' }, body: { enabled: false } }, res);
  expect(code).toBe(404);
  expect(body.error).toContain('rule_not_found');
});

test('PUT 合法 → updateCache + persist + 决策闸', async () => {
  const deps = makeDeps();
  const router = createAlertRuleConfigRouter(deps);
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put({ params: { kind: 'deal_stuck' }, body: { enabled: false, check_params: { stuck_days: 45 } } }, res);
  expect(code).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.decision).toBe('d-1');
  expect(deps._persisted.length).toBe(1);
  expect(deps._persisted[0].kind).toBe('deal_stuck');
  // 缓存已改
  const updated = updateAlertRule('deal_stuck', {});
  expect(updated.rule.check_params.stuck_days).toBe(45);
  expect(updated.rule.enabled).toBe(false);
});

test('PUT check_params 非法 → 400', async () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put({ params: { kind: 'deal_stuck' }, body: { check_params: 'bad' } }, res);
  expect(code).toBe(400);
  expect(body.error).toContain('对象');
});

test('无 DELETE 路由', () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
});
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/alertRuleConfig.test.js 2>&1 | tail -20`
Expected: FAIL（`createAlertRuleConfigRouter is not a function`）

- [ ] **Step 4: 在 alertRuleConfig.js 追加 Router 工厂 + hydrate（精确镜像 approvalFlow.js 决策第0闸）**

```js
// 追加到 src/portal/alertRuleConfig.js 末尾（接在 validateCheckParams 之后）
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { listAlertRules, updateAlertRule } from '../alerts/alertRegistry.js';

const defaultDeps = {
  listRules: () => listAlertRules(),
  updateCache: (kind, patch) => updateAlertRule(kind, patch),
  persist: async (kind, patch) => {
    try {
      await query(
        `UPDATE crm.alert_rule SET enabled=$2, check_params=$3::jsonb, severity=$4, target_role=$5, version=COALESCE(version,1)+1, updated_at=now() WHERE kind=$1`,
        [kind, patch.enabled !== undefined ? !!patch.enabled : null, JSON.stringify(patch.check_params || {}), patch.severity || null, patch.target_role || null]
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
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

export function createAlertRuleConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const handlers = {
    list: async (req, res) => {
      try {
        const rules = await D.listRules();
        res.json({ rules });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const { kind } = req.params;
        const { enabled, check_params, severity, target_role } = req.body || {};
        if (check_params !== undefined && !validateCheckParams(check_params))
          return res.status(400).json({ error: 'check_params 必须为对象' });
        const patch = {};
        if (enabled !== undefined) patch.enabled = enabled;
        if (check_params !== undefined) patch.check_params = check_params;
        if (severity !== undefined) patch.severity = severity;
        if (target_role !== undefined) patch.target_role = target_role;
        const cached = D.updateCache(kind, patch);
        if (!cached.ok) return res.status(404).json({ error: cached.error });
        const decision = await D.produceDecision({ kind, patch });
        await D.persist(kind, patch);
        res.json({ ok: true, rule: cached.rule, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };
  router.get('/api/alert-rules', handlers.list);
  router.put('/api/alert-rules/:kind', handlers.put);
  router.handlers = handlers; // 无 delete
  return router;
}

// 启动水合：从 crm.alert_rule 回填内存缓存（PG 不可用则静默回退 DEFAULT_RULES）
export async function hydrateAlertRules() {
  try {
    const r = await query(`SELECT kind, enabled, check_params, severity, target_role FROM crm.alert_rule`);
    for (const row of r.rows) {
      updateAlertRule(row.kind, {
        enabled: row.enabled,
        check_params: row.check_params || {},
        severity: row.severity,
        target_role: row.target_role,
      });
    }
  } catch {
    /* 未建表 → 保持 DEFAULT_RULES 内存镜像，评估照常 */
  }
}
```

> 测试 Step 2 的 `makeDeps` 用注入 `listRules`/`updateCache`/`persist`/`produceDecision`，故不依赖真实 registry 与 PG，可独立 GREEN。默认实现中 `defaultDeps.updateCache` 用真实 `updateAlertRule`（同步），`listRules` 用 `listAlertRules`，与注入一致。

- [ ] **Step 5: 运行测试确认 GREEN（11/11）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/alertRuleConfig.test.js 2>&1 | tail -15`
Expected: PASS（11/11）

- [ ] **Step 6: 提交**

```bash
git add src/alerts/alertRegistry.js src/portal/alertRuleConfig.js test/web/alertRuleConfig.test.js
git commit -m "feat(alert-rule): updateAlertRule+Router+11测试"
```

---

### Task 3: crm.alert_rule 建表 + 5 类种子

**Files:**
- Modify: `db/migrate-config.sql` （追加建表）
- Modify: `db/seed.sql` + `db/test-setup.sql` （追加 5 类种子）

- [ ] **Step 1: 在 migrate-config.sql 末尾追加建表（幂等）**

```sql
-- 预警规则配置（第 21 项；内存 alertRegistry 的持久源，启动 hydrate 回填）
-- 引擎热路径同步读缓存；本表为持久源，异步落库
CREATE TABLE IF NOT EXISTS crm.alert_rule (
  kind          TEXT PRIMARY KEY,
  match         JSONB NOT NULL DEFAULT '{}',
  check_params  JSONB NOT NULL DEFAULT '{}',
  severity      TEXT,                       -- low|medium|high|NULL(引擎默认 medium)
  target_role   TEXT,                       -- sales|manager|finance|contract_admin|presales|ops|NULL(引擎默认 ops)
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  version       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: 在 db/seed.sql 与 db/test-setup.sql 末尾追加 5 类种子（幂等 UPSERT，severity/target_role 留 NULL）**

```sql
-- 预警规则配置种子（item 21，5 类；severity/target_role 留 NULL 由引擎默認 medium/ops）
INSERT INTO crm.alert_rule (kind, match, check_params, enabled, version) VALUES
  ('deal_stuck', '{"particleTypes":["CRM_DEAL"],"actions":["stage_update","advance"]}'::jsonb, '{"stuck_days":30}'::jsonb, TRUE, 1),
  ('lead_overdue', '{"particleTypes":["CRM_DEAL"],"actions":["lead-picked","lead-recycled","followup","update"]}'::jsonb, '{"overdue_days":30}'::jsonb, TRUE, 1),
  ('forecast_breach', '{"particleTypes":["CRM_DEAL"],"actions":["forecast_update","amount_update"]}'::jsonb, '{"breach_pct":0.8}'::jsonb, TRUE, 1),
  ('approval_bottleneck', '{"particleTypes":["*"],"actions":["approval_create"]}'::jsonb, '{"bottleneck_count":5}'::jsonb, TRUE, 1),
  ('payment_due', '{"particleTypes":["CRM_INVOICE"],"actions":["invoice_create","payment_create"]}'::jsonb, '{"due_days":7}'::jsonb, TRUE, 1)
ON CONFLICT (kind) DO UPDATE SET
  match=EXCLUDED.match, check_params=EXCLUDED.check_params, enabled=EXCLUDED.enabled, updated_at=now();
```

- [ ] **Step 3: 语法/存在性冒烟（grep 确认语句落地）**

Run: `cd /d/system/CRM-ai-native && grep -n "crm.alert_rule" db/migrate-config.sql db/seed.sql && grep -c "INSERT INTO crm.alert_rule" db/seed.sql`
Expected: 建表 1 处 + 种子 1 处命中

- [ ] **Step 4: 提交**

```bash
git add db/migrate-config.sql db/seed.sql db/test-setup.sql
git commit -m "feat(alert-rule): crm.alert_rule 建表+5类种子"
```

---

### Task 4: routes.js 挂载 + 页路由 + portal 模块 + 启动 hydrate

**Files:**
- Modify: `src/http/routes.js`

- [ ] **Step 1: import 新增 Router（第 33 行附近）**

```js
import { createAlertRuleConfigRouter, hydrateAlertRules } from '../portal/alertRuleConfig.js';
```
> 加在 `import { createApprovalFlowRouter } from '../portal/approvalFlow.js';` 之后。

- [ ] **Step 2: 挂载 Router（第 64 行附近，紧跟 createApprovalFlowRouter 挂载）**

```js
  app.use(createAlertRuleConfigRouter({}));
```

- [ ] **Step 3: 启动水合（第 74 行 ensureTimers 旁）**

```js
  ensureTimers({}).catch(() => {});
  hydrateAlertRules().catch(() => {}); // 启动从 crm.alert_rule 回填缓存
```

- [ ] **Step 4: 页路由 + portal 模块挂载（第 806 行 /portal/approvalFlow.js 挂载之后）**

```js
  // 预警规则配置（第 21 项）
  app.get('/alert-rules.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/alert-rules.html', import.meta.url))));
  app.get('/alert-rules', (req, res) => res.redirect('/alert-rules.html'));
  app.get('/portal/alertRuleConfig.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/alertRuleConfig.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 5: 语法冒烟（routes.js 可加载，无解析错误）**

Run: `cd /d/system/CRM-ai-native && node --input-type=module -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | tail -15`
Expected: `routes OK`

- [ ] **Step 6: 提交**

```bash
git add src/http/routes.js
git commit -m "feat(alert-rule): 路由挂载+页路由+启动水合"
```

---

### Task 5: alert-rules.html 管理页

**Files:**
- Create: `src/web/alert-rules.html`

- [ ] **Step 1: 创建页面（拉取→渲染→编辑→保存，纯前端无轮询）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>预警规则配置</title>
  <style>
    body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 24px; background: #f7f8fa; color: #1f2329; }
    h1 { font-size: 20px; }
    .note { background: #fff7e6; border: 1px solid #ffd591; padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 8px 0 16px; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #e5e6eb; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f2f3f5; }
    .cp-row { display: block; margin: 2px 0; }
    .cp-key { display: inline-block; min-width: 90px; color: #4e5969; }
    .toolbar { margin: 12px 0; }
    button { padding: 6px 14px; border: none; border-radius: 6px; background: #165dff; color: #fff; cursor: pointer; }
    button:hover { background: #2563eb; }
    .summary { color: #86909c; font-size: 13px; }
  </style>
</head>
<body>
  <h1>预警规则配置</h1>
  <div class="note">⚠️ 配置管理 <code>crm.alert_rule</code> 持久源；引擎实时读内存缓存（改即生效）。与运营态告警处置（ack/close）端点分离。</div>
  <div id="app">加载中…</div>
  <div class="toolbar"><button id="save">保存全部</button> <span class="summary" id="summary"></span></div>

  <script type="module">
    import { renderAlertRules, alertRuleSummary } from '/portal/alertRuleConfig.js';

    let RULES = [];
    const app = document.getElementById('app');

    async function load() {
      const r = await fetch('/api/alert-rules');
      const data = await r.json();
      RULES = data.rules || [];
      app.innerHTML = renderAlertRules(RULES);
      document.getElementById('summary').textContent =
        `共 ${alertRuleSummary(RULES).count} 条 / 启用 ${alertRuleSummary(RULES).enabled} 条`;
    }

    function collect() {
      const rows = [...app.querySelectorAll('.rule-row')];
      return rows.map((row) => {
        const kind = row.dataset.kind;
        const enabled = !!row.querySelector('.r-enabled')?.checked;
        const severity = row.querySelector('.r-severity')?.value || null;
        const target_role = row.querySelector('.r-target_role')?.value || null;
        const cp = {};
        row.querySelectorAll('.cp-val').forEach((el) => { cp[el.dataset.key] = Number(el.value); });
        return { kind, enabled, severity, target_role, check_params: cp };
      });
    }

    document.getElementById('save').addEventListener('click', async () => {
      const payload = collect();
      let okCount = 0;
      for (const p of payload) {
        const res = await fetch(`/api/alert-rules/${p.kind}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: p.enabled, severity: p.severity, target_role: p.target_role, check_params: p.check_params }),
        });
        if (res.ok) okCount++;
      }
      alert(`已保存 ${okCount}/${payload.length} 条（写经决策第0闸）`);
      load();
    });

    load();
  </script>
</body>
</html>
```

- [ ] **Step 2: 提交**

```bash
git add src/web/alert-rules.html
git commit -m "feat(alert-rule): 管理页"
```

---

### Task 6: 配置中心第 21 项翻 ready

**Files:**
- Modify: `src/portal/configCenter.js`（第 19 行）
- Test: `test/web/configCenter.test.js` （如该项有 pending 断言需同步）

- [ ] **Step 1: 翻第 21 项**

```js
  { id: 21, name: '预警规则配置', group: '运营', status: 'ready', page: '/alert-rules.html', endpoint: '/api/alert-rules', note: '5 类规则启停+阈值编辑，写经决策第0闸，DB 持久化' },
```
> 替换原 `{ id: 21, name: '预警规则配置', group: '运营', status: 'pending', page: null, endpoint: null, note: '后端 alertRegistry 有，无配置页' },`

- [ ] **Step 2: 运行配置中心测试确认无回归**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/configCenter.test.js 2>&1 | tail -15`
Expected: PASS（8/8，无第 21 项 pending 断言需改动）

- [ ] **Step 3: 提交**

```bash
git add src/portal/configCenter.js
git commit -m "feat(config-center): 第21项翻ready"
```

---

### Task 7: 全量 web 测试 + 冒烟 + 工作日志

**Files:**
- 读/写: `.workbuddy/memory/2026-08-27.md`

- [ ] **Step 1: 运行 test/web 全量（基线 55 + 11 = 66 绿）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/ 2>&1 | tail -25`
Expected: PASS（66/66）

- [ ] **Step 2: 路由加载冒烟（含 alert-rules 端点可达性语法层）**

Run: `cd /d/system/CRM-ai-native && node --input-type=module -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | tail -5`
Expected: `routes OK`

- [ ] **Step 3: 既有 test/alert.test.js 不受影响（同步契约不变）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/alert.test.js 2>&1 | tail -10`
Expected: PASS（T1/T4 强制的同步契约未被破坏；若 DB 不可用导致部分用例跳过属已知）

- [ ] **Step 4: 追加工作日志**

```markdown
## item 21 预警规则配置页（2026-08-27 晚，内联执行 TDD）
- 交付：src/portal/alertRuleConfig.js（render+createAlertRuleConfigRouter+hydrateAlertRules）+ src/web/alert-rules.html + src/http/routes.js 挂载 + src/portal/configCenter.js 第21项 ready + db/migrate-config.sql 建表 + db/seed.sql/test-setup.sql 5类种子 + src/alerts/alertRegistry.js 新增 updateAlertRule（同步缓存）。
- 验证：test/web/alertRuleConfig.test.js 11/11；test/web 全量 66/66（基线55+11）；routes 加载 OK；test/alert.test.js 同步契约未破。
- 范式：复用 RBAC/business-tier/approval-flow 同构；写经决策第0闸、绝对禁删；DB 为持久源、内存缓存为实时热路径、启动 hydrate 回填（未建表回退 DEFAULT_RULES）。
- 已知限制：与运营态告警处置端点（/api/alerts ack/close）分离，本文仅配置；首次部署须跑 migrate+seed 建表。
- 待提交：按 Task 1–6 六笔 commit（沙箱无凭证）。
```
> 追加到 `.workbuddy/memory/2026-08-27.md` 末尾。

---

## 验收口径

- `test/web/alertRuleConfig.test.js` **11/11 绿**；`test/web/` 全量 **66/66**（基线 55 + 11）
- `/alert-rules` 可列 / 编 / 存 5 类规则；写经决策第0闸；**无 DELETE**
- `configCenter` 第 21 项 `ready`、可跳转
- 启动经 `hydrateAlertRules()` 从 `crm.alert_rule` 回填缓存；未建表回退 `DEFAULT_RULES`（评估照常）
- 既有 `test/alert.test.js` 同步契约（T1/T4）未被破坏

## 已知限制（写入 spec §8，已交底）

- 内存缓存为实时热路径，DB 为持久源；首次部署须先跑 `db/migrate-config.sql` + `db/seed.sql` 建表+种子，否则配置改动不落库（缓存回退 DEFAULT_RULES）。
- 运营态告警处置端点（`/api/alerts` ack/close/evaluate）仍由 `alertEndpoints.js` 提供，本次**不挂载**（item 21 仅配置页）。
- `severity`/`target_role` 留 NULL 时引擎在 `alertHook.js` 默认 `medium`/`ops`。
