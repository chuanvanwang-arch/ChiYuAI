# 客户 360 深度洞察页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 account-360 摘要页基础上，新增「客户洞察页」(`/account-insight.html` + `GET /api/page/account-insight`)，按客户维度聚合时间线 / 任务线 / 完整交易链(L2C) / 决策链，并按六角色做数据范围 + 字段级双重权限分离，同时在摘要页增加「查看深度洞察」入口。

**Architecture:** 复用现有受控渲染三件套——`S0x.schema.js`（受控 Schema）→ `renderPage(schema, data)`（唯一渲染出口）→ `account-360.html`/`account-insight.html`（壳 + fetch）。新增聚合服务 `src/account/insightService.js` 负责按角色加载粒子、聚合四视图、执行字段级权限剔除；后端在 `routes.js` 新增 `/api/page/account-insight`，并精简 `/api/page/account-360`。

**Tech Stack:** Node 22 ESM + Express 4；PostgreSQL（`crm.particles`/`crm.events`/`crm.tasks`/`crm.decision`/`crm.memory_log`）；`src/page/renderer.js` 受控渲染器；`src/context/scope.js` + `src/context/roleProfiles.js` 权限；vitest（单元）+ app.fetch 适配器（集成）。

---

## §0 关键约束（来自代码核实，务必遵守）

1. **校验器铁律**（`src/page/validator.js`）：除 `attr-field` 外的所有组件（table/subtable/metric-card/select/reasoning-trace/result-card/goal-form）**必须**声明 `dataBinding: { source: 'particle', particleType: <合法枚举>, filters: [], metrics: [] }`，否则 `validatePageSchema` 返回非法、`renderPage` 输出空。所有 plan 内 schema 均已补齐。
2. **合法枚举**：
   - `PAGE_TYPES` 含 `detail`/`workspace`；本计划用 `workspace`。
   - `COMPONENT_KINDS` 含 `metric-card/table/goal-form/result-card/reasoning-trace/subtable/select/attr-field`；**无 tab 组件**。
   - `CANONICAL_NAV` 不含 `/accounts/:id/insight` → **必须**在 `src/page/schema.js` 的 `CANONICAL_NAV` 数组追加该值，否则洞察页 schema 校验失败。
   - `ATTR_FIELD_TYPES` 含 `text/number/currency/date/timestamp/select/rating` 等；敏感字段用 `currency`/`text`。
   - `ACTION_WHITELIST` 不含 `navigate-insight` → **不使用 goal-form 跳转按钮**；「查看深度洞察」用 HTML 壳里的 `<a>`/`<button>` + JS `location.href` 实现。
3. **4 Tab 落地方式修正**：渲染器无原生 Tab 容器，table/subtable 输出不带标题包裹。故将设计的「4 Tab」落地为**4 个带标题分隔的区块**（时间线 / 任务线 / 交易链 / 决策链），每区块前用一个 `result-card`（仅作标题）承接，前端无需折叠 JS 即可清晰分章。若需真 Tab 条需新增 renderer 组件（超出设计「不新增组件」约束，后置）。
4. **schema 为模块级常量、不可变**：`applyFieldPerms` 在执行前 `structuredClone(schema)` 再按角色剔除字段，避免污染其它请求。
5. **seed.js TRUNCATE CASCADE 隐性核弹**：测试一律走**纯函数**（无 DB），避免触发 setup 清空。集成测试仅作可选附录。

---

## 文件结构（创建 / 修改清单）

| 动作 | 文件 | 职责 |
|---|---|---|
| Create | `src/account/insightService.js` | 聚合四视图 + 权限剔除的纯/薄函数集合 |
| Create | `src/pages/S35.schema.js` | 客户洞察页受控 Schema（workspace + 11 组件） |
| Modify | `src/page/schema.js` | `CANONICAL_NAV` 追加 `/accounts/:id/insight` |
| Modify | `src/http/routes.js` | 新增 `/api/page/account-insight` + import S35 + 新增 HTML 路由；精简 `/api/page/account-360` |
| Modify | `src/pages/S06.schema.js` | 摘要页：移除关联 subtable，新增「最新动态」table + AI 建议 result-card（均带 dataBinding） |
| Create | `src/web/account-insight.html` | 洞察页壳：解析 accountId、fetch API、注入角色提示、注入「返回摘要」 |
| Modify | `src/web/account-360.html` | 增加「查看深度洞察」按钮（链接到 insight 页） |
| Create | `test/account-insight.test.js` | 纯函数单元测试（scope/字段级/时间线/交易链/权限剔除） |

---

## Task A：聚合服务 `src/account/insightService.js`（纯函数 + 薄 DB 封装）

