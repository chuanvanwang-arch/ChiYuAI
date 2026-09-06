# Phase 2 租户隔离收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收口 3 处配置面伪隔离——#3 seven-dim 写路径补 tenantId、#4 alert-rule 租户行懒克隆+播种、配置中心 id35/39/44/36 标签失真修正。

**Architecture:** 全部复用 Phase 1 验证的「懒克隆 system 模板 → 租户独立落盘」范式（对齐 business-tier/approval-flow）。W1 仅透传 `scopeOf(me)` 进既有已支持租户的 `updateScenario` 内核；W2 在 `persist` 写前克隆 system 行 + 新增播种步骤；W3 仅改 `configCenter.js` 静态数组元数据（不动运行时 gate）。零 DELETE、幂等可重跑。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL（crm schema, localhost/::1:5433）；测试 vitest 3。

**铁律提醒（贯穿全程）：**
- 绝对禁止 `DELETE`（测试清理用幂等 UPSERT/UPDATE，不用 DELETE）。
- 共享测试库 `crm_native_test` 若被并发 vitest 占用，跑测试加 `SKIP_CONCURRENCY_CHECK=1`。
- 每 Task 一 commit（用户提供精确 PowerShell 命令在本地提交，AI 沙箱无凭证）。
- id36 已批准纳入（仅改 scope/resolve 元数据，不碰 config_store['context-routing']/routing.js）。

---

## 文件结构（改动清单）

| 文件 | 操作 | 责任 |
|---|---|---|
| `src/http/sevenDimRouter.js` | Modify `:83`、`:190` | W1：透传 tenantId 进 updateScenario |
| `src/portal/alertRuleConfig.js` | Modify persist + handlers 用 `D.resolveMe` + 导出 `alertRuleDeps` | W2：租户行懒克隆 |
| `scripts/seed-tenant-isolation.mjs` | Modify（增 `seedAlertRules`） | W2：播种租户 alert_rule |
| `src/portal/configCenter.js` | Modify `:50/:65/:60/:69` | W3：id35/39/44/36 scope/resolve |
| `test/http/sevenDimRouter-tenant.test.js` | Create | W1 测试 |
| `test/alerts/alertRuleTenant.test.js` | Create | W2 测试 |
| `test/web/configCenter-scope.test.js` | Create | W3 测试 |

---

## Task 1：W1 sevenDimRouter 透传 tenantId（id15）

**Files:**
- Modify: `src/http/sevenDimRouter.js:83,190`
- Test: `test/http/sevenDimRouter-tenant.test.js`（新建）

- [ ] **Step 1：写失败测试（router 透传 tenantId + DB 按租户落盘）**

新建 `test/http/sevenDimRouter-tenant.test.js`：
```js
import { test, expect, beforeAll } from 'vitest';
import { createSevenDimRouter } from '../../src/http/sevenDimRouter.js';
import { scenarioDeps } from '../../src/portal/decisionScenario.js';
import { query, queryWrite } from '../../src/db.js';

const T = 'tenantAlpha';

beforeAll(async () => {
  // 幂等复位（禁 DELETE：用 UPDATE 而非 DELETE）
  await queryWrite(
    `UPDATE crm.config_store SET value=value WHERE key='seven-dim' AND tenant_id=$1`,
    [T]
  ).catch(() => {});
});

test('PUT 透传 scopeOf(me).tenantId 进 updateScenario（修复前 opts 无 tenantId）', async () => {
  let captured = null;
  const router = createSevenDimRouter({
    resolveMe: () => ({ ok: true, role: 'sysadmin', tenantId: T }),
    updateScenario: (id, patch, opts) => { captured = opts; return { required_dims: patch.required_dims }; },
    produceDecision: async () => ({ decisionId: 'd-x', ok: true }),
  });
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put(
    { body: { scenario_id: 'LEAD_FOLLOW_UP', required_dims: [{ dim: 'comprehension', on_missing: 'warn' }] } },
    res
  );
  expect(code).not.toBe(400);
  expect(captured).not.toBeNull();
  expect(captured.tenantId).toBe(T); // 关键：修复前此处为 undefined
});

test('PUT default_strictness 按租户落 config_store，不污染 system', async () => {
  const router = createSevenDimRouter({
    resolveMe: () => ({ ok: true, role: 'sysadmin', tenantId: T }),
  });
  let body = null;
  const res = { json: (p) => { body = p; } };
  await router.handlers.put({ body: { default_strictness: 'block' } }, res);
  expect(body.ok).toBe(true);
  const r = await query(
    `SELECT value FROM crm.config_store WHERE key='seven-dim' AND tenant_id=$1`,
    [T]
  );
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].value.default_strictness).toBe('block');
  // system 基线不受影响（若存在）
  const sys = await query(
    `SELECT value FROM crm.config_store WHERE key='seven-dim' AND tenant_id='system'`
  );
  if (sys.rows.length) expect(sys.rows[0].value.default_strictness).not.toBe('block');
});
```

