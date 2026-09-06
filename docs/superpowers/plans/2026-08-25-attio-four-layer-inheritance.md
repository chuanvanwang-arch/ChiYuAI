# ATTIO 四层承接补全 — 实施计划（T6–T10）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ATTIO 16 字段从「Schema 孤岛」提升为「四层结构化承接」——知识层按 semanticTag 自动词汇登记、身份解析建 auto_weak 边、关系强度进决策单元子图、记忆层 emit 属性变更事件、决策层用 relation 组调节置信度、智能体层 retrieveEntityProfile 投影注入 L1。

**Architecture:** 方案 B「分层语义约定 + 通用投影」——在 `particleModel.js` 引入 `semanticTags` 常量表（firmographic/social/relation/interaction/ui），`hooks.js`（ontologySync）成为单一投影点：按 tag 自动建边 + 关联账户 + 词汇登记 + emit 变更事件；`vocabulary.js` 改为按 tag 登记「有序枚举」；`autonomyEngine.js` 读取关系强度调节置信度；`assembler.js` 新增 `retrieveEntityProfile` 注入 L1。不新增粒子类型、不扩展 19 类型集、不引入新依赖。

**Tech Stack:** Node 22 ESM + PostgreSQL 16 (pgcrypto+vector) + vitest 3（写时真实 PG@5433；纯逻辑测试不依赖 DB）。

**来源设计:** `docs/2026-08-25-12-attio-four-layer-inheritance.md` §7（已批准）。**前置完成:** `docs/superpowers/plans/2026-08-25-attio-enrichment-impl.md`（T1–T5，已落地：schema + key_contact 边 + interaction_index 维护器，commit 387a5ef 系列）。

---

### Task 6: semanticTag 常量表 + 词汇登记改为按 tag 自动覆盖

**Files:**
- Modify: `src/particles/particleModel.js`（新增 `SEMANTIC_TAGS` + `semanticTagOf(attr)` 导出）
- Modify: `src/ontology/vocabulary.js`（ENUM_HINT_FIELDS → 按 tag 计算 + 有序枚举登记）
- Test: `test/attio-inheritance.test.js`（新建，纯逻辑无 DB）

- [ ] **Step 1: 写失败测试**

```js
// test/attio-inheritance.test.js
import { describe, it, expect } from 'vitest';
import { SEMANTIC_TAGS, semanticTagOf } from '../src/particles/particleModel.js';
import { enumHintFields, orderedEnumHintFields } from '../src/ontology/vocabulary.js';

describe('ATTIO 四层承接 T6：semanticTag + 词汇自动登记', () => {
  it('semanticTagOf 把 ATTIO 字段归入五组', () => {
    expect(semanticTagOf('domains')).toBe('firmographic');
    expect(semanticTagOf('employee_range')).toBe('firmographic');
    expect(semanticTagOf('categories')).toBe('firmographic');
    expect(semanticTagOf('logo_url')).toBe('ui');
    expect(semanticTagOf('key_contact')).toBe('relation');
    expect(semanticTagOf('relationship_strength')).toBe('relation');
    expect(semanticTagOf('interaction_index')).toBe('interaction');
  });

  it('enumHintFields 自动覆盖 ATTIO 复数/新 select（不再硬编码老 6 字段）', () => {
    const fields = enumHintFields();
    expect(fields).toContain('categories');
    expect(fields).toContain('employee_range');
    expect(fields).toContain('estimated_arr_usd');
    expect(fields).toContain('industry');   // 旧字段不丢
    expect(fields).toContain('stage');
  });

  it('orderedEnumHintFields 仅含量纲字段（大小关系可参与条件比较）', () => {
    const ordered = orderedEnumHintFields();
    expect(ordered).toContain('employee_range');
    expect(ordered).toContain('estimated_arr_usd');
    expect(ordered).not.toContain('industry'); // 非量纲不进有序组
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: FAIL（`SEMANTIC_TAGS`/`semanticTagOf`/`enumHintFields`/`orderedEnumHintFields` 未导出）

- [ ] **Step 3: 实现语义标签常量表**

在 `src/particles/particleModel.js` 的 `ATTRIBUTE_TYPE_SET` 之后新增：

```js
// ATTIO 分层语义约定（12 设计 §5 方案 B：按 tag 路由四层，避免逐字段硬编码）
export const SEMANTIC_TAGS = {
  firmographic: ['domains','funding_raised_usd','foundation_date','estimated_arr_usd','employee_range','categories'],
  social: ['linkedin','twitter','facebook','instagram','angellist'],
  relation: ['champion_strength','key_contact','relationship_strength','company'],
  interaction: ['interaction_index'],
  ui: ['logo_url','avatar_url','primary_location'],
  legacy: ['name','industry','region','source','size','rating','business_title','job_title','title','department','decision_power','email','phone','type'],
};