**Files:**
- Create: `src/account/insightService.js`
- Test: `test/account-insight.test.js`（本 Task 仅写 scope/字段级纯函数测试）

- [ ] **Step 1: 写失败测试（字段级权限剔除 + scope 过滤）**

`test/account-insight.test.js`：
```js
import { describe, it, expect } from 'vitest';
import {
  applyScopeFilter, applyFieldPerms, buildTimelineRows, buildTransactionRows,
} from '../src/account/insightService.js';

const SALES = { data_scope: { model: 'self' } };
const FINANCE = { data_scope: { model: 'domain', domain: ['payment', 'contract', 'invoice'] } };

describe('applyScopeFilter', () => {
  it('self 模型仅保留 owner_id === actor 的粒子', () => {
    const ps = [
      { type: 'CRM_DEAL', payload: { owner_id: 'u1' } },
      { type: 'CRM_DEAL', payload: { owner_id: 'u2' } },
    ];
    const r = applyScopeFilter(ps, SALES, 'u1');
    expect(r).toHaveLength(1);
    expect(r[0].payload.owner_id).toBe('u1');
  });
  it('domain 模型仅保留 domain 内类型', () => {
    const ps = [
      { type: 'CRM_DEAL' }, { type: 'CRM_PAYMENT_RECORD' }, { type: 'CRM_CONTRACT' },
    ];
    const r = applyScopeFilter(ps, FINANCE, 'u9');
    expect(r.map(x => x.type).sort()).toEqual(['CRM_CONTRACT', 'CRM_PAYMENT_RECORD']);
  });
  it('all 模型全保留', () => {
    const ps = [{ type: 'CRM_DEAL' }, { type: 'CRM_ACCOUNT' }];
    expect(applyScopeFilter(ps, { data_scope: { model: 'all' } }, 'x')).toHaveLength(2);
  });
});

describe('applyFieldPerms', () => {
  it('sales 隐藏回款金额列、finance 可见', () => {
    const schema = {
      type: 'workspace', title: 't', navigation: { to: '/accounts/:id/insight' },
      layout: { columns: 1, theme: 'light' },
      components: [
        { kind: 'subtable', title: '交易链', mainColumn: 'stage', subColumns: ['doc', 'amount', 'status'],
          subRows: 'items', permColumns: { sales: ['amount'], finance: [] },
          dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
        { kind: 'attr-field', attrSlug: 'biz', attrType: 'text', label: '工商信息', perm: 'biz_info',
          attr: { data_origin: 'external' } },
      ],
    };
    const sHidden = applyFieldPerms(structuredClone(schema), 'sales');
    const sub = sHidden.components.find(c => c.kind === 'subtable');
    expect(sub.subColumns).toEqual(['doc', 'status']);
    const af = sHidden.components.find(c => c.kind === 'attr-field');
    expect(af.hidden).toBe(true);

    const fVisible = applyFieldPerms(structuredClone(schema), 'finance');
    const subF = fVisible.components.find(c => c.kind === 'subtable');
    expect(subF.subColumns).toEqual(['doc', 'amount', 'status']);
    const afF = fVisible.components.find(c => c.kind === 'attr-field');
    expect(afF.hidden).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: FAIL（`Cannot find module '../src/account/insightService.js'`）

- [ ] **Step 3: 实现 insightService.js（纯函数 + 薄封装）**

`src/account/insightService.js`：
```js
// src/account/insightService.js — 客户洞察聚合 + 权限剔除（受控渲染数据面）
// 纯函数为主（可单测、无 DB）；薄封装 queryParticles 仅用于 handler 组装。
import { query } from '../db.js';
import { loadProfile } from '../context/roleProfiles.js';

// —— 字段级权限矩阵（设计 §4.2）——
export const FIELD_PERMS = {
  payment_amount: { sales: 'hidden', manager: 'readonly', exec: 'visible', finance: 'visible', presales: 'hidden', contract_admin: 'readonly' },
  cost:           { sales: 'hidden', manager: 'hidden',  exec: 'visible', finance: 'readonly', presales: 'hidden', contract_admin: 'hidden' },
  contract_amount:{ sales: 'readonly', manager: 'visible', exec: 'visible', finance: 'visible', presales: 'readonly', contract_admin: 'visible' },
  biz_info:       { sales: 'readonly', manager: 'visible', exec: 'visible', finance: 'visible', presales: 'readonly', contract_admin: 'visible' },
};

// 纯函数：按 data_scope 过滤关联粒子（self/domain 可纯推断；org_subtree/all 透传）
export function applyScopeFilter(particles, profile, actor) {
  const m = profile?.data_scope?.model || 'all';
  if (m === 'all') return particles;
  if (m === 'self') return particles.filter(p => p?.payload?.owner_id === actor);
  if (m === 'domain') {
    const dom = profile.data_scope.domain || [];
    return particles.filter(p => dom.includes(p.type));
  }
  return particles; // org_subtree 需 DB 解析，handler 内单独处理
}

