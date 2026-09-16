# 线A 挂载点实施计划 —— line-a-mount-points

- 计划输入：`docs/2026-09-15-final-design-coexistence-and-proactive.md`（§6.1 A-B5/A-B6、§9.1/§9.3 配置层、§13 T06 契约）
- 触发：`docs/2026-09-16-design-merge-audit.md` §10 第 7 项（用户 2026-09-16 明确指示「补充第7项（为线A补挂载点）」）
- 病灶（设计 §0.2 自陈）：「8 个端点**等挂载方统一 add**，**挂载方一直没来**」——线A 全链路在 `src/` 下零生产触发点
- 成功判据：`integration-poll` 定时器与 `POST /api/integration/webhook/:provider` 均能真实驱动同步内核（`createSyncEngine.runOnce`），且默认信任档 L1（只读）下不产生任何写入

## §0 红线（本计划不可越）

| # | 红线 | 判据 |
|---|---|---|
| 1 | **零调度层回归** | 不新增定时器；只在既有 `integration-poll` 分支内加同步分支（设计 §6.1 A-B6 明示） |
| 2 | **默认 L1 起步** | 无 `objects[]` 的既有 descriptor → 同步分支 no-op，行为与今天完全一致 |
| 3 | **无自动提升路径** | 有效信任档 = `min(descriptor.trust_level, config_store['sync-trust'].default_level)`——取更严者，拒绝 descriptor 单方面提权 |
| 4 | **写操作过决策第 0 闸** | L2/L3 每 run mint 一枚决策并落 `sync_cursor.decision_id`（设计 §15） |
| 5 | **绝对禁 DELETE** | 外部记录消失走 `external_deleted_at` 软标记（resolver 已实现，本计划不新增删除路径） |
| 6 | **不新增粒子类型** | `objects[].name` 映射目标仅取既有粒子类型（由 `sync-mappings` 声明） |
| 7 | **失败不静默** | 每 target 独立 catch → `emit('trace')` + `recordFailure`（G3） |
| 8 | **零硬编码** | descriptor / 映射 / 信任档全部来自 `config_store`（per-tenant） |

## §1 两处判断（须用户确认，已在实现中按保守侧落地）

### 判断 1：同步 provider 工厂与 enrich 适配器工厂**分离**

设计 §6.1 A-B3 原文写「`tenantInstances.KIND_FACTORY` 加两个 kind」，但两处契约**不同**：

| 工厂 | 契约方法 | 消费方 |
|---|---|---|
| `tenantInstances.KIND_FACTORY`（现状 3 kind） | `enrich(entity, fields, ctx)` + `coverageFields` | `runWaterfall`（富化瀑布） |
| 本计划新增 `src/sync/factory.js` | `verifyAuth()` / `discoverObjects()` / `readIncremental({cursor})` | 同步内核 `engine.runOnce` |

`src/sync/fxiaoke.js` 实现的是**同步 provider 契约**（无 `enrich`）。若按字面塞进 `KIND_FACTORY`，`runWaterfall` 会对无 `enrich` 的实例调用 → 富化链路回归。

**落地方式**：新增 `SYNC_PROVIDER_FACTORY`（`fxiaoke` / `neocrm` / `generic-rest`），**不动** `KIND_FACTORY`；A-B3 的业务目的（"客户无论用哪家套装都能接"）由同步工厂达成。设计 §7.1 A-N1 本身已把 `src/sync/` 定为"厂商无关同步内核"，故在 `src/sync/` 内建 provider 注册表符合设计自身架构。

### 判断 2：有效信任档取 `min(descriptor, global)`

设计 §9.2 有 tenant 级 `default_level`、§9.3 有 descriptor 级 `trust_level`，未规定优先级。
**落地方式**：取更严者（`L1 < L2 < L3`）。理由：`sync-trust.default_level` 作为租户总闸，descriptor 不可单方面越过；与项目既有「保守投影」惯例一致（E2：B/C 一律 HIGH）。两者不一致时 `emit('trace','sync-trust-clamped')` 留痕，使意图可观测而非静默。

## §2 任务结构（6 Task）

### Task 1：同步 provider 工厂 `src/sync/factory.js`（新建）

**Files:** New `src/sync/factory.js`；Test `test/sync/factory.test.js`

- [x] **Step 1: 写失败测试**