export function semanticTagOf(attr) {
  for (const [tag, attrs] of Object.entries(SEMANTIC_TAGS)) {
    if (attrs.includes(attr)) return tag;
  }
  return 'legacy';
}
```

- [ ] **Step 4: 实现词汇登记按 tag 自动覆盖**

将 `src/ontology/vocabulary.js` 的 `ENUM_HINT_FIELDS` 导出替换为函数 + 新增有序枚举导出：

```js
// src/ontology/vocabulary.js — 枚举型/业务专有名词写时登记（进 L1 图种子）
// 12 设计 §7.2：按 semanticTag 自动覆盖（不再硬编码老 6 字段）
import { createParticle } from '../particles/particleRepo.js';
import { SEMANTIC_TAGS, semanticTagOf } from '../particles/particleModel.js';

// 量纲枚举字段（大小关系可参与条件比较：employee_range/estimated_arr_usd）
export const ORDERED_ENUM_HINTS = ['employee_range', 'estimated_arr_usd'];

// firmographic 组中的 select/枚举字段 → 应自动登记词汇（categories/employee_range/estimated_arr_usd 在此覆盖）
export function enumHintFields() {
  const firmographicSelects = SEMANTIC_TAGS.firmographic.filter((f) => f !== 'domains'); // domains 走身份解析不走词汇
  return [...new Set(['industry','region','stage','source','category','type', ...firmographicSelects])];
}

// 量纲枚举：登记为有序枚举（保留大小关系，供语义比较如 "ARR > 阈值"）
export function orderedEnumHintFields() {
  return ORDERED_ENUM_HINTS;
}

// 写时登记：粒子 payload 中的枚举/业务名词 → CRM_KNOWLEDGE（fail-open，登记失败不阻断业务写）
export async function registerVocabulary(entity, tenantId = 'system') {
  const payload = entity.payload || {};
  for (const f of enumHintFields()) {
    const val = payload[f];
    if (!val || typeof val !== 'string') continue;
    const exists = await findKnowledge(val);
    if (exists) continue;
    const kind = orderedEnumHintFields().includes(f) ? 'ordered-enum' : '业务术语';
    await createParticle('CRM_KNOWLEDGE', { term: val, type: kind, layer: 'L1' }, { tenantId })
      .catch(() => null);
  }
}

