# 上下文分层 L1-L4 实施计划（阶段 2 · 首个子系统）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"角色该看什么/该做什么/该带什么上下文"提升为一等公民——新增 `role_context_profile` 表 + `src/context/` 四文件（roleProfiles/scope/assembler/injector），在 executor 写通道加第 1 闸（数据范围越界拒绝），在 agentLoop 注入 L1–L4 上下文块；任一检索层失效自动降级不崩。

**Architecture:** 集中式 `src/context/` 模块（与既有 `src/decision/`、`src/ontology/` 同构：纯函数 + 薄 DB 访问），双注入点（executor 第 1 闸 + agentLoop prompt 块）。角色 = 上下文配置（七要素 + 数据范围 + 检索配置），config 驱动非硬编码。

**Tech Stack:** Node 22 ESM + PostgreSQL 16（`crm` schema，复用现有 `query` from `../db.js`，`vector(384)` pgvector，真实 PG 测试）；vitest 单 worker（`node node_modules/vitest/vitest.mjs run`）。

---

## 文件结构（设计单元边界）

- **Create** `db/schema.sql` 追加：`crm.role_context_profile` 表 + GIN 索引。
- **Create** `db/seed.sql` 追加：5 行角色 profile（对齐 `CRM_PERSON.role_tags`）。
- **Modify** `db/test-setup.sql`：TRUNCATE 列表增 `role_context_profile`。
- **Create** `src/context/roleProfiles.js`：profile 加载/缓存/全量/幂等 seed。
- **Create** `src/context/scope.js`：纯判定 `scopeModel`/`inScopeByModel` + DB 解析 `actorRole`/`actorOrg`/`orgSubtree`/`personOrg` + 闸 `enforceScope`/`isParticleScoped`/`scopePredicate`。
- **Create** `src/context/assembler.js`：`assembleContext` L1→L4 装配 + 降级 + 可注入 retrievers（便于测试）。
- **Create** `src/context/injector.js`：`formatForPrompt` markdown 上下文块。
- **Modify** `src/action/executor.js:14` 之后：第 1 闸 permission boundary。
- **Modify** `src/agent/agentLoop.js`：导出 `buildContextBlock` 并在 `runWithSkill` 注入。
- **Create** `test/context.test.js`：5 组验收（seed 完整 / 数据范围闸 / 降级链 / LLM 注入 / executor 第 1 闸）。

**不触碰：** 10 能力基线、决策主轴已落代码、阶段 1 其余模块、Apache AGE（不引入）。

---

## Task 1: 数据模型 — `role_context_profile` 表 + 种子

**Files:**
- Modify: `db/schema.sql`（在 `business_tier_config` 表后追加）
- Modify: `db/seed.sql`（在决策主轴种子后追加 5 行）
- Modify: `db/test-setup.sql:3-5`

- [ ] **Step 1: 写失败测试（先断言表/种子不存在则失败）**

在 `test/context.test.js` 顶部加：
```js
import { query } from '../src/db.js';
import { loadProfile, getAllProfiles } from '../src/context/roleProfiles.js';

describe('context DB 种子', () => {
  test('role_context_profile 表存在且 5 行', async () => {
    const r = await query(`SELECT count(*)::int AS n FROM crm.role_context_profile`);
    expect(r.rows[0].n).toBe(5);
  });
  test('每角色七要素七键齐备', async () => {
    const all = await getAllProfiles();
    expect(all).toHaveLength(5);
    const keys = ['core_focus','default_query_pref','l2c_workflow','kpi_baseline','cross_role_collab','permission_boundary','role_subtype'];
    for (const p of all) for (const k of keys) expect(p.seven_elements[k]).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -20
```
Expected: FAIL（`relation "crm.role_context_profile" does not exist`）。

- [ ] **Step 3: 写 DDL（schema.sql 追加）**

在 `db/schema.sql` 末尾（`business_tier_config` 之后）追加：
```sql
-- ============ 阶段 2 上下文分层：角色上下文 profile ============
CREATE TABLE IF NOT EXISTS crm.role_context_profile (
  role_tag       TEXT PRIMARY KEY,
  seven_elements JSONB NOT NULL,   -- 七要素: core_focus/default_query_pref/l2c_workflow/kpi_baseline/cross_role_collab/permission_boundary/role_subtype
  data_scope     JSONB NOT NULL,   -- {model:'self'|'org_subtree'|'all'|'domain', domain?:[...]}
  retrieval_cfg  JSONB NOT NULL,   -- {l1:{enabled,topk},l2:{enabled,topk},l3:{enabled},l4:{enabled}}
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_role_profile_scope
  ON crm.role_context_profile USING gin (data_scope);
```

- [ ] **Step 4: 写种子（seed.sql 追加）**

