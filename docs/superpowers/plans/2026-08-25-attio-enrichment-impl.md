# ATTIO 属性/交互模型借鉴 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ATTIO extract 的 firmographics、联系人 enrichment、关系强度、交互渠道维度借鉴进本项目 9 粒子模型（范围 A+B+C+D），不新增粒子、不扩展 19 类型集。

**Architecture:** 在 `particleModel.js` 以声明式 `coreAttributes` 承载 ATTIO 新增属性并加 `key_contact` 受控谓词；交互渠道以"事件平面 + 写时维护 `interaction_index` 计算指针(first/last/next)"实现，复用现有 `particles/events` 表与三钩子，不新增粒子。

**Tech Stack:** Node 22 ESM + PostgreSQL 16(pgcrypto+vector) + vitest 3（写时真实 PG@5433；纯逻辑测试不依赖 DB）。

**来源设计：** `docs/2026-08-25-11-attio-enrichment-design.md`（已批准）

---

### Task 1: 粒子模型声明 ATTIO 属性 + key_contact 谓词

**Files:**
- Modify: `src/particles/particleModel.js`
- Test: `test/attio-attributes.test.js`（纯逻辑，无 DB）

- [ ] **Step 1: 写失败测试**

```js
// test/attio-attributes.test.js
import { describe, it, expect } from 'vitest';
import {
  PARTICLE_TYPES, ATTRIBUTE_TYPE_SET, CONTROLLED_PREDICATES,
  validateCoreAttributesSchema,
} from '../src/particles/particleModel.js';

describe('ATTIO 属性声明 + 19 类型集纪律', () => {
  it('所有粒子 coreAttributes 类型均落在 19 类型集内', () => {
    expect(validateCoreAttributesSchema()).toBe(true);
  });

  it('CRM_ACCOUNT 含 ATTIO A 桶 firmographics（类型合法）', () => {
    const a = PARTICLE_TYPES.CRM_ACCOUNT.coreAttributes;
    expect(a.domains).toBe('domain');
    expect(a.funding_raised_usd).toBe('currency');
    expect(a.foundation_date).toBe('date');
    expect(a.estimated_arr_usd).toBe('select');
    expect(a.employee_range).toBe('select');
    expect(a.categories).toBe('select');
    expect(a.logo_url).toBe('url');
    expect(a.linkedin).toBe('url');
    expect(a.champion_strength).toBe('select');
    expect(a.key_contact).toBe('actor-reference');
  });

  it('CRM_CONTACT 含 ATTIO B/D 桶 enrichment', () => {
    const c = PARTICLE_TYPES.CRM_CONTACT.coreAttributes;
    expect(c.job_title).toBe('text');
    expect(c.avatar_url).toBe('url');
    expect(c.primary_location).toBe('location');
    expect(c.company).toBe('record-reference');
    expect(c.relationship_strength).toBe('select');
  });

  it('key_contact 进入受控谓词', () => {
    expect(CONTROLLED_PREDICATES).toContain('key_contact');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-attributes.test.js`
Expected: FAIL（`validateCoreAttributesSchema` 未定义 / `coreAttributes` 不存在）

- [ ] **Step 3: 实现最小代码**

在 `src/particles/particleModel.js` 的 `CRM_ACCOUNT` 与 `CRM_CONTACT` 定义内新增 `coreAttributes`；在 `CONTROLLED_PREDICATES` 数组加入 `'key_contact'`；在文件末尾新增校验函数。

```js
  CRM_ACCOUNT: {
    slug: 'account', title: '客户',
    identity: ['name'],
    states: { current: 'potential', flow: ['potential','active','dormant','lost'] },
    why: 'dormant_reason',
    coreAttributes: {
      name: 'text', industry: 'select', region: 'select', business_title: 'text',
      source: 'select', size: 'select', rating: 'rating',
      // ATTIO A 桶 firmographics
      domains: 'domain', funding_raised_usd: 'currency', foundation_date: 'date',
      estimated_arr_usd: 'select', employee_range: 'select', categories: 'select',
      logo_url: 'url', linkedin: 'url', twitter: 'url', facebook: 'url',
      instagram: 'url', angellist: 'url',
      // ATTIO D 桶 关系强度
      champion_strength: 'select', key_contact: 'actor-reference',
    },
  },
  CRM_CONTACT: {
    slug: 'contact', title: '联系人',
    identity: ['name'],
    states: { current: 'active', flow: ['active','departed'] },
    coreAttributes: {
      name: 'personal-name', email: 'email-address', phone: 'phone-number',
      title: 'text', department: 'select', decision_power: 'select',
      // ATTIO B 桶 enrichment
      job_title: 'text', avatar_url: 'url', primary_location: 'location',
      linkedin: 'url', twitter: 'url', company: 'record-reference',
      // ATTIO D 桶 关系强度
      relationship_strength: 'select',
    },
  },
```

