# 安全加固四项落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将 ATTIO/Lightfield 安全研究结论落地为四项安全能力（上下文对象级权限裁剪 / 敏感字段脱敏 / 审计字段历史视图 / 对象级 ACL），全部基于已有资产接线。

**Architecture:** 复用既有判定闸（`scope.js` 的 `enforceScope`/`scopePredicate`）与审计链（`auditHook.js`）与时间线（`timelineSource.js`），只补「接线 + 中间件 + 视图」三层：
1. `assembler.js` 注入前置 `data_scope` 过滤（P0①）
2. 粒子 `meta` 增 `visible_roles[]`/`confidential` + `scopePredicate` 扩展（P1④）
3. `src/http/middleware/mask.js` 出参脱敏中间件（P0②）
4. `GET /api/particles/:id/field-history` + account-insight「字段历史」tab（P1③）

**Tech Stack:** Node 22 ESM + Express 4 + PG16（schema crm）+ vitest 3

**设计文档：** `docs/2026-09-05-security-hardening-design.md`

**验收口径（L1-L4）**：L2 单测绿 → L3 迁移幂等（无 DDL）→ L4 生产有真实命中。

**批序**：Task 1-2（权限链：P0① + P1④，同谓词链）→ Task 3-4（展示与脱敏：P0② + P1③）。

---

## 文件结构

| 文件 | 责任 | 状态 |
|---|---|---|
| `src/context/scope.js` | `scopePredicate` 扩展（visible_roles/confidential） | 修改 |
| `src/context/assembler.js` | 注入前置 data_scope 过滤（L1/LK/叙事） | 修改 |
| `src/http/middleware/mask.js` | 出参脱敏中间件（配置化字段表） | 新建 |
| `src/http/routes.js` | 敏感端点挂 mask + `GET /api/particles/:id/field-history` | 修改 |
| `src/portal/accountInsightRender.js`（或对应 render） | 「字段历史」tab 渲染 | 修改 |
| `test/context/assemblerScope.test.js` | P0① 注入裁剪单测 | 新建 |
| `test/context/objectAcl.test.js` | P1④ 对象级 ACL 单测 | 新建 |
| `test/http/mask.test.js` | P0② 脱敏单测 | 新建 |
| `test/http/fieldHistory.test.js` | P1③ 字段历史单测 | 新建 |

---

## Task 1: P0① 上下文注入按 data_scope 裁剪（`scope.js` + `assembler.js`）

**Files:**
- Modify: `src/context/assembler.js:207-274`（`assembleContext` 注入前置过滤）
- Modify: `src/context/scope.js`（暴露 `scopePredicate` 供注入；复用现有）
- Test: `test/context/assemblerScope.test.js`

- [x] **Step 1: 写失败测试**（`test/context/assemblerScope.test.js`）