```js
// test/sync/factory.test.js
import { describe, it, expect } from 'vitest';
import { SYNC_PROVIDER_FACTORY, createGenericRestSyncProvider } from '../../src/sync/factory.js';

describe('sync provider factory（同步 provider 工厂）', () => {
  it('含 fxiaoke / neocrm / generic-rest 三种 kind', () => {
    expect(Object.keys(SYNC_PROVIDER_FACTORY).sort()).toEqual(['fxiaoke', 'generic-rest', 'neocrm']);
  });
  it('产出的 provider 满足同步契约四方法（verifyAuth/discoverObjects/readIncremental）', () => {
    const p = createGenericRestSyncProvider({ id: 'x', endpoint: 'https://example.com/api' });
    expect(typeof p.verifyAuth).toBe('function');
    expect(typeof p.discoverObjects).toBe('function');
    expect(typeof p.readIncremental).toBe('function');
    expect(p.kind).toBe('generic-rest');
  });
  it('generic-rest：无 endpoint → verifyAuth fail（fail-closed，零请求）', async () => {
    const p = createGenericRestSyncProvider({ id: 'x' });
    const r = await p.verifyAuth();
    expect(r.ok).toBe(false);
  });
  it('generic-rest：注入 __fetch → readIncremental 按 since_field 组装查询并返回 rows+cursor', async () => {
    const calls = [];
    const p = createGenericRestSyncProvider({
      id: 'x', endpoint: 'https://e.com/list', token: 'tk',
      objects: [{ name: 'AccountObj', since_field: 'last_modified_time', id_field: '_id' }],
      __fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ data: [{ _id: 'a1', name: '客户A', last_modified_time: '2026-09-16T01:00:00Z' }] }) }; },
    });
    const r = await p.readIncremental({ object: 'AccountObj', cursor: '2026-09-16T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.cursor).toBe('2026-09-16T01:00:00Z');  // 游标推进到本批最大 since
    expect(calls[0].url).toContain('last_modified_time');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tk');
  });
  it('generic-rest：无 credentials → verifyAuth fail（凭据不出口，不进日志）', async () => {
    const p = createGenericRestSyncProvider({ id: 'x', endpoint: 'https://e.com' });
    expect((await p.verifyAuth()).ok).toBe(false);
  });
});
```

- [x] **Step 2: 运行确认红**

Run: `npx vitest run test/sync/factory.test.js`
Expected: FAIL（`src/sync/factory.js` 不存在）

- [x] **Step 3: 实现**

```js
// src/sync/factory.js — 同步 provider 工厂（kind → 同步 provider 实例）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B3 + §9.3
// ⚠ 与 connectors/discovery/tenantInstances.js:9 的 KIND_FACTORY **刻意分离**：
//   那边是 enrich 适配器契约（enrich + coverageFields，供 runWaterfall）；
//   这边是同步 provider 契约（verifyAuth/discoverObjects/readIncremental，供 sync engine）。
//   两者混用会让 runWaterfall 调到无 enrich 的实例（见本计划 §1 判断 1）。
import { createFxiaokeProvider } from './fxiaoke.js';

// 通用 REST 同步 provider：零租户代码，差异全在 descriptor（endpoint / objects[] / 凭据）
export function createGenericRestSyncProvider(cfg = {}) {
  const { endpoint, token, objects = [] } = cfg;
  const cred = cfg.credentials || null;
  const authToken = token || (typeof cred === 'string' ? cred : cred?.token);
  const doFetch = cfg.__fetch || ((url, opts) => fetch(url, opts));

  async function verifyAuth() {
    if (!endpoint) return { ok: false, error: 'endpoint_missing' };
    if (!authToken) return { ok: false, error: 'credentials_missing' }; // fail-closed，零请求
    return { ok: true };
  }

  async function discoverObjects() {
    const a = await verifyAuth();
    if (!a.ok) return { ok: false, error: a.error };
    return { ok: true, objects: objects.map((o) => ({ name: o.name, label: o.label || o.name })) };
  }

  // 增量：按 since_field 游标查询；游标推进到本批最大 since（无新记录则保持原游标）
  async function readIncremental({ object, cursor = null } = {}) {
    const a = await verifyAuth();
    if (!a.ok) return { ok: false, error: a.error, rows: [], cursor };
    const def = objects.find((o) => o.name === object);
    if (!def) return { ok: false, error: `object_not_declared: ${object}`, rows: [], cursor };
    const since = def.since_field || 'updated_at';
    const url = `${endpoint}?object=${encodeURIComponent(object)}&${since}=${encodeURIComponent(cursor || '')}`;
    try {
      const resp = await doFetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!resp.ok) return { ok: false, error: `http_${resp.status}`, rows: [], cursor };
      const j = await resp.json();
      const rows = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
      const maxSince = rows.reduce((m, r) => {
        const v = r?.[since];
        return v && String(v) > String(m || '') ? v : m;
      }, null);
      return { ok: true, rows, cursor: maxSince || cursor };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), rows: [], cursor };
    }
  }

  return { kind: 'generic-rest', verifyAuth, discoverObjects, readIncremental };
}

export const SYNC_PROVIDER_FACTORY = {
  fxiaoke: createFxiaokeProvider,
  // 自研 / 其它套装：generic-rest 覆盖（设计 §6.1 A-B3「自研 CRM 用 generic-rest 覆盖」）
  neocrm: createGenericRestSyncProvider,
  'generic-rest': createGenericRestSyncProvider,
};
```

- [x] **Step 4: 运行确认绿**

Run: `npx vitest run test/sync/factory.test.js` → Expected: PASS(5)

### Task 2：挂载层 `src/sync/mount.js`（新建）

**Files:** New `src/sync/mount.js`；Test `test/sync/mount.test.js`

职责：把 `config_store` 描述符 → 同步 provider 实例 → 引擎运行，供定时器与 webhook 两个生产触发点复用。

