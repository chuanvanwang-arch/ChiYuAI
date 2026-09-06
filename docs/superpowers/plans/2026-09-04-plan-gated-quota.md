# 套餐驱动强制闸门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 `config_store['billing-plans']` 为唯一真相源，落地三道套餐驱动强制闸门——免费租户用户数硬封顶、功能模块前端导航门禁、Token 超额（免费档硬封顶 / 付费档计费+安全上限），做到"按套餐内容控制、收费清晰"。

**Architecture:** 复用既有 `getPlan`（billingService）、`resolveEntitlements`（entitlements.js，第 1.7 闸已用）、上一轮 `tokenQuota`（三级聚合）。新增 `seatPolicy.js`（席位闸）、`quotaGate.js`（Token 闸），均在已有 metering 上下文（callChat/embed）与用户创建入口（selfRegister/userManagement）注入；前端经 `menuFor(role, ents)` 过滤菜单 + 新端点 `/api/billing/entitlements`。全部配置驱动、禁硬编码。

**Tech Stack:** Node22 ESM + Express4 + PostgreSQL(pg) + vitest3。运行时：`C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`。测试库 `crm_native_test`（PGDATABASE 强制）。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `db/seed-billing-config.sql` | 每档补 `token_overage_mode` + `token_hard_cap`（幂等） |
| `src/billing/billingService.js` | 导出既有 `getPlan`（供 seatPolicy/quotaGate 复用） |
| `src/billing/seatPolicy.js`（新） | 席位闸 `checkSeatLimit` + `SeatLimitError` |
| `src/http/selfRegister.js` | 注入席位闸（新增成员路径） |
| `src/portal/userManagement.js` | 注入席位闸（admin 建用户，带 tenantId） |
| `src/billing/quotaGate.js`（新） | Token 闸 `enforceTokenQuota` + `TokenQuotaError` |
| `src/llm/client.js` | `callChat` 预检 + `makeThink` 透传 quota 错误 |
| `src/llm/embeddingClient.js` | `embed` 预检 + 透传 quota 错误 |
| `src/portal/layoutMenu.js` | 菜单项加 `requiresEntitlement`；`menuFor(role, ents)` 过滤 |
| `src/http/billingRoutes.js` | 新增 `GET /api/billing/entitlements` |
| `src/web/billing.html` | 新增"模块解锁状态"对照区 |
| 测试 | `test/billing/planQuotaFields.test.js`、`test/billing/seatPolicy.test.js`、`test/billing/quotaGate.test.js`、`test/http/entitlementsRoute.test.js`、`test/web/layoutMenu.test.js` |

---

### Task 1: 配置种子新增 token_overage_mode / token_hard_cap + 导出 getPlan

**Files:**
- Modify: `db/seed-billing-config.sql`
- Modify: `src/billing/billingService.js:9`（`getPlan` 加 `export`）
- Test: `test/billing/planQuotaFields.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/billing/planQuotaFields.test.js
import { readFileSync } from 'fs';
import { expect, test } from 'vitest';
import { getPlan } from '../../src/billing/billingService.js';
import { queryWrite } from '../../src/db.js';

test('seed 文件含 token_overage_mode / token_hard_cap 字段', () => {
  const sql = readFileSync('db/seed-billing-config.sql', 'utf8');
  expect(sql).toContain('token_overage_mode');
  expect(sql).toContain('token_hard_cap');
});

test('getPlan 返回 token_overage_mode / token_hard_cap', async () => {
  const plans = [
    { plan_id: 'free', name: '免费版', base_fee: 0, included_seats: 3, seat_unit_price: 0, included_tokens: 50000, token_overage_unit_price: 0.03, token_overage_mode: 'block', token_hard_cap: null, entitlements: ['core_crm'] },
    { plan_id: 'pro', name: '增强版', base_fee: 0, included_seats: 0, seat_unit_price: 2980, included_tokens: 1000000, token_overage_unit_price: 0.02, token_overage_mode: 'bill', token_hard_cap: 3000000, entitlements: ['core_crm', 'decision_autonomy'] },
  ];
  await queryWrite(`INSERT INTO crm.config_store (tenant_id, key, value, updated_by) VALUES ('system','billing-plans',$1::jsonb,'test') ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(plans)]);
  const f = await getPlan('any-tenant');
  expect(f.token_overage_mode).toBe('block');
  expect(f.token_hard_cap).toBeNull();
  const p = await getPlan('pro-tenant'); // plan 缺省回退首档，此处用 tenant 无 plan → default free；直接断言字段存在
  expect(p).toHaveProperty('token_overage_mode');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /d/system/CRM-ai-native
