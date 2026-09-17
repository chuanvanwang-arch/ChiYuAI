# 内部可观测客户异动派生 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「新客户筛选（新战略 / 高层变动 / 人员招聘）」从**无源字段**改为**内部可观测、可证伪**的客户异动信号（联系人台账变动、关系冷却），并把该主张的口径显式收敛到平台真实可覆盖的范围。

**Architecture:** 新增 `src/signal/activityDerivation.js`（纯函数 + 注入式 IO，对齐 `scheduleScanner` 范式），读 `config_store['internal-signal-derivation']` 声明的规则，从 `crm.particles`（`CRM_CONTACT` / `CRM_ACCOUNT`）派生 `source='derived'` 的信号，落 `crm.signal`；由 `timers.js` 新增定时器⑱ 驱动。口径收敛同步改 `src/config/discoveryRules.js` 与 `src/web/discovery-rules.html`（含页面镜像的防漂移守卫）。

**Tech Stack:** Node.js ESM、PostgreSQL（`crm` schema）、vitest。

---

## §0 设计输入与硬边界

设计文档：`docs/2026-09-16-internal-signal-derivation-design.md`（已通过 `validate-contract.mjs`，`valid:true`）。
承接智能体：`prospecting`（契约键 `ct-prospecting`）。

**已被实测推翻的上一轮假设（以本计划为准）**：

| 原设想 | 实测（本地 `crm_native`） | 结论 |
|---|---|---|
| 用 `decision_relation` 派生「决策链/关键人变动」 | 125 行全为 `REFERENCED_PRECEDENT`(71)/`DECIDED_ON`(49)/`OVERRIDES`/`CAUSED` 等 | ⛔ **不可**——它是「我方决策作用于某实体」，属平台内部决策网，**不是**客户组织人事。据此派生＝造新桩 |
| 三条规则（招聘 / 新战略 / 高层变动） | 「招聘 / 新战略」内部**零数据源**；`particles` 侧 `CRM_CONTACT` 25 行可派生 | ✅ 只做 2 条：`contact_ledger_change`（弱代理）+ `relation_cooling`；两条原主张**改口径剔除** |
| `relation_cooling` 判据含「无近期互动」 | `src/particles/interactionIndex.js` 声明的 `email/calendar/call/meeting` 枚举**全仓零外部消费者**（孤儿模块），DB 侧无互动流水表 | ⚠ 本批**只用粒子 `updated_at` 停滞**近似，代码与文档均须标注该收敛 |

**硬边界**：不新增粒子类型；不为无数据源字段写任何桩映射；派生信号 `source='derived'` 且
`payload.confidence_basis='internal_inference'`，权重**低于**实测情报；阈值/窗口/启停 100% 配置化；
零 DELETE；写操作过决策第 0 闸；去重谓词与 `idx_signal_dedup` 逐字一致。

**碰撞检查（已做）**：`src/signal/activityDerivation.js` 不存在；`internal-signal-derivation` / `relation_cooling` /
`contact_ledger_change` 全仓 0 命中；`src/config/discoveryRules.js`、`src/scheduler/timers.js`、
`test/timers.test.js` 工作树均 **clean**（无并行会话在途改动）。

---

## §1 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/signal/activityDerivation.js` | 创建 | 派生器：`deriveOnce({tenantId, now})`、`deriveAllTenants({now})`、纯函数 `hitsRule`/`bucketKey` |
| `db/migration-internal-signal-derivation-config.sql` | 创建 | 幂等播种 `internal-signal-derivation` 配置（新键 → `WHERE NOT EXISTS` 整键播种即可） |
| `db/migrate.js` | 修改 | 登记上述播种（追加一段 try 块） |
| `src/scheduler/timers.js` | 修改 | 新增定时器⑱ `activity-derivation-scan`（VITEST 护栏 + 可配间隔） |
| `test/timers.test.js` | 修改 | `EXPECTED_TIMERS` 17 → 18 + 注释更新 |
| `src/config/discoveryRules.js` | 修改 | 三字段标 `coverage:'no_internal_source'`；新增两条 `coverage:'internal_inference'` |
| `src/web/discovery-rules.html` | 修改 | 页面镜像同步（`signals` 块 + `SIGNAL_LABELS` + 面板说明改口径） |
| `test/signal/activityDerivation.test.js` | 创建 | 派生器纯函数 + DI 全用例（正例/反例/幂等/置信标注） |
| `test/signal/derivationConfigTemplate.test.js` | 创建 | 配置模板静态守卫（幂等/零 DELETE/阈值齐全/无桩字段） |
| `test/config/discoveryCoverage.test.js` | 创建 | 口径守卫：三字段无源标注 + 两项低权重 + **页面镜像防漂移** |
| `test/signal/derivationWiring.test.js` | 创建 | 静态守卫：定时器⑱ 已注册 + VITEST 护栏 + 派生器生产 import 方存在 |
| `docs/2026-09-16-internal-signal-derivation-design.md` | 修改 | 回填执行读数与口径收敛结果 |

---

## Task 1: 派生器 `src/signal/activityDerivation.js`

**Files:**
- Create: `src/signal/activityDerivation.js`
- Test: `test/signal/activityDerivation.test.js`

- [x] **Step 1: 写失败测试**

