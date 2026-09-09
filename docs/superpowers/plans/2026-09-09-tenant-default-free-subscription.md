# 新租户开通默认免费档（Default Free Subscription）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新租户经开通入口（`provisionTenant` / `seedTenantDefaults`）自动获得 `free` 订阅（active，3 个月周期），零人工遗漏；已有订阅的租户不覆盖。

**Architecture:** 在 `subscriptionService.js` 新增幂等函数 `ensureDefaultSubscription(tenantId, defaultPlan='free')`；在 `seedTenantDefaults()` 的注册表登记后、return 前调用它（fail-open）。套餐为租户级，账号自动继承，无需账号级改动。关联设计文档：`docs/2026-09-09-tenant-default-free-subscription-design.md`。

**Tech Stack:** Node.js + PostgreSQL（pg，`crm_native_test` 测试库）+ Vitest。写经 `queryWrite`，读经 `query`（来自 `src/db.js`）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/billing/subscriptionService.js` | Modify（末尾追加） | 新增 `ensureDefaultSubscription` 幂等函数 |
| `src/seed/tenantDefaults.js` | Modify（import + 函数内调用） | 开通入口接入默认免费订阅 |
| `test/billing/ensureDefaultSubscription.test.js` | Create | 单元 + 集成测试（幂等 / 已有订阅不覆盖 / 周期） |

---

## Task 1: ensureDefaultSubscription 函数 + 单测（TDD）

**Files:**
- Create: `test/billing/ensureDefaultSubscription.test.js`
- Modify: `src/billing/subscriptionService.js`（末尾追加，约第 76 行后）

- [ ] **Step 1: 写失败测试**

`test/billing/ensureDefaultSubscription.test.js`：
```js
import { describe, it, before, after } from 'vitest';
import assert from 'node:assert';
import { query, queryWrite } from '../../src/db.js';
import { ensureDefaultSubscription } from '../../src/billing/subscriptionService.js';

const T = 'test_free_sub_' + Date.now();
const T_HAS = 'test_free_has_' + Date.now();

before(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT DO NOTHING`, [T]);
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT DO NOTHING`, [T_HAS]);
  // T_HAS 已有 starter 订阅 → 模拟「已定义订阅」
  await queryWrite(
    `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, started_at, expires_at, created_at, updated_at)
     VALUES ($1,'starter','active',now(),now()+interval '1 month',now(),now())`,
    [T_HAS]
  );
});

after(async () => {
  // 仅清理本测试在 crm_native_test 创建的临时数据，绝不触碰生产库
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id IN ($1,$2)`, [T, T_HAS]);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id IN ($1,$2)`, [T, T_HAS]);
});

function diffMonths(expires, started) {
  return Math.round((new Date(expires) - new Date(started)) / (1000 * 60 * 60 * 24 * 30));
}