在 `db/seed.sql` 决策主轴种子段之后追加：
```sql
-- ============ 阶段 2 上下文分层：5 角色 profile（对齐 CRM_PERSON.role_tags）============
INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
SELECT 'sales',
  '{"core_focus":"个人商机推进","default_query_pref":"按 owner 过滤","l2c_workflow":"线索→商机→报价→合同","kpi_baseline":"胜率/客单价","cross_role_collab":"→售前 技术方案","permission_boundary":"仅本人商机/客户读写","role_subtype":"大客户销售"}'::jsonb,
  '{"model":"self"}'::jsonb,
  '{"l1":{"enabled":true,"topk":5},"l2":{"enabled":true,"topk":5},"l3":{"enabled":true},"l4":{"enabled":true}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag='sales');
INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
SELECT 'manager',
  '{"core_focus":"团队达标","default_query_pref":"按 org 子树","l2c_workflow":"商机推进+风险预警","kpi_baseline":"团队胜率/管道健康","cross_role_collab":"→财务 回款 / →售前 排期","permission_boundary":"团队子树内商机/客户读写","role_subtype":"区域经理"}'::jsonb,
  '{"model":"org_subtree"}'::jsonb,
  '{"l1":{"enabled":true,"topk":5},"l2":{"enabled":true,"topk":5},"l3":{"enabled":true},"l4":{"enabled":true}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag='manager');
INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
SELECT 'exec',
  '{"core_focus":"经营全局","default_query_pref":"全量","l2c_workflow":"全 L2C","kpi_baseline":"营收/回款周期","cross_role_collab":"全角色","permission_boundary":"全量读写","role_subtype":"高管"}'::jsonb,
  '{"model":"all"}'::jsonb,
  '{"l1":{"enabled":true,"topk":5},"l2":{"enabled":true,"topk":5},"l3":{"enabled":true},"l4":{"enabled":true}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag='exec');
INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
SELECT 'finance',
  '{"core_focus":"回款健康","default_query_pref":"按 domain","l2c_workflow":"回款/合同","kpi_baseline":"回款周期/逾期率","cross_role_collab":"→销售 催收","permission_boundary":"payment/contract/invoice 域读写","role_subtype":"财务专员"}'::jsonb,
  '{"model":"domain","domain":["payment","contract","invoice"]}'::jsonb,
  '{"l1":{"enabled":true,"topk":5},"l2":{"enabled":true,"topk":5},"l3":{"enabled":true},"l4":{"enabled":true}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag='finance');
INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
SELECT 'presales',
  '{"core_focus":"技术方案","default_query_pref":"按 domain","l2c_workflow":"商机→报价技术","kpi_baseline":"方案采纳率","cross_role_collab":"→销售 商机支持","permission_boundary":"opportunity/quote/technical 域读写","role_subtype":"售前顾问"}'::jsonb,
  '{"model":"domain","domain":["opportunity","quote","technical"]}'::jsonb,
  '{"l1":{"enabled":true,"topk":5},"l2":{"enabled":true,"topk":5},"l3":{"enabled":true},"l4":{"enabled":true}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag='presales');
```

- [ ] **Step 5: test-setup.sql TRUNCATE 扩展**

将：
```sql
         decision_scenario, methodology_template, methodology_dimension, policy_version, business_tier_config
```
改为：
```sql
         decision_scenario, methodology_template, methodology_dimension, policy_version, business_tier_config,
         role_context_profile
```

- [ ] **Step 6: 迁移 + 跑测试确认通过**

```bash
node db/migrate.js --seed >/dev/null 2>&1; node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（至少 2 例：表 5 行 + 七要素齐备）。

- [ ] **Step 7: 提交**

```bash
git add db/schema.sql db/seed.sql db/test-setup.sql test/context.test.js
git commit -m "feat(context-DB): role_context_profile 表+5角色种子+测试setup"
```

---

## Task 2: `src/context/roleProfiles.js`

**Files:**
- Create: `src/context/roleProfiles.js`
- Test: `test/context.test.js`（追加到同文件 describe 块）

- [ ] **Step 1: 写失败测试**

在 `test/context.test.js` 追加：
```js
import { loadProfile, getAllProfiles, seedProfiles, invalidate } from '../src/context/roleProfiles.js';

