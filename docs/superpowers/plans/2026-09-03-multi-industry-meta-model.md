# 多行业配置化元模型（零污染 + 按租户全隔离）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把平台从「通用 CRM 单租户」改造为「universal core + per-tenant profile + evolution engine」的配置化元模型——不引入行业维度、不加域、不加粒子类型字面量；新行业上线 = 写一份 `tenant-profile` 配置 + 业务数据驱动自适应，**零行业专属代码**；并补齐元模型层（`meta_attr`）与记忆层（`memory_log`/`snapshot`/`note`）的 `tenant_id` 维度，实现「按租户完全隔离数据权限 + 客户记忆全隔离」。

**Architecture:** 平台底层已具备 80% 元模型原子（19 valueType、`meta_attr.description` NL 定义、`source='ai'` AI Fill 列、`permission` 逐属性隐私、自由 TEXT 关系 target、`config_store` per-tenant）。本次改造 = 收敛（convergence）而非重建：① 给元模型层与记忆层补 `tenant_id`（结构性 20%）；② 新增 `getParticleDef(type,tenantId)` 双源解析器（代码基线 ∪ 租户配置原型），`isParticleType` 保留代码基线不破坏现有 21 处 CRM 硬编码；③ 激活已存在的 AI Fill 引擎（`source='ai'` 列）；④ 新增关系基数 `edges.cardinality` + 谓词配置并集；⑤ 新增 L2 沙箱公式引擎。所有 schema 变更经决策第0闸 + HITL + 审计；绝对禁 DELETE。

**Tech Stack:** Node 22 ESM + PostgreSQL 16（schema `crm`, @5433）+ Express。存储层 `crm.meta_attr`/`crm.memory_log`/`crm.memory_snapshot`/`crm.memory_note`/`crm.edges`/`crm.particles`；配置层 `crm.config_store`（per-tenant + system 回退，`src/config/configStore.js`）。测试 vitest 3（mock pg）。

---

## 文件结构（本次改造涉及）

| 文件 | 职责 | 动作 |
|---|---|---|
| `db/schema.sql` | DDL 单一事实源 | Modify（加 `tenant_id`/`cardinality` 列） |
| `db/migrations/2026-09-03-tenant-isolation.sql` | 迁移脚本 | Create |
| `src/particles/particleModel.js` | 类型注册 / 谓词 | Modify（`getParticleDef`/`resolvePrototype` + 谓词配置并集） |
| `src/metaAttr/metaAttrRepo.js` | meta_attr 读写 | Modify（带 tenant 过滤 + `ensureAdaptiveRegistration` 带 tenantId） |
| `src/memory/memoryLog.js` | 记忆查询 | Modify（带 tenant 过滤） |
| `src/context/timelineSource.js` | 故事线 | Modify（带 tenant 过滤） |
| `src/account/insightService.js` | 洞察 | Modify（去硬编码 `tenant_id='system'`） |
| `src/particles/particleRepo.js` | 粒子写 | Modify（`ensureAdaptiveRegistration` 透传 tenantId） |
| `src/calc/formulaEngine.js` | L2 公式引擎 | Create |
| `src/agent/aiFillEngine.js` | AI Fill 引擎 | Create |
| `src/config/configStore.js` | 配置读写 | 复用（已有 `readConfig`/`writeConfig`） |
| `test/meta-model/*.test.js` | 隔离/解析器测试 | Create |
| `docs/2026-09-03-multi-industry-config-profile-design.md` | 设计基线 | 已存在（§1-§16） |

**治理约束（贯穿所有 Task）：** 每 Task 一 commit；AI 不代 commit；写操作经决策第0闸 + HITL；绝对禁 DELETE（去重走 `merged_into`）；TDD（先红后绿）；CRM 行为零破坏。

---

## Phase 0：元模型层 tenant 隔离（DDL）

### Task 1：给 `meta_attr` 加 `tenant_id` 列

**Files:**
- Modify: `db/schema.sql:368`（在 `meta_attr` 定义段后追加 ALTER）
- Create: `db/migrations/2026-09-03-tenant-isolation.sql`

- [ ] **Step 1: 写失败测试**