// 纯函数：克隆 schema 后按角色剔除隐藏字段 / 隐藏列
export function applyFieldPerms(schema, role) {
  const s = structuredClone(schema);
  for (const comp of s.components) {
    if (comp.kind === 'attr-field' && comp.perm && FIELD_PERMS[comp.perm]) {
      const vis = FIELD_PERMS[comp.perm][role] || 'visible';
      if (vis === 'hidden') comp.hidden = true;
      else if (vis === 'readonly') comp.readonly = true;
    }
    if ((comp.kind === 'subtable' || comp.kind === 'table') && comp.permColumns) {
      const hide = comp.permColumns[role] || [];
      if (hide.length && comp.subColumns) comp.subColumns = comp.subColumns.filter(c => !hide.includes(c));
      if (hide.length && comp.dataBinding?.columns) comp.dataBinding.columns = comp.dataBinding.columns.filter(c => !hide.includes(c));
    }
  }
  return s;
}

// 纯函数：多源事件 → 统一时间线条目，按 ts 倒序 + 同秒同实体去重
export function buildTimelineRows(sources) {
  const seen = new Set();
  const rows = [];
  for (const ev of sources) {
    const key = `${ev.ts}|${ev.type}|${ev.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ts: ev.ts, type: ev.type, title: ev.title, source: ev.source, actor: ev.actor, entity: ev.entityType, summary: ev.summary });
  }
  return rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

// 纯函数：L2C 关联粒子 → 交易链行 + 汇总（金额/回款率）
export function buildTransactionRows(related) {
  const stages = [
    { stage: '商机', items: related.deals || [] },
    { stage: '报价', items: related.quotations || [] },
    { stage: '合同', items: related.contracts || [] },
    { stage: '订单', items: related.orders || [] },
    { stage: '回款', items: related.payments || [] },
    { stage: '发票', items: related.invoices || [] },
  ];
  const amountOf = (it) => Number(it?.payload?.amount || it?.payload?.expected_amount || it?.payload?.paid_amount || 0);
  const rows = stages.map(s => ({
    stage: s.stage,
    doc: s.items.length,
    amount: s.items.reduce((sum, it) => sum + amountOf(it), 0),
    status: s.items.length ? '有' : '无',
  }));
  const contractAmt = rows.find(r => r.stage === '合同')?.amount || 0;
  const paidAmt = rows.find(r => r.stage === '回款')?.amount || 0;
  const rate = contractAmt > 0 ? Math.round((paidAmt / contractAmt) * 100) : 0;
  return { rows, totals: { contractAmt, paidAmt, rate } };
}

// —— 薄封装：handler 用，按 accountId 并行拉取关联粒子（scope 由调用方先过滤）——
export async function loadRelatedParticles(accountId, dealIds = []) {
  const types = ['CRM_CONTACT', 'CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_ORDER', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE', 'CRM_TECHNICAL_PROPOSAL'];
  const byType = {};
  for (const t of types) {
    const rows = await query(
      `SELECT id, type, slug, title, payload, state FROM crm.particles
       WHERE type=$1 AND tenant_id='system'
         AND (payload->>'account_id'=$2 OR payload->>'deal_id' = ANY($3::text[]))`,
      [t, accountId, dealIds]
    );
    byType[t] = rows.rows;
  }
  return byType;
}

// 薄封装：时间线多源抽取（events / tasks / decision / memory_log）
export async function loadTimelineSources(accountId, dealIds = []) {
  const ev = await query(
    `SELECT 'event' AS type, payload->>'title' AS title, actor, created_at,
            payload->>'source' AS source, payload->>'entity_type' AS entity_type,
            id::text AS entity_id
     FROM crm.events
     WHERE payload->>'account_id'=$1 OR payload->>'deal_id'=ANY($2::text[])
     ORDER BY created_at DESC LIMIT 100`,
    [accountId, dealIds]
  );
  const tk = await query(
    `SELECT 'task' AS type, title, 'system' AS actor, created_at,
            'AI' AS source, action_name AS entity_type, id::text AS entity_id
     FROM crm.tasks WHERE payload->>'account_id'=$1 ORDER BY created_at DESC LIMIT 100`,
    [accountId]
  );
  const dc = await query(
    `SELECT 'decision' AS type, scenario_id AS title, decider_role AS actor, created_at,
            '决策' AS source, 'DECISION' AS entity_type, decision_id::text AS entity_id
     FROM crm.decision WHERE involved_entities @> $1::jsonb ORDER BY created_at DESC LIMIT 100`,
    [JSON.stringify({ account_id: accountId })]
  );
  const ml = await query(
    `SELECT 'memory' AS type, payload->>'title' AS title, 'system' AS actor, created_at,
            '记忆' AS source, kind AS entity_type, id::text AS entity_id
     FROM crm.memory_log WHERE topic=$1 ORDER BY created_at DESC LIMIT 100`,
    [`account:${accountId}`]
  );
  const norm = (r) => ({
    ts: r.created_at?.toISOString?.() || String(r.created_at),
    type: r.type, title: r.title || '', source: r.source || '', actor: r.actor || '',
    entityType: r.entity_type || '', entityId: r.entity_id || '', summary: '',
  });
  return [...ev.rows, ...tk.rows, ...dc.rows, ...ml.rows].map(norm);
}

export async function loadDecisions(accountId) {
  const r = await query(
    `SELECT d.decision_id::text AS id, d.scenario_id, d.disposition, d.state, d.rationale,
            COALESCE(d.referenced_precedents::text, '[]') AS precedents
     FROM crm.decision d WHERE d.involved_entities @> $1::jsonb ORDER BY d.created_at DESC LIMIT 50`,
    [JSON.stringify({ account_id: accountId })]
  );
  return r.rows.map(d => ({
    decision: d.scenario_id,
    scenario: d.disposition,
    state: d.state,
    precedent: (JSON.parse(d.precedents || '[]')[0] || '无'),
  }));
}

// 依据角色解析 actor（username → CRM_PERSON slug）；缺失则回退 null（self/org 透传）
export async function resolveActor(username) {
  if (!username) return null;
  const r = await query(`SELECT slug FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'username'=$1 LIMIT 1`, [username]);
  return r.rows[0]?.slug || null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: PASS（scope 3 例 + 字段级 1 例）

- [ ] **Step 5: Commit**

```bash
git add src/account/insightService.js test/account-insight.test.js
git commit -m "feat(account-insight): 聚合服务与权限剔除纯函数 + 单测"
```

---

## Task B：摘要页精简 + 「查看深度洞察」入口

**Files:**
- Modify: `src/pages/S06.schema.js`
- Modify: `src/http/routes.js`（`/api/page/account-360` handler，约 528–581 行）
- Modify: `src/web/account-360.html`
- Test: `test/account-insight.test.js`（追加：buildTimelineRows/buildTransactionRows 纯函数测试）

- [ ] **Step 1: 写失败测试（时间线排序去重 + 交易链汇总）**

在 `test/account-insight.test.js` 末尾追加：
```js
describe('buildTimelineRows', () => {
  it('按 ts 倒序且同秒同实体去重', () => {
    const src = [
      { ts: '2026-08-28T10:00:00Z', type: 'event', title: 'A', entityId: '1', entityType: 'D', source: 'x', actor: 's', summary: '' },
      { ts: '2026-08-28T09:00:00Z', type: 'event', title: 'B', entityId: '2', entityType: 'D', source: 'x', actor: 's', summary: '' },
      { ts: '2026-08-28T10:00:00Z', type: 'event', title: 'A', entityId: '1', entityType: 'D', source: 'x', actor: 's', summary: '' },
    ];
    const r = buildTimelineRows(src);
    expect(r).toHaveLength(2);
    expect(r[0].title).toBe('A');
  });
});

describe('buildTransactionRows', () => {
  it('计算各阶段金额与回款率', () => {
    const related = {
      deals: [{ payload: { expected_amount: 100 } }],
      contracts: [{ payload: { amount: 200 } }],
      payments: [{ payload: { paid_amount: 50 } }],
    };
    const { rows, totals } = buildTransactionRows(related);
    expect(rows.find(r => r.stage === '合同').amount).toBe(200);
    expect(totals.rate).toBe(25);
  });
});
```

- [ ] **Step 2: 运行确认失败（函数已存在，应已通过；若新增则先 FAIL）**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: 追加用例 PASS（buildTimelineRows/buildTransactionRows 已在 Task A 实现）

- [ ] **Step 3: 修改 S06 schema（移除关联 subtable，新增动态 table + AI 建议 result-card）**

`src/pages/S06.schema.js` 将 `subtable`（关联商机/联系人）组件替换为：
```js
    // 最新动态（设计 §1：摘要页展示最近事件 3 条，替代原关联 subtable）
    {
      kind: 'table',
      title: '最新动态',
      dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] },
      columns: ['ts', 'type', 'title'],
    },
    // AI 建议（设计 §1：下一步建议）
    {
      kind: 'result-card',
      title: 'AI 下一步建议',
      dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] },
    },