`CONTROLLED_PREDICATES` 改为：
```js
export const CONTROLLED_PREDICATES = [
  'belongs_to','owned_by','part_of','has_employee','works_at','priced_by',
  'used_in','referenced_in','evidenced_by','sourcedFrom','transitionedBecause',
  'instanceOf','explains','member_of','governs','temporallyFollows','key_contact',
];
```

文件末尾新增：
```js
// 校验所有粒子 coreAttributes 类型 ∈ 19 类型集（ATTIO 借鉴纪律闸门）
export function validateCoreAttributesSchema() {
  for (const [type, def] of Object.entries(PARTICLE_TYPES)) {
    for (const [slug, t] of Object.entries(def.coreAttributes || {})) {
      if (!ATTRIBUTE_TYPE_SET.has(t)) {
        throw new Error(`粒子 ${type} 属性 ${slug} 类型 ${t} 不在 19 类型集内`);
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-attributes.test.js`
Expected: PASS（4/4）

- [ ] **Step 5: 提交**

```bash
git add src/particles/particleModel.js test/attio-attributes.test.js
git commit -m "feat(attio): 粒子模型声明 ATTIO firmographics/关系强度属性 + key_contact 谓词"
```

---

### Task 2: 交互渠道索引纯函数（first/last/next）

**Files:**
- Create: `src/particles/interactionIndex.js`
- Test: `test/attio-attributes.test.js`（同文件追加 describe 块，纯逻辑无 DB）

- [ ] **Step 1: 写失败测试（追加到 test/attio-attributes.test.js）**

```js
import { INTERACTION_CHANNELS, emptyInteractionIndex, applyInteraction } from '../src/particles/interactionIndex.js';

describe('ATTIO C 桶 交互渠道索引纯逻辑', () => {
  it('渠道枚举 = email/calendar/call/meeting/general', () => {
    expect(INTERACTION_CHANNELS).toEqual(['email','calendar','call','meeting','general']);
  });
  it('空索引结构正确', () => {
    const idx = emptyInteractionIndex();
    expect(idx.email).toEqual({ first_at: null, last_at: null, next_at: null });
  });
  it('applyInteraction last 取最大值、first 取最小值、next 取最小值', () => {
    let idx = emptyInteractionIndex();
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-10T00:00:00Z', kind: 'last' });
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-05T00:00:00Z', kind: 'last' });
    expect(idx.email.last_at).toBe('2026-08-10T00:00:00Z'); // 取晚
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-01T00:00:00Z', kind: 'first' });
    expect(idx.email.first_at).toBe('2026-08-01T00:00:00Z'); // 取早
    idx = applyInteraction(idx, { channel: 'email', at: '2026-09-01T00:00:00Z', kind: 'next' });
    idx = applyInteraction(idx, { channel: 'email', at: '2026-08-20T00:00:00Z', kind: 'next' });
    expect(idx.email.next_at).toBe('2026-08-20T00:00:00Z'); // 取最早计划
  });
  it('未知渠道/未知指针抛错', () => {
    expect(() => applyInteraction(emptyInteractionIndex(), { channel: 'sms', at: '2026-08-10T00:00:00Z', kind: 'last' })).toThrow(/未知交互渠道/);
    expect(() => applyInteraction(emptyInteractionIndex(), { channel: 'email', at: '2026-08-10T00:00:00Z', kind: 'wrong' })).toThrow(/未知指针类型/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/attio-attributes.test.js`
Expected: FAIL（`interactionIndex` 模块不存在）

- [ ] **Step 3: 实现**

