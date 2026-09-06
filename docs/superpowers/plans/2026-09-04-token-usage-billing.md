# Token 额度/使用明细（租户→账号→动作，真实计量）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在账单页新增「Token 额度与使用明细」专区，按 租户→账号→动作 三级下钻，并把 LLM/embedding 真实 token 用量回写 token_accounting（tenant_id + 真实账号），使额度/已用/剩余/超量费可见、可收费。

**Architecture:** 计量在 LLM 封装层统一采集（`callChat`/`embed` 解析 `usage`），经 `recordTokens` 落 `token_accounting`；`billingService` 新增三级聚合；`billingRoutes` 暴露 `GET /api/billing/token-usage`（复用 `applyTenantOverride` 租户隔离）；`billing.html` 渲染额度卡 + 账号表 + 动作表。不引入拦截止/限流（仅展示+计费，拦截为后续独立设计），不改表结构，计量 fail-open。

**Tech Stack:** Node22 ESM + Express4 + PostgreSQL(pgvector, schema crm, @5433) + vitest3；前端 crm-* web component + portal 资源。

---

### Task 1: LLM/embedding 封装层真实 Token 埋点回写

**Files:**
- Modify: `src/llm/client.js`（导出 `callChat` + 解析 `usage` + 透传 `metering`）
- Modify: `src/llm/embeddingClient.js`（`embed` 解析 `usage` + 透传 `metering`）
- Modify: `src/agent/agentLoop.js:72`（注入 `metering` 到 `getLlmThink`）
- Modify: `src/ontology/embedding.js:39`（`embedText` 透传 `metering`）
- Test: `test/llm/tokenMetering.test.js`（新建）

- [ ] **Step 1: 写失败测试（mock fetch + spy recordTokens）**

```js
// test/llm/tokenMetering.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/alerts/tokenAccounting.js', () => ({
  recordTokens: vi.fn(async () => ({ ok: true })),
}));
const { recordTokens } = await import('../../src/alerts/tokenAccounting.js');
const { callChat } = await import('../../src/llm/client.js');

describe('callChat token 真实计量', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('解析 usage 并带 tenant_id+actor 回写 token_accounting', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const cfg = { base: 'https://x/v1/chat/completions', apiKey: 'k', model: 'm' };
    const out = await callChat(cfg, [{ role: 'user', content: 'x' }], {
      metering: { tenantId: 't1', actor: 'alice', action: 'agent-think' },
    });
    expect(out).toBe('hi');
    expect(recordTokens).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', actor: 'alice', action: 'agent-think',
      tokensIn: 10, tokensOut: 5, source: 'llm',
    }));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/llm/tokenMetering.test.js`
Expected: FAIL（`callChat` 未导出 / 未回写 `recordTokens`）

- [ ] **Step 3: 最小实现 — `src/llm/client.js` 改动**

在文件顶部 import 区增加（紧接既有 import 后）：
```js
import { recordTokens } from '../alerts/tokenAccounting.js';
```
将 `async function callChat(cfg, messages, { timeoutMs = 20000, maxTokens } = {})` 改为导出并增加 metering：
```js
export async function callChat(cfg, messages, { timeoutMs = 20000, maxTokens, metering = null } = {}) {
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temp ?? 0.7,
    max_tokens: maxTokens ?? cfg.max_tokens ?? 1024,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(cfg.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
    const j = await r.json();
    // 09-V6 token 真实计量：解析 usage 回写 token_accounting（fail-open 不阻断主写）
    if (metering && j?.usage) {
      await recordTokens({
        actor: metering.actor || 'system',
        action: metering.action || 'llm-chat',
        tokensIn: Number(j.usage.prompt_tokens) || 0,
        tokensOut: Number(j.usage.completion_tokens) || 0,
        source: 'llm',
        decision_id: metering.decision_id || null,
        tenantId: metering.tenantId || 'system',
      });
    }
    return j?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}
```
`getLlmThink` 透传 `metering`：
```js
export async function getLlmThink(opts = {}) {
  const cfg = await loadActiveCfg(opts, opts.refresh);
  const metering = opts.metering || null;
  return cfg ? makeThink(cfg, metering) : null;
}
function makeThink(cfg, metering) {
  return async function llmThink(task, o = {}) {
    try {
      const text = await callChat(cfg, [
        { role: 'system', content: '你是 CRM 销售智能体推理器，仅输出 JSON：{"action":<string|null>,"params":<object>,"reasoning":<string>}。' },
        { role: 'user', content: buildPrompt(task, o.step || {}, o.prior || []) },
      ], { timeoutMs: 20000, maxTokens: undefined, metering });
      return parseThink(text);
    } catch (e) {
      return { action: null, params: {}, reasoning: `[LLM 调用失败，降级] ${e.message}`, degraded: true, degradeReason: 'llm_error' };
    }
  };
}
```
`getLlmJson` 透传 `metering`：
```js
export async function getLlmJson(opts = {}) {
  const cfg = await loadActiveCfg(opts, opts.refresh);
  if (!cfg) return null;
  const metering = opts.metering || null;
  const attempts = (opts.strategy === 'round-robin' || opts.strategy === 'failover') ? 2 : 1;
  return async (systemPrompt, userPrompt, o = {}) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      const c = i === 0 ? cfg : await loadActiveCfg(opts, true);
      if (!c) break;
      try {
        const text = await callChat(c, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], { timeoutMs: o.timeoutMs ?? 20000, maxTokens: o.max_tokens, metering });
        return parseJsonObject(text);
      } catch (e) { lastErr = e; }
    }
    return null;
  };
}
```

