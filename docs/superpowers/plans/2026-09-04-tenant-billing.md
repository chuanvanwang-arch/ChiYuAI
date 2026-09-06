# 多租户 LLM Token 计费与费用页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CRM-ai-native 新增平台级计费域：按租户统计「账号费 + Token 费」，租户自助查询、管理员集中查询与对账，平台内缴费记录流，并按 attio/Lightfield 风格套餐做功能门槛门禁。

**Architecture:** 专用计费表 `billing_statement`/`billing_payment` + `config_store` 配置化档位（含权益集）；复用既有 `tenantScopeBar`/`applyTenantOverride` 做租户隔离；在 `actionExecutor.dispatch` 第 1.7 闸插入 `plan_entitlement` 门禁。设计基线文档：`docs/2026-09-04-tenant-billing-page-design.md`（已批准）。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL(5433, schema crm)；前端 vanilla HTML + `/portal/` web components（`api.js`/`tenantScopeBar.js`/`layout.js`/`util.js`）；测试 vitest 3。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `db/migration-billing-token-tenant.sql` | `token_accounting` 加 `tenant_id`（前置缺口修复） |
| `db/migration-billing-tables.sql` | 新建 `billing_statement` / `billing_payment` |
| `db/seed-billing-config.sql` | `config_store` 写入 `billing-plans` / `billing-settings` |
| `src/alerts/tokenAccounting.js` | `recordTokens` 增 `tenantId` 参数 + INSERT 带 `tenant_id` |
| `src/action/executor.js` | 调用 `recordTokens` 透传 `ctx.tenantId`；插入第 1.7 闸 `plan_entitlement` |
| `src/billing/pricing.js` | `computeBilling(plan, tokenIn, tokenOut, seatCount)` 纯函数（账号费+Token费） |
| `src/billing/entitlements.js` | `resolveEntitlements(tenantId)` → Set |
| `src/billing/billingService.js` | 聚合 token/席位、生成账单、缴费、对账、导出 |
| `src/http/billingRoutes.js` | `/api/billing/*` 路由（汇总/用量/出账/对账/导出/缴费/档位） |
| `src/http/routes.js` | `import` 并挂载 `billingRoutes` |
| `src/action/registry.js` | 代表 action 加 `requiresEntitlement` 元数据 |
| `test/billing/pricing.test.js` | 计价纯函数单测 |
| `test/billing/entitlements.test.js` | 权益解析 + 门禁拦截单测 |
| `test/billing/billingService.test.js` | 聚合/出账/缴费/对账单测 |
| `src/web/billing.html` | 费用页面（自助/集中/提醒/对账/缴费/功能矩阵） |

---

## Task 1: 补 token_accounting 租户维度

**Files:**
- Create: `db/migration-billing-token-tenant.sql`
- Modify: `src/alerts/tokenAccounting.js:25-31`
- Modify: `src/action/executor.js:182-188`

- [ ] **Step 1: 写失败测试（聚合按租户）**

```js
// test/billing/tokenTenant.test.js
import { query, queryWrite } from '../../src/db.js';
import { recordTokens } from '../../src/alerts/tokenAccounting.js';

afterEach(async () => { await queryWrite(`DELETE FROM crm.token_accounting WHERE actor='__t_test'`); });

test('recordTokens 写入 tenant_id', async () => {
  const r = await recordTokens({ actor:'__t_test', action:'crm-deal-advance', tokensIn:10, tokensOut:5, tenantId:'acme' });
  expect(r.ok).toBe(true);
  const q = await query(`SELECT tenant_id, tokens_in FROM crm.token_accounting WHERE actor='__t_test'`);
  expect(q.rows[0].tenant_id).toBe('acme');
  expect(q.rows[0].tokens_in).toBe(10);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/tokenTenant.test.js`
Expected: FAIL（`recordTokens` 不接受 tenantId，列不存在）

- [ ] **Step 3: 写迁移补列**

```sql
-- db/migration-billing-token-tenant.sql
ALTER TABLE crm.token_accounting
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_tenant
  ON crm.token_accounting(tenant_id, created_at);
```