- [ ] **Step 2：运行确认失败**

```bash
cd /d/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/http/sevenDimRouter-tenant.test.js
```
期望：第 1 个测试 FAIL（断言 `captured.tenantId` 为 `undefined`）。

- [ ] **Step 3：最小实现（2 行改动）**

`src/http/sevenDimRouter.js:83`：
```js
  updateScenario: (id, patch, opts) => scenarioDeps.updateScenario(id, patch, opts),
```
`src/http/sevenDimRouter.js:190`：
```js
        const row = await D.updateScenario(scenario_id, v.normalized, { tenantId });
```

- [ ] **Step 4：运行确认通过**

```bash
cd /d/system/CRM-ai-native
SKIP_CONCURRENCY_CHECK=1 node node_modules/vitest/vitest.mjs run test/http/sevenDimRouter-tenant.test.js
```
期望：2/2 PASS。

- [ ] **Step 5：提交**

```powershell
cd D:\system\CRM-ai-native
git add src/http/sevenDimRouter.js test/http/sevenDimRouter-tenant.test.js
git commit -m "fix(tenant): W1 sevenDimRouter 透传 scopeOf(me).tenantId 进 updateScenario"
```

---

## Task 2：W2 alert-rule 租户行懒克隆（id21）

**Files:**
- Modify: `src/portal/alertRuleConfig.js`（`persist` + handlers 用 `D.resolveMe` + 导出 `alertRuleDeps`）
- Test: `test/alerts/alertRuleTenant.test.js`（新建）

- [ ] **Step 1：写失败测试（租户首 PUT 自建行）**

新建 `test/alerts/alertRuleTenant.test.js`：
```js
import { test, expect } from 'vitest';
import { alertRuleDeps } from '../../src/portal/alertRuleConfig.js';
import { query } from '../../src/db.js';

const T = 'e2e-tenant-alert';

test('persist 对租户首写：克隆 system 模板 → 自建 (kind,tenant_id) 行且 UPDATE 生效', async () => {
  const r = await alertRuleDeps.persist(
    'deal_stuck',
    { enabled: false, check_params: { stuck_days: 99 } },
    { tenantId: T }
  );
  expect(r.ok).toBe(true);
  const row = await query(
    `SELECT enabled, check_params FROM crm.alert_rule WHERE kind='deal_stuck' AND tenant_id=$1`,
    [T]
  );
  expect(row.rows.length).toBe(1);
  expect(row.rows[0].enabled).toBe(false);
  expect(row.rows[0].check_params.stuck_days).toBe(99);
  // system 模板不被污染
  const sys = await query(
    `SELECT enabled FROM crm.alert_rule WHERE kind='deal_stuck' AND tenant_id='system'`
  );
  expect(sys.rows[0].enabled).toBe(true);
});

test('persist 对已有租户行：UPDATE 不复制新行（幂等）', async () => {
  await alertRuleDeps.persist('lead_overdue', { enabled: true }, { tenantId: T });
  const before = await query(`SELECT count(*)::int n FROM crm.alert_rule WHERE tenant_id=$1`, [T]);
  await alertRuleDeps.persist('lead_overdue', { enabled: false }, { tenantId: T });
  const after = await query(`SELECT count(*)::int n FROM crm.alert_rule WHERE tenant_id=$1`, [T]);
  expect(after.rows[0].n).toBe(before.rows[0].n); // 行长不变
  const row = await query(`SELECT enabled FROM crm.alert_rule WHERE kind='lead_overdue' AND tenant_id=$1`, [T]);
  expect(row.rows[0].enabled).toBe(false);
});
```
> 注：`alertRuleDeps` 为本 Task 新增导出；修复前该符号不存在 → Step 2 编译失败（import 报错），即红灯。