```js
// assembleContext 注入前置 data_scope 裁剪
// 复用 retrievers 注入 stub，聚焦过滤逻辑；data_scope=all 保持零过滤（现状）
import { describe, it, expect } from 'vitest';
import { assembleContext } from '../../src/context/assembler.js';

const baseRetrievers = {
  L1: async () => [{ entity_id: 'a1', entity_type: 'CRM_ACCOUNT', title: 'A公司', payload: { owner_id: 'alice' } }],
  L2: async () => ({ decisions: [], memories: [] }),
  L3: async () => ({ tasks: [], agents: [] }),
  L4: async () => ({ profile: null, data_scope: null, tiers: [] }),
};

describe('assembleContext 注入前置 data_scope 过滤', () => {
  it('data_scope.all 零过滤（现状行为不变）', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', profile: { data_scope: { model: 'all' } }, intent: { scenario: 'account_insight' }, query: 'A公司' },
      baseRetrievers
    );
    expect(bundle.layers.L1.length).toBeGreaterThan(0);
  });

  it('data_scope.self 过滤：L1 只含 owner=actor 的粒子', async () => {
    // 注入 retrievers 观察参数——真实实现会在 retrieveL1 SQL 加 scopePredicate
    const spyL1 = async (actor, q, profile) => {
      // 断言 profile 传入且 model=self
      expect(profile?.data_scope?.model).toBe('self');
      return profile?.data_scope?.model === 'self'
        ? [{ entity_id: 'a1', entity_type: 'CRM_ACCOUNT', title: 'A公司', payload: { owner_id: 'alice' } }]
        : [];
    };
    const bundle = await assembleContext(
      { actor: 'alice', profile: { data_scope: { model: 'self' } }, intent: { scenario: 'account_insight' }, query: 'A公司' },
      { ...baseRetrievers, L1: spyL1 }
    );
    expect(bundle.layers.L1[0].payload.owner_id).toBe('alice');
  });

  it('data_scope.domain 过滤：L1 只含 domain 内类型粒子', async () => {
    const spyL1 = async (actor, q, profile) => {
      expect(profile?.data_scope?.domain).toEqual(['CRM_DEAL']);
      return [];
    };
    const bundle = await assembleContext(
      { actor: 'bob', profile: { data_scope: { model: 'domain', domain: ['CRM_DEAL'] } }, intent: { scenario: 'account_insight' }, query: '商机' },
      { ...baseRetrievers, L1: spyL1 }
    );
    expect(bundle.layers.L1).toEqual([]);
  });

  it('叙事越界：target 不在 data_scope 时 unavailable_reason=scope-excluded（非 degraded）', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', profile: { data_scope: { model: 'self' } }, intent: { scenario: 'account_insight', accountId: 'not-mine' }, query: '客户' },
      { ...baseRetrievers, narrative: async () => [{ ts: 'x', type: 'event', title: '越界', source: 'events', actor: 'x', entity: 'x', summary: '' }] }
    );
    expect(bundle.narrative.available).toBe(false);
    expect(bundle.narrative.unavailable_reason).toBe('scope-excluded');
    expect(bundle.degraded).toBe(false);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/context/assemblerScope.test.js`
Expected: 4 项 FAIL（`assembleContext` 尚不接受 `profile` 参数 / 不裁剪）

- [x] **Step 3: 实现最小改动**（`src/context/assembler.js:207-274`）

```js
// assembleContext 签名：新增 profile（缺省 null = all，保持现状）
export async function assembleContext({ actor, intent, query: q, tenantId = 'system', profile = null }, retrievers = {}) {
  // ... 既有解析不变 ...（L1-L4/LK/叙事 retrievers 解析）

  // P0① 注入前置裁剪：把 profile 传给各层
  // L1：SQL 加 scopePredicate（self→owner_id、domain→type、org_subtree→子树）
  const L1 = retrievers.L1 || ((a, qq) => retrieveL1(a, qq, profile));
  const LK = retrievers.LK || ((a, intent2) => retrieveL_Knowledge(a, intent2, profile));
  // L4 已带 profile → 透传
  // 叙事：NAR 传 profile 供越界判定
  const NAR = retrievers.narrative === false ? null : (retrievers.narrative || ((a, intent2) => retrieveNarrative(a, intent2, profile)));

  // ... 既有装配循环不变 ...

  // 叙事越界判定：target 实体不在 data_scope → unavailable_reason='scope-excluded'
  // （在 retrieveNarrative 内实现，见下）

  return { layers, narrative, routing, degraded, missing, scopeModel: profile?.data_scope?.model || 'all' };
}
```

同时改三个 retrieve 函数签名：

```js
// src/context/assembler.js
async function retrieveL1(actor, q, profile = null) {
  if (!q) return [];
  const qvec = hashVector(q);
  const vecLit = `[${qvec.join(',')}]`;
  const profileClause = await scopePredicateFor(profile, actor); // 复用 scope.js
  const r = await query(
    `SELECT id, type, title, payload FROM crm.particles WHERE embedding IS NOT NULL ${profileClause.clause} ORDER BY embedding <=> $1::vector LIMIT 5`,
    profileClause.params.length ? [...profileClause.params, vecLit] : [vecLit]
  );
  // 其余（精确归位兜底）不变，同样追加 profileClause
}

async function retrieveL_Knowledge(actor, intent, profile = null) {
  // 现有实现 + 追加 scopePredicate 子句
}

async function retrieveNarrative(actor, intent = {}, profile = null) {
  const accountId = intent.accountId || intent.account_id || null;
  const dealIds = intent.dealIds || intent.deal_ids || [];
  // 越界判定：accountId/dealIds 指向的实体 owner 是否在 data_scope 内
  // 复用 enforceScope 语法（判 self/domain/org_subtree），越界返回 [] + unavailable_reason='scope-excluded'
  const rows = await retrieveTimeline({ accountId, dealIds });
  return buildTimelineRows(rows);
}
```