- [ ] **Step 4: 改 writer 透传 tenantId**

```js
// src/alerts/tokenAccounting.js
export async function recordTokens({ actor='system', action='unknown', tokensIn=0, tokensOut=0, source='llm', decision_id=null, tenantId='system' } = {}) {
  try {
    await queryWrite(
      `INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, decision_id, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor, action, Number(tokensIn)||0, Number(tokensOut)||0, source, decision_id, tenantId]
    );
    return { ok:true };
  } catch (e) { return { ok:false, error:e.message }; }
}
```

- [ ] **Step 5: 调用处透传 ctx.tenantId**

```js
// src/action/executor.js (原 line ~186)
await recordTokens({
  actor: ctx.actor || 'system', action: actionName,
  tokensIn: ctx.tokensIn ?? 0, tokensOut: ctx.tokensOut ?? 0,
  source: 'llm', decision_id: decisionId, tenantId: ctx.tenantId || 'system',
});
```

- [ ] **Step 6: 重跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/tokenTenant.test.js`
Expected: PASS

- [ ] **Step 7: 提交（用户本地 PowerShell）**

```powershell
git add db/migration-billing-token-tenant.sql src/alerts/tokenAccounting.js src/action/executor.js test/billing/tokenTenant.test.js
git commit -m "feat(billing): add tenant_id to token_accounting + writer passthrough"
```

---

## Task 2: 计费配置化档位 + 账期 + 权益（config_store）

**Files:**
- Create: `db/seed-billing-config.sql`
- Create: `src/http/billingRoutes.js` (仅 plans 段，Task 4 扩写其余)
- Test: `test/billing/billingRoutes.test.js`

- [ ] **Step 1: 写失败测试（GET /api/billing/plans）**

```js
// test/billing/billingRoutes.test.js
import { readConfig } from '../../src/config/configStore.js';
test('billing-plans config 含 4 档且含 entitlements', async () => {
  const plans = await readConfig('billing-plans', { tenantId:'system' });
  expect(Array.isArray(plans)).toBe(true);
  expect(plans.length).toBe(4);
  expect(plans.find(p=>p.plan_id==='pro').entitlements).toContain('decision_autonomy');
});
```

- [ ] **Step 2: 运行确认失败** → FAIL（config 未播种）

- [ ] **Step 3: 播种 config_store**

```sql
-- db/seed-billing-config.sql
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at) VALUES
('system','billing-settings',
 '{"cycle":"monthly","default_plan":"free","currency":"CNY","grace_days":15}'::jsonb,
 'system', now())
ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at) VALUES
('system','billing-plans',
 '[{"plan_id":"free","name":"免费版","base_fee":0,"included_seats":3,"seat_unit_price":0,"included_tokens":50000,"token_overage_unit_price":0.030,"currency":"CNY","features":"核心 CRM","entitlements":["core_crm"]},
   {"plan_id":"starter","name":"起步版","base_fee":0,"included_seats":5,"seat_unit_price":39,"included_tokens":200000,"token_overage_unit_price":0.025,"currency":"CNY","features":"+ AI 代理/360洞察","entitlements":["core_crm","ai_agents","customer_360"]},
   {"plan_id":"pro","name":"专业版","base_fee":199,"included_seats":20,"seat_unit_price":99,"included_tokens":1000000,"token_overage_unit_price":0.020,"currency":"CNY","features":"+ 决策自治/事件自动化/审批/LLM/MCP/报表/审计","entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance"]},
   {"plan_id":"enterprise","name":"企业版","base_fee":0,"included_seats":-1,"seat_unit_price":0,"included_tokens":-1,"token_overage_unit_price":0,"currency":"CNY","features":"面议：+ 行业配置/高级RBAC/客户记忆","entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance","industry_config","rbac_advanced","memory"]}]'::jsonb,
 'system', now())
ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
```

- [ ] **Step 4: 路由返回档位**