- [ ] **Step 2：运行确认失败**

```bash
cd /d/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/alerts/alertRuleTenant.test.js
```
期望：FAIL（import `alertRuleDeps` 失败 / 租户行 0 行）。

- [ ] **Step 3：实现（persist 懒克隆 + 可注入 resolveMe + 导出）**

`src/portal/alertRuleConfig.js` 改动三处：

(1) `defaultDeps` 顶部增加 `resolveMe`（复用已导入的 `resolveMe`）：
```js
const defaultDeps = {
  resolveMe: (req) => resolveMe(req),
  listRules: ({ tenantId = 'system' } = {}) => listAlertRules({ tenantId }),
```

(2) `persist` 在 UPDATE 前克隆 system 行（仅非 system 租户）：
```js
  persist: async (kind, patch, { tenantId = 'system' } = {}) => {
    try {
      // 2026-09-06 W2：租户首写先克隆 system 模板（含 match 列）到本租户，避免 UPDATE 命中 0 行（修复伪绿/重启丢）
      if (tenantId && tenantId !== 'system') {
        await queryWrite(
          `INSERT INTO crm.alert_rule (kind, match, check_params, severity, target_role, enabled, version, tenant_id)
           SELECT kind, match, check_params, severity, target_role, enabled, version, $2
           FROM crm.alert_rule WHERE kind=$1 AND tenant_id='system'
           ON CONFLICT (kind, tenant_id) DO NOTHING`,
          [kind, tenantId]
        );
      }
      const r = await queryWrite(
        `UPDATE crm.alert_rule SET enabled=$3, check_params=$4::jsonb, severity=$5, target_role=$6, version=COALESCE(version,1)+1, updated_at=now() WHERE kind=$1 AND tenant_id=$2 RETURNING kind`,
        [kind, tenantId, patch.enabled !== undefined ? !!patch.enabled : null, JSON.stringify(patch.check_params || {}), patch.severity || null, patch.target_role || null]
      );
      return { ok: r.rows.length > 0 };
    } catch {
      return { ok: false };
    }
  },
```

(3) `handlers.list` / `handlers.put` 改用 `D.resolveMe(req)`（原直接调 `resolveMe(req)`，为支持测试注入）：
```js
    list: async (req, res) => {
      try {
        const me = D.resolveMe(req);
        const tenantId = scopeTenant(me);
```
```js
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
        const me = D.resolveMe(req);
        const tenantId = scopeOf(me);
```

(4) 文件末尾导出（对齐 decisionScenario 的 `scenarioDeps`）：
```js
export { defaultDeps as alertRuleDeps };
```

- [ ] **Step 4：运行确认通过**

```bash
cd /d/system/CRM-ai-native
SKIP_CONCURRENCY_CHECK=1 node node_modules/vitest/vitest.mjs run test/alerts/alertRuleTenant.test.js
```
期望：2/2 PASS。

- [ ] **Step 5：提交**

```powershell
cd D:\system\CRM-ai-native
git add src/portal/alertRuleConfig.js test/alerts/alertRuleTenant.test.js
git commit -m "fix(tenant): W2 alert_rule persist 租户首写懒克隆 system 模板"
```

---

## Task 3：W2 播种租户 alert_rule 行

**Files:**
- Modify: `scripts/seed-tenant-isolation.mjs`（增 `seedAlertRules` + main 调用）

- [ ] **Step 1：写播种函数（复用 collectTenants 范式，只插不删）**