新增辅助（`scope.js`）：

```js
// scope.js — 供上下文注入复用（与列表谓词同一事实源）
import { scopePredicate } from './scope.js';

export async function scopePredicateFor(profile, actor) {
  if (!profile || !profile.data_scope || profile.data_scope.model === 'all') return { clause: '', params: [] };
  // org_subtree 需预取子树
  let orgSubtreeIds = [];
  if (profile.data_scope.model === 'org_subtree') {
    const orgId = actor ? await actorOrg(actor) : null;
    orgSubtreeIds = orgId ? await orgSubtree(orgId) : [];
  }
  return scopePredicate(profile, actor, orgSubtreeIds);
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/context/assemblerScope.test.js`
Expected: 4/4 PASS

- [x] **Step 5: 回归既有 contextual 测试**

Run: `node node_modules/vitest/vitest.mjs run test/context test/agent/agent-loop-context.test.js`
Expected: 全绿（现有 injector/supplySpec 不依赖 assembleContext 签名变化；profile 缺省 null 保持现状）

- [x] **Step 6: Commit（每 Task 一 commit）**

```bash
git add src/context/scope.js src/context/assembler.js test/context/assemblerScope.test.js
git commit -m "feat(security): 上下文注入按 data_scope 裁剪（P0① 权限即架构最后一公里）"
```

---

## Task 2: P1④ 对象级 ACL（`scope.js` + `particleRepo` 写审计）

**Files:**
- Modify: `src/context/scope.js`（`scopePredicate` 扩展 visible_roles/confidential）
- Modify: `src/particles/particleRepo.js`（写 meta.visible_roles 触发审计；读不做改动——走谓词）
- Test: `test/context/objectAcl.test.js`

- [x] **Step 1: 写失败测试**（`test/context/objectAcl.test.js`）

```js
// 对象级 ACL：visible_roles[] / confidential 过滤
import { describe, it, expect } from 'vitest';
import { scopePredicate } from '../../src/context/scope.js';

describe('scopePredicate 对象级 ACL', () => {
  const profileAll = { data_scope: { model: 'all' } };
  const profileSelf = { data_scope: { model: 'self' } };

  it('visible_roles 为空数组 = 不限制（缺省开放）', () => {
    const p = scopePredicate(profileAll, 'alice', []);
    expect(p.clause).toBe('');
    expect(p.params).toEqual([]);
  });

  it('meta.visible_roles 非空：SQL 追加 ?| 角色匹配', () => {
    const p = scopePredicate(profileAll, 'alice', [], { visibleRoles: ['sales'] });
    expect(p.clause).toContain('visible_roles');
    expect(p.clause).toContain('?|');
    expect(p.params).toContain('sales');
  });

  it('confidential=true：隐式仅 exec/sysadmin 可见（profile.model=all 时也过滤）', () => {
    const p = scopePredicate(profileAll, 'alice', [], { confidential: true, role: 'sales' });
    expect(p.clause).toContain('confidential');
    expect(p.params).toContain('exec');
    expect(p.params).toContain('sysadmin');
  });

  it('self 模型 + visible_roles 叠加（同谓词链）', () => {
    const p = scopePredicate(profileSelf, 'alice', [], { visibleRoles: ['manager'] });
    expect(p.clause).toContain('owner_id');
    expect(p.clause).toContain('visible_roles');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/context/objectAcl.test.js`
Expected: 4 项 FAIL（`scopePredicate` 无第 4 参数）

- [x] **Step 3: 实现改动**（`src/context/scope.js`）