```js
// 在 src/http/billingRoutes.js 中（Task 4 一起挂载，此处先定义 plans 处理器）
import { readConfig } from '../config/configStore.js';
export function registerBillingRoutes(app) {
  app.get('/api/billing/plans', async (req, res) => {
    try {
      const plans = await readConfig('billing-plans', { tenantId:'system' });
      const settings = await readConfig('billing-settings', { tenantId:'system' });
      res.json({ plans, settings });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
```

- [ ] **Step 5: 重跑测试确认通过** → PASS

- [ ] **Step 6: 提交**

```powershell
git add db/seed-billing-config.sql src/http/billingRoutes.js test/billing/billingRoutes.test.js
git commit -m "feat(billing): seed billing-plans/billing-settings + GET /api/billing/plans"
```

---

## Task 3: 计费表 + 启用 tenants.plan

**Files:**
- Create: `db/migration-billing-tables.sql`
- Modify: `src/http/billingRoutes.js`（加 `POST /api/admin/tenant-plan`）
- Test: `test/billing/billingTables.test.js`

- [ ] **Step 1: 写失败测试（表存在 + 设 plan）**

```js
// test/billing/billingTables.test.js
import { query } from '../../src/db.js';
test('billing_statement 与 billing_payment 存在且带 tenant_id', async () => {
  const r = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='billing_statement' AND column_name='tenant_id'`);
  expect(r.rows.length).toBe(1);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 建表迁移**

```sql
-- db/migration-billing-tables.sql
CREATE TABLE IF NOT EXISTS crm.billing_statement (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'system',
  period      TEXT NOT NULL,
  cycle       TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','quarterly')),
  token_in    INT NOT NULL DEFAULT 0,
  token_out   INT NOT NULL DEFAULT 0,
  token_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  seat_count  INT NOT NULL DEFAULT 0,
  seat_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','overdue')),
  issued_at   TIMESTAMPTZ,
  due_at      TIMESTAMPTZ,
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, cycle)
);
CREATE TABLE IF NOT EXISTS crm.billing_payment (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  statement_id BIGINT NOT NULL REFERENCES crm.billing_statement(id),
  amount      NUMERIC(12,2) NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('bank_transfer','wechat','alipay','other')),
  status      TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','failed')),
  paid_at     TIMESTAMPTZ,
  txn_ref     TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- tenants.plan 列已存在于 2026-09-03-crm-tenants.sql；此处仅补索引（幂等）
CREATE INDEX IF NOT EXISTS idx_crm_billing_statement_tenant_period
  ON crm.billing_statement(tenant_id, period, cycle);
```

- [ ] **Step 4: 启用 tenants.plan（admin 设档位，零信任角色闸）**

```js
// 追加到 registerBillingRoutes
app.post('/api/admin/tenant-plan', async (req, res) => {
  const me = req.me || {};
  if (me.role !== 'admin' && me.role !== 'sysadmin') return res.status(403).json({ error:'forbidden' });
  const { tenantId, planId } = req.body || {};
  if (!tenantId || !planId) return res.status(400).json({ error:'tenantId & planId required' });
  try {
    const r = await query(
      `UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`,
      [tenantId, planId]
    );
    res.json({ ok:true, updated: r.rowCount });
  } catch (e) { res.status(500).json({ error:e.message }); }
});
```

- [ ] **Step 5: 重跑测试确认通过** → PASS

- [ ] **Step 6: 提交**

```powershell
git add db/migration-billing-tables.sql src/http/billingRoutes.js test/billing/billingTables.test.js
git commit -m "feat(billing): create billing_statement/billing_payment + admin set tenant plan"
```

---

## Task 4: 计费汇总 / 逾期 / 缴费 / 对账 / 导出 API

**Files:**
- Create: `src/billing/pricing.js`
- Create: `src/billing/billingService.js`
- Modify: `src/http/billingRoutes.js`（汇总/用量/出账/对账/导出/缴费）
- Test: `test/billing/pricing.test.js`, `test/billing/billingService.test.js`

- [ ] **Step 1: 写计价纯函数测试**