```js
// src/particles/interactionIndex.js — ATTIO C 桶：交互渠道维度 + first/last/next 计算指针
import { updateParticle, getParticle } from './particleRepo.js';
import { emit } from '../events/bus.js';

export const INTERACTION_CHANNELS = ['email', 'calendar', 'call', 'meeting', 'general'];

export function emptyInteractionIndex() {
  const idx = {};
  for (const ch of INTERACTION_CHANNELS) idx[ch] = { first_at: null, last_at: null, next_at: null };
  return idx;
}

export function applyInteraction(index, { channel, at, kind }) {
  if (!INTERACTION_CHANNELS.includes(channel)) throw new Error(`未知交互渠道: ${channel}`);
  if (!['first', 'last', 'next'].includes(kind)) throw new Error(`未知指针类型: ${kind}`);
  const idx = JSON.parse(JSON.stringify(index || emptyInteractionIndex()));
  const cur = idx[channel];
  const t = new Date(at).toISOString();
  if (kind === 'first') { if (!cur.first_at || t < cur.first_at) cur.first_at = t; }
  else if (kind === 'last') { if (!cur.last_at || t > cur.last_at) cur.last_at = t; }
  else if (kind === 'next') { if (!cur.next_at || t < cur.next_at) cur.next_at = t; }
  return idx;
}

export async function recordInteraction({ relatedType, relatedId, channel, at, kind = 'last' }) {
  if (!INTERACTION_CHANNELS.includes(channel)) throw new Error(`未知交互渠道: ${channel}`);
  if (!['first', 'last', 'next'].includes(kind)) throw new Error(`未知指针类型: ${kind}`);
  const p = await getParticle(relatedId);
  if (!p) throw new Error(`粒子不存在: ${relatedId}`);
  const idx = applyInteraction(p.payload.interaction_index, { channel, at, kind });
  const np = await updateParticle(relatedId, { patch: { interaction_index: idx } });
  emit('particle', 'interaction-recorded', { relatedType, relatedId, channel, kind, at });
  return np;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/attio-attributes.test.js`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/particles/interactionIndex.js test/attio-attributes.test.js
git commit -m "feat(attio): 交互渠道 first/last/next 计算索引（纯函数 + recordInteraction）"
```

---

### Task 3: 钩子接线 key_contact 边 + 交互事件落库

**Files:**
- Modify: `src/ontology/hooks.js`（ontologySync 加 key_contact 自动边）
- Test: `test/interaction-index.test.js`（DB 集成，需 PG@5433）

- [ ] **Step 1: 写失败测试**

```js
// test/interaction-index.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle, getParticle, queryNeighbors } from '../src/particles/particleRepo.js';
import { recordInteraction } from '../src/particles/interactionIndex.js';

beforeEach(async () => { await query(`TRUNCATE particles, edges, events CASCADE`); });