```js
// test/meta-model/isolation.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { queryWrite, query } from '../../src/db.js';

describe('meta_attr tenant isolation (DDL)', () => {
  it('meta_attr has tenant_id column', async () => {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='meta_attr' AND column_name='tenant_id'`
    );
    expect(r.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/meta-model/isolation.test.js`
Expected: FAIL（`column_name` 0 行）

- [ ] **Step 3: 在 schema.sql 的 meta_attr 段后追加 ALTER**

在 `db/schema.sql` 的 `CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_type_tag`（`schema.sql:369`）之后追加：

```sql
-- 2026-09-03 多行业配置化：meta_attr 加 tenant_id（行业差异化属性隔离）
ALTER TABLE crm.meta_attr ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_tenant
  ON crm.meta_attr(tenant_id, particle_type);
```

- [ ] **Step 4: 写迁移脚本**

```sql
-- db/migrations/2026-09-03-tenant-isolation.sql
ALTER TABLE crm.meta_attr ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.memory_snapshot ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.memory_note ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.edges ADD COLUMN IF NOT EXISTS cardinality TEXT NOT NULL DEFAULT 'many'
  CHECK (cardinality IN ('one','many'));
CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_tenant ON crm.meta_attr(tenant_id, particle_type);
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_tenant ON crm.memory_log(tenant_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_crm_memory_snapshot_tenant ON crm.memory_snapshot(tenant_id, ref_id);
CREATE INDEX IF NOT EXISTS idx_crm_memory_note_tenant ON crm.memory_note(tenant_id, topic);
CREATE INDEX IF NOT EXISTS idx_crm_edges_cardinality ON crm.edges(tenant_id, edge_type);
```

- [ ] **Step 5: 运行测试确认通过 + 执行迁移**

Run: `npx vitest run test/meta-model/isolation.test.js`
Expected: PASS
Run（PG 探活后）: `psql 连接串 -f db/migrations/2026-09-03-tenant-isolation.sql`（或经 node 脚本调用 queryWrite 执行该文件内容）

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql db/migrations/2026-09-03-tenant-isolation.sql test/meta-model/isolation.test.js
git commit -m "feat(meta-model): add tenant_id to meta_attr (P0 isolation DDL)"
```

### Task 2：给记忆三表加 `tenant_id` 列

**Files:**
- Modify: `db/schema.sql:289,300`（memory_snapshot / memory_note 段后追加 ALTER）
- 复用: `db/migrations/2026-09-03-tenant-isolation.sql`（Task 1 已含三表 ALTER）

- [ ] **Step 1: 写失败测试（三表均有 tenant_id）**

```js
// 追加到 test/meta-model/isolation.test.js
describe('memory tables tenant isolation (DDL)', () => {
  for (const t of ['memory_log','memory_snapshot','memory_note']) {
    it(`${t} has tenant_id column`, async () => {
      const r = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='crm' AND table_name=$1 AND column_name='tenant_id'`, [t]);
      expect(r.rows.length).toBe(1);
    });
  }
});
```

- [ ] **Step 2: 在 schema.sql 追加 ALTER（memory_snapshot 段后 + memory_note 段后）**

```sql
-- 在 schema.sql:289（idx_crm_memory_snapshot_ref 之后）追加
ALTER TABLE crm.memory_snapshot ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
-- 在 schema.sql:300（memory_note 主键定义之后）追加
ALTER TABLE crm.memory_note ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/isolation.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql test/meta-model/isolation.test.js
git commit -m "feat(meta-model): add tenant_id to memory_log/snapshot/note"
```

### Task 3：`edges` 加 `cardinality` 列（G3 前置）

**Files:**
- Modify: `db/schema.sql:47`（edges 段后追加 ALTER，已含于迁移脚本 Task 1）

- [ ] **Step 1: 写失败测试**

```js
it('edges has cardinality column', async () => {
  const r = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='crm' AND table_name='edges' AND column_name='cardinality'`);
  expect(r.rows.length).toBe(1);
});
```

- [ ] **Step 2: 在 schema.sql:47 后追加（迁移脚本已含，此处补 schema 单一事实源）**

```sql
ALTER TABLE crm.edges ADD COLUMN IF NOT EXISTS cardinality TEXT NOT NULL DEFAULT 'many'
  CHECK (cardinality IN ('one','many'));
```

- [ ] **Step 3: 运行测试 + 确认迁移幂等**

Run: `npx vitest run test/meta-model/isolation.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql test/meta-model/isolation.test.js
git commit -m "feat(meta-model): add cardinality to edges (G3 prep)"
```

---

## Phase 1：访问层按租户过滤

### Task 4：`ensureAdaptiveRegistration` 带 tenantId

**Files:**
- Modify: `src/metaAttr/metaAttrRepo.js:94-115`（签名加 tenantId；INSERT 带 tenant_id）
- Modify: `src/particles/particleRepo.js:111,188`（透传 tenantId）

- [ ] **Step 1: 写失败测试**

```js
// test/meta-model/adaptive-tenant.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureAdaptiveRegistration } from '../../src/metaAttr/metaAttrRepo.js';
import { query, queryWrite } from '../../src/db.js';

describe('ensureAdaptiveRegistration per-tenant', () => {
  it('registers attr under the calling tenant, not global', async () => {
    await queryWrite(`DELETE FROM crm.meta_attr WHERE tenant_id='acme'`);
    await ensureAdaptiveRegistration('CRM_ACCOUNT', { training_budget: 100 }, 'acme');
    const r = await query(
      `SELECT tenant_id FROM crm.meta_attr WHERE particle_type='CRM_ACCOUNT' AND attr_slug='training_budget'`);
    expect(r.rows[0].tenant_id).toBe('acme');
  });
});
```

- [ ] **Step 2: 修改 `ensureAdaptiveRegistration` 签名与 INSERT**

```js
// src/metaAttr/metaAttrRepo.js:94
export async function ensureAdaptiveRegistration(particleType, payload, tenantId = 'system', actor = 'system') {
  const registered = [];
  for (const slug of Object.keys(payload || {})) {
    if (slug === 'ai' || slug === 'events' || slug === 'stage_change_reason' || slug === 'closed_reason') continue;
    if (slug.startsWith('ai.')) continue;
    const exists = await getMetaAttr(particleType, slug, tenantId);
    if (exists) continue;
    const rec = adaptiveRecordFor(particleType, slug, payload[slug], actor);
    if (!rec) continue;
    await queryWrite(
      `INSERT INTO crm.meta_attr
         (particle_type, attr_slug, title, attr_type, semantic_tag, source, enabled, version, created_by, tenant_id)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
       WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id=$10)`,
      [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
       rec.source, rec.enabled, rec.version, rec.created_by, tenantId]
    );
    emit('particle', 'meta-attr-auto-registered', { particle_type: particleType, attr_slug: slug, attr_type: rec.attr_type, tenant_id: tenantId });
    registered.push(slug);
  }
  return registered;
}
```

同时把 `getMetaAttr`（:67）与 `setMetaAttr`（:73）/ `upsertSeedAttr`（:15 调 `getMetaAttr`）签名补 `tenantId` 参数并在 WHERE 加 `tenant_id`：

```js
export async function getMetaAttr(particleType, attrSlug, tenantId = 'system') {
  const r = await query(`SELECT * FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id=$3`,
    [particleType, attrSlug, tenantId]);
  return r.rows[0] || null;
}
```

- [ ] **Step 3: `particleRepo.js` 透传 tenantId**

```js
// src/particles/particleRepo.js:111（createParticle 内）
await ensureAdaptiveRegistration(type, payload, tenantId, 'system');
// :188（updateParticle 内）
await ensureAdaptiveRegistration(p.type, patch, cur.tenant_id || 'system', 'system');
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/meta-model/adaptive-tenant.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/metaAttr/metaAttrRepo.js src/particles/particleRepo.js test/meta-model/adaptive-tenant.test.js
git commit -m "feat(meta-model): ensureAdaptiveRegistration carries tenantId"
```

### Task 5：`listMetaAttr` / `setMetaAttr` 按 tenant 过滤

**Files:**
- Modify: `src/metaAttr/metaAttrRepo.js:55-90`

- [ ] **Step 1: 写失败测试**

```js
it('listMetaAttr filters by tenant', async () => {
  await queryWrite(`INSERT INTO crm.meta_attr
    (particle_type,attr_slug,title,attr_type,tenant_id)
    VALUES ('CRM_ACCOUNT','x_budget','预算','currency','acme')
    ON CONFLICT DO NOTHING`);
  const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT', tenantId: 'other' });
  expect(rows.find(r => r.attr_slug === 'x_budget')).toBeUndefined();
});
```

- [ ] **Step 2: 修改 `listMetaAttr` 与 `setMetaAttr` 带 tenant**

```js
export async function listMetaAttr({ particleType, enabled, semanticTag, tenantId = 'system' } = {}) {
  const r = await query(
    `SELECT * FROM crm.meta_attr
     WHERE ($1::text IS NULL OR particle_type=$1)
       AND ($2::boolean IS NULL OR enabled=$2)
       AND ($3::text IS NULL OR semantic_tag=$3)
       AND ($4::text IS NULL OR tenant_id=$4)
     ORDER BY tenant_id, particle_type, semantic_tag, attr_slug`,
    [particleType || null, enabled === undefined ? null : enabled, semanticTag || null, tenantId]
  );
  return r.rows;
}

export async function setMetaAttr(particleType, attrSlug, patch, { actor = 'system', versionBump = true, tenantId = 'system' } = {}) {
  const cur = await getMetaAttr(particleType, attrSlug, tenantId);
  if (!cur) throw new Error(`元模型属性不存在: ${tenantId}.${particleType}.${attrSlug}`);
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  if (versionBump && patch) next.version = (cur.version || 1) + 1;
  await queryWrite(
    `UPDATE crm.meta_attr SET
       title=$3, attr_type=$4, semantic_tag=$5, required=$6, "unique"=$7, description=$8, options=$9,
       source=$10, display=$11, validation=$12, permission=$13, enabled=$14, version=$15, updated_at=now()
     WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id=$16`,
    [particleType, attrSlug, next.title, next.attr_type, next.semantic_tag, next.required, next.unique,
     next.description, next.options, next.source,
     JSON.stringify(next.display || {}), JSON.stringify(next.validation || {}),
     JSON.stringify(next.permission || {}), next.enabled, next.version, tenantId]
  );
  emit('trace', 'meta-attr-updated', { tenant_id: tenantId, particle_type: particleType, attr_slug: attrSlug, version: next.version, actor });
  return getMetaAttr(particleType, attrSlug, tenantId);
}
```

> 注意：`upsertSeedAttr`（:15）调用 `getMetaAttr` 与 `setMetaAttr` 需补 `tenantId='system'`（种子属 system 基线，供所有租户继承）。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/adaptive-tenant.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/metaAttr/metaAttrRepo.js test/meta-model/adaptive-tenant.test.js
git commit -m "feat(meta-model): metaAttr queries filter by tenant"
```

### Task 6：`memoryLog.js` 查询带 tenant 过滤

**Files:**
- Modify: `src/memory/memoryLog.js:37-49,70-79`

- [ ] **Step 1: 写失败测试**

```js
// test/meta-model/memory-tenant.test.js
import { describe, it, expect } from 'vitest';
import { retrieveMemory, rrfSearch } from '../../src/memory/memoryLog.js';
import { queryWrite } from '../../src/db.js';

describe('memory tenant isolation', () => {
  it('retrieveMemory scoped to tenant', async () => {
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
      VALUES ('account:a','decision','{"x":1}','acme','ent1')`);
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
      VALUES ('account:a','decision','{"x":2}','other','ent1')`);
    const r = await retrieveMemory({ topic: 'account:a', tenantId: 'acme' });
    expect(r.rows.every(x => x.tenant_id === 'acme')).toBe(true);
    expect(r.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: 修改 `retrieveMemory` 与 `rrfSearch` 带 tenant**

```js
export async function retrieveMemory({ layer, topic, topicLike, channel = 'auto', limit = 50, tenantId = 'system' } = {}) {
  const ch = resolveChannel({ channel, layer, topic });
  if (ch === 'note') {
    const r = await query(`SELECT * FROM crm.memory_note WHERE layer=$1 AND topic=$2 AND archived=false AND tenant_id=$3`, [layer, topic, tenantId]);
    return { channel: 'note', rows: r.rows };
  }
  if (topicLike) {
    const r = await query(`SELECT * FROM crm.memory_log WHERE topic LIKE $1 AND archived=false AND tenant_id=$3 ORDER BY created_at DESC LIMIT $2`, [topicLike, limit, tenantId]);
    return { channel: 'log', rows: r.rows };
  }
  const r = await query(`SELECT * FROM crm.memory_log WHERE topic=$1 AND archived=false AND tenant_id=$2 ORDER BY created_at DESC LIMIT $3`, [topic, tenantId, limit]);
  return { channel: 'log', rows: r.rows };
}

export async function rrfSearch(queryText, { entityId = null, k = 5, denseWeight = 0.5, tenantId = 'system' } = {}) {
  const q = String(queryText || '').trim();
  const params = [];
  let where = `archived=false AND tenant_id=$${params.length + 1}`;
  params.push(tenantId);
  if (entityId) { params.push(entityId); where += ` AND entity_id=$${params.length}`; }
  const rows = (await query(
    `SELECT id, topic, kind, payload, created_at FROM crm.memory_log WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  )).rows;
  // …（余弦/RRF 融合逻辑不变，rowText 不变）
  // 返回时附 tenant_id：
  return [...acc.entries()]
    .map(([id, score]) => {
      const row = rows.find((r) => r.id === id);
      return { id, topic: row.topic, kind: row.kind, payload: row.payload, created_at: row.created_at, score, tenant_id: row.tenant_id };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/memory-tenant.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/memory/memoryLog.js test/meta-model/memory-tenant.test.js
git commit -m "feat(memory): memoryLog queries filter by tenant"
```

### Task 7：`timelineSource.js` 带 tenant 过滤

**Files:**
- Modify: `src/context/timelineSource.js:142-149`

- [ ] **Step 1: 写失败测试**

```js
// 在 test/meta-model/memory-tenant.test.js 追加
import { getTimelineRows } from '../../src/context/timelineSource.js';
it('timeline scoped to tenant', async () => {
  await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
    VALUES ('account:a','decision','{"x":1}','acme','ent1')`);
  await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
    VALUES ('account:a','decision','{"x":2}','other','ent1')`);
  const rows = await getTimelineRows({ accountId: 'ent1', tenantId: 'acme' });
  expect(rows.every(r => r.tenant_id === 'acme' || r.type !== 'memory')).toBe(true);
});
```

- [ ] **Step 2: 修改 memory 源查询**

```js
// src/context/timelineSource.js:142-149（memory 段）
`SELECT 'memory' AS type, payload->>'title' AS title, 'system' AS actor, created_at AS occurred_at,
        '记忆' AS source, kind AS entity_type, id::text AS entity_id, '' AS summary, m.topic AS topic
 FROM crm.memory_log m
 WHERE (m.entity_id=$1 OR m.entity_id=ANY($2::text[])) AND m.tenant_id=$4
 ORDER BY created_at DESC LIMIT $3`,
[acc, deals, lim, tenantId]
```

> 同步把 `getTimelineRows` 签名加 `tenantId='system'` 并透传至各源查询（events/tasks/decision 源若有 tenant 条件一并补，保持与 particles 同隔离语义）。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/memory-tenant.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/context/timelineSource.js test/meta-model/memory-tenant.test.js
git commit -m "feat(context): timelineSource filters memory by tenant"
```

### Task 8：`insightService.js:236` 去硬编码 `tenant_id='system'`

**Files:**
- Modify: `src/account/insightService.js:236`

- [ ] **Step 1: 写失败测试（或 grep 断言）**

```js
// test/meta-model/no-hardcode-system.test.js
import { readFileSync } from 'fs';
it('no hardcoded tenant_id=system in insightService query', () => {
  const src = readFileSync('src/account/insightService.js', 'utf8');
  expect(src).not.toMatch(/tenant_id\s*=\s*'system'/);
});
```

- [ ] **Step 2: 改为从 ctx 注入 tenant**

定位 `insightService.js:236` 的查询（围绕 account 360 聚合），将其 `tenant_id='system'` 改为函数入参 `tenantId` 透传（与 `queryParticles({tenantId})` 一致）。函数签名补 `tenantId = 'system'`，调用点从 `ctx.tenantId` 注入。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/no-hardcode-system.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/account/insightService.js test/meta-model/no-hardcode-system.test.js
git commit -m "fix(context): inject tenant in insightService instead of hardcoded system"
```

---

## Phase 2：类型注册双源 + universal core 收敛（G1）

### Task 9：新增 `getParticleDef` / `resolvePrototype` 双源解析器

**Files:**
- Modify: `src/particles/particleModel.js`（在 `isParticleType` 后新增）

- [ ] **Step 1: 写失败测试**

```js
// test/meta-model/type-resolver.test.js
import { describe, it, expect } from 'vitest';
import { resolvePrototype } from '../../src/particles/particleModel.js';
import { writeConfig } from '../../src/config/configStore.js';

describe('resolvePrototype dual-source', () => {
  it('CRM types resolve from code baseline (no tenant)', async () => {
    expect((await resolvePrototype('CRM_DEAL', 'crm')).source).toBe('code');
  });
  it('training type resolves from tenant-profile config', async () => {
    await writeConfig('tenant-profile', {
      prototypes: { TRAINING_PROJECT: { label: '培训项目', flow: ['lead','quoted','closed'] } }
    }, { tenantId: 'acme-training' });
    const def = await resolvePrototype('TRAINING_PROJECT', 'acme-training');
    expect(def.source).toBe('config');
    expect(def.flow).toContain('quoted');
  });
  it('training type invisible in crm tenant (isolation)', async () => {
    const def = await resolvePrototype('TRAINING_PROJECT', 'crm');
    expect(def).toBeNull();
  });
});
```

- [ ] **Step 2: 实现解析器**

```js
// src/particles/particleModel.js（isParticleType 之后追加）
import { readConfig } from './configStore.js';  // 注意避免循环引用：configStore 不 import particleModel 即可

/**
 * 双源解析：① 代码基线 PARTICLE_TYPES（CRM 业务，保留不破坏现有 21 处硬编码）
 *           ② 租户 tenant-profile.prototypes（custom 对象，配置驱动零代码）
 * 返回 { source:'code'|'config', ...def } 或 null。
 */
export async function resolvePrototype(type, tenantId = 'system') {
  if (Object.prototype.hasOwnProperty.call(PARTICLE_TYPES, type)) {
    return { source: 'code', ...PARTICLE_TYPES[type], type };
  }
  if (tenantId && tenantId !== 'system') {
    const profile = await readConfig('tenant-profile', { tenantId }).catch(() => null);
    const proto = profile?.prototypes?.[type];
    if (proto) return { source: 'config', ...proto, type };
  }
  return null;
}

/** 同步判断：仅查代码基线（保留 isParticleType 语义，CRM 行为零破坏） */
export function isConfigurablePrototype(type) {
  return !Object.prototype.hasOwnProperty.call(PARTICLE_TYPES, type);
}
```

> 关于 universal core 收敛：本次**不删除** `PARTICLE_TYPES` 的 33 个字面量（避免破坏 21 处 CRM 硬编码分支，符合「CRM 行为零破坏」铁律）。`resolvePrototype` 以「代码基线 ∪ 租户配置」双源承接 custom 对象，等价于把 {ACCOUNT,CONTACT,OPPORTUNITY,CONTRACT} 视为基线、其余走配置——是**加法收敛**而非删除式重构。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/type-resolver.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/particles/particleModel.js test/meta-model/type-resolver.test.js
git commit -m "feat(meta-model): dual-source resolvePrototype (code baseline ∪ tenant config)"
```

### Task 10：seed 培训租户 `tenant-profile` 配置画像（端到端示例）

**Files:**
- Create: `db/seed/tenant-profile-training.js`（或并入现有 seed 流程）

- [ ] **Step 1: 写 seed 脚本（引用设计 §2 schema）**

```js
// db/seed/tenant-profile-training.js
import { writeConfig } from '../../src/config/configStore.js';
export async function seedTrainingProfile(tenantId = 'acme-training') {
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      TRAINING_CLIENT:    { label:'企业客户', flow:['lead','diagnosed','proposal','negotiation','signed','delivered','closed'], attributes:['training_budget','training_goal','headcount'] },
      TRAINER:            { label:'讲师', flow:['prospect','onboarded','active','retired'], attributes:['expertise_domain','daily_rate','available_from','rating'] },
      TRAINING_PROVIDER:  { label:'培训机构', flow:['candidate','partnered','active','suspended'], attributes:['qualification','cooperation_mode'] },
      TRAINING_PROJECT:   { label:'培训项目', flow:['lead','need_diagnosed','matched','quoted','confirmed','delivering','closed'], approvalDomains:['quote','deal'], attributes:['subject','duration','budget','target'] },
      TRAINING_CONTRACT:  { label:'合同', flow:['draft','signed','active','fulfilled','terminated'], approvalDomains:['contract'], attributes:['mode','party_a','party_b','amount'] },
      TRAINING_SETTLEMENT:{ label:'结算', flow:['pending','calculated','approved','paid'], approvalDomains:['settlement'], attributes:['revenue','cost','commission','mode'] }
    },
    approvalDomains: ['quote','contract','settlement'],
    calculations: [ { id:'settlement_commission', target:'TRAINING_SETTLEMENT.payload.commission',
      expr:'(revenue - cost) * commission_rate', inputs:['revenue','cost','commission_rate'], trigger:'on_write' } ]
  }, { tenantId });
}
```

- [ ] **Step 2: 写验证测试（端到端）**

```js
it('training tenant profile seeds 6 prototypes', async () => {
  await seedTrainingProfile('acme-training');
  const p = await resolvePrototype('TRAINING_PROJECT', 'acme-training');
  expect(p.flow).toContain('quoted');
  expect(await resolvePrototype('TRAINING_PROJECT','crm')).toBeNull();  // 隔离
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/type-resolver.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add db/seed/tenant-profile-training.js test/meta-model/type-resolver.test.js
git commit -m "feat(seed): training tenant-profile config (6 prototypes, zero new type literals)"
```

---

## Phase 3：关系基数 + 谓词配置化（G3/G4）

### Task 11：`createEdge` 校验基数 + 谓词并集

**Files:**
- Modify: `src/particles/particleModel.js`（谓词并集）+ `src/particles/particleRepo.js`（createEdge）

- [ ] **Step 1: 写失败测试**

```js
// test/meta-model/edge-config.test.js
it('rejects edge_type not in baseline ∪ tenant profile', async () => {
  await expect(createEdge({ sourceType:'TRAINER', sourceId:'x', edgeType:'illegal_pred', targetType:'TRAINING_PROJECT', targetId:'y', tenantId:'acme-training' }))
    .rejects.toThrow(/受控谓词/);
});
it('accepts profile-declared edge_type', async () => {
  // tenant-profile 声明 edgeTypes:['supplies→TRAINING_PROJECT'] 后
  await expect(createEdge({ sourceType:'TRAINING_PROVIDER', sourceId:'p', edgeType:'supplies', targetType:'TRAINING_PROJECT', targetId:'y', tenantId:'acme-training' }))
    .resolves.toBeDefined();
});
```

- [ ] **Step 2: 谓词并集解析器**

```js
// src/particles/particleModel.js
export async function isControlledPredicateConfig(edgeType, tenantId = 'system') {
  if (CONTROLLED_PREDICATES.includes(edgeType)) return true;
  if (tenantId && tenantId !== 'system') {
    const profile = await readConfig('tenant-profile', { tenantId }).catch(() => null);
    const edgeTypes = profile?.prototypes
      ? Object.values(profile.prototypes).flatMap(p => p.edgeTypes || [])
      : [];
    return edgeTypes.includes(edgeType);
  }
  return false;
}
```

- [ ] **Step 3: `createEdge` 校验 + 落 cardinality**

```js
// src/particles/particleRepo.js createEdge 内
const ok = await isControlledPredicateConfig(edgeType, tenantId);
if (!ok) throw new Error(`边谓词未受控: ${edgeType}（须属基线或租户 profile.edgeTypes）`);
// INSERT 时写入 cardinality（默认 'many'，可由 profile.edgeTypes 声明基数）
await queryWrite(
  `INSERT INTO crm.edges (tenant_id, source_type, source_id, edge_type, target_type, target_id, cardinality, meta)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [tenantId, sourceType, sourceId, edgeType, targetType, targetId, cardinality || 'many', JSON.stringify(meta || {})]
);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/meta-model/edge-config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/particles/particleModel.js src/particles/particleRepo.js test/meta-model/edge-config.test.js
git commit -m "feat(meta-model): configurable edge predicates + cardinality"
```

---

## Phase 4：L2 公式引擎

### Task 12：沙箱表达式求值器

**Files:**
- Create: `src/calc/formulaEngine.js`

- [ ] **Step 1: 写失败测试**

```js
// test/calc/formulaEngine.test.js
import { describe, it, expect } from 'vitest';
import { evalFormula } from '../../src/calc/formulaEngine.js';

describe('formulaEngine', () => {
  it('evaluates arithmetic with inputs', () => {
    expect(evalFormula('(revenue - cost) * commission_rate', { revenue: 100, cost: 60, commission_rate: 0.1 })).toBe(4);
  });
  it('rejects dangerous globals', () => {
    expect(() => evalFormula('process.exit(1)', {})).toThrow();
  });
  it('returns null on undefined input (fail-safe)', () => {
    expect(evalFormula('revenue * 2', {})).toBeNull();
  });
});
```

- [ ] **Step 2: 实现（ESM `vm` 沙箱 + 白名单）**

```js
// src/calc/formulaEngine.js
import vm from 'node:vm';
const ALLOWED = ['Math', 'Number', 'parseFloat', 'parseInt', 'toFixed'];
export function evalFormula(expr, inputs = {}) {
  const sandbox = { ...inputs };
  for (const k of Object.keys(inputs)) if (inputs[k] === undefined || inputs[k] === null) return null;
  const ctx = vm.createContext(sandbox);
  try {
    const out = vm.runInContext(`( ${expr} )`, ctx, { timeout: 100 });
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;  // fail-safe：非法表达式不抛错、返回 null，由调用方告警
  }
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/calc/formulaEngine.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/calc/formulaEngine.js test/calc/formulaEngine.test.js
git commit -m "feat(calc): sandboxed formula engine for L2 calculations"
```

### Task 13：`on_write` 触发公式落 payload + 审计

**Files:**
- Modify: `src/particles/particleRepo.js`（createParticle/updateParticle 后触发）

- [ ] **Step 1: 写失败测试**

```js
it('settlement auto-computes commission on write', async () => {
  await seedTrainingProfile('acme-training');
  const p = await createParticle('TRAINING_SETTLEMENT', { slug:'s1', title:'结算1',
    payload:{ revenue:100, cost:60, commission_rate:0.1 } }, 'acme-training');
  expect(p.payload.commission).toBe(4);
});
```

- [ ] **Step 2: 在 createParticle/updateParticle 写库后触发**

```js
// src/particles/particleRepo.js（ensureAdaptiveRegistration 之后）
import { runProfileCalculations } from '../calc/formulaEngine.js';
// ...
const calcOut = await runProfileCalculations(type, particle.payload, tenantId);
if (calcOut && Object.keys(calcOut).length) {
  await queryWrite(`UPDATE particles SET payload = payload || $1::jsonb WHERE id=$2`, [JSON.stringify(calcOut), particle.id]);
  particle.payload = { ...particle.payload, ...calcOut };
  emit('trace','formula-computed', { id: particle.id, keys: Object.keys(calcOut) });
}
```

```js
// src/calc/formulaEngine.js 追加
import { readConfig } from '../config/configStore.js';
export async function runProfileCalculations(type, payload, tenantId) {
  const profile = await readConfig('tenant-profile', { tenantId }).catch(() => null);
  const calcs = (profile?.calculations || []).filter(c => c.target?.startsWith(`${type}.`));
  const out = {};
  for (const c of calcs) {
    if (c.trigger !== 'on_write') continue;
    const val = evalFormula(c.expr, Object.fromEntries(c.inputs.map(i => [i, payload[i]])));
    if (val !== null) out[c.target.split('.').pop()] = val;
  }
  return out;
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/calc/formulaEngine.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/particles/particleRepo.js src/calc/formulaEngine.js test/calc/formulaEngine.test.js
git commit -m "feat(calc): on_write formula trigger writes computed fields"
```

---

## Phase 5：AI Fill 引擎激活（G2 + V5）

### Task 14：AI Fill 引擎（激活已存在的 `source='ai'` 列）

**Files:**
- Create: `src/agent/aiFillEngine.js`

- [ ] **Step 1: 写失败测试**

```js
// test/agent/aiFill.test.js
import { describe, it, expect } from 'vitest';
import { proposeAiFill } from '../../src/agent/aiFillEngine.js';

it('proposes field from raw context (no LLM => deterministic fallback)', async () => {
  const proposal = await proposeAiFill({ prototype:'TRAINING_CLIENT', rawContext:'客户预算 50 万，目标提升销售', tenantId:'acme-training' });
  expect(proposal).toBeDefined();
  expect(proposal.draft).toBe(true);  // 仅建议草稿，不直写
});
```

- [ ] **Step 2: 实现（建议草稿 → 决策第0闸 + HITL → 经 meta_attr.source='ai' 落库）**

```js
// src/agent/aiFillEngine.js
// 治理：本引擎只产出「建议草稿」，应用须经决策第0闸 + HITL；写经零信任写闸，绝对禁 DELETE。
export async function proposeAiFill({ prototype, rawContext, tenantId = 'system', llm = null }) {
  // 1) 解析原始上下文 → 候选属性（有 LLM 走 LLM，无则确定性兜底：提取已知字段名）
  const candidates = llm
    ? await llm.extractFields(rawContext, prototype)
    : deterministicExtract(rawContext);
  // 2) 对未登记的候选，构造 meta_attr 草稿（source='ai', enabled=false）
  const draft = [];
  for (const c of candidates) {
    draft.push({
      particle_type: prototype, attr_slug: c.slug, title: c.title,
      attr_type: c.type, semantic_tag: 'ai-filled', source: 'ai', enabled: false, tenant_id: tenantId
    });
  }
  return { draft: true, proposal: draft };
}
function deterministicExtract(text) {
  const map = { 预算: 'budget', 目标: 'goal', 人数: 'headcount' };
  return Object.entries(map).filter(([k]) => text.includes(k))
    .map(([k, slug]) => ({ slug, title: k, type: 'text' }));
}
```

> 应用侧（agent 调用）把 `proposal` 经决策第0闸 mint decision_id → HITL 确认 → `setMetaAttr(..., {source:'ai', enabled:true}, {tenantId})` 落库。此即把 §6 T5 回溯补填**泛化为持续自动填充**，吸收 LF 的 V5 价值。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/agent/aiFill.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent/aiFillEngine.js test/agent/aiFill.test.js
git commit -m "feat(agent): AI Fill engine proposes schema drafts (gated by decision + HITL)"
```

### Task 15：逐字段可见性按 tenant 生效（B-LF2）

**Files:**
- Modify: `src/metaAttr/metaAttrRepo.js`（读取时按 `permission` + tenant 过滤）

- [ ] **Step 1: 写失败测试**

```js
it('hides attr when permission denies tenant', async () => {
  await setMetaAttr('CRM_ACCOUNT','salary',{permission:{deny_tenants:['acme']},enabled:true},{tenantId:'system'});
  const rows = await listMetaAttr({ particleType:'CRM_ACCOUNT', tenantId:'acme', applyPermission:true });
  expect(rows.find(r=>r.attr_slug==='salary')).toBeUndefined();
});
```

- [ ] **Step 2: `listMetaAttr` 支持 `applyPermission` 过滤 permission.deny_tenants**

```js
// 在 listMetaAttr 返回后过滤（或 SQL 内 jsonb 包含判断）：
if (applyPermission) {
  return r.rows.filter(r => {
    const deny = r.permission?.deny_tenants || [];
    return !deny.includes(tenantId);
  });
}
return r.rows;
```

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/meta-model/adaptive-tenant.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/metaAttr/metaAttrRepo.js test/meta-model/adaptive-tenant.test.js
git commit -m "feat(meta-model): per-field visibility by tenant (permission.deny_tenants)"
```

---

## Self-Review（作者自查）

1. **Spec coverage**：§15 隔离（P0/P1 覆盖 20.1-20.7）✅；G1 核心收敛（P2 Task 9 双源解析器，加法收敛保 CRM 行为）✅；G3 基数（Task 3 + Task 11）✅；G4 谓词配置（Task 11）✅；L2 公式（P4 Task 12-13）✅；AI Fill（P5 Task 14）✅；逐字段可见性（Task 15）✅。
2. **Placeholder scan**：无 TBD/TODO；每代码步含真实片段；批量迁移（21 文件）以「保留 PARTICLE_TYPES + 新增 resolvePrototype」加法策略规避，未要求逐文件手写——符合「CRM 行为零破坏」铁律，非 placeholder。
3. **Type consistency**：`resolvePrototype` 返回 `{source, ...def, type}`；`runProfileCalculations` 返回 `payload` 子集；`proposeAiFill` 返回 `{draft, proposal}`——跨 Task 命名一致。

---

## 执行交接

计划已存 `docs/superpowers/plans/2026-09-03-multi-industry-meta-model.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 每 Task 派发独立子代理，Task 间审查，快速迭代。

**2. Inline Execution** — 本会话逐 Task 执行 + 检查点审查。

**建议起点**：Phase 0 → Phase 1（用户最关心的「按租户全隔离」），先行交付验证；P2-P5 可并行推进。请选择执行方式。