PGDATABASE=crm_native_test C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe node_modules/vitest/vitest.mjs run test/billing/planQuotaFields.test.js
```
预期：FAIL（`getPlan` 未导出 / seed 无新字段）。

- [ ] **Step 3: 实现——导出 getPlan**

`src/billing/billingService.js:9` 将 `async function getPlan(tenantId) {` 改为 `export async function getPlan(tenantId) {`。

- [ ] **Step 4: 实现——seed 每档补两字段**

`db/seed-billing-config.sql` 的 `billing-plans` JSON 每档加：
- `free`: `"token_overage_mode":"block","token_hard_cap":null`
- `starter`: `"token_overage_mode":"bill","token_hard_cap":600000`
- `pro`: `"token_overage_mode":"bill","token_hard_cap":3000000`
- `enterprise`: `"token_overage_mode":"bill","token_hard_cap":15000000`
- `local_flagship`: `"token_overage_mode":"bill","token_hard_cap":null`

（字段位置：放在 `token_overage_unit_price` 之后、`currency` 之前。保持 JSON 合法、单引号 SQL 字符串内双引号。）

- [ ] **Step 5: 重播 seed 到两库（生产 + 测试）**

新建 `_reseed_billing.mjs`（用后删除）：
```js
import { readFileSync } from 'fs';
import { queryWrite } from './src/db.js';
const sql = readFileSync('db/seed-billing-config.sql', 'utf8');
for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) await queryWrite(s); }
console.log('reseed done');
```
```bash
cd /d/system/CRM-ai-native
PGPASSWORD=agent2b PGDATABASE=crm_native C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe _reseed_billing.mjs
PGPASSWORD=agent2b PGDATABASE=crm_native_test C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe _reseed_billing.mjs
rm -f _reseed_billing.mjs
```

- [ ] **Step 6: 运行测试确认通过**

```bash
PGDATABASE=crm_native_test C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe node_modules/vitest/vitest.mjs run test/billing/planQuotaFields.test.js
```
预期：PASS。

- [ ] **Step 7: 提交**

```bash
git add db/seed-billing-config.sql src/billing/billingService.js test/billing/planQuotaFields.test.js
git commit -m "feat(billing): 套餐补 token_overage_mode/token_hard_cap + 导出 getPlan"
```

---

### Task 2: 席位硬封顶 seatPolicy + 注入 selfRegister/userManagement

**Files:**
- Create: `src/billing/seatPolicy.js`
- Modify: `src/http/selfRegister.js:98-111`
- Modify: `src/portal/userManagement.js:160-167, 240-259`
- Test: `test/billing/seatPolicy.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/billing/seatPolicy.test.js
import { expect, test, beforeAll } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { checkSeatLimit } from '../../src/billing/seatPolicy.js';

const T = '__seat_t';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'seat','active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  await queryWrite(`DELETE FROM crm.crm_users WHERE tenant_id=$1`, [T]);
  for (let i = 0; i < 3; i++) await queryWrite(`INSERT INTO crm.crm_users (username, password_hash, role, tenant_id, enabled) VALUES ($1,'x','sales',$2,true)`, [`__su${i}`, T]);
});

test('免费档第4用户被拒（block 模式）', async () => {
  const r = await checkSeatLimit(T);
  expect(r.ok).toBe(false);
  expect(r.mode).toBe('block');
});

test('付费档（seat_unit_price>0）不封顶', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='pro' WHERE tenant_id=$1`, [T]);
  const r = await checkSeatLimit(T);
  expect(r.ok).toBe(true);
  expect(r.mode).toBe('bill');
});

test('unlimited（-1）不限制', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='local_flagship' WHERE tenant_id=$1`, [T]);
  const r = await checkSeatLimit(T);
  expect(r.mode).toBe('unlimited');
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**（getPlan 已导出；seatPolicy 不存在 → 导入失败 FAIL）

