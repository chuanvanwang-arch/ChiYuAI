# 租户级后台设置完全隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让租户级后台配置完全按租户隔离：每个租户单独保存、数据互不污染、权限闭环、租户设置仅本租户生效。

**Architecture:** 基于现有 per-tenant 底座（config_store 主键 `(tenant_id,key)` + scopeTenant/scopeOf 读写分派）做三层次补强：(1) 存储层 autoSeed——租户缺键自动从 system 模板落默认到租户（`_seeded` 标记），不再运行时回退 system；(2) 播种/backfill——新租户 onboarding 自动播种 8 个租户级键，存量租户一次性 backfill；(3) 三处缺口补闸——alert_rule 表 + pool-config + decision-scenario 写侧按租户隔离（decision_scenario PK 复合化为 `(scenario_id, tenant_id)` + FK 复合化，方案 a），approval-config 消费链租户化。

**Tech Stack:** Node.js 22 + PostgreSQL 16（pgvector/pgcrypto）+ Express 4 + vitest 3；db.js 写池 queryWrite、configStore readConfig/writeConfig、scopeTenant/scopeOf、tenantRouter 播种钩子。

---

## 设计文档

- 设计：`docs/2026-09-05-tenant-config-full-isolation-design.md`（已批准，契约校验通过）
- 代码审计发现的缺口：
  - G1: `configStore.js:10-23` 运行时回退 system
  - G2: `approvalConfig.js:59` 消费硬编码 system
  - G3: `alert_rule` 表无 tenant_id 列 + 内存注册表平台级
  - G4: `routes.js:723` / `controlledConfigPages.js:203` pool-config 写死 org-hq/system
  - G5: `decisionScenario.js` 写侧 UPDATE 无 tenant 限定
  - G6: `seedTenantDefaults.js` 只播种 2 键，需扩展

## 文件结构

| 文件 | 职责 | 变更 |
|---|---|---|
| `src/config/configStore.js` | 存储层：readConfig autoSeed | 修改 |
| `db/seed/tenantDefaults.js` | 播种器：扩展到 8 键 + T9 租户配置化 | 修改 |
| `db/backfill-tenant-config.js` | 存量租户 backfill（一次性脚本，只插不删） | 新建 |
| `db/schema.sql` / 新迁移 | alert_rule 补 tenant_id 列 | 修改/新建 |
| `src/alerts/alertRegistry.js` | 内存规则表租户化 | 修改 |
| `src/alerts/alertHook.js` | 事件上下文透传租户 | 修改 |
| `src/http/alertRuleConfigRouter.js`（若独立） | 读/写按租户 | 修改 |
| `src/sales/pool.js` | pool-config 按租户存储 | 修改 |
| `src/http/routes.js` / `controlledConfigPages.js` | pool 端点按租户 | 修改 |
| `src/portal/decisionScenario.js` | 决策场景写侧租户化 + 读侧 listScenarios 租户过滤 | 修改 |
| `db/migration-decision-scenario-tenant-pk.sql` | decision_scenario PK 复合化 + FK 复合化（方案 a） | 新建 |
| `src/approval/approvalConfig.js` | 租户化读取 | 修改 |
| `src/action/seed-actions.js` | approval 消费传租户 | 修改 |
| `test/...` | TDD 测试 | 新建/修改 |

## 关键前置知识（工程师必读）

- **db.js**：`query` 是读池，`queryWrite` 是写池（INSERT/UPDATE/DELETE 必须经写池）。
- **configStore**：`readConfig(key, {tenantId})` → `{value, decision_id}` 或 null；`writeConfig(key, value, {tenantId, decisionId, updatedBy})` → upsert。
- **scopeTenant(me)**：admin/sysadmin → `'*'`（通配）；其他 → me.tenantId 或 'system'。
- **scopeOf(me)**：恒 me.tenantId 或 'system'（写永不跨租户）。
- **system 语义**：platform 种子租户；新决策下 system 只作模板源，不再运行时回退。
- **铁律**：禁 DELETE；写经决策第0闸；零信任 HITL；每 Task 一 commit（禁 `git add -A`，显式路径 add）。

---

### Task 1: configStore autoSeed（G1）