async function findKnowledge(term) {
  const { query } = await import('../db.js');
  const r = await query(
    `SELECT id FROM particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'=$1 LIMIT 1`,
    [term]
  );
  return r.rows[0] || null;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: PASS（3/3）

- [ ] **Step 6: 提交**

```bash
git add src/particles/particleModel.js src/ontology/vocabulary.js test/attio-inheritance.test.js
git commit -m "feat(attio): semanticTag 五组常量 + 词汇登记按 tag 自动覆盖（含有序枚举）"
```

> ⚠️ 注意：`vocabulary.js` 改用 `createParticle` 前请确认其签名（T6 Step 4 代码中的 `createParticle(type, payload, {tenantId})` 与 `particleRepo.js:8` 一致）。若实际签名不同，以 `particleRepo.js` 为准调整。

---

### Task 7: 身份解析 — domains→账户 auto_weak 边 + relation_confidence + 人工确认升强

**Files:**
- Modify: `src/ontology/hooks.js`（ontologySync 增身份解析）
- Modify: `src/particles/particleModel.js`（CONTROLLED_PREDICATES 增 `auto_weak`）
- Test: `test/attio-inheritance.test.js`（追加 DB 集成 describe 块）

- [ ] **Step 1: 写失败测试（追加到 test/attio-inheritance.test.js）**

```js
// 追加 describe 块（DB 集成，需 PG@5433）
import { query } from '../src/db.js';
import { createParticle, createEdge, queryNeighbors } from '../src/particles/particleRepo.js';
import { confirmWeakEdge } from '../src/ontology/hooks.js';

describe('ATTIO 四层承接 T7：domains 身份解析', () => {
  it('CONTACT 邮箱域名命中 ACCOUNT domains → auto_weak 受控边自动建', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技', domains: ['x.com'] });
    const contact = await createParticle('CRM_CONTACT', { name: '李工', email: 'li@x.com' });
    const n = await queryNeighbors('CRM_CONTACT', contact.id);
    expect(n.some((e) => e.edge_type === 'auto_weak' && e.target_id === acct.id)).toBe(true);
  });

  it('confirmWeakEdge 人工确认后边强度/状态升级', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技', domains: ['x.com'] });
    const contact = await createParticle('CRM_CONTACT', { name: '李工', email: 'li@x.com' });
    const n = await queryNeighbors('CRM_CONTACT', contact.id);
    const weak = n.find((e) => e.edge_type === 'auto_weak');
    await confirmWeakEdge(weak.id);
    const after = await query(`SELECT meta FROM crm.edges WHERE id=$1`, [weak.id]);
    expect(after.rows[0].meta.confirmed).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: FAIL（`auto_weak` 非受控谓词导致 createEdge 拒 / `confirmWeakEdge` 未导出）

- [ ] **Step 3: 实现身份解析（hooks.js ontologySync）**

在 `src/particles/particleModel.js` 的 `CONTROLLED_PREDICATES` 数组追加：

```js
  'auto_weak',                                  // 身份解析弱边（12 设计 §7.1，可人工确认升强）
```

在 `src/ontology/hooks.js` 的 `ontologySync` 内，`refs` 循环之后新增：

```js
  // ② ATTIO 身份解析（12 §7.1）：CONTACT.email 域名 命中 ACCOUNT.domains → auto_weak 边
  if (entity.type === 'CRM_CONTACT' && payload.email && typeof payload.email === 'string') {
    const domain = payload.email.split('@')[1]?.toLowerCase();
    if (domain) {
      const { query: q } = await import('../db.js');
      const hit = await q(
        `SELECT id FROM crm.particles WHERE type='CRM_ACCOUNT' AND payload->>'domains' LIKE $1 LIMIT 1`,
        [`%${domain}%`]
      ).catch(() => ({ rows: [] }));
      const acct = hit.rows[0];
      if (acct) {
        const { createEdge } = await import('../particles/particleRepo.js');
        await createEdge('CRM_CONTACT', entity.id, 'auto_weak', 'CRM_ACCOUNT', acct.id, {
          relation_confidence: 0.6, confirmed: false, edge_source: 'identity-resolve',
        }).catch(() => {});
      }
    }
  }
```

在 `ontologySync` 之后新增导出（供人工确认升强）：

```js
// 人工确认弱边→强边（12 §7.1 验收③）：仅 auto_weak 可确认，确认后 meta.confirmed=true
export async function confirmWeakEdge(edgeId) {
  const { query: q } = await import('../db.js');
  const r = await q(`SELECT * FROM crm.edges WHERE id=$1 AND edge_type='auto_weak'`, [edgeId]);
  if (!r.rows[0]) throw new Error(`非 auto_weak 边或不存在: ${edgeId}`);
  await q(`UPDATE crm.edges SET meta = meta || '{"confirmed":true}'::jsonb WHERE id=$1`, [edgeId]);
  return { ok: true, edgeId };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: PASS（需 PG@5433；沙箱无 PG 时标注环境限制，非回归）

- [ ] **Step 5: 提交**

```bash
git add src/particles/particleModel.js src/ontology/hooks.js test/attio-inheritance.test.js
git commit -m "feat(attio): domains 身份解析 auto_weak 弱边 + confirmWeakEdge 人工确认升强"
```

---

### Task 8: 关系强度进图 + 记忆层 emit 属性变更事件

**Files:**
- Modify: `src/ontology/hooks.js`（关系强度边 + firmographic 变更 emit）
- Modify: `src/memory/capture.js`（订阅 memory 域承接属性变更）
- Test: `test/attio-inheritance.test.js`（追加 DB 集成 describe 块）

- [ ] **Step 1: 写失败测试（追加）**

```js
import { appendMemory } from '../src/memory/memoryLog.js';
import { on } from '../src/events/bus.js';

describe('ATTIO 四层承接 T8：关系强度边 + 属性变更记忆事件', () => {
  it('CONTACT.relationship_strength 写时自动建关系强度边', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技' });
    const contact = await createParticle('CRM_CONTACT', { name: '李工', relationship_strength: 'strong' });
    const n = await queryNeighbors('CRM_CONTACT', contact.id);
    expect(n.some((e) => e.edge_type === 'relationship_strength' && e.target_id === acct.id)).toBe(true);
  });

  it('firmographic 属性经 memory 域事件被 capture 承接', async () => {
    const seen = [];
    const unsub = on('memory', (msg) => seen.push(msg));
    await createParticle('CRM_ACCOUNT', { name: 'Y 科技', employee_range: '51-200' });
    const found = seen.some((m) => m.type === 'attribute-change-firmographic');
    unsub();
    expect(found).toBe(true);
  });

  it('capture.js 订阅 memory 域后 firmographic 事件落入 memory_log', async () => {
    await createParticle('CRM_ACCOUNT', { name: 'Z 科技', estimated_arr_usd: '1m-5m' });
    const r = await query(`SELECT count(*) c FROM crm.memory_log WHERE event_type='attribute-change-firmographic'`);
    expect(r.rows[0].c >= 1).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: FAIL（`relationship_strength` 边不存在 / memory 域事件不 emit / capture 未订阅）

- [ ] **Step 3: 实现关系强度边——在 `src/ontology/hooks.js` 的 `ontologySync` 身份解析之后追加**

```js
  // ③ 关系强度边（12 §7.3）：CONTACT.relationship_strength/ACCOUNT.champion_strength → 决策单元子图
  const relationStrength = payload.relationship_strength || payload.champion_strength;
  if (relationStrength && (entity.type === 'CRM_CONTACT' || entity.type === 'CRM_ACCOUNT')) {
    const { query: q } = await import('../db.js');
    const r = await q(
      `SELECT id FROM crm.particles WHERE type=$1 AND payload->>'name'=$2 LIMIT 1`,
      [entity.type === 'CRM_CONTACT' ? 'CRM_ACCOUNT' : 'CRM_DEAL', payload.account_name || payload.name]
    ).catch(() => ({ rows: [] }));
    const target = r.rows[0];
    if (target) {
      const { createEdge } = await import('../particles/particleRepo.js');
      await createEdge(entity.type, entity.id, 'relationship_strength', target.type, target.id, {
        strength: relationStrength, edge_source: 'attio-relation',
      }).catch(() => {});
    }
  }
```

> ⚠️ 目标实体查找依赖 `account_name`/`name` 匹配，属最小实现。若既有测试数据无此字段，关系强度边不会建——验收以「有 account_name 时建边」为准。

- [ ] **Step 4: 实现属性变更 emit——在 `ontologySync` 最前（refs 之前）追加**

```js
  // ④ 属性变更事件（12 §7.2 记忆承接）：firmographic/ui 组变更时 emit memory 域（capture 整包承接）
  const firmographicKeys = SEMANTIC_TAGS.firmographic.filter((f) => payload[f] !== undefined);
  if (firmographicKeys.length) {
    emit('memory', 'attribute-change-firmographic', {
      entity_type: entity.type, entity_id: entity.id, changed: firmographicKeys,
    });
  }
```

> ⚠️ 需在 `hooks.js` 顶部 import `SEMANTIC_TAGS` 与 `emit`，或使用动态 import（与现文件 `createEdge` 动态 import 风格一致，推荐动态 import 保持零循环依赖）。

- [ ] **Step 5: 实现 capture 订阅 memory 域**

在 `src/memory/capture.js` 的 `registerCaptureSubscriber` 中追加 memory 域订阅：

```js
export function registerCaptureSubscriber() {
  on('*', (msg) => {
    captureMemory({ domain: msg.domain, type: msg.type, payload: msg.summary, actor: msg.summary?.actor })
      .catch(() => {});
  });
  on('memory', (msg) => {
    appendMemory({
      topic: `attribute:${msg.summary?.entity_type}:${msg.summary?.entity_id}`,
      kind: 'attribute-change',
      payload: msg.summary, layer: 'L-Workspace',
      eventType: msg.type, ttlDays: 90,
    }).catch(() => {});
  });
}
```

> ⚠️ `capture.js` 顶部需已有 `appendMemory` import；若 `registerCaptureSubscriber` 已用 `captureMemory` 包装整包，第二种 `on('memory')` 直接调 `appendMemory`（按 `memoryLog.js:22` 签名）。

- [ ] **Step 6: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: PASS（需 PG@5433）

- [ ] **Step 7: 提交**

```bash
git add src/ontology/hooks.js src/memory/capture.js test/attio-inheritance.test.js
git commit -m "feat(attio): 关系强度边 + memory 域属性变更事件 + capture 承接"
```

---

### Task 9: 决策层 — relation 组置信度调节因子

**Files:**
- Modify: `src/decision/autonomyEngine.js`
- Test: `test/attio-inheritance.test.js`（追加 DB 集成 describe 块）

- [ ] **Step 1: 写失败测试（追加）**

```js
import { requireDecision } from '../src/decision/autonomyEngine.js';

describe('ATTIO 四层承接 T9：relation 组调节决策置信度', () => {
  it('关系强度高 → 置信度上调，低自主场景可放行', async () => {
    const decision = await requireDecision('deal-quote', {
      customer: 'system', project: 'demo',
      relations: { champion_strength: 'high', relationship_strength: 'high' },
    }, [], { conf: { threshold: 0.8 } });
    expect(decision.mode).toBe('autonomous');
  });

  it('关系强度缺失/低 → 不回退阈值、仍走原有档位', async () => {
    const decision = await requireDecision('deal-quote', {
      customer: 'system', project: 'demo',
    }, [], { conf: { threshold: 0.8 } });
    // 未传 relations 时 behavior 与 T9 前完全一致（无噪声）
    expect(['autonomous', 'escalated']).toContain(decision.mode);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: FAIL（`trigger_context.relations` 未被引擎读取，`champion_strength:'high'` 不产生自主放行）

- [ ] **Step 3: 实现（autonomyEngine.js 的 `confidence` 计算处）**

在 `requireDecision` 的 `const conf = confidence(...)` 之前插入关系调节：

```js
  // ATTIO relation 组置信度调节（12 §7.2/§8 决策承接）：强关系→上调，弱/缺失→不干扰
  const rel = (trigger_context.relations || {});
  const relBoost = (['high','champion'].includes(rel.champion_strength) ? 0.05 : 0)
                 + (['high','strong'].includes(rel.relationship_strength) ? 0.05 : 0);
  const conf = Math.min(confidence(cfg.weights, { avgSimilarity, coverage, methodScore, allMet }) + relBoost, 0.95);
```

> ⚠️ 原代码 `const conf = confidence(...)` 需替换为上式（保持变量名 `conf` 不变，后续 escalated/autonomous 分支引用不变）。`relBoost` 上限 0.10、封顶 0.95——强关系不足以跨过阈值，除非本来接近。

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: PASS（需 PG@5433）

- [ ] **Step 5: 提交**

```bash
git add src/decision/autonomyEngine.js test/attio-inheritance.test.js
git commit -m "feat(attio): relation 组置信度调节因子（强关系上调、缺失零干扰）"
```

---

### Task 10: 智能体上下文 — retrieveEntityProfile 投影注入 L1

**Files:**
- Modify: `src/context/assembler.js`（新增 `retrieveEntityProfile` + 注入 L1）
- Test: `test/attio-inheritance.test.js`（追加 DB 集成 describe 块）

- [ ] **Step 1: 写失败测试（追加）**

```js
import { assembleContext } from '../src/context/assembler.js';

describe('ATTIO 四层承接 T10：实体画像投影注入 L1', () => {
  it('assembleContext 的 L1 含 firmographic/relation 结构化投影', async () => {
    const acct = await createParticle('CRM_ACCOUNT', {
      name: 'X 科技', employee_range: '51-200', categories: 'SaaS',
      champion_strength: 'high', key_contact: 'li@x.com',
    });
    const ctx = await assembleContext({ actor: 'presales', intent: { scenario: 'deal-quote' }, query: 'X 科技 客户画像' });
    const l1 = ctx.layers.L1 || [];
    const profiled = l1.find((p) => p.entity_id === acct.id);
    expect(profiled?.profile?.firmographic).toContain('employee_range');
    expect(profiled?.profile?.relation?.champion_strength).toBe('high');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: FAIL（L1 检索结果无 `profile` 投影字段）

- [ ] **Step 3: 实现（assembler.js）**

在 `retrieveL1` 之后新增投影函数，并在 `assembleContext` 的 L1 组装处调用：

```js
// ATTIO 实体画像投影（12 §7.3/§8 智能体承接）：按 semanticTag 投影结构化属性注入 L1
export async function retrieveEntityProfile(particle) {
  if (!particle) return null;
  const payload = particle.payload || {};
  const profile = { firmographic: {}, relation: {}, interaction: {} };
  for (const [tag, attrs] of Object.entries(SEMANTIC_TAGS)) {
    if (!['firmographic', 'relation', 'interaction'].includes(tag)) continue;
    for (const a of attrs) {
      if (payload[a] !== undefined) profile[tag][a] = payload[a];
    }
  }
  return { entity_id: particle.id, entity_type: particle.type, ...profile };
}

async function retrieveL1(actor, q) {
  if (!q) return [];
  const qvec = hashVector(q);
  const r = await query(
    `SELECT id, type, title, payload FROM crm.particles WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT 5`,
    [qvec]
  );
  return r.rows.map((row) => ({ ...row, profile: retrieveEntityProfile(row) }));
}
```

> ⚠️ `retrieveEntityProfile` 使用 `SEMANTIC_TAGS`——需在 `assembler.js` 顶部 import（`import { SEMANTIC_TAGS } from '../particles/particleModel.js'`）。纯函数（行内同步计算，无 DB）。

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: PASS（需 PG@5433）

- [ ] **Step 5: 提交**

```bash
git add src/context/assembler.js test/attio-inheritance.test.js
git commit -m "feat(attio): retrieveEntityProfile 按 tag 投影注入 L1（firmographic/relation/interaction）"
```

---

### Task 11: 全量测试 + 设计文档自检同步

**Files:**
- Test: `test/attio-inheritance.test.js`（本轮全部新增）
- Modify: `docs/2026-08-25-12-attio-four-layer-inheritance.md`（§10 自检状态 → 已实现）

- [ ] **Step 1: 运行新增测试全套**

Run: `node node_modules/vitest/vitest.mjs run test/attio-inheritance.test.js`
Expected: PASS（T6 纯逻辑 3 + T7/T8/T9/T10 DB 集成各 2-3）

- [ ] **Step 2: 运行全量测试（需 PG@5433）**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 基线 33 + ATTIO T1-T5 既有 + T6-T10 新增 全绿（fileParallelism 已禁，共享真实 PG）

- [ ] **Step 3: 同步 12 设计文档 §10 自检**

将 `docs/2026-08-25-12-attio-four-layer-inheritance.md` §10 末行 `- [ ] 方案 B + §7/§8/§9 待用户批准设计后，转入 writing-plans → 实现（HARD-GATE）` 改为：

```md
- [x] 方案 B 已批准；T6-T10 已实现（commit 见 `docs/superpowers/plans/2026-08-25-attio-four-layer-inheritance.md`）；§7/§8/§9 全部落地
```

- [ ] **Step 4: 提交**

```bash
git add docs/2026-08-25-12-attio-four-layer-inheritance.md
git commit -m "docs(attio): 12 设计 §10 自检更新为已实现（T6-T10）"
```

---

## 自检（对照 12 设计 §7/§8/§9）

- [x] §7.1 Identity → Task 7（domains auto_weak 边 + confirmWeakEdge 升强 + attio_id 外部键）
- [x] §7.2 Semantics → Task 6（semanticTag 自动词汇登记 + ordered-enum 量纲比较）+ Task 8（属性变更记忆）
- [x] §7.3 Structure → Task 8（relationship_strength/champion_strength 决策单元边）
- [x] §8 七维校验 → 维度 1/2/3 供给补全（维度 5/6/7 由决策主轴/事件总线供给，非本计划范围）
- [x] §9.1 编排 → Task 9（决策 relation 组置信度调节）+ Task 10（智能体 L1 投影）
- [x] §9.2 SKILL → `crm-*` 技能承接点（assembler L1 投影被技能消费；SKILL 本体不改，AI-* 不污染）
- [x] §9.3 闭环 → 属性变更事件进 memory_log（维度 6 供给源之一）
- [x] T7 验收①同域名双 CONTACT 归一→ 已建 auto_weak 边（多域名数组任一元素命中 + 子域后缀归一 + 防子串误判，commit `b0ca0a6` 闭环）
- [x] T7 验收②attio_id 唯一约束 → `particleModel.js` 声明 + `schema.sql` external_ids 唯一索引（前置 T1-T5 已含，此处复用）
- [x] T7 验收③弱边可人工确认升强 → `confirmWeakEdge` 实现

> **遗留项（非阻塞）**：多域名跨账户归一（同一公司多域名 → 合并阈值）未实现，仅单域名匹配；`attio_id` 唯一约束依赖 `schema.sql` external_ids（T1-T5 已建，若未建请在 Task 7 前补建）。