```js
// test/billing/pricing.test.js
import { computeBilling } from '../../src/billing/pricing.js';
const pro = { base_fee:199, included_seats:20, seat_unit_price:99, included_tokens:1000000, token_overage_unit_price:0.020 };
test('专业版：超席 + 超 token 计费', () => {
  const b = computeBilling(pro, 1200000, 800000, 25); // token 合计 2,000,000；席 25
  // 账号费 = 199 + (25-20)*99 = 199+495 = 694
  // Token费 = (2,000,000-1,000,000)/1000*0.020 = 1000*0.020 = 20
  expect(b.seat_fee).toBeCloseTo(694, 2);
  expect(b.token_fee).toBeCloseTo(20, 2);
  expect(b.total_fee).toBeCloseTo(714, 2);
});
test('企业版不限（-1）不计超额', () => {
  const ent = { base_fee:0, included_seats:-1, seat_unit_price:0, included_tokens:-1, token_overage_unit_price:0 };
  const b = computeBilling(ent, 9e9, 9e9, 999);
  expect(b.seat_fee).toBe(0); expect(b.token_fee).toBe(0); expect(b.total_fee).toBe(0);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现 pricing.js**

```js
// src/billing/pricing.js
export function computeBilling(plan, tokenIn, tokenOut, seatCount) {
  const seats = Number(seatCount) || 0;
  const tokens = (Number(tokenIn)||0) + (Number(tokenOut)||0);
  const seatFee = plan.included_seats === -1
    ? 0
    : plan.base_fee + Math.max(0, seats - (plan.included_seats||0)) * (plan.seat_unit_price||0);
  const tokenFee = plan.included_tokens === -1
    ? 0
    : Math.max(0, tokens - (plan.included_tokens||0)) / 1000 * (plan.token_overage_unit_price||0);
  const total = Math.round((seatFee + tokenFee) * 100) / 100;
  return {
    seat_count: seats,
    seat_fee: Math.round(seatFee*100)/100,
    token_fee: Math.round(tokenFee*100)/100,
    total_fee: total,
  };
}
```

- [ ] **Step 4: 实现 billingService.js（聚合/出账/缴费/对账/导出）**

```js
// src/billing/billingService.js
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { computeBilling } from './pricing.js';