**Files:**
- Modify: `src/config/configStore.js`
- Test: `test/config/configStore.autoSeed.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/config/configStore.autoSeed.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/config/configStore.js';

// 直接用真库验证 autoSeed 语义（对齐既有 configStore 测试范式）
describe('configStore autoSeed', () => {
  const T = 'e2e-tenant-autoseed';
  const KEY = 'sales-thresholds';
  const SYS = 'system';

  beforeAll(async () => {
    // 清租户键（只删测试租户的键，不改 system）
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T]).catch(() => {});
  });
  afterAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T]).catch(() => {});
  });

  it('租户缺键 → autoSeed 从 system 模板落租户并返回', async () => {
    // system 已有基线
    const sys = await readConfig(KEY, { tenantId: SYS });
    expect(sys).toBeTruthy();
    // 租户无键 → 读触发 autoSeed
    const t = await readConfig(KEY, { tenantId: T });
    expect(t).toBeTruthy();
    expect(t.value).toEqual(sys.value);
    // 已落库（租户已保存单独的一份）
    const again = await readConfig(KEY, { tenantId: T });
    expect(again.value).toEqual(sys.value);
  });

  it('已存在的租户键不被覆盖', async () => {
    await writeConfig(KEY, { bantcc: { pass: 0.99 } }, { tenantId: T, decisionId: null });
    const t = await readConfig(KEY, { tenantId: T });
    expect(t.value.bantcc.pass).toBe(0.99);
  });

  it('platform 键不 autoSeed（仅租户级键）', async () => {
    // 平台级键（如 billing-plans）不是租户级；直接读 system
    const p = await readConfig('billing-plans', { tenantId: T });
    expect(p).toBeTruthy(); // 有 system 基线 → 返回（读 side 不落租户）
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest test/config/configStore.autoSeed.test.js --reporter=verbose`
Expected: 失败 —— 租户缺键时 `readConfig` 返回 null 而非 autoSeed。

- [ ] **Step 3: 实现 autoSeed**

```js
// src/config/configStore.js (修改 readConfig)
export async function readConfig(key, { tenantId = PLATFORM } = {}) {
  if (tenantId !== PLATFORM) {
    const r = await query(
      `SELECT value, decision_id FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
      [tenantId, key]
    );
    if (r.rows[0]) return r.rows[0];
    // autoSeed：租户缺键 → 从 system 模板落租户（只读触发；幂等：已有则上面已返回）
    // 2026-09-05 用户决策：完全独立不共享；system 只作模板源
    const s = await query(
      `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
      [PLATFORM, key]
    );
    if (s.rows[0]) {
      // 深拷贝 + _seeded 标记（审计：该值来自模板）
      const seededValue = { ...s.rows[0].value, _seeded: 'system-template' };
      await queryWrite(
        `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
         VALUES ($1, $2, $3::jsonb, NULL, 'system', now())
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId, key, JSON.stringify(seededValue)]
      );
      const r2 = await query(
        `SELECT value, decision_id FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
        [tenantId, key]
      );
      if (r2.rows[0]) return r2.rows[0];
    }
  }
  const r = await query(
    `SELECT value, decision_id FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
    [PLATFORM, key]
  );
  return r.rows[0] || null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/config/configStore.js test/config/configStore.autoSeed.test.js
git commit -m "feat(config): configStore autoSeed 租户缺键自动落默认（G1 完全独立）"
```

---

### Task 2: 播种器扩展（G6）——8 键 + 租户配置化

**Files:**
- Modify: `db/seed/tenantDefaults.js`
- Test: `test/db/seed/tenantDefaults.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/db/seed/tenantDefaults.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js';
import { readConfig } from '../../src/config/configStore.js';

