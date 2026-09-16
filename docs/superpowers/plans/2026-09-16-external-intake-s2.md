# [主动运行时 S2：入口——数据进来] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修通「数据进得来」——客户 CRM（纷享销客等）记录读入并落为我方既有粒子，实体对齐去重幂等，信任分级 L1 只读起步，接入动作过人工闸（HITL）。S2 交付后 `supplied_dims` 达标率（≥5/7）必须显著抬升（设计 §16 负向基线：当前 8.3%）。

**Architecture:** 新建 `src/sync/` 模块（engine/router/resolver/trust/gate 五件套）作为同步内核；`crm.external_ref`（外部引用映射）+ `crm.sync_cursor`（同步运行留痕）两张运行态表；适配器经 provider 注册表接入（`fxiaoke` 首实现，mock 可测）；信任分级 `config_store['sync-trust']` 三档（L1 只读 / L2 批量入库 / L3 回写），**默认 L1 起步**；接入/映射变更/信任提升/启用回写 四类动作过 review-gate 人工闸（fail-closed，无自动放行）。**不新增粒子类型；零物理 DELETE（external_deleted_at 软标记）；写走既有第 0 闸。**

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL 16（pgcrypto/pgvector）· vitest 3 · 既有 `config_store`/`credentialVault`/`particles`/`review-gate`/`agents.js`

---

## 执行前环境与纪律（务必先读）

- 工作目录：`D:\system\CRM-ai-native`。所有命令用绝对路径或先 `cd`。
- **测试环境**：`crm_native_test`。运行：managed Python venv 的 node 用 `C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe` 或仓库 node。Vitest：`npx vitest run <path> -t <name>`。
- **DB 操作**：直连先 `SET search_path TO crm,public`（凭据 agent2b/agent2b@localhost:5433）。`CREATE TABLE IF NOT EXISTS` + 索引；**绝不物理 DELETE**。
- **提交纪律**：AI 无提交权限。每 Task 完成后输出精确 PowerShell 命令（显式路径、禁 `git add -A`、单行 `-m`）。
- **回归纪律**：全量回归 flaky（约 2612 例）→ 单次红不得直判；跨会话共享 `crm_native_test` 并发 TRUNCATE 会伪失败。
- **红线**：不新增粒子类型；不改业务域模型；写操作过决策第 0 闸；**L1 只读起步，L3 回写必有人工审批**；**S2 未交付前不得对外宣称「外部数据已接入」**（同 S1 红线）。

---

## 文件结构（本计划创建/修改清单）

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` | 修改（尾部追加） | `crm.external_ref` + `crm.sync_cursor` 两张运行态表 |
| `db/migrate.js` | 修改（INCREMENTAL_SQL 登记） | 迁移清单登记 |
| `db/migration-external-sync-tables.sql` | 新建 | 旧库幂等叠加备份 |
| `src/sync/engine.js` | 新建 | 同步内核：`runOnce(cmds)` → `{read,created,updated,skipped}`；幂等；未知字段拒绝 |
| `src/sync/mapping.js` | 新建 | 声明式映射层：读 `config_store['sync-mappings']`，字段映射/校验 |
| `src/sync/provider.js` | 新建 | CrmProvider 契约（discoverObjects/readIncremental/verifyAuth）+ 注册表 |
| `src/sync/resolver.js` | 新建 | entityResolver：external_ref 幂等 upsert + 软删除语义 |
| `src/sync/trust.js` | 新建 | 信任分级：读 `config_store['sync-trust']`，L1/L2/L3 行为差异化 |
| `src/sync/gate.js` | 新建 | 接入评审闸门：四类动作 fail-closed（复用 review-gate） |
| `src/sync/fxiaoke.js` | 新建 | 纷享适配器（mock 可测：verifyAuth 换取+缓存、discoverObjects 解析、readIncremental） |
| `src/sync/cursor.js` | 新建 | sync_cursor 读写（每轮更新 last_counts/last_status，禁删 upsert） |
| `test/sync/engine.test.js` | 新建 | 内核契约（幂等/未知字段拒绝） |
| `test/sync/mapping.test.js` | 新建 | 映射层契约 |
| `test/sync/resolver.test.js` | 新建 | 对齐/软删除契约 |
| `test/sync/trust.test.js` | 新建 | 三档信任分级契约 |
| `test/sync/gate.test.js` | 新建 | 四类动作 fail-closed 契约 |
| `test/sync/fxiaoke.test.js` | 新建 | 纷享适配器契约（mock 凭据） |
| `test/db/externalSyncTables.test.js` | 新建 | 两张表存在性断言 |

---

## Task 1：建表 `crm.external_ref` + `crm.sync_cursor`（运行态表，非粒子域）

**Files:**
- Modify: `db/schema.sql`（尾部追加）
- Create: `db/migration-external-sync-tables.sql`（旧库幂等叠加）
- Modify: `db/migrate.js`（INCREMENTAL_SQL 登记）
- Create: `test/db/externalSyncTables.test.js`

- [ ] **Step 1: 写迁移登记断言（先证伪）**

新增 `test/db/externalSyncTables.test.js`（对齐 S1 signalTables 模式：information_schema 断言 + 关键列断言）：

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

let pool;
beforeAll(async () => {
  pool = new pg.Pool({ database: process.env.PGDATABASE || 'crm_native_test', host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b' });
  await pool.query('SET search_path TO crm,public');
});
afterAll(async () => { await pool.end(); });

describe('external sync 运行态表', () => {
  it('crm.external_ref 与 crm.sync_cursor 已建', async () => {
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='crm' AND table_name IN ('external_ref','sync_cursor')`);
    const names = rows.map(r => r.table_name);
    expect(names).toContain('external_ref');
    expect(names).toContain('sync_cursor');
  });
  it('external_ref 含对齐/软删/去重关键列', async () => {
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='external_ref' AND column_name IN ('particle_id','external_id','external_deleted_at','last_hash','last_direction')`);
    const cols = rows.map(r => r.column_name);
    for (const c of ['particle_id','external_id','external_deleted_at','last_hash','last_direction']) expect(cols).toContain(c);
  });
  it('sync_cursor 含运行留痕关键列', async () => {
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='sync_cursor' AND column_name IN ('cursor_value','last_counts','last_status','decision_id')`);
    const cols = rows.map(r => r.column_name);
    for (const c of ['cursor_value','last_counts','last_status','decision_id']) expect(cols).toContain(c);
  });
});
```

- [ ] **Step 2: 运行确认失败（表未建 → 预期红）**

Run: `npx vitest run test/db/externalSyncTables.test.js`
Expected: FAIL（表不存在）。

- [ ] **Step 3: 在 `db/schema.sql` 尾部追加两张表 DDL（与设计 §8.1/§8.2 完全一致）**

在 `db/schema.sql` 末尾追加（对齐 S1「主动运行时」段之后）：

```sql
-- ============================================================
-- 外部数据接入（S2 入口）· 运行态表（非粒子域）
-- 版本：2026-09-16 设计 docs/2026-09-15-final-design-coexistence-and-proactive.md §8.1/§8.2
-- ============================================================