- [x] **Step 1: 写失败测试**

```js
// test/sync/mount.test.js
import { describe, it, expect, vi } from 'vitest';
import { normalizeSyncMappings, loadTenantSyncTargets, runTenantSyncOnce, handleObjectChanged } from '../../src/sync/mount.js';

const designShape = {
  version: 1,
  mappings: [{
    object: 'AccountObj', particle_type: 'CRM_ACCOUNT', direction: 'in',
    identity: { external_id_field: '_id', since_field: 'last_modified_time' },
    fields: [{ external: 'name', particle: 'name', type: 'string' }],
  }],
};

describe('normalizeSyncMappings（设计形状 §9.1 ↔ 实现形状 mapping.js 兼容）', () => {
  it('设计形状（mappings[] + fields[].external）→ mapping.js 可用形状（fields[].ext）', () => {
    const m = normalizeSyncMappings(designShape);
    expect(m.AccountObj.particle_type).toBe('CRM_ACCOUNT');
    expect(m.AccountObj.fields[0]).toEqual({ ext: 'name', particle: 'name', type: 'string' });
  });
  it('实现形状（对象字典 + fields[].ext）原样通过（零回归）', () => {
    const impl = { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] } };
    expect(normalizeSyncMappings(impl).AccountObj.fields[0].ext).toBe('name');
  });
  it('空/非法输入 → 空对象（fail-closed，不抛）', () => {
    expect(normalizeSyncMappings(null)).toEqual({});
    expect(normalizeSyncMappings({ version: 1 })).toEqual({});
  });
});

describe('loadTenantSyncTargets（descriptor → 同步目标）', () => {
  const readConfig = async (key) => {
    if (key === 'integration-providers') return { value: [
      { id: 'fx-1', kind: 'fxiaoke', enabled: true, trust_level: 'L3',
        objects: [{ name: 'AccountObj', direction: 'in', cadence_min: 30, mapping_ref: 'AccountObj' }] },
      { id: 'off', kind: 'fxiaoke', enabled: false, objects: [{ name: 'X', direction: 'in' }] },
      { id: 'no-obj', kind: 'generic-rest', enabled: true, endpoint: 'https://e.com' }, // 无 objects[] → 跳过
      { id: 'bad-kind', kind: 'unknown-xyz', enabled: true, objects: [{ name: 'X', direction: 'in' }] }, // 未知 kind → 跳过
      { id: 'out-only', kind: 'generic-rest', enabled: true, endpoint: 'https://e.com',
        objects: [{ name: 'Y', direction: 'out' }] }, // 仅出向 → 不产生拉取目标
    ] };
    if (key === 'sync-trust') return { value: { default_level: 'L1' } };
    return null;
  };

  it('仅启用 + 有入向 objects + kind 受支持者成为目标', async () => {
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig, resolveCredentials: async () => ({}), factories: { fxiaoke: () => ({ kind: 'fxiaoke' }), 'generic-rest': () => ({ kind: 'generic-rest' }) } });
    expect(t.map((x) => x.id)).toEqual(['fx-1']);
    expect(t[0].objects).toHaveLength(1);
  });

  it('有效信任档取 min(descriptor, global)：descriptor L3 + global L1 → L1（无自动提权）', async () => {
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig, resolveCredentials: async () => ({}), factories: { fxiaoke: () => ({ kind: 'fxiaoke' }) } });
    expect(t[0].trustLevel).toBe('L1');
  });

  it('descriptor L2 + global L3 → L2（取更严者）', async () => {
    const rc = async (k) => (k === 'integration-providers'
      ? { value: [{ id: 'a', kind: 'fxiaoke', enabled: true, trust_level: 'L2', objects: [{ name: 'O', direction: 'in' }] }] }
      : { value: { default_level: 'L3' } });
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig: rc, resolveCredentials: async () => ({}), factories: { fxiaoke: () => ({ kind: 'fxiaoke' }) } });
    expect(t[0].trustLevel).toBe('L2');
  });

  it('读配置失败 → 空数组（fail-closed，定时器不炸）', async () => {
    const t = await loadTenantSyncTargets({ tenantId: 't1', readConfig: async () => { throw new Error('db down'); }, resolveCredentials: async () => ({}), factories: {} });
    expect(t).toEqual([]);
  });
});

describe('runTenantSyncOnce（L1 只读 / L2 入库 + 决策 / 失败不静默）', () => {
  const mkEngineDeps = (over = {}) => ({
    createEngine: vi.fn(() => ({ runOnce: vi.fn(async () => ({ ok: true, read: 2, created: 2, readOnly: false })) })),
    pool: {}, readConfig: async () => ({ value: {} }), mintDecision: vi.fn(async () => ({ decisionId: 'dec-1' })),
    emit: vi.fn(), recordFailure: vi.fn(), ...over,
  });

  it('L1：runOnce 被调用且不 mint 决策（只读观察期）', async () => {
    const deps = mkEngineDeps();
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [{ id: 'a', kind: 'fxiaoke', provider: {}, objects: [{ name: 'O', direction: 'in' }], trustLevel: 'L1' }], deps });
    expect(out.runs).toBe(1);
    expect(deps.mintDecision).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith('trace', 'sync-run-done', expect.objectContaining({ tenant_id: 't1', object: 'O', trust_level: 'L1' }));
  });

  it('L2：每 run mint 一枚决策并透传 decisionId（第 0 闸）', async () => {
    const runOnce = vi.fn(async () => ({ ok: true, created: 1 }));
    const deps = mkEngineDeps({ createEngine: vi.fn(() => ({ runOnce })) });
    await runTenantSyncOnce({ tenantId: 't1', targets: [{ id: 'a', kind: 'fxiaoke', provider: {}, objects: [{ name: 'O', direction: 'in' }], trustLevel: 'L2' }], deps });
    expect(deps.mintDecision).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ object: 'O', tenantId: 't1', decisionId: 'dec-1' }));
  });

  it('单 target 抛错 → emit trace + recordFailure，其余 target 继续（不静默、不传染）', async () => {
    const deps = mkEngineDeps({
      createEngine: vi.fn()
        .mockImplementationOnce(() => ({ runOnce: async () => { throw new Error('boom'); } }))
        .mockImplementationOnce(() => ({ runOnce: async () => ({ ok: true }) })),
    });
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [
      { id: 'bad', kind: 'fxiaoke', provider: {}, objects: [{ name: 'O1', direction: 'in' }], trustLevel: 'L1' },
      { id: 'good', kind: 'fxiaoke', provider: {}, objects: [{ name: 'O2', direction: 'in' }], trustLevel: 'L1' },
    ], deps });
    expect(deps.recordFailure).toHaveBeenCalledWith('sync-run-failed', expect.any(Error));
    expect(out.runs).toBe(2);
    expect(out.errors).toBe(1);
  });

  it('出向 object 不触发拉取（direction=out 走回写通道，非本函数）', async () => {
    const deps = mkEngineDeps();
    const out = await runTenantSyncOnce({ tenantId: 't1', targets: [{ id: 'a', kind: 'fxiaoke', provider: {}, objects: [{ name: 'O', direction: 'out' }], trustLevel: 'L1' }], deps });
    expect(out.runs).toBe(0);
  });
});

describe('handleObjectChanged（A-B5 单记录事件路由）', () => {
  it('按 event.object 路由到内核 upsert（不经富化瀑布）', async () => {
    const upsert = vi.fn(async () => ({ created: true, particle_id: 'p1' }));
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj',
      row: { _id: 'a1', name: '客户A' },
      deps: { mappings: { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] } },
        createResolver: () => ({ upsert }), readConfig: async () => ({ value: { default_level: 'L2' } }) },
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'a1', particleType: 'CRM_ACCOUNT', object: 'AccountObj' }));
  });

  it('未声明映射的 object → fail-closed 拒绝（不越权建粒子）', async () => {
    const r = await handleObjectChanged({ tenantId: 't1', provider: 'fxiaoke', object: 'UnknownObj', row: { id: 'x' },
      deps: { mappings: {}, readConfig: async () => ({ value: { default_level: 'L2' } }) } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('object_not_mapped');
  });

  it('默认 L1（只读）→ 事件不写库（与轮询同口径）', async () => {
    const upsert = vi.fn();
    const r = await handleObjectChanged({ tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj', row: { id: 'a1' },
      deps: { mappings: { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] } },
        createResolver: () => ({ upsert }), readConfig: async () => ({ value: { default_level: 'L1' } }) } });
    expect(r.ok).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: 运行确认红**

Run: `npx vitest run test/sync/mount.test.js`

- [x] **Step 3: 实现**

```js
// src/sync/mount.js — 线A 挂载层（把同步内核装到生产触发点）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B5/A-B6 + §9.1/§9.3 + §13 T06
// 触发点（仅两处，零新增定时器）：
//   ① src/scheduler/timers.js ⑩ integration-poll 的增量分支（A-B6）
//   ② src/http/connectorRouter.js POST /api/integration/webhook/:provider 的对象变化路由（A-B5）
export const SYNC_TRUST_ORDER = ['L1', 'L2', 'L3'];