```
其余 attr-field×3 + metric-card×7 + reasoning-trace 保持不变（它们已带 dataBinding）。

- [ ] **Step 4: 修改 `/api/page/account-360` handler（注入最新事件 + AI 建议，移除 subtable 数据）**

在 `src/http/routes.js` 的 account-360 handler 中（约 540–575 行），将 `deals` 过滤后追加：
```js
      const dealIds = deals.map(d => d.id);
      const evRows = await query(
        `SELECT payload->>'title' AS title, payload->>'type' AS type, created_at
         FROM crm.events WHERE payload->>'account_id'=$1 OR payload->>'deal_id'=ANY($2::text[])
         ORDER BY created_at DESC LIMIT 3`,
        [account.id, dealIds]
      ).then(r => r.rows.map(e => ({
        ts: e.created_at?.toISOString?.() || String(e.created_at),
        type: e.type || 'event',
        title: e.title || '事件',
      })));
      const aiSuggestion = (deals.length === 0 && contacts.length === 0)
        ? '该客户暂无任何商机与联系人，建议优先补全画像并指派 owner。'
        : `当前 ${dealCount} 个商机、${contactCount} 个联系人；最近事件 ${evRows[0]?.title || '无'}。`;
```
将 `data.components.subtable` 改为：
```js
          table: { rows: evRows },
          'result-card': { summary: aiSuggestion },
