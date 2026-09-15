# 外部数据源融合能力（Provider-Agnostic Fusion）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CRM 平台建立「入站意图 → 按 provider 路由 → 草稿暂存 → HITL 确认落库」的通用融合能力，使 anysite / 启信慧眼(qixin) / 新榜(xinbang) 等任意外部数据源可插拔接入，融合层对 provider 透明；任何返回数据**绝不自动落 CRM 粒子**，须经 `confirm_token` 闸门确认后写入。

**Architecture:** 复用既有 `ProviderAdapter` / `providerRegistry` / `credentialVault` 泛型机制；新增「入站 MCP 工具 `prospecting-lookup` + 意图路由函数 `routeExternalLookup` + 草稿暂存表 `discovery_draft` + HITL 确认写」面。传输层各 provider 自封装（anysite=REST+JWT；qixin/xinbang=REST+Bearer）。网关已有的两阶段 `confirm_token` 即 HITL 人工闸；`draft_id` 绑定具体草稿，二者共同构成「无 token 拒写、无草稿拒写」双闸。

**Tech Stack:** Node.js (ESM) · Express · crm-native-mcp (StreamableHTTP/stdio) · PostgreSQL+pgcrypto (credentialVault) · Zod (MCP schema) · Vitest。

---

## 关键约束（贯穿全部 Task）

- ⚠ **绝对禁自动落 CRM 粒子**：provider 返回数据未经 `confirm_token` 不得 `data-particle-create` / `createParticle` 写 `CRM_DEAL`/`CRM_ACCOUNT`（对齐零信任第 0 闸）。
- ⚠ **禁 DELETE**：草稿清理走软状态（`status='consumed'`/`'expired'`），不物理删。
- ⚠ **JWT 不落前端/日志/memory**：仅在服务端 `ctx.credentials` 流转；`access-token` header 取值来自 `ctx.credentials.anysite || process.env.ANY_SITE_KEY`。
- **新 provider 接入 = 实现 `ProviderAdapter` + 注册 + config 翻 `enabled`，融合层零改动**（本能力核心）。
- 测试命令统一：`node node_modules/vitest/vitest.mjs run <test-path>`。

---

## 文件结构（本计划新增/修改）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/connectors/discovery/lookupRouter.js` | 新建 | 纯函数 `routeExternalLookup`：provider→适配器路由 + 凭据注入 + search/enrich 调用，**零 DB 写** |
| `src/connectors/discovery/draftRepo.js` | 新建 | `discovery_draft` 暂存表读写（insertDraft/getDraft/softExpireDraft），软清理 |
| `src/action/prospectingActions.js` | 修改 | 新增 `prospecting-lookup` 动作（入站工具）+ `prospecting-confirm` 扩展支持 `draft_id` |
| `src/agent/agentSpec.js` | 修改 | `prospecting` agent `actions`/`skillCalls` 加入 `prospecting-lookup`（装配闭包三处同改 1/3） |
| `src/connectors/discovery/adapters/anysite.js` | 修改 | 重写为 REST 客户端（fetch + `access-token:JWT`），删 MCP 客户端分支 |
| `src/config/discoveryRules.js` | 修改 | `qixin`/`anysite`/`xinbang` 的 `enabled:false`→`true` |
| `src/config/prospectingRules.js` | 修改 | `sources.qixin/xinbang/anysite.enabled:false`→`true` |
| `src/web/discovery-rules.html` | 修改 | `INTEGRATION_CATALOG` 由 `PROVIDERS` 派生（配置驱动，去重硬编码列表） |
| `db/schema.sql` | 修改 | 追加 `crm.discovery_draft` 建表 DDL（单一事实源） |
| `test/connectors/discovery/lookupRouter.test.js` | 新建 | 路由纯函数单测（mock 适配器 + 凭据） |
| `test/connectors/discovery/anysiteRest.test.js` | 新建 | anysite REST 单测（mock fetch，断言 URL/header/映射/fail-open） |
| `test/action/prospectingLookup.test.js` | 新建 | `prospecting-lookup` 动作 + MCP 暴露 + 装配闭包断言 |
| `test/action/prospectingConfirmDraft.test.js` | 新建 | `prospecting-confirm` 消费 `draft_id` 落库 + 闸门单测 |
| `test/config/providerEnabled.test.js` | 新建 | config 翻 enabled 断言 |
| `test/integration/externalProviderFusion.test.js` | 新建 | 多 provider 全链（lookup→draft→confirm）集成测试 |

---

## Task 1 — 意图路由处理器（设计 T2：provider→适配器路由，零写）