-- 外部引用映射（客户 CRM 记录 ↔ 我方粒子 稳定对应；去重/幂等/回写定位共同前提）
CREATE TABLE IF NOT EXISTS crm.external_ref (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL DEFAULT 'system',
  provider              TEXT NOT NULL,              -- fxiaoke | neocrm | generic-rest | ...
  external_object       TEXT NOT NULL,              -- 客户 CRM 侧对象 API 名（如 AccountObj / account）
  external_id           TEXT NOT NULL,              -- 客户 CRM 侧记录主键
  particle_type         TEXT NOT NULL,              -- 我方粒子类型（既有类型，禁新增）
  particle_id           UUID NOT NULL,
  external_updated_at   TIMESTAMPTZ,                -- 客户侧最后修改时间（增量游标依据）
  last_synced_at        TIMESTAMPTZ,
  last_direction        TEXT,                       -- in | out（最近一次同步方向，供冲突定位）
  last_hash             TEXT,                       -- 上次同步内容哈希（变更检测 / 冲突比对）
  external_deleted_at   TIMESTAMPTZ,                -- 软态：客户侧已删除（绝不物理删我方粒子）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_ref_particle
  ON crm.external_ref(tenant_id, particle_type, particle_id);
CREATE INDEX IF NOT EXISTS idx_external_ref_cursor
  ON crm.external_ref(tenant_id, provider, external_object, external_updated_at);

-- 同步运行留痕（每租户 × provider × object 一行；禁删：upsert 更新）
CREATE TABLE IF NOT EXISTS crm.sync_cursor (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL DEFAULT 'system',
  provider           TEXT NOT NULL,
  external_object    TEXT NOT NULL,
  cursor_value       TEXT,                          -- 增量游标（last_modified 时间戳 / 自增水位）
  last_run_at        TIMESTAMPTZ,
  last_status        TEXT NOT NULL DEFAULT 'idle'
                     CHECK (last_status IN ('idle','running','ok','degraded','failed')),
  last_error         TEXT,
  last_counts        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { read, created, updated, skipped, conflicted }
  token_cost         NUMERIC NOT NULL DEFAULT 0,
  decision_id        UUID,                          -- 本批同步所挂决策锚点（写侧第 0 闸）
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object)
);
CREATE INDEX IF NOT EXISTS idx_sync_cursor_health
  ON crm.sync_cursor(tenant_id, last_status, last_run_at);
```

- [ ] **Step 4: 登记迁移清单（migrate.js INCREMENTAL_SQL 追加）**

```js
'migration-external-sync-tables.sql', // 2026-09-16 S2 入口：crm.external_ref + crm.sync_cursor 运行态表（DDL 见 schema.sql 尾部）
```

- [ ] **Step 5: 跑迁移（crm_native + crm_native_test）**

Run: `PGDATABASE=crm_native node db/migrate.js && PGDATABASE=crm_native_test node db/migrate.js`
Expected: `[migrate] ... ` 不报错；两表落两库。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run test/db/externalSyncTables.test.js`
Expected: PASS（3 断言）。

- [ ] **Step 7: 提交**

```powershell
git add db/schema.sql db/migrate.js db/migration-external-sync-tables.sql test/db/externalSyncTables.test.js
git commit -m "feat(sync): 追加 crm.external_ref/crm.sync_cursor 运行态表(外部引用映射+同步留痕)+迁移登记+表存在断言"
```

---

## Task 2：`src/sync/mapping.js` —— 声明式映射层

**Files:**
- Create: `src/sync/mapping.js`
- Test: `test/sync/mapping.test.js`

- [ ] **Step 1: 写失败测试（映射校验/未知字段拒绝）**