- [ ] **Step 3: 实现 seatPolicy.js**

```js
// src/billing/seatPolicy.js — 席位（用户数）硬封顶闸
import { query } from '../db.js';
import { getPlan } from './billingService.js';

export class SeatLimitError extends Error {
  constructor(message) { super(message); this.name = 'SeatLimitError'; this.isSeat = true; }
}

async function activeSeats(tenantId) {
  const r = await query(`SELECT count(*)::int AS n FROM crm.crm_users WHERE tenant_id=$1 AND enabled = true`, [tenantId]);
  return r.rows[0].n;
}

// 返回 { ok, mode:'unlimited'|'bill'|'block', included, used, remaining, error? }
export async function checkSeatLimit(tenantId) {
  const plan = await getPlan(tenantId);
  const included = Number(plan.included_seats);
  const price = Number(plan.seat_unit_price) || 0;
  const used = await activeSeats(tenantId);
  if (included === -1) return { ok: true, mode: 'unlimited', included, used, remaining: null };
  if (price > 0) return { ok: true, mode: 'bill', included, used, remaining: null }; // 按席位计费，不封顶
  const remaining = Math.max(0, included - used);
  if (used >= included) {
    return { ok: false, mode: 'block', included, used, remaining: 0, error: `当前套餐席位已满（${used}/${included}），请升级套餐以添加更多成员` };
  }
  return { ok: true, mode: 'block', included, used, remaining };
}
```

- [ ] **Step 4: 注入 selfRegister.js（新增成员路径）**

`src/http/selfRegister.js` 在 `const { tenantId, isNew } = await resolveTenantByCompany(companyName);`（line 98）之后、`const pw = ...`（line 104）之前插入：
```js
  // 席位闸：新租户首 admin 不拦（其本身是首个席位）；已有租户新增成员才拦
  if (!isNew) {
    const { checkSeatLimit } = await import('../billing/seatPolicy.js');
    const seat = await checkSeatLimit(tenantId);
    if (!seat.ok) return { ok: false, status: 402, error: seat.error };
  }
```

- [ ] **Step 5: 注入 userManagement.js（admin 建用户，带 tenantId）**

`src/portal/userManagement.js` `defaultDeps.createUser`（line 160）改签名为 `(username, passwordHash, role, displayName, orgId, tenantId)` 并在 INSERT 前加闸、INSERT 带入 tenant_id：
```js
  createUser: async (username, passwordHash, role, displayName, orgId, tenantId) => {
    if (tenantId) {
      const { checkSeatLimit } = await import('../../billing/seatPolicy.js');
      const seat = await checkSeatLimit(tenantId);
      if (!seat.ok) throw new (await import('../../billing/seatPolicy.js')).SeatLimitError(seat.error);
    }
    const r = await query(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, enabled, tenant_id)
       VALUES($1, $2, $3, $4, $5, TRUE, $6) RETURNING user_id`,
      [username, passwordHash, role, displayName || username, orgId ?? null, tenantId ?? null]
    );
    return r.rows[0];
  },
```
`handlers.post`（line 247）`D.createUser(...)` 调用补第 6 参 `me.tenantId`：
```js
        const row = await D.createUser(
          v.normalized.username, hash, v.normalized.role, v.normalized.display_name, v.normalized.org_id, me.tenantId
        );
```
`handlers.post` catch（line 256）改为区分 SeatLimitError：
```js
    } catch (e) {
      if (e?.isSeat) return res.status(402).json({ error: e.message });
      res.status(400).json({ error: e.message });
    }
```
顶部 import 区加 `import { SeatLimitError } from '../../billing/seatPolicy.js';`。

- [ ] **Step 6: 运行测试**

```bash
PGDATABASE=crm_native_test C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe node_modules/vitest/vitest.mjs run test/billing/seatPolicy.test.js
```
预期：PASS（3 例）。

- [ ] **Step 7: 提交**

```bash
git add src/billing/seatPolicy.js src/http/selfRegister.js src/portal/userManagement.js test/billing/seatPolicy.test.js
git commit -m "feat(billing): 席位硬封顶 seatPolicy + 注入 selfRegister/userManagement"
```

---

### Task 3: Token 超额闸门 quotaGate + callChat/embed 预检 + 错误透传

**Files:**
- Create: `src/billing/quotaGate.js`
- Modify: `src/llm/client.js:135,185`
- Modify: `src/llm/embeddingClient.js:28,67-70`
- Test: `test/billing/quotaGate.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/billing/quotaGate.test.js
import { expect, test, beforeAll } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { enforceTokenQuota, TokenQuotaError } from '../../src/billing/quotaGate.js';