// —— 有效信任档：min(descriptor, global)。取更严者，descriptor 不可单方面提权（§1 判断 2）——
export function effectiveTrustLevel(descriptorLevel, globalLevel) {
  const d = SYNC_TRUST_ORDER.includes(descriptorLevel) ? descriptorLevel : null;
  const g = SYNC_TRUST_ORDER.includes(globalLevel) ? globalLevel : 'L1'; // 缺省即最严
  if (!d) return g;
  return SYNC_TRUST_ORDER[Math.min(SYNC_TRUST_ORDER.indexOf(d), SYNC_TRUST_ORDER.indexOf(g))];
}

// —— 声明式映射：兼容设计形状 §9.1（mappings[] + fields[].external）与实现形状（fields[].ext）——
// 兼容而非替换：mapping.js 既有形状不被破坏（零回归），设计形状可直落 config_store
export function normalizeSyncMappings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const list = Array.isArray(raw.mappings) ? raw.mappings : null;
  if (!list) {
    // 实现形状：{ [object]: { particle_type, fields:[{ext,particle}] } }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'version') continue;
      if (!v || typeof v !== 'object' || !Array.isArray(v.fields)) continue;
      out[k] = { ...v, fields: v.fields.map((f) => ({ ...f, ext: f.ext ?? f.external })) };
    }
    return out;
  }
  // 设计形状：{ version, mappings: [{ object, particle_type, direction, identity, fields:[{external,particle}] }] }
  const out = {};
  for (const m of list) {
    if (!m?.object) continue;
    if (m.direction && m.direction !== 'in') continue; // 出向映射由回写 Action 消费，不进读入表
    out[m.object] = {
      particle_type: m.particle_type,
      identity: m.identity || null,
      fields: (m.fields || []).map((f) => ({ ...f, ext: f.external })),
      filters: m.filters || null,
    };
  }
  return out;
}