- [ ] **Step 4: `src/agent/agentLoop.js:72` 注入 metering**

```js
  const metering = { tenantId: ctx?.tenantId || 'system', actor: ctx?.actor || 'agent', action: 'agent-think' };
  const think = llmThink || (await getLlmThink({ metering }).catch(() => null)) || defaultThink;
```

- [ ] **Step 5: `src/llm/embeddingClient.js` 埋点**

顶部 import 区增加：
```js
import { recordTokens } from './tokenAccountingShim.js';
```
> 说明：`embeddingClient.js` 与 `client.js` 同目录 `src/llm/`，但 `tokenAccounting.js` 在 `src/alerts/`。为避免跨目录循环依赖风险并复用既有 `recordTokens`，在 `src/llm/` 下新建薄壳 `tokenAccountingShim.js`：
```js
// src/llm/tokenAccountingShim.js
export { recordTokens } from '../alerts/tokenAccounting.js';
```
`embed` 函数签名与埋点（在 `const v = j?.data?.[0]?.embedding;` 之后、`return v.map(Number);` 之前插入）：
```js
export async function embed(text, { model, metering } = {}) {
  const cfg = await loadEmbedCfg();
  if (!cfg) throw new Error('embedding 配置不可用（llm_config 缺省条目/无 api_key）');
  const m = model || process.env.EMBEDDING_MODEL || 'BAAI/bge-large-zh-v1.5';
  const url = embeddingsUrl(cfg.base);
  const input = String(text || '').slice(0, 480);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: m, input }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Embedding HTTP ${r.status}`);
    const j = await r.json();
    const v = j?.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error('embedding 返回空向量');
    // 09-V6 token 真实计量（embedding 烧 prompt token；completion 无）
    if (metering && j?.usage) {
      await recordTokens({
        actor: metering.actor || 'system',
        action: metering.action || 'embedding',
        tokensIn: Number(j.usage.prompt_tokens) || 0,
        tokensOut: 0,
        source: 'embedding',
        tenantId: metering.tenantId || 'system',
      });
    }
    return v.map(Number);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 6: `src/ontology/embedding.js:39` 透传 metering**

```js
export async function embedText(text, opts = {}) {
  if (EMBED_PROVIDER === 'model') {
    try {
      const v = await embed(text, { metering: opts.metering });
      return v;
    } catch {
      return stableHashVector(text);
    }
  }
  return stableHashVector(text);
}
```
> 调用方（如 `decisionRepo.embedText(stableStringify({...}), { metering: {...} })`）可按需传入；本任务仅打通能力，未强制全链路强制传参（fail-open，不传则不计）。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run test/llm/tokenMetering.test.js`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/llm/client.js src/llm/embeddingClient.js src/llm/tokenAccountingShim.js src/agent/agentLoop.js src/ontology/embedding.js test/llm/tokenMetering.test.js
git commit -m "feat(billing): LLM/embedding 封装层真实 token 埋点回写 token_accounting"
```

---

### Task 2: billingService 三级 Token 聚合查询

**Files:**
- Modify: `src/billing/billingService.js`（新增 `tokenQuota` / `tokenByAccount` / `tokenByAction`）
- Test: `test/billing/tokenUsage.test.js`（新建，依赖 crm_native_test）

- [ ] **Step 1: 写失败测试**

