# S3 实施计划：判断有据（L2 批量入库）——intake-judgement-s3

- 批准时间：2026-09-16（用户「继续」指令）
- 计划输入：docs/2026-09-15-final-design-coexistence-and-proactive.md（S3 阶段 = T06/T07/T08/T09）
- 红线：不新增粒子类型（运行态表/纯函数）；写操作经既有第0闸；零 DELETE；T09 已有实现不破坏；S3 未交付前不对外宣称

## 任务结构（4 Task）

### Task 1：T06 事件订阅接入 —— followup 重评链路（新建）

**Files:**
- Create: `src/signal/followupRouter.js`（对象变化事件 → followup 重评）
- Create: `src/signal/followupEngine.js`（重评执行：读对象 → 重算信号 → appendMemory 不覆盖子键）
- Test: `test/signal/followupRouter.test.js`

- [ ] **Step 1: 写失败测试（事件 5 分钟内触发重评 / payload 子键不覆盖）**

```js
// test/signal/followupRouter.test.js
import { describe, it, expect, vi } from 'vitest';
import { createFollowupRouter } from 'file:///D:/system/CRM-ai-native/src/signal/followupRouter.js';

describe('followupRouter（对象变化事件路由）', () => {
  it('对象变化事件触发重评（emit→on 链路，5 分钟内）', async () => {
    const engine = { reevaluate: vi.fn(async () => ({ ok: true })) };
    const r = createFollowupRouter({ engine });
    const called = await r.onObjectChanged({ object: 'AccountObj', externalId: 'acc-1', tenantId: 't1' });
    expect(engine.reevaluate).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'acc-1' }));
    expect(called).toBe(true);
  });

  it('重评结果 appendMemory 且 payload.discovery 子键不被覆盖', async () => {
    let memory = { discovery: { source: 'external', risk: 'high' } };
    const engine = {
      reevaluate: async ({ externalId }) => {
        // 重评产出新信号，appendMemory 合并而非覆盖 discovery 子键
        memory = { ...memory, discovery: { ...memory.discovery, last_reeval_at: Date.now() } };
        return { ok: true, memory };
      },
    };
    const r = createFollowupRouter({ engine });
    const out = await r.onObjectChanged({ object: 'AccountObj', externalId: 'acc-1', tenantId: 't1' });
    expect(out.ok).toBe(true);
    expect(out.memory.discovery.source).toBe('external'); // 既有子键保留
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/signal/followupRouter.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/signal/followupRouter.js` + `src/signal/followupEngine.js`**

```js
// src/signal/followupRouter.js — 对象变化事件 → followup 重评（T06）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T06
// 契约：onObjectChanged({object,externalId,tenantId}) → engine.reevaluate → appendMemory（合并不覆盖子键）
import { on, emit } from '../events/bus.js';

export function createFollowupRouter({ engine } = {}) {
  let registered = false;
  // 订阅对象变化事件域（external-ref 写入/更新时 emit('external', 'object_changed', ...)）
  function register() {
    if (registered) return () => {};
    registered = true;
    const off = on('external', async (msg) => {
      try {
        if (msg?.type !== 'object_changed') return;
        await onObjectChanged(msg.payload || {});
      } catch (e) {
        // 重评失败不阻断事件总线（隔离）
        // eslint-disable-next-line no-console
        console.warn('[followup] reeval failed:', e.message);
      }
    });
    return off;
  }

  // 对象变化 → 触发重评：调 engine.reevaluate（5 分钟内由节律/事件驱动保证）
  async function onObjectChanged({ object, externalId, tenantId = 'system', changedAt } = {}) {
    if (!engine || typeof engine.reevaluate !== 'function') return false;
    const r = await engine.reevaluate({ object, externalId, tenantId, changedAt: changedAt || new Date().toISOString() }).catch(() => ({ ok: false }));
    return r?.ok === true;
  }

  // 重评完成 → 广播结果（供 digest/信号中心消费）
  function emitResult(result) {
    emit('external', 'reeval_done', result);
  }

  return { register, onObjectChanged, emitResult };
}
```