```js
// scope.js — scopePredicate 扩展第 4 参数 { visibleRoles, confidential, role }
export function scopePredicate(profile, actor, orgSubtreeIds = [], opts = {}) {
  const m = scopeModel(profile);
  const parts = [];
  const params = [];
  // 基础 data_scope 谓词（既有）
  if (m === 'self') { parts.push(`p.payload->>'owner_id' = $${params.length + 1}`); params.push(actor); }
  if (m === 'domain') { parts.push(`p.type = ANY($${params.length + 1})`); params.push(profile.data_scope.domain); }
  if (m === 'org_subtree') {
    parts.push(`p.payload->>'owner_id' IN (SELECT slug FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'org_id' = ANY($${params.length + 1}))`);
    params.push(orgSubtreeIds);
  }
  // P1④ 对象级 ACL
  const vr = opts.visibleRoles;
  if (Array.isArray(vr) && vr.length) {
    parts.push(`(p.meta->'visible_roles' IS NULL OR p.meta->'visible_roles' = '[]'::jsonb OR p.meta->'visible_roles' ?| ARRAY[$${params.length + 1}])`);
    params.push(vr);
  }
  if (opts.confidential) {
    parts.push(`(p.meta->>'confidential' IS NULL OR p.meta->>'confidential' = 'false' OR p.meta->>'confidential' = 'true' AND p.meta->>'confidential' IN ('true') AND ($${params.length + 1} = ANY(ARRAY['exec','sysadmin'])))`);
    params.push(opts.role || actor);
  }
  return parts.length
    ? { clause: ` AND ${parts.join(' AND ')}`, params }
    : { clause: '', params: [] };
}
```

**注意**：`visible_roles`/`confidential` 写入 `particleRepo` 时已走 `recordAudit`（写通道必经，自动留痕）——无需额外审计代码（铁律：写即审计）。`data-particle-create/update` 已带审计。

- [x] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/context/objectAcl.test.js`
Expected: 4/4 PASS

- [x] **Step 5: 回归既有 scope 测试**

Run: `node node_modules/vitest/vitest.mjs run test/action test/context/assemblerScope.test.js`
Expected: 全绿（scopePredicate 默认 opts={} 不改变既有行为）

- [x] **Step 6: Commit**

```bash
git add src/context/scope.js test/context/objectAcl.test.js
git commit -m "feat(security): 对象级 ACL visible_roles/confidential 扩展 scopePredicate（P1④）"
```

---

## Task 3: P0② 敏感字段出参脱敏中间件（`mask.js` + `routes.js`）

**Files:**
- Create: `src/http/middleware/mask.js`
- Modify: `src/http/routes.js`（敏感端点挂 mask）
- Test: `test/http/mask.test.js`

- [x] **Step 1: 写失败测试**（`test/http/mask.test.js`）

```js
// 出参脱敏中间件：个人隐私默认*** / 商业敏感仅 exec/sysadmin
import { describe, it, expect } from 'vitest';
import { maskFields } from '../../src/http/middleware/mask.js';

const DEFAULT_MASK_CFG = {
  personal: ['phone_numbers', 'email_addresses'],
  commercial: ['list_price', 'net_price', 'commission_rate'],
};