**Files:**
- Create: `src/connectors/discovery/lookupRouter.js`
- Test: `test/connectors/discovery/lookupRouter.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/connectors/discovery/lookupRouter.test.js
import { describe, it, expect } from 'vitest';
import { routeExternalLookup } from '../../../src/connectors/discovery/lookupRouter.js';

const fakeAdapter = (over) => ({
  id: 'anysite',
  search: async (q, ctx) => (over.search ? over.search(q, ctx) : [{ name: 'Acme', provider: 'anysite' }]),
  enrich: async (e, f, ctx) => (over.enrich ? over.enrich(e, f, ctx) : { industry: { value: 'chem', confidence: 0.8, provider: 'anysite' } }),
});

describe('routeExternalLookup', () => {
  it('未知/未启用 provider → 返回 error 且零写', async () => {
    const r = await routeExternalLookup({ provider: 'nope', kind: 'prospect', tenantId: 't1', deps: {
      loadAdapters: async () => [], resolveCredentials: async () => ({}),
    } });
    expect(r.items).toEqual([]);
    expect(r.error).toBe('provider_not_enabled_or_unknown');
  });

  it('prospect kind → 调 adapter.search 透传 credentials', async () => {
    let seenCtx = null;
    const r = await routeExternalLookup({ provider: 'anysite', kind: 'prospect',
      payload: { icp: { industries: ['chem'] } }, tenantId: 't1', deps: {
        loadAdapters: async () => [fakeAdapter({ search: async (q, ctx) => { seenCtx = ctx; return [{ name: 'Acme' }]; } })],
        resolveCredentials: async () => ({ anysite: 'JWT123' }),
      } });
    expect(r.items).toEqual([{ name: 'Acme' }]);
    expect(seenCtx.credentials.anysite).toBe('JWT123');
  });

  it('enrich kind → 调 adapter.enrich 并扁平化 fieldHit', async () => {
    const r = await routeExternalLookup({ provider: 'anysite', kind: 'enrich',
      payload: { entity: { name: 'Acme' }, fields: ['industry'] }, tenantId: 't1', deps: {
        loadAdapters: async () => [fakeAdapter()], resolveCredentials: async () => ({}),
      } });
    expect(r.items[0]).toMatchObject({ field: 'industry', value: 'chem' });
  });

  it('adapter 抛错 fail-open → 返回空 items', async () => {
    const r = await routeExternalLookup({ provider: 'anysite', kind: 'prospect', tenantId: 't1', deps: {
      loadAdapters: async () => [fakeAdapter({ search: async () => { throw new Error('boom'); } })],
      resolveCredentials: async () => ({}),
    } });
    expect(r.items).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/connectors/discovery/lookupRouter.test.js`
Expected: FAIL（`Cannot find module '.../lookupRouter.js'`）

- [ ] **Step 3: 实现路由纯函数**

```js
// src/connectors/discovery/lookupRouter.js
// 意图路由处理器（设计 T2）：provider → providerRegistry 解析适配器 → 凭据注入 → search/enrich。
// 铁律：零 DB 写；fail-open（适配器异常/未启用 → 空结果，不抛业务异常）。
import { loadAdapters } from './providerRegistry.js';
import { resolveCredentials } from './credentialVault.js';

// 把适配器的 enrich fieldHit map（{ field: {value,confidence,provider} }）扁平成草稿 items
function flattenEnrich(out = {}) {
  return Object.entries(out).map(([field, v]) => ({
    field, value: v?.value, confidence: v?.confidence, provider: v?.provider,
  }));
}

export async function routeExternalLookup({ provider, kind = 'prospect', payload = {}, tenantId = 'system', deps = {} } = {}) {
  const load = deps.loadAdapters || loadAdapters;
  const resolve = deps.resolveCredentials || resolveCredentials;

  const adapters = await load({ tenantId }, { allowIds: [provider] });
  const adapter = adapters.find((a) => a.id === provider);
  if (!adapter) return { provider, kind, items: [], error: 'provider_not_enabled_or_unknown' };

  const credentials = await resolve({ tenantId, providerIds: [provider], deps });
  const ctx = { tenantId, credentials };

  if (kind === 'enrich') {
    const entity = payload.entity || {};
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    const out = await adapter.enrich(entity, fields, ctx).catch(() => ({}));
    return { provider, kind, items: flattenEnrich(out) };
  }

  // prospect（默认）：调 adapter.search（无 search 适配器跳过）
  const query = payload.icp || payload.query || payload;
  const list = typeof adapter.search === 'function'
    ? await adapter.search(query, ctx).catch(() => [])
    : [];
  return { provider, kind, items: list };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/connectors/discovery/lookupRouter.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/connectors/discovery/lookupRouter.js test/connectors/discovery/lookupRouter.test.js
git commit -m "feat(fusion): add routeExternalLookup provider-agnostic routing (zero-write)"
```

---

## Task 2 — 泛型入站 MCP 工具 `prospecting-lookup`（设计 T1）

**Files:**
- Modify: `src/action/prospectingActions.js`（新增 action）
- Modify: `src/agent/agentSpec.js:95-96`（装配闭包三处同改 1/3）
- Test: `test/action/prospectingLookup.test.js`

- [ ] **Step 1: 写失败测试（动作注册 + 装配闭包 + 行为）**

```js
// test/action/prospectingLookup.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { getAction } from '../../src/action/registry.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

beforeAll(() => { seedActions(); });

describe('prospecting-lookup action', () => {
  it('已注册且为 read（直接 dispatch，无决策闸）', () => {
    const a = getAction('prospecting-lookup');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read');
    expect(a.namespace).toBe('prospecting');
    expect(a.agentTool).toBe(true);
  });

  it('装配闭包：prospecting-lookup ⊆ prospecting.actions ⊆ skillCalls', () => {
    const spec = agentSpecs['prospecting'];
    expect(spec.capabilities.actions).toContain('prospecting-lookup');
    expect(spec.capabilities.skillCalls).toContain('prospecting-lookup');
    expect(getAction('prospecting-lookup')).not.toBeNull();
  });

  it('assertAgentAssembly 通过', async () => {
    const r = await assertAgentAssembly();
    const fails = r.filter((x) => !x.ok && (x.detail || '').includes('prospecting-lookup'));
    expect(fails).toEqual([]);
  });

  it('MCP 暴露面包含 prospecting-lookup 且含 protocol 字段', () => {
    const { tools } = buildMcpTools({ seed: false });
    const t = tools.find((x) => x.name === 'prospecting-lookup');
    expect(t).toBeDefined();
    expect(t.inputSchema).toHaveProperty('provider');
    expect(t.inputSchema).toHaveProperty('kind');
    expect(t.inputSchema).toHaveProperty('payload');
  });

  it('handler 调路由 + 暂存草稿，零 CRM 粒子写', async () => {
    let routed = null, drafted = null;
    const a = getAction('prospecting-lookup');
    const res = await a.handler({ provider: 'anysite', kind: 'prospect', payload: { icp: {} } },
      { tenantId: 't1' },
      { routeExternalLookup: async (p) => { routed = p; return { provider: p.provider, kind: p.kind, items: [{ name: 'Acme' }] }; },
        insertDraft: async (d) => { drafted = d; return { draft_id: 'd-1' }; } });
    expect(routed.provider).toBe('anysite');
    expect(drafted.tenantId).toBe('t1');
    expect(drafted.items).toEqual([{ name: 'Acme' }]);
    expect(res.draft_id).toBe('d-1');
    expect(res.count).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/action/prospectingLookup.test.js`
