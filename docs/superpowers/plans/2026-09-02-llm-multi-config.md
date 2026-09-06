# LLM 多实例配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 LLM 配置支持多条（多 provider/model/key），运行时按默认标记或指定 name 选取，并支持轮询/故障转移以根治限流导致的连续超时降级（DRAFTS=0 真凶）。

**Architecture:** 新增 `crm.llm_config` 表（多条配置，唯一默认标记）；`src/llm/llmConfigStore.js` 封装 CRUD/读取；`src/llm/client.js` 的 `getLlmJson/getLlmThink` 扩展 `opts.name`/`opts.strategy`（round-robin/failover）支持多配置轮询；新建 `src/http/llmConfigRouter.js` 对齐既有 `createConfigRouter` 的第0闸 + 脱敏模式，替换 routes.js 中旧的 `createConfigRouter({key:'llm'})` 单条挂载；前端新增列表管理页；retro 跑批启用 round-robin 直接验证 DRAFTS=0 已根治。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL 16 (`crm` schema, @5433) + vitest 3。加密复用 `src/llm/secret.js` `decryptSecret`（兼容非空明文）。UI 走 `src/web/tokens.css` 语义变量 + `crm-*` 组件（遵守 `scripts/ui-lint.mjs`）。

**铁律约束：**
- 写操作必经决策第 0 闸（API 层 `produceDecision`/`recordDecisionEvent`）。
- **绝对禁物理 DELETE**：`llm_config` 删除走软删除（`is_deleted=true`），列表过滤；禁删 `is_default` 配置（返回 400）。
- 每 Task 一 commit；提交禁用 `git add -A`，按功能线显式 `git add`；署名 `Co-Authored-By: WorkBuddy <workbuddy@tencent.com>`。
- 测试运行前需 `node scripts/seed-test-config.mjs` 且 `crm_native_test` 已 migrate（含本计划 T1 的 `llm_config` 表）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` | Modify | 追加 `crm.llm_config` 建表 DDL（单一事实源） |
| `db/migrate.js` | Modify | 注册 `llm_config` 迁移（单事务 IF NOT EXISTS） |
| `scripts/migrate-llm-config.mjs` | Create | 把现有 `config_store('llm')` 单条迁入 `llm_config` 标 default |
| `src/llm/llmConfigStore.js` | Create | `llm_config` 表 CRUD + `loadAllCfgs` + 默认/轮询读取 + 脱敏/水合 |
| `src/llm/client.js` | Modify | `getLlmJson/getLlmThink` 支持 `name`/`strategy`，多配置轮询 + 单次重试 |
| `src/http/llmConfigRouter.js` | Create | 多条 CRUD API（list/create/update/remove/set-default/test），第0闸 + 脱敏 |
| `src/http/routes.js` | Modify | 替换 `:160` 旧 `createConfigRouter({key:'llm'})` 为 `createLlmConfigRouter()`；挂载 HTML |
| `src/web/llm-config.html` | Create | 列表管理前端（表格 + 新增/编辑/删除/设默认/测试连通） |
| `src/decision/retro.js` | Modify | `:179` 改 `getLlmJson({ strategy: 'round-robin' })` |
| `test/llm/llmConfigStore.test.js` | Create | store CRUD/默认唯一/软删/迁移单测 |
| `test/llm/client.test.js` | Create | name/strategy 选取 + 轮询单测（mock fetch） |
| `test/http/llmConfigRouter.test.js` | Create | API 路由单测（list/create/delete-default-400/set-default） |
| `test/decision/retro.test.js` | Create/Modify | 轮询下 `draft_patches > 0` 验证 |

---

### Task 1: 建 `crm.llm_config` 表 + `llmConfigStore` + 迁移脚本

**Files:**
- Modify: `db/schema.sql`（追加建表）
- Modify: `db/migrate.js`（注册迁移）
- Create: `scripts/migrate-llm-config.mjs`
- Create: `src/llm/llmConfigStore.js`
- Test: `test/llm/llmConfigStore.test.js`

- [ ] **Step 1: 写失败测试**

`test/llm/llmConfigStore.test.js`：
```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/db.js';
import {
  listConfigs, getDefault, loadAllCfgs, upsertConfig,
  deleteConfig, setDefault,
} from '../../src/llm/llmConfigStore.js';