Create `test/signal/activityDerivation.test.js`:
```js
// test/signal/activityDerivation.test.js — 内部可观测客户异动派生（设计 §3.1 / 契约 T-D1）
// 为什么需要：主张「可以筛选新客户，比如新战略、高层变动、人员招聘」此前只有**一条权重配置**
//   （discoveryRules.js:35），全仓无任何适配器产出这些字段——典型「配置承诺 ≠ 实现」。
//   本文件锁四条可证伪语义：① 真命中；② **反例不命中**（正常实体不得被派生）；
//   ③ 置信语义显式（source=derived + confidence_basis）；④ 幂等（同 dedup_key 不新增）。
import { describe, it, expect } from 'vitest';
import { createActivityDerivation } from '../../src/signal/activityDerivation.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');   // 与下面各行 updated_at 的相对关系即用例语义
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const CONFIG = {
  version: 1,
  enabled: true,
  rules: [
    { id: 'contact-ledger-change', kind: 'contact_change', entity_type: 'CRM_CONTACT', window_days: 14,
      severity: 'low', target_role: 'sales', enabled: true, bucket: 'day' },
    { id: 'relation-cooling', kind: 'relation_cooling', entity_type: 'CRM_ACCOUNT', threshold_days: 30,
      severity: 'medium', target_role: 'sales', enabled: true, bucket: 'week' },
  ],
};

function makeCtx({ entities = [], config = CONFIG } = {}) {
  const created = [];
  const queries = [];
  return {
    created, queries,
    q: async (sql, params) => {
      queries.push({ sql, params });
      // 按 type 过滤注入实体（模拟 crm.particles 查询）
      const type = params?.[0];
      const rows = entities.filter((e) => !Array.isArray(type) || type.includes(e.type))
        .filter((e) => params?.[1] == null || e.tenant_id === params[1]);
      return { rows };
    },
    store: { create: async (o) => { created.push(o); return { ok: true, deduped: false }; } },
    readConfig: async () => ({ value: config }),
  };
}

const derive = (ctx) => createActivityDerivation({ query: ctx.q, signalStore: ctx.store, readConfig: ctx.readConfig });

describe('contact_ledger_change（弱代理：客户侧联系人台账变动）', () => {
  it('窗口内 CRM_CONTACT 更新 → 命中，且带 source=derived + confidence_basis', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(3), owner_id: 'alice' } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].source).toBe('derived');
    expect(ctx.created[0].kind).toBe('contact_change');
    expect(ctx.created[0].owner_id).toBe('alice');
    expect(ctx.created[0].payload.confidence_basis).toBe('internal_inference');
    expect(ctx.created[0].dedup_key).toContain('derived:contact-ledger-change:c1:');
  });

  it('窗口外的联系人更新 → 不命中（反例）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c2', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(40) } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
    expect(ctx.created).toHaveLength(0);
  });

  it('缺 updated_at → 不命中（不把"未知时间"当"刚更新"）', async () => {
    const ctx = makeCtx({ entities: [{ id: 'c3', type: 'CRM_CONTACT', tenant_id: 't1', payload: {} }] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });
});

describe('relation_cooling（关系冷却）', () => {
  it('停滞超过阈值 → 命中 medium', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'a1', type: 'CRM_ACCOUNT', tenant_id: 't1', payload: { updated_at: daysAgo(45), owner_id: 'alice' } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].kind).toBe('relation_cooling');
    expect(ctx.created[0].severity).toBe('medium');
  });

  it('近期有更新（未超阈值）→ 不命中（反例：正常实体不得被派生）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'a2', type: 'CRM_ACCOUNT', tenant_id: 't1', payload: { updated_at: daysAgo(5) } },
    ] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });
});

describe('fail-closed 与幂等', () => {
  it('配置读不到 → 零产出且给出归因（不静默、不造假）', async () => {
    const ctx = makeCtx();
    ctx.readConfig = async () => null;
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
    expect(r.missing[0].reason).toBe('config_missing');
  });

  it('enabled:false → 零产出', async () => {
    const ctx = makeCtx({ config: { ...CONFIG, enabled: false }, entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(1) } },
    ] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });

  it('同实体重复派生 → dedup_key 完全一致（幂等由 store.create 吸收）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(3) } },
    ] });
    const d = derive(ctx);
    await d.deriveOnce({ tenantId: 't1', now: NOW });
    await d.deriveOnce({ tenantId: 't1', now: NOW + 3600000 });
    expect(ctx.created[0].dedup_key).toBe(ctx.created[1].dedup_key);
  });

  it('纯函数 bucketKey（day/week/month）', async () => {
    const ctx = makeCtx();
    const d = derive(ctx);
    expect(d.bucketKey(NOW, 'day')).toBe('2026-09-16');
    expect(d.bucketKey(NOW, 'month')).toBe('2026-09');
    expect(d.bucketKey(NOW, 'week')).toMatch(/^2026-W\d{2}$/);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/signal/activityDerivation.test.js`
Expected: FAIL — `Failed to resolve import "../../src/signal/activityDerivation.js"`。

- [x] **Step 3: 实现**

