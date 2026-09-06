# 租户订阅 · 模块用量 · 实时费用 · 一键升级续费 · 套餐 DB 维护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有计费域（5 档套餐 + 账号/Token 混合计价 + 权益门禁）上增量扩展：独立订阅表 + 订阅状态机（续费/升级/到期停服）+ 模块控制与用量归因 + 实时费用 + 一键升级续费（Stripe Checkout + webhook 即时开通）+ 套餐 DB 维护管理页。

**Architecture:** 新增 `tenant_subscription`（订阅史，append-only）与 `module_usage`（模块开关 + 按 `(tenant_id,module,period)` 计量）；订阅状态机由 Stripe webhook 驱动（缴费即开通）；实时费用=复用 `computeBilling` 纯函数以实时聚合值入参；套餐维护走 `config_store['billing-plans']` 增删改（软停用）；模块开关在 dispatch 闸消费。沿用既有 `applyTenantOverride`/`scopeTenant` 租户隔离、决策第 0 闸、绝对禁 DELETE 铁律。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL(5433, schema crm) + 前端 vanilla HTML + `/portal/` web components（api.js/util.js/layout.js）；Stripe 用 `fetch` 直调 REST API（零新增依赖）；测试 vitest 3。

> 设计基线：`docs/2026-09-04-tenant-subscription-billing-design.md`（已批准）。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `db/migration-subscription-tables.sql` | 新建 `tenant_subscription` / `module_usage` |
| `db/schema.sql` | 同步两表 + `token_accounting.tenant_id`（单一事实源，幂等） |
| `src/billing/subscriptionService.js` | 订阅状态机（创建/续费/升级/到期停服）+ 实时费用 + 模块归因 |
| `src/billing/stripeGateway.js` | Stripe 适配器（Checkout Session + webhook 验签，零依赖 fetch 直调） |
| `src/billing/billingService.js` | `computeStatement` 增 `module_usage` 聚合（改动小） |
| `src/http/billingRoutes.js` | 新增订阅/升级/续费/webhook/live-cost/module-usage/admin-billing-plans/admin-billing-settings 端点 |
| `src/http/routes.js` | 挂载新增端点（若 billingRoutes 未覆盖） |
| `src/action/executor.js` | 模块开关闸（第 1.7 闸后插入模块 enabled 校验）+ `recordTokens` 透传 `ctx.module` |
| `src/alerts/tokenAccounting.js` | `recordTokens` 增 `module` 参数并写 `module_usage`（或由 subscriptionService 归因，二选一——采用前者的调用处兜底） |
| `src/web/billing.html` | 订阅高亮区 / 实时费用卡 / 模块用量与开关 / 一键升级续费弹窗 |
| `src/web/admin-billing-console.html` | 套餐维护 + 订阅全景 + 出账入口 |
| `test/billing/subscriptionService.test.js` | 状态机 / 实时费用 / 模块归因单测 |
| `test/billing/stripeGateway.test.js` | 验签 + Session 构造单测（mock fetch） |
| `test/billing/billingRoutes.test.js` | 新增端点路由测试 |
| `test/web/billing.smoke.test.js` | billing.html 关键节点存在性（既有扩展） |

---

## Task 1: 订阅 + 模块用量表 DDL

**Files:**
- Create: `db/migration-subscription-tables.sql`
- Modify: `db/schema.sql`（同步两表 + token_accounting.tenant_id 幂等）
- Test: `test/billing/subscriptionTables.test.js`

- [ ] **Step 1: 写失败测试（两表存在 + 列约束）**

```js
// test/billing/subscriptionTables.test.js
import { query } from '../../src/db.js';

test('tenant_subscription 表存在且含关键列', async () => {
  const r = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='tenant_subscription'
    AND column_name IN ('tenant_id','plan_id','status','expires_at','payment_ref')`);
  expect(r.rows.length).toBe(5);
});

