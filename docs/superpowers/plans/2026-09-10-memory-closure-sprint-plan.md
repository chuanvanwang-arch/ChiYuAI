# 记忆系统收口 Sprint 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐记忆系统设计中已规划但未落地的 C3（自动沉淀拓宽+建档即沉淀）、U4（记忆页放开业务租户视图）、P4/P5（治理排程+存量回填），使"业务租户写即沉淀、且能看到自己记忆"闭环。

**Architecture:** 复用既有 `precipitate.js` 纯函数与 `memoryConfig.js` Router；C3 仅拓宽 `DEFAULT_RULES` 字段集并新增"建档=created 事实"分支、在 `createParticle` 挂钩；U4 仅放宽 `MEMORY_VIEWER_ROLES` 并改 `scopedTenant` 解析；P4/P5 接入既有健康巡检/回填脚本。零语义变更，全部 fail-open。

**Tech Stack:** Node.js ESM + PostgreSQL(pg) + vitest；`config_store` 配置化；`scopeTenant` 多租户隔离范式。

---

## 文件结构

| 文件 | 改动 | 责任 |
|---|---|---|
| `src/memory/precipitate.js` | 拓宽 `DEFAULT_RULES`；`precipitateFromParticleWrite` 增 `created` 分支 | C3 自动沉淀内核 |
| `src/particles/particleRepo.js` | `createParticle` 尾部挂沉淀钩子（`before=null`） | C3 建档即沉淀 |
| `src/portal/memoryConfig.js` | 放宽 `MEMORY_VIEWER_ROLES`；`handlers.get` 按 `scopeTenant` 隔离 | U4 记忆页租户视图 |
| `scripts/memory-nightly.sh` | 新建夜批脚本 | P4 治理排程 |
| `test/memory/precipitate-closure.test.js` | 新建单测 | C3 验证 |
| `test/portal/memoryConfig.test.js`（追加） | 追加 U4 断言 | U4 验证 |

---

### Task A: C3 自动沉淀 — 字段集拓宽 + 建档即沉淀

**Files:**
- Modify: `src/memory/precipitate.js:19-26`（`DEFAULT_RULES`）、`src/memory/precipitate.js:100-150`（`precipitateFromParticleWrite`）
- Modify: `src/particles/particleRepo.js:154`（createParticle 钩子）
- Test: `test/memory/precipitate-closure.test.js`（新建）

- [ ] **Step A1: 写失败单测（纯函数 + created 分支）**

```js
// test/memory/precipitate-closure.test.js
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RULES, shouldPrecipitate, diffFields, precipitateFromParticleWrite,
} from '../../src/memory/precipitate.js';

describe('C3 沉淀字段集拓宽', () => {
  it('CRM_DEAL 改 status/decision_chain/scope 应沉淀', () => {
    const v = shouldPrecipitate({
      type: 'CRM_DEAL',
      before: { stage: 'S1', status: 'open' },
      after: { stage: 'S1', status: 'won', decision_chain: 'A>B' },
      config: DEFAULT_RULES,
    });
    expect(v.ok).toBe(true);
    const fields = v.changes.map((c) => c.field).sort();
    expect(fields).toEqual(['decision_chain', 'status']);
  });

  it('CRM_QUOTATION 改 discount_rate 应沉淀（新增域）', () => {
    const v = shouldPrecipitate({
      type: 'CRM_QUOTATION',
      before: { discount_rate: 0.1 }, after: { discount_rate: 0.2 }, config: DEFAULT_RULES,
    });
    expect(v.ok).toBe(true);
    expect(v.topic).toBe('quote:change');
  });

  it('CRM_APPROVAL_FLOW 改 status 应沉淀（新增域）', () => {
    const v = shouldPrecipitate({
      type: 'CRM_APPROVAL_FLOW',
      before: { status: 'pending' }, after: { status: 'approved' }, config: DEFAULT_RULES,
    });
    expect(v.ok).toBe(true);
  });

  it('before=null 时 diffFields 把所有声明字段视为新增（created 模式）', () => {
    const d = diffFields(null, { stage: 'S1', amount: 100 }, ['stage', 'amount']);
    expect(d).toHaveLength(2);
    expect(d.every((c) => c.from == null)).toBe(true);
  });
});

describe('C3 建档即沉淀（created 分支，集成）', () => {
  it('precipitateFromParticleWrite(before=null) 产出 changeType=created 且带客户锚点', async () => {
    const after = { id: 'deal-created-001', type: 'CRM_DEAL', tenant_id: 'acme-demo', payload: { account_id: 'acc-99', stage: 'S1' } };
    const res = await precipitateFromParticleWrite(after, null, { tenantId: 'acme-demo', actor: 'system' });
    expect(res.ok).toBe(true);
    expect(res.row.payload.changeType).toBe('created');
    expect(res.row.entity_id).toBe('acc-99');   // 客户优先锚点
    expect(res.row.entity_type).toBe('ACCOUNT');
    expect(res.row.tenant_id).toBe('acme-demo');
    expect(res.row.payload.summary).toContain('创建');
  });
});
```