Create `src/signal/activityDerivation.js`:
```js
// src/signal/activityDerivation.js — 内部可观测客户异动派生（设计 docs/2026-09-16-internal-signal-derivation-design.md §3.1）
//
// 立论：用户主张「可以筛选新客户，比如新战略、高层变动、人员招聘」此前只有一条**权重配置**
//   （src/config/discoveryRules.js:35 的 leadership_change），全仓无任何适配器产出该字段 —— 典型
//   「配置承诺 ≠ 实现」。本模块把该主张收敛为**内部可观测、可证伪**的两类信号。
//
// 数据面实测（2026-09-16，本地 crm_native）与据此的两处**口径收敛**（必须保留本注释）：
//   ① 「招聘 / 新战略」在本平台**零数据源**（无 HR、无战略情报面）⇒ 本模块**不产出**这两个字段。
//      绝不写"看起来在跑"的桩映射（P0 刚清掉的假绿形态）。
//   ② `decision_relation`（125 行：REFERENCED_PRECEDENT 71 / DECIDED_ON 49 / OVERRIDES / CAUSED…）
//      语义是「我方某决策作用于某实体」= 平台内部决策网，**不是**客户组织人事 ⇒ **不可**用作
//      「关键人变动」代理。据此派生等于新造一个桩，故排除。
//   ③ `relation_cooling` 原设计含「且无近期互动」。实测 `src/particles/interactionIndex.js` 声明的
//      email/calendar/call/meeting 枚举**全仓零外部消费者**（孤儿模块）、DB 侧亦无互动流水表
//      ⇒ 本批**只用粒子 updated_at 停滞**近似，并以此作为该信号的语义边界（不宣称"互动缺失"）。
//
// 铁律：
//   A. 派生信号必须自带来源与置信语义（source='derived'、payload.confidence_basis='internal_inference'），
//      且不得与实测情报同权（权重低于实测来源，见 discoveryRules.coverage 与守卫测试）。
//   B. 阈值/窗口/启停 100% 配置化（config_store['internal-signal-derivation']），零代码字面量。
//   C. fail-closed：读不到配置 / 实体缺失 → 不产出，并在返回值 missing[] 中显式归因（不静默、不造假）。
//   D. 零 DELETE；dedup_key 与 idx_signal_dedup 的部分索引谓词配合（同 (tenant_id,dedup_key) 未关闭唯一）。
import { readConfig as defaultRead } from '../config/configStore.js';

export function createActivityDerivation({ query, signalStore, readConfig = defaultRead } = {}) {
  // 桶键：决定「多久算一次新的异动提醒」。同日/同周/同月内重复派生 → 键相同 → 由 store.create 幂等吸收。
  function bucketKey(now = Date.now(), bucket = 'day') {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    if (bucket === 'month') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    if (bucket === 'week') {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return `${t.getUTCFullYear()}-W${p(Math.ceil(((t - yStart) / 86400000 + 1) / 7))}`;
    }
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 单实体命中评估（纯函数，可单测）：
  //   window_days  —— 近 N 天内**发生过变动**（= 近期变动）
  //   threshold_days —— 已停滞**超过 N 天**（= 冷却）
  //   两者语义相反，故必须由规则显式声明、互斥判定；缺字段一律不命中（不把"未知时间"当"刚更新"）。
  function hitsRule(rule, entity, now = Date.now()) {
    const ts = entity?.payload?.updated_at;
    if (!ts) return false;
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) return false;
    const ageDays = (now - t) / 86400000;
    if (rule.window_days != null) return ageDays <= Number(rule.window_days);
    if (rule.threshold_days != null) return ageDays > Number(rule.threshold_days);
    return false;   // 两条都没声明 → 规则不完整，不命中（不猜测语义）
  }

  async function loadConfig(tenantId) {
    try {
      const row = await readConfig('internal-signal-derivation', { tenantId });
      return row?.value || null;
    } catch {
      return null;
    }
  }

  async function deriveOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const cfg = await loadConfig(tenantId);
    const missing = [];
    if (!cfg || typeof cfg !== 'object') {
      return { scanned: 0, signals: 0, deduped: 0, missing: [{ reason: 'config_missing' }] };
    }
    if (cfg.enabled === false) return { scanned: 0, signals: 0, deduped: 0, missing: [] };
    const rules = Array.isArray(cfg.rules) ? cfg.rules.filter((r) => r.enabled !== false) : [];
    if (!rules.length) return { scanned: 0, signals: 0, deduped: 0, missing: [{ reason: 'no_rules' }] };

    let scanned = 0, signals = 0, deduped = 0;
    for (const rule of rules) {
      if (!rule.entity_type) { missing.push({ rule_id: rule.id, reason: 'entity_type_required' }); continue; }
      const { rows } = await query(
        `SELECT id, tenant_id, payload FROM crm.particles WHERE type=$1 AND tenant_id=$2`,
        [rule.entity_type, tenantId],
      ).catch(() => ({ rows: [] }));
      scanned += rows.length;
      let hit = 0;
      for (const entity of rows) {
        if (!hitsRule(rule, entity, now)) continue;
        hit += 1;
        const r = await signalStore.create({
          tenant_id: tenantId,
          source: 'derived',                                  // 铁律 A：来源可辨（低置信，不与实测情报同权）
          kind: rule.kind,
          severity: rule.severity || 'low',
          target_role: rule.target_role || 'sales',
          owner_id: entity.payload?.owner_id || null,
          particle_id: entity.id,
          payload: {
            subject: `${rule.kind}（内部推断）`,
            rule_id: rule.id,
            confidence_basis: 'internal_inference',           // 铁律 A：置信依据显式落 payload
            entity_type: rule.entity_type,
          },
          evidence: {
            rule_id: rule.id,
            window_days: rule.window_days ?? null,
            threshold_days: rule.threshold_days ?? null,
            updated_at: entity.payload?.updated_at || null,
          },
          dedup_key: `derived:${rule.id}:${entity.id}:${bucketKey(now, rule.bucket)}`,
        });
        if (r?.ok) { signals += 1; if (r.deduped) deduped += 1; }
      }
      // 铁律 C：规则就绪但零命中 → 显式归因（真库数据面缺失时不得静默）
      if (hit === 0) missing.push({ rule_id: rule.id, reason: 'zero_hit', scanned: rows.length });
    }
    return { scanned, signals, deduped, missing };
  }

  // 全部租户：单租户失败不中断其余（失败项收集返回，由调用方 emit trace）
  async function deriveAllTenants({ now = Date.now() } = {}) {
    const { rows } = await query(
      `SELECT DISTINCT tenant_id FROM crm.config_store WHERE key='internal-signal-derivation'`,
    ).catch(() => ({ rows: [] }));
    const totals = { tenants: rows.length, signals: 0, deduped: 0, missing: [], failures: [] };
    for (const { tenant_id } of rows) {
      try {
        const r = await deriveOnce({ tenantId: tenant_id, now });
        totals.signals += r.signals;
        totals.deduped += r.deduped;
        for (const m of r.missing) totals.missing.push({ tenant_id, ...m });
      } catch (e) {
        totals.failures.push({ tenant_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  return { deriveOnce, deriveAllTenants, hitsRule, bucketKey };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/signal/activityDerivation.test.js`
Expected: 10 passed。

- [x] **Step 5: 提交**

```bash
git add src/signal/activityDerivation.js test/signal/activityDerivation.test.js
git commit -m "feat(signal): 新增内部客户异动派生器（contact_ledger_change / relation_cooling，fail-closed + 置信标注）"
```

---

## Task 2: 播种 `internal-signal-derivation` 配置

**Files:**
- Create: `db/migration-internal-signal-derivation-config.sql`
- Modify: `db/migrate.js`
- Test: `test/signal/derivationConfigTemplate.test.js`

- [x] **Step 1: 写失败测试**

Create `test/signal/derivationConfigTemplate.test.js`:
```js
// test/signal/derivationConfigTemplate.test.js — 派生配置模板守卫
// 为什么需要：阈值/窗口/启停必须 100% 配置化（零代码字面量）。若模板缺字段，派生器会以
//   「规则不完整 → 不命中」静默归零，而配置页显示"已配置"——正是需要防的假绿形态。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../db/migration-internal-signal-derivation-config.sql', import.meta.url), 'utf8');

describe('internal-signal-derivation 模板', () => {
  it('含两条规则 id 与 kind', () => {
    expect(sql).toContain('contact-ledger-change');
    expect(sql).toContain('relation-cooling');
    expect(sql).toContain('contact_change');
    expect(sql).toContain('relation_cooling');
  });

  it('阈值齐全：window_days 与 threshold_days 各就位（缺一会使规则不命中）', () => {
    expect(sql).toMatch(/"window_days"\s*:\s*\d+/);
    expect(sql).toMatch(/"threshold_days"\s*:\s*\d+/);
  });

  it('不出现无源字段（招聘/新战略的桩映射一律禁止）', () => {
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/hiring|strategy_shift|new_strategy|leadership_change/);
  });

  it('零 DELETE / 零 DROP / 不使用 ON CONFLICT (key)', () => {
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)/i);
  });

  it('幂等：WHERE NOT EXISTS 按 key 判存在', () => {
    expect(sql).toMatch(/WHERE\s+NOT\s+EXISTS[\s\S]*key\s*=\s*'internal-signal-derivation'/i);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/signal/derivationConfigTemplate.test.js`