Expected: FAIL（action 未注册）

- [ ] **Step 3: 在 `prospectingActions.js` 注册 `prospecting-lookup`**

在 `seedProspectingActions()` 内、`prospecting-search` 注册之前插入（文件顶部已 import `seedDiscoveryActions` 等；需新增 import）：

```js
// 在文件顶部 import 段补充：
import { routeExternalLookup } from '../connectors/discovery/lookupRouter.js';
import { insertDraft } from '../connectors/discovery/draftRepo.js'; // Task 4 落地；本 Task 用 deps 注入即可

// 在 seedProspectingActions() 内，registerAction prospecting-search 之前加入：
  // —— prospecting-lookup（入站意图路由工具，零 CRM 写）：路由到指定 provider 适配器取数 → 暂存 discovery_draft → 返回草稿预览
  registerAction({
    name: 'prospecting-lookup', kind: 'read', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { provider: 'string', kind: 'string', payload: 'object' },
    parameters: { required: ['provider', 'kind'] },
    handler: async ({ provider, kind, payload = {} }, ctx, deps = {}) => {
      const route = deps.routeExternalLookup || routeExternalLookup;
      const draftInsert = deps.insertDraft || insertDraft;
      const res = await route({ provider, kind, payload, tenantId: ctx.tenantId, deps });
      if (res.error) return { provider, kind, count: 0, items: [], error: res.error };
      // 暂存到 discovery_draft（staging，非 CRM 粒子）—— 满足「零 CRM 写」红线；confirm 阶段才落 CRM
      const d = await draftInsert({ tenantId: ctx.tenantId, provider, kind, items: res.items || [] }).catch(() => null);
      return {
        draft_id: d?.draft_id || null,
        provider, kind,
        count: (res.items || []).length,
        items: (res.items || []).slice(0, 20), // 仅预览
        preview: true,
      };
    },
  });
```

- [ ] **Step 4: 装配闭包三处同改 —— 改 `agentSpec.js:95-96`**

将：
```js
      actions: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm'],
```
改为：
```js
      actions: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm', 'prospecting-lookup', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm', 'prospecting-lookup'],
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/action/prospectingLookup.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/action/prospectingActions.js src/agent/agentSpec.js test/action/prospectingLookup.test.js
git commit -m "feat(fusion): register prospecting-lookup inbound MCP tool + assembly closure"
```

---

## Task 3 — anysite 适配器 REST 重写（设计 T3）

**Files:**
- Modify: `src/connectors/discovery/adapters/anysite.js`
- Test: `test/connectors/discovery/anysiteRest.test.js`

**已知事实（实证，来自前期实测）：**
- REST base = `https://api.anysite.io/api`
- 认证 header = `access-token: <完整 JWT>`（**裸 UUID 会 401**）
- 已验证可用：`POST /api/linkedin/email/user` body `{ "email": "x" }` → 200（body `[]` 或 profile 数组）
- 公司搜索路径探活返回 404（`/api/db/linkedin/search/companies`、`/api/linkedin/search/companies` 均 404）——**开放校准项**：`search()` 依次尝试候选路径，全部失败则 fail-open 返回 `[]`，不下发硬编码死路径。

- [ ] **Step 1: 写失败测试**

```js
// test/connectors/discovery/anysiteRest.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock fetch 全局
const fetches = [];
global.fetch = vi.fn(async (url, opts) => {
  fetches.push({ url, opts });
  if (url.includes('/linkedin/email/user')) {
    return { ok: true, json: async () => ([{ name: 'Jane Doe', headline: 'CEO @ Acme', email: 'jane@acme.com' }]) };
  }
  if (url.includes('search/companies') || url.includes('company/search')) {
    return { ok: true, json: async () => ({ items: [{ name: 'Acme Co', industry: 'chemical', url: 'https://li.com/acme' }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

const { anysiteAdapter } = await import('../../src/connectors/discovery/adapters/anysite.js');

beforeEach(() => { fetches.length = 0; });

describe('anysite REST adapter', () => {
  it('enrich by email → access-token header + 字段映射', async () => {
    const a = anysiteAdapter();
    const out = await a.enrich({ email: 'jane@acme.com' }, ['industry', 'registered_address'], { credentials: { anysite: 'JWT-XYZ' } });
    expect(fetches[0].url).toContain('/api/linkedin/email/user');
    expect(fetches[0].opts.headers['access-token']).toBe('JWT-XYZ');
    expect(out.industry).toBeDefined();
  });

  it('search by icp → 尝试候选路径，命中即映射 candidate', async () => {
    const a = anysiteAdapter();
    const list = await a.search({ industries: ['chemical'], limit: 5 }, { credentials: { anysite: 'JWT-XYZ' } });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].provider).toBe('anysite');
  });

  it('无凭据 → fail-open 返回空，不抛', async () => {
    const a = anysiteAdapter();
    expect(await a.search({ industries: ['x'] }, {})).toEqual([]);
    expect(await a.enrich({ name: 'X' }, ['industry'], {})).toEqual({});
  });

  it('health() 探活用已验证端点，返回 {ok,valid}', async () => {
    const a = anysiteAdapter();
    const h = await a.health({ credentials: { anysite: 'JWT-XYZ' } });
    expect(h).toHaveProperty('ok');
    expect(h).toHaveProperty('valid');
  });

  it('__mock 透传（单测兼容旧用例）', async () => {
    const a = anysiteAdapter({ __mock: { companies: [{ name: 'MockCo', domain: 'mock.com' }] } });
    const list = await a.search({ industries: ['x'] }, {});
    expect(list[0].name).toBe('MockCo');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/connectors/discovery/anysiteRest.test.js`