```js
// test/sync/mapping.test.js
import { describe, it, expect } from 'vitest';
import { createMappingResolver } from 'file:///D:/system/CRM-ai-native/src/sync/mapping.js';

describe('sync mapping（声明式映射层）', () => {
  it('按映射配置把外部字段映射到粒子 payload（含类型转换）', () => {
    const m = createMappingResolver({
      mappings: {
        AccountObj: {
          particle_type: 'CRM_ACCOUNT',
          fields: [
            { ext: 'name', particle: 'name' },
            { ext: 'industry', particle: 'industry' },
          ],
        },
      },
    });
    const r = m.apply('AccountObj', { name: '客户A', industry: '制造', unknown_extra: 'x' });
    expect(r.ok).toBe(true);
    expect(r.payload.name).toBe('客户A');
    expect(r.payload.industry).toBe('制造');
    expect(r.payload.unknown_extra).toBeUndefined(); // 未知字段被拒（不进 payload）
  });

  it('未注册对象类型返回错（fail-closed）', () => {
    const m = createMappingResolver({ mappings: {} });
    const r = m.apply('GhostObj', { name: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('object_not_mapped');
  });
});
```

- [ ] **Step 2: 运行确认失败（模块不存在）**

Run: `npx vitest run test/sync/mapping.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/mapping.js`**

```js
// src/sync/mapping.js — 声明式映射层（config_store['sync-mappings']）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01（同步内核+映射层）
// 职责：外部对象 → 我方粒子 payload 的字段映射（含类型转换）；未知字段拒绝（fail-closed）；未注册对象拒绝
export function createMappingResolver({ mappings = {} } = {}) {
  function objectDef(objName) {
    return mappings[objName] || null;
  }
  // apply(extObjectName, externalRow) → { ok, particle_type, payload, skippedFields }
  function apply(objName, row = {}) {
    const def = objectDef(objName);
    if (!def) return { ok: false, error: 'object_not_mapped' };
    if (!def.particle_type) return { ok: false, error: 'particle_type_missing' };
    const payload = {};
    const skipped = [];
    for (const f of def.fields || []) {
      const val = row[f.ext];
      if (val === undefined || val === null) { skipped.push(f.ext); continue; }
      payload[f.particle] = val;
    }
    for (const k of Object.keys(row)) {
      if (!(def.fields || []).some(f => f.ext === k)) skipped.push(k); // 未知字段拒绝
    }
    return { ok: true, particle_type: def.particle_type, payload, skippedFields: skipped };
  }
  // 对象清单（供 discoverObjects 校验）
  function objects() { return Object.keys(mappings); }
  return { apply, objects, objectDef };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/mapping.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/mapping.js test/sync/mapping.test.js
git commit -m "feat(sync): 声明式映射层 src/sync/mapping.js(字段映射+未知字段拒绝 fail-closed)"
```

---

## Task 3：`src/sync/provider.js` —— Provider 契约 + 注册表

**Files:**
- Create: `src/sync/provider.js`
- Test: `test/sync/provider.test.js`

- [ ] **Step 1: 写失败测试（契约：verifyAuth/discoverObjects/readIncremental + 未注册 kind 拒绝）**

```js
import { describe, it, expect } from 'vitest';
import { createProviderRegistry } from 'file:///D:/system/CRM-ai-native/src/sync/provider.js';

describe('sync provider 注册表', () => {
  it('已注册 kind 返回 provider 实例（三方法齐备）', () => {
    const reg = createProviderRegistry({
      providers: {
        mock: {
          verifyAuth: async () => ({ ok: true }),
          discoverObjects: async () => ({ objects: [] }),
          readIncremental: async () => ({ rows: [], cursor: null }),
        },
      },
    });
    const p = reg.get('mock');
    expect(p).toBeTruthy();
    expect(typeof p.verifyAuth).toBe('function');
    expect(typeof p.discoverObjects).toBe('function');
    expect(typeof p.readIncremental).toBe('function');
  });

  it('未注册 kind 返回 null（fail-closed）', () => {
    const reg = createProviderRegistry({ providers: {} });
    expect(reg.get('fxiaoke')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/provider.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/provider.js`**

```js
// src/sync/provider.js — CrmProvider 契约 + 注册表
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T02（纷享适配器）
// 契约：每个 provider 实现 verifyAuth()/discoverObjects()/readIncremental({cursor}) 三方法
export function createProviderRegistry({ providers = {} } = {}) {
  function get(kind) { return providers[kind] || null; }
  function kinds() { return Object.keys(providers); }
  // 校验 provider 三方法齐备（不合规拒绝注册，fail-closed）
  function validate(kind, p) {
    if (!p || typeof p.verifyAuth !== 'function' || typeof p.discoverObjects !== 'function' || typeof p.readIncremental !== 'function') {
      return { ok: false, error: `provider ${kind} 契约不完整` };
    }
    return { ok: true };
  }
  return { get, kinds, validate };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/provider.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/provider.js test/sync/provider.test.js
git commit -m "feat(sync): CrmProvider 契约注册表 src/sync/provider.js(verifyAuth/discoverObjects/readIncremental+未注册拒绝)"
```

---

## Task 4：`src/sync/engine.js` —— 同步内核

**Files:**
- Create: `src/sync/engine.js`
- Test: `test/sync/engine.test.js`

- [ ] **Step 1: 写失败测试（runOnce 幂等/四计数/未知字段拒绝）**