Expected: FAIL — `ENOENT`。

- [x] **Step 3: 写迁移 SQL**

Create `db/migration-internal-signal-derivation-config.sql`:
```sql
-- 内部可观测客户异动派生配置（2026-09-16）
-- 设计输入：docs/2026-09-16-internal-signal-derivation-design.md §3.2
-- 消费方：src/signal/activityDerivation.js（阈值/窗口/启停零代码字面量）
--
-- ⚠ 本键与 signal-schedule 的关键差别：这是一个**新键**（全库零行），故可直接用「整键播种 +
--   WHERE NOT EXISTS」范式（对齐 migration-sync-config.sql）。若将来本键已存在而需加规则，
--   必须改用「键内数组按 rule.id 追加」（见 db/migration-signal-schedule-rules.sql 头注），
--   否则存量租户永远拿不到新规则。
--
-- 口径边界（不得宣传为"招聘/新战略情报"）：
--   本配置只声明平台**内部可观测**的两类客户异动：
--     contact-ledger-change —— 客户侧联系人台账变动（CRM_CONTACT 近 14 天内被更新）= 「关键人变动」的**弱代理**
--     relation-cooling      —— 客户/商机关系冷却（CRM_ACCOUNT 停滞超 30 天）
--   「人员招聘」「新战略」在本平台**无数据源**（无 HR / 无战略情报面），本文件**刻意不含**其任何字段，
--   也绝不为其写占位映射（P0 刚清掉的桩，不再制造）。
--   relation-cooling 的判据**只**用粒子 updated_at 停滞：平台内无互动流水表（interactionIndex 枚举
--   全仓零消费者），故不宣称"无近期互动"。
--
-- 权重口径：派生信号在 discoveryRules 中权重**低于**实测情报（见 src/config/discoveryRules.js 的 coverage 标注）。
-- 幂等：WHERE NOT EXISTS（两代主键下均成立）；仅 INSERT，不删不改既有行。
-- 执行渠道：db/migrate.js 的 INCREMENTAL_SQL（容器启动即跑）。
--   **刻意不加入 scripts/seed-test-config.mjs**：派生器测试全部走注入式替身（零 DB），
--   测试库无需该键；而在测试库凭空多一个键会制造"配置已存在"的隐式前提（与 ⑱ signal-delivery 注解同源纪律）。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'internal-signal-derivation', '{
  "version": 1,
  "enabled": true,
  "rules": [
    {"id":"contact-ledger-change","kind":"contact_change","entity_type":"CRM_CONTACT","window_days":14,
     "severity":"low","target_role":"sales","enabled":true,"bucket":"day"},
    {"id":"relation-cooling","kind":"relation_cooling","entity_type":"CRM_ACCOUNT","threshold_days":30,
     "severity":"medium","target_role":"sales","enabled":true,"bucket":"week"}
  ]
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='internal-signal-derivation');
```

- [x] **Step 4: 登记进 migrate 清单**

Modify `db/migrate.js`：在「L3 日期规则补充」try 块之后（或任一同范式 try 块之后）追加：
```js
  // ─── 内部客户异动派生配置（2026-09-16）：internal-signal-derivation 平台模板 ───
  // 新键 → 整键播种（WHERE NOT EXISTS）。消费方 src/signal/activityDerivation.js。
  // 缺此键：派生器 loadConfig 返 null → fail-closed 零产出（不会静默产假信号，但也无信号）。
  try {
    const hasDeriv = await pool.query(
      `SELECT 1 FROM crm.config_store WHERE tenant_id='system' AND key='internal-signal-derivation' LIMIT 1`
    );
    if (!hasDeriv.rowCount) {
      const derivSql = readFileSync(new URL('./migration-internal-signal-derivation-config.sql', import.meta.url), 'utf8');
      await pool.query(derivSql);
      console.log('[migrate] 内部客户异动派生配置已播种（internal-signal-derivation）');
    } else {
      console.log('[migrate] internal-signal-derivation 已存在，跳过');
    }
  } catch (e) {
    console.log('[migrate] 内部客户异动派生配置播种跳过：', String(e.message || e).slice(0, 120));
  }
```
并把 `'migration-internal-signal-derivation-config.sql'` 加入文件顶部 `INCREMENTAL_SQL` 数组**末尾**，
带注释：`// 2026-09-16 内部客户异动派生：internal-signal-derivation 平台模板（新键整键播种）`。

> ⚠ `INCREMENTAL_SQL` 是**无条件执行清单**（每项幂等）。本文件内已带 `WHERE NOT EXISTS`，可安全入列。
> 注意入列后它同时会在测试库被 pretest 之外的路径执行到吗？——不会：`pretest` 只跑 `scripts/seed-test-config.mjs`，
> 而该脚本**不**执行 `INCREMENTAL_SQL`（`INCREMENTAL_SQL` 仅被 `db/migrate.js` 与
> `test/migrate-consistency.test.js` 使用）。

- [x] **Step 5: 跑守卫测试 + 真库执行与直查验证**

Run:
```bash
cd D:/system/CRM-ai-native && npx vitest run test/signal/derivationConfigTemplate.test.js test/migrate-consistency.test.js && PGDATABASE=crm_native node db/migrate.js 2>&1 | tail -4
cat > .tmp-deriv.mjs <<'EOF'
import { pool } from './src/db.js';
const r = await pool.query(`SELECT tenant_id, jsonb_array_length(value->'rules') n, value->'enabled' en FROM crm.config_store WHERE key='internal-signal-derivation'`);
console.table(r.rows);
await process.exit(0);
EOF
PGDATABASE=crm_native node .tmp-deriv.mjs; rm -f .tmp-deriv.mjs
```
Expected: 守卫 5 passed + migrate-consistency 通过；`system` 一行、`n=2`、`en=true`；**复跑 migrate 后行数不变**。

- [x] **Step 6: 提交**

```bash
git add db/migration-internal-signal-derivation-config.sql db/migrate.js test/signal/derivationConfigTemplate.test.js
git commit -m "feat(db): 播种 internal-signal-derivation 配置（两条内部派生规则，零桩字段）"
```