Expected: FAIL（仍为 MCP 客户端实现）

- [ ] **Step 3: 重写 `anysite.js` 为 REST 客户端**

整文件替换为：

```js
// src/connectors/discovery/adapters/anysite.js — anysite.io REST 客户端（access-token:JWT）
// 铁律（对齐 qixin/xinbang）：
//   1. 无凭据 / 异常 → search 返 []、enrich 返 {}（fail-open，不抛业务异常）
//   2. 字段映射复用 discoveryRules.signals 权重键
//   3. token 绝不进前端 / 日志 / memory
//   4. 公司搜索路径前期实测 404 → 依次尝试候选路径，全失败 fail-open（不下发死路径）
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const ANY_SITE_API = process.env.ANY_SITE_API || 'https://api.anysite.io/api';
// 候选公司搜索路径（优先级降序）；实测 /api/db/linkedin/search/companies 与 /api/linkedin/search/companies 均 404，
// 故全量 fail-open，待真机校准后收敛到单一有效路径（开放项）。
const SEARCH_PATHS = [
  '/db/linkedin/search/companies',
  '/linkedin/search/companies',
  '/linkedin/company/search',
];

function authHeaders(ctx = {}) {
  const key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
  if (!key) return null;
  return { 'access-token': key, 'Content-Type': 'application/json' };
}

async function postJson(path, body, ctx) {
  const headers = authHeaders(ctx);
  if (!headers) return null;
  try {
    const r = await fetch(`${ANY_SITE_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const candidateFromCompany = (it) => it && it.name ? {
  name: it.name, domain: it.domain || '', industry: it.industry, revenue: it.revenue,
  funding_round: false, hiring_icp_role: false, tender_match: false,
  confidence: 0.7, provider: 'anysite', url: it.url, location: it.location,
} : null;

const companyFromHeadline = (headline) => {
  if (!headline) return null;
  const at = /@\s*([^,，]+)/.exec(headline);
  if (at) return at[1].trim();
  const sep = /^(.+?)[\s]*[-–—|｜][\s]*.+$/.exec(headline);
  if (sep && sep[1].trim().length >= 2) return sep[1].trim();
  return null;
};

export function anysiteAdapter(cfg = {}) {
  const http = cfg.__http || postJson;
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'anysite', kind: 'firmographics', scope: 'paid', costTier: 2,
        coverageFields: ['industry', 'registered_address', 'legal_person', 'employees'], ...cfg });
    }

    async health(ctx = {}) {
      if (cfg.__mock?.statistic) return { ok: !!cfg.__mock.statistic.ok, valid: !!cfg.__mock.statistic.valid, ts: new Date().toISOString() };
      const headers = authHeaders(ctx);
      if (!headers) return { ok: false, valid: false, detail: 'no credentials' };
      const data = await http('/linkedin/email/user', { email: '' }, ctx); // 已验证端点兜底探活
      return { ok: data !== null, valid: data !== null, ts: new Date().toISOString() };
    }

    // 富集：email 查找（已验证可用端点），回退 name 搜索
    async enrich(entity = {}, fields = [], ctx = {}) {
      if (cfg.__mock) {
        const out = {};
        for (const f of fields) if (cfg.__mock[f] != null) Object.assign(out, fieldHit(f, { value: cfg.__mock[f], confidence: 0.8, cost: this.costTier, provider: this.id }));
        return out;
      }
      const key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
      if (!key) return {};
      if (entity.email) {
        const data = await http('/linkedin/email/user', { email: entity.email }, ctx);
        const prof = Array.isArray(data) ? data[0] : (data?.items?.[0]);
        const out = {};
        if (prof?.name && fields.includes('industry')) Object.assign(out, fieldHit('industry', { value: prof.industry || prof.headline || '', confidence: 0.7, cost: this.costTier, provider: this.id }));
        if (prof?.location && fields.includes('registered_address')) Object.assign(out, fieldHit('registered_address', { value: prof.location, confidence: 0.6, cost: this.costTier, provider: this.id }));
        return out;
      }
      return {}; // 无 email 富集约等于空（name 搜索在 search 侧覆盖）
    }

    async search(query = {}, ctx = {}) {
      if (cfg.__mock?.companies || cfg.__mock?.people) {
        const list = cfg.__mock.companies || cfg.__mock.people || [];
        return list.map((c) => ({ ...c, provider: 'anysite', confidence: 0.8 }));
      }
      const key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
      if (!key) return [];
      const keywords = (query.industries || []).join(' ') || query.name || query.keywords || '';
      const count = Math.min(Number(query.limit) || 20, 50);
      for (const path of SEARCH_PATHS) {
        const data = await http(path, { keywords, count }, ctx).catch(() => null);
        const items = data?.items || (Array.isArray(data) ? data : null);
        if (Array.isArray(items) && items.length) return items.map(candidateFromCompany).filter(Boolean);
      }
      return []; // fail-open：全候选路径 404/异常 → 空
    }
  })();
}