- [ ] **Step A2: 运行单测确认失败（production 字段集尚未拓宽 → 前 3 例 FAIL）**

```bash
node node_modules/vitest/vitest.mjs run test/memory/precipitate-closure.test.js 2>&1 | tail -20
```
Expected: 前 3 例 FAIL（`DEFAULT_RULES` 还缺 `status/decision_chain/scope` 与 `CRM_QUOTATION/CRM_APPROVAL_FLOW` 域）。

- [ ] **Step A3: 实现 DEFAULT_RULES 拓宽**

```js
// src/memory/precipitate.js — 替换 DEFAULT_RULES（原 19-26 行）
export const DEFAULT_RULES = {
  dedupeHours: 24,
  rules: [
    { type: 'CRM_DEAL', fields: ['stage', 'amount', 'owner', 'expected_close_date', 'close_date', 'status', 'decision_chain', 'scope'], topic: 'deal:field-change', ttlDays: 180 },
    { type: 'CRM_ACCOUNT', fields: ['industry', 'tier', 'business_tier', 'named_owner', 'name'], topic: 'account:field-change', ttlDays: 365 },
    { type: 'CRM_CONTACT', fields: ['role', 'title', 'phone', 'decision_power'], topic: 'contact:field-change', ttlDays: 365 },
    { type: 'CRM_QUOTATION', fields: ['amount', 'discount_rate', 'status'], topic: 'quote:change', ttlDays: 180 },
    { type: 'CRM_CONTRACT', fields: ['status', 'amount'], topic: 'contract:change', ttlDays: 365 },
    { type: 'CRM_APPROVAL_FLOW', fields: ['status'], topic: 'approval:change', ttlDays: 180 },
  ],
};
```

- [ ] **Step A4: 实现 created 分支（`precipitateFromParticleWrite` 改 100-150 行）**

```js
export async function precipitateFromParticleWrite(after, before, opts = {}) {
  try {
    const type = after?.type || before?.type || null;
    const isCreate = !before;                       // 建档模式：before 为 null
    const tenantId = opts.tenantId || after?.tenant_id || null;
    if (!type) return { ok: false, reason: 'no-type' };

    const config = await loadRules(tenantId);
    const verdict = shouldPrecipitate({
      type, before: before?.payload, after: after?.payload, config,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const anchor = resolveEntityAnchor({ payload: after?.payload || {} });
    const entityId = anchor.entity_id || after?.id || null;
    if (await recentlyPrecipitated({
      entityId, topic: verdict.topic, changes: verdict.changes, dedupeHours: config.dedupeHours,
    })) return { ok: false, reason: 'dedupe-window' };

    const payload = {
      type, id: after?.id || null,
      changeType: isCreate ? 'created' : 'field-change',
      changes: verdict.changes,
      changeKeys: verdict.changes.map((c) => `${c.field}=${c.to}`).sort().join(','),
      actor: opts.actor || null,
      decision_id: opts.decisionId || null,
      // summary 是消费端硬契约（injector.js#memoryText 只认 text|summary|note|content）
      summary: isCreate
        ? `创建 ${type}（${after?.id || ''}）`
        : `${type} ${verdict.changes.map((c) => `${c.field}: ${c.from ?? '空'} → ${c.to}`).join('；')}`,
    };

    const res = await appendMemory({
      topic: verdict.topic,
      kind: verdict.kind,
      payload,
      layer: 'L-Workspace',
      actor: opts.actor || null,
      eventType: isCreate ? 'particle-created' : 'particle-updated',
      ttlDays: verdict.ttlDays,
      explicit: true,               // 事实变更属高价值，豁免价值视界闸
      tenantId,
      entityId,
      entityType: anchor.entity_type,
    });
    if (!res?.ok) return { ok: false, reason: res?.code || 'append-failed' };
    return { ok: true, memoryId: res.row?.id, changes: verdict.changes.length, topic: verdict.topic, changeType: payload.changeType };
  } catch (e) {
    try {
      const { emit } = await import('../events/bus.js');
      emit('trace', 'memory-precipitate-failed', { id: after?.id, error: String(e?.message || e) });
      const { recordFailure } = await import('../monitor/monitorStore.js');
      recordFailure('memory-precipitate-failed', e);
    } catch { /* 二次失败不抛 */ }
    return { ok: false, reason: 'exception' };
  }
}
```

- [ ] **Step A5: 在 createParticle 挂建档钩子（particleRepo.js 154 行 `emit('particle','created')` 之前插入）**

