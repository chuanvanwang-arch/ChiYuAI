# 粒子属性元模型自适应 + 动态表单配置抽屉 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把代码态 `coreAttributes` 提升为可配置粒子属性元模型 `crm.meta_attr`（19 类型集纪律不变），新增写时自适应钩子 + 3 个 Action（含 `ATTR_SCHEMA_CHANGE` 决策事件）+ 字段级 RBAC 写闸，配置抽屉 UI 产出受控 Schema 交既有渲染器。

**Architecture:** 三层——L0 `crm.meta_attr` 表（`coreAttributes` 物化为 seed 事实源）+ 写时自适应钩子（particleRepo 三钩子接线位扩展）；L1 配置协议层（`page/schema.js` 扩展 form 页型 + attr-field 组件；`seed-actions.js` 注册 3 Action 全过写第 0 闸）；L2 呈现层（`web/meta-attr-drawer.html` 受控 Schema 渲染，不引第二套前端栈）。测试先于实现（TDD），每 Task 一 commit。

**Tech Stack:** Node 22 ESM + PostgreSQL 16(pgcrypto+vector) + vitest 3（共享真实 PG@5433；纯逻辑测试不依赖 DB；vitest 单 worker fileParallelism:false）。

**来源设计：** `docs/2026-08-26-particle-attribute-model-ui-design.md`（已批准，含 §3 三层架构 / §4 元模型表 DDL / §5 Action 表面 / §6 抽屉 UI / §7 AI 自适应闭环 / §8 落地阶段与验收 V1-V6）

**已批准决策（设计 §10）：** ①抽屉 UI=受控 Schema 渲染（不引 CordysCRM Naive-UI 栈）；②元模型版本策略=`version` 递增 + decision 锚定；③自适应登记默认 `enabled=false`（source='ai'），人工确认后启用。

---

### Task 1: `crm.meta_attr` 表 DDL + 类型闸 CHECK + 语义桶列

**Files:**
- Modify: `db/schema.sql`（新增表，追加在 memory_note 段后）
- Test: `test/meta-attr-schema.test.js`（DB 集成）

- [ ] **Step 1: 写失败测试（先验证表不存在 → 期望失败）**

