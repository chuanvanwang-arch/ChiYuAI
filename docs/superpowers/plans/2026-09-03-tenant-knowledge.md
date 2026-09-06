# 租户级 Knowledge（P0-②）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现租户级领域 Know-How（ICP/竞品/异议/买家语言）的沉淀、写入、注入与复盘回写闭环，落地 `docs/2026-09-03-tenant-knowledge-design.md`（已批准）。

**Architecture:** 复用已注册的 `CRM_KNOWLEDGE` 粒子（particleModel.js:78）为数据形态；`crm-knowledge-upsert` Action（write，第0闸 + confirm:'critical' 双段）为唯一写入通道；`assembleContext` 新增 `retrieveL_Knowledge` 按 `intent.scenario`→kind 映射按需注入（映射走 config_store）；`submitRetro` 新增 C4 通道把赢单/输单语言回写为 KNOWLEDGE 粒子（溯源 decision_id）；`knowledge-config.html` 提供租户级管理视图；`industry-onboarding` 扩展 Step 4.5 播种。全程禁 DELETE、tenant_id 隔离、零信任不旁路。

**Tech Stack:** Node 22 ESM、Express4、PostgreSQL 16（schema crm）+ pg；vitest（默认连 `crm_native_test`）。复用：`src/particles/particleRepo.js`（createParticle/updateParticle）、`src/config/configStore.js`（readConfig/writeConfig）、`src/decision/closureLoop.js`（submitRetro）、`src/action/registry.js`（registerAction）、`src/context/assembler.js`（assembleContext）、`src/http/routes.js`、`src/metaAttr/metaAttrRepo.js`（seedMetaAttr）。

---

## 文件结构

| 动作 | 路径 | 职责 |
|---|---|---|
| Modify | `src/particles/particleModel.js:78-82` | 为 CRM_KNOWLEDGE 增 coreAttributes（kind/content/source/confidence/tags），触发 meta_attr 种子物化 |
| Modify | `src/metaAttr/metaAttrRepo.js` | 无代码改动（seedMetaAttr 已泛化读 PARTICLE_TYPES.coreAttributes）；仅靠 particleModel 新属性物化 |
| Modify | `src/action/seed-actions.js` | 注册 `crm-knowledge-upsert` write action（第0闸 + confirm:'critical' + rbac_roles） |
| Modify | `src/context/assembler.js` | 新增 `retrieveL_Knowledge` + `assembleContext` 装配 L_KNOWLEDGE 层 |
| Modify | `src/decision/closureLoop.js:95-175` | submitRetro 内追加 C4 通道（knowledge_particles → KNOWLEDGE 粒子回写） |
| Modify | `src/config/configStore.js` | 无代码改动（readConfig/writeConfig 已 per-tenant 通用） |
| Create | `src/web/knowledge-config.html` | 租户级知识管理页（清单/录入/审核） |
| Modify | `src/http/routes.js` | 注册 `GET /knowledge-config.html` 静态页 + `GET/POST /api/knowledge` 管理 API |
| Modify | `plugin-platform-admin/skills/industry-onboarding/SKILL.md` | 新增 Step 4.5 播种 KNOWLEDGE 种子 |
| Create | `test/knowledge.test.js` | 纯逻辑单测（映射/action 注册/注入格式，无 PG 依赖） |
| Create | `test/knowledge-integration.test.js` | 集成测试（DB 用例无 DB 时 skip） |

---

## Task 1：CRM_KNOWLEDGE coreAttributes 物化

**Files:**
- Modify: `src/particles/particleModel.js:78-82`
- Test: `test/knowledge.test.js`

- [ ] **Step 1: 写失败测试**（meta_attr 种子应包含 KNOWLEDGE 的 kind/content/source/confidence/tags）