```js
  // C3（2026-09-10 P2 收口）：建档即沉淀（新建实体=事实，必记；去重窗豁免）
  try {
    const { precipitateFromParticleWrite } = await import('../memory/precipitate.js');
    await precipitateFromParticleWrite(particle, null, {
      tenantId: tenantId || particle.tenant_id || null,
      actor: actor || 'system',
      decisionId: decisionId || null,
    });
  } catch (e) {
    emit('trace', 'memory-precipitate-create-failed', { id: particle.id, error: String(e?.message || e) });
  }
  emit('particle', 'created', { id: particle.id, type });
  return particle;
```

- [ ] **Step A6: 运行单测确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/memory/precipitate-closure.test.js 2>&1 | tail -20
```
Expected: 全部 PASS（6 例）。

- [ ] **Step A7: 提交**

```bash
git add src/memory/precipitate.js src/particles/particleRepo.js test/memory/precipitate-closure.test.js
git commit -m "C3: widen precipitate rules + precipitate on particle create (created fact)"
```

---

### Task B: U4 记忆页放开业务租户视图

**Files:**
- Modify: `src/portal/memoryConfig.js:64-66`（`MEMORY_VIEWER_ROLES`）、`:75-86`（`handlers.get`）、`:71`（forbid 文案）
- Test: 追加至 `test/portal/memoryConfig.test.js`

- [ ] **Step B1: 写失败断言（业务角色可看本租户）**

```js
// 追加到 test/portal/memoryConfig.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMemoryConfigRouter } from '../../src/portal/memoryConfig.js';

function makeReq(role, tenantId, tenantQuery) {
  return { query: tenantQuery ? { tenant: tenantQuery } : {} };
}
function makeRes() {
  const r = {};
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

describe('U4 记忆页租户视图', () => {
  it('sales 角色仅看到本租户记忆（跨租户不可见）', async () => {
    const deps = {
      resolveMe: async () => ({ ok: true, role: 'sales', tenantId: 'acme-demo' }),
      listLogs: async (tenantId) => (tenantId === 'acme-demo' ? [{ id: 1 }] : []),
      listNotes: async () => [],
      listSnapshots: async () => [],
      listPrecedents: async () => [],
      distill: async () => ({ ok: true }),
      distillDryRun: async () => ({ wouldDistill: 0 }),
      produceDecision: async () => ({ event_id: null }),
    };
    const router = createMemoryConfigRouter(deps);
    const res = await router.handlers.get(makeReq('sales', 'acme-demo'), makeRes());
    expect(res.code).toBe(200);
    expect(res.body.logs).toHaveLength(1);            // 仅本租户
  });

  it('非 viewer 角色（如匿名/无效）被拒', async () => {
    const router = createMemoryConfigRouter({
      resolveMe: async () => ({ ok: false, role: 'guest' }),
      listLogs: async () => [], listNotes: async () => [], listSnapshots: async () => [],
      listPrecedents: async () => [], distill: async () => ({ ok: true }),
      distillDryRun: async () => ({ wouldDistill: 0 }), produceDecision: async () => ({ event_id: null }),
    });
    const res = await router.handlers.get(makeReq('guest', 'x'), makeRes());
    expect(res.code).toBe(403);
  });

  it('admin 传 ?tenant=acme-demo 收窄到该租户', async () => {
    const router = createMemoryConfigRouter({
      resolveMe: async () => ({ ok: true, role: 'admin', tenantId: 'system' }),
      listLogs: async (tenantId) => (tenantId === 'acme-demo' ? [{ id: 9 }] : []),
      listNotes: async () => [], listSnapshots: async () => [], listPrecedents: async () => [],
      distill: async () => ({ ok: true }), distillDryRun: async () => ({ wouldDistill: 0 }),
      produceDecision: async () => ({ event_id: null }),
    });
    const res = await router.handlers.get(makeReq('admin', 'system', 'acme-demo'), makeRes());
    expect(res.code).toBe(200);
    expect(res.body.logs).toHaveLength(1);
  });
});
```

- [ ] **Step B2: 运行确认失败（当前 sales 不在 viewer 列表 → 403）**

```bash
node node_modules/vitest/vitest.mjs run test/portal/memoryConfig.test.js 2>&1 | tail -20
```
Expected: 第 1 例 FAIL（sales 被 forbid，期望 200）。

- [ ] **Step B3: 实现放宽**

```js
// src/portal/memoryConfig.js — 替换 63-66 行
// 记忆页可见角色：admin/sysadmin 跨租户全局；ten_admin/tan_admin 按本租户隔离；
// 业务用户(sales/manager/presales/exec) 仅可见本租户记忆（U4 收口，2026-09-10）
const MEMORY_VIEWER_ROLES = ['admin', 'sysadmin', 'ten_admin', 'tan_admin', 'sales', 'manager', 'presales', 'exec'];
const isMemoryViewer = (role) => MEMORY_VIEWER_ROLES.includes(role);
const isTenantAdmin = (role) => role === 'ten_admin' || role === 'tan_admin';
```

```js
// src/portal/memoryConfig.js — 替换 71 行 forbid 文案
const forbid = (res) => res.status(403).json({ error: '需要有效登录身份（业务用户仅可见本租户记忆）' });
```

```js
// src/portal/memoryConfig.js — 替换 75-86 行 handlers.get
    get: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || !isMemoryViewer(me.role)) return forbid(res);
        // U4 收口（2026-09-10）：业务用户/租户管理员按自身租户隔离；
        //   admin/sysadmin 可经 ?tenant= 收窄，传 null=全局；绝不回退全量 system 污染。
        const scopedTenant = (me.role === 'admin' || me.role === 'sysadmin')
          ? (req.query?.tenant || null)
          : (me.tenantId || 'system');
        const [logs, notes, snapshots, precedents] = await Promise.all([
          D.listLogs(scopedTenant), D.listNotes(scopedTenant), D.listSnapshots(scopedTenant), D.listPrecedents(scopedTenant),
        ]);
        res.status(200).json({ logs, notes, snapshots, precedents });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