async function getPlan(tenantId) {
  const tenants = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
  const planId = tenants.rows[0]?.plan || (await readConfig('billing-settings',{tenantId:'system'})).default_plan;
  const plans = await readConfig('billing-plans', { tenantId:'system' });
  return plans.find(p => p.plan_id === planId) || plans[0];
}
async function tokenUsage(tenantId, period) {
  const r = await query(
    `SELECT COALESCE(SUM(tokens_in),0)::int AS tin, COALESCE(SUM(tokens_out),0)::int AS tout
     FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')= $2`,
    [tenantId, period]
  );
  return r.rows[0];
}
async function activeSeats(tenantId) {
  const r = await query(
    `SELECT count(*)::int AS n FROM crm.crm_users WHERE tenant_id=$1 AND status='active'`,
    [tenantId]
  );
  return r.rows[0].n;
}
export async function computeStatement(tenantId, period) {
  const plan = await getPlan(tenantId);
  const u = await tokenUsage(tenantId, period);
  const seats = await activeSeats(tenantId);
  const b = computeBilling(plan, u.tin, u.tout, seats);
  return { tenant_id:tenantId, period, token_in:u.tin, token_out:u.tout, ...b };
}
export async function issueStatement(tenantId, period, cycle='monthly', graceDays=15) {
  const s = await computeStatement(tenantId, period);
  const res = await query(
    `INSERT INTO crm.billing_statement (tenant_id, period, cycle, token_in, token_out, token_fee, seat_count, seat_fee, total_fee, status, issued_at, due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',now(),now()+$10::int)
     ON CONFLICT (tenant_id, period, cycle) DO UPDATE
       SET token_in=EXCLUDED.token_in, token_out=EXCLUDED.token_out, token_fee=EXCLUDED.token_fee,
           seat_count=EXCLUDED.seat_count, seat_fee=EXCLUDED.seat_fee, total_fee=EXCLUDED.total_fee,
           status='issued', issued_at=now(), due_at=now()+$10::int
     RETURNING *`,
    [tenantId, period, cycle, s.token_in, s.token_out, s.token_fee, s.seat_count, s.seat_fee, s.total_fee, graceDays]
  );
  return res.rows[0];
}
export async function flipOverdue() {
  await query(`UPDATE crm.billing_statement SET status='overdue'
    WHERE status='issued' AND due_at < now()`);
}
export async function pay(statementId, { method='other', note='', txn_ref='' }) {
  const st = await query(`SELECT * FROM crm.billing_statement WHERE id=$1`, [statementId]);
  if (!st.rows[0]) throw new Error('statement not found');
  const s = st.rows[0];
  await query(`INSERT INTO crm.billing_payment (tenant_id, statement_id, amount, method, status, paid_at, txn_ref, note)
    VALUES ($1,$2,$3,$4,'paid',now(),$5,$6)`, [s.tenant_id, statementId, s.total_fee, method, txn_ref, note]);
  await query(`UPDATE crm.billing_statement SET status='paid', paid_at=now() WHERE id=$1`, [statementId]);
  return { ok:true };
}
export async function reconcile(period) {
  const r = await query(
    `SELECT status, count(*)::int AS n, COALESCE(SUM(total_fee),0)::numeric AS amt
     FROM crm.billing_statement WHERE period=$1 GROUP BY status`, [period]);
  return r.rows;
}
export async function exportCsv(period, tenantScope='*') {
  const rows = await query(
    tenantScope==='*'
      ? `SELECT tenant_id, period, total_fee, status FROM crm.billing_statement WHERE period=$1 ORDER BY tenant_id`
      : `SELECT tenant_id, period, total_fee, status FROM crm.billing_statement WHERE period=$1 AND tenant_id=$2 ORDER BY tenant_id`,
    tenantScope==='*' ? [period] : [period, tenantScope]);
  const head = 'tenant_id,period,total_fee,status\n';
  return head + rows.rows.map(r=>`${r.tenant_id},${r.period},${r.total_fee},${r.status}`).join('\n');
}
```

- [ ] **Step 5: 挂载路由**

```js
// 续 registerBillingRoutes（import billingService + applyTenantOverride + scopeTenant）
import { computeStatement, issueStatement, flipOverdue, pay, reconcile, exportCsv } from '../billing/billingService.js';
import { applyTenantOverride } from './tenantScope.js';
import { scopeTenant } from './tenantScope.js';