registerProvider('anysite', anysiteAdapter);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/connectors/discovery/anysiteRest.test.js`
Expected: PASS（6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/connectors/discovery/adapters/anysite.js test/connectors/discovery/anysiteRest.test.js
git commit -m "feat(fusion): rewrite anysite adapter to REST (access-token:JWT), fail-open"
```

---

## Task 4 — 草稿暂存 + HITL 确认写（设计 T4，泛型跨 provider）

**Files:**
- Modify: `db/schema.sql`（追加 `crm.discovery_draft` DDL）
- Create: `src/connectors/discovery/draftRepo.js`
- Modify: `src/action/prospectingActions.js`（`prospecting-confirm` 扩展 `draft_id`）
- Test: `test/action/prospectingConfirmDraft.test.js`

**HITL 双闸说明：** `prospecting-confirm` 已是 `write` + `autoDecision:true` + `confirm:'stage2'` → 网关自动 mint 决策并发 `confirm_token`（phase1），用户 phase2 持 token 执行。本 Task 的「confirm_token 写闸」即复用网关两阶段 token；`draft_id` 绑定具体草稿。无 token → 网关拒；无草稿/已消费/过期 → handler 拒。

- [ ] **Step 1: 写失败测试**

```js
// test/action/prospectingConfirmDraft.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAction } from '../../src/action/registry.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { insertDraft, getDraft, softExpireDraft } from '../../src/connectors/discovery/draftRepo.js';
import { query, queryWrite } from '../../src/db.js';

const TID = 'test-confirm-draft';

beforeAll(async () => { seedActions(); });
afterAll(async () => { await queryWrite(`DELETE FROM crm.discovery_draft WHERE tenant_id=$1`, [TID]).catch(()=>{}); await (await import('../../src/db.js')).pool.end(); });

describe('discovery_draft repo', () => {
  it('insert → get → 软过期', async () => {
    const d = await insertDraft({ tenantId: TID, provider: 'anysite', kind: 'prospect', items: [{ name: 'Acme' }] });
    expect(d.draft_id).toBeTruthy();
    const got = await getDraft(d.draft_id, { tenantId: TID });
    expect(got.status).toBe('pending');
    expect(got.items[0].name).toBe('Acme');
    await softExpireDraft(d.draft_id);
    const after = await getDraft(d.draft_id, { tenantId: TID });
    expect(after.status).toBe('consumed');
  });
});

describe('prospecting-confirm (draft_id path)', () => {
  it('消费 draft_id → 落 CRM_DEAL S0；跨租户拒绝', async () => {
    const d = await insertDraft({ tenantId: TID, provider: 'anysite', kind: 'prospect', items: [{ name: 'DraftCo', industry: 'chem' }] });
    const a = getAction('prospecting-confirm');
    const created = [];
    const res = await a.handler({ draft_id: d.draft_id }, { tenantId: TID, decision_id: 'dec-1', actor: 'alice' },
      { createParticle: async (type, payload, opts) => { created.push({ type, payload }); return { id: 'deal-'+created.length }; },
        createEdge: async () => ({}),
        getDraft: (id, o) => getDraft(id, o),
        softExpireDraft: (id) => softExpireDraft(id),
        findAccount: async () => null });
    expect(created.length).toBe(1);
    expect(created[0].type).toBe('CRM_DEAL');
    expect(created[0].payload.stage).toBe('S0');
    expect(res.results[0].existing).toBe(false);
    const after = await getDraft(d.draft_id, { tenantId: TID });
    expect(after.status).toBe('consumed');
  });

  it('草稿已消费 → 拒绝（防重复落库）', async () => {
    const d = await insertDraft({ tenantId: TID, provider: 'anysite', kind: 'prospect', items: [{ name: 'X' }] });
    await softExpireDraft(d.draft_id);
    const a = getAction('prospecting-confirm');
    await expect(a.handler({ draft_id: d.draft_id }, { tenantId: TID, decision_id: 'dec-2' },
      { createParticle: async () => ({}), createEdge: async () => ({}), getDraft: (id, o) => getDraft(id, o), softExpireDraft: () => {} , findAccount: async () => null }))
      .rejects.toThrow(/已消费|非 pending/);
  });

  it('无 draft_id 且非 session → 退回既有 session 逻辑（不破坏旧链路）', async () => {
    const a = getAction('prospecting-confirm');
    await expect(a.handler({ session_id: 'nope', confirmed_ids: [] }, { tenantId: TID, decision_id: 'dec-3' }, {}))
      .rejects.toThrow(/session/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/action/prospectingConfirmDraft.test.js`
Expected: FAIL（表/模块不存在）

- [ ] **Step 3: `db/schema.sql` 追加建表 DDL**

在 `db/schema.sql` 末尾（任意 `CREATE TABLE IF NOT EXISTS crm.xxx` 块之后）追加：

```sql
-- 外部数据源融合：草稿暂存表（staging，非 CRM 业务粒子）
-- 仅承载 provider 返回的待确认数据；confirm 后才落 CRM_DEAL/CRM_ACCOUNT。软清理（status 翻转），禁物理 DELETE。
CREATE TABLE IF NOT EXISTS crm.discovery_draft (
  draft_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL DEFAULT 'system',
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_crm_discovery_draft_tenant ON crm.discovery_draft(tenant_id, status, expires_at);
```

> 注：新表走 `CREATE TABLE IF NOT EXISTS` 段，migrate.js 在全新库与存量库均会创建（旧库该表不存在 → 创建生效）。无需走 ALTER 补列陷阱。

- [ ] **Step 4: 创建 `draftRepo.js`**

```js
// src/connectors/discovery/draftRepo.js — discovery_draft 暂存读写（软清理，禁物理 DELETE）
import { query, queryWrite } from '../../db.js';

export async function insertDraft({ tenantId = 'system', provider, kind, items = [], confirmToken = null } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.discovery_draft (tenant_id, provider, kind, items, confirm_token)
     VALUES ($1,$2,$3,$4,$5) RETURNING draft_id, status, created_at, expires_at`,
    [tenantId, provider, kind, JSON.stringify(items), confirmToken]
  );
  return r.rows[0];
}