```
（`'result-card'` 索引键 = comp.title = 'AI 下一步建议'`；渲染器按 title 索引。）

- [ ] **Step 5: account-360.html 增加「查看深度洞察」入口**

在 `src/web/account-360.html` 的 `<div id="app">` 内、`#account-root` 之后追加：
```html
  <div id="insight-entry" style="padding:8px 16px">
    <a id="insight-link" class="pg-btn" href="#">查看深度洞察 →</a>
  </div>
```
并在 `<script>` 的 `(async () => { ... })()` 内、`root.innerHTML = j.html;` 之后追加：
```js
        const link = document.getElementById('insight-link');
        if (link && accountId) link.href = '/account-insight.html?id=' + encodeURIComponent(accountId);
```

- [ ] **Step 6: 运行全部相关测试**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/pages/S06.schema.js src/http/routes.js src/web/account-360.html test/account-insight.test.js
git commit -m "feat(account-360): 摘要页精简为最新动态+AI建议，增加洞察入口"
```

---

## Task C：洞察页 Schema `S35` + 新增 API 端点

**Files:**
- Create: `src/pages/S35.schema.js`
- Modify: `src/page/schema.js`（CANONICAL_NAV 追加）
- Modify: `src/http/routes.js`（import S35 + 新增 `/api/page/account-insight` handler）

- [ ] **Step 1: 写失败测试（schema 校验通过 + 字段剔除在洞察 schema 也成立）**

在 `test/account-insight.test.js` 追加：
```js
import { schema as S35 } from '../src/pages/S35.schema.js';
import { validatePageSchema } from '../src/page/validator.js';

describe('S35 schema', () => {
  it('通过结构校验', () => {
    expect(validatePageSchema(S35).ok).toBe(true);
  });
  it('sales 下回款金额列被剔除', () => {
    const s = applyFieldPerms(structuredClone(S35), 'sales');
    const sub = s.components.find(c => c.kind === 'subtable' && c.title === '完整交易链（L2C）');
    expect(sub.subColumns).not.toContain('amount');
  });
});
```

- [ ] **Step 2: 运行确认失败（S35 尚未创建）**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: FAIL（`Cannot find module '../src/pages/S35.schema.js'`）

- [ ] **Step 3: 修改 `src/page/schema.js` 追加导航枚举**

在 `CANONICAL_NAV` 数组（约 54 行附近）的 `'/accounts/:id'` 后追加：
```js
  '/accounts/:id/insight',
```

- [ ] **Step 4: 创建 `src/pages/S35.schema.js`**

```js
// src/pages/S35.schema.js — 客户洞察页（workspace，4 区块 + AI 洞察）
// 设计输入：docs/2026-08-28-customer-360-insight-design.md §2.1 / §6.2
// 组件：result-card×4(章节标题) + table(时间线) + subtable(任务线) + subtable(交易链)
//       + metric-card×2(交易总额/回款率) + subtable(决策链) + reasoning-trace(AI 洞察)
// 注意：renderer 无原生 tab，4 Tab 落地为 4 个带 result-card 标题的区块。
import { validatePageSchema } from '../page/validator.js';

const ACC = { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] };