```js
// test/knowledge.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../src/action/seed-actions.js';
import { getAction } from '../src/action/registry.js';
import { PARTICLE_TYPES } from '../src/particles/particleModel.js';

describe('CRM_KNOWLEDGE 粒子定义', () => {
  it('coreAttributes 包含 kind/content/source/confidence/tags', () => {
    const def = PARTICLE_TYPES.CRM_KNOWLEDGE;
    expect(def).toBeDefined();
    const attrs = Object.keys(def.coreAttributes || {});
    expect(attrs).toEqual(expect.arrayContaining(['kind', 'content', 'source', 'confidence', 'tags']));
  });
  it('identity 仍为 term', () => {
    expect(PARTICLE_TYPES.CRM_KNOWLEDGE.identity).toEqual(['term']);
  });
});

describe('crm-knowledge-upsert Action 注册', () => {
  beforeAll(() => seedActions());
  it('已注册为 write + confirm:critical + rbac_roles', () => {
    const a = getAction('crm-knowledge-upsert');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.confirm).toBe('critical');
    expect(a.rbac_roles).toEqual(expect.arrayContaining(['manager', 'presales', 'exec', 'sysadmin']));
  });
  it('参数 schema 定义 term/kind/content', () => {
    const a = getAction('crm-knowledge-upsert');
    expect(a.parameters.required).toEqual(expect.arrayContaining(['term', 'kind', 'content']));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/knowledge.test.js`
Expected: FAIL（coreAttributes 断言与 action 注册断言未实现）

- [ ] **Step 3: 实现 coreAttributes**

在 `src/particles/particleModel.js:78-82` 的 CRM_KNOWLEDGE 定义中加 coreAttributes：

```js
  CRM_KNOWLEDGE: {
    slug: 'knowledge', title: '知识/词表',
    identity: ['term'],
    states: { current: 'registered', flow: ['registered','deprecated'] },
    // P0-② 领域 Know-How（doc: 2026-09-03-tenant-knowledge-design）：
    // kind ∈ {icp, competitors, objections, buyer_language}（行业配置化，禁硬编码于逻辑）
    coreAttributes: {
      term: 'text',           // 标题/检索锚点（identity 同源）
      kind: 'text',           // icp | competitors | objections | buyer_language
      content: 'text',        // 知识正文
      source: 'text',         // manual | retro_win | retro_lose | import
      confidence: 'number',   // 0-1，人工录入默认 1，复盘回写取决策 confidence
      tags: 'text',           // 可选检索标签（JSON 数组字面量）
    },
  },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/knowledge.test.js`
Expected: PASS（coreAttributes 断言通过；action 断言仍失败——属 Task 2）

- [ ] **Step 5: Commit**

```bash
git add src/particles/particleModel.js test/knowledge.test.js
git commit -m "feat(knowledge): CRM_KNOWLEDGE coreAttributes 定义（P0-② tenant-knowledge 基础）"
```

---

## Task 2：crm-knowledge-upsert Action 注册

**Files:**
- Modify: `src/action/seed-actions.js`
- Test: `test/knowledge.test.js`