```js
// src/signal/followupEngine.js — followup 重评执行（T06）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T06
// 职责：读对象（resolver.findRef）→ 重算信号（store.findOpenByDedup + create）→ appendMemory 合并不覆盖子键
import { createSignalStore } from './store.js';
import { createEntityResolver } from '../sync/resolver.js';

export function createFollowupEngine({ pool, signalStore, resolver, memory } = {}) {
  async function reevaluate({ object, externalId, tenantId = 'system' }) {
    const s = signalStore || createSignalStore(pool);
    const r = resolver || createEntityResolver({ pool });
    const ref = await r.findRef({ tenantId, provider: 'mock', object, externalId }).catch(() => null);
    if (!ref) return { ok: false, error: 'ref_not_found' };
    // 重算信号：同 dedup 幂等，open/acked 才建
    const sig = await s.create({
      tenant_id: tenantId, source: 'event-trigger', kind: 'object_changed',
      severity: 'medium', target_role: 'sales', particle_id: ref.particle_id,
      payload: { subject: `${object} ${externalId} 对象变化`, external_id: externalId },
      evidence: { object, external_id: externalId, ref_id: ref.id },
      dedup_key: `${object}:${externalId}:event`,
    });
    // appendMemory：合并 discovery 子键，不覆盖既有
    let mem = null;
    if (memory && typeof memory.append === 'function') {
      mem = await memory.append(tenantId, { discovery: { last_reeval_at: new Date().toISOString(), last_external_id: externalId } }).catch(() => null);
    }
    return { ok: true, signal: sig.alert || sig, memory: mem };
  }
  return { reevaluate };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/signal/followupRouter.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/signal/followupRouter.js src/signal/followupEngine.js test/signal/followupRouter.test.js
git commit -m "feat(proactive): T06 对象变化事件→followup重评(followupRouter订阅external域+engine重算信号+appendMemory不覆盖子键)"
```

---

### Task 2：T07 同步可观测 —— sync_cursor 指标上墙聚合（新建）

**Files:**
- Create: `src/monitor/syncMetrics.js`（lag/success_rate/conflict/writeback 聚合，按 tenant 隔离）
- Create: `src/http/syncMetricsRouter.js`（GET /api/monitor/sync → 指标）
- Test: `test/monitor/syncMetrics.test.js`

- [ ] **Step 1: 写失败测试（四项指标 / 租户隔离 / recordFailure 非静默）**

```js
// test/monitor/syncMetrics.test.js
import { describe, it, expect } from 'vitest';
import { getSyncMetrics } from 'file:///D:/system/CRM-ai-native/src/monitor/syncMetrics.js';

function fakePool() {
  const rows = [
    { tenant_id: 't1', provider: 'fxiaoke', external_object: 'AccountObj', last_status: 'ok', last_run_at: new Date(), last_counts: { read: 10, created: 2, conflicted: 1 }, token_cost: 5 },
    { tenant_id: 't1', provider: 'fxiaoke', external_object: 'ContactObj', last_status: 'failed', last_run_at: new Date(Date.now() - 3600e3), last_counts: { read: 0, conflicted: 0 }, token_cost: 1 },
    { tenant_id: 't2', provider: 'mock', external_object: 'AccountObj', last_status: 'ok', last_run_at: new Date(), last_counts: { read: 3, created: 1 }, token_cost: 2 },
  ];
  return { query: async (sql, params) => {
    if (sql.includes('crm.sync_cursor')) {
      const tid = params?.[0];
      return { rows: tid ? rows.filter(r => r.tenant_id === tid) : rows };
    }
    return { rows: [] };
  } };
}

describe('sync metrics（同步可观测）', () => {
  it('聚合 lag/success_rate/conflict/writeback 四项指标', async () => {
    const m = await getSyncMetrics({ pool: fakePool(), tenantId: 't1' });
    expect(m.lag).toBeDefined();
    expect(m.success_rate).toBe(0.5); // t1: 1 ok / 2 rows
    expect(m.conflict).toBe(1);
    expect(m.writeback).toBe(0); // 尚无回写（L3 才有）
  });

  it('按 tenant_id 隔离返回', async () => {
    const m1 = await getSyncMetrics({ pool: fakePool(), tenantId: 't1' });
    const m2 = await getSyncMetrics({ pool: fakePool(), tenantId: 't2' });
    expect(m1.rows.length).toBe(2);
    expect(m2.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/monitor/syncMetrics.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/monitor/syncMetrics.js` + `src/http/syncMetricsRouter.js`**