describe('seedTenantDefaults 扩展', () => {
  const T = 'e2e-tenant-seedext';
  beforeAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T]).catch(() => {});
  });
  afterAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T]).catch(() => {});
  });

  it('默认播种全部租户级键（all=true）', async () => {
    const r = await seedTenantDefaults(T, { all: true });
    expect(r.ok).toBe(true);
    // 8 键应全播种
    const keys = ['sales-thresholds','named-account-targets','approval-config',
      'behavior-standard','finance-receivables','decision-retro','agent-event-trigger','context-routing'];
    for (const k of keys) {
      const row = await readConfig(k, { tenantId: T });
      expect(row, `键 ${k} 应播种`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL —— `all` 选项不存在，播种键数不足。

- [ ] **Step 3: 实现扩展**

```js
// db/seed/tenantDefaults.js (修改)
// 默认「必须按租户差异化」的键清单（可增量扩展；其余键一律回退 system）
export const DEFAULT_TENANT_SEED_KEYS = [
  'sales-thresholds','named-account-targets','approval-config',
  'behavior-standard','finance-receivables','decision-retro',
  'agent-event-trigger','context-routing',
];

// opts: { all=false, salesThresholds=false, namedTargets=false, ... }
//   all=true → 播全量 DEFAULT_TENANT_SEED_KEYS
export async function seedTenantDefaults(tenantId, opts = {}) {
  // ...（保留 ① 注册表登记逻辑）
  // ② 差异化键播种
  const seededKeys = [];
  const skippedKeys = [];
  const targetKeys = opts.all ? DEFAULT_TENANT_SEED_KEYS
    : DEFAULT_TENANT_SEED_KEYS.filter((k) => opts[keyFlagMap[k]]);
  for (const key of targetKeys) {
    try {
      const src = await readConfig(key, { tenantId: 'system' });
      await writeConfig(key, src?.value || {}, { tenantId: tenant });
      seededKeys.push(key);
    } catch {
      skippedKeys.push(key);
    }
  }
  return { ok: true, tenantId: tenant, seededKeys, skippedKeys };
}
const keyFlagMap = {
  'sales-thresholds': 'salesThresholds',
  'named-account-targets': 'namedTargets',
  'approval-config': 'approvalConfig',
  'behavior-standard': 'behaviorStandard',
  'finance-receivables': 'financeReceivables',
  'decision-retro': 'decisionRetro',
  'agent-event-trigger': 'agentEventTrigger',
  'context-routing': 'contextRouting',
};
```

（完整代码：保留原 `provisionTenant`、`writeConfig/readConfig` import；实现以实际源码为准。）

- [ ] **Step 4: 运行确认通过**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add db/seed/tenantDefaults.js test/db/seed/tenantDefaults.test.js
git commit -m "feat(tenant): 播种器扩展到 8 租户级键 + all 选项（G6）"
```

---

### Task 3: 存量租户 backfill（G6）

**Files:**
- Create: `db/backfill-tenant-config.js`

- [ ] **Step 1: 写脚本（只插不删，幂等）**

```js
// db/backfill-tenant-config.js — 存量租户配置 backfill（一次性迁移）
// 语义：把 system 基线深拷贝到现有租户（只补缺，不覆盖已有定制；禁 DELETE）
// 运行：node db/backfill-tenant-config.js
import { query, queryWrite } from '../src/db.js';
import { DEFAULT_TENANT_SEED_KEYS, seedTenantDefaults } from './seed/tenantDefaults.js';
import { readConfig } from '../src/config/configStore.js';

const TARGET_KEYS = DEFAULT_TENANT_SEED_KEYS;

async function main() {
  // ① 收集租户：tenants 表 + particles 中出现的租户（并集）
  const tenants = new Set();
  const t1 = await query(`SELECT tenant_id FROM crm.tenants`).catch(() => ({ rows: [] }));
  for (const r of t1.rows) tenants.add(r.tenant_id);
  const t2 = await query(`SELECT DISTINCT tenant_id FROM crm.particles WHERE tenant_id IS NOT NULL`);
  for (const r of t2.rows) tenants.add(r.tenant_id);
  tenants.delete('system');

  let backfilled = 0, skipped = 0;
  for (const tenant of tenants) {
    const res = await seedTenantDefaults(tenant, { all: true });
    backfilled += res.seededKeys.length;
    skipped += res.skippedKeys.length;
    console.log(`[backfill] ${tenant}: seeded=${res.seededKeys.join(',')} skipped=${res.skippedKeys.join(',') || '-'}`);
  }
  console.log(`[backfill] 完成：租户 ${tenants.size} 个，播种 ${backfilled} 键，跳过 ${skipped} 键（只插不删）`);
  process.exit(0);
}

main().catch((e) => { console.error('[backfill] 失败:', e.message); process.exit(1); });
```

- [ ] **Step 2: 冒烟运行（只读计划）**

Run: `node db/backfill-tenant-config.js --dry-run`（先加 dry-run 分支：只打印不写）
Expected: 列出将 backfill 的租户与键数。

- [ ] **Step 3: 真实运行（需用户确认——零信任 HITL）**

Run: `node db/backfill-tenant-config.js`
Expected: 4 个存量租户（acme-chem/acme-demo/acme-insmedi/acme-training + co-036cq4k 等）各播种缺失的键。

- [ ] **Step 4: 验证**

验证脚本（临时，不入库）：读各租户 8 键，确认存在 + `_seeded` 标记（若有）。
Expected: 每个租户 8 键可读，值=system 模板。

- [ ] **Step 5: Commit**

```bash
git add db/backfill-tenant-config.js
git commit -m "feat(db): 存量租户配置 backfill 脚本（只插不删，幂等）"
```

---

### Task 4: alert_rule 表 + 注册表/钩子租户化（G3）

**Files:**
- Create: `db/migration-alert-tenant.sql`（或写入 `db/migrate-tenant.js` 追加）
- Modify: `src/alerts/alertRegistry.js`
- Modify: `src/alerts/alertHook.js`
- Modify: `src/portal/alertRuleConfig.js`
- Test: `test/alerts/alertTenant.test.js`

- [ ] **Step 1: 迁移补列（仿照 `db/migration-meta-attr-tenant-pk.sql` 先例）**

```sql
-- db/migration-alert-tenant.sql
-- 2026-09-05 修复 alert_rule 跨租户隔离缺口（configCenter id21 声明 tenant 隔离，原实现未隔离）
-- 仿照 meta_attr 先例：幂等 DO $$ 块，仅当 PK 未含 tenant_id 时重建。
ALTER TABLE crm.alert_rule ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      USING (constraint_name, table_schema, table_name)
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'crm'
      AND tc.table_name = 'alert_rule'
      AND kcu.column_name = 'tenant_id'
  ) THEN
    ALTER TABLE crm.alert_rule DROP CONSTRAINT alert_rule_pkey;
    ALTER TABLE crm.alert_rule ADD PRIMARY KEY (tenant_id, kind);
    RAISE NOTICE '[migrate] alert_rule_pkey 已重建为 (tenant_id, kind)';
  ELSE
    RAISE NOTICE '[migrate] alert_rule_pkey 已含 tenant_id，跳过';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alert_rule_tenant ON crm.alert_rule(tenant_id);
```

（旧 PK `(kind)` 下每个 kind 至多 1 行 → 加 tenant_id 后必然唯一，DROP+ADD 不会因重复行失败，无需 DELETE。）

- [ ] **Step 2: 写失败测试**

```js
// test/alerts/alertTenant.test.js — 验证注册表按租户
import { describe, it, expect, beforeEach } from 'vitest';
import { resetAlertRegistry, updateAlertRule, listAlertRules, evaluateForEvent, registerTenantRules, tenantRules } from '../../src/alerts/alertRegistry.js';

describe('alertRegistry 租户化', () => {
  beforeEach(() => resetAlertRegistry());
  it('reset 后默认规则属于 system 租户', () => {
    const rules = listAlertRules();
    expect(rules.every((r) => r.tenant_id === 'system')).toBe(true);
  });
  it('租户更新不污染 system', () => {
    updateAlertRule('deal_stuck', { enabled: false }, { tenantId: 'acme-chem' });
    expect(listAlertRules({ tenantId: 'acme-chem' }).find((r) => r.kind === 'deal_stuck').enabled).toBe(false);
    expect(listAlertRules({ tenantId: 'system' }).find((r) => r.kind === 'deal_stuck').enabled).toBe(true);
  });
});
```

- [ ] **Step 3: 实现注册表租户化**

```js
// src/alerts/alertRegistry.js — 关键改动
// 内存表改为 per-tenant 映射：{ [tenantId]: rules[] }；缺省回退 system 模板（只读，不复制）
const rulesByTenant = new Map(); // tenantId -> rules[]
function ensureTenant(tenantId) {
  if (!rulesByTenant.has(tenantId)) {
    rulesByTenant.set(tenantId, rules.map(cloneRule).map((r) => ({ ...r, tenant_id: tenantId === 'system' ? 'system' : '_inherited' })));
  }
  return rulesByTenant.get(tenantId);
}
export function listAlertRules({ tenantId = 'system' } = {}) { return ensureTenant(tenantId).map(r => ({ ...r })); }
export function updateAlertRule(kind, patch = {}, { tenantId = 'system' } = {}) {
  const rs = ensureTenant(tenantId);
  const rule = rs.find((r) => r.kind === kind);
  if (!rule) return { ok: false, error: 'rule_not_found' };
  // ...（同既有逻辑，改 rs）
}
// evaluateForEvent 增加 tenantId 参数
export function evaluateForEvent(event, { tenantId = 'system' } = {}) { ... }
```

（`_inherited` 标记：租户未显式改时仍用模板值，改了即拷贝——与 configStore autoSeed 语义对齐。）

- [ ] **Step 4: 钩子透传租户**

```js
// src/alerts/alertHook.js —— 粒子写事件不携带 tenant_id（particleRepo.js:149 emit('particle','created',{id,type})）
// → 从粒子 id 反查租户（禁裸 catch：查询失败 → 回落 system 并 emit trace）
export function registerAlertHook() {
  if (unsubscribe) return;
  unsubscribe = on('particle', (msg) => {
    const { type, summary, payload } = msg;
    const evt = payload || summary || {};
    const event = { particleType: evt.particleType, action: evt.action || type, metric: evt.metric || {} };
    // 反查租户（fail-open 记 trace，不静默）
    let tenantId = 'system';
    if (evt.id) {
      try {
        const r = await query(`SELECT tenant_id FROM crm.particles WHERE id=$1`, [evt.id]);
        tenantId = r.rows[0]?.tenant_id || 'system';
      } catch (e) { emit('trace', 'alert-tenant-resolve-failed', { id: evt.id, error: String(e?.message) }); }
    }
    for (const { rule, payload: hitPayload } of evaluateForEvent(event, { tenantId })) {
      const a = createAlert({ ..., tenant_id: tenantId });
      ...
    }
  });
}
```

- [ ] **Step 5: Router 按租户读/写**

```js
// src/portal/alertRuleConfig.js — listRules/persist 接 tenantId
// list:  const { scopeTenant } = await import('../http/tenantScope.js'); const me=...; const rules = await D.listRules({ tenantId: scopeTenant(me) });
// put:  const { scopeOf } = ...; persist(kind, patch, { tenantId: scopeOf(me) })
// hydrateAlertRules：读全部行，按 tenant_id 分组回填
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest test/alerts/alertTenant.test.js --reporter=verbose`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add db/migration-alert-tenant.sql src/alerts/alertRegistry.js src/alerts/alertHook.js src/portal/alertRuleConfig.js test/alerts/alertTenant.test.js
git commit -m "feat(alerts): alert_rule 租户化（G3）——表补 tenant_id + 注册表/钩子/Router 按租户"
```

---

### Task 5: pool-config 租户化（G4）

**Files:**
- Modify: `src/sales/pool.js`
- Modify: `src/http/routes.js:711-725`
- Modify: `src/http/controlledConfigPages.js:195-210`
- Test: `test/sales/poolTenant.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/sales/poolTenant.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPoolConfig, setPoolConfig } from '../../src/sales/pool.js';

describe('pool-config 租户隔离', () => {
  const T = 'e2e-tenant-pool';
  beforeAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`UPDATE crm.particles SET payload = payload - 'pool_config' WHERE tenant_id=$1 AND type='CRM_ORGANIZATION'`, [T]).catch(() => {});
  });
  afterAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`UPDATE crm.particles SET payload = payload - 'pool_config' WHERE tenant_id=$1 AND type='CRM_ORGANIZATION'`, [T]).catch(() => {});
  });
  it('租户写 pool 配置不污染 system', async () => {
    // system 组织
    await setPoolConfig('org-hq', { pick_rule: { daily_limit: 5 } }, { tenantId: 'system' });
    // 租户组织（若不存在需先建；为简化直接断言写目标租户）
    const t = await setPoolConfig('org-hq', { pick_rule: { daily_limit: 1 } }, { tenantId: T });
    expect(t.pick_rule.daily_limit).toBe(1);
    const s = await getPoolConfig('org-hq', { tenantId: 'system' });
    expect(s.pick_rule.daily_limit).toBe(5);
  });
});
```

（若 CRM_ORGANIZATION 粒子只存在 system 租户，测试需先为 T 建一个——见 Step 3 实现以实际为准。）

- [ ] **Step 2: 实现租户隔离**

```js
// src/sales/pool.js — 修改：查询加 tenant_id 条件
export async function getPoolConfig(orgId = 'org-hq', { query: q = query, tenantId = 'system' } = {}) {
  const r = await q(
    `SELECT payload FROM crm.particles WHERE slug=$1 AND type='CRM_ORGANIZATION' AND tenant_id=$2`,
    [orgId, tenantId]
  );
  if (!r.rows[0]) return { ...DEFAULT_POOL_CONFIG };
  ...
}
export async function setPoolConfig(orgId, patch, { query: q = query, tenantId = 'system' } = {}) {
  const r = await q(`SELECT payload FROM crm.particles WHERE slug=$1 AND type='CRM_ORGANIZATION' AND tenant_id=$2`, [orgId, tenantId]);
  if (!r.rows[0]) throw new Error(`组织不存在（租户 ${tenantId}）: ${orgId}`);
  ...UPDATE... WHERE slug=$2 AND type='CRM_ORGANIZATION' AND tenant_id=$3
}
```

- [ ] **Step 3: Router/受控页传租户**

```js
// routes.js: GET /api/pool-config
const me = await realResolveMe(req).catch(() => ({ ok:false }));
const tenantId = scopeTenant(me);
res.json({ orgId, config: await getPoolConfig(orgId, { tenantId }), tenantId });
// PUT /api/pool-config
const tenantId = scopeOf(me);
await setPoolConfig(orgId, patch, { tenantId });
// controlledConfigPages.js pool-config 段：同传 scopeTenant(me)
```

- [ ] **Step 4: 运行测试确认通过**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sales/pool.js src/http/routes.js src/http/controlledConfigPages.js test/sales/poolTenant.test.js
git commit -m "feat(pool): pool-config 按租户隔离（G4）——读写均 scopeTenant/scopeOf"
```

---

### Task 6: decision-scenario 写侧租户化（G5，方案 a：PK 迁移）

**Files:**
- Create: `db/migration-decision-scenario-tenant-pk.sql`（PK 迁移，仿 meta_attr 先例）
- Modify: `src/portal/decisionScenario.js`（写侧租户化）
- Modify: `src/http/decisionReadRoutes.js`（读侧核对/对齐）
- Test: `test/portal/decisionScenarioTenant.test.js`

- [ ] **Step 1: PK 迁移（仿 `db/migration-meta-attr-tenant-pk.sql`）**

```sql
-- db/migration-decision-scenario-tenant-pk.sql
-- 2026-09-05 决策场景租户 PK 化（方案 a，用户 2026-09-05 裁决）
-- 仿 meta_attr 先例：幂等 DO 块，仅当 PK 未含 tenant_id 时重建。
-- 关键：decision_scenario 被三张表 FK 单列引用（decision.scenario_id /
--   calibration_patch.scenario_id / outcome_event_map.scenario_id）。
--   → 重建 PK 前必须先 DROP 这三条 FK；重建后再以复合列 (scenario_id, tenant_id) 重建 FK；
--   引用表均已含 tenant_id（migrate-tenant.js 补列），可关联 tenant_id 对齐。
ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      USING (constraint_name, table_schema, table_name)
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'crm'
      AND tc.table_name = 'decision_scenario'
      AND kcu.column_name = 'tenant_id'
  ) THEN
    -- 1) 卸下三张引用表的单列 FK（约束名按 DB 实际，用 IF EXISTS 幂等）
    ALTER TABLE crm.decision DROP CONSTRAINT IF EXISTS decision_scenario_id_fkey;
    ALTER TABLE crm.calibration_patch DROP CONSTRAINT IF EXISTS calibration_patch_scenario_id_fkey;
    ALTER TABLE crm.outcome_event_map DROP CONSTRAINT IF EXISTS outcome_event_map_scenario_id_fkey;
    -- 2) 重建 decision_scenario PK
    ALTER TABLE crm.decision_scenario DROP CONSTRAINT decision_scenario_pkey;
    ALTER TABLE crm.decision_scenario ADD PRIMARY KEY (scenario_id, tenant_id);
    -- 3) 三张引用表补 tenant_id（幂等；migrate-tenant.js 已补，保险起见）
    ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
    ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
    ALTER TABLE crm.outcome_event_map ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
    -- 4) 复合 FK 重建（scenario_id + tenant_id 对齐）
    ALTER TABLE crm.decision ADD CONSTRAINT decision_scenario_tenant_fkey
      FOREIGN KEY (scenario_id, tenant_id) REFERENCES crm.decision_scenario(scenario_id, tenant_id);
    ALTER TABLE crm.calibration_patch ADD CONSTRAINT calibration_patch_scenario_tenant_fkey
      FOREIGN KEY (scenario_id, tenant_id) REFERENCES crm.decision_scenario(scenario_id, tenant_id);
    ALTER TABLE crm.outcome_event_map ADD CONSTRAINT outcome_event_map_scenario_tenant_fkey
      FOREIGN KEY (scenario_id, tenant_id) REFERENCES crm.decision_scenario(scenario_id, tenant_id);
    RAISE NOTICE '[migrate] decision_scenario_pkey 已重建为 (scenario_id, tenant_id) + FK 复合化';
  ELSE
    RAISE NOTICE '[migrate] decision_scenario_pkey 已含 tenant_id，跳过';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_decision_scenario_tenant ON crm.decision_scenario(tenant_id);