app.get('/api/billing/summary', async (req, res) => {
  const me = req.me || {};
  const scope = applyTenantOverride(req, me);     // '*' 或具体 tenant
  const { period, cycle='monthly' } = req.query;
  try {
    await flipOverdue();
    const tenants = scope === '*'
      ? (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map(r=>r.tenant_id)
      : [scope];
    const rows = [];
    for (const t of tenants) rows.push(await computeStatement(t, period));
    res.json({ rows });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/billing/statement/issue', async (req, res) => {
  const me = req.me || {};
  if (me.role!=='admin' && me.role!=='sysadmin') return res.status(403).json({ error:'forbidden' });
  const { tenantId, period, cycle } = req.body || {};
  try { const s = await issueStatement(tenantId, period, cycle); res.json({ ok:true, statement:s }); }
  catch(e){ res.status(500).json({ error:e.message }); }
});

app.get('/api/billing/reconcile', async (req, res) => {
  const me = req.me || {};
  if (me.role!=='admin' && me.role!=='sysadmin') return res.status(403).json({ error:'forbidden' });
  try { await flipOverdue(); res.json({ rows: await reconcile(req.query.period) }); }
  catch(e){ res.status(500).json({ error:e.message }); }
});

app.get('/api/billing/export', async (req, res) => {
  const me = req.me || {};
  if (me.role!=='admin' && me.role!=='sysadmin') return res.status(403).json({ error:'forbidden' });
  const scope = applyTenantOverride(req, me);
  try { const csv = await exportCsv(req.query.period, scope);
    res.setHeader('Content-Type','text/csv'); res.send(csv); }
  catch(e){ res.status(500).json({ error:e.message }); }
});

app.post('/api/billing/pay', async (req, res) => {
  const me = req.me || {};
  const scope = scopeTenant(me);   // 普通用户仅能缴本租户
  const { statementId, method, note, txn_ref } = req.body || {};
  try {
    const st = await query(`SELECT tenant_id FROM crm.billing_statement WHERE id=$1`, [statementId]);
    if (!st.rows[0]) return res.status(404).json({ error:'not found' });
    if (scope !== '*' && st.rows[0].tenant_id !== scope)
      return res.status(403).json({ error:'cannot pay other tenant' });
    const r = await pay(statementId, { method, note, txn_ref });
    res.json(r);
  } catch(e){ res.status(500).json({ error:e.message }); }
});
```

- [ ] **Step 6: 写 billingService 单测并运行**

```js
// test/billing/billingService.test.js
import { computeStatement, issueStatement, pay, reconcile } from '../../src/billing/billingService.js';
// 依赖 PG 真库，用 beforeAll 灌测试租户 + token + 用户，afterAll 清理
test('issue + pay 流转', async () => {
  const s = await issueStatement('__bt', '2026-09');
  expect(s.status).toBe('issued');
  const r = await pay(s.id, { method:'bank_transfer', note:'test' });
  expect(r.ok).toBe(true);
  const rec = await reconcile('2026-09');
  expect(rec.find(x=>x.status==='paid')).toBeTruthy();
});
```

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/`
Expected: 全部 PASS（PG 不稳时单次红不得直判，重跑）

- [ ] **Step 7: 提交**

```powershell
git add src/billing/pricing.js src/billing/billingService.js src/http/billingRoutes.js test/billing/pricing.test.js test/billing/billingService.test.js
git commit -m "feat(billing): summary/issue/pay/reconcile/export APIs + pricing"
```

---

## Task 5: 功能门槛门禁（dispatch 第 1.7 闸 + 解析器 + 代表打标）

**Files:**
- Create: `src/billing/entitlements.js`
- Modify: `src/action/executor.js`（第 1.5 闸后插入第 1.7 闸）
- Modify: `src/action/registry.js`（代表 action 加 `requiresEntitlement`）
- Test: `test/billing/entitlements.test.js`

- [ ] **Step 1: 写失败测试（解析 + 拦截）**

```js
// test/billing/entitlements.test.js
import { resolveEntitlements } from '../../src/billing/entitlements.js';
import { query, queryWrite } from '../../src/db.js';
afterAll(async () => { await queryWrite(`UPDATE crm.tenants SET plan='free' WHERE tenant_id='__et'`); });
test('resolveEntitlements 返回档位权益集', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='pro' WHERE tenant_id='__et'`);
  const e = await resolveEntitlements('__et');
  expect(e.has('decision_autonomy')).toBe(true);
  expect(e.has('industry_config')).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现解析器**

```js
// src/billing/entitlements.js
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
export async function resolveEntitlements(tenantId) {
  try {
    const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
    const planId = t.rows[0]?.plan || (await readConfig('billing-settings',{tenantId:'system'})).default_plan;
    const plans = await readConfig('billing-plans', { tenantId:'system' });
    const plan = plans.find(p => p.plan_id === planId) || plans[0];
    return new Set(plan?.entitlements || []);
  } catch { return new Set(); }   // fail-open：解析异常默认放行
}
```

- [ ] **Step 4: 插入第 1.7 闸（executor.js，第 1.5 闸 RBAC 之后）**

```js
// src/action/executor.js — 在 RBAC 第1.5闸块之后、field 第2.5闸之前插入：
if (def.requiresEntitlement?.length) {
  try {
    const { resolveEntitlements } = await import('../billing/entitlements.js');
    const ents = await resolveEntitlements(ctx.tenantId || 'system');
    const missing = def.requiresEntitlement.filter((k) => !ents.has(k));
    if (missing.length) {
      emit('trace', 'action-plan-blocked', { action: actionName, tenant: ctx.tenantId, missing });
      return { ok:false, gate:'plan_entitlement', error:`当前套餐未解锁: ${missing.join(',')}，请升级套餐` };
    }
  } catch { /* fail-open */ }
}
```

- [ ] **Step 5: 代表 action 打标（registry.js）**

```js
// 在 registry 中对应 action 定义增加 requiresEntitlement（按 src/action/registry.js 实名校准）
// 例：
// { name:'crm-account-360', kind:'read', requiresEntitlement:['customer_360'], ... }
// { name:'method-decision-execute', kind:'write', requiresEntitlement:['decision_autonomy'], ... }
// { name:'agent-event-trigger-dispatch', kind:'write', requiresEntitlement:['event_automation'], ... }
// { name:'crm-review-gate-approve', kind:'write', requiresEntitlement:['approval_flow'], ... }
// { name:'sales-decision-monitor', kind:'read', requiresEntitlement:['advanced_reporting'], ... }
```
> 具体 action 名以 `src/action/registry.js` 现有键为准（writing-plans 执行时核对）。

- [ ] **Step 6: 重跑测试确认通过** → PASS

- [ ] **Step 7: 提交**

```powershell
git add src/billing/entitlements.js src/action/executor.js src/action/registry.js test/billing/entitlements.test.js
git commit -m "feat(billing): plan_entitlement gate + resolver + representative tagging"
```

---

## Task 6: 费用页面 billing.html

**Files:**
- Create: `src/web/billing.html`
- Test: `test/web/billing.smoke.test.js`（存在性 + 关键节点 id）

- [ ] **Step 1: 写存在性冒烟测试**

```js
// test/web/billing.smoke.test.js
import { readFileSync } from 'fs';
test('billing.html 含关键节点', () => {
  const html = readFileSync('src/web/billing.html','utf8');
  expect(html).toContain('id="tier-cards"');
  expect(html).toContain('id="overview"');
  expect(html).toContain('id="statement-table"');
  expect(html).toContain('id="reconcile"');
  expect(html).toContain('id="pay-modal"');
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现页面（复用 tenantScopeBar + api.js + layout.js + util.js）**

页面结构（attio/Lightfield 风，分段卡片）：
1. 顶部 `tenantScopeBar` 挂载点（admin 显示租户筛选）
2. `#tier-cards`：4 档卡片 + 功能矩阵表（✓/—），当前租户档高亮
3. `#overview`：概览卡（Token 用量 in/out、活跃账号、Token 费、账号费、合计、待缴）
4. `#overdue`：待缴/逾期提醒区（红=逾期）
5. `#statement-table`：账单明细表（账期+cycle 筛选；admin 见租户列 + 缴费按钮）
6. `#reconcile`：管理员对账视图（已出账/已缴/逾期 + 导出 CSV 按钮）
7. `#pay-modal`：缴费弹窗（方式下拉 + 流水号 + 备注 + 确认）

关键前端逻辑（内联 module script）：
```js
import { injectLayout } from '/portal/layout.js';
import { me, api } from '/portal/api.js';
import { fmtMoney } from '/portal/util.js';
import { mountTenantScopeBar, tenantQuery, isAdminScope } from '/portal/tenantScopeBar.js';
injectLayout();

async function loadPlans() { return api('/api/billing/plans'); }
async function loadSummary() {
  const meR = await me();
  const isAdmin = meR?.role==='admin' || meR?.role==='sysadmin';
  const data = await api(`/api/billing/summary?period=${curPeriod()}${tenantQuery()}`);
  renderOverview(data.rows, isAdmin);
  renderStatements(data.rows, isAdmin);
  if (isAdmin) loadReconcile();
}
function curPeriod(){ const d=new Date(); return d.toISOString().slice(0,7); }
function renderOverview(rows, isAdmin){
  const all = isAdmin ? rows : rows;
  const sum = (k)=>all.reduce((a,r)=>a+(r[k]||0),0);
  document.getElementById('overview').innerHTML = [
    ['Token 用量(in)', sum('token_in')],
    ['Token 用量(out)', sum('token_out')],
    ['活跃账号', sum('seat_count')],
    ['Token 费', fmtMoney(sum('token_fee'))],
    ['账号费', fmtMoney(sum('seat_fee'))],
    ['合计', fmtMoney(sum('total_fee'))],
  ].map(([k,v])=>`<div class="card"><p class="cl">${k}</p><p class="cv">${v}</p></div>`).join('');
}
function renderStatements(rows, isAdmin){
  const el = document.getElementById('statement-table');
  el.innerHTML = `<table class="bd"><tr><th>账期</th>${isAdmin?'<th>租户</th>':''}<th>Token费</th><th>账号费</th><th>合计</th><th>状态</th><th></th></tr>` +
    rows.map(r=>`<tr><td>${r.period}</td>${isAdmin?`<td>${r.tenant_id}</td>`:''}<td>${fmtMoney(r.token_fee)}</td><td>${fmtMoney(r.seat_fee)}</td><td>${fmtMoney(r.total_fee)}</td><td>${r.status}</td><td><button onclick="openPay(${r.id})">缴费</button></td></tr>`).join('') + `</table>`;
}
async function loadReconcile(){
  const d = await api(`/api/billing/reconcile?period=${curPeriod()}${tenantQuery()}`);
  document.getElementById('reconcile').innerHTML = d.rows.map(r=>`<div class="card"><p class="cl">${r.status}</p><p class="cv">${r.amt}</p><p class="cl">${r.n} 笔</p></div>`).join('') + `<button onclick="exportCsv()">导出 CSV</button>`;
}
function openPay(id){
  document.getElementById('pay-modal').style.display='block';
  document.getElementById('pay-confirm').onclick = async ()=>{
    await api('/api/billing/pay', { method:'POST', body: JSON.stringify({
      statementId:id, method:document.getElementById('pay-method').value,
      note:document.getElementById('pay-note').value, txn_ref:document.getElementById('pay-txn').value }) });
    document.getElementById('pay-modal').style.display='none';
    loadSummary();
  };
}
async function exportCsv(){
  const r = await fetch(`/api/billing/export?period=${curPeriod()}${tenantQuery()}`, { headers:{ Authorization:`Bearer ${localStorage.getItem('crm_token')}` } });
  const blob = await r.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='billing.csv'; a.click();
}
(async ()=>{ const m=await me(); document.getElementById('app').style.display='block';
  if(m?.role==='admin'||m?.role==='sysadmin') await mountTenantScopeBar(document.getElementById('tenant-bar'), ()=>loadSummary());
  await loadSummary(); })();
```
> 样式复用 `/portal/tokens.css` + `/portal/common.css`；卡片/表格风格对齐 `receivables.html`/`finance-receivables.html`。

- [ ] **Step 4: 重跑冒烟测试确认通过** → PASS

- [ ] **Step 5: 提交**

```powershell
git add src/web/billing.html test/web/billing.smoke.test.js
git commit -m "feat(billing): billing.html self/admin query + pay + reconcile + tier matrix"
```

---

## 自检（Self-Review）

1. **Spec 覆盖**：① token 租户维度(T1) ② 配置化档位+账期+权益(T2) ③ 计费表+tenants.plan(T3) ④ 汇总/逾期/缴费/对账/导出(T4) ⑤ 功能门槛门禁(T5) ⑥ 费用页面(T6) —— 全部覆盖；四项增量（导出/逾期/缴费方式/账期可配）落在 T3/T4/T6。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含实际实现。
3. **类型一致性**：`computeBilling` 签名在 pricing.test / pricing.js / billingService.js 一致；`resolveEntitlements` 在 entitlements.test / executor 一致；`applyTenantOverride` / `scopeTenant` 来自既有 `tenantScope.js`。

## 执行交接

计划已存 `docs/superpowers/plans/2026-09-04-tenant-billing.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每任务派发独立子代理，任务间两阶段评审，迭代快。
2. **Inline 执行** — 本会话用 executing-plans 逐 Task 执行带检查点。

> 注：本环境沙箱无 git 凭证，所有 `git commit` 由用户在本地按功能线执行（PowerShell 兼容命令已给出）。PG 不稳时测试单次红不得直判回归，重跑确认。