const T = '__tokg_t';
const period = new Date().toISOString().slice(0, 7);
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'tokg','active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  await queryWrite(`DELETE FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2`, [T, period]);
  await queryWrite(`INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, tenant_id, created_at) VALUES ($1,'a',30000,30000,'llm',$2,now())`, ['alice', T]); // 60000 > 50000
});

test('免费档用量超 included_tokens → 抛 TokenQuotaError', async () => {
  await expect(enforceTokenQuota(T, period)).rejects.toBeInstanceOf(TokenQuotaError);
});

test('付费档（bill 模式）未达安全上限 → 放行', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='pro' WHERE tenant_id=$1`, [T]);
  await expect(enforceTokenQuota(T, period)).resolves.toMatchObject({ ok: true });
});

test('付费档用量超 token_hard_cap → 抛 TokenQuotaError', async () => {
  await queryWrite(`DELETE FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2`, [T, period]);
  await queryWrite(`INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, tenant_id, created_at) VALUES ($1,'a',2000000,2000000,'llm',$2,now())`, ['alice', T]); // 4000000 > 3000000
  await expect(enforceTokenQuota(T, period)).rejects.toBeInstanceOf(TokenQuotaError);
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 quotaGate.js**

```js
// src/billing/quotaGate.js — Token 超额强制闸（配置驱动：block / bill+安全上限）
import { getPlan, tokenQuota } from './billingService.js';

export class TokenQuotaError extends Error {
  constructor(message) { super(message); this.name = 'TokenQuotaError'; this.isQuota = true; }
}

// 调用前预检：免费档硬封顶（used>=included），付费档超安全上限封顶
export async function enforceTokenQuota(tenantId, period) {
  const plan = await getPlan(tenantId);
  const q = await tokenQuota(tenantId, period);
  const mode = plan.token_overage_mode || 'bill';
  const included = Number(plan.included_tokens) || 0;
  const hardCap = plan.token_hard_cap != null
    ? Number(plan.token_hard_cap)
    : (mode === 'bill' ? included * 3 : included);
  if (mode === 'block' && q.used_total >= included) {
    throw new TokenQuotaError(`Token 额度已用完（${q.used_total}/${included}），请升级套餐`);
  }
  if (mode === 'bill' && q.used_total >= hardCap) {
    throw new TokenQuotaError(`本月 Token 用量已达安全上限（${q.used_total}/${hardCap}），请升级套餐或购买加量包`);
  }
  return { ok: true, mode, used: q.used_total, cap: hardCap };
}
```

- [ ] **Step 4: 注入 client.js callChat 预检 + makeThink 透传**

`src/llm/client.js` `callChat`（line 135）在 `const ctrl = new AbortController();` 之前插入：
```js
  if (metering && metering.tenantId) {
    const { enforceTokenQuota } = await import('../billing/quotaGate.js');
    await enforceTokenQuota(metering.tenantId, new Date().toISOString().slice(0, 7));
  }
```
`makeThink`（line 185）catch 改为：
```js
    } catch (e) {
      if (e?.isQuota) return { action: null, params: {}, reasoning: `[额度已用完] ${e.message}`, degraded: true, quotaExceeded: true, degradeReason: 'token_quota' };
      return { action: null, params: {}, reasoning: `[LLM 调用失败，降级] ${e.message}`, degraded: true, degradeReason: 'llm_error' };
    }
```

- [ ] **Step 5: 注入 embeddingClient.js 预检 + 透传**

`src/llm/embeddingClient.js` `embed`（line 28）在 `const cfg = await loadEmbedCfg();` 之后插入：
```js
  if (metering && metering.tenantId) {
    const { enforceTokenQuota } = await import('../billing/quotaGate.js');
    await enforceTokenQuota(metering.tenantId, new Date().toISOString().slice(0, 7));
  }