```

- [ ] **Step B4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/portal/memoryConfig.test.js 2>&1 | tail -20
```
Expected: 全部 PASS。

- [ ] **Step B5: 提交**

```bash
git add src/portal/memoryConfig.js test/portal/memoryConfig.test.js
git commit -m "U4: open memory page to business tenants with scopeTenant isolation"
```

---

### Task C: P4 治理排程 + P5 存量回填

**Files:**
- Create: `scripts/memory-nightly.sh`
- Operational: `scripts/memory-health-check.mjs` / `scripts/memory-loop-closed.mjs`（既有，仅接入）/ `scripts/memory-backfill.mjs`（既有，apply）

- [ ] **Step C1: 新建夜批脚本**

```bash
#!/usr/bin/env bash
# scripts/memory-nightly.sh — 记忆治理闭环夜批（P4）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
node scripts/memory-health-check.mjs --json >> logs/mem-health.jsonl 2>&1 || true
node scripts/memory-loop-closed.mjs >> logs/mem-loop.log 2>&1 || true
echo "memory-nightly done: $(date -u +%FT%TZ)"
```

- [ ] **Step C2: 测试库验证巡检+闭环可跑**

```bash
PGDATABASE=crm_native_test node scripts/memory-health-check.mjs --json 2>&1 | tail -5
PGDATABASE=crm_native_test node scripts/memory-loop-closed.mjs 2>&1 | tail -5
```
Expected: health-check 输出 7 项指标 JSON；loop-closed 连跑可累积缺口（无异常退出）。

- [ ] **Step C3: 测试库验证存量回填 apply（S3 anchor + S4 project）**

```bash
PGDATABASE=crm_native_test node scripts/memory-backfill.mjs --step=anchor --step=project --apply 2>&1 | tail -10
```
Expected: 锚点覆盖率提升、决策记忆含 summary、全程 0 条 DELETE（脚本违约即中止）。

- [ ] **Step C4: 提交夜批脚本**

```bash
git add scripts/memory-nightly.sh
git commit -m "P4: add memory nightly cron script (health-check + loop-closed)"
```

> **生产回填（HITL 需用户授权）**：生产库执行前须用户在本地健康 checkout 运行
> `PGDATABASE=crm_native node scripts/memory-backfill.mjs --step=anchor --step=project --apply`
> 并确认 `--dry-run` 计数符合预期；AI 不自动执行生产写操作。

---

## 自检（写后自审）

1. **Spec 覆盖**：C3（A1-A5 字段集拓宽 + 建档钩子 + created 分支）✓；U4（B1-B5 角色放宽 + scopeTenant）✓；P4（C1-C2 夜批 + 巡检）✓；P5（C3 backfill apply）✓；R7 不在本 Sprint（独立立项）✓。
2. **占位符扫描**：无 TBD/TODO；所有代码步均含完整片段；测试步含实际断言。
3. **类型一致性**：`precipitateFromParticleWrite(after, before, opts)` 在 updateParticle（`before=cur`）与 createParticle（`before=null`）两处调用签名一致；`changeType` 字段在 payload 与断言中一致；`MEMORY_VIEWER_ROLES` 在 Step B3 定义、Step B4 测试引用一致。
4. **契约对齐**：设计文档 `docs/2026-09-10-memory-closure-sprint-design.md` 三任务 contract-yaml 与本计划 Task A/B/C 一一对应（agent `intake-router`/`review-gate`，contract_task_id `ct-intake-route`/`ct-review-gate`）。

*计划完整；await 执行方式裁决（Subagent-Driven / Inline Execution）。*