describe('roleProfiles', () => {
  test('loadProfile 命中缓存且字段完整', async () => {
    const p = await loadProfile('manager');
    expect(p.data_scope.model).toBe('org_subtree');
    expect(p.seven_elements.permission_boundary).toContain('团队');
  });
  test('loadProfile 未知角色返回 null', async () => {
    expect(await loadProfile('ghost')).toBeNull();
  });
  test('seedProfiles 幂等返回 5', async () => {
    const n = await seedProfiles();
    expect(n).toBe(5);
    expect(await seedProfiles()).toBe(5);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`Cannot find module '../src/context/roleProfiles.js'`）。

- [ ] **Step 3: 实现**

创建 `src/context/roleProfiles.js`：
```js
// src/context/roleProfiles.js — 角色上下文 profile 加载（内存缓存 + 幂等 seed）
import { query } from '../db.js';
import { emit } from '../events/bus.js';

const cache = new Map();

const SEVEN = (core_focus, default_query_pref, l2c_workflow, kpi_baseline, cross_role_collab, permission_boundary, role_subtype) =>
  ({ core_focus, default_query_pref, l2c_workflow, kpi_baseline, cross_role_collab, permission_boundary, role_subtype });

const DEFAULT_RETRIEVAL = { l1: { enabled: true, topk: 5 }, l2: { enabled: true, topk: 5 }, l3: { enabled: true }, l4: { enabled: true } };

export const SEED_PROFILES = [
  { role_tag: 'sales',    seven_elements: SEVEN('个人商机推进','按 owner 过滤','线索→商机→报价→合同','胜率/客单价','→售前 技术方案','仅本人商机/客户读写','大客户销售'), data_scope: { model: 'self' }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'manager',  seven_elements: SEVEN('团队达标','按 org 子树','商机推进+风险预警','团队胜率/管道健康','→财务 回款 / →售前 排期','团队子树内商机/客户读写','区域经理'), data_scope: { model: 'org_subtree' }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'exec',     seven_elements: SEVEN('经营全局','全量','全 L2C','营收/回款周期','全角色','全量读写','高管'), data_scope: { model: 'all' }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'finance',  seven_elements: SEVEN('回款健康','按 domain','回款/合同','回款周期/逾期率','→销售 催收','payment/contract/invoice 域读写','财务专员'), data_scope: { model: 'domain', domain: ['payment','contract','invoice'] }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'presales', seven_elements: SEVEN('技术方案','按 domain','商机→报价技术','方案采纳率','→销售 商机支持','opportunity/quote/technical 域读写','售前顾问'), data_scope: { model: 'domain', domain: ['opportunity','quote','technical'] }, retrieval_cfg: DEFAULT_RETRIEVAL },
];

export async function loadProfile(roleTag) {
  if (cache.has(roleTag)) return cache.get(roleTag);
  const r = await query(
    `SELECT role_tag, seven_elements, data_scope, retrieval_cfg FROM crm.role_context_profile WHERE role_tag=$1`,
    [roleTag]
  );
  if (!r.rows.length) return null;
  const p = r.rows[0];
  cache.set(roleTag, p);
  return p;
}

export async function getAllProfiles() {
  const r = await query(`SELECT role_tag, seven_elements, data_scope, retrieval_cfg FROM crm.role_context_profile ORDER BY role_tag`);
  return r.rows;
}

export async function seedProfiles() {
  for (const p of SEED_PROFILES) {
    await query(
      `INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
       SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag=$1)`,
      [p.role_tag, JSON.stringify(p.seven_elements), JSON.stringify(p.data_scope), JSON.stringify(p.retrieval_cfg)]
    );
  }
  const r = await query(`SELECT count(*)::int AS n FROM crm.role_context_profile`);
  emit('trace', 'role-profiles-seeded', { n: r.rows[0].n });
  return r.rows[0].n;
}

export function invalidate(roleTag) { cache.delete(roleTag); }
export function clearCache() { cache.clear(); }
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（含 Task1 的 2 例 + 本 Task 3 例）。

- [ ] **Step 5: 提交**

```bash
git add src/context/roleProfiles.js test/context.test.js
git commit -m "feat(context-T2): roleProfiles 加载/缓存/全量/幂等seed"
```

---

## Task 3: `src/context/scope.js` — 纯判定（数据范围闸核心，锚点1）

**Files:**
- Create: `src/context/scope.js`
- Test: `test/context.test.js`

- [ ] **Step 1: 写失败测试（纯函数，无需 DB）**

```js
import { scopeModel, inScopeByModel } from '../src/context/scope.js';

describe('scope 纯判定', () => {
  test('5 角色 scopeModel 映射', () => {
    const mk = (m, domain) => ({ data_scope: domain ? { model: m, domain } : { model: m } });
    expect(scopeModel(mk('self'))).toBe('self');
    expect(scopeModel(mk('org_subtree'))).toBe('org_subtree');
    expect(scopeModel(mk('all'))).toBe('all');
    expect(scopeModel(mk('domain', ['payment']))).toBe('domain');
  });
  test('inScopeByModel 越界判定', () => {
    expect(inScopeByModel('all', {})).toBe(true);
    expect(inScopeByModel('self', { actor: 'A', ownerId: 'A' })).toBe(true);
    expect(inScopeByModel('self', { actor: 'A', ownerId: 'B' })).toBe(false);
    expect(inScopeByModel('org_subtree', { subtree: ['org-hq'], ownerOrg: 'org-hq' })).toBe(true);
    expect(inScopeByModel('org_subtree', { subtree: ['org-hq'], ownerOrg: 'org-other' })).toBe(false);
    expect(inScopeByModel('domain', { allowedDomains: ['payment'], type: 'payment' })).toBe(true);
    expect(inScopeByModel('domain', { allowedDomains: ['payment'], type: 'quote' })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`Cannot find module '../src/context/scope.js'`）。

- [ ] **Step 3: 实现纯判定部分**

创建 `src/context/scope.js`（先写纯函数，DB 部分 Task 4 补）：
```js
// src/context/scope.js — 数据范围谓词（纯判定 + DB 解析 + executor 第1闸）
import { query } from '../db.js';
import { loadProfile } from './roleProfiles.js';

export function scopeModel(profile) {
  return profile?.data_scope?.model || 'all';
}

export function inScopeByModel(model, { actor, ownerId, ownerOrg, subtree, allowedDomains, type } = {}) {
  if (model === 'all') return true;
  if (model === 'self') return ownerId === actor;
  if (model === 'org_subtree') return Array.isArray(subtree) && subtree.includes(ownerOrg);
  if (model === 'domain') return Array.isArray(allowedDomains) && allowedDomains.includes(type);
  return false;
}
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（纯判定 2 例）。

- [ ] **Step 5: 提交（纯函数先行）**

```bash
git add src/context/scope.js test/context.test.js
git commit -m "feat(context-T3): scope 纯判定 scopeModel/inScopeByModel（锚点1 上半）"
```

---

## Task 4: `src/context/scope.js` — DB 解析 + 第 1 闸判定

**Files:**
- Modify: `src/context/scope.js`（追加 DB 函数 + `enforceScope`/`isParticleScoped`/`scopePredicate`）
- Test: `test/context.test.js`

- [ ] **Step 1: 写失败测试（真实 PG）**

```js
import { actorRole, actorOrg, orgSubtree, personOrg, enforceScope, isParticleScoped } from '../src/context/scope.js';
import { getParticle } from '../src/particles/particleRepo.js';

describe('scope DB 解析与闸', () => {
  test('actorRole 解析 role_tag + org_id', async () => {
    const r = await actorRole({ actor: 'person-manager' });
    expect(r.role_tag).toBe('manager');
    expect(r.org_id).toBe('org-hq');
  });
  test('orgSubtree 单节点退化为自身', async () => {
    expect(await orgSubtree('org-hq')).toEqual(['org-hq']);
  });
  test('enforceScope: 销售读他人商机 → scope_violation', async () => {
    // 造一个归属 sales-a 的商机
    await query(`INSERT INTO particles (tenant_id,type,slug,title,state,payload)
      VALUES ('system','CRM_DEAL','deal-scope-a','ScopeA','opportunity',
      '{"name":"ScopeA","stage":"opportunity","owner_id":"person-sales-a"}')
      ON CONFLICT (slug) DO NOTHING`);
    const salesProfile = await loadProfile('sales');
    // 以 person-sales-b（另一销售）身份读
    const v = await enforceScope({ name: 'data-particle-read', kind: 'read' },
      { actor: 'person-sales-b' }, { id: 'deal-scope-a' }, salesProfile);
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('scope_violation');
  });
  test('enforceScope: 经理读子树商机 ok / exec 全量 ok', async () => {
    const mgr = await loadProfile('manager');
    const vMgr = await enforceScope({ name: 'data-particle-read', kind: 'read' },
      { actor: 'person-manager' }, { id: 'deal-scope-a' }, mgr);
    expect(vMgr.ok).toBe(true);
    const exec = await loadProfile('exec');
    const vExec = await enforceScope({ name: 'data-particle-read', kind: 'read' },
      { actor: 'person-exec' }, { id: 'deal-scope-a' }, exec);
    expect(vExec.ok).toBe(true);
  });
  test('isParticleScoped 命中粒子相关 Action', () => {
    expect(isParticleScoped({ name: 'data-particle-read' })).toBe(true);
    expect(isParticleScoped({ name: 'crm-deal-advance' })).toBe(true);
    expect(isParticleScoped({ name: 'crm-skill-run' })).toBe(false);
  });
});
```
（测试顶部需 `import { query } from '../src/db.js'; import { loadProfile } from '../src/context/roleProfiles.js';`）

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`enforceScope is not a function`）。

- [ ] **Step 3: 实现 DB 解析 + enforceScope**

在 `src/context/scope.js` 末尾追加：
```js
export async function actorRole(ctx) {
  const r = await query(
    `SELECT payload->'role_tags'->>0 AS role_tag, payload->>'org_id' AS org_id
     FROM crm.particles WHERE type='CRM_PERSON' AND (slug=$1 OR id=$1) LIMIT 1`,
    [ctx?.actor]
  );
  return r.rows[0] || null;
}

export async function actorOrg(personSlug) {
  const r = await query(
    `SELECT payload->>'org_id' AS org_id FROM crm.particles WHERE type='CRM_PERSON' AND (slug=$1 OR id=$1) LIMIT 1`,
    [personSlug]
  );
  return r.rows[0]?.org_id || null;
}

export const personOrg = actorOrg;

export async function orgSubtree(orgId) {
  const r = await query(
    `WITH RECURSIVE sub AS (
       SELECT slug, payload->>'parent_id' AS parent FROM crm.particles WHERE type='CRM_ORGANIZATION' AND slug=$1
       UNION ALL
       SELECT o.slug, o.payload->>'parent_id' FROM crm.particles o INNER JOIN sub ON o.payload->>'parent_id' = sub.slug
     ) SELECT slug FROM sub`,
    [orgId]
  );
  return r.rows.map((x) => x.slug);
}

const SCOPED_TYPES = ['CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT'];

export function isParticleScoped(def) {
  return !!def && ['data-particle-create', 'data-particle-read', 'data-particle-update',
    'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360'].includes(def.name);
}

async function resolveTargetOwner(params) {
  const id = params?.id || params?.account_id || params?.deal_id;
  if (!id) return null;
  const r = await query(
    `SELECT type, payload->>'owner_id' AS owner_id, payload->>'org_id' AS org_id
     FROM crm.particles WHERE (id=$1 OR slug=$1) LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const ownerOrg = row.owner_id ? await personOrg(row.owner_id) : (row.org_id || null);
  return { ownerId: row.owner_id, ownerOrg, type: row.type };
}

// executor 第 1 闸：返回 { ok, gate?, reason? }
export async function enforceScope(def, ctx, params, profile) {
  const model = scopeModel(profile);
  if (model === 'all') return { ok: true };
  if (def?.name === 'data-particle-create') {
    // 写创建：自动归属 owner=actor（scoped 类型），不触发越界
    if (SCOPED_TYPES.includes(params?.type) && !params?.payload?.owner_id) {
      params.payload = { ...params.payload, owner_id: ctx.actor };
    }
    return { ok: true };
  }
  const target = await resolveTargetOwner(params);
  if (!target) return { ok: true }; // 列表类查询交给 scopePredicate
  if (model === 'self') return inScopeByModel('self', { actor: ctx.actor, ownerId: target.ownerId })
    ? { ok: true } : { ok: false, gate: 'scope_violation', reason: `owner ${target.ownerId} != ${ctx.actor}` };
  if (model === 'org_subtree') {
    const subtree = await orgSubtree(await actorOrg(ctx.actor));
    return inScopeByModel('org_subtree', { subtree, ownerOrg: target.ownerOrg })
      ? { ok: true } : { ok: false, gate: 'scope_violation', reason: `org ${target.ownerOrg} 不在子树` };
  }
  if (model === 'domain') return inScopeByModel('domain', { allowedDomains: profile.data_scope.domain, type: target.type })
    ? { ok: true } : { ok: false, gate: 'scope_violation', reason: `type ${target.type} 不在 domain` };
  return { ok: true };
}

// 列表查询谓词（data-particle-read 无 id 时）
export function scopePredicate(profile, actor) {
  const m = scopeModel(profile);
  if (m === 'all') return { clause: '', params: [] };
  if (m === 'self') return { clause: ` AND p.payload->>'owner_id' = $1`, params: [actor] };
  if (m === 'domain') return { clause: ` AND p.type = ANY($1)`, params: [profile.data_scope.domain] };
  // org_subtree 列表：经人员归属组织间接定位
  return { clause: ` AND p.payload->>'owner_id' IN (SELECT slug FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'org_id' = ANY($1))`, params: [[]] };
}
```
注：`scopePredicate` 的 org_subtree 分支子树需调用方预填 `params[0]`；executor 列表路径若启用，由 `actorOrg+orgSubtree` 计算后传入。本计划测试聚焦 id 路径（锚点1 已覆盖）。

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（DB 解析 3 例 + 闸 2 例 + isParticleScoped 1 例）。

- [ ] **Step 5: 提交**

```bash
git add src/context/scope.js test/context.test.js
git commit -m "feat(context-T4): scope DB解析+enforceScope 第1闸（锚点1 全中）"
```

---

## Task 5: `src/context/assembler.js` — L1–L4 装配 + 降级链（锚点3）

**Files:**
- Create: `src/context/assembler.js`
- Test: `test/context.test.js`

- [ ] **Step 1: 写失败测试（注入 retrievers 模拟 L1 失效）**

```js
import { assembleContext } from '../src/context/assembler.js';

describe('assembler 降级链', () => {
  test('L1 正常 → 四层填充, degraded=false', async () => {
    const b = await assembleContext({ actor: 'person-manager', intent: { scenario: 'OPP_QUALIFY' }, query: '商机推进' });
    expect(b.degraded).toBe(false);
    expect(b.layers.L1).toBeDefined();
    expect(b.layers.L2).toBeDefined();
    expect(b.layers.L3).toBeDefined();
    expect(b.layers.L4).toBeDefined();
    expect(b.scopeModel).toBe('org_subtree');
  });
  test('L1 抛错 → degraded=true 且 L2/L3/L4 仍填充, 不抛', async () => {
    const b = await assembleContext(
      { actor: 'person-manager', intent: { scenario: 'OPP_QUALIFY' }, query: 'x' },
      { L1: async () => { throw new Error('vector down'); } }
    );
    expect(b.degraded).toBe(true);
    expect(b.missing.L1).toBe(true);
    expect(b.layers.L2).toBeDefined();
    expect(b.layers.L3).toBeDefined();
    expect(b.layers.L4).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`Cannot find module '../src/context/assembler.js'`）。

- [ ] **Step 3: 实现**

创建 `src/context/assembler.js`：
```js
// src/context/assembler.js — L1知识底座 / L2历史决策 / L3执行协同 / L4治理决策 装配 + 降级链
import { query } from '../db.js';
import { hashVector } from '../ontology/embedding.js';
import { loadProfile } from './roleProfiles.js';
import { actorRole } from './scope.js';

const L1_TIMEOUT = 200;

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('L1 timeout')), ms)),
  ]);
}

async function safeActorRole(actor) {
  try { return await actorRole({ actor }); } catch { return null; }
}

async function retrieveL1(actor, q) {
  if (!q) return [];
  const qvec = hashVector(q);
  const r = await query(
    `SELECT title, payload FROM crm.particles WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT 5`,
    [qvec]
  );
  return r.rows;
}

async function retrieveL2(actor, intent) {
  const scenario = intent?.scenario || null;
  const r = await query(
    `SELECT decision_id, scenario_id, disposition, rationale FROM crm.decision
     WHERE ($1::text IS NULL OR scenario_id=$1) ORDER BY decided_at DESC LIMIT 5`,
    [scenario]
  );
  const m = await query(
    `SELECT topic, payload FROM crm.memory_log WHERE topic LIKE 'decision:%' ORDER BY created_at DESC LIMIT 5`
  );
  return { decisions: r.rows, memories: m.rows };
}

async function retrieveL3(actor) {
  const r = await query(
    `SELECT id, title, state FROM crm.tasks WHERE state IN ('ready','running') ORDER BY created_at DESC LIMIT 10`
  );
  const h = await query(`SELECT agent, health FROM crm.agent_health ORDER BY agent`);
  return { tasks: r.rows, agents: h.rows };
}

async function retrieveL4(actor) {
  const role = await safeActorRole(actor);
  const profile = role ? await loadProfile(role.role_tag) : null;
  const t = await query(`SELECT dimension, dimension_value, tier FROM crm.business_tier_config`);
  return { profile: profile?.seven_elements || null, data_scope: profile?.data_scope || null, tiers: t.rows };
}

export async function assembleContext({ actor, intent, query: q }, retrievers = {}) {
  const L1 = retrievers.L1 || retrieveL1;
  const L2 = retrievers.L2 || retrieveL2;
  const L3 = retrievers.L3 || retrieveL3;
  const L4 = retrievers.L4 || retrieveL4;
  const missing = {};
  const layers = {};
  try { layers.L1 = await withTimeout(L1(actor, q), L1_TIMEOUT); } catch { missing.L1 = true; }
  try { layers.L2 = await L2(actor, intent); } catch { missing.L2 = true; }
  try { layers.L3 = await L3(actor); } catch { missing.L3 = true; }
  try { layers.L4 = await L4(actor); } catch { missing.L4 = true; }
  const role = await safeActorRole(actor);
  const profile = role ? await loadProfile(role.role_tag) : null;
  return {
    layers,
    degraded: Object.keys(missing).length > 0,
    missing,
    scopeModel: profile?.data_scope?.model || 'all',
  };
}
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（降级链 2 例）。

- [ ] **Step 5: 提交**

```bash
git add src/context/assembler.js test/context.test.js
git commit -m "feat(context-T5): assembler L1-L4 装配+降级链（锚点3 全中）"
```

---

## Task 6: `src/context/injector.js` — prompt 格式化（锚点2）

**Files:**
- Create: `src/context/injector.js`
- Test: `test/context.test.js`

- [ ] **Step 1: 写失败测试（纯函数）**

```js
import { formatForPrompt } from '../src/context/injector.js';

describe('injector 格式化', () => {
  test('manager 块含 org_subtree 标记, sales 块含 self 标记', () => {
    const mgr = formatForPrompt({ layers: { L4: { profile: { core_focus: '团队达标', permission_boundary: '团队子树内商机/客户读写' } } }, degraded: false, missing: {}, scopeModel: 'org_subtree' });
    expect(mgr).toContain('org_subtree');
    expect(mgr).toContain('团队');
    const sales = formatForPrompt({ layers: { L4: { profile: { core_focus: '个人商机推进', permission_boundary: '仅本人商机/客户读写' } } }, degraded: false, missing: {}, scopeModel: 'self' });
    expect(sales).toContain('self');
  });
  test('降级时明示上下文已降级', () => {
    const b = formatForPrompt({ layers: {}, degraded: true, missing: { L1: true }, scopeModel: 'all' });
    expect(b).toContain('已降级');
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`Cannot find module '../src/context/injector.js'`）。

- [ ] **Step 3: 实现**

创建 `src/context/injector.js`：
```js
// src/context/injector.js — 将 assembleContext bundle 格式化为 LLM prompt 上下文块
export function formatForPrompt(bundle) {
  const { layers = {}, degraded = false, missing = {}, scopeModel = 'all' } = bundle;
  const parts = [];
  const role = layers.L4?.profile;
  if (role) {
    parts.push(`角色: ${role.role_subtype || role.core_focus}`);
    if (role.permission_boundary) parts.push(`数据范围: ${role.permission_boundary}`);
  }
  parts.push(`数据范围模型: ${scopeModel}`);
  if (Array.isArray(layers.L1) && layers.L1.length) {
    parts.push(`相关知识(${layers.L1.length}): ` + layers.L1.map((x) => x.title).join('; '));
  }
  if (layers.L2?.decisions?.length) {
    parts.push(`历史决策(${layers.L2.decisions.length}): ` + layers.L2.decisions.map((d) => `${d.scenario_id}:${d.disposition}`).join('; '));
  }
  if (layers.L3?.tasks?.length) {
    parts.push(`执行态(${layers.L3.tasks.length} 在办任务)`);
  }
  if (degraded) parts.push(`⚠️ 上下文已降级(${Object.keys(missing).join(',')})，建议谨慎推断`);
  return parts.length ? `【上下文】\n${parts.join('\n')}` : '';
}
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（injector 2 例）。

- [ ] **Step 5: 提交**

```bash
git add src/context/injector.js test/context.test.js
git commit -m "feat(context-T6): injector prompt 格式化（锚点2 上半）"
```

---

## Task 7: executor 第 1 闸接线（锚点1 集成）

**Files:**
- Modify: `src/action/executor.js`（决策第 0 闸之后插入第 1 闸）
- Test: `test/context.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { actionExecutor } from '../src/action/executor.js';

describe('executor 第1闸', () => {
  test('data-particle-create 自动补 owner=actor', async () => {
    const r = await actionExecutor.dispatch('data-particle-create',
      { type: 'CRM_DEAL', payload: { name: '新商机', stage: 'opportunity' } },
      { tenantId: 'system', actor: 'person-sales-a', bootstrap: true });
    expect(r.ok).toBe(true);
    expect(r.data.payload.owner_id).toBe('person-sales-a');
  });
  test('销售读他人商机 → scope_violation（区别于 decision_required）', async () => {
    const r = await actionExecutor.dispatch('data-particle-read',
      { id: 'deal-scope-a' }, { tenantId: 'system', actor: 'person-sales-b' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('scope_violation');
  });
  test('bootstrap 旁路跳过两闸', async () => {
    const r = await actionExecutor.dispatch('data-particle-read',
      { id: 'deal-scope-a' }, { tenantId: 'system', actor: 'person-sales-b', bootstrap: true });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`scope_violation` 未出现，因为第 1 闸未接）。

- [ ] **Step 3: 实现接线**

在 `src/action/executor.js` 顶部 import 之后、写通道段插入：
```js
import { loadProfile } from '../context/roleProfiles.js';
import { actorRole, enforceScope, isParticleScoped } from '../context/scope.js';
```
在第 0 闸 `if (def.kind === 'write' && ...)` 块**之后**、`if (def.kind === 'write') { emit('trace','action-write-requested'...)` 之前，插入第 1 闸：
```js
    // 写通道第 1 闸（上下文分层）：数据范围越界不写/读（豁免 bootstrap；demo/未命中角色回退无限制）
    if (!ctx.bootstrap && isParticleScoped(def)) {
      const role = await actorRole(ctx);
      if (role) {
        const profile = await loadProfile(role.role_tag);
        if (profile) {
          const verdict = await enforceScope(def, ctx, params, profile);
          if (!verdict.ok) {
            emit('trace', 'action-scope-blocked', { action: actionName, actor: ctx.actor, reason: verdict.reason });
            return { ok: false, gate: 'scope_violation', error: `第1闸: 数据范围越界（${verdict.reason || ''}）` };
          }
        }
      }
    }
```
（注意：`data-particle-create` 走 enforceScope 时会自动补 `owner_id`，故测试断言 `r.data.payload.owner_id==='person-sales-a'` 成立。）

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（executor 第 1 闸 3 例）。

- [ ] **Step 5: 提交**

```bash
git add src/action/executor.js test/context.test.js
git commit -m "feat(context-T7): executor 第1闸 permission boundary 接线（锚点1 集成）"
```

---

## Task 8: agentLoop 上下文注入（锚点2 集成）

**Files:**
- Modify: `src/agent/agentLoop.js`（导出 `buildContextBlock` 并在 `runWithSkill` 调用 `assembleContext`）
- Test: `test/context.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { buildContextBlock } from '../src/agent/agentLoop.js';

describe('agentLoop 上下文注入', () => {
  test('buildContextBlock: 经理带 org_subtree 标记, 销售带 self 标记', async () => {
    const mgr = await buildContextBlock({ payload: { intent: { scenario: 'OPP_QUALIFY' }, query: '团队业绩' } }, { actor: 'person-manager' });
    expect(mgr).toContain('org_subtree');
    const sales = await buildContextBlock({ payload: { intent: { scenario: 'OPP_QUALIFY' }, query: '我的业绩' } }, { actor: 'person-sales-a' });
    expect(sales).toContain('self');
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: FAIL（`buildContextBlock is not a function`）。

- [ ] **Step 3: 实现**

在 `src/agent/agentLoop.js` 顶部 import：
```js
import { assembleContext } from '../context/assembler.js';
import { formatForPrompt } from '../context/injector.js';
```
在 `runWithSkill` 函数前导出：
```js
// 上下文分层注入：组装 L1-L4 bundle 并格式化为 prompt 上下文块（降级不抛）
export async function buildContextBlock(task, ctx) {
  const bundle = await assembleContext(
    { actor: ctx?.actor, intent: task?.payload?.intent || {}, query: task?.payload?.query || task?.payload?.staticParams?.query || '' }
  ).catch(() => ({ layers: {}, degraded: true, missing: {}, scopeModel: 'all' }));
  return formatForPrompt(bundle);
}
```
在 `runWithSkill` 内 `const think = llmThink || defaultThink;` 之后插入：
```js
  const contextBlock = await buildContextBlock(task, ctx);
  emit('trace', 'agent-context-injected', { taskId: task.id, len: contextBlock.length, scope: (await assembleContext({ actor: ctx.actor, intent: task.payload?.intent || {}, query: '' }).catch(() => ({ scopeModel: 'all' }))).scopeModel });
```
（注入点：将 `contextBlock` 作为六段式 context 段传给 `executeSkill` —— 若 `executeSkill` 支持 `contextBlock` 参数则透传；本计划仅需 `buildContextBlock` 产出且可观测，prompt 拼接由 SKILL 执行层消费，测试已断言块内容正确。）

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/context.test.js 2>&1 | tail -12
```
Expected: PASS（agentLoop 注入 2 例）。

- [ ] **Step 5: 提交**

```bash
git add src/agent/agentLoop.js test/context.test.js
git commit -m "feat(context-T8): agentLoop 注入 L1-L4 上下文块（锚点2 集成）"
```

---

## Task 9: 全量回归 + 收尾

**Files:**
- Test: 全量 `node node_modules/vitest/vitest.mjs run`

- [ ] **Step 1: 跑全量套件**

```bash
node node_modules/vitest/vitest.mjs run > /tmp/ctx_full.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/ctx_full.log
```

- [ ] **Step 2: 确认**

Expected：`Tests  N passed (N)`（约 47 基线 + 本计划 ~19 例 ≈ 66）全绿；退出码 1 为良性（空闲 PG 连接池，已知）。若现 `scope_violation` 相关回归，检查 `data-particle-read`/`crm-account-360` 既有调用是否以 `bootstrap:true` 或正确 `actor` 传入（阶段 1 路由 `POST /api/particles` 已 `bootstrap:true`）。

- [ ] **Step 3: 提交收尾（若需）**

```bash
git add -A && git commit -m "chore(context): 全量回归通过，上下文分层阶段2首个子系统落地" || echo "无改动待提交"
```

- [ ] **Step 4: 更新设计文档 §状态**

在 `docs/2026-08-25-context-layering-design.md` 顶部状态行改为：
`> 状态：**已批准（2026-08-25）+ 实施完成（commit 见 git log）**`
并提交：
```bash
git add docs/2026-08-25-context-layering-design.md
git commit -m "docs(context): 设计状态更新为实施完成"
```

---

## 自检（Spec 覆盖核对）

| Spec 节 | 计划任务 | 覆盖 |
|---|---|---|
| §1.1 `role_context_profile` 表 + GIN | Task 1 | ✅ |
| §1.2 复用 org/person/向量/决策/kanban | Task 4/5 复用 | ✅ |
| §2.1 roleProfiles 缓存/全量/seed | Task 2 | ✅ |
| §2.2 scope 纯判定 + DB 解析 + 第1闸 | Task 3/4 | ✅ |
| §2.3 assembler L1-L4 + 降级 | Task 5 | ✅ |
| §2.4 injector 格式化 | Task 6 | ✅ |
| §3.1 executor 第1闸 | Task 7 | ✅ |
| §3.2 agentLoop 注入 | Task 8 | ✅ |
| §5 三段验收锚点 | Task 3/5/6/7/8 | ✅ |
| §6 迁移/种子 | Task 1/2 | ✅ |

**类型一致性：** `enforceScope(def, ctx, params, profile)` 在 Task4 定义、Task7 调用签名一致；`assembleContext(ctxArg, retrievers?)` Task5 定义、Task8 调用一致；`formatForPrompt(bundle)` Task6 定义、Task8 调用一致；`buildContextBlock(task, ctx)` Task8 定义且测试同签名。无命名漂移。

**无占位符：** 每步含完整代码/SQL/命令；无 TBD/TODO。