---

## Task 3: 定时器⑱ 接线派生扫描

**Files:**
- Modify: `src/scheduler/timers.js`（文件末尾 `signal-dispatch` 之后）
- Modify: `test/timers.test.js:20-27`（`EXPECTED_TIMERS` 与注释）
- Test: `test/signal/derivationWiring.test.js`

- [x] **Step 1: 写失败测试**

Create `test/signal/derivationWiring.test.js`:
```js
// test/signal/derivationWiring.test.js — 派生器生产接线守卫
// 为什么需要：本仓已有 5 次以上「模块全绿但生产零接线」的事故（createDeliveryRegistry 0 调用点、
//   alertStore persister 未挂、connectorActions 未注册…）。判据必须是「生产侧存在 import 方 +
//   定时器已注册 + 有 VITEST 护栏」，而不是"函数被定义了"。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const timers = readFileSync(new URL('../../src/scheduler/timers.js', import.meta.url), 'utf8');

describe('派生扫描的生产接线', () => {
  it('timers.js 引入并装配派生器（不是只定义了模块）', () => {
    expect(timers).toContain("import { createActivityDerivation }");
    expect(timers).toContain('createActivityDerivation(');
    expect(timers).toContain('deriveAllTenants');
  });

  it('注册定时器 activity-derivation-scan，且带 VITEST 护栏', () => {
    expect(timers).toContain("timers.set('activity-derivation-scan'");
    const idx = timers.indexOf("timers.set('activity-derivation-scan'");
    const block = timers.slice(Math.max(0, idx - 1500), idx);
    expect(block).toContain('process.env.VITEST');
  });

  it('间隔来自环境变量（零硬编码字面量阈值）', () => {
    expect(timers).toMatch(/ACTIVITY_DERIVATION_MS/);
  });

  it('零投递/零命中不静默：失败与 missing 均 emit', () => {
    const idx = timers.indexOf("timers.set('activity-derivation-scan'");
    const block = timers.slice(Math.max(0, idx - 2000), idx);
    expect(block).toContain('emit(');
    expect(block).toMatch(/missing|failures/);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/signal/derivationWiring.test.js`
Expected: FAIL — 前 3 例失败（未接线）。

- [x] **Step 3: 实现接线**

Modify `src/scheduler/timers.js`：
① 顶部 import 区（与其它 `src/signal/*` 引入并列）新增：
```js
import { createActivityDerivation } from '../signal/activityDerivation.js';
```
② 在文件末尾 `return timers.size;}` **之前**（`signal-dispatch` 块之后）插入：
```js
  // ⑱ 内部客户异动派生扫描（2026-09-16）—— 主张「筛选新客户」的可证伪落地
  //   存在的理由：该主张此前只有一条权重配置（discoveryRules.js:35 leadership_change），
  //     全仓无任何产出方 ⇒ 属「配置承诺 ≠ 实现」。本定时器是派生器**唯一**的生产触发点。
  //   频率取「小时级」：派生依据是粒子 updated_at 的相对天数（窗口 14 天 / 阈值 30 天），
  //     小时级足够灵敏且不会对 particles 造成压力。
  //   护栏：VITEST 下不启动（测试进程不得跑真实定时器）；间隔可经环境变量调整（零硬编码）。
  const activityDerivationIntervalMs = Number(process.env.ACTIVITY_DERIVATION_MS || 3600000);
  const runActivityDerivation = async () => {
    if (process.env.VITEST) return;
    // signalStore 用**动态 import**：与同文件其它扫描器（signal-schedule-scan / prospect-scan /
    //   research-scheduler）的既有约定一致（timers.js:580/598/619），避免顶层静态引入拉大启动面。
    const { createSignalStore } = await import('../signal/store.js');
    const derivation = createActivityDerivation({ query, signalStore: createSignalStore(pool), readConfig });
    await derivation.deriveAllTenants()
      .then((r) => {
        // 不静默：产出、幂等吸收、零命中归因、失败都必须可见——
        //   否则「派生了但零命中」与「根本没接线」在日志上不可区分（本仓头号假绿形态）。
        if (r.signals) emit('trace', 'activity-derivation', r);
        else emit('trace', 'activity-derivation-idle', { tenants: r.tenants, missing: r.missing });
        for (const f of r.failures) {
          emit('trace', 'activity-derivation-tenant-failed', f);
          recordFailure('activity-derivation-tenant-failed', new Error(f.error));
        }
      })
      .catch((err) => {
        emit('trace', 'activity-derivation-failed', { error: String(err?.message || err) });
        recordFailure('activity-derivation-failed', err);
      });
  };
  const activityDerivationTimer = setInterval(runActivityDerivation, activityDerivationIntervalMs);
  timers.set('activity-derivation-scan', {
    handle: activityDerivationTimer, intervalMs: activityDerivationIntervalMs, kind: 'rule', registeredAt: now,
  });
```
> `readConfig` 已在 `timers.js:15` 顶层 import（`signal-dispatch` 装配同用），无需新增；
> `createSignalStore` 按上文动态 import，**不要**加顶层静态 import（与既有约定冲突）。

- [x] **Step 4: 更新定时器计数断言**

Modify `test/timers.test.js`：
```js
// 注：decision-retro 与 decision-retro-boot 互斥——boot 是次日志对齐的 setTimeout，
//     触发后才注册 decision-retro 常驻 interval，故启动瞬间为 18（11 基线 + S5 三定时器 + S6 一定时器 + S7 一定时器 + 全链集成 Q1 一定时器 + 内部派生 ⑱）。
const EXPECTED_TIMERS = 18;
```
并把用例名与列表注释同步为「18 个：… + activity-derivation-scan（内部客户异动派生，2026-09-16）」。