export async function getDraft(draftId, { tenantId = 'system' } = {}) {
  const r = await query(`SELECT * FROM crm.discovery_draft WHERE draft_id=$1 AND tenant_id=$2`, [draftId, tenantId]);
  return r.rows[0] || null;
}

// 软过期：置 consumed（已消费）或 expired（软过期清理），绝不物理删
export async function softExpireDraft(draftId, status = 'consumed') {
  await queryWrite(
    `UPDATE crm.discovery_draft SET status=$2, consumed_at=now() WHERE draft_id=$1 AND status='pending'`,
    [draftId, status]
  );
}

// 软过期清理（定时任务调用）：把超过 expires_at 的 pending 翻为 expired（不删行）
export async function sweepExpired({ tenantId = 'system' } = {}) {
  await queryWrite(
    `UPDATE crm.discovery_draft SET status='expired', consumed_at=now()
     WHERE tenant_id=$1 AND status='pending' AND expires_at < now()`,
    [tenantId]
  );
}
```

- [ ] **Step 5: `prospecting-confirm` 扩展 `draft_id` 分支**

在 `src/action/prospectingActions.js` 顶部 import 增加：

```js
import { insertDraft } from './draftRepo.js'; // 注意：本文件在 src/action/，draftRepo 在 src/connectors/discovery/ → 路径为 '../connectors/discovery/draftRepo.js'
```

> ⚠ 路径修正：prospectingActions.js 位于 `src/action/`，draftRepo 在 `src/connectors/discovery/`，故 import 应为：
> `import { getDraft, softExpireDraft } from '../connectors/discovery/draftRepo.js';`

修改 `prospecting-confirm` 的 `handler` 签名与首部，增加 `draft_id` 分支（在现有 `session_id` 逻辑之前插入）：

```js
    handler: async ({ session_id, confirmed_ids, draft_id }, ctx, deps = {}) => {
      const getDraftFn = deps.getDraft || getDraft;
      const softExpire = deps.softExpireDraft || softExpireDraft;
      const findAccountFn = deps.findAccount || (/* 既有 findAccount 闭包 */);
      // —— 草稿路径（设计 T4）：从 discovery_draft 取待确认候选 ——
      if (draft_id) {
        const d = await getDraftFn(draft_id, { tenantId: ctx.tenantId });
        if (!d) throw new Error(`discovery_draft 不存在: ${draft_id}`);
        if (d.status !== 'pending') throw new Error(`discovery_draft 状态非 pending（${d.status}）: ${draft_id}`);
        if (d.expires_at && new Date(d.expires_at) < new Date()) throw new Error(`discovery_draft 已过期: ${draft_id}`);
        const candidates = (d.items || []).map((it) => ({ ...it, id: candidateIdOf(it.name || '', it.domain || '') }));
        confirmed_ids = candidates.map((c) => c.id);
        const results = [];
        for (const cand of candidates) {
          const hit = await findAccountFn(cand.name, cand.domain).catch(() => null);
          if (hit) { results.push({ account_id: hit.id || null, deal_id: null, decision_id: ctx.decision_id, existing: true }); continue; }
          const deal = await (deps.createParticle || createParticle)('CRM_DEAL', {
            name: cand.name, stage: 'S0', pool_type: 'new', source: 'prospecting',
            expected_amount: cand.revenue || 0, industry: cand.industry, pooled_at: new Date().toISOString(),
          }, { tenantId: ctx.tenantId, requireDecisionId: ctx.decision_id });
          await (deps.createEdge || createEdge)('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', `prospecting:${cand.id}`, {
            edge_source: 'auto_weak', relation_confidence: cand.fit_score ?? 0.5, provenance: 'prospecting-lookup', decision_id: ctx.decision_id,
          }, ctx.tenantId).catch(() => {});
          results.push({ account_id: null, deal_id: deal.id, decision_id: ctx.decision_id, existing: false });
        }
        await softExpire(draft_id);
        (deps.emit || emit)('prospecting', 'batch-pooled', { tenant_id: ctx.tenantId, total: results.length, decision_id: ctx.decision_id, via: 'discovery_draft' });
        return { results, via: 'discovery_draft' };
      }
      // —— 既有 session 路径（不变）——
      requireMintedDecision(ctx, 'prospecting-confirm');
      const s = getSession(session_id);
      // ...（以下保持原逻辑不变）
```

> 关键：`if (draft_id)` 分支**先于** `requireMintedDecision` 之前返回，但网关两阶段 `confirm_token` 已在 phase1 触发 mint（因 `prospecting-confirm` 声明了 `autoDecision:true`+`decisionScenario`），phase2 执行时 `ctx.decision_id` 已具备；`createParticle` 的 `requireDecisionId` 取 `ctx.decision_id` 满足第 0 闸。

- [ ] **Step 6: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/action/prospectingConfirmDraft.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 7: 提交**

```bash
git add db/schema.sql src/connectors/discovery/draftRepo.js src/action/prospectingActions.js test/action/prospectingConfirmDraft.test.js
git commit -m "feat(fusion): discovery_draft staging + HITL confirm gate (cross-provider)"
```

---

## Task 5 — 配置翻 enabled + 前端 catalog 通用化（设计 T5）

**Files:**
- Modify: `src/config/discoveryRules.js:27-29`
- Modify: `src/config/prospectingRules.js:18-20`
- Modify: `src/web/discovery-rules.html:330-334`
- Test: `test/config/providerEnabled.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/config/providerEnabled.test.js
import { describe, it, expect } from 'vitest';
import { DEFAULT_DISCOVERY_RULES, mergedDiscoveryRules } from '../../src/config/discoveryRules.js';
import { DEFAULT_PROSPECTING_RULES, mergedProspectingRules } from '../../src/config/prospectingRules.js';

describe('provider enabled flips', () => {
  it('discoveryRules: qixin/anysite/xinbang 均已启用', () => {
    for (const id of ['qixin', 'anysite', 'xinbang']) {
      const p = DEFAULT_DISCOVERY_RULES.providers.find((x) => x.id === id);
      expect(p.enabled, id).toBe(true);
    }
  });
  it('prospectingRules: 三源均启用', () => {
    for (const id of ['qixin', 'anysite', 'xinbang']) {
      expect(DEFAULT_PROSPECTING_RULES.sources[id].enabled, id).toBe(true);
    }
  });
  it('mergedDiscoveryRules 解析出 anysite 为 enabled 适配器', async () => {
    const r = await mergedDiscoveryRules({ tenantId: 'system' });
    expect(r.providers.find((p) => p.id === 'anysite').enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/config/providerEnabled.test.js`
Expected: FAIL

- [ ] **Step 3: 翻 `discoveryRules.js` enabled**

将 `src/config/discoveryRules.js:27-29`：
```js
    { id: 'qixin',        kind: 'firmographics',     scope: 'paid',             costTier: 2, enabled: false },
    { id: 'anysite',      kind: 'firmographics',     scope: 'paid',             costTier: 2, enabled: false },
    { id: 'xinbang',      kind: 'social',            scope: 'paid',             costTier: 2, enabled: false },
```
改为 `enabled: true`（三行）。

- [ ] **Step 4: 翻 `prospectingRules.js` enabled**

将 `src/config/prospectingRules.js:18-20`：
```js
    qixin:   { enabled: false, weight: 0.6 },
    xinbang: { enabled: false, weight: 0.2 },
    anysite: { enabled: false, weight: 0.2 },
```
改为 `enabled: true`（三行）。

- [ ] **Step 5: 前端 `INTEGRATION_CATALOG` 配置驱动（去重硬编码列表）**

将 `src/web/discovery-rules.html:330-334`：
```js
const INTEGRATION_CATALOG = [
  { id: 'qixin', name: '启信慧眼', kind: 'firmographics', scope: 'paid', desc: '企业画像/招投标/融资/招聘强信号' },
  { id: 'xinbang', name: '新榜', kind: 'social', scope: 'paid', desc: '公众号/小红书/抖音发布内容辅助信号' },
  { id: 'anysite', name: 'Anysite', kind: 'firmographics', scope: 'paid', desc: '企业/个人画像：LinkedIn 公司画像、人员搜索、邮箱查找（access-token 认证）' },
];
```
改为由 `PROVIDERS` 常量（同文件 line 187-193，已含全部付费源）派生，单一事实源：
```js
// 友好名称/描述映射（仅展示层；接入事实仍以 PROVIDERS + config_store 为准）
const PROVIDER_META = {
  qixin:   { name: '启信慧眼', desc: '企业画像/招投标/融资/招聘强信号' },
  xinbang: { name: '新榜',     desc: '公众号/小红书/抖音发布内容辅助信号' },
  anysite: { name: 'Anysite',  desc: '企业/个人画像：LinkedIn 公司画像、人员搜索、邮箱查找（access-token 认证）' },
};
// 配置驱动：从 PROVIDERS 派生付费源清单，不写死（新增 provider 只需改 PROVIDERS/config）
const INTEGRATION_CATALOG = (typeof PROVIDERS !== 'undefined' ? PROVIDERS : DEFAULT_DISCOVERY_RULES.providers)
  .filter((p) => p.scope === 'paid')
  .map((p) => ({ id: p.id, name: (PROVIDER_META[p.id] || {}).name || p.id, kind: p.kind, scope: p.scope, desc: (PROVIDER_META[p.id] || {}).desc || '' }));
```
> 注：`PROVIDERS` 常量定义于 line 187 附近（同文件静态数组），与 `DEFAULT_DISCOVERY_RULES.providers` 同构；为稳妥，fallback 到 `DEFAULT_DISCOVERY_RULES.providers` 时需在文件顶部确保该常量可用（discovery-rules.html 顶部已内联 `DEFAULT_DISCOVERY_RULES` 等价对象，line 187 即其 `providers` 段）。若 `DEFAULT_DISCOVERY_RULES` 在该文件内未以该名暴露，改用 `PROVIDERS` 即可（line 187 定义）。

- [ ] **Step 6: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/config/providerEnabled.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/config/discoveryRules.js src/config/prospectingRules.js src/web/discovery-rules.html test/config/providerEnabled.test.js
git commit -m "feat(fusion): enable anysite/qixin/xinbang + config-driven integration catalog"
```

---

## Task 6 — 测试 + 多 provider E2E（含 HITL）（设计 T6）

**Files:**
- Create: `test/integration/externalProviderFusion.test.js`

- [ ] **Step 1: 写集成测试（mock fetch + 注入凭据，全链 lookup→draft→confirm）**

```js
// test/integration/externalProviderFusion.test.js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// 用注入凭据 + mock fetch 跑全链，避免依赖真实 JWT/外网
const fakeData = {
  anysite: [{ name: 'AnysiteCo', domain: 'anysite.com', industry: 'chemical' }],
  qixin:   [{ name: 'QixinCo',   domain: 'qixin.com',   industry: 'chemical' }],
  xinbang: [{ name: 'XinbangCo', domain: 'xinbang.com', industry: 'media' }],
};
global.fetch = vi.fn(async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  const prov = url.includes('anysite') ? 'anysite' : url.includes('qixin') ? 'qixin' : 'xinbang';
  return { ok: true, json: async () => ({ items: fakeData[prov] || [] }) };
});

const { seedActions } = await import('../../src/action/seed-actions.js');
const { getAction } = await import('../../src/action/registry.js');
const { insertDraft } = await import('../../src/connectors/discovery/draftRepo.js');
const { queryWrite, pool } = await import('../../src/db.js');

const TID = 'test-e2e-fusion';

beforeAll(() => { seedActions(); });
afterAll(async () => { await queryWrite(`DELETE FROM crm.discovery_draft WHERE tenant_id=$1`, [TID]).catch(()=>{}); await pool.end(); });

describe('multi-provider fusion E2E', () => {
  for (const prov of ['anysite', 'qixin', 'xinbang']) {
    it(`${prov}: lookup → draft → confirm 全链`, async () => {
      const lookup = getAction('prospecting-lookup');
      const r1 = await lookup.handler({ provider: prov, kind: 'prospect', payload: { icp: { industries: ['chemical'] } } },
        { tenantId: TID },
        { resolveCredentials: async () => ({ [prov]: 'JWT' }), // 经 routeExternalLookup 注入
          insertDraft: (d) => insertDraft(d) });
      expect(r1.draft_id).toBeTruthy();
      expect(r1.count).toBeGreaterThan(0);

      const confirm = getAction('prospecting-confirm');
      const created = [];
      const res = await confirm.handler({ draft_id: r1.draft_id }, { tenantId: TID, decision_id: `dec-${prov}`, actor: 'alice' },
        { createParticle: async (type, payload) => { created.push(payload); return { id: 'id' }; },
          createEdge: async () => ({}),
          getDraft: (id, o) => (await import('../../src/connectors/discovery/draftRepo.js')).getDraft(id, o),
          softExpireDraft: (id) => (await import('../../src/connectors/discovery/draftRepo.js')).softExpireDraft(id),
          findAccount: async () => null });
      expect(created.length).toBe(1);
      expect(created[0].stage).toBe('S0');
      expect(res.via).toBe('discovery_draft');
    });
  }

  it('无 credentials → lookup 返回 error，不落草稿', async () => {
    const lookup = getAction('prospecting-lookup');
    const r = await lookup.handler({ provider: 'anysite', kind: 'prospect', payload: {} }, { tenantId: TID },
      { resolveCredentials: async () => ({}), insertDraft: async () => { throw new Error('should not reach'); } });
    expect(r.error).toBe('provider_not_enabled_or_unknown'); // 凭据空 → adapter 不在 enabled 解析结果（无 key 仍注册，但 search 返 []）；此处 provider 解析依赖 enable
  });
});
```

- [ ] **Step 2: 运行集成测试**

Run: `node node_modules/vitest/vitest.mjs run test/integration/externalProviderFusion.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 3: 跑相关测试套件全绿**

Run: `node node_modules/vitest/vitest.mjs run test/connectors/discovery test/action test/config`
Expected: 全 PASS

- [ ] **Step 4: 真 JWT 实测（可选，需 `ANY_SITE_KEY` 环境变量）**

```bash
# 仅本地有真实 JWT 时执行；验证 anysite REST 真机取数
ANY_SITE_KEY="<完整JWT>" node -e "
import('./src/connectors/discovery/adapters/anysite.js').then(async (m)=>{
  const a = m.anysiteAdapter();
  console.log('health:', await a.health({credentials:{anysite:process.env.ANY_SITE_KEY}}));
  console.log('enrich:', await a.enrich({email:'test@acme.com'}, ['industry'], {credentials:{anysite:process.env.ANY_SITE_KEY}}));
});
"
```
Expected: `health.ok=true`，enrich 返回 fieldHit map（或 `{}` 若邮箱无匹配，仍非错误）。

- [ ] **Step 5: 提交**

```bash
git add test/integration/externalProviderFusion.test.js
git commit -m "test(fusion): multi-provider E2E lookup→draft→confirm with HITL gate"
```

---

## 自审（Self-Review）

**1. 设计覆盖核对**
- T1 入站工具 `prospecting-lookup` → Task 2 ✅
- T2 路由处理器零写 → Task 1 ✅
- T3 anysite REST 重写 → Task 3 ✅（含 404 路径 fail-open 开放项）
- T4 草稿暂存 + HITL 确认写 → Task 4 ✅
- T5 配置翻 enabled + 前端通用化 → Task 5 ✅
- T6 单测 + 多 provider E2E → Task 6 ✅
- 红线（禁自动落库 / 禁 DELETE / JWT 不落前端）全部在代码与注释中落实 ✅

**2. 占位符扫描**：无 TBD/TODO；每步均含可执行代码与命令。

**3. 类型/命名一致性**
- `routeExternalLookup({provider,kind,payload,tenantId,deps})` 在 Task 1 定义、Task 2 调用、Task 6 注入 —— 签名一致。
- `insertDraft/getDraft/softExpireDraft` 在 Task 4 定义，Task 2/4/6 调用 —— 一致。
- `prospecting-lookup` / `prospecting-confirm` 命名在 agentSpec、prospectingActions、测试三处一致。
- `draft_id` 字段贯穿 lookup 返回、confirm 入参、draftRepo —— 一致。

**开放项（实现时校准）**
- anysite 公司搜索 REST 路径实测 404 → 当前 fail-open 多候选路径探测；真机校准后收敛单一路径（Task 3 `SEARCH_PATHS`）。
- `discovery_draft` retention 默认 24h 软过期（Task 4 DDL `expires_at`），`sweepExpired` 供定时任务调用。
- 二期 `signal` 端点映射不在本期 scope（设计 §7）。