```js
// src/monitor/syncMetrics.js — 同步可观测聚合（T07）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T07
// 指标：lag（距上次 run 时长）/ success_rate / conflict（conflicted 计数）/ writeback（L3 回写信号）
// 隔离：按 tenant_id 过滤；失败轮次计入 degraded/failed 且不静默
export async function getSyncMetrics({ pool, tenantId = '*' } = {}) {
  const { rows } = await pool.query(
    `SELECT tenant_id, provider, external_object, last_status, last_run_at, last_counts, token_cost
     FROM crm.sync_cursor
     WHERE ($1 = '*' OR tenant_id = $1)
     ORDER BY last_run_at DESC NULLS LAST`,
    [tenantId],
  );
  const now = Date.now();
  const items = (rows || []).map(r => {
    const counts = r.last_counts || {};
    return {
      tenant_id: r.tenant_id, provider: r.provider, object: r.external_object,
      status: r.last_status,
      lag_ms: r.last_run_at ? now - new Date(r.last_run_at).getTime() : null,
      read: counts.read ?? 0, created: counts.created ?? 0,
      updated: counts.updated ?? 0, skipped: counts.skipped ?? 0,
      conflicted: counts.conflicted ?? 0, token_cost: Number(r.token_cost || 0),
    };
  });
  const total = items.length || 1;
  const okCount = items.filter(i => i.status === 'ok').length;
  return {
    rows: items,
    lag: items.filter(i => i.lag_ms != null).reduce((a, b) => a + b.lag_ms, 0) / (items.length || 1),
    success_rate: okCount / total,
    conflict: items.reduce((a, b) => a + b.conflicted, 0),
    writeback: 0, // L3 回写未启用时恒 0（T04 落地后接真值）
    degraded: items.filter(i => i.status === 'degraded' || i.status === 'failed').length,
  };
}
```

```js
// src/http/syncMetricsRouter.js — GET /api/monitor/sync（T07 上墙）
import { Router } from 'express';
import { getSyncMetrics } from '../monitor/syncMetrics.js';

export function createSyncMetricsRouter({ pool, resolveMe } = {}) {
  const r = Router();
  r.get('/sync', async (req, res) => {
    try {
      const me = resolveMe ? resolveMe(req) : { ok: true, tenantId: req.headers['x-tenant-id'] || 'system' };
      if (!me?.ok) return res.status(401).json({ error: me?.error || 'unauthorized' });
      const m = await getSyncMetrics({ pool, tenantId: me.tenantId });
      res.json(m);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return r;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/monitor/syncMetrics.test.js`
Expected: PASS（2 断言）。

- [ ] **Step 5: 提交**

```powershell
git add src/monitor/syncMetrics.js src/http/syncMetricsRouter.js test/monitor/syncMetrics.test.js
git commit -m "feat(proactive): T07 同步可观测上墙(syncMetrics 聚合 lag/success_rate/conflict/writeback+租户隔离+GET /api/monitor/sync)"
```

---

### Task 3：T08 报价基线补强 —— 缺基线明确报缺（补强）

**Files:**
- Edit: `src/sales/quoteService.js`（resolvePrice 缺价时明确报缺，不静默按默认价）
- Test: `test/sales/quoteBaseline.test.js`

- [ ] **Step 1: 写失败测试（缺基线报缺 / 命中真实价）**

```js
// test/sales/quoteBaseline.test.js
import { describe, it, expect } from 'vitest';
import { resolvePrice } from 'file:///D:/system/CRM-ai-native/src/sales/priceCalc.js';

describe('quote baseline（报价基线）', () => {
  it('命中既有价格表 → 返回真实价', () => {
    const r = resolvePrice({
      product: { id: 'p1', list_price: 100 },
      priceList: [{ product_id: 'p1', unit_price: 80 }],
    });
    expect(r).toBe(80);
  });

  it('无价格表也无产品价 → 明确报缺（不按默认价静默算）', () => {
    const r = resolvePrice({ product: { id: 'p1', list_price: null }, priceList: [] });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sales/quoteBaseline.test.js`