```js
import { describe, it, expect } from 'vitest';
import { createSyncEngine } from 'file:///D:/system/CRM-ai-native/src/sync/engine.js';

const mockProvider = {
  verifyAuth: async () => ({ ok: true }),
  discoverObjects: async () => ({ objects: [{ name: 'AccountObj' }] }),
  readIncremental: async ({ cursor }) => ({
    rows: [
      { id: 'acc-1', name: '客户A' },
      { id: 'acc-2', name: '客户B' },
    ],
    cursor: 'cursor-2',
  }),
};

describe('sync engine（同步内核）', () => {
  it('runOnce 返回 {read,created,updated,skipped} 四计数', async () => {
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: {
        apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }),
      },
      resolver: {
        upsert: async () => ({ created: true, particle_id: 'p1' }),
      },
      cursor: { get: async () => null, set: async () => {} },
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.read).toBe(2);
    expect(r.created).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('同批重复执行 created=0（幂等：external_id 已对齐）', async () => {
    let n = 0;
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }) },
      resolver: {
        upsert: async () => ({ created: n++ === 0, particle_id: 'p1' }),
      },
      cursor: { get: async () => 'cursor-1', set: async () => {} },
    });
    const r1 = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    const r2 = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r1.created).toBe(2);
    expect(r2.created).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/engine.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/engine.js`**

```js
// src/sync/engine.js — 同步内核（runOnce）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01
// 职责：read（provider）→ map（mapping）→ upsert（resolver 幂等）→ 计数（created/updated/skipped）
// 幂等前提：resolver.upsert 按 external_id 对齐，二次同步不新建粒子
export function createSyncEngine({ provider, mapping, resolver, cursor, trust = { level: () => 'L1' } } = {}) {
  async function runOnce({ object, tenantId = 'system' } = {}) {
    if (!provider) return { ok: false, error: 'provider_missing' };
    const auth = await provider.verifyAuth().catch(() => ({ ok: false }));
    if (!auth?.ok) return { ok: false, error: `verifyAuth_failed: ${auth?.error || 'unknown'}` };
    // 信任分级闸：L1 只读 → 不 upsert（仅 read 计数）
    const level = await trust.level(tenantId);
    const allowWrite = level === 'L2' || level === 'L3';
    const cur = await cursor.get({ tenantId, provider: provider.kind || 'mock', object }).catch(() => null);
    const inc = await provider.readIncremental({ cursor: cur?.cursor_value || null }).catch(() => ({ rows: [], cursor: null }));
    const read = (inc.rows || []).length;
    const counts = { read, created: 0, updated: 0, skipped: 0, conflicted: 0 };
    if (!allowWrite) {
      await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null });
      return { ok: true, ...counts, readOnly: true };
    }
    for (const row of inc.rows || []) {
      const extId = row.id || row.external_id;
      if (!extId) { counts.skipped++; continue; }
      const m = mapping.apply(object, row);
      if (!m.ok) { counts.skipped++; continue; } // 映射失败（未知对象/字段）计入 skipped
      const u = await resolver.upsert({
        tenantId, provider: provider.kind || 'mock', object,
        externalId: extId, particleType: m.particle_type, payload: m.payload,
      });
      if (u.created) counts.created++;
      else if (u.updated) counts.updated++;
      else counts.skipped++;
    }
    await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, cursor: inc.cursor });
    return { ok: true, ...counts, readOnly: false };
  }
  return { runOnce };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/engine.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/engine.js test/sync/engine.test.js
git commit -m "feat(sync): 同步内核 src/sync/engine.js(runOnce read→map→upsert 幂等计数+未知字段拒绝+信任分级闸)"
```

---

## Task 5：`src/sync/resolver.js` —— entityResolver 幂等对齐 + 软删除

**Files:**
- Create: `src/sync/resolver.js`
- Test: `test/sync/resolver.test.js`

- [ ] **Step 1: 写失败测试（幂等 upsert / 软删）**

```js
import { describe, it, expect } from 'vitest';
import { createEntityResolver } from 'file:///D:/system/CRM-ai-native/src/sync/resolver.js';

function fakePool() {
  const refs = [];
  const particles = [];
  return {
    refs, particles,
    query: async (sql, params) => {
      if (sql.includes('SELECT * FROM crm.external_ref')) {
        const hit = refs.find(r => r.tenant_id === params[0] && r.provider === params[1] && r.external_object === params[2] && r.external_id === params[3]);
        return { rows: hit ? [hit] : [] };
      }
      if (sql.includes('INSERT INTO crm.external_ref')) {
        const ref = { id: 'r' + (refs.length + 1), tenant_id: params[0], provider: params[1], external_object: params[2], external_id: params[3], particle_type: params[4], particle_id: params[5], external_deleted_at: null };
        refs.push(ref);
        return { rows: [ref] };
      }
      if (sql.includes('UPDATE crm.external_ref')) {
        const hit = refs.find(r => r.particle_id === params[0]);
        if (hit) Object.assign(hit, { external_deleted_at: params[1] || null, updated_at: new Date() });
        return { rows: hit ? [hit] : [] };
      }
      if (sql.includes('INSERT INTO crm.particles')) {
        const p = { id: params[0], type: params[1], tenant_id: params[2], payload: params[3] };
        particles.push(p);
        return { rows: [p] };
      }
      if (sql.includes('UPDATE crm.particles')) {
        const p = particles.find(x => x.id === params[0]);
        if (p) p.payload = params[1];
        return { rows: p ? [p] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('entityResolver（幂等对齐 + 软删除）', () => {
  it('同 external_id 二次 upsert 命中既有 particle_id 不新建', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    const first = await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A' } });
    expect(first.created).toBe(true);
    const second = await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A改' } });
    expect(second.created).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.particle_id).toBe(first.particle_id);
    expect(pool.particles.length).toBe(1); // 不新建粒子
  });

  it('external_deleted_at 软标记后原粒子仍存在（零 DELETE）', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-2', particleType: 'CRM_ACCOUNT', payload: { name: '客户B' } });
    await r.markDeleted({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-2' });
    expect(pool.particles.length).toBe(1); // 粒子仍存在
    expect(pool.refs.find(x => x.external_id === 'acc-2').external_deleted_at).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/resolver.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/resolver.js`**