- [x] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/signal/derivationWiring.test.js test/timers.test.js`
Expected: 全部 passed（4 + 既有用例）。

- [x] **Step 6: 提交**

```bash
git add src/scheduler/timers.js test/timers.test.js test/signal/derivationWiring.test.js
git commit -m "feat(scheduler): 新增定时器⑱ activity-derivation-scan（内部异动派生唯一生产触发点）"
```

---

## Task 4: 口径收敛（`discoveryRules` + 页面镜像 + 防漂移守卫）

**Files:**
- Modify: `src/config/discoveryRules.js:34-40`（`signals` 块）
- Modify: `src/web/discovery-rules.html:196-198`（`signals` 镜像）与 `:206-209`（`SIGNAL_LABELS`）
- Test: `test/config/discoveryCoverage.test.js`

- [x] **Step 1: 写失败测试**

Create `test/config/discoveryCoverage.test.js`:
```js
// test/config/discoveryCoverage.test.js — 口径守卫（含页面镜像防漂移）
// 为什么需要：
//   ① 「招聘 / 新战略 / 高层变动」在本平台**无数据源**。若这些字段继续以"可用信号"示人，
//      就是「配置承诺 ≠ 实现」——本仓已多次为此付出代价（审计 §1.2）。
//      故须显式标注 coverage:'no_internal_source'，让任何读配置的人都看得到边界。
//   ② src/web/discovery-rules.html 第 196-198 行是 signals 的**第二份副本**（漂移源）：
//      改了一处、漏另一处 → 配置页显示的权重与后端实际生效的不一致。故加镜像一致守卫。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_DISCOVERY_RULES } from '../../src/config/discoveryRules.js';

const html = readFileSync(new URL('../../src/web/discovery-rules.html', import.meta.url), 'utf8');
const S = DEFAULT_DISCOVERY_RULES.signals;

describe('口径：三字段显式标注无内部数据源', () => {
  it('hiring_icp_role / leadership_change 等无源字段带 coverage 标注', () => {
    for (const k of ['hiring_icp_role', 'leadership_change']) {
      expect(S[k], `缺 ${k}`).toBeDefined();
      expect(S[k].coverage, `${k} 缺 coverage 标注`).toBe('no_internal_source');
    }
  });
});

describe('内部可观测异动：低置信派生，不得与实测情报同权', () => {
  it('contact_ledger_change / relation_cooling 存在且标注 internal_inference', () => {
    for (const k of ['contact_ledger_change', 'relation_cooling']) {
      expect(S[k], `缺 ${k}`).toBeDefined();
      expect(S[k].coverage).toBe('internal_inference');
      expect(typeof S[k].weight).toBe('number');
    }
  });

  it('派生权重严格低于最高实测情报权重（不同权）', () => {
    const maxMeasured = Math.max(
      ...Object.entries(S).filter(([, v]) => v.coverage !== 'internal_inference').map(([, v]) => v.weight),
    );
    for (const k of ['contact_ledger_change', 'relation_cooling']) {
      expect(S[k].weight).toBeLessThan(maxMeasured);
    }
  });
});