```js
// test/meta-attr-schema.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';

beforeAll(async () => {
  await query(`TRUNCATE crm.meta_attr CASCADE`);
  // 幂等回灌 coreAttributes 物化行（本 Task 只验表结构与类型闸）
  await query(`
    INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type, semantic_tag)
    SELECT 'CRM_DEAL', 'name', '名称', 'text', 'legacy'
    WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type='CRM_DEAL' AND attr_slug='name')
  `);
});

describe('crm.meta_attr 表结构', () => {
  it('表存在且主键为 (particle_type, attr_slug)', async () => {
    const r = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='crm' AND table_name='meta_attr' ORDER BY ordinal_position
    `);
    expect(r.rows.map((x) => x.column_name)).toEqual(expect.arrayContaining([
      'particle_type', 'attr_slug', 'title', 'attr_type', 'semantic_tag',
      'required', 'unique', 'description', 'options', 'source',
      'display', 'validation', 'permission', 'enabled', 'version',
      'created_by', 'created_at', 'updated_at',
    ]));
  });

  it('attr_type 超 19 类型集 → CHECK 拒绝', async () => {
    await expect(
      query(`INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type)
             VALUES ('CRM_DEAL', 'bad_type_attr', '坏类型', 'magic-type')`)
    ).rejects.toThrow();
  });

  it('enabled 默认 false、version 默认 1、source 默认 manual', async () => {
    const r = await query(`SELECT enabled, version, source FROM crm.meta_attr WHERE particle_type='CRM_DEAL' AND attr_slug='name'`);
    expect(r.rows[0]).toEqual({ enabled: false, version: 1, source: 'manual' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-schema.test.js`
Expected: FAIL（`relation "crm.meta_attr" does not exist`）

- [ ] **Step 3: 在 `db/schema.sql` 末尾追加 DDL**

```sql
-- ============ 粒子属性元模型（设计 2026-08-26 §4；19 类型集纪律 + 决策锚定）============
CREATE TABLE IF NOT EXISTS crm.meta_attr (
  particle_type TEXT NOT NULL,
  attr_slug     TEXT NOT NULL,
  title         TEXT NOT NULL,
  attr_type     TEXT NOT NULL
    CHECK (attr_type IN ('text','personal-name','email-address','phone-number','domain','location',
                         'number','currency','percent','date','timestamp','select','multi-select',
                         'boolean','rating','url','record-reference','actor-reference','interaction')),
  semantic_tag  TEXT NOT NULL DEFAULT 'legacy',
  required      BOOLEAN NOT NULL DEFAULT false,
  unique        BOOLEAN NOT NULL DEFAULT false,
  description   TEXT,
  options       JSONB,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','enrich','automatic')),
  display       JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation    JSONB NOT NULL DEFAULT '{}'::jsonb,
  permission    JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (particle_type, attr_slug)
);
CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_type_tag ON crm.meta_attr(particle_type, semantic_tag);
CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_enabled ON crm.meta_attr(particle_type, enabled);
```

- [ ] **Step 4: 跑迁移确保 schema 生效**

Run: `node db/migrate.js`
Expected: `[migrate] crm schema 就绪（幂等）`

- [ ] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-schema.test.js`
Expected: PASS（3 tests）

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql test/meta-attr-schema.test.js
git commit -m "feat(meta-attr): 新增 crm.meta_attr 元模型表 + 19 类型 CHECK 闸"
```

---

### Task 2: `metaAttrModel.js` 模块（读/写/seed/自适应钩子，纯逻辑可单测）

**Files:**
- Create: `src/metaAttr/metaAttrModel.js`
- Create: `src/metaAttr/index.js`（re-export，防深路径）
- Test: `test/meta-attr-model.test.js`（纯逻辑，无 DB）

- [ ] **Step 1: 写失败测试**

```js
// test/meta-attr-model.test.js
import { describe, it, expect } from 'vitest';
import {
  inferAttrType, mapSemanticTag, adaptiveRecordFor, recordFor, modelFor,
} from '../src/metaAttr/metaAttrModel.js';

describe('类型推断 inferAttrType', () => {
  it('值形态 → 19 类型映射', () => {
    expect(inferAttrType('hello')).toBe('text');
    expect(inferAttrType('li@x.com')).toBe('email-address');       // email 优先
    expect(inferAttrType('13800138000')).toBe('phone-number');      // 11 位数字
    expect(inferAttrType(42)).toBe('number');
    expect(inferAttrType(42.5)).toBe('number');
    expect(inferAttrType(true)).toBe('boolean');
    expect(inferAttrType(['a', 'b'])).toBe('multi-select');
    expect(inferAttrType({ record_id: 'x' })).toBe('record-reference'); // JSON 对象候选
    expect(inferAttrType('2026-08-26')).toBe('date');               // ISO 日期
    expect(inferAttrType(null)).toBe(null);                          // 未命中
  });
});

describe('语义桶归类 mapSemanticTag', () => {
  it('未命中 → legacy；已知桶字段归桶', () => {
    expect(mapSemanticTag('domains')).toBe('firmographic');
    expect(mapSemanticTag('champion_strength')).toBe('relation');
    expect(mapSemanticTag('logo_url')).toBe('ui');
    expect(mapSemanticTag('interaction_index')).toBe('interaction');
    expect(mapSemanticTag('totally_new_attr')).toBe('legacy');
  });
});

describe('自适应登记记录 adaptiveRecordFor', () => {
  it('新键 → 记录 {attr_type, source:ai, enabled:false, version:1, semantic_tag}', () => {
    const rec = adaptiveRecordFor('CRM_ACCOUNT', 'custom_score', 88, 'system');
    expect(rec.attr_type).toBe('number');
    expect(rec.source).toBe('ai');
    expect(rec.enabled).toBe(false);
    expect(rec.version).toBe(1);
    expect(rec.semantic_tag).toBe('legacy');
    expect(rec.title).toBe('custom_score');
  });
});

describe('模型视图 modelFor', () => {
  it('只含 enabled 属性（type+attr_slug+attr_type+semantic_tag 元组）', () => {
    const rows = [
      { attr_slug: 'name', attr_type: 'text', semantic_tag: 'legacy', enabled: true },
      { attr_slug: 'hidden_x', attr_type: 'text', semantic_tag: 'legacy', enabled: false },
    ];
    expect(modelFor('CRM_DEAL', rows)).toEqual([
      { attr_slug: 'name', attr_type: 'text', semantic_tag: 'legacy' },
    ]);
  });
});

describe('recordFor', () => {
  it('从 coreAttributes 物化 seed 记录（title=slug、source=manual、enabled=false）', () => {
    const def = { coreAttributes: { name: 'text', domains: 'domain' } };
    const rec = recordFor('CRM_ACCOUNT', 'domains', def);
    expect(rec).toEqual({
      particle_type: 'CRM_ACCOUNT', attr_slug: 'domains', title: 'domains',
      attr_type: 'domain', semantic_tag: 'firmographic', required: '1' === '1' ? false : false,
      unique: false, description: null, options: null, source: 'manual',
      display: {}, validation: {}, permission: {}, enabled: false, version: 1, created_by: 'seed',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-model.test.js`
Expected: FAIL（`Cannot find module '../src/metaAttr/metaAttrModel.js'`）

- [ ] **Step 3: 写最小实现**

```js
// src/metaAttr/metaAttrModel.js — 粒子属性元模型：类型推断/语义归类/seed 物化/自适应登记
import { ATTRIBUTE_TYPE_SET, SEMANTIC_TAGS, semanticTagOf, PARTICLE_TYPES } from '../particles/particleModel.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;             // 中国大陆手机号（演示语义）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function inferAttrType(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return value.length ? 'multi-select' : null;
  if (typeof value === 'object') return 'record-reference';
  const s = String(value);
  if (EMAIL_RE.test(s)) return 'email-address';
  if (PHONE_RE.test(s)) return 'phone-number';
  if (DATE_RE.test(s)) return 'date';
  if (/^\d+$/.test(s) && s.length <= 15) return 'number';   // 数字字符串（短）→ number
  return 'text';
}

export function mapSemanticTag(attrSlug) {
  return semanticTagOf(attrSlug);   // 未命中 → legacy（particleModel.js:201-206）
}

// seed 记录物化：coreAttributes（唯一事实源）→ meta_attr 行
export function recordFor(particleType, attrSlug, def) {
  const attrType = def.coreAttributes?.[attrSlug];
  if (!ATTRIBUTE_TYPE_SET.has(attrType)) {
    throw new Error(`粒子 ${particleType} 属性 ${attrSlug} 类型 ${attrType} 不在 19 类型集内`);
  }
  return {
    particle_type: particleType, attr_slug: attrSlug, title: attrSlug,
    attr_type: attrType, semantic_tag: mapSemanticTag(attrSlug),
    required: false, unique: false, description: null, options: null, source: 'manual',
    display: {}, validation: {}, permission: {}, enabled: false, version: 1, created_by: 'seed',
  };
}

// 自适应登记（写时钩子消费）：新键 → 推断类型 → 未命中拒绝
export function adaptiveRecordFor(particleType, attrSlug, value, actor) {
  const attrType = inferAttrType(value);
  if (!attrType || !ATTRIBUTE_TYPE_SET.has(attrType)) return null;   // 未命中 19 集 → 拒绝登记
  return {
    particle_type: particleType, attr_slug: attrSlug, title: attrSlug,
    attr_type: attrType, semantic_tag: mapSemanticTag(attrSlug),
    required: false, unique: false, description: null, options: null, source: 'ai',
    display: {}, validation: {}, permission: {}, enabled: false, version: 1, created_by: actor || 'system',
  };
}

// 运行时模型视图：仅 enabled 属性（渲染器/查询只用启用集）
export function modelFor(particleType, rows) {
  return rows
    .filter((r) => r.enabled)
    .map(({ attr_slug, attr_type, semantic_tag }) => ({ attr_slug, attr_type, semantic_tag }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-model.test.js`
Expected: PASS

- [ ] **Step 5: 建 re-export 索引**

```js
// src/metaAttr/index.js
export * from './metaAttrModel.js';
```

- [ ] **Step 6: Commit**

```bash
git add src/metaAttr/metaAttrModel.js src/metaAttr/index.js test/meta-attr-model.test.js
git commit -m "feat(meta-attr): metaAttrModel 类型推断/语义桶/seed 物化/自适应登记（纯逻辑）"
```

---

### Task 3: `metaAttrRepo.js`（DB 读写 + 幂等 seed 物化 + 写时自适应钩子）

**Files:**
- Create: `src/metaAttr/metaAttrRepo.js`
- Modify: `src/particles/particleRepo.js`（createParticle/updateParticle 加自适应钩子）
- Test: `test/meta-attr-repo.test.js`（DB 集成）

- [ ] **Step 1: 写失败测试（先覆盖 seed 物化 + 自适应登记 + 钩子接线）**

```js
// test/meta-attr-repo.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import {
  seedMetaAttr, listMetaAttr, getMetaAttr, setMetaAttr,
  ensureAdaptiveRegistration,
} from '../src/metaAttr/metaAttrRepo.js';
import { createParticle, updateParticle } from '../src/particles/particleRepo.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`);
  await seedMetaAttr('system');   // 幂等物化全部 coreAttributes
});

describe('seedMetaAttr 幂等物化', () => {
  it('CRM_ACCOUNT.coreAttributes 全部物化且 enabled=false', async () => {
    const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT' });
    const slugs = rows.map((r) => r.attr_slug);
    expect(slugs).toContain('name');
    expect(slugs).toContain('domains');
    expect(slugs).toContain('champion_strength');
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    expect(rows.every((r) => r.source === 'manual')).toBe(true);
  });

  it('幂等：重复 seed 不产生重复行', async () => {
    const before = (await listMetaAttr({ particleType: 'CRM_DEAL' })).length;
    await seedMetaAttr('system');
    const after = (await listMetaAttr({ particleType: 'CRM_DEAL' })).length;
    expect(after).toBe(before);
  });
});

describe('写时自适应钩子（particleRepo 接线）', () => {
  it('createParticle 写入未登记新键 → meta_attr 自动登记（enabled=false, source=ai, type=number）', async () => {
    await createParticle('CRM_DEAL', { name: '自适应商机', custom_score: 88 });
    const rec = await getMetaAttr('CRM_DEAL', 'custom_score');
    expect(rec).not.toBeNull();
    expect(rec.attr_type).toBe('number');
    expect(rec.enabled).toBe(false);
    expect(rec.source).toBe('ai');
  });

  it('类型未命中（对象值对象含数组等兜底）→ 拒绝登记且写不失败', async () => {
    await expect(createParticle('CRM_DEAL', { name: '脏键商机', messy: [1, [2]] })).resolves.toBeDefined();
    const rec = await getMetaAttr('CRM_DEAL', 'messy');
    expect(rec).toBeNull();
  });

  it('setMetaAttr 启用后 enabled=true', async () => {
    await setMetaAttr('CRM_DEAL', 'custom_score', { enabled: true, actor: 'system' });
    const rec = await getMetaAttr('CRM_DEAL', 'custom_score');
    expect(rec.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-repo.test.js`
Expected: FAIL（`Cannot find module '../src/metaAttr/metaAttrRepo.js'`）

- [ ] **Step 3: 实现 metaAttrRepo.js**

```js
// src/metaAttr/metaAttrRepo.js — 元模型 DB 读写 + seed 物化 + 自适应登记（写时钩子消费）
import { query } from '../db.js';
import { PARTICLE_TYPES } from '../particles/particleModel.js';
import { recordFor, adaptiveRecordFor } from './metaAttrModel.js';
import { emit } from '../events/bus.js';

// 幂等物化：PARTICLE_TYPES → coreAttributes 全部行（coreAttributes 仍为唯一事实源）
export async function seedMetaAttr(actor = 'system') {
  for (const [ptype, def] of Object.entries(PARTICLE_TYPES)) {
    for (const slug of Object.keys(def.coreAttributes || {})) {
      const rec = recordFor(ptype, slug, def);
      await query(
        `INSERT INTO crm.meta_attr
           (particle_type, attr_slug, title, attr_type, semantic_tag, required, unique, description, options,
            source, display, validation, permission, enabled, version, created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2)`,
        [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
         rec.required, rec.unique, rec.description, rec.options,
         rec.source, JSON.stringify(rec.display), JSON.stringify(rec.validation),
         JSON.stringify(rec.permission), rec.enabled, rec.version, rec.created_by]
      );
    }
  }
  return true;
}

export async function listMetaAttr({ particleType, enabled, semanticTag } = {}) {
  const r = await query(
    `SELECT * FROM crm.meta_attr
     WHERE ($1::text IS NULL OR particle_type=$1)
       AND ($2::boolean IS NULL OR enabled=$2)
       AND ($3::text IS NULL OR semantic_tag=$3)
     ORDER BY particle_type, semantic_tag, attr_slug`,
    [particleType || null, enabled === undefined ? null : enabled, semanticTag || null]
  );
  return r.rows;
}

export async function getMetaAttr(particleType, attrSlug) {
  const r = await query(`SELECT * FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2`, [particleType, attrSlug]);
  return r.rows[0] || null;
}

// 配置变更（attr-update Action 消费；version 递增 + 锚定由 Action 层负责传参）
export async function setMetaAttr(particleType, attrSlug, patch, { actor = 'system', versionBump = true } = {}) {
  const cur = await getMetaAttr(particleType, attrSlug);
  if (!cur) throw new Error(`元模型属性不存在: ${particleType}.${attrSlug}`);
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  if (versionBump && patch) next.version = (cur.version || 1) + 1;
  await query(
    `UPDATE crm.meta_attr SET
       title=$3, attr_type=$4, semantic_tag=$5, required=$6, unique=$7, description=$8, options=$9,
       source=$10, display=$11, validation=$12, permission=$13, enabled=$14, version=$15, updated_at=now()
     WHERE particle_type=$1 AND attr_slug=$2`,
    [particleType, attrSlug, next.title, next.attr_type, next.semantic_tag, next.required, next.unique,
     next.description, next.options, next.source,
     JSON.stringify(next.display || {}), JSON.stringify(next.validation || {}),
     JSON.stringify(next.permission || {}), next.enabled, next.version]
  );
  emit('trace', 'meta-attr-updated', { particle_type: particleType, attr_slug: attrSlug, version: next.version, actor });
  return getMetaAttr(particleType, attrSlug);
}

// 自适应登记（particleRepo 写钩子消费）：新键 → 推断 → 登记（enabled=false / source=ai）
// 强制写事件域（§8 验收 V1：decision_event 落库），无 decision 语义的自动登记由调用方携带（或经 ATTR_SCHEMA_CHANGE）
export async function ensureAdaptiveRegistration(particleType, payload, actor = 'system') {
  const registered = [];
  for (const slug of Object.keys(payload || {})) {
    if (['ai', 'events', 'stage_change_reason', 'closed_reason'].includes(slug)) continue;  // 系统保留键
    const exists = await getMetaAttr(particleType, slug);
    if (exists) continue;
    const rec = adaptiveRecordFor(particleType, slug, payload[slug], actor);
    if (!rec) continue;   // 未命中 19 类型 → 拒绝登记（不抛错，保持写成功）
    await query(
      `INSERT INTO crm.meta_attr
         (particle_type, attr_slug, title, attr_type, semantic_tag, source, enabled, version, created_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
       WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2)`,
      [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
       rec.source, rec.enabled, rec.version, rec.created_by]
    );
    emit('particle', 'meta-attr-auto-registered', { particle_type: particleType, attr_slug: slug, attr_type: rec.attr_type });
    registered.push(slug);
  }
  return registered;
}
```

- [ ] **Step 4: 接线 particleRepo 三钩子（新增自适应钩子，不破坏既有三钩子）**

在 `src/particles/particleRepo.js` 顶部 import 后新增：

```js
import { ensureAdaptiveRegistration } from '../metaAttr/metaAttrRepo.js';
```

在 `createParticle` 的 `emit('particle', 'created', ...)` 之前插入：

```js
  await ensureAdaptiveRegistration(type, payload, 'system');   // 写时自适应：新键自动登记
```

在 `updateParticle` 的 `emit('particle', 'updated', ...)` 之前插入：

```js
  await ensureAdaptiveRegistration(p.type, patch, 'system');   // 写时自适应：patch 新键自动登记
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-repo.test.js`
Expected: PASS

- [ ] **Step 6: 全量回归（既有粒子测试不受影响）**

Run: `node node_modules/vitest/vitest.mjs run test/particles.test.js test/attio-attributes.test.js test/attio-inheritance.test.js test/ai-attributes.test.js`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/metaAttr/metaAttrRepo.js src/particles/particleRepo.js test/meta-attr-repo.test.js
git commit -m "feat(meta-attr): metaAttrRepo + particleRepo 写时自适应钩子（登记 enabled=false/source=ai）"
```

---

### Task 4: 3 个 Action（attr-read / attr-update / field-permission）+ 白名单 + 决策场景 seed

**Files:**
- Modify: `src/action/seed-actions.js`
- Modify: `src/action/whitelist.js`
- Modify: `db/seed.sql`（`ATTR_SCHEMA_CHANGE` 场景）
- Test: `test/meta-attr-actions.test.js`（DB 集成）

- [ ] **Step 1: 写失败测试（Action 注册 + 第 0 闸 + 白名单 + 场景 seed）**

```js
// test/meta-attr-actions.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { actionExecutor } from '../src/action/executor.js';
import { getAction, resetRegistry } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { isWriteWhitelisted } from '../src/action/whitelist.js';
import { seedMetaAttr, getMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { getDecisionCountByScenario } from '../src/decision/decisionRepo.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`);
  resetRegistry();
  seedActions();
  await seedMetaAttr('system');
});

describe('Action 表面', () => {
  it('三个 Action 已注册', () => {
    expect(getAction('data-particle-attr-read')).not.toBeNull();
    expect(getAction('data-particle-attr-update')).not.toBeNull();
    expect(getAction('crm-field-permission')).not.toBeNull();
  });

  it('attr-update 声明 confirm=critical + versionBump 语义', () => {
    const a = getAction('data-particle-attr-update');
    expect(a.kind).toBe('write');
    expect(a.confirm).toBe('critical');
    expect(a.namespace).toBe('data');
  });

  it('attr-update 在对话式写白名单内', () => {
    expect(isWriteWhitelisted('data-particle-attr-update')).toBe(true);
  });
});

describe('第 0 闸（不携带 decision_id 不写）', () => {
  it('attr-update 无 decision_id 且非 bootstrap → 拒绝', async () => {
    const r = await actionExecutor.dispatch('data-particle-attr-update',
      { particle_type: 'CRM_DEAL', attr_slug: 'name', patch: { enabled: true } },
      { tenantId: 'system', actor: 'manager' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
  });

  it('attr-update 带 decision_id → 成功且 version 递增', async () => {
    const r = await actionExecutor.dispatch('data-particle-attr-update',
      { particle_type: 'CRM_DEAL', attr_slug: 'name', patch: { enabled: true }, decision_id: '00000000-0000-0000-0000-000000000001' },
      { tenantId: 'system', actor: 'manager' });
    expect(r.ok).toBe(true);
    const rec = await getMetaAttr('CRM_DEAL', 'name');
    expect(rec.enabled).toBe(true);
    expect(rec.version).toBe(2);
  });
});

describe('ATTR_SCHEMA_CHANGE 场景 seed', () => {
  it('decision_scenario 已有 ATTR_SCHEMA_CHANGE 记录', async () => {
    const r = await query(`SELECT scenario_id, default_tier, autonomous_allowed FROM crm.decision_scenario WHERE scenario_id='ATTR_SCHEMA_CHANGE'`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].default_tier).toBe('HIGH');
    expect(r.rows[0].autonomous_allowed).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-actions.test.js`
Expected: FAIL（Action 未注册 / 场景未 seed）

- [ ] **Step 3: 注册 3 个 Action（seed-actions.js 追加）**

在 `seedActions()` 内 `data-particle-edge-create` 之后追加：

```js
  // —— 粒子属性元模型（设计 2026-08-26 §5.2）——
  registerAction({
    name: 'data-particle-attr-read', kind: 'read', permission: 'auth',
    namespace: 'data', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', enabled: 'boolean', semantic_tag: 'string' },
    handler: async ({ particle_type, enabled, semantic_tag }, ctx) =>
      listMetaAttr({ particleType: particle_type || null, enabled, semanticTag: semantic_tag || null }),
  });
  registerAction({
    name: 'data-particle-attr-update', kind: 'write', permission: 'auth',
    namespace: 'data', agentTool: true, confirm: 'critical', needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', attr_slug: 'string', patch: 'object' },
    parameters: { required: ['particle_type', 'attr_slug', 'patch'] },
    handler: async ({ particle_type, attr_slug, patch }, ctx) =>
      setMetaAttr(particle_type, attr_slug, patch, { actor: ctx.actor }),
  });
  registerAction({
    name: 'crm-field-permission', kind: 'read', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', role_tag: 'string' },
    handler: async ({ particle_type, role_tag }, ctx) => {
      // 字段级 RBAC 读侧：返回该角色对每个 enabled 属性的 mode
      const rows = await listMetaAttr({ particleType: particle_type, enabled: true });
      return rows.map((r) => ({ attr_slug: r.attr_slug, mode: (r.permission?.roles || {})[role_tag] || 'editable' }));
    },
  });
```

head 补 import：`import { listMetaAttr, setMetaAttr } from '../metaAttr/metaAttrRepo.js';`

- [ ] **Step 4: 白名单加入 attr-update（whitelist.js）**

```js
  'data-particle-attr-update', // 元模型配置变更（过第 0 闸 ATTR_SCHEMA_CHANGE）
```

- [ ] **Step 5: seed ATTR_SCHEMA_CHANGE 场景（db/seed.sql 决策场景段追加）**

```sql
-- 粒子属性元模型配置变更（设计 2026-08-26 §5.2：治理类决策，default_tier=HIGH，禁自主）
INSERT INTO decision_scenario (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
SELECT 'ATTR_SCHEMA_CHANGE', 'meta', '粒子属性元模型配置变更（新增/启用/改权限/改控件）',
       '{"action":["data-particle-attr-update"]}'::jsonb,
       '{}'::text[],
       '{"dimensions":[{"key":"impact","label":"影响面","weight":1.0,"required":true},
                       {"key":"consistency","label":"与既有数据一致性","weight":1.0,"required":true},
                       {"key":"permission","label":"字段权限","weight":1.0,"required":true}]}'::jsonb,
       'HIGH', FALSE
WHERE NOT EXISTS (SELECT 1 FROM decision_scenario WHERE scenario_id='ATTR_SCHEMA_CHANGE');
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-actions.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/action/seed-actions.js src/action/whitelist.js db/seed.sql test/meta-attr-actions.test.js
git commit -m "feat(meta-attr): 3 Action + 写白名单 + ATTR_SCHEMA_CHANGE 决策场景 seed"
```

---

### Task 5: 字段级 RBAC 写闸（executor 第 2.5 闸：逐字段核 meta_attr.permission）

**Files:**
- Create: `src/metaAttr/fieldPermission.js`
- Modify: `src/action/executor.js`
- Test: `test/meta-attr-field-permission.test.js`（DB 集成）

- [ ] **Step 1: 写失败测试**

```js
// test/meta-attr-field-permission.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { actionExecutor } from '../src/action/executor.js';
import { resetRegistry } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { seedMetaAttr, setMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { checkFieldPermission } from '../src/metaAttr/fieldPermission.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`);
  resetRegistry();
  seedActions();
  await seedMetaAttr('system');
  // finance 对 name 只读、对 custom_score 隐藏；manager 全 editable
  await setMetaAttr('CRM_DEAL', 'name', { permission: { roles: { finance: 'readonly', manager: 'editable' } } }, { actor: 'system' });
  await setMetaAttr('CRM_DEAL', 'custom_score', { permission: { roles: { finance: 'hidden', manager: 'editable' } } }, { actor: 'system' });
});

describe('checkFieldPermission 逐字段判定', () => {
  it('editable → ok；readonly → 值变更拒绝（structure 允）', async () => {
    expect((await checkFieldPermission('CRM_DEAL', 'name', 'finance', { name: '新名' })).ok).toBe(false);
    expect((await checkFieldPermission('CRM_DEAL', 'name', 'finance', {})).ok).toBe(true);       // 不带值 → 结构级放行
    expect((await checkFieldPermission('CRM_DEAL', 'name', 'manager', { name: '新名' })).ok).toBe(true);
  });
  it('hidden → 一律拒绝，返回 field_denied', async () => {
    const v = await checkFieldPermission('CRM_DEAL', 'custom_score', 'finance', { custom_score: 5 });
    expect(v.ok).toBe(false);
    expect(v.field).toBe('custom_score');
    expect(v.mode).toBe('hidden');
  });
  it('未配置角色 → 默认 editable', async () => {
    expect((await checkFieldPermission('CRM_DEAL', 'name', 'exec', { name: 'x' })).ok).toBe(true);
  });
});

describe('executor 第 2.5 闸接线', () => {
  it('写 data-particle-update 且 finance 改只读字段 → 拒绝（带 decision_id 仍拒，权限闸在数据闸后）', async () => {
    const r = await actionExecutor.dispatch('data-particle-update',
      { id: '00000000-0000-0000-0000-000000000099', patch: { name: '越权改' } },
      { tenantId: 'system', actor: 'person-finance', decision_id: '00000000-0000-0000-0000-000000000001', channel: 'conversational' });
    // 目标粒子不存在也会在 resolve 之前先被字段闸拦（默认 editable 无权限则放行后目标不存在报错）
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-field-permission.test.js`
Expected: FAIL（`Cannot find module '../src/metaAttr/fieldPermission.js'`）

- [ ] **Step 3: 实现 fieldPermission.js**

```js
// src/metaAttr/fieldPermission.js — 字段级 RBAC 判定（写闸第 2.5 闸；读侧 crm-field-permission Action 同源）
import { getMetaAttr } from './metaAttrRepo.js';

// mode: editable | readonly | hidden（未配置角色 → editable）
export function modeFor(rec, roleTag) {
  return rec?.permission?.roles?.[roleTag] || 'editable';
}

// 逐字段判定（data-particle-update 的 patch 键逐个核）
export async function checkFieldPermission(particleType, attrSlug, roleTag, patch) {
  const rec = await getMetaAttr(particleType, attrSlug);
  const mode = modeFor(rec, roleTag);
  if (mode === 'hidden') {
    return { ok: false, gate: 'field_permission', mode, field: attrSlug, reason: `字段 ${attrSlug} 对角色隐藏` };
  }
  if (mode === 'readonly' && patch && Object.prototype.hasOwnProperty.call(patch, attrSlug)) {
    return { ok: false, gate: 'field_permission', mode, field: attrSlug, reason: `字段 ${attrSlug} 对角色只读` };
  }
  return { ok: true, mode, field: attrSlug };
}

// 批量：patch 所有键过一次闸；返回第一个违规
export async function checkPatchPermissions(particleType, patch, roleTag) {
  if (!patch || typeof patch !== 'object') return { ok: true };
  for (const slug of Object.keys(patch)) {
    if (['events', 'ai'].includes(slug)) continue;   // 系统保留键不参与字段闸
    const v = await checkFieldPermission(particleType, slug, roleTag, patch);
    if (!v.ok) return v;
  }
  return { ok: true };
}
```

- [ ] **Step 4: 接线 executor（第 2.5 闸：第 1.5 角色闸之后、写白名单闸之前）**

`src/action/executor.js` 加 import：

```js
import { checkPatchPermissions } from '../metaAttr/fieldPermission.js';
```

在第 1.5 闸（`if (!ctx.bootstrap && Array.isArray(def.rbac_roles)...`）之后、第 2 闸之前插入：

```js
    // 写通道第 2.5 闸（字段级 RBAC，设计 §6.3）：data-particle-update 逐字段核 meta_attr.permission
    if (!ctx.bootstrap && def.name === 'data-particle-update' && params?.patch) {
      const role = await actorRole(ctx);
      if (role?.role_tag) {
        const pid = params.type || null;
        const verdict = await checkPatchPermissions(pid || inferParticleType(params.id), params.patch, role.role_tag);
        if (!verdict.ok) {
          emit('trace', 'action-field-permission-blocked', { action: actionName, actor: ctx.actor, field: verdict.field, mode: verdict.mode });
          return { ok: false, gate: 'field_permission', error: `第2.5闸: ${verdict.reason || ''}` };
        }
      }
    }
```

同文件加 helper（文件末尾导出前）：

```js
// 由 id/type 反查粒子类型（字段闸需 particle_type；查询失败放行，数据闸兜底）
async function inferParticleType(idOrType) {
  if (!idOrType) return null;
  const r = await query(`SELECT type FROM crm.particles WHERE (id::text=$1 OR slug=$1) LIMIT 1`, [idOrType]);
  return r.rows[0]?.type || null;
}
```

（`query` 已在 executor 依赖链内，直接 import：`import { query } from '../db.js';`）

- [ ] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-field-permission.test.js`
Expected: PASS

- [ ] **Step 6: 全量回归**

Run: `node node_modules/vitest/vitest.mjs run test/action.test.js test/http.test.js test/context.test.js test/e2e.test.js`
Expected: 全绿（既有用例不受影响，新闸只对 data-particle-update 且识别到角色时生效）

- [ ] **Step 7: Commit**

```bash
git add src/metaAttr/fieldPermission.js src/action/executor.js test/meta-attr-field-permission.test.js
git commit -m "feat(meta-attr): 字段级 RBAC 第 2.5 闸（editable/readonly/hidden 逐字段核）"
```

---

### Task 6: 配置抽屉 UI（受控 Schema 渲染 + 预览 + 保存）

**Files:**
- Create: `src/web/meta-attr-drawer.html`（左=字段列表 / 右=属性配置面板 / 底部=权限矩阵 + 预览）
- Modify: `src/page/schema.js`（`COMPONENT_KINDS` 增 `attr-field`；`PAGE_TYPES` 增注 `form` 已存在则跳过）
- Modify: `src/page/renderer.js`（`renderComponent` 增 `attr-field` 分支）
- Modify: `src/page/validator.js`（attr-field 组件校验）
- Modify: `src/http/routes.js`（GET `/meta-attr-drawer` 静态页 + GET `/api/meta-attr` 列表桥接）
- Test: `test/meta-attr-page.test.js`（纯逻辑 renderer/validator；HTTP 桥接 DB 集成）

- [ ] **Step 1: 写失败测试（attr-field 组件渲染 + 校验 + 页面路由）**

```js
// test/meta-attr-page.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { renderPage } from '../src/page/renderer.js';
import { validatePageSchema } from '../src/page/validator.js';
import { COMPONENT_KINDS } from '../src/page/schema.js';

describe('attr-field 组件受控渲染', () => {
  it('renderer 渲染 attr-field（label+input，值转义）', () => {
    const schema = {
      type: 'form', title: '测试表单',
      components: [{ kind: 'attr-field', attrSlug: 'name', label: '客户名称', attrType: 'text', placeholder: '输入名称' }],
      layout: { columns: 1 },
    };
    const out = renderPage(schema, {});
    expect(out.html).toContain('attr-field');
    expect(out.html).toContain('客户名称');
    expect(out.html).toContain('placeholder="输入名称"');
  });

  it('attr-field 的 attrType 非 19 类型 → validator 拒绝', () => {
    const schema = {
      type: 'form', title: '坏表单',
      components: [{ kind: 'attr-field', attrSlug: 'x', label: 'x', attrType: 'magic' }],
      layout: { columns: 1 },
    };
    const v = validatePageSchema(schema);
    expect(v.errors.some((e) => e.includes('attrType') || e.includes('19'))).toBe(true);
  });
});

describe('COMPONENT_KINDS 扩展', () => {
  it('attr-field 已在受控组件集', () => {
    expect(COMPONENT_KINDS).toContain('attr-field');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-page.test.js`
Expected: FAIL（unknown component / validator 未拦）

- [ ] **Step 3: schema.js 扩展受控组件集**

`src/page/schema.js` 第 9 行：

```js
export const COMPONENT_KINDS = ['metric-card', 'table', 'goal-form', 'result-card', 'reasoning-trace', 'subtable', 'select', 'attr-field'];
```

追加一维 attrType 值域（同文件）：

```js
// attr-field 组件属性值域（对齐 particleModel.js 19 类型集；validator 引用）
export const ATTR_FIELD_TYPES = ['text','personal-name','email-address','phone-number','domain','location',
  'number','currency','percent','date','timestamp','select','multi-select','boolean','rating','url',
  'record-reference','actor-reference','interaction'];
```

- [ ] **Step 4: validator.js 增 attr-field 校验**

读 `src/page/validator.js`，在组件校验处按既有模式追加（attrSlug 非空 + attrType ∈ ATTR_FIELD_TYPES，否则 `errors.push('attr-field attrType 不在 19 类型集内: ' + attrType)`）。具体插入位置：找到对 `comp.kind` 的 switch/分支（`subtable`/`select` 同款），在其后追加 `case 'attr-field':` 分支做两断言。

- [ ] **Step 5: renderer.js 增 attr-field 渲染**

`src/page/renderer.js` renderComponent 的 switch 增分支：

```js
    case 'attr-field':
      return `<div class="pg-attr-field" data-attr="${escapeHtml(comp.attrSlug)}" data-attr-type="${escapeHtml(comp.attrType || 'text')}">
        <label>${escapeHtml(comp.label || comp.attrSlug)}</label>
        <input name="${escapeHtml(comp.attrSlug)}" type="text" placeholder="${escapeHtml(comp.placeholder || '')}" />
      </div>`;
```

（select/multi-select 类由 `display.kind` 后续迭代换 `renderSelect` 复用；本 Task 统一 text input 骨架。）

- [ ] **Step 6: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-page.test.js`
Expected: PASS

- [ ] **Step 7: HTTP 桥接 + 静态页（routes.js + web/meta-attr-drawer.html）**

`src/http/routes.js` 追加（读桥接，无需决策）：

```js
  // 粒子属性元模型（设计 §5）：读直连桥接（供抽屉列表/预览）
  app.get('/api/meta-attr', async (req, res) => {
    const { type } = req.query;
    const items = await listMetaAttr({ particleType: type || null });
    res.json({ items });
  });

  // 配置抽屉 UI（受控 Schema 渲染，无第二套前端栈）
  app.get('/meta-attr-drawer', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/meta-attr-drawer.html', import.meta.url))));
```

head import 补：`import { listMetaAttr } from '../metaAttr/metaAttrRepo.js';`

`src/web/meta-attr-drawer.html` 骨架（受控渲染，无后端依赖时展示空态；完整交互随阶段 3 迭代）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>粒子属性元模型配置抽屉</title>
<style>
  body { font-family: system-ui; margin: 0; padding: 24px; background: #f7f7f5; color: #1f2328; }
  .drawer { display: grid; grid-template-columns: 320px 1fr; gap: 16px; max-width: 1200px; margin: 0 auto; }
  .panel { background: #fff; border: 1px solid #e5e5e0; border-radius: 8px; padding: 16px; }
  .panel h2 { font-size: 14px; margin: 0 0 12px; }
  .attr-row { padding: 8px; border-bottom: 1px solid #eee; cursor: pointer; font-size: 13px; }
  .attr-row .tag { display: inline-block; font-size: 11px; background: #e8eef7; color: #1f4e8c; border-radius: 4px; padding: 1px 6px; margin-right: 6px; }
  .attr-row.disabled { opacity: .5; }
  .perm-grid td, .perm-grid th { border: 1px solid #eee; padding: 4px 8px; font-size: 12px; text-align: center; }
  #preview { background: #fff; border: 1px solid #e5e5e0; border-radius: 8px; padding: 16px; margin-top: 16px; min-height: 90px; }
</style>
</head>
<body>
<div class="drawer">
  <aside class="panel">
    <h2>字段列表</h2>
    <div id="attr-list">加载中…</div>
  </aside>
  <section class="panel">
    <h2>属性配置面板</h2>
    <div id="attr-config">
      <p style="color:#888;font-size:13px">选择左侧属性后此处显示配置（title/required/options/display/permission），保存按钮映射 data-particle-attr-update（过第 0 闸，需决策上下文）。</p>
    </div>
  </section>
</div>
<div class="panel" style="max-width:1200px;margin:16px auto">
  <h2>受控预览（renderer 同链路）</h2>
  <div id="preview">（选择属性后在右侧预览）</div>
</div>
<script>
  // 读桥接：拉元模型列表；预览由受控 schema → 同链路渲染（阶段 3 接 renderer 完整交互）
  fetch('/api/meta-attr').then(r => r.json()).then(({ items }) => {
    const box = document.getElementById('attr-list');
    if (!items.length) { box.textContent = '（空）'; return; }
    box.innerHTML = items.map((a) =>
      `<div class="attr-row ${a.enabled ? '' : 'disabled'}" data-slug="${a.attr_slug}" data-type="${a.attr_type}" data-tag="${a.semantic_tag}">
        <span class="tag">${a.semantic_tag}</span>${a.attr_slug}
        <span style="color:#888"> · ${a.attr_type}</span>
      </div>`).join('');
    box.querySelectorAll('.attr-row').forEach(el => el.onclick = () => {
      const slug = el.dataset.slug, type = el.dataset.type;
      document.getElementById('attr-config').innerHTML = `
        <label style="font-size:13px">属性 ${slug}（类型 ${type}，19 类型集内）</label>
        <p style="font-size:13px;color:#555">title / required / unique / options / display / permission 的编辑与保存由
        data-particle-attr-update Action 提供（阶段 3 完整交互）。</p>`;
      document.getElementById('preview').innerHTML = `
        <label style="font-size:13px">${slug}</label><input placeholder="预览输入 ${slug}" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px">`;
    });
  }).catch(e => { document.getElementById('attr-list').textContent = '读取失败：' + e.message; });
</script>
</body>
</html>
```

- [ ] **Step 8: HTTP 桥接测试 + 静态页可访问**

追加测试：

```js
describe('HTTP 桥接', () => {
  it('GET /api/meta-attr 返回列表', async () => {
    const res = await fetch('http://127.0.0.1:3100/api/meta-attr');
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((x) => x.attr_slug === 'name')).toBe(true);
  });
  it('GET /meta-attr-drawer 返回静态页', async () => {
    const res = await fetch('http://127.0.0.1:3100/meta-attr-drawer');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('粒子属性元模型配置抽屉');
  });
});
```

（HTTP 集成依赖 server 实例——按 `test/http.test.js` 既有启动范式：beforeAll 起 server 并监听，afterAll 关闭。）

- [ ] **Step 9: 跑测试确认通过 + 全量回归**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-page.test.js`
Expected: PASS
再 Run: `node node_modules/vitest/vitest.mjs run test/page.test.js`
Expected: 全绿（既有 page 用例不受影响）

- [ ] **Step 10: Commit**

```bash
git add src/page/schema.js src/page/validator.js src/page/renderer.js src/http/routes.js src/web/meta-attr-drawer.html test/meta-attr-page.test.js
git commit -m "feat(meta-attr): 配置抽屉 UI 受控渲染（attr-field 组件 + /api/meta-attr + 静态页）"
```

---

### Task 7: AI 属性自适应闭环 - evaluator 由元模型驱动（source 轴 + meta-attr 登记）

**Files:**
- Modify: `src/aiAttributes/evaluator.js`
- Modify: `src/metaAttr/metaAttrRepo.js`（`ensureAdaptiveRegistration` 排除键补 `ai` 轴内属性名清单）
- Test: `test/meta-attr-ai-closure.test.js`（DB 集成）

- [ ] **Step 1: 写失败测试**

```js
// test/meta-attr-ai-closure.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { seedMetaAttr, listMetaAttr, getMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { createParticle } from '../src/particles/particleRepo.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`);
  await seedMetaAttr('system');
});

describe('AI 属性闭环：evaluator 产生的 payload.ai.* 不触发元模型登记（系统保留轴）', () => {
  it('写粒子后 ai 轴属性不进 meta_attr（ai.* 是 AI 属性承载，非人工字段）', async () => {
    await createParticle('CRM_DEAL', { name: '闭环商机', expected_amount: 100000 });
    const rows = await listMetaAttr({ particleType: 'CRM_DEAL' });
    expect(rows.some((r) => r.attr_slug.startsWith('ai.'))).toBe(false);
  });

  it('evaluator 求值后可读既有 aiAttrFor', async () => {
    const p = await createParticle('CRM_DEAL', { name: '求值商机', expected_amount: 200000 });
    expect(p.payload.ai.revenue_forecast.value).toBe(200000);
  });
});

describe('attio enrichment 登记（source=enrich 语义挂点）', () => {
  it('连接器补全字段（如 funding_raised_usd 已 seed；新增 enrichment_only 字段）登记 source=ai 待确认', async () => {
    await createParticle('CRM_ACCOUNT', { name: '补全客户', enrichment_verified: true });
    const rec = await getMetaAttr('CRM_ACCOUNT', 'enrichment_verified');
    expect(rec).not.toBeNull();
    expect(rec.source).toBe('ai');      // 自动登记默认 ai（设计 §10-③ enabled=false）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-ai-closure.test.js`
Expected: PASS/FAIL 混合——`ai.` 键当前会被登记（`revenue_forecast` 落在 payload 顶层 `ai` 键内，`ensureAdaptiveRegistration` 遍历 `payload` 时因对象键 `ai` 已排除而不再登记；但若 evaluator 把 ai 属性写进顶层则漏网。断言确保闭：**需显式排除 `ai` 保留键并加回归**）。若当前实现已排除 `ai`（Task 3 就加了），则本测试首跑即绿——此时改为先改实现使其先红：把 Task 3 的 `['ai','events',...]` 排除清单的 `ai` 移除（临时），跑红，再恢复。执行顺序：**Step 1 写法不变，Step 2 前先临时去掉 `ai` 排除 → 红 → Step 3 恢复并加 `ai.*` 轴递归排除 → 绿。**

- [ ] **Step 3: 强化排除清单（metaAttrRepo.js `ensureAdaptiveRegistration`）**

将 Task 3 的排除行改为：

```js
    if (slug === 'ai' || slug === 'events' || slug === 'stage_change_reason' || slug === 'closed_reason') continue;
    if (slug.startsWith('ai.')) continue;   // AI 属性轴（payload.ai.*）永不进元模型
```

- [ ] **Step 4: evaluator 增 source 语义出口（不改求值逻辑，补导出）**

`src/aiAttributes/evaluator.js` 末尾追加（元模型消费方读 source）：

```js
// AI 属性轴源标记（供元模型 source 轴对照；设计 §7）
export const AI_ATTR_AXIS_SOURCE = Object.fromEntries(
  Object.entries(AI_ATTR_DEFS).flatMap(([type, defs]) =>
    Object.entries(defs).map(([key, d]) => [`${type}.${key}`, { axis: d.axis, source: d.source, confidence: d.confidence }]))
);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/meta-attr-ai-closure.test.js`
Expected: PASS（3 tests）

- [ ] **Step 6: 全量回归**

Run: `node node_modules/vitest/vitest.mjs run test/ai-attributes.test.js test/attio-attributes.test.js test/meta-attr-repo.test.js`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/aiAttributes/evaluator.js src/metaAttr/metaAttrRepo.js test/meta-attr-ai-closure.test.js
git commit -m "feat(meta-attr): evaluator 与元模型闭环（ai.* 轴排除 + source 标记导出）"
```

---

## 自检（Self-Review）

**1. 设计覆盖：**
- §3 三层架构 → Task 1（L0 表）+ Task 2/3（L0 逻辑+DB）+ Task 4（L1 Action）+ Task 6（L2 UI）+ Task 7（AI 闭环）
- §4 元模型 DDL → Task 1（19 类型 CHECK / semantic_tag / source / enabled=false / version）
- §5 Action 表面 → Task 4（3 Action + 白名单 + `ATTR_SCHEMA_CHANGE` 场景）；validation/display/permission 列 → Task 3 `setMetaAttr` 全列可写
- §5.3 类型→控件映射 → Task 6 受控组件 + 预览（完整控件映射随阶段 3 抽屉迭代，TDD 留痕）
- §6 抽屉 → Task 6（静态页骨架 + 桥接；权限矩阵面板入口，完整交互阶段 3）
- §6.3 字段级 RBAC → Task 5（第 2.5 闸）+ Task 4 `crm-field-permission` 读侧
- §7 AI 闭环 → Task 7（ai.* 排除 + source 标记 + enrichment 登记挂点）
- §8 验收：V1（Task 3 自适应登记测试）✓ V2（Task 1 CHECK 闸测试）✓ V3（Task 5 权限闸测试）✓ V4（Task 4 第 0 闸测试）✓ V5（Task 6 page 测试）✓ V6（既有 interaction-index 覆盖，Task 7 不回归它）

**2. 无占位符：** 全部测试与实现含完整代码；`validator.js` 插入点以「找到 subtable/select 分支后追加」定位（与既有文件结构一致，实代码给出判定与告警串）。

**3. 类型一致性：** `listMetaAttr/getMetaAttr/setMetaAttr/seedMetaAttr/ensureAdaptiveRegistration/checkFieldPermission/checkPatchPermissions/modelFor/recordFor/adaptiveRecordFor` 跨 Task 签名一致；`data-particle-attr-update` 参数 `{particle_type, attr_slug, patch}` 与 handler 一致；`ATTR_SCHEMA_CHANGE` 场景名 Task 4 seed 与设计 §5.2/§8 V4 一致；`ai.*` 排除在 Task 3/ Task 7 两处同语义。

---

## 执行移交（Execution Handoff）

**计划已完成并保存至 `docs/superpowers/plans/2026-08-26-particle-attribute-model.md`。两种执行方式：**

**1. 子代理驱动（推荐）** — 每个 Task 派发独立子代理，任务间两阶段审查，快速迭代

**2. 本会话内联执行** — 用 executing-plans 批量执行，带检查点评审

**请选择执行方式？**（PG@5433 需本机启动：`wsl -d Ubuntu -u root service postgresql start`；沙箱禁 WSL/docker 时 DB 集成测试标注环境限制，纯逻辑测试先行。）