// —— descriptor → 同步目标（仅 enabled + 有入向 objects + kind 受支持）——
export async function loadTenantSyncTargets({ tenantId = 'system', readConfig, resolveCredentials, factories = {} } = {}) {
  try {
    const row = await readConfig('integration-providers', { tenantId });
    const descs = Array.isArray(row?.value) ? row.value : [];
    const trustRow = await readConfig('sync-trust', { tenantId });
    const globalLevel = trustRow?.value?.default_level || 'L1';
    const creds = resolveCredentials ? await resolveCredentials({ tenantId, providerIds: descs.map((d) => d.id) }).catch(() => ({})) : {};
    const out = [];
    for (const d of descs) {
      if (!d?.enabled) continue;
      const factory = factories[d.kind];
      if (!factory) continue; // 未知 kind 跳过（不抛，防扫描中断）
      const inbound = (Array.isArray(d.objects) ? d.objects : []).filter((o) => o?.name && (!o.direction || o.direction === 'in'));
      if (!inbound.length) continue; // 无 objects[] → no-op（既有 descriptor 零行为变化）
      out.push({
        id: d.id, kind: d.kind,
        provider: factory({ ...d, credentials: (creds && creds[d.id]) || d.credentials || null }),
        objects: inbound,
        trustLevel: effectiveTrustLevel(d.trust_level, globalLevel),
        descriptorLevel: d.trust_level || null,
      });
    }
    return out;
  } catch {
    return []; // fail-closed：读配置失败 → 无目标（定时器不炸）
  }
}

// —— per-tenant 一轮同步（A-B6 分支体；零新增定时器）——
export async function runTenantSyncOnce({ tenantId = 'system', targets = [], deps = {} } = {}) {
  const {
    createEngine, pool, createResolver, createCursor, createTrust,
    mintDecision, emit, recordFailure, decisionScene = 'integration-sync',
  } = deps;
  let runs = 0, errors = 0, created = 0, updated = 0, skipped = 0, conflicted = 0, writeback = 0;
  for (const t of targets) {
    for (const obj of t.objects) {
      runs++;
      try {
        // 有效信任档已由 loadTenantSyncTargets 取 min；这里作为定值注入内核
        const trust = { level: async () => t.trustLevel, canWriteBack: async () => t.trustLevel === 'L3' };
        // 第 0 闸：L2/L3 每 run 一枚决策（§15「批量入库：一次 run mint 一个决策」）；L1 只读不铸
        let decisionId = null;
        if (t.trustLevel === 'L2' || t.trustLevel === 'L3') {
          const d = await (mintDecision || (async () => ({ decisionId: null })))(decisionScene, { tenantId, provider: t.kind, object: obj.name });
          decisionId = d?.decisionId || null;
        }
        const engine = createEngine({ tenantId, target: t, object: obj, trust, pool, createResolver, createCursor, decisionId });
        const r = await engine.runOnce({ object: obj.name, tenantId, decisionId });
        created += r?.created || 0; updated += r?.updated || 0;
        skipped += r?.skipped || 0; conflicted += r?.conflicted || 0; writeback += r?.writeback || 0;
        emit && emit('trace', 'sync-run-done', {
          tenant_id: tenantId, provider: t.id, object: obj.name,
          trust_level: t.trustLevel, read: r?.read || 0, created: r?.created || 0,
          updated: r?.updated || 0, skipped: r?.skipped || 0, decision_id: decisionId,
        });
      } catch (err) {
        // G3 不静默：单 target/object 失败留痕，不传染其它目标
        errors++;
        emit && emit('trace', 'sync-run-failed', { tenant_id: tenantId, provider: t.id, object: obj.name, error: String(err?.message || err) });
        recordFailure && recordFailure('sync-run-failed', err);
      }
    }
  }
  return { runs, errors, created, updated, skipped, conflicted, writeback };
}