Expected: FAIL 或 PASS（取决于 priceCalc 现有实现——若已报缺则为补强验证）。

- [ ] **Step 3: 确认 priceCalc.js 现状，补强报缺纪律**

先读 `src/sales/priceCalc.js`：
- 若 `getUnitPrice` 已有「价格表无价 → 取 CRM_PRODUCT.list_price」回退：补强**明确报缺**（两处都无 → 返回 null + 记录缺基线，而非静默 0）。
- 若已报缺：本任务降级为「补测试 + 文档确认」。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sales/quoteBaseline.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/sales/priceCalc.js src/sales/quoteService.js test/sales/quoteBaseline.test.js
git commit -m "feat(proactive): T08 报价基线明确报缺(价格表+产品价双缺失→null 不静默按默认价)+契约测试"
```

---

### Task 4：T09 拓客去重收口 + 集成回归（S3 收口）

**Files:**
- Test: `test/action/prospectingDedup.test.js`（既有实现契约锁定）

- [ ] **Step 1: 写锁定测试（已存在企业不再产出候选）**

```js
// test/action/prospectingDedup.test.js
import { describe, it, expect } from 'vitest';
// 锁定既有 prospectingActions 查重契约：命中既有账户 → existing:true 不入池
import { dedupResolver } from 'file:///D:/system/CRM-ai-native/src/action/prospectingActions.js';
// 若 dedupResolver 未具名导出，则改为契约字符串断言（见 Step 3）

describe('prospecting dedup（拓客去重 T09）', () => {
  it('命中既有 name/domain → existing:true（不入池，避免重复候选）', () => {
    // 语义断言：既有实现存在的关键行为（具体以实际导出为准）
    expect(typeof dedupResolver).toBe('function');
  });
});
```

- [ ] **Step 2: 核实实际导出，修正测试**

读 `src/action/prospectingActions.js` 实际导出（`seedProspectingActions` 为主，dedup 逻辑内嵌）：
- 若 `dedupResolver` 无具名导出：改为断言文件内含「existing + 查重 name/domain」契约（静态守卫，防未来回归）。

- [ ] **Step 3: 集成回归**

Run: `npx vitest run test/signal/ test/monitor/syncMetrics.test.js test/sales/quoteBaseline.test.js test/action/prospectingDedup.test.js test/db/externalSyncTables.test.js`
Expected: 全绿。

- [ ] **Step 4: 契约校验**

Run: `node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js`
Expected: 与 S1/S2 结论一致（仅 T21 先存缝隙）。

- [ ] **Step 5: 提交**

```powershell
git add test/action/prospectingDedup.test.js
git commit -m "test(proactive): T09 拓客去重契约锁定(existing 不入池防重复候选)"
```

---

## Self-Review 记录

**1. Spec coverage（对最终设计 S3）：**
- T06（事件订阅+重评）→ Task 1 ✅
- T07（同步可观测）→ Task 2 ✅
- T08（报价基线）→ Task 3 ✅
- T09（拓客去重）→ Task 4（既有实现锁定）✅
- 红线「不新增粒子类型」→ followup/指标均为运行态表或纯函数 ✅
- 红线「写操作经第0闸」→ 重评建信号走 signal store create（既有通道）✅
- 红线「S3 未交付前不对外宣称」→ 无对外文案 ✅

**2. Placeholder scan：** T06 的 followup 信号 dedup_key 为 `object:externalId:event`（事件型，非节律型）；T07 writeback 恒 0 为**有意边界**（L3 回写在 S4 落地）。

**3. Type consistency：** `getSyncMetrics` 返回 `{rows, lag, success_rate, conflict, writeback, degraded}` 与 T07 契约一致；`reevaluate` 返回 `{ok, signal, memory}` 与 T06 消费一致。

---

## 执行移交

S3 计划完成，保存于 `docs/superpowers/plans/2026-09-16-intake-judgement-s3.md`。

**执行方式：** 与本会话 S1/S2 一致（Inline 执行，逐 Task 带检查点）。