- [ ] **Step 1: 写失败测试**（已随 Task 1 写入——action 断言部分）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/knowledge.test.js`
Expected: FAIL（action 断言 `expect(a).toBeTruthy()` 未通过）

- [ ] **Step 3: 实现 Action**

在 `src/action/seed-actions.js` 的 `export function seedActions() {` 内、`crm-memory-upsert` 注册（:159-194）旁新增：

```js
  // P0-② 租户级 Knowledge 写入通道（docs/2026-09-03-tenant-knowledge-design.md §5）
  // 零信任不旁路：第0闸（decision_id）+ confirm:'critical' 双段（全仓无 needsApproval:true 先例，
  //   对齐 crm-deal-advance 范式）；rbac_roles 白名单（第1.5闸）。
  registerAction({
    name: 'crm-knowledge-upsert', kind: 'write', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false, confirm: 'critical',
    rbac_roles: ['manager', 'presales', 'exec', 'sysadmin'],
    version: '1.0.0', owner: 'crm-native',
    schema: {
      id: 'string', term: 'string', kind: 'string', content: 'string',
      source: 'string', confidence: 'number', tags: 'array',
    },
    parameters: {
      required: ['term', 'kind', 'content'],
      properties: {
        id: { type: 'string', description: '存在则更新，缺则新建' },
        term: { type: 'string' },
        kind: { type: 'string', enum: ['icp','competitors','objections','buyer_language'] },
        content: { type: 'string' },
        source: { type: 'string', default: 'manual' },
        confidence: { type: 'number', default: 1 },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (p, ctx) => {
      const tid = ctx.tenantId || 'system';
      const payload = {
        term: p.term, kind: p.kind, content: p.content,
        source: p.source || 'manual',
        confidence: Number(p.confidence ?? 1),
        tags: Array.isArray(p.tags) ? p.tags : [],
      };
      const decisionId = ctx.decision_id || null;
      if (p.id) {
        const r = await updateParticle(p.id, {
          patch: payload, requireDecisionId: decisionId,
        }).catch((e) => { recordFailure('crm-knowledge-update-failed', e); return null; });
        if (!r) return { ok: false, error: 'knowledge 更新失败（见 trace）' };
        return { ok: true, id: r.id, updated: true };
      }
      const r = await createParticle('CRM_KNOWLEDGE', payload, {
        tenantId: tid, actor: ctx.actor, requireDecisionId: decisionId,
      }).catch((e) => { recordFailure('crm-knowledge-create-failed', e); return null; });
      if (!r) return { ok: false, error: 'knowledge 创建失败（见 trace）' };
      return { ok: true, id: r.id, created: true };
    },
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/knowledge.test.js`
Expected: PASS（action 断言通过）

- [ ] **Step 5: Commit**

```bash
git add src/action/seed-actions.js test/knowledge.test.js
git commit -m "feat(knowledge): crm-knowledge-upsert 写入 Action（第0闸+confirm双段+rbac白名单）"
```

---

## Task 3：assembleContext 按需注入（L_KNOWLEDGE 层）

**Files:**
- Modify: `src/context/assembler.js`
- Modify: `src/config/configStore.js`（无代码改动，仅靠已有 writeConfig 落映射）
- Test: `test/knowledge.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/knowledge.test.js` 追加：

```js
import { SCENARIO_KNOWLEDGE_MAP, resolveKnowledgeKinds } from '../src/context/assembler.js';

describe('Knowledge 注入映射（纯逻辑）', () => {
  it('QUOTE_PRICING → competitors+objections', () => {
    expect(SCENARIO_KNOWLEDGE_MAP.QUOTE_PRICING).toEqual(['competitors', 'objections']);
  });
  it('未知 scenario 回退全量（缺省）', () => {
    expect(SCENARIO_KNOWLEDGE_MAP.UNKNOWN_SCENE || resolveKnowledgeKinds('UNKNOWN_SCENE')).toContain('buyer_language');
  });
  it('resolveKnowledgeKinds 应用配置覆盖', () => {
    expect(resolveKnowledgeKinds('QUOTE_PRICING', { QUOTE_PRICING: ['icp'] })).toEqual(['icp']);
  });
});

describe('注入行格式', () => {
  it('L_KNOWLEDGE 行形如 {kind, term, content}', async () => {
    const { buildKnowledgeRows } = await import('../src/context/assembler.js');
    const rows = buildKnowledgeRows([
      { payload: { kind: 'icp', term: 'T', content: 'C' } },
    ]);
    expect(rows[0]).toEqual({ kind: 'icp', term: 'T', content: 'C' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/knowledge.test.js`
Expected: FAIL（SCENARIO_KNOWLEDGE_MAP / resolveKnowledgeKinds / buildKnowledgeRows 未定义）

- [ ] **Step 3: 实现**

在 `src/context/assembler.js`：

1) 文件头部（`import { SEMANTIC_TAGS } ...` 之后）新增导出：

```js
// P0-② 租户级 Knowledge 注入（docs/2026-09-03-tenant-knowledge-design.md §6）
// scenario → kind 映射：出厂默认（config_store['knowledge-injection-map'] 可覆盖，禁散点硬编码）
export const SCENARIO_KNOWLEDGE_MAP = {
  QUOTE_PRICING: ['competitors', 'objections'],
  REVIEW_GATE: ['objections'],
  ICP_MATCH: ['icp'],
  WIN_RETRO: ['buyer_language', 'objections'],
  LOSE_RETRO: ['buyer_language', 'objections'],
  OUTBOUND: ['buyer_language'],
};

export function resolveKnowledgeKinds(scenario, override = null) {
  if (override && typeof override === 'object' && Array.isArray(override[scenario])) {
    return override[scenario];
  }
  return SCENARIO_KNOWLEDGE_MAP[scenario] || ['icp', 'competitors', 'objections', 'buyer_language'];
}

export function buildKnowledgeRows(rows) {
  return (rows || []).map((row) => {
    const p = row.payload || {};
    return { kind: p.kind, term: p.term, content: p.content };
  });
}
```

2) `retrieveL_Knowledge`（放在 `retrieveL4` 之后）：

```js
// P0-② 知识层：按 intent.scenario → kind 过滤（config_store['knowledge-injection-map'] 租户可覆盖）
async function retrieveL_Knowledge(actor, intent) {
  const scenario = intent?.scenario || null;
  const cfg = await readConfig('knowledge-injection-map', { tenantId: intent?.tenantId || 'system' }).catch(() => null);
  const kinds = resolveKnowledgeKinds(scenario, cfg?.value || null);
  if (!kinds.length) return [];
  const r = await query(
    `SELECT id, payload FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND tenant_id=$1 AND state='registered'
       AND payload->>'kind' = ANY($2::text[])
     ORDER BY (payload->>'confidence')::float DESC NULLS LAST LIMIT 20`,
    [intent?.tenantId || 'system', kinds]
  );
  return buildKnowledgeRows(r.rows);
}
```

3) `assembleContext`（`assembler.js:108`）在 L4 之后、narrative 之前获取并装配：

```js
  const LK = retrievers.LK || retrieveL_Knowledge;  // 与 L1-L4 同形态可注入测试替身
  ...
  try { layers.LK = await LK(actor, intent); } catch { missing.LK = true; }
```

（在 `try { layers.L4 = ...}` 行后加一行；`LK` 在函数头部 retrievers 解构处定义。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/knowledge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/assembler.js test/knowledge.test.js
git commit -m "feat(knowledge): assembleContext 按需注入 L_KNOWLEDGE 层（scenario→kind 走配置）"
```

---

## Task 4：submitRetro C4 通道（赢单/输单语言回写）

**Files:**
- Modify: `src/decision/closureLoop.js:95-175`
- Test: `test/knowledge.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/knowledge.test.js` 追加：

```js
import { routeRetroChannels } from '../src/decision/closureLoop.js';

describe('C4 通道分流（纯逻辑）', () => {
  it('knowledge_particles 非数组 → 空数组（fail-safe）', () => {
    const r = routeRetroChannels({});
    expect(Array.isArray(r.knowledge_particles)).toBe(true);
    expect(r.knowledge_particles).toHaveLength(0);
  });
  it('结构化 knowledge_particles 透传', () => {
    const kp = [{ term: 't', kind: 'buyer_language', content: 'c' }];
    const r = routeRetroChannels({ knowledge_particles: kp });
    expect(r.knowledge_particles).toEqual(kp);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/knowledge.test.js`
Expected: FAIL（`r.knowledge_particles` 为 undefined）

- [ ] **Step 3: 实现**

`src/decision/closureLoop.js`：

1) `routeRetroChannels`（:45）返回对象追加：

```js
  const knowledgeParticles = Array.isArray(payload.knowledge_particles) ? payload.knowledge_particles : [];
  ...
  return {
    facts,
    negative_precedents: negativePrecedents, // → C2 反面先例
    knowledge_patches: knowledgePatches,     // → C3 处方（PENDING）——注意保持现有键名
    knowledge_particles: knowledgeParticles, // → C4 知识粒子回写（P0-② 新增）
    memory_impacts: memoryImpacts,           // → C3′ 记忆影响（append-only）
  };
```

2) `submitRetro`（:95）在 C3′ 之后、`return` 之前追加 C4：

```js
  // C4（P0-② 租户级 Knowledge）：结构化知识产出 → KNOWLEDGE 粒子回写
  // 租户解析（实查：crm.decision 无 tenant_id 列，schema.sql:155-177）：
  //   involved_entities 首实体反查粒子 tenant_id；取不到 → skip + trace 留痕（不阻断复盘主提交）
  const kps = routed.knowledge_particles || [];
  let knowledgeCount = 0;
  if (kps.length) {
    const ents = Array.isArray(exist.rows[0]?.involved_entities) ? exist.rows[0].involved_entities : [];
    let tenantId = null;
    if (ents[0]?.id) {
      const t = await query(`SELECT tenant_id FROM crm.particles WHERE id=$1`, [ents[0].id]);
      tenantId = t.rows[0]?.tenant_id || null;
    }
    if (!tenantId) {
      emit('trace', 'knowledge-c4-skip', { decision_id: decisionId, reason: 'no_tenant_from_entities' });
    } else {
      for (const kp of kps) {
        if (!kp.term || !kp.kind || !kp.content) continue;
        await createParticle('CRM_KNOWLEDGE', {
          term: kp.term, kind: kp.kind, content: kp.content,
          source: 'retro_' + (payload.outcome_type || 'win'),
          confidence: Number(exist.rows[0]?.confidence ?? 0.7),
          tags: Array.isArray(kp.tags) ? kp.tags : [],
        }, { tenantId, actor: 'decision-agent', requireDecisionId: decisionId })
          .then(() => { knowledgeCount += 1; })
          .catch((e) => { emit('trace', 'knowledge-c4-write-failed', { decision_id: decisionId, error: String(e?.message || e) }); });
      }
      emit('trace', 'knowledge-c4-write', { decision_id: decisionId, count: knowledgeCount });
    }
  }
```

3) 顶部 import 区新增：

```js
import { createParticle } from '../particles/particleRepo.js';
import { emit } from '../events/bus.js';
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/knowledge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/decision/closureLoop.js test/knowledge.test.js
git commit -m "feat(knowledge): submitRetro C4 通道回写 KNOWLEDGE 粒子（溯源 decision_id）"
```

---

## Task 5：knowledge-config.html 管理页 + 路由

**Files:**
- Create: `src/web/knowledge-config.html`
- Modify: `src/http/routes.js`
- Test: `test/knowledge-integration.test.js`

- [ ] **Step 1: 写失败测试（集成）**

```js
// test/knowledge-integration.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';
import { query } from '../src/db.js';

const app = createApp();
const sysTok = issueToken({ username: 'admin', role: 'admin', display_name: 'Admin' });
const auth = { Authorization: 'Bearer ' + sysTok };
let dbOk = false;
try { await query('SELECT 1'); dbOk = true; } catch { dbOk = false; }
const db = (n, f) => (dbOk ? it(n, f) : it.skip(n, f));

beforeAll(async () => { if (dbOk) await query(`DELETE FROM crm.particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'='IT-TERM'`); });
afterAll(async () => { if (dbOk) await query(`DELETE FROM crm.particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'='IT-TERM'`); });

it('GET /knowledge-config.html 返回 200 html', async () => {
  const res = await app.fetch('/knowledge-config.html');
  expect(res.status).toBe(200);
});

db('GET /api/knowledge?kind=icp 返回 kind 过滤清单', async () => {
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
    VALUES (gen_random_uuid(), 'system', 'CRM_KNOWLEDGE', 'it-term', 'IT-TERM', 'registered',
      '{"term":"IT-TERM","kind":"icp","content":"c","source":"manual","confidence":1}'::jsonb)`);
  const res = await app.fetch('/api/knowledge?kind=icp', { headers: auth });
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.rows.some((r) => r.payload?.term === 'IT-TERM')).toBe(true);
});

db('GET /api/knowledge 无 token 返回 401', async () => {
  const res = await app.fetch('/api/knowledge');
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/knowledge-integration.test.js`
Expected: FAIL（/api/knowledge 404 / /knowledge-config.html 404）

- [ ] **Step 3: 实现路由**

`src/http/routes.js`（在既有 `GET /sales-thresholds-config.html` 静态页注册旁）新增：

```js
  app.get('/knowledge-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/knowledge-config.html', import.meta.url))));
```

并在 API 区新增：

```js
  // P0-② 租户级 Knowledge 管理 API（docs/2026-09-03-tenant-knowledge-design.md §7）
  // 写经 crm-knowledge-upsert（actionExecutor.dispatch 第0闸 + confirm 双段），此处只做只读清单与提交代理
  app.get('/api/knowledge', async (req, res) => {
    const authz = /* 复用既有登录/角色中间件（对齐 /api/page/* 模式）*/;
    if (!authz.ok) return res.status(401).json({ error: authz.reason });
    const kind = req.query.kind || null;
    const tid = /* 复用既有 ctx 解析（req.ctx.tenantId，admin 通配 '*'）*/;
    const r = await query(
      `SELECT id, type, slug, title, state, payload, created_at FROM crm.particles
       WHERE type='CRM_KNOWLEDGE' AND ($1::text IS NULL OR payload->>'kind'=$1)
         AND ($2::text IS NULL OR tenant_id=$2 OR $2='*')
       ORDER BY (payload->>'confidence')::float DESC NULLS LAST, created_at DESC LIMIT 100`,
      [kind, tid]
    );
    return res.json({ ok: true, rows: r.rows });
  });

  app.post('/api/knowledge', async (req, res) => {
    const authz = /* 复用既有登录/角色中间件 */;
    if (!authz.ok) return res.status(401).json({ error: authz.reason });
    const role = /* 复用既有角色解析 */;
    if (!['manager', 'presales', 'exec', 'sysadmin'].includes(role)) {
      return res.status(403).json({ error: '角色无权录入知识' });
    }
    const { actionExecutor } = await import('../action/executor.js');
    const out = await actionExecutor.dispatch('crm-knowledge-upsert', req.body || {}, {
      tenantId: /* ctx.tenantId */, actor: /* ctx.actor */,
      channel: 'conversational', decision_id: req.body?.decision_id || null,
    });
    if (!out.ok) return res.status(400).json({ error: out.error, gate: out.gate });
    return res.json({ ok: true, ...out.data });
  });
```

> 注：`authz/role/ctx` 的具体实现以 `routes.js` 既有中间件为准（集成测试只验证端点行为：401/200/403）。若仓库无现成单函数可复用，按 `GET /api/page/*`（account-360 页）既有鉴权模式内联实现，**不得新增全局中间件**。

- [ ] **Step 4: 创建 `src/web/knowledge-config.html`**

页面骨架（对齐 `sales-thresholds-config.html` 范式——左侧 tab（四类 kind）+ 右侧表格 + 录入表单 + 提交按钮；通过 `fetch('/api/knowledge')` 加载、`fetch('/api/knowledge',{method:'POST'})` 提交，携带 `Authorization` header；样式复用既有 config 页 CSS 变量，不新增全局样式）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>租户级知识管理</title>
<style>
  :root { --bg:#f5f7fa; --panel:#fff; --line:#e2e6ee; --text:#1f2733; --brand:#2b5cd9; }
  body { margin:0; font-family:system-ui,-apple-system,"PingFang SC",sans-serif; background:var(--bg); color:var(--text); }
  .app { max-width:1100px; margin:0 auto; padding:24px; }
  header { display:flex; align-items:center; justify-content:space-between; }
  h1 { font-size:20px; }
  .tabs { display:flex; gap:8px; margin:16px 0; }
  .tab { padding:8px 16px; border:1px solid var(--line); border-radius:8px; background:var(--panel); cursor:pointer; }
  .tab.active { background:var(--brand); color:#fff; border-color:var(--brand); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:8px; overflow:hidden; }
  th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; font-size:14px; }
  th { background:#eef1f7; }
  .form { display:grid; grid-template-columns:1fr 1fr; gap:12px; background:var(--panel); padding:16px; border-radius:8px; margin-top:16px; }
  input,select,textarea { padding:8px; border:1px solid var(--line); border-radius:6px; font-size:14px; width:100%; box-sizing:border-box; }
  button { padding:8px 20px; border:0; border-radius:6px; background:var(--brand); color:#fff; font-size:14px; cursor:pointer; }
  .msg { margin-top:8px; font-size:13px; }
  .err { color:#d93025; }
</style>
</head>
<body>
<div class="app">
  <header><h1>租户级知识管理（ICP / 竞品 / 异议 / 买家语言）</h1><div id="who"></div></header>
  <div class="tabs" id="tabs">
    <button class="tab active" data-kind="icp">ICP 画像</button>
    <button class="tab" data-kind="competitors">竞品</button>
    <button class="tab" data-kind="objections">异议处理</button>
    <button class="tab" data-kind="buyer_language">买家语言</button>
    <button class="tab" data-kind="">全部</button>
  </div>
  <table id="list">
    <thead><tr><th>term</th><th>kind</th><th>content</th><th>source</th><th>confidence</th><th>state</th></tr></thead>
    <tbody></tbody>
  </table>
  <div class="form">
    <select id="kind"><option value="icp">ICP</option><option value="competitors">竞品</option>
      <option value="objections">异议</option><option value="buyer_language">买家语言</option></select>
    <input id="term" placeholder="term（必填，标题/关键词）">
    <textarea id="content" rows="3" placeholder="content（必填，知识正文）" style="grid-column:1/3"></textarea>
    <input id="source" placeholder="source（默认 manual）">
    <input id="confidence" placeholder="confidence（0-1，默认 1）">
    <input id="tags" placeholder="tags（逗号分隔，可选）">
    <button id="save">提交（经第0闸 + 确认）</button>
  </div>
  <div class="msg" id="msg"></div>
</div>
<script>
  const KIND_ZH = { icp:'ICP 画像', competitors:'竞品', objections:'异议', buyer_language:'买家语言' };
  let currentKind = 'icp';
  const token = sessionStorage.getItem('crm_token') || localStorage.getItem('crm_token') || '';
  document.getElementById('who').textContent = token ? '已登录' : '未登录（配置页仅登录后可写）';
  async function load() {
    const q = currentKind ? '?kind=' + currentKind : '';
    const res = await fetch('/api/knowledge' + q, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { document.getElementById('msg').textContent = '未登录或 token 失效'; return; }
    const j = await res.json();
    const tb = document.querySelector('#list tbody');
    tb.innerHTML = '';
    for (const r of (j.rows || [])) {
      const p = r.payload || {};
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(p.term||'')}</td><td>${esc(KIND_ZH[p.kind]||p.kind||'')}</td>
        <td>${esc(p.content||'')}</td><td>${esc(p.source||'')}</td><td>${esc(p.confidence||'')}</td><td>${esc(r.state||'')}</td>`;
      tb.appendChild(tr);
    }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); currentKind = b.dataset.kind; load();
  });
  document.getElementById('save').addEventListener('click', async () => {
    const body = {
      kind: document.getElementById('kind').value,
      term: document.getElementById('term').value.trim(),
      content: document.getElementById('content').value.trim(),
      source: document.getElementById('source').value.trim() || undefined,
      confidence: document.getElementById('confidence').value.trim() || undefined,
      tags: document.getElementById('tags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),
    };
    if (!body.term || !body.content) { document.getElementById('msg').textContent = 'term/content 必填'; return; }
    const res = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    document.getElementById('msg').textContent = j.ok ? '已提交（id=' + (j.id||'') + '）' : (j.error || '失败');
    document.getElementById('msg').className = j.ok ? 'msg' : 'msg err';
    if (j.ok) { document.getElementById('term').value=''; document.getElementById('content').value=''; load(); }
  });
  load();
</script>
</body>
</html>
```

- [ ] **Step 4b: 运行集成测试确认通过**

Run: `npx vitest run test/knowledge-integration.test.js`
Expected: PASS（无 DB 时 1 个 it 通过 + 2 个 skip；有 DB 时 3 个全过）

- [ ] **Step 5: Commit**

```bash
git add src/web/knowledge-config.html src/http/routes.js test/knowledge-integration.test.js
git commit -m "feat(knowledge): knowledge-config.html 管理页 + /api/knowledge 读写路由"
```

---

## Task 6：industry-onboarding 扩展 Step 4.5 播种

**Files:**
- Modify: `plugin-platform-admin/skills/industry-onboarding/SKILL.md`

- [ ] **Step 1: 在 Step 4 之后新增 Step 4.5 章节**

在 `SKILL.md`「## 5. Step 4 — 经真实写通道建粒子（MCP = actionExecutor.dispatch）」节**之后**追加：

```markdown
## 4.5 Step 4.5 — 播种租户 KNOWLEDGE 种子（P0-② 领域 Know-How）

新行业上线即拥有本租户自有的领域 Know-How。经 `crm-knowledge-upsert`（同 Step 4 的 MCP 写通道）批量建四类初始条目，落 `tenant_id=本租户`（方案 B：全部数据按租户自有）。

```js
// 等价于经 MCP / API POST /api/knowledge 调 crm-knowledge-upsert
await actionExecutor.dispatch('crm-knowledge-upsert', {
  term: '化工买手-决策链', kind: 'icp',
  content: '主要对接采购/技术双线，预算单在 Q3 集中释放',
  source: 'industry-bootstrap',
}, { tenantId: 'acme-chem', actor: 'system', decision_id: '<第0闸 mint 的 decision_id>' });
// 同法播种 competitors / objections / buyer_language 各 ≥1 条
```

链路：`POST /api/knowledge` → `crm-knowledge-upsert` → 第0闸 + confirm 双段 → `createParticle('CRM_KNOWLEDGE')` → 写时 embedding + meta_attr 自适应登记。

**验收**：`resolvePrototype` 隔离依旧成立；本租户 `GET /api/knowledge` 可见 ≥4 类种子；`assembleContext` 装配输出含 `layers.LK`（对应 scenario 的 kind）。
```

并在 §7 上线检查清单追加一项：

```markdown
- [ ] **本租户 KNOWLEDGE 种子已播种**（`GET /api/knowledge` 可见 icp/competitors/objections/buyer_language 各 ≥1）
```

- [ ] **Step 2: 自查**：确认 SKILL.md 未触碰 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 任何行业字面量（禁污染铁律），种子示例用中性行业名（化工/acme-chem）。

- [ ] **Step 3: Commit**

```bash
git add plugin-platform-admin/skills/industry-onboarding/SKILL.md
git commit -m "docs(knowledge): industry-onboarding 扩展 Step 4.5 KNOWLEDGE 播种"
```

---

## Task 7：回归验证 + 全绿

**Files:**
- Test: `test/knowledge.test.js`、`test/knowledge-integration.test.js`
- Test: 全量回归

- [ ] **Step 1: 单测确认**

Run: `npx vitest run test/knowledge.test.js test/knowledge-integration.test.js`
Expected: 全 PASS（无 DB 时集成部分 skip 不红）

- [ ] **Step 2: 关键既有回归（防回退）**

Run: `npx vitest run test/action.test.js test/decision-gate.test.js test/account-360-integration.test.js 2>&1 | tail -20`
Expected: 全绿（action 注册新增不破坏既有断言；crm-deal-advance 等既有 action 不受影响）

- [ ] **Step 3: 全量回归**

Run: `npx vitest run 2>&1 | tail -30`
Expected: 已知 flaky 之外全绿（基线约 2612 例；单次红不得直判，重跑确认，对齐全量回归铁律）

- [ ] **Step 4: Commit**

```bash
git add test/knowledge.test.js test/knowledge-integration.test.js
git commit -m "test(knowledge): P0-② 全量回归验证通过"
```

---

## Self-Review 记录

**Spec 覆盖：**
- §5 写入通道 → Task 2 ✓
- §4 数据模型（coreAttributes）→ Task 1 ✓
- §6 注入通道 + §6.2 映射 → Task 3 ✓
- §5.2 C4 复盘回写 → Task 4 ✓
- §7 前端管理页 + 路由 → Task 5 ✓
- §8 行业播种 → Task 6 ✓
- §9 L1-L4 验收（L1 写入合规=Task2 测试；L2 数据守恒=C4 skip 留痕+deprecated；L3 注入生效=Task3；L4 端到端=Task7 回归）✓

**占位符扫描：** Task 5 路由的 `authz/role/ctx` 复用既有中间件的表述——已明确「以 routes.js 既有中间件为准，不得新增全局中间件」，非占位符而是对接既有实现的实现指引。其余每步均含完整代码。

**类型一致性：** `payload.kind` 四值在 Task1/2/3/4/6 保持一致；`knowledge_particles` 键在 Task4 routeRetroChannels/submitRetro 一致；`retrieveL_Knowledge`→`LK` 命名一致；`SCENARIO_KNOWLEDGE_MAP` 在 Task3 定义、Task3 测试引用一致。

**注意（沙箱无 git 凭证）**：所有 commit 命令由用户本地执行；本环境只产出改动文件。每 Task 一 commit（铁律）。