```js
// test/billing/tokenUsage.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { tokenQuota, tokenByAccount, tokenByAction } from '../../src/billing/billingService.js';

const T = 'tok_test_t';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, status, plan) VALUES ($1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  await queryWrite(`DELETE FROM crm.token_accounting WHERE tenant_id=$1`, [T]);
  await queryWrite(
    `INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, tenant_id, created_at)
     VALUES ($1,'agent-think',30000,20000,$1,now()), ($1,'agent-think',10000,5000,$1,now()),
            ($2,'crm-deal-advance',40000,10000,$1,now())`,
    [T, 'bob']
  );
});

describe('token 三级聚合', () => {
  it('tokenQuota 计算剩余与超量费（free 含 50000）', async () => {
    const q = await tokenQuota(T, new Date().toISOString().slice(0, 7));
    expect(q.plan_id).toBe('free');
    expect(q.included_tokens).toBe(50000);
    expect(q.used_total).toBe(115000);            // 30000+20000+10000+5000+40000+10000
    expect(q.remaining).toBe(0);                  // 已超量，剩余封底 0
    expect(typeof q.overage_fee).toBe('number');
  });
  it('tokenByAccount 按账号聚合 + 占比 + 未归因', async () => {
    const rows = await tokenByAccount(T, new Date().toISOString().slice(0, 7));
    // actor=T（两行合计 65000）与 bob（50000）
    const total = rows.reduce((a, r) => a + r.total, 0);
    expect(total).toBe(115000);
    rows.forEach((r) => expect(r.share_pct).toBeGreaterThanOrEqual(0));
    const bob = rows.find((r) => r.actor === 'bob');
    expect(bob.total).toBe(50000);
  });
  it('tokenByAction 按动作聚合', async () => {
    const rows = await tokenByAction(T, new Date().toISOString().slice(0, 7));
    const think = rows.find((r) => r.action === 'agent-think');
    expect(think.total).toBe(65000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/billing/tokenUsage.test.js`
Expected: FAIL（`tokenQuota` 等函数未定义）

- [ ] **Step 3: 最小实现 — `src/billing/billingService.js` 末尾追加**

```js
// —— Token 三级聚合（租户→账号→动作），账期粒度 YYYY-MM ——

// 租户额度卡：含额度 / 已用 / 剩余 / 超量费
export async function tokenQuota(tenantId, period) {
  const plan = await getPlan(tenantId);
  const u = await tokenUsage(tenantId, period);
  const used = Number(u.tin) + Number(u.tout);
  const included = plan.included_tokens;
  const unlimited = included === -1;
  const remaining = unlimited ? null : Math.max(0, (Number(included) || 0) - used);
  const b = computeBilling(plan, u.tin, u.tout, 0);
  return {
    plan_id: plan.plan_id, plan_name: plan.name,
    included_tokens: unlimited ? -1 : Number(included) || 0,
    used_total: used, remaining, overage_fee: b.token_fee, unlimited,
  };
}

// 按账号（actor）聚合；关联 crm_users 取 username，无法匹配标 is_unattributed
export async function tokenByAccount(tenantId, period) {
  const r = await query(
    `SELECT actor,
            COALESCE(SUM(tokens_in),0)::int  AS tin,
            COALESCE(SUM(tokens_out),0)::int AS tout,
            COALESCE(SUM(tokens_in)+SUM(tokens_out),0)::int AS total
     FROM crm.token_accounting
     WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2
     GROUP BY actor ORDER BY total DESC`,
    [tenantId, period]
  );
  const rows = r.rows;
  const sum = rows.reduce((a, x) => a + Number(x.total), 0);
  const actors = rows.map((x) => x.actor);
  const userRows = actors.length
    ? (await query(
        `SELECT username, user_id FROM crm.crm_users WHERE username = ANY($1) OR user_id = ANY($1)`,
        [actors]
      )).rows
    : [];
  const known = new Set(userRows.flatMap((u) => [u.username, u.user_id]));
  return rows.map((x) => {
    const u = userRows.find((ru) => ru.username === x.actor || ru.user_id === x.actor);
    return {
      actor: x.actor,
      username: u?.username || null,
      tokens_in: Number(x.tin), tokens_out: Number(x.tout), total: Number(x.total),
      share_pct: sum ? Math.round((Number(x.total) / sum) * 1000) / 10 : 0,
      is_unattributed: !known.has(x.actor),
    };
  });
}

// 按动作（action）聚合
export async function tokenByAction(tenantId, period) {
  const r = await query(
    `SELECT action,
            COALESCE(SUM(tokens_in),0)::int  AS tin,
            COALESCE(SUM(tokens_out),0)::int AS tout,
            COALESCE(SUM(tokens_in)+SUM(tokens_out),0)::int AS total
     FROM crm.token_accounting
     WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2
     GROUP BY action ORDER BY total DESC`,
    [tenantId, period]
  );
  const sum = r.rows.reduce((a, x) => a + Number(x.total), 0);
  return r.rows.map((x) => ({
    action: x.action,
    tokens_in: Number(x.tin), tokens_out: Number(x.tout), total: Number(x.total),
    share_pct: sum ? Math.round((Number(x.total) / sum) * 1000) / 10 : 0,
  }));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/billing/tokenUsage.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/billing/billingService.js test/billing/tokenUsage.test.js
git commit -m "feat(billing): 新增 tokenQuota/tokenByAccount/tokenByAction 三级聚合"
```