在 `scripts/seed-tenant-isolation.mjs` 的 `seedBusinessTiers` 函数之后新增：
```js
async function seedAlertRules(tenant) {
  const sys = await query(
    `SELECT kind, match, check_params, severity, target_role, enabled, version
     FROM crm.alert_rule WHERE tenant_id='system'`
  ).catch(() => ({ rows: [] }));
  if (!sys.rows.length) return 0;
  const own = await query(
    `SELECT 1 FROM crm.alert_rule WHERE tenant_id=$1 LIMIT 1`,
    [tenant]
  ).catch(() => ({ rows: [] }));
  if (own.rows.length) return 0;
  if (DRY_RUN) {
    console.log(`  [dry-run] ${tenant}: 将克隆 ${sys.rows.length} 条 alert_rule`);
    return 0;
  }
  let created = 0;
  for (const r of sys.rows) {
    await query(
      `INSERT INTO crm.alert_rule (kind, match, check_params, severity, target_role, enabled, version, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (kind, tenant_id) DO NOTHING`,
      [r.kind, JSON.stringify(r.match || {}), JSON.stringify(r.check_params || {}), r.severity, r.target_role, r.enabled !== false, r.version || 1, tenant]
    ).catch(() => {});
    created++;
  }
  return created;
}
```

- [ ] **Step 2：在 main() 接线**

`scripts/seed-tenant-isolation.mjs` 的 `main()` 循环内，在 `seedBusinessTiers(tenant)` 之后加：
```js
    const rules = await seedAlertRules(tenant);
    totalFlows += flows;
    totalTiers += tiers;
    totalRules += rules;
    if (flows || tiers || rules) console.log(`[seed] ${tenant}: 审批流 +${flows} / 分级 +${tiers} / 预警 +${rules}`);
```
并在 `main()` 顶部声明 `let totalRules = 0;`，结尾日志补 `预警共克隆 ${totalRules}`。

- [ ] **Step 3：运行播种（生产库）确认**

```bash
cd /d/system/CRM-ai-native
node scripts/seed-tenant-isolation.mjs
```
期望：各业务租户 `+预警 5`（system 5 行已存在 → 克隆 5 行/租户），日志 `预警共克隆 N`。

- [ ] **Step 4：提交**

```powershell
cd D:\system\CRM-ai-native
git add scripts/seed-tenant-isolation.mjs
git commit -m "feat(tenant): W2 seed-tenant-isolation 播种各租户 alert_rule 行"
```

---

## Task 4：W3 配置中心标签失真修正（id35/39/44/36）

**Files:**
- Modify: `src/portal/configCenter.js:50,65,60,69`
- Test: `test/web/configCenter-scope.test.js`（新建）

- [ ] **Step 1：写断言测试**

新建 `test/web/configCenter-scope.test.js`：
```js
import { test, expect } from 'vitest';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const TARGET_IDS = [35, 39, 44, 36];
const byId = Object.fromEntries(CONFIG_ITEMS.map((i) => [i.id, i]));

test('id35/39/44/36 标签修正为平台级（scope=platform, resolve=system-only）', () => {
  for (const id of TARGET_IDS) {
    const it = byId[id];
    expect(it, `config id ${id} 应存在`).toBeDefined();
    expect(it.scope, `id ${id} scope 应为 platform`).toBe('platform');
    expect(it.resolve, `id ${id} resolve 应为 system-only`).toBe('system-only');
    // 与 level 一致（平台级配置）
    expect(it.level).toBe('system');
  }
});
```

- [ ] **Step 2：运行确认失败**

```bash
cd /d/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/web/configCenter-scope.test.js
```
期望：FAIL（id35/39/44/36 当前 scope='tenant'）。

- [ ] **Step 3：改四处元数据**

`src/portal/configCenter.js`：
- `:50` id35：`scope: 'tenant'` → `'platform'`，`resolve: 'tenant-first'` → `'system-only'`
- `:65` id39：`scope: 'tenant'` → `'platform'`，`resolve: 'tenant-first'` → `'system-only'`
- `:60` id36：`scope: 'tenant'` → `'platform'`，`resolve: 'tenant-first'` → `'system-only'`
- `:69` id44：`scope: 'tenant'` → `'platform'`，`resolve: 'tenant-first'` → `'system-only'`

- [ ] **Step 4：运行确认通过 + scope/resolve 仅展示用校验**

```bash
cd /d/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run test/web/configCenter-scope.test.js
```
期望：PASS。
补充校验（确认 scope/resolve 无运行时 gate 依赖，仅展示）：
```bash
cd /d/system/CRM-ai-native
grep -rn "\.scope\b\|\.resolve\b" src --include=*.js | grep -v "configCenter.js" || echo "无其他运行时消费点"
```
期望：无运行时消费点（或仅字符串插值展示），确认改动纯元数据、不破坏行为。

- [ ] **Step 5：提交**

```powershell
cd D:\system\CRM-ai-native
git add src/portal/configCenter.js test/web/configCenter-scope.test.js
git commit -m "fix(config): W3 id35/39/44/36 标签修正为平台级 scope/platform"
```

---

## Task 5：完整测试 + E2E + 审计回填

**Files:**
- Modify: `docs/2026-09-06-phase2-tenant-isolation-design.md`（回填 §7/§8/§9）

- [ ] **Step 1：运行 Phase 2 全套测试**

```bash
cd /d/system/CRM-ai-native
SKIP_CONCURRENCY_CHECK=1 node node_modules/vitest/vitest.mjs run test/http/sevenDimRouter-tenant.test.js test/alerts/alertRuleTenant.test.js test/web/configCenter-scope.test.js test/portal/decisionScenarioTenant.test.js test/web/alertRuleConfig.test.js test/web/configCenter.test.js
```
期望：全部 PASS（决策场景租户化 + alert 租户化 + 配置标签均绿）。

- [ ] **Step 2：E2E 实测（生产库）**

```bash
cd /d/system/CRM-ai-native
node scripts/seed-tenant-isolation.mjs
```
验证：
- 各业务租户 `crm.alert_rule` 各 5 行（`SELECT tenant_id, count(*) FROM crm.alert_rule GROUP BY tenant_id`）。
- seven-dim：以租户 admin 身份 PUT `default_strictness` → `crm.config_store` 出现该租户行。
- alert-rules：以租户身份 PUT 某 kind → `crm.alert_rule` 出现 `(kind,tenant_id)` 行且 persist ok:true。

- [ ] **Step 3：审计探针（按设计实测隔离）**

写临时探针 `tmp/_audit_phase2.mjs`（仅读，禁写）：
```js
import { query } from '../src/db.js';
const r = await query(`
  SELECT tenant_id, count(*)::int n FROM crm.decision_scenario GROUP BY tenant_id ORDER BY tenant_id`);
console.log('decision_scenario 分布:', r.rows);
const a = await query(`
  SELECT tenant_id, count(*)::int n FROM crm.alert_rule GROUP BY tenant_id ORDER BY tenant_id`);
console.log('alert_rule 分布:', a.rows);
const c = await query(`
  SELECT tenant_id, key FROM crm.config_store WHERE key='seven-dim' ORDER BY tenant_id`);
console.log('seven-dim config_store 分布:', c.rows);
```
运行：`cd /d/system/CRM-ai-native && node tmp/_audit_phase2.mjs`
期望：每个业务租户均有独立 `decision_scenario` / `alert_rule` / `config_store(seven-dim)` 行，且 `system` 模板独立存在、不被污染。

- [ ] **Step 4：回填交付文档**

将 Step 1–3 的实测结果回填 `docs/2026-09-06-phase2-tenant-isolation-design.md` 的 §7（完整测试与 E2E 结果）、§8/§9（按设计审计实测）。删除 `tmp/_audit_phase2.mjs`。

- [ ] **Step 5：提交**

```powershell
cd D:\system\CRM-ai-native
git add docs/2026-09-06-phase2-tenant-isolation-design.md
git commit -m "docs(phase2): 回填完整测试/E2E/审计实测结果"
```

---

## 自审（Self-Review）

1. **Spec 覆盖**：W1(§2)→Task1；W2 运行态懒克隆(§3)→Task2，播种(§3)→Task3；W3(§4)→Task4；测试/E2E/审计(§6)→Task5。无遗漏。
2. **占位扫描**：无 TBD/TODO；每步含完整代码/命令。
3. **类型一致性**：`scenarioDeps.updateScenario(id,patch,{tenantId})` 与 `decisionScenario.js:177` 签名一致；`alertRuleDeps.persist(kind,patch,{tenantId})` 与 `defaultDeps.persist` 签名一致；`CONFIG_ITEMS` 导出符号与 Task4 测试一致。
4. **禁 DELETE**：Task1/2 测试改用幂等 UPSERT/UPDATE，未使用 DELETE。