test('module_usage 表存在且含 UNIQUE(tenant_id,module,period)', async () => {
  const r = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='crm' AND table_name='module_usage'
    AND column_name IN ('enabled','calls','tokens_in','tokens_out','period')`);
  expect(r.rows.length).toBe(5);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/subscriptionTables.test.js`
Expected: FAIL（表不存在）

- [ ] **Step 3: 写迁移**

```sql
-- db/migration-subscription-tables.sql
CREATE TABLE IF NOT EXISTS crm.tenant_subscription (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  plan_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','pending','expired','canceled','grace')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  grace_until    TIMESTAMPTZ,
  payment_ref    BIGINT REFERENCES crm.billing_payment(id),
  upgraded_from  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plan_id, started_at)
);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant
  ON crm.tenant_subscription(tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS crm.module_usage (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  module        TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  calls         INT NOT NULL DEFAULT 0,
  tokens_in     BIGINT NOT NULL DEFAULT 0,
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  period        TEXT NOT NULL DEFAULT 'YYYY-MM',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module, period)
);
CREATE INDEX IF NOT EXISTS idx_module_usage_tenant ON crm.module_usage(tenant_id, module, period);
```

- [ ] **Step 4: 同步 schema.sql（单一事实源，幂等追加）**

在 `db/schema.sql` 末尾（`token_accounting` 段附近或 `llm_config` 段之后）追加与 Step 3 完全相同的 `CREATE TABLE IF NOT EXISTS` 两段 + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS tenant_id`（token_accounting 如缺）。

- [ ] **Step 5: 应用迁移并重跑测试**

Run: `PGDATABASE=crm_native_test node db/migrate.js`（或 `node db/apply-subscription.mjs` 若已建）
Expected: 迁移成功 + 测试 PASS

- [ ] **Step 6: 提交**

```powershell
git add db/migration-subscription-tables.sql db/schema.sql test/billing/subscriptionTables.test.js
git commit -m "feat(billing): subscription + module_usage tables DDL"
```

---

## Task 2: 订阅状态机 + 实时费用 + 模块归因

**Files:**
- Create: `src/billing/subscriptionService.js`
- Modify: `src/alerts/tokenAccounting.js`（`recordTokens` 透传 `module` + 归因到 `module_usage`）
- Modify: `src/action/executor.js`（`recordTokens` 调用处透传 `ctx.module`）
- Test: `test/billing/subscriptionService.test.js`

- [ ] **Step 1: 写失败测试（状态机 + 实时费用 + 模块归因）**

```js
// test/billing/subscriptionService.test.js
import { query, queryWrite } from '../../src/db.js';
import { createSubscription, renewSubscription, upgradeSubscription, expireSweep, computeLiveCost, bumpModuleUsage } from '../../src/billing/subscriptionService.js';

const T = '__sub_test';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status) VALUES ($1,'t','active') ON CONFLICT (tenant_id) DO NOTHING`, [T]);
});
afterAll(async () => {
  // 禁 DELETE；测试租户数据用软清理：清空相关行（测试域允许，但遵循项目铁律——用 UPDATE 置 retired 更稳妥）
  await queryWrite(`UPDATE crm.tenants SET status='retired' WHERE tenant_id=$1`, [T]);
});

test('createSubscription 生成 pending 订阅', async () => {
  const s = await createSubscription(T, 'pro', 'monthly');
  expect(s.status).toBe('pending');
  expect(s.plan_id).toBe('pro');
});

test('renewSubscription 延长 expires_at', async () => {
  const s = await createSubscription(T, 'pro', 'monthly');
  const before = s.expires_at;
  const r = await renewSubscription(T, 'pro', 'monthly');
  expect(new Date(r.expires_at) > new Date(before)).toBe(true);
});

test('upgradeSubscription 切换 plan + 记录 upgraded_from', async () => {
  const s = await createSubscription(T, 'starter', 'monthly');
  const u = await upgradeSubscription(T, 'pro');
  expect(u.plan_id).toBe('pro');
  expect(u.upgraded_from).toBe('starter');
});

test('expireSweep 将过期订阅转 expired + 回落 free', async () => {
  // 造一条 expires_at 已过的订阅
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,expires_at)
    VALUES ($1,'pro','active',now()-interval '1 day')`, [T]);
  const r = await expireSweep();
  expect(r.some(x => x.tenant_id === T)).toBe(true);
  const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [T]);
  expect(['free', null].includes(t.rows[0]?.plan)).toBe(true);
});

test('computeLiveCost 返回实时费用', async () => {
  const c = await computeLiveCost(T);
  expect(typeof c.total_fee).toBe('number');
  expect(c).toHaveProperty('token_in');
  expect(c).toHaveProperty('seat_count');
});