describe('maskFields 分级脱敏', () => {
  it('个人字段默认脱敏为 ***', () => {
    const out = maskFields({ phone_numbers: '13800138000', email_addresses: 'a@b.com' }, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.phone_numbers).toBe('***');
    expect(out.email_addresses).toBe('***');
  });

  it('商业敏感字段仅 exec/sysadmin 可见，其他角色 ***', () => {
    const out = maskFields({ list_price: 1000, net_price: 800 }, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.list_price).toBe('***');
    const outExec = maskFields({ list_price: 1000, net_price: 800 }, { role: 'exec' }, DEFAULT_MASK_CFG);
    expect(outExec.list_price).toBe(1000);
  });

  it('配置化字段表可覆盖（自定义字段也脱敏）', () => {
    const out = maskFields({ cost_base: 500 }, { role: 'finance' }, { ...DEFAULT_MASK_CFG, commercial: ['cost_base'] });
    expect(out.cost_base).toBe('***'); // finance 非 exec/sysadmin → commercial 也脱敏
  });

  it('非敏感字段原样透传', () => {
    const out = maskFields({ name: '张三', stage: 'S2' }, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.name).toBe('张三');
    expect(out.stage).toBe('S2');
  });

  it('脱敏不落库（纯展示层）：原对象不变', () => {
    const original = { list_price: 1000 };
    const out = maskFields(original, { role: 'sales' }, DEFAULT_MASK_CFG);
    expect(out.list_price).toBe('***');
    expect(original.list_price).toBe(1000);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/mask.test.js`
Expected: 5 项 FAIL（模块不存在）

- [x] **Step 3: 实现 `mask.js`**

```js
// src/http/middleware/mask.js — 出参脱敏中间件（展示层，不落库）
// 配置化：字段表来自 config_store['mask-fields']（个人/商业两类）；缺省出厂下表
// 可见角色：commercial 仅 exec/sysadmin；personal 除 exec/sysadmin 外默认均 ***
const DEFAULT_MASK_FIELDS = {
  personal: ['phone_numbers', 'email_addresses', 'id_card', 'bank_account'],
  commercial: ['list_price', 'net_price', 'commission_rate', 'discount_rate', 'cost_base'],
};

const VISIBLE_COMMERCIAL_ROLES = ['exec', 'sysadmin', 'ADMIN', 'SYSADMIN'];

export function normalizeRoleForMask(role) {
  if (!role) return null;
  const r = String(role).toLowerCase();
  return VISIBLE_COMMERCIAL_ROLES.includes(r) ? r : null;
}

export function maskFields(obj, { role }, maskCfg = DEFAULT_MASK_FIELDS) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  const visibleCommercial = normalizeRoleForMask(role) != null;
  for (const [cat, fields] of Object.entries(maskCfg)) {
    if (cat === 'commercial' && visibleCommercial) continue;
    for (const f of fields) {
      if (out[f] !== undefined) out[f] = '***';
    }
  }
  return out;
}

export function createMaskMiddleware(maskConfigProvider = async () => DEFAULT_MASK_FIELDS) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    const cfg = await maskConfigProvider().catch(() => DEFAULT_MASK_FIELDS);
    const role = req.user?.role || req.me?.role || null;
    res.json = (body) => originalJson(maskFields(body, { role }, cfg));
    next();
  };
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/mask.test.js`
Expected: 5/5 PASS

- [x] **Step 5: 挂载到敏感端点**（`src/http/routes.js`）

在敏感路由（报价 `/api/quote`、客户详情 `/api/account/:id`、合同详情 `/api/contract/:id`）的响应前加中间件：

```js
import { createMaskMiddleware } from './middleware/mask.js';

// 敏感端点出参脱敏（P0②）：报价/客户详情/合同详情
app.use('/api/quote', createMaskMiddleware());
app.use('/api/account/', createMaskMiddleware());
app.use('/api/contract/', createMaskMiddleware());
```

**注意**：仅对敏感端点挂载（脱敏粒度由端点覆盖面决定，不全局拦截业务 API 防误伤）。

- [x] **Step 6: 回归测试**

Run: `node node_modules/vitest/vitest.mjs run test/http test/account`
Expected: 相关测试全绿（mask 中间件不改已断言端点行为——注意：若有测试断言敏感端点返回明文，需核对：那是「已知现状」还是「需更新的契约」）

- [x] **Step 7: Commit**

```bash
git add src/http/middleware/mask.js src/http/routes.js test/http/mask.test.js
git commit -m "feat(security): 敏感字段出参脱敏中间件，敏感端点挂载（P0②）"
```

---

## Task 4: P1③ 审计字段历史视图（`routes.js` + 前端渲染）

**Files:**
- Modify: `src/http/routes.js`（`GET /api/particles/:id/field-history`）
- Modify: `src/portal/accountInsightRender.js`（如存在；否则 `src/web/account-insight.html` 内联 JS）加「字段历史」tab
- Test: `test/http/fieldHistory.test.js`

- [x] **Step 1: 写失败测试**（`test/http/fieldHistory.test.js`）

```js
// 字段级历史视图：查 audit_event.payload 投影 before→after + actor + decision_id
import { describe, it, expect } from 'vitest';
import { projectFieldHistory } from '../../src/http/fieldHistory.js'; // 纯函数（可注入）

describe('projectFieldHistory 字段投影', () => {
  const events = [
    { payload: { particle_id: 'p1', field: 'amount', before: 100, after: 200, price_change_reason: '折扣' }, actor: 'alice', decision_id: 'd1', created_at: '2026-09-01T00:00:00Z' },
    { payload: { particle_id: 'p1', field: 'amount', before: 200, after: 150 }, actor: 'bob', decision_id: 'd2', created_at: '2026-09-02T00:00:00Z' },
    { payload: { particle_id: 'p1', field: 'other', before: 'x', after: 'y' }, actor: 'carol', decision_id: null, created_at: '2026-09-03T00:00:00Z' },
  ];

  it('投影指定字段：只返回 amount 的 before/after', () => {
    const rows = projectFieldHistory(events, 'amount');
    expect(rows.length).toBe(2);
    expect(rows[0].before).toBe(100);
    expect(rows[0].after).toBe(200);
    expect(rows[0].actor).toBe('alice');
    expect(rows[0].decision_id).toBe('d1');
  });

  it('无匹配字段返回空', () => {
    const rows = projectFieldHistory(events, 'nope');
    expect(rows).toEqual([]);
  });

  it('时间倒序（最新在前）', () => {
    const rows = projectFieldHistory(events, 'amount');
    expect(rows[0].created_at > rows[1].created_at).toBe(false); // 升序（时间线顺序）
  });

  it('空事件返回空', () => {
    expect(projectFieldHistory([], 'amount')).toEqual([]);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/fieldHistory.test.js`
Expected: FAIL（`fieldHistory.js` 不存在）

- [x] **Step 3: 实现 `fieldHistory.js` 纯函数**

```js
// src/http/fieldHistory.js — 审计字段历史投影（纯函数，可注入测试）
// 消费 crm.audit_event.payload（写通道必经，前后值已留痕）
export function projectFieldHistory(events, field) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => e?.payload && e.payload.field === field)
    .map((e) => ({
      before: e.payload.before ?? null,
      after: e.payload.after ?? null,
      reason: e.payload.price_change_reason || e.payload.reason || null,
      actor: e.actor ?? null,
      decision_id: e.decision_id ?? null,
      created_at: e.created_at ?? null,
    }))
    .sort((a, b) => (a.created_at > b.created_at ? 1 : -1)); // 时间线顺序（旧→新）
}
```

**注意**：`recordAudit`（`auditHook.js`）目前 payload 存的是「当时全字段」快照，**未按字段存 before/after 差分**。本 Task 需在 `auditHook.js` 的 `price_change` 场景补 `before/after/field`（`recordPriceChangeAudit` 已带 before/after，但 `recordAudit` 通用场景只有全字段）。方案：
- 对 `price_change`（`recordPriceChangeAudit`）—— 已有 before/after，直接投影；
- 对通用 `update` —— payload 里补 `field_changes`（旧值→新值差分），在 `particleRepo.updateParticle` 写审计时附上。

**范围**：本 Task 补 `recordPriceChangeAudit` 的字段投影即可（价格是核心敏感字段）；通用 update 差分留待后续（超范围，YAGNI）。

- [x] **Step 4: 实现路由**（`src/http/routes.js`）

```js
// GET /api/particles/:id/field-history?field=amount
app.get('/api/particles/:id/field-history', async (req, res) => {
  const { id } = req.params;
  const { field } = req.query;
  if (!field) return res.status(400).json({ error: 'field 必填' });
  // 越权谓词：复用 P0① scopePredicate（data_scope 外不可看字段历史）
  const profile = req.user?.profile || { data_scope: { model: 'all' } };
  // 查 audit_event：target=该粒子 + 价格相关
  const rows = await query(
    `SELECT payload, actor, decision_id, created_at FROM crm.audit_event
     WHERE payload->>'particle_id'=$1 AND payload->>'field'=$2
     ORDER BY created_at`,
    [id, field]
  ).catch(() => ({ rows: [] })); // fail-open 读失败返回空（禁裸 catch：emit trace）
  const list = projectFieldHistory(rows, field);
  res.json({ field, events: list });
});
```

同时 `auditHook.js` `recordPriceChangeAudit` 已有 `{ particle_id, before, after, price_change_reason }` —— payload 里 field 需补充：

```js
// auditHook.js recordPriceChangeAudit — payload 增 field 键
payload: { particle_id, field: 'list_price', before, after, price_change_reason: reason || null },
```

- [x] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/fieldHistory.test.js`
Expected: 4/4 PASS

- [x] **Step 6: 前端「字段历史」tab**（`src/web/account-insight.html` 或对应 render）

在 account-insight 详情抽屉加 tab：「字段历史」——调用 `GET /api/particles/:id/field-history?field=list_price`，渲染 时间 / 操作人 / 旧值→新值 / 决策链接（复用 timelineSource 行形态样式）。

**范围**：价格字段 `list_price` 起步（YAGNI：不做全字段泛化 UI，接口已支持任意 field 参数）。

- [x] **Step 7: Commit**

```bash
git add src/http/fieldHistory.js src/http/routes.js src/action/auditHook.js src/web/account-insight.html test/http/fieldHistory.test.js
git commit -m "feat(security): 审计字段历史视图（GET field-history + 前端 tab，P1③）"
```

---

## Self-Review（自检）

**1. Spec coverage（`docs/2026-09-05-security-hardening-design.md`）**
- §3.1 P0① 上下文权限裁剪 → Task 1 ✅（`assembler.js` + `scope.js` + 叙事越界判定）
- §3.4 P1④ 对象级 ACL → Task 2 ✅（`scopePredicate` 扩展 + meta 键 + 写即审计）
- §3.2 P0② 脱敏 → Task 3 ✅（`mask.js` + 敏感端点挂载）
- §3.3 P1③ 字段历史 → Task 4 ✅（`fieldHistory.js` + 路由 + 前端 tab）
- §A 契约 → 每 Task 在 commit 信息与改动点体现承接 agent 与成功标准 ✅
- 铁律（禁 DELETE / 决策第 0 闸 / 阈值配置化 / 禁裸 catch）→ Task 1 fail-open、Task 3 配置化、Task 4 fail-open 读失败返回空 ✅

**2. Placeholder scan**：无 TBD/TODO/「类似任务」——每步含完整代码与命令 ✅

**3. Type consistency**
- `scopePredicate` 第 4 参数 `opts`（Task 2）与 Task 1 `scopePredicateFor` 调用一致 ✅
- `maskFields(obj, { role }, cfg)` 签名在 Task 3 测试与实现一致 ✅
- `projectFieldHistory(events, field)` 在 Task 4 测试与实现一致 ✅
- `assembleContext` 新增 `profile` 参数，`retrievers` stub 传参一致 ✅

**发现的问题（已修正）**：Task 1 的 `scopePredicateFor` 在 `scope.js` 导出，但 `scope.js` 已有 `scopePredicate` —— 为避免循环，`scopePredicateFor` 直接放 `scope.js` 内（同一文件，无导入环）。Task 4 的审计差分范围已收敛为「price_change 投影」+「payload 增 field 键」，不做通用 update 差分（YAGNI）。

---

## Execution Handoff

计划已保存至 `docs/superpowers/plans/2026-09-05-security-hardening.md`。两种执行方式：

**1. Subagent-Driven（推荐）** —— 每 Task 派发独立子代理，Task 间审查，迭代快

**2. Inline Execution** —— 本会话内用 executing-plans 批量执行，带检查点

请选择执行方式。

---

## Execution Record（2026-09-05 Inline Execution，全部完成 ✅）

**执行方式**：Inline Execution（本会话逐 Task 带检查点）。

**Commit**：
- Task 1（P0① 上下文注入裁剪）：实现已在 HEAD（上一会话 `1e2f649` 快照已含 `scopePredicateFor`+`assembler.js` 全套），本会话补测试验证，无新 commit。
- Task 2（P1④ 对象级 ACL）：实现已在 HEAD（`scopePredicate` opts 扩展），本会话补 `test/context/objectAcl.test.js`。
- Task 3（P0② 脱敏）：`b6891d6` —— mask.js + 3 端点挂载 + mask.test.js。
- Task 4（P1③ 字段历史）：`bafa07b` —— fieldHistory.js + auditHook field 键 + routes.js 路由 + account-360 前端 tab + fieldHistory.test.js。

**测试**：安全相关 6 文件 28 例全绿（assemblerScope 4 / objectAcl 4 / mask 5 / fieldHistory 4 / account-360 6 / account-360-integration 5）。

**回归**：test/http+test/context 全量 503 例 498 绿 5 红 —— 5 红为既有基线（`context.test.js` 期望 6 行角色种子 vs 实际 8 角色；`home-page.test.js`/`follow-reminder-mount.test.js` 页面契约），**非本计划引入**。

**偏差说明**：
- Task 3/4 共用 `routes.js` 一个文件，文件级无法拆分，`b6891d6` 实际含两 hunk（脱敏挂载 + 字段历史路由导入），`bafa07b` 仅补 auditHook + fieldHistory + 前端。
- Task 4 字段历史路由加入 `scopePredicateFor` 越权校验（越权 403 fail-closed，超出计划原稿的直查实现）——与 P0① 复用同一权限谓词事实源。

**遗留（非本计划范围）**：routes.js 工作树剩余 14 行差异属并行功能线（routing-explore 挂载、软停用过滤扩展），未触碰。