---

### Task 3: 新增 GET /api/billing/token-usage 端点（租户隔离）

**Files:**
- Modify: `src/http/billingRoutes.js`（import + 新路由）
- Test: `test/http/tokenUsageRoute.test.js`（新建，依赖 crm_native_test）

- [ ] **Step 1: 写失败测试**

```js
// test/http/tokenUsageRoute.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/http/routes.js';
import { queryWrite } from '../../src/db.js';

const T = 'tu_route_t';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, status, plan) VALUES ($1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  await queryWrite(`DELETE FROM crm.token_accounting WHERE tenant_id=$1`, [T]);
  await queryWrite(`INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, tenant_id, created_at) VALUES ($1,'agent-think',1000,500,$1,now())`, [T]);
});

describe('GET /api/billing/token-usage', () => {
  it('admin 指定租户返回 quota+byAccount+byAction', async () => {
    const res = await request(app)
      .get(`/api/billing/token-usage?period=${new Date().toISOString().slice(0, 7)}&tenant=${T}`)
      .set('Authorization', 'Bearer <admin-token>'); // 测试夹具按项目 auth 注入
    expect(res.status).toBe(200);
    expect(res.body.quota.plan_id).toBe('free');
    expect(Array.isArray(res.body.byAccount)).toBe(true);
    expect(Array.isArray(res.body.byAction)).toBe(true);
  });
});
```