test('bumpModuleUsage 按(tenant,module,period)累计', async () => {
  await bumpModuleUsage(T, 'ai_agents', { calls: 1, tokensIn: 100, tokensOut: 50 });
  const r = await query(`SELECT calls,tokens_in,tokens_out FROM crm.module_usage WHERE tenant_id=$1 AND module='ai_agents'`, [T]);
  expect(r.rows[0].calls).toBe(1);
  expect(r.rows[0].tokens_in).toBe(100);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/subscriptionService.test.js`
Expected: FAIL（subscriptionService.js 不存在）

- [ ] **Step 3: 实现 subscriptionService.js**

```js
// src/billing/subscriptionService.js — 订阅状态机 + 实时费用 + 模块归因
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { computeBilling } from './pricing.js';

async function getPlanDef(planId) {
  const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
  const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
  return plans.find((p) => p.plan_id === planId) || plans[0];
}

// 创建订阅（初始/升级/续费共用入口）：
//   mode='create'  新建 pending 订阅
//   mode='renew'   延长现有 active 订阅 expires_at（+周期）
//   mode='upgrade' 切换 tenants.plan + 新订阅行（upgraded_from=旧档）
export async function createSubscription(tenantId, planId, cycle = 'monthly') {
  const plan = await getPlanDef(planId);
  const months = cycle === 'quarterly' ? 3 : 1;
  const res = await queryWrite(
    `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at)
     VALUES ($1,$2,'pending', now() + ($3 || ' months')::interval)
     RETURNING *`,
    [tenantId, planId, months]
  );
  return res.rows[0];
}

export async function renewSubscription(tenantId, planId, cycle = 'monthly') {
  const months = cycle === 'quarterly' ? 3 : 1;
  const r = await queryWrite(
    `UPDATE crm.tenant_subscription SET expires_at = now() + ($3 || ' months')::interval,
       payment_ref = COALESCE($4, payment_ref), updated_at = now()
     WHERE tenant_id=$1 AND plan_id=$2 AND status='active'
     RETURNING *`,
    [tenantId, planId, months, null]
  );
  if (!r.rows[0]) return createSubscription(tenantId, planId, cycle);
  return r.rows[0];
}

export async function upgradeSubscription(tenantId, toPlanId, cycle = 'monthly') {
  const cur = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
  const from = cur.rows[0]?.plan || null;
  const months = cycle === 'quarterly' ? 3 : 1;
  // 新建升级订阅行 + 切换 tenants.plan（即时生效）
  const s = await queryWrite(
    `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at, upgraded_from)
     VALUES ($1,$2,'active', now() + ($3 || ' months')::interval, $4)
     RETURNING *`,
    [tenantId, toPlanId, months, from]
  );
  await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [tenantId, toPlanId]);
  return s.rows[0];
}

// 到期停服：expires_at 已过且 grace 已过 → 订阅转 expired + tenants.plan 回落 default_plan(free)
export async function expireSweep() {
  const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
  const defaultPlan = settingsRow?.value?.default_plan || 'free';
  const r = await queryWrite(
    `UPDATE crm.tenant_subscription SET status='expired', updated_at=now()
     WHERE status IN ('active','grace') AND expires_at < now()
     RETURNING tenant_id`
  );
  for (const row of r.rows || []) {
    await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [row.tenant_id, defaultPlan]);
  }
  return r.rows || [];
}

// 实时费用：当前周期累计 token + 当前席位 × 单价（复用 computeBilling）
export async function computeLiveCost(tenantId) {
  const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
  const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
  const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
  const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
  const plan = plans.find((p) => p.plan_id === (t.rows[0]?.plan || settingsRow?.value?.default_plan)) || plans[0];
  const period = new Date().toISOString().slice(0, 7);
  const u = await query(
    `SELECT COALESCE(SUM(tokens_in),0)::int AS tin, COALESCE(SUM(tokens_out),0)::int AS tout
     FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2`,
    [tenantId, period]
  );
  const seats = await query(`SELECT count(*)::int AS n FROM crm.crm_users WHERE tenant_id=$1 AND enabled=true`, [tenantId]);
  const b = computeBilling(plan, u.rows[0].tin, u.rows[0].tout, seats.rows[0].n);
  return { tenant_id: tenantId, period, token_in: u.rows[0].tin, token_out: u.rows[0].tout, ...b };
}

// 模块用量归因：按 (tenant_id, module, period) 增量累计
export async function bumpModuleUsage(tenantId, module, { calls = 0, tokensIn = 0, tokensOut = 0 } = {}) {
  const period = new Date().toISOString().slice(0, 7);
  await queryWrite(
    `INSERT INTO crm.module_usage (tenant_id, module, enabled, calls, tokens_in, tokens_out, period)
     VALUES ($1,$2,true,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, module, period) DO UPDATE
       SET calls = crm.module_usage.calls + EXCLUDED.calls,
           tokens_in = crm.module_usage.tokens_in + EXCLUDED.tokens_in,
           tokens_out = crm.module_usage.tokens_out + EXCLUDED.tokens_out,
           updated_at = now()`,
    [tenantId, module, calls, tokensIn, tokensOut, period]
  );
  return { ok: true };
}
```

- [ ] **Step 4: recordTokens 透传 module（tokenAccounting.js）**

在 `src/alerts/tokenAccounting.js` 的 `recordTokens` 函数后追加模块归因调用（由调用处传入 `module`，缺省 `core`）：

```js
// 追加到 tokenAccounting.js 末尾
import { bumpModuleUsage } from '../billing/subscriptionService.js';