export const schema = {
  type: 'workspace',
  title: '客户洞察',
  navigation: { to: '/accounts/:id/insight' },
  layout: { columns: 1, theme: 'light' },
  components: [
    { kind: 'result-card', title: '客户时间线', dataBinding: ACC },
    {
      kind: 'table', title: '时间线',
      dataBinding: { ...ACC, columns: ['ts', 'type', 'title', 'source', 'actor'] },
      columns: ['ts', 'type', 'title', 'source', 'actor'],
    },
    { kind: 'result-card', title: '客户任务线', dataBinding: ACC },
    {
      kind: 'subtable', title: '任务线', mainColumn: 'task', subColumns: ['status', 'due', 'actor'], subRows: 'details',
      dataBinding: ACC,
    },
    { kind: 'result-card', title: '完整交易链（L2C）', dataBinding: ACC },
    {
      kind: 'subtable', title: '完整交易链（L2C）', mainColumn: 'stage', subColumns: ['doc', 'amount', 'status'], subRows: 'items',
      // 字段级：sales 隐藏回款金额列；finance 可见
      permColumns: { sales: ['amount'], manager: [], exec: [], finance: [], presales: ['amount'], contract_admin: [] },
      dataBinding: ACC,
    },
    { kind: 'metric-card', title: '交易总金额', dataBinding: ACC },
    { kind: 'metric-card', title: '回款率', dataBinding: ACC },
    { kind: 'result-card', title: '决策链与先例', dataBinding: ACC },
    {
      kind: 'subtable', title: '决策链', mainColumn: 'decision', subColumns: ['scenario', 'state', 'precedent'], subRows: 'links',
      dataBinding: ACC,
    },
    { kind: 'attr-field', attrSlug: 'biz', attrType: 'text', label: '客户工商信息', perm: 'biz_info',
      attr: { data_origin: 'external', sourcedFrom: { source: '工商', relation_confidence: 0.92 } } },
    {
      kind: 'reasoning-trace', title: 'AI 洞察',
      steps: [
        { status: 'ok', label: '聚合四源数据' },
        { status: 'ok', label: '权限裁剪' },
        { status: 'ok', label: '生成下一步建议' },
      ],
      dataBinding: ACC,
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S35 schema 非法: ' + v.errors[0]);
```

- [ ] **Step 5: 在 `routes.js` import S35 并新增端点**

在 routes.js 顶部 import 区（约 70 行后）追加：
```js
import { schema as S35_SCHEMA } from '../pages/S35.schema.js';
import { applyScopeFilter, applyFieldPerms, buildTimelineRows, buildTransactionRows, loadRelatedParticles, loadTimelineSources, loadDecisions, resolveActor } from '../account/insightService.js';
```

在 `/api/page/account-360` 路由**之后**新增：
```js
  // ─── S35 客户洞察受控渲染（双页分离第二页）───
  // 契约：GET /api/page/account-insight?accountId=&tab=  → { schema:S35, data, html, role, warnings }
  app.get('/api/page/account-insight', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me.ok) return res.status(401).json({ error: me.error });
      const role = me.role || 'sales';
      const profile = await loadProfile(role);
      const accountId = req.query.accountId || null;
      const accounts = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'system', limit: 100 });
      const account = (accountId && accounts.find(a => a.id === accountId)) || accounts[0] || null;
      if (!account) {
        const rendered = renderPage(S35_SCHEMA, { state: 'empty' });
        return res.json({ schema: S35_SCHEMA, data: { state: 'empty' }, html: rendered.html, warnings: rendered.warnings, role });
      }
      const actor = await resolveActor(me.username);
      // 越权（self 模型且 owner 不匹配）→ 403
      if (profile?.data_scope?.model === 'self' && actor && account.payload?.owner_id && account.payload.owner_id !== actor) {
        return res.status(403).json({ error: 'scope_violation', gate: 'scope', reason: `owner ${account.payload.owner_id} != ${actor}` });
      }
      const dealIds = (await queryParticles({ type: 'CRM_DEAL', tenantId: 'system', limit: 200 }))
        .filter(d => (d.payload?.account_id || '') === account.id).map(d => d.id);
      const related = await loadRelatedParticles(account.id, dealIds);
      // 数据范围过滤（domain / self）
      const flat = Object.values(related).flat();
      const scoped = applyScopeFilter(flat, profile, actor);
      const scopedById = new Map();
      for (const p of scoped) scopedById.set(p.id, p);
      const pick = (t) => (related[t] || []).filter(p => scopedById.has(p.id));

      const timelineSources = await loadTimelineSources(account.id, dealIds);
      const timeline = buildTimelineRows(timelineSources);
      const tx = buildTransactionRows({
        deals: pick('CRM_DEAL'), quotations: pick('CRM_QUOTATION'), contracts: pick('CRM_CONTRACT'),
        orders: pick('CRM_ORDER'), payments: pick('CRM_PAYMENT_RECORD'), invoices: pick('CRM_INVOICE'),
      });
      const decisions = await loadDecisions(account.id);
      const tasks = (await query(
        `SELECT title, payload->>'status' AS status, payload->>'due' AS due, payload->>'actor' AS actor
         FROM crm.tasks WHERE payload->>'account_id'=$1 ORDER BY created_at DESC LIMIT 50`, [account.id]
      )).rows.map(t => ({ task: t.title, status: t.status || 'ready', due: t.due || '', actor: t.actor || 'system', details: [] }));

      const data = {
        // resolveDatum 按 comp.title 索引；下列键须与 S35 各组件 title 一致
        components: {
          '时间线': { rows: timeline },
          '任务线': { rows: tasks },
          '完整交易链（L2C）': { rows: tx.rows },
          '交易总金额': { value: tx.totals.contractAmt },
          '回款率': { value: tx.totals.rate + '%' },
          '决策链': { rows: decisions },
          'AI 洞察': { steps: S35_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [] },
        },
      };
      // 字段级权限：克隆 schema 后按角色剔除
      const schemaForRole = applyFieldPerms(S35_SCHEMA, role);
      const rendered = renderPage(schemaForRole, data);
      res.json({ schema: schemaForRole, data, html: rendered.html, warnings: rendered.warnings, role, accountId: account.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

> 注意：`data.components['subtable']` 与 `'完整交易链（L2C）'` 用 title 索引（渲染器 resolveDatum 规则）；两个 subtable 分别用 title 区分。

- [ ] **Step 6: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: PASS（含 S35 校验 + 字段剔除）

- [ ] **Step 7: Commit**

```bash
git add src/pages/S35.schema.js src/page/schema.js src/http/routes.js test/account-insight.test.js
git commit -m "feat(account-insight): S35 schema + /api/page/account-insight 端点"
```

---

## Task D：洞察页 HTML 壳 `account-insight.html`

**Files:**
- Create: `src/web/account-insight.html`
- Test: 无（壳层，随集成验证）

- [ ] **Step 1: 创建 `src/web/account-insight.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>客户洞察 · CRM</title>
  <link rel="stylesheet" href="/portal/tokens.css" />
  <link rel="stylesheet" href="/portal/common.css" />
  <link rel="stylesheet" href="/page.css" />
  <style>
    .pg-page { padding: 16px; }
    .pg-grid { display: grid; gap: 12px; }
    .pg-metric-card, .pg-table, .pg-subtable-wrap, .pg-result-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .pg-value { font-size: 20px; font-weight: 600; }
    #insight-root:empty::before { content: "加载中…"; color: var(--mut); }
    .pg-btn { display:inline-block; padding:6px 12px; border:1px solid var(--line); border-radius:6px; text-decoration:none; color:var(--txt); }
  </style>
</head>
<body>
  <div id="app">
    <div style="padding:8px 16px"><a class="pg-btn" href="/account-360.html" id="back-link">← 返回客户 360</a> <span id="role-hint"></span></div>
    <div id="insight-root"><div class="pg-state" data-state="loading">加载中…</div></div>
  </div>
  <script type="module">
    import { injectLayout } from '/portal/layout.js';
    injectLayout();
    (async () => {
      const root = document.getElementById('insight-root');
      if (!root) return;
      const q = new URLSearchParams(location.search);
      const fromPath = location.pathname.match(/\/accounts\/([^/]+)\/insight/);
      const accountId = q.get('id') || (fromPath ? fromPath[1] : '');
      const back = document.getElementById('back-link');
      if (back && accountId) back.href = '/account-360.html?id=' + encodeURIComponent(accountId);
      try {
        const url = '/api/page/account-insight' + (accountId ? ('?accountId=' + encodeURIComponent(accountId)) : '');
        const r = await fetch(url, { headers: { Authorization: localStorage.getItem('token') ? 'Bearer ' + localStorage.getItem('token') : '' } });
        if (!r.ok) throw new Error((await r.json()).error || ('HTTP ' + r.status));
        const j = await r.json();
        if (j.role) document.getElementById('role-hint').textContent = '当前角色：' + j.role;
        if (j.html) root.innerHTML = j.html;
      } catch (e) {
        root.innerHTML = `<div class="pg-state" data-state="error">客户洞察渲染失败：${e.message}</div>`;
      }
    })();
  </script>
</body>
</html>
```

- [ ] **Step 2: 在 `routes.js` 注册 HTML 路由**

在 account-360.html 路由（约 1453 行）附近追加：
```js
  app.get('/account-insight.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/account-insight.html', import.meta.url))));
  app.get('/account-insight', (req, res) => res.redirect('/account-insight.html'));
  app.get('/accounts/:id/insight', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/account-insight.html', import.meta.url))));
```

- [ ] **Step 3: 自检样式契约（记忆红线）**

确认 `account-insight.html` 已链 `/page.css`（renderPage 产物 pg-* 样式来源）。已链。

- [ ] **Step 4: Commit**

```bash
git add src/web/account-insight.html src/http/routes.js
git commit -m "feat(account-insight): 洞察页 HTML 壳 + 路由注册"
```

---

## Task E：集成冒烟（app.fetch 适配器，无 DB 依赖）

**Files:**
- Modify: `test/account-insight.test.js`（追加 HTTP 层冒烟，使用 crafting token）

- [ ] **Step 1: 写集成测试（200 / 403 / 字段剔除端到端）**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';

const app = createApp();
const tok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice' });
const auth = { Authorization: 'Bearer ' + tok };

describe('GET /api/page/account-insight', () => {
  it('无 accountId 返回 200 + 首户 html', async () => {
    const res = await app.fetch('/api/page/account-insight', { headers: auth });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.html).toContain('pg-page');
    expect(j.role).toBe('sales');
  });
  it('缺失 token 返回 401', async () => {
    const res = await app.fetch('/api/page/account-insight');
    expect(res.status).toBe(401);
  });
  it('sales 响应 html 不含回款金额列头', async () => {
    const res = await app.fetch('/api/page/account-insight', { headers: auth });
    const j = await res.json();
    expect(j.html).not.toContain('金额'); // 交易链 amount 列被 permColumns 剔除
  });
});
```

- [ ] **Step 2: 运行全量测试**

Run: `node node_modules/vitest/vitest.mjs run test/account-insight.test.js`
Expected: PASS（纯函数 + schema + 集成）

- [ ] **Step 3: Commit**

```bash
git add test/account-insight.test.js
git commit -m "test(account-insight): 集成冒烟 + 权限端到端"
```

---

## Task F：字段级权限在摘要页 attr-field 落地（可选增强）

**Files:**
- Modify: `src/pages/S06.schema.js`（为 sensitive attr-field 加 perm）
- Test: 已在 Task A 覆盖 `applyFieldPerms`

> 说明：摘要页当前 attr-field 为 name/industry/status（均非敏感），无需字段级隐藏。本 Task 仅当后续在摘要页加入回款/成本等敏感字段时启用。首版跳过，保持 scope 聚焦。

- [ ] **Step 1: （如需要）为 S06 添加带 perm 的 attr-field 并复用 applyFieldPerms**

（首版不执行；保留为后续扩展点。）

---

## Task G：全量回归 + 自查

**Files:** 无新增，仅运行

- [ ] **Step 1: 运行全量测试套件**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全绿（含既有 398 例 + 本计划新增用例）

- [ ] **Step 2: 启动服务人工核验（可选）**

```bash
node src/http/server.js   # 默认 3000
```
浏览器访问 `http://127.0.0.1:3000/account-360.html?id=<首户>` → 点「查看深度洞察」→ 核验 4 区块 + 角色提示 + 回款金额对 sales 隐藏。

- [ ] **Step 3: 设计自查（无占位符/无矛盾/范围闭合）**

- [ ] **Step 4: Commit（如 G 阶段有微调）**

```bash
git add -A && git commit -m "chore(account-insight): 全量回归通过"
```

---

## 自查（Spec 覆盖核对）

| 设计 § | 落地 Task |
|---|---|
| §1 双页分离 + 4 区块 | Task C(S35) / Task D(html) / §0 约束③（Tab→区块） |
| §2 信息架构 | Task C handler 聚合 |
| §3 数据源五源 | `loadRelatedParticles` / `loadTimelineSources` / `loadDecisions` |
| §4 权限双闸 | `applyScopeFilter`(Task A) + `applyFieldPerms`(Task A) + 403 越权(Task C) |
| §5 后端 API | Task C 端点 |
| §6 前端 Schema | S35(Task C) / S06 精简(Task B) |
| §7 错误处理 | empty(无 id/不存在) / 401(token) / 403(越权) / 500(catch) |
| §8 测试 | Task A/B/C/E 纯函数 + schema + 集成 |
| §9 实施拆分 A–G | 本计划 Task A–G 一一对应 |

**类型一致性：** `applyScopeFilter(particles, profile, actor)`、`applyFieldPerms(schema, role)`、`buildTimelineRows(sources)`、`buildTransactionRows(related)`、`loadRelatedParticles(accountId, dealIds)`、`loadTimelineSources(accountId, dealIds)`、`loadDecisions(accountId)`、`resolveActor(username)` —— 全计划在 Task A 定义、Task B/C/E 调用，签名一致。

**占位符扫描：** 无 TBD/TODO；所有代码块为可执行实现。Task F 显式标注「首版跳过」属设计范围内的范围裁剪，非占位。