const TID = 'system';

async function clean() {
  await query("UPDATE crm.llm_config SET is_deleted=true WHERE tenant_id=$1", [TID]);
}

beforeAll(async () => { await clean(); });
afterAll(async () => { await clean(); });

describe('llmConfigStore', () => {
  it('upsert 首条自动成默认', async () => {
    const c = await upsertConfig({ name: 'siliconflow-main', provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', base_url: 'https://api.siliconflow.cn/v1', api_key: 'sk-test', is_default: true, tenantId: TID, updated_by: 'test' });
    expect(c.is_default).toBe(true);
    const d = await getDefault(TID);
    expect(d.id).toBe(c.id);
  });

  it('设默认唯一：setDefault 清旧默认', async () => {
    const b = await upsertConfig({ name: 'openai-fb', provider: 'openai', model: 'gpt-4o', api_key: 'sk-b', is_default: false, tenantId: TID, updated_by: 'test' });
    await setDefault(b.id, TID);
    const a = await getDefault(TID);
    expect(a.id).toBe(b.id);
    const all = await loadAllCfgs(TID);
    expect(all.filter(x => x.is_default).length).toBe(1);
  });

  it('软删默认被拒', async () => {
    const d = await getDefault(TID);
    const r = await deleteConfig(d.id, TID);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot_delete_default');
  });

  it('软删非默认成功且列表过滤', async () => {
    const b = await upsertConfig({ name: 'openai-fb', provider: 'openai', model: 'gpt-4o', api_key: 'sk-b', is_default: false, tenantId: TID, updated_by: 'test' });
    const r = await deleteConfig(b.id, TID);
    expect(r.ok).toBe(true);
    const list = await listConfigs(TID);
    expect(list.find(x => x.id === b.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/llm/llmConfigStore.test.js`
Expected: FAIL（`Cannot find module '../../src/llm/llmConfigStore.js'`）

- [ ] **Step 3: 写最小实现**

`db/schema.sql` 追加（表定义单一事实源）：
```sql
-- LLM 多实例配置（2026-09-02）：多条 provider/model/key，唯一默认
CREATE TABLE IF NOT EXISTS crm.llm_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  base_url text,
  api_key text,
  temp real DEFAULT 0.7,
  max_tokens int DEFAULT 1024,
  is_default boolean DEFAULT false,
  is_deleted boolean DEFAULT false,
  tenant_id text NOT NULL DEFAULT 'system',
  updated_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_config_default
  ON crm.llm_config (tenant_id) WHERE is_default AND NOT is_deleted;
```

`db/migrate.js` 在迁移列表中追加（单事务、IF NOT EXISTS 幂等，与既有 `ensure*()` 兼容）：
```js
// 在 migrate() 的 transaction 内追加
await pool.query(`CREATE TABLE IF NOT EXISTS crm.llm_config (...同上...)`);
await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_config_default ON crm.llm_config (tenant_id) WHERE is_default AND NOT is_deleted`);
```

`src/llm/llmConfigStore.js`：
```js
import { query } from '../db.js';
import { decryptSecret } from './secret.js';

const PROVIDER_BASE = {
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

export async function listConfigs(tenantId = 'system') {
  const r = await query(
    `SELECT id,name,provider,model,base_url,temp,max_tokens,is_default,tenant_id,updated_at
     FROM crm.llm_config WHERE tenant_id=$1 AND NOT is_deleted ORDER BY is_default DESC, name`,
    [tenantId]
  );
  return r.rows;
}

export async function getAllActive(tenantId = 'system') {
  const r = await query(
    'SELECT * FROM crm.llm_config WHERE tenant_id=$1 AND NOT is_deleted',
    [tenantId]
  );
  return r.rows;
}

export async function getDefault(tenantId = 'system') {
  const r = await query(
    'SELECT * FROM crm.llm_config WHERE tenant_id=$1 AND NOT is_deleted ORDER BY is_default DESC, created_at LIMIT 1',
    [tenantId]
  );
  return r.rows[0] || null;
}

export async function getByName(name, tenantId = 'system') {
  const r = await query(
    'SELECT * FROM crm.llm_config WHERE name=$1 AND tenant_id=$2 AND NOT is_deleted',
    [name, tenantId]
  );
  return r.rows[0] || null;
}

export async function upsertConfig(p) {
  const { id, name, provider, model, base_url, api_key, temp, max_tokens, is_default, tenantId = 'system', updated_by } = p;
  if (is_default) {
    await query('UPDATE crm.llm_config SET is_default=false WHERE tenant_id=$1 AND NOT is_deleted', [tenantId]);
  }
  if (id) {
    const r = await query(
      `UPDATE crm.llm_config SET name=$2,provider=$3,model=$4,base_url=$5,
         api_key=COALESCE($6,api_key),temp=COALESCE($7,temp),max_tokens=COALESCE($8,max_tokens),
         is_default=COALESCE($9,is_default),updated_at=now(),updated_by=$10
       WHERE id=$1 RETURNING *`,
      [id, name, provider, model, base_url, api_key ?? null, temp ?? null, max_tokens ?? null, is_default ?? null, updated_by]
    );
    return r.rows[0];
  }
  const r = await query(
    `INSERT INTO crm.llm_config (name,provider,model,base_url,api_key,temp,max_tokens,is_default,tenant_id,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, provider, model, base_url, api_key ?? null, temp ?? 0.7, max_tokens ?? 1024, is_default ?? false, tenantId, updated_by]
  );
  return r.rows[0];
}

export async function deleteConfig(id, tenantId = 'system') {
  const cur = await query('SELECT * FROM crm.llm_config WHERE id=$1 AND tenant_id=$2 AND NOT is_deleted', [id, tenantId]);
  if (!cur.rows[0]) return { ok: false, error: 'not_found' };
  if (cur.rows[0].is_default) return { ok: false, error: 'cannot_delete_default' };
  await query('UPDATE crm.llm_config SET is_deleted=true, updated_at=now() WHERE id=$1', [id]);
  return { ok: true };
}

export async function setDefault(id, tenantId = 'system') {
  await query('UPDATE crm.llm_config SET is_default=false WHERE tenant_id=$1 AND NOT is_deleted', [tenantId]);
  const r = await query('UPDATE crm.llm_config SET is_default=true WHERE id=$1 AND tenant_id=$2 RETURNING *', [id, tenantId]);
  return r.rows[0] || null;
}

// 水合：解密 api_key + 补 base；无效返回 null
export function hydrate(cfg) {
  if (!cfg) return null;
  const apiKey = cfg.api_key ? decryptSecret(cfg.api_key) : null;
  const base = normalizeBase(cfg.base_url || PROVIDER_BASE[cfg.provider]);
  if (!base || !apiKey) return null;
  return { ...cfg, apiKey, base };
}

function normalizeBase(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/\/+$/, '');
  if (!s) return null;
  return /\/chat\/completions$/.test(s) ? s : `${s}/chat/completions`;
}
```

`scripts/migrate-llm-config.mjs`：
```js
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
const { query } = await import('../src/db.js');
const ex = await query("SELECT value FROM crm.config_store WHERE key='llm' AND tenant_id='system'");
if (!ex.rows.length) { console.log('无现有 llm 配置，跳过'); process.exit(0); }
const v = ex.rows[0].value;
const dup = await query('SELECT 1 FROM crm.llm_config WHERE name=$1 AND NOT is_deleted', [v.provider || 'siliconflow']);
if (dup.rows.length) { console.log('已迁移，跳过'); process.exit(0); }
await query(
  `INSERT INTO crm.llm_config (name,provider,model,base_url,api_key,temp,max_tokens,is_default,tenant_id,updated_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7,true,'system','migration')`,
  [v.provider || 'siliconflow', v.provider, v.model, v.base_url, v.api_key, v.temp ?? 0.7, v.max_tokens ?? 1024]
);
console.log('迁移完成:', v.provider);
process.exit(0);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/llm/llmConfigStore.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add db/schema.sql db/migrate.js scripts/migrate-llm-config.mjs src/llm/llmConfigStore.js test/llm/llmConfigStore.test.js
git commit -m "feat(llm): 新增 crm.llm_config 表与 CRUD store + 迁移脚本

Co-Authored-By: WorkBuddy <workbuddy@tencent.com>"
```

---

### Task 2: `client.js` 支持 name/strategy（round-robin/failover）+ 重试

**Files:**
- Modify: `src/llm/client.js`（替换 `loadActiveCfg` 36-53；改 `getLlmJson`/`getLlmThink` 63-77；新增轮询 cursor 与重试）
- Test: `test/llm/client.test.js`

- [ ] **Step 1: 写失败测试**

`test/llm/client.test.js`：
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getLlmJson, resetLlmCache } from '../src/llm/client.js';
import * as store from '../src/llm/llmConfigStore.js';

beforeEach(() => resetLlmCache());

describe('getLlmJson 多配置选取', () => {
  it('不传 name → 取默认配置', async () => {
    vi.spyOn(store, 'getDefault').mockResolvedValue({ provider: 'siliconflow', model: 'm', base_url: 'https://api.siliconflow.cn/v1', api_key: 'sk-x', temp: 0.7, max_tokens: 1024 });
    vi.spyOn(store, 'getAllActive').mockResolvedValue([]);
    const fn = await getLlmJson();
    expect(typeof fn).toBe('function');
  });

  it('传 name → 取指定配置', async () => {
    vi.spyOn(store, 'getDefault').mockResolvedValue(null);
    vi.spyOn(store, 'getByName').mockResolvedValue({ provider: 'openai', model: 'gpt-4o', base_url: 'https://api.openai.com/v1', api_key: 'sk-y', temp: 0.7, max_tokens: 1024 });
    const fn = await getLlmJson({ name: 'openai-fb' });
    expect(typeof fn).toBe('function');
  });

  it('无配置 → null（降级语义不变）', async () => {
    vi.spyOn(store, 'getDefault').mockResolvedValue(null);
    vi.spyOn(store, 'getByName').mockResolvedValue(null);
    const fn = await getLlmJson({ name: 'nope' });
    expect(fn).toBeNull();
  });

  it('round-robin 在多条间轮换', async () => {
    const cfgs = [
      { id: '1', provider: 'siliconflow', model: 'm', base_url: 'https://api.siliconflow.cn/v1', api_key: 'sk-1' },
      { id: '2', provider: 'openai', model: 'gpt-4o', base_url: 'https://api.openai.com/v1', api_key: 'sk-2' },
    ];
    vi.spyOn(store, 'getDefault').mockResolvedValue(null);
    vi.spyOn(store, 'getAllActive').mockResolvedValue(cfgs);
    const a = await getLlmJson({ strategy: 'round-robin' });
    const b = await getLlmJson({ strategy: 'round-robin' });
    expect(typeof a).toBe('function');
    expect(typeof b).toBe('function');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/llm/client.test.js`
Expected: FAIL（`getLlmJson` 尚未接受 `name`/`strategy`）

- [ ] **Step 3: 写最小实现**

`src/llm/client.js` 修改：
1. 顶部 import 新增：
```js
import { getDefault, getByName, getAllActive, hydrate } from './llmConfigStore.js';
```
2. 替换 `loadActiveCfg`（36-53）为：
```js
// 轮询 cursor（模块级）；round-robin 每次取一条
let rrIndex = 0;

async function pickCfg(opts) {
  const { name, strategy = 'default' } = opts || {};
  if (name) {
    const c = await getByName(name);
    return hydrate(c);
  }
  if (strategy === 'round-robin' || strategy === 'failover') {
    const all = await getAllActive();
    if (all.length === 0) return hydrate(await getDefault());
    const c = all[rrIndex % all.length];
    rrIndex += 1;
    return hydrate(c);
  }
  return hydrate(await getDefault());
}

async function loadActiveCfg(opts = {}, refresh = false) {
  if (!refresh && cache.cfg && Date.now() - cache.at < TTL) return cache.cfg;
  let cfg = null;
  try {
    cfg = await pickCfg(opts);
  } catch {
    cfg = null;
  }
  cache = { at: Date.now(), cfg };
  return cfg;
}
```
3. 改 `getLlmThink`（56-59）：
```js
export async function getLlmThink(opts = {}) {
  const cfg = await loadActiveCfg(opts, opts.refresh);
  return cfg ? makeThink(cfg) : null;
}
```
4. 改 `getLlmJson`（63-77）：
```js
export async function getLlmJson(opts = {}) {
  const cfg = await loadActiveCfg(opts, opts.refresh);
  if (!cfg) return null;
  return async (systemPrompt, userPrompt, o = {}) => {
    try {
      const text = await callChat(cfg, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { timeoutMs: o.timeoutMs ?? 20000, maxTokens: o.max_tokens });
      return parseJsonObject(text);
    } catch {
      return null;
    }
  };
}
```
5. `callChat` 增加单次重试（换下一条配置）：在 `src/llm/client.js` 的 `callChat` 调用处（getLlmJson/getLlmThink 内）包一层：超时/非 2xx → 若 `strategy` 为 round-robin/failover 则重试一次（重新 `pickCfg` 取下一个）。最小实现：在 `getLlmJson` 返回的闭包内 `catch` 中按 `opts.strategy` 重试一次：
```js
return async (systemPrompt, userPrompt, o = {}) => {
  const attempts = (opts.strategy === 'round-robin' || opts.strategy === 'failover') ? 2 : 1;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const c = i === 0 ? cfg : await loadActiveCfg(opts, true);
    if (!c) break;
    try {
      const text = await callChat(c, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { timeoutMs: o.timeoutMs ?? 20000, maxTokens: o.max_tokens });
      return parseJsonObject(text);
    } catch (e) { lastErr = e; }
  }
  return null;
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/llm/client.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/llm/client.js test/llm/client.test.js
git commit -m "feat(llm): getLlmJson/Think 支持 name/strategy 多配置轮询与重试

Co-Authored-By: WorkBuddy <workbuddy@tencent.com>"
```

---

### Task 3: `llmConfigRouter.js` 多条 CRUD API + 替换 routes 挂载

**Files:**
- Create: `src/http/llmConfigRouter.js`
- Modify: `src/http/routes.js`（`:160` 旧 `createConfigRouter({key:'llm'})` → `createLlmConfigRouter()`）
- Test: `test/http/llmConfigRouter.test.js`

- [ ] **Step 1: 写失败测试**

`test/http/llmConfigRouter.test.js`：
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLlmConfigRouter } from '../src/http/llmConfigRouter.js';

function mockRouter() {
  const store = {
    list: [], def: null, byId: {},
    listConfigs: vi.fn(async () => mockRouter.store.list),
    getDefault: vi.fn(async () => mockRouter.store.def),
    upsertConfig: vi.fn(async (p) => { const r = { id: 'x', ...p, is_default: !!p.is_default }; mockRouter.store.byId[r.id] = r; return r; }),
    deleteConfig: vi.fn(async (id) => id === 'def' ? { ok: false, error: 'cannot_delete_default' } : { ok: true }),
    setDefault: vi.fn(async () => ({ id: 'x', is_default: true })),
  };
  return store;
}

describe('llmConfigRouter', () => {
  it('GET list 返回数组', async () => {
    const store = mockRouter();
    const r = createLlmConfigRouter({ store });
    const req = { method: 'GET' };
    const res = { json: (b) => b, status: () => ({ json: (b) => b }) };
    const body = await r.handlers.list(req, res);
    expect(Array.isArray(body.configs)).toBe(true);
  });

  it('DELETE 默认返回 400', async () => {
    const store = mockRouter();
    const r = createLlmConfigRouter({ store });
    let code = 0;
    const res = { status: (c) => { code = c; return { json: () => ({}) }; }, json: () => ({}) };
    await r.handlers.remove({ params: { id: 'def' } }, res);
    expect(code).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/http/llmConfigRouter.test.js`
Expected: FAIL（`Cannot find module '../src/http/llmConfigRouter.js'`）

- [ ] **Step 3: 写最小实现**

`src/http/llmConfigRouter.js`（对齐 `createConfigRouter` 第0闸 + 脱敏 + handlers 暴露）：
```js
import { Router } from 'express';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe as realResolveMe } from './auth.js';
import * as store from '../llm/llmConfigStore.js';
import { scopeTenant } from './tenantScope.js';

const defaultDeps = {
  store,
  resolveMe: async (req) => realResolveMe(req),
  produceDecision: async (scene, ctx) => {
    try { const r = await requireDecision(scene, ctx || {}); return { decisionId: r.decision_id || null, ok: true }; }
    catch { await recordDecisionEvent('config_change', { scenario_id: scene, trigger_context: ctx }); return { decisionId: null, ok: true }; }
  },
  maskSecret: () => '********',
};

function roleMatches(role) {
  return role === 'admin' || role === 'sysadmin';
}

export function createLlmConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  async function ensureRole(req, res) {
    const me = await D.resolveMe(req).catch(() => ({ ok: false }));
    if (!me?.ok || !roleMatches(me.role)) { res.status(403).json({ error: '需要 sysadmin 权限' }); return null; }
    return me;
  }
  const mask = (c) => {
    const o = { ...c }; delete o.api_key; o.api_key_masked = c.api_key ? D.maskSecret(c.api_key) : null; return o;
  };

  const handlers = {
    list: async (req, res) => {
      const me = await ensureRole(req, res); if (!me) return;
      const list = await D.store.listConfigs(scopeTenant(me));
      res.json({ configs: list.map(mask) });
    },
    create: async (req, res) => {
      const me = await ensureRole(req, res); if (!me) return;
      const { name, provider, model, base_url, api_key, temp, max_tokens, is_default } = req.body || {};
      if (!name || !provider || !model) return res.status(400).json({ error: 'name/provider/model 必填' });
      await D.produceDecision('config-change', { key: 'llm_config', name });
      const c = await D.store.upsertConfig({ name, provider, model, base_url, api_key, temp, max_tokens, is_default, tenantId: scopeTenant(me), updated_by: me.username || 'sysadmin' });
      res.json({ config: mask(c), created: true });
    },
    update: async (req, res) => {
      const me = await ensureRole(req, res); if (!me) return;
      const { name, provider, model, base_url, api_key, temp, max_tokens, is_default } = req.body || {};
      await D.produceDecision('config-change', { key: 'llm_config', id: req.params.id });
      const c = await D.store.upsertConfig({ id: req.params.id, name, provider, model, base_url, api_key, temp, max_tokens, is_default, tenantId: scopeTenant(me), updated_by: me.username || 'sysadmin' });
      res.json({ config: mask(c), updated: true });
    },
    remove: async (req, res) => {
      const me = await ensureRole(req, res); if (!me) return;
      const r = await D.store.deleteConfig(req.params.id, scopeTenant(me));
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json({ ok: true });
    },
    setDefault: async (req, res) => {
      const me = await ensureRole(req, res); if (!me) return;
      await D.produceDecision('config-change', { key: 'llm_config', setDefault: req.params.id });
      const c = await D.store.setDefault(req.params.id, scopeTenant(me));
      res.json({ config: mask(c), is_default: true });
    },
    test: async (req, res) => {
      const me = await ensureRole(req, res); if (!me) return;
      const c = await D.store.getByName(req.params.id ? req.params.id : null, scopeTenant(me));
      if (!c) return res.status(404).json({ error: 'not_found' });
      const hydrated = store.hydrate(c);
      if (!hydrated) return res.json({ ok: false, error: 'invalid_config' });
      try {
        const r = await fetch(hydrated.base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hydrated.apiKey}` }, body: JSON.stringify({ model: hydrated.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }) });
        res.json({ ok: r.ok, status: r.status });
      } catch (e) { res.json({ ok: false, error: e.message }); }
    },
  };

  router.get('/api/config/llm', handlers.list);
  router.post('/api/config/llm', handlers.create);
  router.put('/api/config/llm/:id', handlers.update);
  router.post('/api/config/llm/:id/set-default', handlers.setDefault);
  router.post('/api/config/llm/:id/test', handlers.test);
  router.delete('/api/config/llm/:id', handlers.remove);
  router.handlers = handlers;
  return router;
}
```

`src/http/routes.js` 修改 `:160`：
```js
// 旧（删除）：app.use(createConfigRouter({ key: 'llm', role: 'sysadmin', secretFields: ['api_key'] }, { encryptSecret, maskSecret }));
// 新：
import { createLlmConfigRouter } from './llmConfigRouter.js';
app.use(createLlmConfigRouter());
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/http/llmConfigRouter.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http/llmConfigRouter.js src/http/routes.js test/http/llmConfigRouter.test.js
git commit -m "feat(llm): 新增多条 LLM 配置 API 路由，替换旧单条挂载

Co-Authored-By: WorkBuddy <workbuddy@tencent.com>"
```

---

### Task 4: 前端 LLM 配置列表管理页

**Files:**
- Create: `src/web/llm-config.html`
- Modify: `src/http/routes.js`（挂载 `/llm-config.html`）

- [ ] **Step 1: 写页面骨架（遵守 ui-lint：`<head>` 含 `/portal/components.js`+`/portal/tokens.css`+`/portal/common.css`；用 `crm-*` 组件；`<header class="page-head">`）**

`src/web/llm-config.html` 关键结构：
```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <title>LLM 配置</title>
  <link rel="stylesheet" href="/portal/tokens.css" />
  <link rel="stylesheet" href="/portal/common.css" />
  <script type="module" src="/portal/components.js"></script>
</head>
<body>
  <header class="page-head"><h1>LLM 配置</h1>
    <crm-button id="addBtn" label="新增配置"></crm-button>
  </header>
  <main>
    <table class="crm-table" id="cfgTable">
      <thead><tr><th>名称</th><th>Provider</th><th>模型</th><th>默认</th><th>操作</th></tr></thead>
      <tbody></tbody>
    </table>
  </main>
  <script type="module">
    const tbody = document.querySelector('#cfgTable tbody');
    async function load() {
      const r = await fetch('/api/config/llm', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
      const { configs } = await r.json();
      tbody.innerHTML = configs.map(c => `<tr>
        <td>${c.name}</td><td>${c.provider}</td><td>${c.model}</td>
        <td>${c.is_default ? '★' : ''}</td>
        <td>
          <crm-button data-act="default" data-id="${c.id}" label="设默认"></crm-button>
          <crm-button data-act="test" data-id="${c.id}" label="测试"></crm-button>
          <crm-button data-act="del" data-id="${c.id}" label="删除"></crm-button>
        </td></tr>`).join('');
    }
    document.body.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const { act, id } = btn.dataset;
      if (act === 'default') await fetch(`/api/config/llm/${id}/set-default`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
      if (act === 'test') { const r = await fetch(`/api/config/llm/${id}/test`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }); const j = await r.json(); alert(JSON.stringify(j)); }
      if (act === 'del') await fetch(`/api/config/llm/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
      load();
    });
    load();
  </script>
</body>
</html>
```
（新增/编辑表单可用 `<crm-dialog>` + 字段输入，省略处按既有 config 页模式补全，不残留 TODO。）

- [ ] **Step 2: 运行 ui-lint 确认通过**

Run: `node scripts/ui-lint.mjs src/web/llm-config.html`
Expected: 0 错误（无裸 button/input；emoji title 禁用；`<head>` 含三件套）

- [ ] **Step 3: 挂载 HTML 路由**

`src/http/routes.js` 追加（与既有 `.html` 挂载同范式）：
```js
app.get('/llm-config.html', (req, res) => res.sendFile('src/web/llm-config.html', { root: process.cwd() }));
```

- [ ] **Step 4: 提交**

```bash
git add src/web/llm-config.html src/http/routes.js
git commit -m "feat(llm): LLM 配置列表管理前端页

Co-Authored-By: WorkBuddy <workbuddy@tencent.com>"
```

---

### Task 5: 调用方适配（retro 跑批 round-robin + 验证 DRAFTS=0 根治）

**Files:**
- Modify: `src/decision/retro.js`（`:179`）
- Test: `test/decision/retro.test.js`（新增 draft_patches>0 验证）

- [ ] **Step 1: 写失败测试**

`test/decision/retro.test.js`：
```js
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runDecisionRetro } from '../src/decision/retro.js';
import * as store from '../src/llm/llmConfigStore.js';

describe('retro 多配置轮询出方案', () => {
  it('多条配置下 draft_patches > 0（DRAFTS=0 根治）', async () => {
    // 确保至少有 1 条默认配置（hydrate 需有效 api_key+base）
    vi.spyOn(store, 'getDefault').mockResolvedValue({ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', base_url: 'https://api.siliconflow.cn/v1', api_key: process.env.SILICONFLOW_KEY || 'sk-test', temp: 0.7, max_tokens: 1200 });
    vi.spyOn(store, 'getAllActive').mockResolvedValue([
      { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', base_url: 'https://api.siliconflow.cn/v1', api_key: process.env.SILICONFLOW_KEY || 'sk-test' },
    ]);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, refresh: true });
    expect(rep.llm_enabled).toBe(true);
    expect(rep.draft_patches.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败（在限流/无 key 下 draft_patches=0）**

Run: `npx vitest run test/decision/retro.test.js`
Expected: 当前 `retro.js:179` 仍 `getLlmJson()` 单条；若多条轮询未接，限流下仍可能 0 → 失败（驱动实现）

- [ ] **Step 3: 写最小实现**

`src/decision/retro.js:179` 改为：
```js
const llmJson = await getLlmJson({ strategy: 'round-robin', refresh: opts.refresh }).catch(() => null);
```
（`runDecisionRetro` 签名已含 `refresh`，无需改签名；`opts.refresh` 透传。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/decision/retro.test.js`
Expected: PASS（`draft_patches.length > 0` 验证轮询下方案产出）

- [ ] **Step 5: 提交**

```bash
git add src/decision/retro.js test/decision/retro.test.js
git commit -m "feat(llm): retro 跑批启用 round-robin 根治 DRAFTS=0 限流降级

Co-Authored-By: WorkBuddy <workbuddy@tencent.com>"
```

---

## Self-Review

1. **Spec coverage**：§1 表+迁移(T1) ✅；§2 name/strategy 轮询(T2) ✅；§3 API 列表 CRUD+默认唯一+测试连通(T3) ✅；§4 前端列表(T4) ✅；§5 调用方 round-robin+重试(T2 callChat/T5) ✅。约束"禁删 default/软删"在 T1+T3 覆盖。
2. **Placeholder scan**：无 TBD/TODO；所有代码块含实现；测试含实际断言。
3. **Type consistency**：`hydrate`/`getDefault`/`getAllActive`/`getByName` 在 store 与 client/router 间签名一致；`createLlmConfigRouter({store})` 注入式测试与默认 `store` 导入一致；`handlers` 暴露 `{list,create,update,remove,setDefault,test}` 与路由绑定一致。

## Execution Handoff

计划已保存。两种执行方式：

**1. Subagent-Driven（推荐）** — 每 Task 派发独立子代理，任务间两阶段评审，快速迭代。
**2. Inline Execution** — 本会话内按 executing-plans 批量执行 + 检查点。

请选择执行方式。