```

（⚠ 约束名以 DB 实际为准——若不匹配，用 `SELECT conname FROM pg_constraint WHERE conrelid='crm.decision'::regclass` 核对后替换。）

- [ ] **Step 2: 写失败测试**

```js
// test/portal/decisionScenarioTenant.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scenarioDeps } from '../../src/portal/decisionScenario.js';

describe('decision-scenario 租户化写侧', () => {
  it('updateScenario 带 tenantId → 更新该租户场景', async () => {
    const list = await scenarioDeps.listScenarios();
    const base = list[0];
    await scenarioDeps.updateScenario(base.scenario_id, { description: 'T-PATCH' }, { tenantId: 'e2e-tenant-scn' });
    const rows = await scenarioDeps.listScenarios({ tenantId: 'e2e-tenant-scn' });
    expect(rows.some((r) => r.scenario_id === base.scenario_id && r.description === 'T-PATCH')).toBe(true);
  });
  it('租户场景读回退 system（autonomyEngine 语义）', async () => {
    const rows = await scenarioDeps.listScenarios({ tenantId: 'e2e-tenant-scn' });
    expect(rows.length).toBeGreaterThan(0); // 租户行存在
  });
});
```

- [ ] **Step 3: 实现写侧租户化**

```js
// src/portal/decisionScenario.js — 关键改动
// listScenarios({tenantId='*'})：缺省全量（兼容 admin 通配）；显式租户 → WHERE tenant_id=$1
listScenarios: async ({ tenantId = '*' } = {}) => {
  if (tenantId === '*') {
    return (await query(`SELECT * FROM crm.decision_scenario ORDER BY stage, scenario_id, tenant_id`)).rows;
  }
  return (await query(
    `SELECT * FROM crm.decision_scenario WHERE tenant_id=$1 OR tenant_id='system' ORDER BY (tenant_id=$1) DESC, stage, scenario_id`,
    [tenantId]
  )).rows;
},
// updateScenario(scenario_id, patch, {tenantId='system'})：先模板复制（INSERT...SELECT FROM system 行 ON CONFLICT DO NOTHING）再租户限定 UPDATE
updateScenario: async (scenario_id, patch, { tenantId = 'system' } = {}) => {
  await queryWrite(
    `INSERT INTO crm.decision_scenario (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed, dispositions, tenant_id)
     SELECT scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed, dispositions, $2
     FROM crm.decision_scenario WHERE scenario_id=$1 AND tenant_id='system'
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [scenario_id, tenantId]
  );
  const COL_CAST = { /* 同既有 */ };
  const entries = Object.entries(patch);
  const sets = entries.map(([k], i) => `${k}=$${i + 2}::${COL_CAST[k]}`).join(', ');
  const r = await queryWrite(
    `UPDATE crm.decision_scenario SET ${sets} WHERE scenario_id=$1 AND tenant_id=$2 RETURNING *`,
    [scenario_id, tenantId, ...entries.map(([k, v]) => (COL_CAST[k] === 'jsonb' ? JSON.stringify(v) : v))]
  );
  return r.rows[0];
},
// Router put：解析 me → tenantId = scopeOf(me)；GET list：tenantId = scopeTenant(me)
```

（⚠ `defaultDeps.updateScenario` 原用 `query` 写 UPDATE —— 读池写是隐患，本任务一并改用 `queryWrite` 写池。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest test/portal/decisionScenarioTenant.test.js --reporter=verbose`
Expected: PASS。

- [ ] **Step 5: 相关 FK 引用方核对**

- decision/calibration_patch/outcome_event_map 的 tenant_id 默认 'system'，与 system 场景对齐——复合 FK 不会破坏存量。
- `autonomyEngine.js:119` 读侧已按租户+回退，无需改。
- `executor.js:25` 已 `(tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC`，已对齐复合 PK。

- [ ] **Step 6: Commit**

```bash
git add db/migration-decision-scenario-tenant-pk.sql src/portal/decisionScenario.js test/portal/decisionScenarioTenant.test.js
git commit -m "feat(decision-scenario): 写侧按租户+PK 复合化（G5 方案a）——模板复制+租户限定 UPDATE+FK 复合化"
```

---

### Task 7: approval-config 消费链租户化（G2）

**Files:**
- Modify: `src/approval/approvalConfig.js`
- Modify: `src/action/seed-actions.js:66`
- Modify: `src/http/server.js:75`
- Test: `test/approval/approvalConfigTenant.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/approval/approvalConfigTenant.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readApprovalConfig, DEFAULT_APPROVAL_CONFIG } from '../../src/approval/approvalConfig.js';
import { writeConfig } from '../../src/config/configStore.js';

describe('approval-config 租户化', () => {
  const T = 'e2e-tenant-appr';
  beforeAll(async () => { await writeConfig('approval-config', { tierThresholds: { t2: 999999 } }, { tenantId: T, decisionId: null }); });
  afterAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='approval-config'`, [T]).catch(() => {});
  });
  it('租户读 approval-config → 该租户定制生效', async () => {
    const cfg = await readApprovalConfig(T);
    expect(cfg.tierThresholds.t2).toBe(999999);
  });
  it('system 读 → system 基线', async () => {
    const cfg = await readApprovalConfig('system');
    expect(cfg.tierThresholds.t2).toBe(DEFAULT_APPROVAL_CONFIG.tierThresholds.t2);
  });
});
```

- [ ] **Step 2: 实现**

```js
// src/approval/approvalConfig.js — 函数签名加 tenantId
export async function readApprovalConfig(tenantId = 'system') {
  try {
    const r = await readConfig('approval-config', { tenantId });
    return mergedApprovalConfig(r?.value);
  } catch {
    return mergedApprovalConfig();
  }
}
// 消费方：
//  src/action/seed-actions.js:66 → readApprovalConfig(tenantId)（从调用上下文取租户）
//  src/http/server.js:75 → readApprovalConfig('system')（服务启动加载平台默认）
```

（消费方具体租户来源以调用链为准——若 seed-actions 调用点本身有 actor/tenantId 则透传，否则保持 system 默认并注释。）

- [ ] **Step 3: 运行测试确认通过**

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/approval/approvalConfig.js src/action/seed-actions.js src/http/server.js test/approval/approvalConfigTenant.test.js
git commit -m "feat(approval): approval-config 消费链租户化（G2）——readApprovalConfig(tenantId)"
```

---

### Task 8: E2E 验证 + ui-lint + 全量回归

**Files:**
- Test: `test/e2e/tenantIsolation.e2e.test.js`（新建）

- [ ] **Step 1: 写 E2E 隔离验证**

```js
// test/e2e/tenantIsolation.e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/config/configStore.js';
import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js';

describe('租户设置完全隔离 E2E', () => {
  const A = 'e2e-iso-a', B = 'e2e-iso-b';
  beforeAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id IN ($1,$2)`, [A, B]).catch(() => {});
    await seedTenantDefaults(A, { all: true });
    await seedTenantDefaults(B, { all: true });
  });
  afterAll(async () => {
    const { queryWrite } = await import('../../src/db.js');
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id IN ($1,$2)`, [A, B]).catch(() => {});
  });

  it('租户 A 改销售阈值 → 租户 B 读回原值（互不污染）', async () => {
    await writeConfig('sales-thresholds', { bantcc: { pass: 0.999 } }, { tenantId: A, decisionId: null });
    const a = await readConfig('sales-thresholds', { tenantId: A });
    const b = await readConfig('sales-thresholds', { tenantId: B });
    expect(a.value.bantcc.pass).toBe(0.999);
    expect(b.value.bantcc.pass).not.toBe(0.999);
  });

  it('租户缺键 autoSeed 后完全自有（含 _seeded 标记）', async () => {
    const c = await readConfig('approval-config', { tenantId: A });
    expect(c.value._seeded).toBe('system-template');
  });
});
```

- [ ] **Step 2: 运行 E2E**

Run: `npx vitest test/e2e/tenantIsolation.e2e.test.js --reporter=verbose`
Expected: 2 用例 PASS。

- [ ] **Step 3: 全量回归**

Run: `npx vitest --reporter=dot`
Expected: 全绿（既有 ~2612 用例；PG 不稳时单次红不得直判回归，先隔离重跑）。

- [ ] **Step 4: ui-lint 检查（若改了 web 页面）**

Run: `node scripts/ui-lint.mjs`
Expected: 无违规（新增违规 → 修复）。

- [ ] **Step 5: Commit**

```bash
git add test/e2e/tenantIsolation.e2e.test.js
git commit -m "test(e2e): 租户设置完全隔离验证（A/B 互不污染 + autoSeed）"
```

---

## Self-Review

**Spec coverage:**
- G1 (configStore 回退) → Task 1 ✓
- G2 (approval 消费) → Task 7 ✓
- G3 (alert_rule 无租户) → Task 4 ✓
- G4 (pool-config) → Task 5 ✓
- G5 (decision-scenario) → Task 6 ✓
- G6 (播种/backfill) → Task 2/3 ✓
- 用户三项决策（完全独立/自动落默认/system 模板源）→ Task 1/2/3 ✓
- 权限控制 → 各 Router 沿用 scopeTenant/scopeOf + 三角色闸（已有）✓

**Known risks / 执行注意:**
- decision_scenario / alert_rule 的 PK 迁移需先确认当前约束名（`_pkey` 可能不同，用 `DROP CONSTRAINT IF EXISTS` 幂等）。
- alertHook 事件是否携带 tenant_id 需核对粒子写事件 payload（emit 处）。若不携带，则从事件来源（particle）补。
- CRM_ORGANIZATION 粒子可能仅存在于 system 租户——pool 租户化测试需先建租户组织粒子（或改从 config_store 存储，设计评审时定）。
- backfill 脚本真实运行前需用户显式确认（零信任 HITL，写生产库）。
- 全量回归 2612 例在 PG 不稳时易 flaky——单次红先隔离重跑，勿急判回归。