describe('ATTIO 借鉴 DB 集成', () => {
  it('ACCOUNT 带 key_contact 落库自动建 key_contact 受控边', async () => {
    const contact = await createParticle('CRM_CONTACT', { name: '李工', email: 'li@x.com' });
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技', key_contact: contact.id });
    const n = await queryNeighbors('CRM_ACCOUNT', acct.id);
    expect(n.some(e => e.edge_type === 'key_contact' && e.target_id === contact.id)).toBe(true);
  });

  it('recordInteraction 写时维护 interaction_index', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技' });
    await recordInteraction({ relatedType: 'CRM_ACCOUNT', relatedId: acct.id, channel: 'email', at: '2026-08-10T00:00:00Z', kind: 'last' });
    await recordInteraction({ relatedType: 'CRM_ACCOUNT', relatedId: acct.id, channel: 'email', at: '2026-09-01T00:00:00Z', kind: 'next' });
    const p = await getParticle(acct.id);
    expect(p.payload.interaction_index.email.last_at).toBe('2026-08-10T00:00:00Z');
    expect(p.payload.interaction_index.email.next_at).toBe('2026-09-01T00:00:00Z');
    const ev = await query(`SELECT count(*) c FROM events WHERE domain='particle' AND payload->>'channel'='email'`);
    expect(ev.rows[0].c >= 1).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/interaction-index.test.js`
Expected: FAIL（key_contact 边未自动建 / interaction_index 未维护）

- [ ] **Step 3: 实现（hooks.js ontologySync）**

在 `src/ontology/hooks.js` 的 `refs` 数组追加一行：
```js
  const refs = [
    ['owner_id', 'owned_by', 'CRM_PERSON'],
    ['org_id', 'part_of', 'CRM_ORGANIZATION'],
    ['account_id', 'belongs_to', 'CRM_ACCOUNT'],
    ['key_contact', 'key_contact', 'CRM_CONTACT'],
  ];
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/interaction-index.test.js`
Expected: PASS（需 PG@5433；沙箱无 PG 时标注环境限制，非回归）

- [ ] **Step 5: 提交**

```bash
git add src/ontology/hooks.js test/interaction-index.test.js
git commit -m "feat(attio): key_contact 自动边 + 交互事件写时维护 interaction_index"
```

---

### Task 4: schema.sql 事件渠道索引

**Files:**
- Modify: `db/schema.sql`

- [ ] **Step 1: 实现**

在 `events` 表定义之后追加：
```sql
-- ATTIO C 桶：交互事件渠道索引（channel ∈ email/calendar/call/meeting/general）
CREATE INDEX IF NOT EXISTS idx_crm_events_payload_channel
  ON crm.events USING gin ((payload->'channel'));
```

- [ ] **Step 2: 语法自检**

Run: `node --check db/schema.sql` （注：SQL 非 JS，仅人工确认；或 `psql` Dry-run 略）
Expected: 无语法错误（人工核对分号/括号）

- [ ] **Step 3: 提交**

```bash
git add db/schema.sql
git commit -m "feat(attio): events 表交互渠道 channel GIN 索引"
```

---

### Task 5: 文档同步（01 粒子设计 + 11 增量设计）

**Files:**
- Modify: `docs/2026-08-25-01-ai-particle-system-design.md` §2.1 P2/P3、§2.4
- Modify: `docs/2026-08-25-11-attio-enrichment-design.md` §6

- [ ] **Step 1: 同步 01 文档**

在 §2.1 P2 CRM_ACCOUNT ③ core_attributes 行末补充：`+ ATTIO 借鉴：domains/funding_raised_usd/foundation_date/estimated_arr_usd/employee_range/categories/logo_url/社媒(linkedin·twitter·facebook·instagram·angellist)/champion_strength(select)/key_contact(actor-reference)`。

在 §2.1 P3 CRM_CONTACT ③ core_attributes 行末补充：`+ ATTIO 借鉴：job_title/avatar_url/primary_location/社媒/company(record-reference)/relationship_strength(select)`。

在 §2.4 交互粒子必带属性补充：`+ interaction_index（按 channel∈{email,calendar,call,meeting,general} 维护 first/last/next 计算指针，见 interactionIndex.js）`。

- [ ] **Step 2: 同步 11 增量设计 §6 自检**

将 §6 末行 `- [ ] 待批准实现后补：单元测试…` 改为 `- [x] 单元测试已补（attio-attributes.test.js 纯逻辑 + interaction-index.test.js DB 集成）`。

- [ ] **Step 3: 提交**

```bash
git add docs/2026-08-25-01-ai-particle-system-design.md docs/2026-08-25-11-attio-enrichment-design.md
git commit -m "docs(attio): 01 粒子设计 + 11 增量设计同步 ATTIO 借鉴落地"
```

---

### Task 6: 全量测试 + 收尾

**Files:** 无新增，验证用

- [ ] **Step 1: 运行纯逻辑测试（不依赖 DB）**

Run: `node node_modules/vitest/vitest.mjs run test/attio-attributes.test.js`
Expected: PASS

- [ ] **Step 2: 运行全量（需 PG@5433）**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 基线 33 + 新增纯逻辑 8 全绿；DB 集成 2 例在 PG 可用时通过

- [ ] **Step 3: 更新工作日志**

向 `D:\system\CRM-ai-native\.workbuddy/memory\2026-08-25.md` 追加 ATTIO 借鉴实现完成记录（Task 1-5 落点 + 测试结论）。

---

## 自检（对照设计 11 文档）

- [x] A 桶 firmographics → CRM_ACCOUNT.coreAttributes（domains/funding_raised_usd/.../社媒）
- [x] B 桶 enrichment → CRM_CONTACT.coreAttributes（job_title/avatar_url/primary_location/company/社媒）
- [x] D 桶 关系强度 → champion_strength+key_contact(ACCOUNT) / relationship_strength(CONTACT) + key_contact 受控谓词
- [x] C 桶 交互渠道 → INTERACTION_CHANNELS + applyInteraction + recordInteraction + events.channel 索引
- [x] 粒子数=9（无新增）
- [x] 类型集=19（validateCoreAttributesSchema 闸门）
- [x] 10 ai-* SKILL 不动
- [x] 18 候选 slug 折叠（实现层未新增粒子）