describe('ensureDefaultSubscription', () => {
  it('无订阅租户 → 插入 free/active 且周期 3 月', async () => {
    const r = await ensureDefaultSubscription(T);
    assert.strictEqual(r.created, true);
    const rows = await query(`SELECT plan_id,status,started_at,expires_at FROM crm.tenant_subscription WHERE tenant_id=$1`, [T]);
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0].plan_id, 'free');
    assert.strictEqual(rows.rows[0].status, 'active');
    assert.ok(Math.abs(diffMonths(rows.rows[0].expires_at, rows.rows[0].started_at) - 3) <= 1, 'expires 应为 started+约3月');
  });

  it('重跑幂等 → 不新增', async () => {
    const r = await ensureDefaultSubscription(T);
    assert.strictEqual(r.created, false);
    const rows = await query(`SELECT count(*)::int n FROM crm.tenant_subscription WHERE tenant_id=$1`, [T]);
    assert.strictEqual(rows.rows[0].n, 1);
  });

  it('已有 starter 订阅 → 不插 free', async () => {
    const r = await ensureDefaultSubscription(T_HAS);
    assert.strictEqual(r.created, false);
    const rows = await query(`SELECT plan_id FROM crm.tenant_subscription WHERE tenant_id=$1`, [T_HAS]);
    assert.ok(rows.rows.every(x => x.plan_id !== 'free'), '不应插入 free 行');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\system\CRM-ai-native && PGDATABASE=crm_native_test npx vitest run test/billing/ensureDefaultSubscription.test.js`

Expected: FAIL —— `ensureDefaultSubscription is not exported` / `is not a function`。

- [ ] **Step 3: 实现函数（追加到 subscriptionService.js 末尾）**

`src/billing/subscriptionService.js` 末尾追加：
```js
// 确保租户拥有默认订阅（缺省 free）。幂等：仅当该租户无任何订阅行时插入。
// 用于新租户开通默认免费档；free 为免费档，直接 active（免支付激活）。
export async function ensureDefaultSubscription(tenantId, defaultPlan = 'free') {
  const has = await query(
    `SELECT 1 FROM crm.tenant_subscription WHERE tenant_id=$1 LIMIT 1`,
    [tenantId]
  );
  if (has.rows.length) return { ok: true, created: false, tenantId };
  const r = await queryWrite(
    `INSERT INTO crm.tenant_subscription
       (tenant_id, plan_id, status, started_at, expires_at, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now() + interval '3 months', now(), now())
     RETURNING *`,
    [tenantId, defaultPlan]
  );
  return { ok: true, created: true, tenantId, row: r.rows[0] };
}
```
（注：`query` / `queryWrite` 已在文件第 2 行 import，无需再引入。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd D:\system\CRM-ai-native && PGDATABASE=crm_native_test npx vitest run test/billing/ensureDefaultSubscription.test.js`

Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
cd D:\system\CRM-ai-native
git add src/billing/subscriptionService.js test/billing/ensureDefaultSubscription.test.js
git commit -m "feat(billing): 新增 ensureDefaultSubscription 幂等函数（缺省 free/active/3月）"
```

---

## Task 2: 在开通入口接入默认免费订阅（TDD）

**Files:**
- Modify: `src/seed/tenantDefaults.js`（顶部 import + `seedTenantDefaults` 内 return 前调用）

- [ ] **Step 1: 写失败测试（验证 provisionTenant 后自动 free）**

在 `test/billing/ensureDefaultSubscription.test.js` 末尾追加：
```js
import { provisionTenant } from '../../src/seed/tenantDefaults.js';

const T_PROV = 'test_free_prov_' + Date.now();

after(async () => {
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id=$1`, [T_PROV]);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [T_PROV]);
});

it('provisionTenant 开通新租户 → 自动获 free/active 订阅', async () => {
  await provisionTenant(T_PROV, { all: true });
  const rows = await query(`SELECT plan_id,status FROM crm.tenant_subscription WHERE tenant_id=$1`, [T_PROV]);
  assert.strictEqual(rows.rows.length, 1);
  assert.strictEqual(rows.rows[0].plan_id, 'free');
  assert.strictEqual(rows.rows[0].status, 'active');
});
```
（注：`after` 中追加删除 `T_PROV`；若已有 `after`，合并删除语句。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\system\CRM-ai-native && PGDATABASE=crm_native_test npx vitest run test/billing/ensureDefaultSubscription.test.js`

Expected: 新增用例 FAIL —— `T_PROV` 无订阅行（provisionTenant 未挂 free）。

- [ ] **Step 3: 接入调用**

`src/seed/tenantDefaults.js` 顶部（第 10 行 `import { queryWrite } from '../../src/db.js';` 之后）追加：
```js
import { ensureDefaultSubscription } from '../../src/billing/subscriptionService.js';
```

在 `seedTenantDefaults` 函数内、第 72 行 `return { ok: true, tenantId: tenant, seededKeys, skippedKeys };` **之前**插入：
```js
  // 默认免费档：新租户开通即获 free 订阅（幂等；已有订阅不覆盖；失败 fail-open 不阻断开通）
  try {
    await ensureDefaultSubscription(tenant);
  } catch {
    // fail-open：订阅写入失败不影响租户开通
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd D:\system\CRM-ai-native && PGDATABASE=crm_native_test npx vitest run test/billing/ensureDefaultSubscription.test.js`

Expected: PASS（全部用例，含 provisionTenant 集成用例）。

- [ ] **Step 5: Commit**

```bash
cd D:\system\CRM-ai-native
git add src/seed/tenantDefaults.js test/billing/ensureDefaultSubscription.test.js
git commit -m "feat(tenant): provisionTenant 接入默认免费订阅（fail-open 幂等）"
```

---

## Task 3: 全量回归 + 交付验证

**Files:** 无新文件；运行回归与端到端核对。

- [ ] **Step 1: 跑订阅相关 + 租户相关既有测试**

Run:
```bash
cd D:\system\CRM-ai-native
PGDATABASE=crm_native_test npx vitest run test/billing test/role/sysadmin-profile.test.js
```
Expected: 全绿（确认未破坏既有订阅/角色逻辑）。

- [ ] **Step 2: 端到端核对（本地 crm_native 库，验证真实开通路径）**

Run:
```bash
cd D:\system\CRM-ai-native
node -e "
const {provisionTenant}=require('./src/seed/tenantDefaults.js');
(async()=>{
  const tid='test_e2e_'+Date.now();
  await provisionTenant(tid,{all:true});
  const {Client}=require('pg');
  const c=new Client({host:'127.0.0.1',port:5433,user:'agent2b',password:'agent2b',database:'crm_native'});
  await c.connect();
  const r=await c.query(\"SELECT plan_id,status,expires_at::date FROM crm.tenant_subscription WHERE tenant_id=\$1\",[tid]);
  console.log('E2E 订阅行:', JSON.stringify(r.rows));
  await c.query('DELETE FROM crm.tenant_subscription WHERE tenant_id=\$1',[tid]);
  await c.query('DELETE FROM crm.tenants WHERE tenant_id=\$1',[tid]);
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1);});
"
```
Expected: 打印 `E2E 订阅行: [{"plan_id":"free","status":"active","expires_at":"<started+3月>"}]`。

- [ ] **Step 3: 幂等与不覆盖核对（确认存量/已定义订阅安全）**

Run:
```bash
cd D:\system\CRM-ai-native
node -e "
const {Client}=require('pg');
(async()=>{
  const c=new Client({host:'127.0.0.1',port:5433,user:'agent2b',password:'agent2b',database:'crm_native'});
  await c.connect();
  const r=await c.query(\"SELECT tenant_id,plan_id,status FROM crm.tenant_subscription ORDER BY tenant_id\");
  console.log('现网订阅:', JSON.stringify(r.rows));
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1);});
"
```
Expected: acme-chem 仍为 starter（未被动）；acme-meddev/consult/consult2/training/demo/insmedi 为 free（上轮手动补齐，本次幂等跳过未重复插行）；无重复行。

- [ ] **Step 4: 提交验证结论（无代码改动则无需 commit）**

说明：本 Task 仅运行验证，无文件改动。若 Step 1-3 全通过，交付完成。

---

## Self-Review Checklist

1. **Spec coverage**：落点（provisionTenant/seedTenantDefaults）✅ Task 2；周期 3 月 ✅ Task 1 实现；状态 active ✅ Task 1；幂等/不覆盖 ✅ Task 1 测试；fail-open ✅ Task 2；单测 ✅ Task 1/2。
2. **Placeholder scan**：无 TBD/TODO；每步含完整代码与命令。
3. **Type consistency**：`ensureDefaultSubscription(tenantId, defaultPlan='free')` 在 Task 1 定义、Task 2 调用、测试引用一致；`query`/`queryWrite` 来源一致（`src/db.js`）。

## 红线提醒
- 写经 `queryWrite`（写池）；绝不裸 SQL 删业务数据。
- 测试 teardown 的 `DELETE` 仅作用于 `crm_native_test` 本测试创建的临时租户，**生产库绝对禁 DELETE**。
- 每 Task 一 commit；显式路径 `git add`，禁 `git add -A`，禁 `--no-verify`。