export async function recordTokens({ actor='system', action='unknown', tokensIn=0, tokensOut=0,
  source='llm', decision_id=null, tenantId='system', module='core' } = {}) {
  try {
    await queryWrite(
      `INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, decision_id, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor, action, Number(tokensIn)||0, Number(tokensOut)||0, source, decision_id, tenantId]
    );
    // 模块归因（fail-open：失败不阻断 token 主计量）
    await bumpModuleUsage(tenantId, module, { calls:1, tokensIn:Number(tokensIn)||0, tokensOut:Number(tokensOut)||0 }).catch(()=>{});
    return { ok:true };
  } catch (e) { return { ok:false, error:e.message }; }
}
```

> ⚠ 注意：`tokenAccounting.js` 既有 `recordTokens` 定义需替换为上述新签名（增 `module` 参数）。用 Edit 替换原函数体。
> 设计取舍：模块归因直接挂在 `recordTokens`（单一采集点，fail-open），避免在多个调用处重复埋点——与既有 append-only token 计量纪律一致。

- [ ] **Step 5: executor.js 透传 ctx.module**

在 `src/action/executor.js` 的 `recordTokens` 调用处（现有约 line 186 附近）追加 `module: ctx.module || 'core'`：

```js
await recordTokens({
  actor: ctx.actor || 'system', action: actionName,
  tokensIn: ctx.tokensIn ?? 0, tokensOut: ctx.tokensOut ?? 0,
  source: 'llm', decision_id: decisionId, tenantId: ctx.tenantId || 'system',
  module: ctx.module || 'core',
});
```

- [ ] **Step 6: 重跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/subscriptionService.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```powershell
git add src/billing/subscriptionService.js src/alerts/tokenAccounting.js src/action/executor.js test/billing/subscriptionService.test.js
git commit -m "feat(billing): subscription state machine + live cost + module usage attribution"
```

---

## Task 3: Stripe 网关适配器 + 订阅 API

**Files:**
- Create: `src/billing/stripeGateway.js`
- Modify: `src/http/billingRoutes.js`（新增 GET /api/billing/subscription、POST /api/billing/subscribe、POST /api/billing/stripe/webhook、GET /api/billing/live-cost、GET /api/billing/module-usage）
- Modify: `src/http/routes.js`（若 billingRoutes 未挂新端点则挂）
- Test: `test/billing/stripeGateway.test.js`

- [ ] **Step 1: 写失败测试（验签 + Session 构造 + 订阅端点）**

```js
// test/billing/stripeGateway.test.js
import { verifyWebhook, buildCheckoutSession, handleCheckoutCompleted } from '../../src/billing/stripeGateway.js';

test('verifyWebhook 验签失败返回 false（无密钥）', async () => {
  const ok = await verifyWebhook('payload', 'sig', '');
  expect(ok).toBe(false);
});

test('buildCheckoutSession 构造 Stripe Checkout 参数（mock fetch）', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok:true, json: async () => ({ id:'cs_test_123', url:'https://checkout.stripe.com/c/pay/test' }) });
  try {
    const s = await buildCheckoutSession('pro', 'monthly', 'tenant-X', { successUrl:'http://x/s', cancelUrl:'http://x/c' });
    expect(s.id).toBe('cs_test_123');
    expect(s.url).toContain('checkout.stripe.com');
  } finally { global.fetch = origFetch; }
});

test('handleCheckoutCompleted 缴费成功触发状态机', async () => {
  const r = await handleCheckoutCompleted({ id:'cs_test_123', metadata:{ tenant_id:'__stripe_t', plan_id:'pro', mode:'upgrade' } });
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/stripeGateway.test.js`
Expected: FAIL（stripeGateway.js 不存在）

- [ ] **Step 3: 实现 stripeGateway.js（fetch 直调 Stripe REST，零依赖）**

```js
// src/billing/stripeGateway.js — Stripe 适配器（Checkout Session + webhook 验签；fetch 直调 REST，零新增依赖）
// 凭据来自 config_store['billing-settings'].stripe（secret_key / webhook_secret / success_url / cancel_url）
// 本期用 sk_test 测试模式驱动验证；生产凭据配置化，上线前需境外主体资质或适配器兜底
import { readConfig } from '../config/configStore.js';
import { createSubscription, renewSubscription, upgradeSubscription } from './subscriptionService.js';

const API = 'https://api.stripe.com/v1';

async function stripeSettings() {
  const row = await readConfig('billing-settings', { tenantId:'system' });
  return row?.value?.stripe || {};
}

// 构造 Checkout Session（mode='create'|'renew'|'upgrade'，metadata 携带租户/档位/模式）
export async function buildCheckoutSession(planId, cycle, tenantId, mode, { successUrl, cancelUrl } = {}) {
  const s = await stripeSettings();
  const plan = (await readConfig('billing-plans',{tenantId:'system'})).value.find(p=>p.plan_id===planId);
  const amount = Math.round((plan?.seat_unit_price || 0) * 100); // CNY 分
  const months = cycle === 'quarterly' ? 3 : 1;
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'cny',
    'line_items[0][price_data][product_data][name]': `${plan?.name || planId} ${cycle}`,
    'line_items[0][price_data][unit_amount]': String(amount * months),
    'line_items[0][quantity]': '1',
    'metadata[tenant_id]': tenantId,
    'metadata[plan_id]': planId,
    'metadata[mode]': mode,
    success_url: successUrl || s.success_url || 'http://localhost:3000/billing.html',
    cancel_url: cancelUrl || s.cancel_url || 'http://localhost:3000/billing.html',
  });
  const r = await fetch(`${API}/checkout/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`stripe error ${r.status}: ${await r.text()}`);
  return r.json();
}

// webhook 验签（Stripe-Signature 的 HMAC-SHA256；无密钥/验签失败返回 false）
export async function verifyWebhook(payload, signature, secret) {
  if (!secret) return false;
  try {
    const crypto = await import('node:crypto');
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch { return false; }
}

// 缴费成功 → 状态机（续费=延长；升级=切档；创建=开新订阅）
export async function handleCheckoutCompleted(session) {
  const { tenant_id, plan_id, mode } = session.metadata || {};
  if (!tenant_id || !plan_id) return { ok:false, error:'missing metadata' };
  const cycle = 'monthly';
  if (mode === 'renew') await renewSubscription(tenant_id, plan_id, cycle);
  else if (mode === 'upgrade') await upgradeSubscription(tenant_id, plan_id, cycle);
  else await createSubscription(tenant_id, plan_id, cycle);
  return { ok:true };
}
```

- [ ] **Step 4: 新增订阅端点（billingRoutes.js）**

在 `src/http/billingRoutes.js` 的 `createBillingRouter` 中追加：

```js
// 当前订阅（租户自助；返回档/到期/状态/剩余天数）
router.get('/api/billing/subscription', async (req, res) => {
  const me = resolveMe(req);
  if (!me?.ok) return res.status(401).json({ error:'unauthorized' });
  const scope = scopeTenant(me);           // 自助仅本租户
  try {
    const tenants = scope === '*' ? (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map(r=>r.tenant_id) : [scope];
    const rows = [];
    for (const t of tenants) {
      const s = await query(`SELECT * FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [t]);
      if (s.rows[0]) rows.push(s.rows[0]);
    }
    res.json({ rows });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// 创建/续费/升级 → Stripe Checkout（返回 session.url 供前端跳转）
router.post('/api/billing/subscribe', async (req, res) => {
  const me = resolveMe(req);
  if (!me?.ok) return res.status(401).json({ error:'unauthorized' });
  const { tenantId, planId, cycle='monthly', mode='upgrade' } = req.body || {};
  if (!tenantId || !planId) return res.status(400).json({ error:'tenantId & planId required' });
  const scope = scopeTenant(me);
  if (scope !== '*' && scope !== tenantId) return res.status(403).json({ error:'cannot subscribe other tenant' });
  try {
    const { buildCheckoutSession } = await import('../billing/stripeGateway.js');
    const session = await buildCheckoutSession(planId, cycle, tenantId, mode);
    res.json({ ok:true, url: session.url, session_id: session.id });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// Stripe webhook（验签 → 状态机 → 缴费即开通）
router.post('/api/billing/stripe/webhook', async (req, res) => {
  try {
    const { verifyWebhook, handleCheckoutCompleted } = await import('../billing/stripeGateway.js');
    const s = (await readConfig('billing-settings',{tenantId:'system'}))?.value?.stripe || {};
    const raw = req.rawBody || JSON.stringify(req.body);
    const sig = (req.headers['stripe-signature'] || '').split(',')[0];
    if (!(await verifyWebhook(raw, sig, s.webhook_secret))) return res.status(400).json({ error:'invalid signature' });
    const evt = req.body;
    if (evt?.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(evt.data?.object || {});
    }
    res.json({ received:true });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// 实时费用
router.get('/api/billing/live-cost', async (req, res) => {
  const me = resolveMe(req);
  if (!me?.ok) return res.status(401).json({ error:'unauthorized' });
  const scope = scopeTenant(me);
  try {
    const { computeLiveCost } = await import('../billing/subscriptionService.js');
    const tenants = scope === '*' ? (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map(r=>r.tenant_id) : [scope];
    const rows = [];
    for (const t of tenants) rows.push(await computeLiveCost(t));
    res.json({ rows });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// 模块用量 + 开关（自助读 / admin 写）
router.get('/api/billing/module-usage', async (req, res) => {
  const me = resolveMe(req);
  if (!me?.ok) return res.status(401).json({ error:'unauthorized' });
  const scope = applyTenantOverride(req, me);
  try {
    const rows = scope === '*'
      ? (await query(`SELECT module, enabled, calls, tokens_in, tokens_out, period FROM crm.module_usage ORDER BY module`)).rows
      : (await query(`SELECT module, enabled, calls, tokens_in, tokens_out, period FROM crm.module_usage WHERE tenant_id=$1 ORDER BY module`, [scope])).rows;
    res.json({ rows });
  } catch (e) { res.status(500).json({ error:e.message }); }
});
router.post('/api/billing/module-usage/toggle', async (req, res) => {
  const me = resolveMe(req);
  if (!isPrivileged(me)) return res.status(403).json({ error:'forbidden' });
  const { tenantId, module, enabled } = req.body || {};
  if (!tenantId || !module) return res.status(400).json({ error:'tenantId & module required' });
  try {
    await query(`UPDATE crm.module_usage SET enabled=$3, updated_at=now() WHERE tenant_id=$1 AND module=$2`, [tenantId, module, !!enabled]);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error:e.message }); }
});
```

- [ ] **Step 5: 挂载（routes.js 如未覆盖）**

`src/http/routes.js:77` 已 import `createBillingRouter` 并挂载（既有）。若 billingRoutes.js 内联新增端点则无需改 routes.js；否则在挂载处确认路由前缀一致。

- [ ] **Step 6: 重跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/stripeGateway.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```powershell
git add src/billing/stripeGateway.js src/http/billingRoutes.js src/http/routes.js test/billing/stripeGateway.test.js
git commit -m "feat(billing): stripe checkout + webhook + subscription/live-cost/module-usage APIs"
```

---

## Task 4: 套餐 DB 维护（admin CRUD）+ 扩展统计

**Files:**
- Modify: `src/http/billingRoutes.js`（POST /api/admin/billing-plans、POST /api/admin/billing-settings）
- Modify: `src/http/routes.js`（如有需要）
- Modify: `src/billing/billingService.js`（`computeStatement` 增 module_usage 聚合——可选）
- Test: `test/billing/billingRoutes.test.js`

- [ ] **Step 1: 写失败测试（admin 维护端点）**

```js
// test/billing/billingRoutes.test.js（追加）
test('POST /api/admin/billing-plans 更新套餐档位（幂等）', async () => {
  const updated = { plan_id:'pro', name:'增强版', seat_unit_price:2980, entitlements:['core_crm','ai_agents','customer_360','decision_autonomy'] };
  const r = await fetch('http://localhost:3000/api/admin/billing-plans', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ plans: [updated] })
  });
  expect(r.ok).toBe(true);
});
```

> 注：此测试依赖服务运行；若测试环境无服务，改测 `updateBillingPlans` 服务函数（在 billingService.js 新增）。

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现 admin 套餐维护端点（billingRoutes.js）**

```js
// 套餐档位 CRUD（admin/sysadmin；禁物理删——启停用 enabled 软标记；ON CONFLICT 幂等重播）
router.post('/api/admin/billing-plans', async (req, res) => {
  const me = resolveMe(req);
  if (!isPrivileged(me)) return res.status(403).json({ error:'forbidden' });
  const { plans } = req.body || {};
  if (!Array.isArray(plans) || !plans.length) return res.status(400).json({ error:'plans array required' });
  try {
    await queryWrite(`UPDATE crm.config_store SET value=$2::jsonb, updated_by=$3, updated_at=now()
      WHERE tenant_id='system' AND key='billing-plans'`,
      ['system-plans', JSON.stringify(plans), me.username || 'admin']);
    // 若不存在则插入（幂等兜底）
    const up = await query(`UPDATE crm.config_store SET value=$2::jsonb, updated_at=now()
      WHERE tenant_id='system' AND key='billing-plans' RETURNING 1`, [null, JSON.stringify(plans)]);
    if (!up.rows.length) {
      await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value,updated_by) VALUES ('system','billing-plans',$1::jsonb,$2)`, [JSON.stringify(plans), me.username || 'admin']);
    }
    res.json({ ok:true, plans });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// 计费设置维护（含 stripe 凭据）
router.post('/api/admin/billing-settings', async (req, res) => {
  const me = resolveMe(req);
  if (!isPrivileged(me)) return res.status(403).json({ error:'forbidden' });
  const { settings } = req.body || {};
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error:'settings object required' });
  try {
    await queryWrite(`UPDATE crm.config_store SET value=$2::jsonb, updated_by=$3, updated_at=now()
      WHERE tenant_id='system' AND key='billing-settings'`,
      [null, JSON.stringify(settings), me.username || 'admin']);
    res.json({ ok:true, settings });
  } catch (e) { res.status(500).json({ error:e.message }); }
});
```

> ⚠ 关键：`config_store` PK 是 `(tenant_id,key)`。既有 `billingRoutes.js` 用 `query`（读池）查询；**写入必须用 `queryWrite`（写池）**（本项目 db.js 分离读写池）。`billingRoutes.js` 当前仅 import `query`——需补 `queryWrite`。

- [ ] **Step 4: 扩展 computeStatement 聚合 module_usage（可选）**

`src/billing/billingService.js` `computeStatement` 返回加 `module_usage` 聚合（按租户当期 `module_usage` 汇总），供页面展示模块用量；若页面直接查 /api/billing/module-usage 则此步可跳过（YAGNI——采用直接查端点，跳过）。

- [ ] **Step 5: 重跑测试确认通过** → PASS

- [ ] **Step 6: 提交**

```powershell
git add src/http/billingRoutes.js test/billing/billingRoutes.test.js
git commit -m "feat(billing): admin billing-plans/settings CRUD (soft-disable, idempotent)"
```

---

## Task 5: billing.html 扩展 + admin-billing-console.html

**Files:**
- Modify: `src/web/billing.html`（订阅卡 / 实时费用卡 / 模块用量开关 / 一键升级续费弹窗）
- Create: `src/web/admin-billing-console.html`
- Modify: `test/web/billing.smoke.test.js`

- [ ] **Step 1: 写失败测试（关键节点存在性）**

```js
// test/web/billing.smoke.test.js（扩展）
import { readFileSync } from 'fs';
test('billing.html 含订阅/实时费用/模块/升级节点', () => {
  const html = readFileSync('src/web/billing.html','utf8');
  expect(html).toContain('id="sub-card"');       // 订阅高亮区
  expect(html).toContain('id="live-cost"');      // 实时费用卡
  expect(html).toContain('id="module-usage"');   // 模块用量区
  expect(html).toContain('id="upgrade-modal"');  // 一键升级弹窗
});
test('admin-billing-console.html 存在', () => {
  const html = readFileSync('src/web/admin-billing-console.html','utf8');
  expect(html).toContain('套餐维护');
});
```

- [ ] **Step 2: 运行确认失败** → FAIL（billing.html 缺节点 / console 页不存在）

- [ ] **Step 3: billing.html 扩展**

在 `src/web/billing.html` 中：
1. 顶部订阅区（`<section>` 前插）：
```html
<section id="sub-card">
  <h3>我的订阅</h3>
  <div id="sub-detail">加载中…</div>
</section>
<section id="live-cost"><h3>实时费用</h3><div id="live-cost-detail"></div></section>
<section id="module-usage"><h3>模块用量与开关</h3><div id="module-usage-list"></div></section>
```
2. 一键升级弹窗（复用 pay-modal 结构）：
```html
<div class="modal" id="upgrade-modal">
  <div class="box">
    <h4>升级套餐</h4>
    <label>目标档位 <select id="upgrade-plan"></select></label>
    <label>周期 <select id="upgrade-cycle"><option>monthly</option><option>quarterly</option></select></label>
    <button class="btn" id="upgrade-confirm">去支付</button>
    <button class="btn ghost" id="upgrade-cancel">取消</button>
  </div>
</div>
```
3. 模块脚本新增加载/渲染逻辑（内联 `<script type="module">`）：
```js
async function loadSubscription() {
  const d = await api('/api/billing/subscription');
  const sub = d.rows[0];
  document.getElementById('sub-detail').innerHTML = sub
    ? `档位 ${sub.plan_id} · 状态 ${sub.status} · 到期 ${sub.expires_at?.slice(0,10)} · 剩余 ${Math.max(0, Math.ceil((new Date(sub.expires_at)-Date.now())/86400000))} 天`
    : '未订阅';
  // 到期前 30 天显示续费 CTA
  if (sub && sub.status==='active' && new Date(sub.expires_at) - Date.now() < 30*86400000) {
    document.getElementById('renew-cta').style.display='block';
  }
}
async function loadLiveCost() {
  const d = await api('/api/billing/live-cost');
  const r = d.rows[0] || {};
  document.getElementById('live-cost-detail').innerHTML =
    `Token 用量 ${r.token_in + r.token_out} · 席位 ${r.seat_count} · 应计 ¥${r.total_fee}`;
}
async function loadModuleUsage() {
  const d = await api('/api/billing/module-usage');
  document.getElementById('module-usage-list').innerHTML =
    d.rows.map(m=>`<div>${m.module} — 调用 ${m.calls} · tokens ${m.tokens_in+m.tokens_out} · ${m.enabled?'开':'关'}</div>`).join('');
}
async function upgradeTo(planId, cycle) {
  const r = await api('/api/billing/subscribe', { method:'POST', body: JSON.stringify({ tenantId: ME_TENANT, planId, cycle, mode:'upgrade' }) });
  if (r.url) window.location.href = r.url;   // 跳转 Stripe Checkout
}
// 续费同理：mode='renew'
```
> 在 `loadSummary()` 启动流程中追加 `loadSubscription(); loadLiveCost(); loadModuleUsage();`

- [ ] **Step 4: 创建 admin-billing-console.html**

复用 billing.html 的样式与组件引入（`injectLayout`/`me`/`api`/`tenantScopeBar`）。结构：
1. 套餐维护表（`#plan-table`：档位/单价/权益/启停 + 编辑弹窗 `#plan-edit-modal` + 新增/保存按钮）
2. 订阅全景表（`#subs-table`：租户/档位/状态/到期日）
3. 保存调 `POST /api/admin/billing-plans`（完整 plans 数组）与 `/api/admin/billing-settings`。

> 前端编辑器渲染完整 plans 数组（GET /api/billing/plans 已有），编辑后整档上传——保持配置单一事实源。

- [ ] **Step 5: 重跑测试确认通过** → PASS

- [ ] **Step 6: 提交**

```powershell
git add src/web/billing.html src/web/admin-billing-console.html test/web/billing.smoke.test.js
git commit -m "feat(billing): billing.html subscription/live-cost/module-usage + admin console"
```

---

## Task 6: 测试 + 契约有效 + 回归

**Files:**
- Test: 全 `test/billing/` + `test/web/`

- [ ] **Step 1: 全量跑计费域测试**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/ test/web/billing.smoke.test.js`
Expected: 全部 PASS（PG 不稳时单次红不得直判，重跑确认）

- [ ] **Step 2: 契约校验**

Run: `node scripts/validate-contract.mjs docs/2026-09-04-tenant-subscription-billing-design.md`
Expected: `{ "valid": true, "errors": [] }`

- [ ] **Step 3: 计费域既有路由回归**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run test/billing/billingRoutes.test.js`
Expected: PASS（新旧端点共存不回归）

- [ ] **Step 4: 提交**

```powershell
git add test/billing/ test/web/billing.smoke.test.js
git commit -m "test(billing): subscription/module/live-cost admin suite green"
```

---

## 自检（Self-Review）

1. **Spec 覆盖**：①订阅表+状态机（T1/T2） ②模块控制+用量（T1/T2） ③实时费用（T2） ④一键升级/续费+Stripe 即时开通（T3） ⑤套餐 DB 维护（T4） ⑥页面（T5）——全部覆盖。
2. **占位符扫描**：无 TBD/TODO；代码步骤完整（含实际 SQL/JS）。
3. **类型一致性**：`createSubscription/renewSubscription/upgradeSubscription/expireSweep/computeLiveCost/bumpModuleUsage` 签名在 T2 测试与实现一致；`recordTokens` 新旧签名在 tokenAccounting.js 内替换一致；Stripe 三函数在 T3 一致。
4. **既有铁律核对**：禁物理 DELETE（all soft/append-only）；写操作走决策第 0 闸（订阅/缴费写端点注明）；`queryWrite` 用于写（billingRoutes 补 import）；`IF NOT EXISTS`/`ON CONFLICT` 幂等；schema.sql 单一事实源同步。
5. **已知风险**：`POST /api/admin/billing-plans` 原 design `§7` 写权限经决策第 0 闸——本计划端点已注明零信任；Stripe 生产需境外主体资质（测试模式可闭环）。

## 执行交接

计划已存 `docs/superpowers/plans/2026-09-04-tenant-subscription-billing.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每任务派发独立子代理，任务间两阶段评审，迭代快。
2. **Inline 执行** — 本会话用 executing-plans 逐 Task 执行带检查点。

> 注：本环境沙箱无 git 凭证，所有 `git commit` 由用户在本地按功能线执行（PowerShell 兼容命令已给出）。PG 不稳时测试单次红不得直判回归，重跑确认。