describe('页面镜像防漂移', () => {
  it('discovery-rules.html 的 signals 副本与 DEFAULT_DISCOVERY_RULES.signals 键与权重一致', () => {
    for (const [k, v] of Object.entries(S)) {
      // 页面写法形如 `funding_round: { weight: 0.9 },`（允许同行多个）
      const re = new RegExp(`${k}\\s*:\\s*\\{\\s*weight\\s*:\\s*${v.weight}\\s*\\}`);
      expect(re.test(html), `页面镜像与后端不一致：${k} weight=${v.weight}`).toBe(true);
    }
  });

  it('页面含两项新信号的业务标签（且不再把无源字段表述为可用筛选）', () => {
    expect(html).toContain('contact_ledger_change');
    expect(html).toContain('relation_cooling');
    expect(html).toMatch(/内部推断/);           // 面板须显式提示置信边界
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/config/discoveryCoverage.test.js`
Expected: FAIL — 缺 coverage 标注 / 缺两项新信号 / 页面镜像缺键。

- [x] **Step 3: 改后端默认规则**

Modify `src/config/discoveryRules.js` 的 `signals` 块为：
```js
  signals: {
    // coverage 语义（2026-09-16 口径收敛）：
    //   no_internal_source  —— 本平台**无数据源**。字段保留是为兼容既有读取点（不破坏配置结构），
    //                          但任何展示/承诺都不得把它说成"可用的筛选能力"（审计 §1.2 的根因）。
    //   internal_inference  —— 来自**内部可观测数据**的推断（低置信，权重必须低于实测情报）。
    //   未标注            —— 外部实测情报（融资/标讯/技术采用等，由 discovery 适配器真实产出）。
    funding_round:     { weight: 0.9 },
    hiring_icp_role:   { weight: 0.7, coverage: 'no_internal_source' },
    tender_match:      { weight: 0.8 },
    leadership_change: { weight: 0.5, coverage: 'no_internal_source' },
    tech_adopt:        { weight: 0.6 },
    website_redesign:  { weight: 0.3 },
    social_content:    { weight: 0.4 },
    // ── 内部可观测客户异动（2026-09-16 新增；产出方 src/signal/activityDerivation.js）──
    //   权重刻意压低：同权会让"联系人台账变动"这类弱代理与"融资/标讯"等实测情报在排序上等价。
    contact_ledger_change: { weight: 0.25, coverage: 'internal_inference' },
    relation_cooling:      { weight: 0.2,  coverage: 'internal_inference' },
  },
```

- [x] **Step 4: 同步页面镜像**

Modify `src/web/discovery-rules.html`：
① `signals` 块改为与后端逐字一致：
```js
  signals: {
    funding_round: { weight: 0.9 }, hiring_icp_role: { weight: 0.7 }, tender_match: { weight: 0.8 },
    leadership_change: { weight: 0.5 }, tech_adopt: { weight: 0.6 }, website_redesign: { weight: 0.3 },
    social_content: { weight: 0.4 },
    contact_ledger_change: { weight: 0.25 }, relation_cooling: { weight: 0.2 },
  },
```
② `SIGNAL_LABELS` 增两键并**加置信后缀**：
```js
const SIGNAL_LABELS = {
  funding_round: '融资动态', hiring_icp_role: '目标岗位招聘', tender_match: '中标标讯',
  leadership_change: '管理层变动', tech_adopt: '新技术采用', website_redesign: '官网改版',
  social_content: '社媒内容',
  contact_ledger_change: '客户联系人台账变动（内部推断）', relation_cooling: '客户关系冷却（内部推断）',
};
```
③ 在 signals 面板说明处补一句口径提示（含「内部推断」字样，满足守卫断言）：
```html
      <p class="hint">「招聘 / 新战略」类外部情报本平台暂无可信数据源（已标注 <b>无内部数据源</b>，不计入筛选）；
        内部可观测的客户异动（联系人台账变动、关系冷却）以 <b>内部推断</b> 标注，权重低于实测情报。</p>
```

- [x] **Step 5: 跑相关测试确认通过（含既有回归）**

Run: `npx vitest run test/config/discoveryCoverage.test.js test/config/discoveryRules.test.js test/web/discoveryRulesPage.test.js test/external-integration.test.js test/prospectingRules.test.js`
Expected: 全部 passed。

- [x] **Step 6: 提交**

```bash
git add src/config/discoveryRules.js src/web/discovery-rules.html test/config/discoveryCoverage.test.js
git commit -m "feat(discovery): 口径收敛——无源字段标注 no_internal_source + 新增两项内部推断低权重信号（含页面镜像防漂移）"
```

---

## Task 5: 真库验收 + 文档口径改写

**Files:**
- Modify: `docs/2026-09-16-internal-signal-derivation-design.md`（回填执行读数）
- Modify: `docs/2026-09-16-four-module-claim-verification-audit.md`（主张口径改写）

- [x] **Step 1: 真库跑一次派生并直查产出**

Run:
```bash
cd D:/system/CRM-ai-native && cat > .tmp-derive-run.mjs <<'EOF'
import { pool } from './src/db.js';
import { createActivityDerivation } from './src/signal/activityDerivation.js';
import { createSignalStore } from './src/signal/store.js';
const d = createActivityDerivation({ query: (s, p) => pool.query(s, p), signalStore: createSignalStore(pool) });
for (const tenantId of ['system', 'acme-demo', 'acme-chem']) {
  const r = await d.deriveOnce({ tenantId });
  console.log(tenantId, JSON.stringify(r));
}
const out = await pool.query(`SELECT kind, severity, count(*)::int c FROM crm.signal WHERE source='derived' GROUP BY 1,2 ORDER BY 1`);
console.table(out.rows);
const basis = await pool.query(`SELECT count(*)::int c FROM crm.signal WHERE source='derived' AND payload->>'confidence_basis'='internal_inference'`);
console.log('带 internal_inference 标注的派生信号数:', basis.rows[0].c);
await process.exit(0);
EOF
PGDATABASE=crm_native node .tmp-derive-run.mjs; rm -f .tmp-derive-run.mjs
```
Expected: `relation_cooling` 计数 **> 0**（本库有 35 个 `CRM_ACCOUNT`）；
`confidence_basis='internal_inference'` 计数与派生总数**相等**（不假绿：每条都带标注）。
若 `relation_cooling` = 0，则把 `missing[]` 的 `zero_hit`/`config_missing` 归因原样抄进文档，**不得**叙述为"已产出"。

- [x] **Step 2: 幂等复跑验证**

Run: 重跑 Step 1 的命令。
Expected: 第二次 `signals` 计数不变（同桶键被 `dedup_key` 吸收），`crm.signal` 中 `source='derived'` 行数不增长。

- [x] **Step 3: 回填设计文档**

Modify `docs/2026-09-16-internal-signal-derivation-design.md`：把 §5 验收判据表逐行加上「实测」列，
并在文末追加「§8 执行读数（2026-09-16）」：
```markdown
## §8 执行读数（2026-09-16 实测，本地 crm_native）

| 判据 | 命令 | 实测 |
|---|---|---|
| 派生真实产出 | `SELECT kind,count(*) FROM crm.signal WHERE source='derived' GROUP BY 1` | （填 Step 1 读数） |
| 置信语义 | `... WHERE payload->>'confidence_basis'='internal_inference'` | （填：应与派生总数相等） |
| 幂等 | 复跑 deriveOnce | 行数不增长 |
| 配置就位 | `SELECT count(*) FROM crm.config_store WHERE key='internal-signal-derivation'` | 1（system 模板，经 readConfig autoSeed 覆盖租户） |
| 生产接线 | 定时器⑱ | 已注册，`EXPECTED_TIMERS=18` |

**口径收敛结果（本设计的必要组成）**：
`hiring_icp_role` / `leadership_change` 标 `coverage:'no_internal_source'`；
新增 `contact_ledger_change`(0.25) / `relation_cooling`(0.2) 标 `coverage:'internal_inference'`，
两者权重均**严格低于**最高实测情报权重（0.9）。
**边界声明**：`relation_cooling` 只用粒子 `updated_at` 停滞判定（平台无互动流水表，见代码头注 ③），
不宣称"无近期互动"；`decision_relation` 不可作客户组织人事代理（实测其全为平台内部决策网关系）。
```

- [x] **Step 4: 改写审计报告的主张口径**

Modify `docs/2026-09-16-four-module-claim-verification-audit.md` §模块1 的主张 1 条目，
把「可以筛选新客户，比如新战略、高层变动、人员招聘」改写为：
```markdown
> **口径修正（2026-09-16，用户批准）**：原表述「可以筛选新客户，比如新战略、高层变动、人员招聘」
> 与平台数据面不符——「人员招聘」「新战略」在本平台**无数据源**（无 HR、无战略情报面）。
> 现口径为：**可识别「内部可观测」的客户异动**——客户侧联系人台账变动（`CRM_CONTACT` 近 14 天内更新，
> 属"关键人变动"的弱代理）、客户关系冷却（`CRM_ACCOUNT` 停滞超 30 天）、商机停滞（既有 `deal_stuck`）。
> **不覆盖**外部招聘 / 战略情报（待 S2 外部数据接入）。
> 实现：`src/signal/activityDerivation.js`（`source='derived'` + `confidence_basis='internal_inference'`，
> 权重低于实测情报）+ 定时器⑱；口径标注见 `src/config/discoveryRules.js` 与拓客规则配置页。
```

- [x] **Step 5: 验证「无适配器产出该三字段」的否定断言（扫描方法先自证）**

Run:
```bash
cd D:/system/CRM-ai-native && echo "=== 正向（应仅命中 discoveryRules/页面/文档的标注，不得有产出它的适配器）===" \
&& grep -rn "hiring_icp_role\|leadership_change" src/ --include=*.js --include=*.html | head -20
echo "=== 扫描方法自证（探针文件应命中）==="
cat > /tmp/probe-signal.js <<'EOF'
const x = 'hiring_icp_role';
EOF
grep -rn "hiring_icp_role" /tmp/probe-signal.js; rm -f /tmp/probe-signal.js
```
判读：命中的应是**声明/标注/展示**位置（`discoveryRules.js`、`discovery-rules.html`、
`discoverySchema`/`buildDiscoveryPayload` 的字段名枚举），**不得**出现「某适配器把该字段作为产出写入」。
把命中的每一处的角色（声明 vs 产出）抄进设计文档 §8，作为该否定断言的证据。

- [x] **Step 6: 提交**

```bash
git add docs/2026-09-16-internal-signal-derivation-design.md docs/2026-09-16-four-module-claim-verification-audit.md
git commit -m "docs(discovery): 内部派生执行读数回填 + 「新战略/招聘」主张口径改写（含无源否定断言取证）"
```

---

## §2 验收判据（可证伪）

| # | 判据 | 命令 | 通过条件 |
|---|---|---|---|
| 1 | 派生器语义 | `npx vitest run test/signal/activityDerivation.test.js` | 10 passed；含**反例**（窗口外/近期有更新 → 不命中） |
| 2 | 配置模板 | `npx vitest run test/signal/derivationConfigTemplate.test.js` | 5 passed；无 `hiring/strategy_shift` 桩字段 |
| 3 | 生产接线 | `npx vitest run test/signal/derivationWiring.test.js test/timers.test.js` | 全 passed；`EXPECTED_TIMERS=18` |
| 4 | 口径 + 镜像 | `npx vitest run test/config/discoveryCoverage.test.js` | 6 passed（含页面镜像一致） |
| 5 | 真库产出 | `SELECT kind,count(*) FROM crm.signal WHERE source='derived' GROUP BY 1` | `relation_cooling > 0`；零命中时须有归因 |
| 6 | 置信标注 | `... WHERE payload->>'confidence_basis'='internal_inference'` | 计数 = 派生总数（每条都带） |
| 7 | 幂等 | 复跑 `deriveOnce` | `source='derived'` 行数不增长 |
| 8 | 零假信号 | 判据 1 的反例用例 | 正常实体（近期有更新）不被派生 |

**反假绿要求**：
- 不得把「配置已播种」叙述为「筛选能力已上线」——判据 5 要求**真库有派生信号**；
- 不得省略反例用例（只证"能命中"不证"不乱命中"＝无鉴别力）；
- 零命中时必须给出 `missing[]` 归因，禁止静默或叙述为"已产出"。

---

## §3 风险与缓解

| 风险 | 缓解 |
|---|---|
| 派生信号被当成「客户情报」消费 | `source='derived'` + `payload.confidence_basis` 显式标注；权重低于实测情报（Task 4 守卫锁定）；页面标签带「（内部推断）」 |
| 「弱代理」被叙述成「高层变动」 | Task 4/5 强制改口径 + `grep` 否定断言取证；标签名改为「客户联系人台账变动」 |
| `relation_cooling` 语义被夸大 | 代码头注 ③ + 设计 §8 显式声明「只用 updated_at 停滞，平台无互动流水表」 |
| 定时器计数改动破坏既有断言 | Task 3 Step 4 同步 `EXPECTED_TIMERS`；幂等性断言刻意不写死数字（既有设计已如此） |
| 页面镜像再次漂移 | Task 4 新增镜像一致守卫（改一处漏一处即红） |
| 与并行会话撞车 | 本计划触碰面经核查全部 clean；提交前 `git diff` 复核 hunk 归属 |

---

## §4 闭环回写（契约）

```contract-yaml
- task: "T-D1 新增 src/signal/activityDerivation.js：两条内部派生规则（纯函数 + 注入 IO）"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给定注入的实体集与配置：窗口内 CRM_CONTACT 变动命中、超阈值停滞命中、正常实体不命中；每条信号带 source='derived' 与 confidence_basis='internal_inference'"
```
**契约说明：** T-D1 由 `prospecting` 承接（契约键 `ct-prospecting`，源 `src/agent/contractIds.js`），须读 `intake-router` 记忆（L1，≤2 跳）；成功标准含**正例 + 反例**（正常实体不得命中）。

```contract-yaml
- task: "T-D2 播种 internal-signal-derivation 配置（幂等）并接线派生扫描（定时器⑱）"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "真库直查配置键就位且复跑 0 新增；定时器⑱ 已注册且 EXPECTED_TIMERS=18；派生器在真库上产出 relation_cooling 信号（或返回 missing[] 显式归因说明为何零命中）"
```
**契约说明：** T-D2 由 `prospecting` 承接；**零命中必须给出归因**（不得静默），真库产出须直查可见。

```contract-yaml
- task: "T-D3 口径收敛：discoveryRules 无源字段标注 + 页面镜像同步 + 审计文档改写"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "hiring_icp_role / leadership_change 标注 no_internal_source；新增两项 internal_inference 且权重严格低于最高实测权重；discovery-rules.html 镜像与后端逐键一致；文档不再出现「可筛选招聘/新战略」表述"
```
**契约说明：** T-D3 由 `prospecting` 承接；成功标准为**否定断言的扫描方法先自证有效**（沿用「否定断言须先验证扫描方法」纪律）。

```contract-yaml
- task: "T-D4 守卫测试：派生信号低置信不得与实测情报同权 + 去重幂等"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "断言 internal_inference 权重 < 最高实测来源权重；同实体重复派生 dedup_key 逐字一致（幂等）；页面镜像漂移守卫对人为改动必红"
```
**契约说明：** T-D4 由 `prospecting` 承接；成功标准含**变异验证**（证明守卫有鉴别力）。

---

## §5 提交顺序

```bash
git add src/signal/activityDerivation.js test/signal/activityDerivation.test.js
git commit -m "feat(signal): 新增内部客户异动派生器（contact_ledger_change / relation_cooling）"

git add db/migration-internal-signal-derivation-config.sql db/migrate.js test/signal/derivationConfigTemplate.test.js
git commit -m "feat(db): 播种 internal-signal-derivation 配置（两条内部派生规则，零桩字段）"

git add src/scheduler/timers.js test/timers.test.js test/signal/derivationWiring.test.js
git commit -m "feat(scheduler): 新增定时器⑱ activity-derivation-scan"

git add src/config/discoveryRules.js src/web/discovery-rules.html test/config/discoveryCoverage.test.js
git commit -m "feat(discovery): 口径收敛 + 两项内部推断低权重信号（含页面镜像防漂移）"

git add docs/2026-09-16-internal-signal-derivation-design.md docs/2026-09-16-four-module-claim-verification-audit.md
git commit -m "docs(discovery): 执行读数回填 + 主张口径改写"
```

**禁止 add**（并行会话在途）：`src/signal/route.js`、`src/signal/dispatcher.js`、`db/migration-signal-config.sql`、
`src/monitor/signalMetrics.js`、`scripts/seed-test-config.mjs`、`test/signal/route.test.js`。