// —— A-B5：单条对象变化事件 → 内核 upsert（admin/sysadmin 闸由路由层把守）——
export async function handleObjectChanged({ tenantId = 'system', provider, object, row = {}, deps = {} } = {}) {
  const { mappings = {}, readConfig, createResolver, pool, mintDecision, emit } = deps;
  const def = mappings[object];
  if (!def?.particle_type) return { ok: false, error: 'object_not_mapped' }; // fail-closed：不越权建粒子
  const trustRow = await (readConfig || (async () => null))('sync-trust', { tenantId }).catch(() => null);
  const level = trustRow?.value?.default_level || 'L1';
  const extId = row.id || row.external_id || row[def.identity?.external_id_field];
  if (!extId) return { ok: false, error: 'external_id_missing' };
  if (level === 'L1') return { ok: true, readOnly: true, externalId: extId }; // 只读观察期：事件不写库
  let decisionId = null;
  if (mintDecision) decisionId = (await mintDecision('integration-event', { tenantId, provider, object }).catch(() => ({})))?.decisionId || null;
  const resolver = (createResolver || (() => import('./resolver.js').then((m) => m.createEntityResolver({ pool }))))({ pool });
  const resolvedResolver = resolver?.then ? await resolver : resolver;
  const u = await resolvedResolver.upsert({
    tenantId, provider, object, externalId: extId, particleType: def.particle_type, payload: def.fields.reduce((acc, f) => {
      const v = row[f.ext];
      if (v !== undefined && v !== null) acc[f.particle] = v;
      return acc;
    }, {}),
  });
  emit && emit('trace', 'sync-event-upsert', { tenant_id: tenantId, provider, object, external_id: extId, created: !!u?.created, decision_id: decisionId });
  return { ok: true, readOnly: false, created: !!u?.created, particle_id: u?.particle_id, decisionId };
}
```

- [x] **Step 4: 运行确认绿** → `npx vitest run test/sync/mount.test.js`

### Task 3：`engine.runOnce` 接受可选 `decisionId`（透传 `sync_cursor.decision_id`）

**Files:** Edit `src/sync/engine.js:7,20,45`；Test 追加 `test/sync/engine.test.js`

- [x] **Step 1: 测试**（追加）——`runOnce({object,tenantId,decisionId})` 时 `cursor.set` 收到该 `decisionId`；不传时为 `null`（零回归）
- [x] **Step 2: 实现**（3 处，纯附加）

```js
async function runOnce({ object, tenantId = 'system', decisionId = null } = {}) {   // ← 新增可选参数
  ...
  await cursor.set({ tenantId, provider: ..., object, counts, status: 'ok', error: null, decisionId });           // 只读分支
  await cursor.set({ tenantId, provider: ..., object, counts, status: 'ok', error: null, cursor: inc.cursor, decisionId });
```

### Task 4：`integration-poll` 增量分支（A-B6）

**Files:** Edit `src/scheduler/timers.js:123-147`；Test 追加 `test/external-integration.test.js`

- [x] **Step 1: 测试**——`runIntegrationPollOnce` 注入 `loadSyncTargets` + `runSync` 时二者被调用一次/租户；未注入时不报错（零回归）；`VITEST` 护栏不生效于纯函数（保持既有语义）
- [x] **Step 2: 实现**——在既有租户循环**末尾**（`recordTokens` 之前）追加：

```js
// A-B6 增量分支（T06）：按 descriptor objects[].cursor 拉增量 → 内核 upsert。
//   零新增定时器、零调度框架改动；未配置 objects[] 时 loadSyncTargets 返回空 → no-op（零回归）
const targets = loadSyncTargets ? await loadSyncTargets({ tenantId: tid }).catch(() => []) : [];
if (targets.length) {
  const r = await runSync({ tenantId: tid, targets }).catch(() => null);
  if (r) emit && emit('trace', 'integration-poll-sync', { tenant_id: tid, runs: r.runs, errors: r.errors, created: r.created, updated: r.updated });
}
```

并在 `ensureTimers` 的 ⑩ 处注入真实实现（`loadSyncTargets` = `mount.loadTenantSyncTargets` + `SYNC_PROVIDER_FACTORY` + `resolveCredentials`；`runSync` = `mount.runTenantSyncOnce` + 引擎/解析器/游标/决策铸造）。

### Task 5：对象变化事件路由（A-B5）

**Files:** Edit `src/http/connectorRouter.js:11-21`；Test 追加 `test/external-integration.test.js`

- [x] **Step 1: 测试**——body 带 `event.object` → 走同步路由（`runSyncEvent` 被调用）；不带 → 保持既有 `conn-signal-lead-gen` 派发（**零回归**）；非 admin/sysadmin → 403（两路共用既有闸）
- [x] **Step 2: 实现**——`handleSignalWebhook` 顶部插入分支：

```js
// A-B5：对象变化事件（body.event.object 存在）→ 路由到同步内核 upsert，不经富化瀑布
if (body?.event?.object) {
  if (!runSyncEvent) return { status: 501, json: { error: 'sync_route_not_mounted' } };
  const r = await runSyncEvent({ tenantId: me.tenantId, provider, object: body.event.object, row: body.event.record || body.record || {} });
  return r?.ok ? { status: 200, json: { ok: true, provider, route: 'sync-upsert', ...r } }
               : { status: 400, json: { error: r?.error || 'sync upsert failed', result: r } };
}
```

（角色闸在函数首行已判，两路共用，不重复实现）

### Task 6：真库端到端冒烟 + 留痕

**Files:** New `scripts/smoke-line-a-mount.mjs`

- [x] **Step 1: 冒烟脚本**（真库 `crm_native`）：以 `mock` kind 目标走 `runTenantSyncOnce` → 断言 `crm.sync_cursor` 出现 `last_counts`、L1 下 `crm.external_ref` 行数**不变**、L2 下新增且二次幂等
- [x] **Step 2: 运行** `PGDATABASE=crm_native node scripts/smoke-line-a-mount.mjs`
- [x] **Step 3: 留痕**——审计报告 §10.3 追加执行记录；`.workbuddy/memory/2026-09-16.md` 追加

## §3 验收判据（缺一不可）

| # | 判据 | 证据 |
|---|---|---|
| 1 | `integration-poll` 与 webhook 两处均可驱动 `engine.runOnce` | 单测 + 真库冒烟 |
| 2 | 默认 L1 下**零写入**（`external_ref` 行数不变） | 真库冒烟断言 |
| 3 | 未配置 `objects[]` 的既有 descriptor → no-op | 单测（零回归） |
| 4 | L2 每 run 一枚决策且落 `sync_cursor.decision_id` | 单测 + 真库查询 |
| 5 | 失败非静默（trace + recordFailure）且不传染 | 单测 |
| 6 | 不新增定时器（`timerCount()` 不变） | `test/external-integration.test.js` 既有用例 |
| 7 | 全量 `test/sync` + `test/external-integration.test.js` 绿 | vitest 输出 |

---

## §4 执行结果（2026-09-16，已全部完成）

### 4.1 交付物

| 类型 | 文件 | 说明 |
| ---- | ---- | ---- |
| 新增 | `src/sync/factory.js` | 同步 provider 工厂（`fxiaoke` / `neocrm` / `generic-rest`），与 enrich `KIND_FACTORY` 刻意分离 |
| 新增 | `src/sync/mount.js` | 挂载层：`effectiveTrustLevel` / `normalizeSyncMappings` / `loadSyncMappings` / `loadTenantSyncTargets` / `runTenantSyncOnce` / `handleObjectChanged` |
| 新增 | `test/sync/factory.test.js` · `test/sync/mount.test.js` | 8 + 24 用例 |
| 新增 | `scripts/smoke-line-a-mount.mjs` | 真库端到端冒烟（4 断言） |
| 改写 | `src/scheduler/timers.js` | `runIntegrationPollOnce` 增 A-B6 增量分支（**零新增定时器**）+ `ensureTimers` ⑩ 注入真实装配 |
| 改写 | `src/http/connectorRouter.js` | `handleSignalWebhook` 增 A-B5 事件路由（未接线返回 501，不静默降级）+ `createConnectorRouter` 缺省装配 |
| 改写 | `src/sync/engine.js` | ① `runOnce` 接受可选 `decisionId` → `sync_cursor.decision_id`；② **`readIncremental` 补传 `object`**（见 4.3） |
| 改写 | `src/sync/mapping.js` | `apply` 返回 `external_id`（按 `identity.external_id_field` 解析，见 4.3） |
| 追加用例 | `test/external-integration.test.js`（A-B5 5 例 + A-B6 6 例）· `test/sync/engine.test.js`（+3）· `test/sync/mapping.test.js`（+2） | — |

### 4.2 验证证据

| 判据 | 结果 |
| ---- | ---- |
| `npx vitest run test/sync test/external-integration.test.js test/timers.test.js test/scheduler test/llm/risk-scan-wiring.test.js` | **23 文件 / 146 用例全绿** |
| `node scripts/smoke-line-a-mount.mjs`（真库 `crm_native`） | **5/5 OK**：① L1 零写入（`external_ref` 0→0）且 cursor 留痕 `read=2` ② L2 `created=4`、`external_ref` 0→4、`particles` 0→4、两对象 `decision_id` 均落锚点 ③ 二次幂等 `created=0`、0 新粒子 ④ 无决策时 `errors=2` 且零写入（fail-closed） ⑤ **A-B5 事件路由**：L1 只读 / L2 无决策 `decision_required` 拒写 / L2 有决策 `created=true` |
| 未新增定时器 | `git diff -- src/scheduler/timers.js` 中 `timers.set(` 新增 **0** |
| 依赖闭包可解析 | `mount.js` / `factory.js` / `autonomyEngine.requireDecision` / `configStore` / `credentialVault` / `db.pool` 全部 OK |
| 发布守门 | `node scripts/verify-release-source.mjs` → **启动链路自洽，可发布**（13 处告警全在 `test/`，均为既有，无本计划新增） |

### 4.3 ⚠ 实施中发现并修复的**三处**真实缺口（**不在原计划范围，属"接线才暴露"的潜伏缺陷**）

三处都不是新写错，而是**线A 从未接线，所以从未被运行路径覆盖**：

| # | 缺口 | 证据 | 影响（接线前不可见） | 修法 |
| - | ---- | ---- | ------------------ | ---- |
| **G1** | `engine.runOnce` 调 `provider.readIncremental({cursor})` **未传 `object`**（`engine.js:16`） | 真库冒烟首跑 `read=0`（`data[undefined]`） | 凡"按对象拉取"的 provider（`generic-rest`、纷享真实查询）收到 `undefined` → **永远 0 行、静默空转**，且 `last_status='ok'` 让它看起来完全健康（典型假绿） | `readIncremental({ object, cursor })`；新增用例锁死（`test/sync/engine.test.js`） |
| **G2** | `engine` 用硬编码 `row.id \|\| row.external_id` 取外部 id，**忽略映射声明的 `identity.external_id_field`** | 真库冒烟次跑 `created=0`、`skipped` 全量（纷享 `_id` 形状） | 设计 §9.1 明写 `identity.external_id_field: "_id"`，但实现从不读它 → **所有行被判 skipped**，同步"成功"却零入库 | `mapping.apply` 返回 `external_id`（声明优先，回退 `row.id`/`row.external_id`），`engine` 改用 `m.external_id`；`test/sync/mapping.test.js` +2 例 |
| **G3** | A-B5 缺省装配（`connectorRouter.js`）**未注入 `mintDecision`**，且 `handleObjectChanged` 用可选形态 `if (mintDecision)` 而非 fail-closed | `connectorRouter.js` 装配仅注入 `readConfig`/`pool`/`mappings`；`mount.js` 原文无 `decision_required` 分支 | **L2/L3 写路径可无决策落库**（第 0 闸被静默绕过）。测试三条 A-B5 用例**全部注入 `runSyncEvent` 替身** → 缺省装配路径**零覆盖**，102 例全绿仍不可见 | 装配补 `mintDecision`（走 `autonomy.requireDecision`，与轮询同源）+ `emit`；`handleObjectChanged` 补 fail-closed（缺注入视同铸不出）；`test/sync/mount.test.js` +2 例；冒烟 +⑤ |

> **方法论价值**：G1/G2 都**通过了全部既有单测**（`test/sync` 11 文件原 53 例全绿），因为单测注入的都是 `{id: ...}` 形状的 mock 行且从不校验 `object` 入参。**只有把链路真正接上生产触发点、用设计形状的配置跑一次真库，缺口才暴露**——这正是第 7 项"补挂载点"不可用"声明模块就绪"替代的原因。
>
> **G3 比 G1/G2 更隐蔽一层**：它不是"接线才暴露"，而是"**接了线也暴露不了**"——`connectorRouter` 的**缺省装配路径**没有任何测试或冒烟覆盖（三条用例全用 `runSyncEvent` 替身，测的是替身而非真装配）。此类缺口的判据不是"跑一次真库"，而是**"缺省装配分支是否存在独立覆盖"**：凡装配函数 `deps`/参数以缺省值注入生产依赖（`||` 缺省分支），该分支必须有专门用例。同族前例：`adoption.test.js` 用假 store 掩盖 `setStatus` 静默丢字段。
> **修正方向铁律**：同一红线在多处实现时，**口径须逐字一致**（G3 的两处差异即"轮询 fail-closed vs 事件可选注入"），否则保守处的闸门会被宽松处的旁路绕过。

### 4.4 与计划的偏差（已按保守侧落地，须用户确认）

| # | 计划原定 | 实际落地 | 理由 |
| - | ------- | ------- | ---- |
| 1 | 设计 §6.1 A-B3 字面写「`tenantInstances.KIND_FACTORY` 加两个 kind」 | 落在 **`src/sync/factory.js`** 的独立 `SYNC_PROVIDER_FACTORY`，**未动** `connectors/discovery/tenantInstances.js` | 两侧契约不同（enrich vs sync）；混入会让 `runWaterfall` 调到无 `enrich` 的实例 → 富化链路回归。**并行会话已在设计附录 E.2 独立判定为「设计描述精度不足，不是实现偏离」并留更正记录** |
| 2 | 有效信任档取值未在设计中规定优先级 | `min(descriptor, global)` + descriptor 声明值留痕（`descriptorLevel`） | 无自动提权；`sync-trust.default_level` 作为租户总闸不可被 descriptor 越权（与项目「保守投影」惯例一致） |
| 3 | 计划未提"决策铸不出"分支 | 追加 **fail-closed**：L2/L3 铸不出决策即拒绝本轮（trace + recordFailure） | 守「写无决策不落库」；否则第 0 闸可被"降级为 null 后照写"绕过 |

### 4.5 当前生产实况（**不得误读为"已接入客户 CRM"**）

- 接线已闭合：`integration-poll`（6h 间隔）与 `POST /api/integration/webhook/:provider` 两处触发点均已可达同步内核。
- **但 `crm.config_store` 的 `integration-providers` / `sync-mappings` / `sync-trust` 三键均未配置** → 无 `objects[]` 描述符 → 两处触发点**均为 no-op**。
- 即：**"已把线A 接上生产触发点"为真；"已有客户数据在同步"为假**。对外表述约束见设计 §0.5 与附录 D.2 / E.1。