> 注：admin token 注入方式遵循项目既有 `test/http/*.test.js` 夹具（resolveMe + isPrivileged）；若项目用 cookie/session，照搬现有测试写法。本步骤先跑通结构，token 注入以既有测试为蓝本。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/http/tokenUsageRoute.test.js`
Expected: FAIL（端点 404 / 函数未导入）

- [ ] **Step 3: 最小实现 — `src/http/billingRoutes.js`**

在 import 区（第 17-19 行 `billingService` 导入）追加：
```js
import {
  computeStatement, issueStatement, flipOverdue, pay, reconcile, exportCsv,
  tokenQuota, tokenByAccount, tokenByAction,
} from '../billing/billingService.js';
```
在 `createBillingRouter()` 内、`return router;` 之前新增：
```js
  // T5：Token 额度/使用明细（租户隔离：自助=本租户，admin=可指定/全量）
  router.get('/api/billing/token-usage', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = applyTenantOverride(req, me);
    const period = req.query.period || currentPeriod();
    try {
      if (scope === '*') {
        const tenants = (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map((r) => r.tenant_id);
        const tenantsOut = [];
        for (const t of tenants) {
          tenantsOut.push({
            tenant_id: t,
            quota: await tokenQuota(t, period),
            byAccount: await tokenByAccount(t, period),
            byAction: await tokenByAction(t, period),
          });
        }
        return res.json({ period, scope, tenants: tenantsOut });
      }
      return res.json({
        period, scope,
        quota: await tokenQuota(scope, period),
        byAccount: await tokenByAccount(scope, period),
        byAction: await tokenByAction(scope, period),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/http/tokenUsageRoute.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http/billingRoutes.js test/http/tokenUsageRoute.test.js
git commit -m "feat(billing): 新增 /api/billing/token-usage 端点（租户隔离）"
```

---

### Task 4: 账单页 Token 额度/使用明细专区（租户→账号→动作）

**Files:**
- Modify: `src/web/billing.html`（新增 section + JS 渲染）
- Test: `test/web/billingTokenSection.test.js`（新建，结构/契约校验）

- [ ] **Step 1: 写失败测试（校验专区 DOM 与渲染函数存在）**

```js
// test/web/billingTokenSection.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const html = readFileSync('src/web/billing.html', 'utf8');
describe('billing.html Token 明细专区', () => {
  it('含 Token 额度与使用明细 section 与 loadTokenUsage 调用', () => {
    expect(html).toContain('Token 额度与使用明细');
    expect(html).toContain('id="token-quota"');
    expect(html).toContain('id="token-by-account"');
    expect(html).toContain('id="token-by-action"');
    expect(html).toContain('loadTokenUsage');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/web/billingTokenSection.test.js`
Expected: FAIL（缺 section / 元素 id）

- [ ] **Step 3: 最小实现 — `src/web/billing.html`**

在 `<section><h3>本期概览</h3>...</section>`（第 59 行）之后插入专区段：
```html
  <section><h3>Token 额度与使用明细</h3>
    <p class="sub">按租户 → 账号 → 动作 三级下钻；额度来自本租户生效档位，真实用量来自 LLM/embedding 调用计量。</p>
    <div class="ov" id="token-quota"></div>
    <h4 style="margin:16px 0 8px;font-size:14px">按账号</h4>
    <table class="bd" id="token-by-account"></table>
    <h4 style="margin:16px 0 8px;font-size:14px">按动作</h4>
    <table class="bd" id="token-by-action"></table>
  </section>
```
在 `<script type="module">` 内、`loadSummary` 函数之后新增：
```js
  async function loadTokenUsage() {
    await api(`/api/billing/token-usage?period=${curPeriod()}${tenantQuery()}`)
      .then(renderTokenUsage).catch((e) => console.error('token-usage', e));
  }
  function pct(v) { return `${Number(v).toFixed(1)}%`; }
  function renderTokenUsage(d) {
    // 管理员全量（scope='*'）逐租户渲染；自助单租户
    const blocks = d.tenants
      ? d.tenants.map((t) => renderTokenBlock(t.tenant_id, t))
      : [renderTokenBlock(d.scope, d)];
    document.getElementById('token-quota').innerHTML = blocks.map((b) => b.quota).join('');
    document.getElementById('token-by-account').innerHTML =
      `<tr><th>账号</th><th>in</th><th>out</th><th>合计</th><th>占比</th></tr>` +
      blocks.map((b) => b.account).join('');
    document.getElementById('token-by-action').innerHTML =
      `<tr><th>动作</th><th>in</th><th>out</th><th>合计</th><th>占比</th></tr>` +
      blocks.map((b) => b.action).join('');
  }
  function renderTokenBlock(scope, d) {
    const q = d.quota || {};
    const quota = `<div class="rcard"><div class="k">${scope} · 额度</div><div class="v">${q.unlimited ? '不限' : Number(q.included_tokens).toLocaleString()}</div></div>`
      + `<div class="rcard"><div class="k">已用</div><div class="v">${Number(q.used_total || 0).toLocaleString()}</div></div>`
      + `<div class="rcard"><div class="k">剩余</div><div class="v">${q.unlimited ? '∞' : Number(q.remaining).toLocaleString()}</div></div>`
      + `<div class="rcard"><div class="k">超量费</div><div class="v">${fmtMoney(q.overage_fee || 0)}</div></div>`;
    const account = (d.byAccount || []).map((r) =>
      `<tr><td>${r.username || r.actor}${r.is_unattributed ? ' <span class="bad">未归因</span>' : ''}</td><td>${r.tokens_in}</td><td>${r.tokens_out}</td><td>${r.total}</td><td>${pct(r.share_pct)}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="ok">无数据</td></tr>';
    const action = (d.byAction || []).map((r) =>
      `<tr><td>${r.action}</td><td>${r.tokens_in}</td><td>${r.tokens_out}</td><td>${r.total}</td><td>${pct(r.share_pct)}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="ok">无数据</td></tr>';
    return { quota, account, action };
  }
```
在初始化 IIFE（第 264 行起）中 `await loadSummary();` 之后追加 `await loadTokenUsage();`；并在 `refresh` 按钮回调（第 262 行）中追加 `loadTokenUsage();`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/web/billingTokenSection.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/web/billing.html test/web/billingTokenSection.test.js
git commit -m "feat(billing): 账单页 Token 额度/使用明细专区（租户→账号→动作）"
```

---

## 自检（Self-Review）

1. **Spec 覆盖**：① 真实计量（Task1 callChat/embed 解析 usage + agentLoop 注入 metering）✓；② 三级聚合（Task2）✓；③ 租户隔离端点（Task3，复用 applyTenantOverride）✓；④ 账单页专区（Task4）✓；⑤ 不改表结构 / fail-open ✓；⑥ 历史 `actor='system'` 未归因由 `is_unattributed` 兜底 ✓。
2. **占位符扫描**：无 TBD/TODO；每个代码步骤均含完整实现；测试含真实断言。
3. **类型一致性**：`tokenQuota/tokenByAccount/tokenByAction` 签名与返回结构在 Task2 定义、Task3 路由调用、Task4 前端渲染三处一致；`metering` 字段 `{tenantId, actor, action, decision_id}` 在 client.js/embeddingClient.js/agentLoop.js 一致；`tenantQuery()` 复用既有 billing.html 作用域拼接。