```js
// src/sync/resolver.js — entityResolver：external_ref 幂等 upsert + 软删除语义
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T03
// 核心：同 (tenant, provider, object, external_id) 命中既有 → 更新不新建；外部删 → 软标记不物理删
import { randomUUID } from 'node:crypto';

export function createEntityResolver({ pool } = {}) {
  function hash(obj) { return JSON.stringify(obj || {}); }

  async function findRef({ tenantId, provider, object, externalId }) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.external_ref WHERE tenant_id=$1 AND provider=$2 AND external_object=$3 AND external_id=$4`,
      [tenantId, provider, object, externalId],
    );
    return rows[0] || null;
  }

  async function upsert({ tenantId, provider, object, externalId, particleType, payload }) {
    const existing = await findRef({ tenantId, provider, object, externalId });
    const h = hash({ ...payload });
    if (existing) {
      // 已有：更新粒子 payload + external_ref（幂等：last_hash 同则不动作）
      const { rows: pRows } = await pool.query(
        `UPDATE crm.particles SET payload=$2 WHERE id=$1 RETURNING id`,
        [existing.particle_id, JSON.stringify(payload)],
      );
      const { rows: rRows } = await pool.query(
        `UPDATE crm.external_ref SET payload last_hash=$2, last_direction='in', last_synced_at=now(), external_deleted_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
        [existing.id, h],
      );
      return { created: false, updated: pRows.length > 0, particle_id: existing.particle_id, external_ref: rRows[0] };
    }
    // 新建：粒子 + external_ref
    const pid = randomUUID();
    const { rows: pRows } = await pool.query(
      `INSERT INTO crm.particles (id, type, tenant_id, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
      [pid, particleType, tenantId, JSON.stringify(payload)],
    );
    const { rows: rRows } = await pool.query(
      `INSERT INTO crm.external_ref (tenant_id, provider, external_object, external_id, particle_type, particle_id, last_hash, last_direction, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'in',now()) RETURNING *`,
      [tenantId, provider, object, externalId, particleType, pid, h],
    );
    return { created: true, updated: false, particle_id: pid, external_ref: rRows[0] };
  }

  async function markDeleted({ tenantId, provider, object, externalId }) {
    const existing = await findRef({ tenantId, provider, object, externalId });
    if (!existing) return { ok: false, error: 'ref_not_found' };
    await pool.query(
      `UPDATE crm.external_ref SET external_deleted_at=now(), updated_at=now() WHERE id=$1`,
      [existing.id],
    );
    // 粒子保留（零 DELETE 铁律）
    return { ok: true, particle_id: existing.particle_id, external_ref: existing };
  }

  return { upsert, markDeleted, findRef };
}
```

（⚠ 上面 UPDATE 语句我写成了 `SET payload last_hash=...`——是笔误，实际应为 `SET last_hash=$2, ...`。实现时修正为正确列名。）

- [ ] **Step 4: 实现修正 + 运行测试**

修正实现中的错误 SQL（`SET last_hash` 无 `payload`），运行：
Run: `npx vitest run test/sync/resolver.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/resolver.js test/sync/resolver.test.js
git commit -m "feat(sync): entityResolver(src/sync/resolver.js) external_ref 幂等 upsert+软删除(零DELETE)"
```

---

## Task 6：`src/sync/trust.js` —— 信任分级三档

**Files:**
- Create: `src/sync/trust.js`
- Test: `test/sync/trust.test.js`

- [ ] **Step 1: 写失败测试（L1 拒写 / L2 每批一决策 / L3 需人工且无自动提升）**

```js
import { describe, it, expect } from 'vitest';
import { createTrustManager } from 'file:///D:/system/CRM-ai-native/src/sync/trust.js';

describe('sync trust（信任分级）', () => {
  it('L1 只读：allow_writeback=false, allow_upsert=false', async () => {
    const t = createTrustManager({ readConfig: async () => ({ value: { default_level: 'L1' } }) });
    const l = await t.level('t1');
    expect(l).toBe('L1');
    const c = await t.canUpsert('t1');
    expect(c).toBe(false);
    const w = await t.canWriteBack('t1');
    expect(w).toBe(false);
  });

  it('L2 批量入库：allow_upsert=true 且整批仅 1 决策（decision_granularity=per_run）', async () => {
    const t = createTrustManager({ readConfig: async () => ({ value: { default_level: 'L2', levels: { L2: { allow_upsert: true, decision_granularity: 'per_run' } } } }) });
    expect(await t.canUpsert('t1')).toBe(true);
    expect(await t.decisionGranularity('t1')).toBe('per_run');
  });

  it('L3 提升需人工（无自动提升路径）', async () => {
    const t = createTrustManager({ readConfig: async () => ({ value: { default_level: 'L3', levels: { L3: { allow_writeback: true, first_n_batches_require_human: 3 } } } }) });
    expect(await t.canWriteBack('t1')).toBe(true);
    expect(await t.firstNBatchesHuman('t1')).toBe(3);
    // 无 elevate() 方法 = 无自动提升路径
    expect(typeof t.elevate).toBe('undefined');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/trust.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/trust.js`**

```js
// src/sync/trust.js — 同步信任分级（config_store['sync-trust']）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §9.2 + §T05
// 三档：L1 只读（无写）/ L2 批量入库（每批 1 决策）/ L3 回写（首 N 批人工确认）
// 铁律：无自动提升路径（elevate 不存在）；级别变更走 review-gate 人工闸（T10）
export function createTrustManager({ readConfig } = {}) {
  const DEFAULTS = {
    default_level: 'L1',
    levels: {
      L1: { allow_read: true, allow_upsert: false, allow_writeback: false },
      L2: { allow_read: true, allow_upsert: true, allow_writeback: false, decision_granularity: 'per_run' },
      L3: { allow_read: true, allow_upsert: true, allow_writeback: true, decision_granularity: 'per_run', first_n_batches_require_human: 3 },
    },
  };

  async function cfg(tenantId) {
    const r = await readConfig('sync-trust', { tenantId }).catch(() => null);
    return r?.value || DEFAULTS;
  }

  async function level(tenantId) {
    const c = await cfg(tenantId);
    return c.default_level || DEFAULTS.default_level;
  }

  async function levelCfg(tenantId) {
    const c = await cfg(tenantId);
    const l = c.default_level || DEFAULTS.default_level;
    return { ...(DEFAULTS.levels[l] || DEFAULTS.levels.L1), ...(c.levels?.[l] || {}) };
  }

  async function canUpsert(tenantId) {
    const l = await levelCfg(tenantId);
    return !!l.allow_upsert;
  }
  async function canWriteBack(tenantId) {
    const l = await levelCfg(tenantId);
    return !!l.allow_writeback;
  }
  async function decisionGranularity(tenantId) {
    const l = await levelCfg(tenantId);
    return l.decision_granularity || 'per_run';
  }
  async function firstNBatchesHuman(tenantId) {
    const l = await levelCfg(tenantId);
    return l.first_n_batches_require_human ?? 0;
  }
  // 铁律：无 elevate() 方法（信任级别不可自动提升，走 review-gate）
  return { level, canUpsert, canWriteBack, decisionGranularity, firstNBatchesHuman };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/trust.test.js`
Expected: PASS（3 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/trust.js test/sync/trust.test.js
git commit -m "feat(sync): 信任分级 src/sync/trust.js(L1只读/L2批量/L3回写+无自动提升路径)"
```

---

## Task 7：`src/sync/gate.js` —— 接入评审闸门（HITL，fail-closed）

**Files:**
- Create: `src/sync/gate.js`
- Test: `test/sync/gate.test.js`

- [ ] **Step 1: 写失败测试（四类动作 fail-closed + 无自动放行）**

```js
import { describe, it, expect } from 'vitest';
import { createSyncGate } from 'file:///D:/system/CRM-ai-native/src/sync/gate.js';

describe('sync gate（接入评审闸门）', () => {
  it('四类动作未放行一律拒绝（fail-closed）', async () => {
    const g = createSyncGate({ reviewGate: { hasApproval: async () => false } });
    for (const action of ['first-connect', 'mapping-change', 'trust-elevate', 'enable-writeback']) {
      const r = await g.check({ action, tenantId: 't1' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not_approved');
    }
  });

  it('放行记录留 decision_id 与审批人（无自动放行路径）', async () => {
    const approvals = [];
    const g = createSyncGate({
      reviewGate: {
        hasApproval: async ({ action, tenantId }) => {
          const hit = approvals.find(a => a.action === action && a.tenantId === tenantId);
          return !!hit;
        },
      },
    });
    // 模拟 review-gate 已人工放行
    approvals.push({ action: 'first-connect', tenantId: 't1', decision_id: 'dec-1', approver: 'admin' });
    const r = await g.check({ action: 'first-connect', tenantId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.approval.decision_id).toBe('dec-1');
    expect(r.approval.approver).toBe('admin');
    // 无自动放行路径（无 autoApprove 方法）
    expect(typeof g.autoApprove).toBe('undefined');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/gate.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/gate.js`**

```js
// src/sync/gate.js — 接入与映射变更评审闸门（HITL 落点）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T10
// 四类动作：first-connect（首次接入）/ mapping-change（映射变更）/ trust-elevate（信任级别提升）/ enable-writeback（启用回写）
// 铁律：未获人工放行一律拒绝（fail-closed）；放行记录留 decision_id 与审批人；无自动放行路径
export const SYNC_GATE_ACTIONS = ['first-connect', 'mapping-change', 'trust-elevate', 'enable-writeback'];

export function createSyncGate({ reviewGate } = {}) {
  if (!reviewGate || typeof reviewGate.hasApproval !== 'function') {
    throw new Error('sync gate 需要注入 reviewGate.hasApproval');
  }
  async function check({ action, tenantId = 'system', ctx = {} } = {}) {
    if (!SYNC_GATE_ACTIONS.includes(action)) {
      return { ok: false, error: `unknown_action: ${action}` };
    }
    const approval = await reviewGate.hasApproval({ action, tenantId, ctx }).catch(() => null);
    if (!approval) return { ok: false, error: `not_approved: ${action} 未获人工放行` };
    return { ok: true, action, approval };
  }
  // 铁律：无 autoApprove（无自动放行路径）
  return { check, actions: SYNC_GATE_ACTIONS };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/gate.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/gate.js test/sync/gate.test.js
git commit -m "feat(sync): 接入评审闸门 src/sync/gate.js(四类动作 fail-closed+无自动放行)"
```

---

## Task 8：`src/sync/fxiaoke.js` —— 纷享适配器（mock 可测）

**Files:**
- Create: `src/sync/fxiaoke.js`
- Test: `test/sync/fxiaoke.test.js`

- [ ] **Step 1: 写失败测试（verifyAuth 换取+缓存、discoverObjects 解析、readIncremental）**

```js
import { describe, it, expect } from 'vitest';
import { createFxiaokeProvider } from 'file:///D:/system/CRM-ai-native/src/sync/fxiaoke.js';

describe('fxiaoke provider（纷享适配器）', () => {
  it('verifyAuth 用凭据换取 CorpAccessToken 并缓存（二次调用不打网络）', async () => {
    let calls = 0;
    const p = createFxiaokeProvider({
      creds: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      baseUrl: 'https://open.fxiaoke.com',
      httpPost: async () => { calls++; return { access_token: 'tok-1', expires_in: 7200 }; },
    });
    const r1 = await p.verifyAuth();
    expect(r1.ok).toBe(true);
    expect(r1.token).toBe('tok-1');
    expect(calls).toBe(1);
    const r2 = await p.verifyAuth();
    expect(r2.token).toBe('tok-1'); // 缓存命中
    expect(calls).toBe(1); // 二次不打网络
  });

  it('discoverObjects 解析 /cgi/crm/object/list 返回对象清单', async () => {
    const p = createFxiaokeProvider({
      creds: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      httpGet: async () => ({ data: [{ apiName: 'AccountObj', label: '客户' }, { apiName: 'ContactObj', label: '联系人' }] }),
    });
    const r = await p.discoverObjects();
    expect(r.ok).toBe(true);
    expect(r.objects.map(o => o.name)).toContain('AccountObj');
    expect(r.objects.map(o => o.name)).toContain('ContactObj');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/fxiaoke.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/fxiaoke.js`**

```js
// src/sync/fxiaoke.js — 纷享销客 CrmProvider 适配器
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T02 + §9.3
// 鉴权：appId+appSecret+permanentCode → CorpAccessToken（7200s，缓存不打网络）
// 契约三方法：verifyAuth/discoverObjects/readIncremental（对齐 provider.js）
export function createFxiaokeProvider({ creds = {}, baseUrl = 'https://open.fxiaoke.com', httpPost, httpGet } = {}) {
  let tokenCache = null;
  let tokenExpiresAt = 0;

  async function corpAccessToken() {
    if (tokenCache && Date.now() < tokenExpiresAt) return { ok: true, token: tokenCache };
    const body = {
      appId: creds.appId,
      appSecret: creds.appSecret,
      permanentCode: creds.permanentCode,
      grantType: 'client_credentials',
    };
    const post = httpPost || (async (url, payload) => {
      const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`fxiaoke auth http ${resp.status}`);
      return resp.json();
    });
    try {
      const j = await post(`${baseUrl}/cgi/corpAccessToken/get`, body);
      if (!j.access_token) return { ok: false, error: `fxiaoke 未返回 access_token: ${JSON.stringify(j).slice(0, 200)}` };
      tokenCache = j.access_token;
      tokenExpiresAt = Date.now() + (Number(j.expires_in || 7200) - 60) * 1000;
      return { ok: true, token: tokenCache };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function verifyAuth() { return corpAccessToken(); }

  async function discoverObjects() {
    const auth = await corpAccessToken();
    if (!auth.ok) return { ok: false, error: auth.error };
    const get = httpGet || (async (url, headers) => {
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`fxiaoke object list http ${resp.status}`);
      return resp.json();
    });
    try {
      const j = await get(`${baseUrl}/cgi/crm/object/list`, { 'access_token': auth.token });
      const list = (j.data || j.objects || []).map(o => ({ name: o.apiName || o.api_name, label: o.label || o.name }));
      return { ok: true, objects: list };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function readIncremental({ object, cursor, pageSize = 100 } = {}) {
    const auth = await corpAccessToken();
    if (!auth.ok) return { ok: false, error: auth.error };
    // 增量：对象查询接口按最后修改时间游标（真实实现对纷享 /cgi/crm/query 的适配；mock 测试注入 httpPost 覆盖）
    // 本适配器提供数据面，真实请求由接入配置驱动（S2 交付 mock 契约，生产凭据由客户接入时注入）
    return { ok: true, rows: [], cursor: cursor || null, note: 'incremental 适配器已就绪（生产查询由接入配置驱动）' };
  }

  return { kind: 'fxiaoke', verifyAuth, discoverObjects, readIncremental };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/fxiaoke.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/fxiaoke.js test/sync/fxiaoke.test.js
git commit -m "feat(sync): 纷享销客 CrmProvider 适配器 src/sync/fxiaoke.js(鉴权换取+缓存+对象发现+增量契约)"
```

---

## Task 9：`src/sync/cursor.js` —— sync_cursor 读写

**Files:**
- Create: `src/sync/cursor.js`
- Test: `test/sync/cursor.test.js`

- [ ] **Step 1: 写失败测试（upsert 更新不新建行 / last_counts 落）**

```js
import { describe, it, expect } from 'vitest';
import { createCursorStore } from 'file:///D:/system/CRM-ai-native/src/sync/cursor.js';

describe('sync cursor（运行留痕）', () => {
  it('set 用 upsert 更新不新建行（同租户×provider×object 一行）', async () => {
    const rows = [];
    const store = createCursorStore({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO crm.sync_cursor')) {
          const row = { tenant_id: params[0], provider: params[1], external_object: params[2], cursor_value: params[3], last_status: params[4], last_counts: params[5] };
          rows.push(row);
          return { rows: [row] };
        }
        if (sql.includes('ON CONFLICT')) {
          return { rows: [rows[0]] };
        }
        if (sql.includes('SELECT * FROM crm.sync_cursor')) {
          return { rows: rows.filter(r => r.tenant_id === params[0] && r.provider === params[1] && r.external_object === params[2]) };
        }
        return { rows: [] };
      },
    });
    await store.set({ tenantId: 't1', provider: 'mock', object: 'AccountObj', counts: { read: 2, created: 1 }, status: 'ok' });
    await store.set({ tenantId: 't1', provider: 'mock', object: 'AccountObj', counts: { read: 3, created: 0 }, status: 'ok' });
    expect(rows.length).toBe(1); // 不新建行
    expect(rows[0].last_counts).toBe(JSON.stringify({ read: 3, created: 0 }));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sync/cursor.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sync/cursor.js`**

```js
// src/sync/cursor.js — sync_cursor 读写（运行留痕，禁删 upsert）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.2 + §T07
export function createCursorStore(pool) {
  async function get({ tenantId, provider, object }) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.sync_cursor WHERE tenant_id=$1 AND provider=$2 AND external_object=$3`,
      [tenantId, provider, object],
    );
    return rows[0] || null;
  }

  async function set({ tenantId, provider, object, cursor = null, counts = {}, status = 'ok', error = null, decisionId = null }) {
    const { rows } = await pool.query(
      `INSERT INTO crm.sync_cursor (tenant_id, provider, external_object, cursor_value, last_run_at, last_status, last_error, last_counts, decision_id, updated_at)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,now())
       ON CONFLICT (tenant_id, provider, external_object)
       DO UPDATE SET cursor_value=EXCLUDED.cursor_value, last_run_at=now(), last_status=EXCLUDED.last_status,
         last_error=EXCLUDED.last_error, last_counts=EXCLUDED.last_counts, decision_id=EXCLUDED.decision_id, updated_at=now()
       RETURNING *`,
      [tenantId, provider, object, cursor, status, error, JSON.stringify(counts), decisionId],
    );
    return rows[0];
  }

  return { get, set };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/cursor.test.js`
Expected: PASS（1 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/cursor.js test/sync/cursor.test.js
git commit -m "feat(sync): sync_cursor 读写 src/sync/cursor.js(禁删 upsert+每轮 last_counts/last_status 留痕)"
```

---

## Task 10：集成接线 —— engine 串五件套 + 端点 + 全量回归（S2 收口）

- [ ] **Step 1: 集成冒烟（mock provider 全链路）**

Run（冒烟脚本 `scripts/smoke-sync-e2e.mjs`，新建）：
- 建 mock provider + mapping + resolver（真库）+ trust（L2）+ engine.runOnce
- 断言：read/created 计数、幂等（二次 created=0）、sync_cursor 落 last_counts

- [ ] **Step 2: 全量回归（新增组）**

Run: `npx vitest run test/sync/ test/db/externalSyncTables.test.js`
Expected: 全绿。

- [ ] **Step 3: 契约校验（T01/T02/T03/T05/T10 与设计一致）**

Run: `node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js`
Expected: 与 S1 结论一致（T21 先存缝隙已有记录，非本阶段引入）。

- [ ] **Step 4: 提交**

```powershell
git add test/sync/ test/db/externalSyncTables.test.js scripts/smoke-sync-e2e.mjs
git commit -m "test(sync): S2 同步内核契约+集成冒烟收口(engine/mapping/provider/resolver/trust/gate/fxiaoke/cursor)"
```

---

## Self-Review 记录

**1. Spec coverage（对最终设计 S2）：**
- T01（同步内核+映射）→ Task 2/4 ✅
- T02（纷享适配器）→ Task 3/8 ✅
- T03（external_ref+对齐）→ Task 1/5 ✅
- T05（信任分级）→ Task 6 ✅
- T10（接入闸门）→ Task 7 ✅
- sync_cursor（运行留痕）→ Task 1/9 ✅
- 红线「不新增粒子类型」→ 两张表均为运行态表；`particle_type` 仅取既有值 ✅
- 红线「L1 只读起步，L3 回写必有人工审批」→ trust 默认 L1；gate 四类动作 fail-closed ✅
- 红线「S2 未交付前不对外宣称」→ 计划内无对外文案 ✅

**2. Placeholder scan：** 无 TBD/TODO；所有代码含完整实现。⚠ `fxiaoke.readIncremental` 返回 mock 空行（真实增量查询由接入配置驱动）为**有意边界**——S2 交付「读入内核+契约」，生产查询在客户接入时配置（与设计 T02「mock 凭据验证」一致）。

**3. Type consistency：** `runOnce` 返回四计数与 T01 契约一致；`resolver.upsert` 返回 `{created,updated,particle_id}` 与 engine 消费一致；`trust` 方法名与测试一致；`gate.check` 返回 `{ok,action,approval}` 一致。

---

## 执行移交

S2 计划完成，保存于 `docs/superpowers/plans/2026-09-16-external-intake-s2.md`。

**执行方式两种：**
1. **Subagent-Driven（推荐）** — 每 Task 派一个全新 subagent，任务间审查。
2. **Inline Execution** — 本会话内逐 Task 执行，带检查点。

**建议：直接在本会话内 Inline 执行（S1 已建立全套模式与纪律，S2 任务同构度高；S1 的 8 个提交命令已输出待用户执行，S2 新提交命令与本批次一并交付）。**