```
`embed` 的 catch（line 68 `} finally {` 之前）改为：
```js
    } catch (e) {
      if (e?.isQuota) throw e; // quota 错误透传，不被降级吞掉
      throw new Error(`Embedding 失败: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
```

- [ ] **Step 6: 运行测试**

```bash
PGDATABASE=crm_native_test C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe node_modules/vitest/vitest.mjs run test/billing/quotaGate.test.js
```
预期：PASS（3 例）。

- [ ] **Step 7: 提交**

```bash
git add src/billing/quotaGate.js src/llm/client.js src/llm/embeddingClient.js test/billing/quotaGate.test.js
git commit -m "feat(billing): Token 超额闸门 quotaGate + callChat/embed 预检 + 错误透传"
```

---

### Task 4: 前端导航门禁（layoutMenu + /api/billing/entitlements + billing.html）

**Files:**
- Modify: `src/portal/layoutMenu.js`
- Modify: `src/http/billingRoutes.js`（新增端点 + import resolveEntitlements）
- Modify: `src/web/billing.html`（模块解锁状态区）
- Test: `test/web/layoutMenu.test.js`、`test/http/entitlementsRoute.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/web/layoutMenu.test.js
import { expect, test } from 'vitest';
import { FULL_MENU, ADMIN_MENU, menuFor } from '../../src/portal/layoutMenu.js';

test('menuFor 按权益过滤：无 decision_autonomy 租户看不到「报告」', () => {
  const ents = new Set(['core_crm']);
  const items = menuFor('admin', ents);
  const labels = items.map((m) => m.label);
  expect(labels).not.toContain('报告'); // 报告 requiresEntitlement decision_autonomy
});

test('有 decision_autonomy 则可见', () => {
  const items = menuFor('admin', new Set(['core_crm', 'decision_autonomy']));
  expect(items.map((m) => m.label)).toContain('报告');
});
```

```js
// test/http/entitlementsRoute.test.js（DB-free，mock）
import { expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createBillingRouter } from '../../src/http/billingRoutes.js';

vi.mock('../../src/billing/billingService.js', () => ({ /* 不影响本端点 */ }));
vi.mock('../../src/billing/entitlements.js', () => ({ resolveEntitlements: async () => new Set(['core_crm', 'customer_360']) }));
vi.mock('./auth.js', () => ({ resolveMe: () => ({ ok: true, role: 'sales', tenantId: 't1' }) }));
vi.mock('./tenantScope.js', () => ({ applyTenantOverride: (r, m) => m.tenantId || 't1', scopeTenant: (m) => m.tenantId || 't1' }));

test('GET /api/billing/entitlements 返回权益集', async () => {
  const app = express();
  app.use(createBillingRouter());
  await new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const res = await new Promise((r) => http.get(`http://127.0.0.1:${port}/api/billing/entitlements`, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => r({ status: x.statusCode, body: JSON.parse(d) })); }));
        expect(res.status).toBe(200);
        expect(res.body.entitlements).toContain('customer_360');
        srv.close(() => resolve());
      } catch (e) { srv.close(() => reject(e)); }
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 layoutMenu.js**

`FULL_MENU`/`ADMIN_MENU` 给需控项加 `requiresEntitlement`：
```js
  { group: '洞察', label: '账单', href: '/billing.html' }, // 全员可见，无限制
  // ADMIN_MENU:
  { group: '洞察', label: '报告', href: '/sales-decision-monitor', requiresEntitlement: ['decision_autonomy'] },
  { group: '系统', label: '配置中心', href: '/config', requiresEntitlement: ['rbac_advanced', 'industry_config'] },
```
`menuFor` 改为：
```js
export function menuFor(role, ents) {
  const set = ents instanceof Set ? ents : new Set(ents || []);
  const sys = role === 'admin' ? ADMIN_MENU : [];
  const base = FULL_MENU.filter((m) => !m.roles || m.roles.includes(role));
  const visible = (arr) => arr.filter((m) => !m.requiresEntitlement || m.requiresEntitlement.every((e) => set.has(e)));
  return [...visible(base), ...visible(sys)];
}
```
（保持旧 `menuFor(role)` 单参调用兼容：`ents` 缺省为空集 → 仅显示无 `requiresEntitlement` 的项。）

- [ ] **Step 4: 实现 /api/billing/entitlements 端点**

`src/http/billingRoutes.js` import 区加 `import { resolveEntitlements } from '../billing/entitlements.js';`，在 `createBillingRouter()` 内 `return router;` 之前加：
```js
  // 当前租户权益集（前端导航门禁消费）
  router.get('/api/billing/entitlements', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
      const scope = applyTenantOverride(req, me); // 自助=本租户；admin='*' 时取自身租户
      const tid = scope === '*' ? (me.tenantId || 'system') : scope;
      const ents = await resolveEntitlements(tid);
      const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tid]);
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
      const plan = plans.find((p) => p.plan_id === t.rows[0]?.plan) || plans[0] || {};
      res.json({ tenant_id: tid, plan_id: plan.plan_id, plan_name: plan.name, entitlements: [...ents] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 5: 实现 billing.html 模块解锁状态区**

在 `src/web/billing.html`「Token 额度与使用明细」section 之后插入新 section（纯展示 div/table，沿用既有 `api()`/`tenantQuery()`，不引裸控件）：
```html
<section class="card">
  <h3>模块解锁状态</h3>
  <div id="module-status">加载中…</div>
</section>
```
`<script type="module">` 内加：
```js
async function loadModuleStatus() {
  try {
    const d = await api(`/api/billing/entitlements${tenantQuery()}`);
    const all = ['core_crm','ai_agents','customer_360','decision_autonomy','event_automation','approval_flow','llm_config','mcp_access','advanced_reporting','audit_provenance','industry_config','rbac_advanced','memory'];
    const have = new Set(d.entitlements || []);
    document.getElementById('module-status').innerHTML = all.map((k) =>
      `<div class="row"><span>${ENT_LABELS[k]||k}</span><span class="${have.has(k)?'ok':'no'}">${have.has(k)?'✓ 已解锁':'— 未解锁'}</span></div>`
    ).join('');
  } catch (e) { document.getElementById('module-status').textContent = '加载失败：' + e.message; }
}
```
`ENT_LABELS` 已在 billing.html 定义（功能矩阵用）。初始化 IIFE 末尾 `await loadTokenUsage();` 之后加 `await loadModuleStatus();`；`refresh` 回调补 `loadModuleStatus();`。

- [ ] **Step 6: 运行测试 + ui-lint**

```bash
PGDATABASE=crm_native_test C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe node_modules/vitest/vitest.mjs run test/web/layoutMenu.test.js test/http/entitlementsRoute.test.js
C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe scripts/ui-lint.mjs
```
预期：测试 PASS；ui-lint exit 0（新增为纯 div/table，无裸控件）。

- [ ] **Step 7: 提交**

```bash
git add src/portal/layoutMenu.js src/http/billingRoutes.js src/web/billing.html test/web/layoutMenu.test.js test/http/entitlementsRoute.test.js
git commit -m "feat(billing): 前端导航门禁 layoutMenu + /api/billing/entitlements + 模块解锁状态"
```

---

## 自检（writing-plans §Self-Review）

1. **Spec 覆盖**：用户数硬封顶(Task2) ✓；功能模块前端门禁(Task4) ✓；Token 超额(Task3) ✓；配置驱动(Task1 seed 字段) ✓。
2. **占位符扫描**：无 TBD/TODO；每步含完整代码。
3. **类型一致性**：`checkSeatLimit` 返回 `{ok,mode,...}`（Task2 测试对齐）；`enforceTokenQuota` 抛 `TokenQuotaError.isQuota`（Task3 client/embed 透传一致）；`menuFor(role, ents)`（Task4 测试与实现一致）；`getPlan` 在 Task1 导出供 Task2/3 复用。
4. **依赖顺序**：Task1 先导出 `getPlan` + seed 字段 → Task2/3 依赖；Task4 独立但共用 `resolveEntitlements`（已存在）。

## 执行交接

计划已存 `docs/superpowers/plans/2026-09-04-plan-gated-quota.md`。两种执行方式：
1. **子代理驱动（推荐）**——每 Task 派发全新子代理，任务间审查。
2. **Inline 本会话执行**——executing-plans 逐 Task 批处理 + 检查点。
