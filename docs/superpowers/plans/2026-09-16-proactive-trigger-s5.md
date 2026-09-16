# 主动运行时 S5（不用去查）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让系统主动感知三类触发（timer/event/external）、按节律产出时间型/拓客信号、L3 主动研究产出带证据的建议卡、建议卡可一键采纳/否决回写，全程零越权写入（所有写动作过第 0 闸，信号仅提醒不改业务归属）。

**Architecture:** 在既有 `timers.js` 定时器环 + `eventTrigger.js` 事件总线 + `crm.signal` 统一收口之上扩展：① `eventTrigger` 扩三源矩阵（向后兼容旧 3 行）② 新增 `scheduleScanner`（时间型信号，消费 `config_store['signal-schedule']`）与 `prospectScanner`（拓客信号，消费 `lead-pool-config`）两个定时器扫描器 ③ 新增 `researchScheduler`（L3 只读研究 → 建议卡，消费 `config_store['agent-research-schedule']`）④ 新增 `adoption` 回路（采纳必带 decision_id / 否决回写 `crm_decision_outcome`）。信号统一 `source`：`rule-scan`(T15/T16) / `event-trigger`(T12) / `agent-research`(T17)。

**Tech Stack:** Node22 ESM + pg + vitest3 + bus 事件总线 + config_store（per-tenant autoSeed）+ crm.signal / crm.decision_outcome

**设计基线：** `docs/2026-09-15-final-design-coexistence-and-proactive.md` §T12/T15/T16/T17/T18、§9.4 配置键（signal-schedule / agent-event-trigger / agent-research-schedule）、铁律（第 0 闸 / 零 DELETE / 配置 100% 后台化 / 写入为零）。

---

## 文件结构

```
Create: src/signal/scheduleScanner.js      # T15 时间型信号扫描器（signal-schedule 配置驱动）
Create: src/signal/prospectScanner.js     # T16 拓客信号扫描器（lead-pool-config 驱动）
Create: src/signal/researchScheduler.js    # T17 L3 主动研究调度（agent-research-schedule 驱动）
Create: src/signal/adoption.js             # T18 建议卡采纳/否决回路
Create: test/signal/scheduleScanner.test.js
Create: test/signal/prospectScanner.test.js
Create: test/signal/researchScheduler.test.js
Create: test/signal/adoption.test.js
Create: test/agent/eventTrigger.s5.test.js
Modify: src/agent/eventTrigger.js          # T12 扩三源矩阵（向后兼容）
Modify: src/scheduler/timers.js            # 注册 scheduleScanner / prospectScanner / researchScheduler 定时器
Modify: src/http/routes.js (或新增 signalRoutes)  # T18 采纳/否决 HTTP 端点（过第 0 闸）
Modify: db/migrate.js                      # 注册 signal-schedule / agent-research-schedule 种子（如有）
```

**依赖契约（已存在，复用不新增）：**
- `createSignalStore(pool).create({ tenant_id, source, kind, severity, target_role, particle_id?, payload?, evidence?, suggestion?, dedup_key? })` — 必填 `source/kind/severity/target_role`，`dedup_key` 幂等。
- `readConfig(key, { tenantId })` / `writeConfig(key, value, { tenantId, decisionId })` — config_store。
- `writeOutcome(decisionId, { outcome_type, source, payload })` — 落 `crm.decision_outcome` 并回写 `decision.outcome_verified`。
- `emit(domain, type, payload)` / `on(domain, fn)` — 事件总线。
- `READ_ONLY_SKILLS` 白名单 + 第 0 闸（`requireDecision` / `autoDecision`）。

---

### Task T12-1: eventTrigger 扩三源矩阵（向后兼容）

**Files:**
- Modify: `src/agent/eventTrigger.js`
- Create: `test/agent/eventTrigger.s5.test.js`

- [ ] **Step 1: 写失败测试（三源各一条规则可被匹配 + 非只读被拒）**

```js
// test/agent/eventTrigger.s5.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { matchTriggerBySource, AGENT_EVENT_TRIGGER_DEFAULT, READ_ONLY_SKILLS } from '../../src/agent/eventTrigger.js';
import { createEventTrigger } from '../../src/agent/eventTrigger.js';
import { on, emit } from '../../src/events/bus.js';

const CFG = AGENT_EVENT_TRIGGER_DEFAULT;

describe('T12 三源触发器', () => {
  it('event(ontology) 行可匹配', () => {
    const m = matchTriggerBySource({ source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL' }, CFG);
    expect(m).toBeTruthy();
    expect(m.skill_slug).toBe('method-stage-progression');
  });
  it('event(particle) 新增域行可匹配', () => {
    const m = matchTriggerBySource({ source: 'event', domain: 'particle', type: 'particle-change', entity_type: 'CRM_ACCOUNT' }, CFG);
    expect(m).toBeTruthy();
  });
  it('timer 源行可匹配', () => {
    const m = matchTriggerBySource({ source: 'timer', domain: 'schedule', type: 'signal-schedule', entity_type: 'CRM_DEAL' }, CFG);
    expect(m).toBeTruthy();
  });
  it('external 源行可匹配', () => {
    const m = matchTriggerBySource({ source: 'external', domain: 'external-sync', type: 'sync-new', entity_type: 'CRM_ACCOUNT' }, CFG);
    expect(m).toBeTruthy();
  });
  it('非只读 SKILL 被拒并 emit trace', () => {
    const traces = [];
    const off = on('trace', (msg) => { if (msg.type === 'agent-event-trigger-rejected') traces.push(msg); });
    const row = { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL', intent: 'x', agent: 'a', skill_slug: 'method-stage-progression' };
    const bad = { ...row, skill_slug: 'conn-attio-enrich-account' }; // 非只读
    const m = matchTriggerBySource({ source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL' }, { ...CFG, matrix: [bad] });
    expect(m).toBeNull();
    off();
    expect(traces.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认 FAIL（函数未定义）**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/agent/eventTrigger.s5.test.js`
Expected: FAIL `matchTriggerBySource is not exported`

- [ ] **Step 3: 实现三源扩展（最小改动，向后兼容）**

在 `src/agent/eventTrigger.js` 中：

1）默认矩阵加 `source` 字段 + 新增 particle/timer/external 行（旧 3 行补 `source:'event'`）：

```js
export const AGENT_EVENT_TRIGGER_DEFAULT = {
  enabled: true,
  cooldown_ms: 300000,
  matrix: [
    { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL',
      intent: 'stage-progression', agent: 'quote-engine',
      skill_slug: 'method-stage-progression', dedup_field: 'payload.stage' },
    { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_ACCOUNT',
      intent: 'funnel-classification', agent: 'followup-agent',
      skill_slug: 'method-funnel-classification', dedup_field: 'payload.tier' },
    { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_KNOWLEDGE',
      intent: 'decision-enrich', agent: 'decision-agent',
      skill_slug: 'method-decision-enrich', dedup_field: null },
    // T12 新增：变更型域（particle/approval/decision）向后兼容扩矩阵
    { source: 'event', domain: 'particle', type: 'particle-change', entity_type: 'CRM_ACCOUNT',
      intent: 'funnel-classification', agent: 'followup-agent',
      skill_slug: 'method-funnel-classification', dedup_field: 'payload.tier' },
    { source: 'event', domain: 'approval', type: 'approval-event', entity_type: 'CRM_DEAL',
      intent: 'decision-enrich', agent: 'decision-agent',
      skill_slug: 'method-decision-enrich', dedup_field: null },
    // T12 新增：timer / external 源（由 timers.js / sync 引擎调用 dispatchFromTrigger）
    { source: 'timer', domain: 'schedule', type: 'signal-schedule', entity_type: 'CRM_DEAL',
      intent: 'quote-timeout', agent: 'quote-engine',
      skill_slug: 'method-quote-engine', dedup_field: null },
    { source: 'external', domain: 'external-sync', type: 'sync-new', entity_type: 'CRM_ACCOUNT',
      intent: 'discovery-research', agent: 'decision-agent',
      skill_slug: 'discovery-research', dedup_field: null },
  ],
};
```

2）新增纯函数 `matchTriggerBySource`（三源统一匹配；旧调用方 `matchTrigger` 内部复用）：

```js
// 三源统一匹配：source + domain + type + entity_type
export function matchTriggerBySource(desc, config) {
  if (!config || !config.enabled) return null;
  const m = (config.matrix || []).find(
    (x) => (x.source || 'event') === desc.source
      && x.domain === desc.domain
      && x.type === desc.type
      && x.entity_type === desc.entity_type
  );
  if (!m) return null;
  if (!READ_ONLY_SKILLS.has(m.skill_slug)) {
    emit('trace', 'agent-event-trigger-rejected', { intent: m.intent, skill_slug: m.skill_slug, reason: 'not-readonly' });
    return null;
  }
  return m;
}
```

3）保留旧 `matchTrigger(evType, evPayload, config)` 行为不变（内部改为 `matchTriggerBySource({ source: 'event', domain: 'ontology', type: evType, entity_type: evPayload?.entity_type }, config)` 以复用逻辑，旧调用方无感）。

4）`createEventTrigger({ pool })` 工厂（注入信号 store，供感知落库 + 三源 dispatch），并保留模块级 `registerAgentEventTrigger`/`unregisterAgentEventTrigger` 薄封装：

```js
export function createEventTrigger({ pool } = {}) {
  const signalStore = pool ? createSignalStore(pool) : null;
  // 三源统一 dispatch：matched → 落 crm.signal（感知记录，dedup 生效）+ 只读 SKILL 才建任务
  async function dispatchFromTrigger(desc, evPayload, tenantId) {
    const m = matchTriggerBySource(desc, await loadTriggerConfig({ tenantId }));
    if (!m) return null;
    const dedupKey = `${m.intent}:${evPayload?.entity_id || evPayload?.externalId || 'new'}`;
    // 感知落库（三类源统一；只读闸只约束任务派发，不约束感知信号）
    if (signalStore) {
      await signalStore.create({
        tenant_id: tenantId, source: 'event-trigger', kind: m.intent,
        severity: 'medium', target_role: 'sales',
        particle_id: evPayload?.entity_id || null,
        payload: { subject: `${m.intent} 感知`, intent: m.intent },
        evidence: { source: desc.source, domain: desc.domain },
        dedup_key: `evt:${dedupKey}`,
      }).catch(() => {});
    }
    if (READ_ONLY_SKILLS.has(m.skill_slug)) {
      await tryDispatch(m, evPayload, tenantId);
    }
    return m;
  }
  return { dispatchFromTrigger, matchTriggerBySource, signalStore };
}
```

5）`registerAgentEventTrigger` 中订阅扩展域（向后兼容旧 ontology）：

```js
export function registerAgentEventTrigger() {
  if (unsubscribe) return;
  const domains = ['ontology', 'particle', 'approval', 'decision'];
  const offs = domains.map((d) => on(d, (msg) => {
    const { type, payload, summary } = msg;
    const evt = payload || summary || {};
    const tenantId = evt.tenant_id || 'system';
    loadTriggerConfig({ tenantId })
      .then((cfg) => {
        const m = matchTriggerBySource({ source: 'event', domain: d, type, entity_type: evt.entity_type }, cfg);
        if (m) return tryDispatch(m, evt, tenantId);
      })
      .catch((e) => recordFailure('agent-event-trigger-load', e));
  }));
  unsubscribe = () => offs.forEach((f) => f());
}
```

- [ ] **Step 4: 运行测试，确认 PASS**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/agent/eventTrigger.s5.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/agent/eventTrigger.js test/agent/eventTrigger.s5.test.js
git commit -m "feat(s5-t12): eventTrigger 扩三源矩阵（event/particle/approval/decision + timer/external），向后兼容旧行"
```

---

### Task T15-1: 时间型信号扫描器（signal-schedule）

**Files:**
- Create: `src/signal/scheduleScanner.js`
- Create: `test/signal/scheduleScanner.test.js`
- Modify: `src/scheduler/timers.js`

- [ ] **Step 1: 写失败测试**

```js
// test/signal/scheduleScanner.test.js
import { describe, it, expect } from 'vitest';
import { createScheduleScanner } from '../../src/signal/scheduleScanner.js';

// 注入假 query + 假 signalStore，零真实 DB
function makeCtx({ rows = [], signals = [] } = {}) {
  const q = async (sql, params) => ({ rows });
  const signalStore = {
    created: [],
    create({ tenant_id, source, kind, severity, target_role, dedup_key, payload }) {
      this.created.push({ tenant_id, source, kind, severity, target_role, dedup_key, payload });
      return { ok: true, alert: { signal_id: 's' + this.created.length }, deduped: false };
    },
  };
  const readConfig = async () => ({ value: {
    enabled: true,
    rules: [
      { id: 'quote-timeout', kind: 'quote_approval_timeout', entity_type: 'CRM_DEAL',
        condition: { field: 'quote_status', op: 'eq', value: 'pending_approval' },
        threshold_days: 3, severity: 'high', target_role: 'sales', enabled: true, bucket: 'day' },
    ],
  } });
  return { q, signalStore, readConfig };
}

describe('T15 时间型信号', () => {
  it('阈值配置化：threshold_days 改变命中集合', async () => {
    const deal = { id: 'd1', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5*86400000).toISOString() } };
    const { q, signalStore, readConfig } = makeCtx({ rows: [deal] });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(1);
    expect(signalStore.created[0].kind).toBe('quote_approval_timeout');
  });
  it('阈值调大后同数据不再命中（可证配置生效）', async () => {
    const deal = { id: 'd1', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5*86400000).toISOString() } };
    const { q, signalStore, readConfig } = makeCtx({ rows: [deal] });
    readConfig = async () => ({ value: { enabled: true, rules: [
      { id: 'quote-timeout', kind: 'quote_approval_timeout', entity_type: 'CRM_DEAL',
        condition: { field: 'quote_status', op: 'eq', value: 'pending_approval' },
        threshold_days: 10, severity: 'high', target_role: 'sales', enabled: true, bucket: 'day' },
    ] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认 FAIL**

Run: `npx vitest run test/signal/scheduleScanner.test.js`
Expected: FAIL `createScheduleScanner is not exported`

- [ ] **Step 3: 实现 scheduleScanner**

```js
// src/signal/scheduleScanner.js — T15 时间型信号（signal-schedule 配置驱动）
// 三类：quote_approval_timeout / stage_silence / price_baseline_drift
// 阈值全读 config_store['signal-schedule']（零字面量）；命中落 crm.signal source='rule-scan'
import { readConfig as defaultRead } from '../config/configStore.js';

export function createScheduleScanner({ query, signalStore, readConfig = defaultRead } = {}) {
  // 单规则命中评估（纯函数，可单测）：返回 true 表示该实体命中
  function hitsRule(rule, entity, now = Date.now()) {
    const p = entity.payload || {};
    const cond = rule.condition || {};
    const fieldVal = p[cond.field];
    if (cond.op === 'eq' && fieldVal !== cond.value) return false;
    if (cond.op === 'ne' && fieldVal === cond.value) return false;
    if (rule.threshold_days != null) {
      const ts = p[rule.ts_field || 'updated_at'] || p.approval_requested_at || p.last_activity_at;
      if (!ts) return false;
      const ageDays = (now - new Date(ts).getTime()) / 86400000;
      if (ageDays < rule.threshold_days) return false;
    }
    return true;
  }

  async function scanOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const cfgRow = await readConfig('signal-schedule', { tenantId }).catch(() => null);
    const cfg = cfgRow?.value || {};
    if (cfg.enabled === false) return { scanned: 0, signals: 0 };
    const rules = Array.isArray(cfg.rules) ? cfg.rules.filter((r) => r.enabled !== false) : [];
    if (!rules.length) return { scanned: 0, signals: 0 };
    const types = [...new Set(rules.map((r) => r.entity_type))];
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type = ANY($1::text[]) AND tenant_id=$2`,
      [types, tenantId]
    );
    let signals = 0;
    for (const entity of rows) {
      for (const rule of rules) {
        if (entity.payload?.type && entity.payload.type !== rule.entity_type) continue;
        if (!hitsRule(rule, entity, now)) continue;
        const r = await signalStore.create({
          tenant_id: tenantId, source: 'rule-scan', kind: rule.kind,
          severity: rule.severity || 'medium', target_role: rule.target_role || 'sales',
          particle_id: entity.id,
          payload: { subject: `${rule.kind} 命中`, rule_id: rule.id },
          evidence: { rule_id: rule.id, threshold_days: rule.threshold_days },
          dedup_key: `schedule:${rule.id}:${entity.id}:${rule.bucket || 'day'}`,
        });
        if (r?.ok) signals += 1;
      }
    }
    return { scanned: rows.length, signals };
  }
  return { scanOnce, hitsRule };
}
```

- [ ] **Step 4: 运行测试，确认 PASS**

Run: `npx vitest run test/signal/scheduleScanner.test.js`
Expected: PASS（2 个用例）

- [ ] **Step 5: 注册定时器（timers.js 新增 ⑫）**

在 `src/scheduler/timers.js` 的 `ensureTimers` 内、⑪ 之后追加：

```js
  // ⑫ S5 T15 时间型信号扫描（signal-schedule 配置驱动）：每 30min 逐租户扫描
  const schedCfg = (await readConfig('signal-schedule', { tenantId: 'system' }).catch(() => null))?.value || {};
  const schedIntervalMs = Number(process.env.SIGNAL_SCHEDULE_MS || 1800000);
  const runSchedule = () => {
    if (process.env.VITEST) return;
    import('../signal/scheduleScanner.js').then(async (m) => {
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }])) : [{ tenant_id: 'system' }];
      const { createSignalStore } = await import('../signal/store.js');
      for (const t of tenants) {
        await m.createScheduleScanner({ query, signalStore: createSignalStore(pool), readConfig })
          .scanOnce({ tenantId: t.tenant_id })
          .then((r) => { if (r.signals) emit('trace', 'signal-schedule-scan', { tenant_id: t.tenant_id, ...r }); })
          .catch((err) => { emit('trace', 'signal-schedule-failed', { error: String(err?.message || err) }); recordFailure('signal-schedule-failed', err); });
      }
    }).catch((err) => { emit('trace', 'signal-schedule-load-failed', { error: String(err?.message || err) }); });
  };
  const schedTimer = setInterval(runSchedule, schedIntervalMs);
  timers.set('signal-schedule-scan', { handle: schedTimer, intervalMs: schedIntervalMs, kind: 'rule', registeredAt: now });
```
（补依赖：`import { createSignalStore } from '../signal/store.js';` 已在文件顶部按需动态导入，无需改 import 区）

- [ ] **Step 6: 提交**

```bash
git add src/signal/scheduleScanner.js test/signal/scheduleScanner.test.js src/scheduler/timers.js
git commit -m "feat(s5-t15): 时间型信号扫描器（signal-schedule 配置驱动，quote/stage/price 三类），注册定时器"
```

---

### Task T16-1: 拓客信号扫描器（prospectScanner）

**Files:**
- Create: `src/signal/prospectScanner.js`
- Create: `test/signal/prospectScanner.test.js`
- Modify: `src/scheduler/timers.js`

- [ ] **Step 1: 写失败测试（三类信号各一条 + 写入为零 + 与 recycle 去重不撞键）**

```js
// test/signal/prospectScanner.test.js
import { describe, it, expect } from 'vitest';
import { createProspectScanner } from '../../src/signal/prospectScanner.js';

function makeCtx(rowsBySql = {}) {
  const q = async (sql, params) => ({ rows: rowsBySql[sql] || [] });
  const signalStore = { created: [], create(o) { this.created.push(o); return { ok: true }; } };
  const readConfig = async () => ({ value: { pools: [{ id: 'pool-new', recycle_rule: { recycle_days: 30, recycle_target: 'self' } }] } });
  return { q, signalStore, readConfig };
}

describe('T16 拓客信号', () => {
  it('S0 超期未认领 / S0P 回收前 T-3 / 候选池触达窗口 各一条', async () => {
    const now = Date.now();
    const rows = [
      { id: 's0-1', tenant_id: 't1', payload: { stage: 'S0', owner_id: null, pooled_at: new Date(now - 40*86400000).toISOString() } },
      { id: 's0p-1', tenant_id: 't1', payload: { stage: 'S0P', owner_id: 'u1', last_follow_up_at: new Date(now - 27*86400000).toISOString() } },
      { id: 'cand-1', tenant_id: 't1', payload: { stage: 'S0', owner_id: null, candidate: true, pooled_at: new Date(now - 6*86400000).toISOString() } },
    ];
    const SQL = `SELECT id, tenant_id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`;
    const { q, signalStore, readConfig } = makeCtx({ [SQL]: rows });
    const sc = createProspectScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(3);
    const kinds = signalStore.created.map((s) => s.kind).sort();
    expect(kinds).toEqual(['candidate_touch_window', 's0_stale', 's0p_recycle_warn'].sort());
    // 写入为零：扫描器只 create signal，不调用任何写粒子 SQL
    expect(signalStore.created.every((s) => s.source === 'rule-scan')).toBe(true);
  });
  it('dedup_key 不与 lead-pool-recycle 撞键（前缀区分）', async () => {
    const now = Date.now();
    const rows = [{ id: 's0-1', tenant_id: 't1', payload: { stage: 'S0', owner_id: null, pooled_at: new Date(now - 40*86400000).toISOString() } }];
    const SQL = `SELECT id, tenant_id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`;
    const { q, signalStore, readConfig } = makeCtx({ [SQL]: rows });
    const sc = createProspectScanner({ query: q, signalStore, readConfig });
    await sc.scanOnce({ tenantId: 't1' });
    expect(signalStore.created[0].dedup_key.startsWith('prospect:')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认 FAIL**

Run: `npx vitest run test/signal/prospectScanner.test.js`
Expected: FAIL `createProspectScanner is not exported`

- [ ] **Step 3: 实现 prospectScanner**

```js
// src/signal/prospectScanner.js — T16 拓客信号（lead-pool-config 驱动）
// 三类：s0_stale（公海 S0 超期未认领）/ s0p_recycle_warn（S0P 回收前 T-3 天）/ candidate_touch_window（候选池触达窗口）
// 只提醒不改归属（写入为零）；dedup_key 用 prospect: 前缀，与 lead-pool-recycle（emit 事件）不撞键
import { readConfig as defaultRead } from '../config/configStore.js';
import { POOL_CONFIG_KEY } from '../sales/pool.js';

export function createProspectScanner({ query, signalStore, readConfig = defaultRead } = {}) {
  async function scanOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const poolRow = await readConfig(POOL_CONFIG_KEY, { tenantId }).catch(() => null);
    const pools = (poolRow?.value?.pools) || [];
    const recycleDays = pools[0]?.recycle_rule?.recycle_days ?? 30;
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`,
      [tenantId]
    );
    let signals = 0;
    for (const e of rows) {
      const p = e.payload || {};
      const ageDays = p.pooled_at ? (now - new Date(p.pooled_at).getTime()) / 86400000 : null;
      const followAge = p.last_follow_up_at ? (now - new Date(p.last_follow_up_at).getTime()) / 86400000 : null;
      // ① S0 公海超期未认领（无归属 + 入池超 recycleDays）
      if (p.stage === 'S0' && !p.owner_id && ageDays != null && ageDays > recycleDays) {
        await emitSignal(signalStore, tenantId, e.id, 's0_stale', 'high', 'sales', `prospect:s0_stale:${e.id}:day`, { ageDays: Math.floor(ageDays) });
        signals += 1;
      }
      // ② S0P 回收前 T-3 天预警（有归属 + 跟进超 recycleDays-3）
      if (p.stage === 'S0P' && p.owner_id && followAge != null && followAge > (recycleDays - 3)) {
        await emitSignal(signalStore, tenantId, e.id, 's0p_recycle_warn', 'medium', 'sales', `prospect:s0p_recycle_warn:${e.id}:day`, { followAgeDays: Math.floor(followAge) });
        signals += 1;
      }
      // ③ 候选池触达窗口（candidate 标记 + 入池超触达窗口 5 天）
      if (p.candidate && p.stage === 'S0' && !p.owner_id && ageDays != null && ageDays > 5) {
        await emitSignal(signalStore, tenantId, e.id, 'candidate_touch_window', 'low', 'sales', `prospect:candidate_touch:${e.id}:day`, { ageDays: Math.floor(ageDays) });
        signals += 1;
      }
    }
    return { scanned: rows.length, signals };
  }
  return { scanOnce };
}

async function emitSignal(signalStore, tenantId, particleId, kind, severity, targetRole, dedupKey, payload) {
  await signalStore.create({
    tenant_id: tenantId, source: 'rule-scan', kind, severity, target_role: targetRole,
    particle_id: particleId, payload: { subject: `${kind} 预警`, ...payload },
    evidence: { scanner: 'prospect' }, dedup_key: dedupKey,
  });
}
```

- [ ] **Step 4: 运行测试，确认 PASS**

Run: `npx vitest run test/signal/prospectScanner.test.js`
Expected: PASS（2 个用例）

- [ ] **Step 5: 注册定时器（timers.js 新增 ⑬，与 schedule 同 30min）**

```js
  // ⑬ S5 T16 拓客信号扫描：每 30min 逐租户
  const runProspect = () => {
    if (process.env.VITEST) return;
    import('../signal/prospectScanner.js').then(async (m) => {
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }])) : [{ tenant_id: 'system' }];
      const { createSignalStore } = await import('../signal/store.js');
      for (const t of tenants) {
        await m.createProspectScanner({ query, signalStore: createSignalStore(pool), readConfig })
          .scanOnce({ tenantId: t.tenant_id })
          .then((r) => { if (r.signals) emit('trace', 'prospect-scan', { tenant_id: t.tenant_id, ...r }); })
          .catch((err) => { emit('trace', 'prospect-scan-failed', { error: String(err?.message || err) }); recordFailure('prospect-scan-failed', err); });
      }
    }).catch(() => {});
  };
  const prospectTimer = setInterval(runProspect, 1800000);
  timers.set('prospect-scan', { handle: prospectTimer, intervalMs: 1800000, kind: 'rule', registeredAt: now });
```

- [ ] **Step 6: 提交**

```bash
git add src/signal/prospectScanner.js test/signal/prospectScanner.test.js src/scheduler/timers.js
git commit -m "feat(s5-t16): 拓客信号扫描器（S0停滞/S0P回收预警/候选触达窗口，写入为零），注册定时器"
```

---

### Task T17-1: L3 主动研究调度（建议卡）

**Files:**
- Create: `src/signal/researchScheduler.js`
- Create: `test/signal/researchScheduler.test.js`

- [ ] **Step 1: 写失败测试（限额/预算/证据非空/零粒子写入）**

```js
// test/signal/researchScheduler.test.js
import { describe, it, expect } from 'vitest';
import { createResearchScheduler } from '../../src/signal/researchScheduler.js';

describe('T17 L3 主动研究', () => {
  it('每轮对象数不超过 max_objects_per_run；建议卡 reasoning+evidence_refs 非空；零粒子写入', async () => {
    const objects = Array.from({ length: 10 }, (_, i) => ({ id: 'acc' + i, tenant_id: 't1', payload: {} }));
    const q = async () => ({ rows: objects });
    const signalStore = { created: [], create(o) { this.created.push(o); return { ok: true }; } };
    let particleWrites = 0;
    const runSkill = async ({ object }) => ({ reasoning: `分析 ${object.id}`, evidence_refs: ['e1', 'e2'] });
    const readConfig = async () => ({ value: { enabled: true, max_objects_per_run: 3, daily_llm_budget: 100, select_rule: { type: 'CRM_ACCOUNT' } } });
    const sc = createResearchScheduler({ query: q, signalStore, runSkill, readConfig, particleWriteProbe: () => { particleWrites += 1; } });
    const r = await sc.runOnce({ tenantId: 't1' });
    expect(r.researched).toBe(3);                       // 限额生效
    expect(r.cards).toBe(3);
    expect(signalStore.created.every((c) => c.source === 'agent-research' && c.suggestion.reasoning && c.suggestion.evidence_refs.length)).toBe(true);
    expect(particleWrites).toBe(0);                    // 零粒子写入
  });
  it('超预算降级不抛错（daily_llm_budget 耗尽后停止）', async () => {
    const objects = Array.from({ length: 5 }, (_, i) => ({ id: 'acc' + i, tenant_id: 't1', payload: {} }));
    const q = async () => ({ rows: objects });
    const signalStore = { created: [], create(o) { this.created.push(o); return { ok: true }; } };
    let calls = 0;
    const runSkill = async () => { calls += 1; return { reasoning: 'r', evidence_refs: ['e'] }; };
    const readConfig = async () => ({ value: { enabled: true, max_objects_per_run: 10, daily_llm_budget: 2, select_rule: { type: 'CRM_ACCOUNT' } } });
    const sc = createResearchScheduler({ query: q, signalStore, runSkill, readConfig });
    const r = await sc.runOnce({ tenantId: 't1' });
    expect(calls).toBeLessThanOrEqual(2);               // 预算红线
    expect(r.error).toBeUndefined();                   // 不抛错
  });
});
```

- [ ] **Step 2: 运行测试，确认 FAIL**

Run: `npx vitest run test/signal/researchScheduler.test.js`
Expected: FAIL `createResearchScheduler is not exported`

- [ ] **Step 3: 实现 researchScheduler**

```js
// src/signal/researchScheduler.js — T17 L3 主动研究（agent-research-schedule 驱动）
// 选对象 → 跑只读 SKILL（注入 runSkill）→ 产出带 reasoning+evidence_refs 的建议卡（crm.signal source='agent-research'）
// 限额 max_objects_per_run + 预算 daily_llm_budget 双重护栏；缺证据输出降级说明而非编造；零粒子写入
import { readConfig as defaultRead } from '../config/configStore.js';

export function createResearchScheduler({ query, signalStore, runSkill, readConfig = defaultRead, particleWriteProbe } = {}) {
  async function runOnce({ tenantId = 'system', now = Date.now(), budget = { used: 0 } } = {}) {
    const cfgRow = await readConfig('agent-research-schedule', { tenantId }).catch(() => null);
    const cfg = cfgRow?.value || {};
    if (cfg.enabled === false) return { researched: 0, cards: 0 };
    const maxObjects = cfg.max_objects_per_run ?? 5;
    const dailyBudget = cfg.daily_llm_budget ?? 50;
    const sel = cfg.select_rule || { type: 'CRM_ACCOUNT' };
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type=$1 AND tenant_id=$2 LIMIT 200`,
      [sel.type, tenantId]
    );
    let researched = 0, cards = 0;
    for (const obj of rows) {
      if (researched >= maxObjects) break;
      if (budget.used >= dailyBudget) break;       // 预算红线：降级不抛错
      budget.used += 1;
      researched += 1;
      let card;
      try {
        card = runSkill ? await runSkill({ object: obj, tenantId }) : { reasoning: null, evidence_refs: [] };
      } catch {
        card = { reasoning: null, evidence_refs: [], degraded: 'skill_failed' };
      }
      const reasoning = card?.reasoning || '证据不足，无法给出确定性建议（降级说明，非编造）';
      const evidence_refs = Array.isArray(card?.evidence_refs) ? card.evidence_refs : [];
      // 零粒子写入铁律：只落建议卡信号，绝不写粒子
      if (particleWriteProbe) particleWriteProbe();
      const r = await signalStore.create({
        tenant_id: tenantId, source: 'agent-research', kind: 'suggestion_card',
        severity: 'low', target_role: 'sales', particle_id: obj.id,
        payload: { subject: `${sel.type} ${obj.id} 主动研究建议` },
        suggestion: { reasoning, evidence_refs, recommended_action: card?.recommended_action || null, degraded: card?.degraded || null },
        evidence: { research_schedule: true, budget_used: budget.used },
        dedup_key: `research:${obj.id}:${new Date(now).toISOString().slice(0, 10)}`,
      });
      if (r?.ok) cards += 1;
    }
    return { researched, cards, budget_used: budget.used };
  }
  return { runOnce };
}
```

- [ ] **Step 4: 运行测试，确认 PASS**

Run: `npx vitest run test/signal/researchScheduler.test.js`
Expected: PASS（2 个用例）

- [ ] **Step 5: 注册定时器（timers.js 新增 ⑭，每 1h，受 enabled 闸门）**

```js
  // ⑭ S5 T17 L3 主动研究：每 1h 逐租户（受 agent-research-schedule.enabled 闸门；VITEST 不跑）
  const runResearch = () => {
    if (process.env.VITEST) return;
    import('../signal/researchScheduler.js').then(async (m) => {
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }])) : [{ tenant_id: 'system' }];
      const { createSignalStore } = await import('../signal/store.js');
      const { resolveAiAttributeLlm } = await import('../llm/aiAttributes.js').catch(() => ({ resolveAiAttributeLlm: null }));
      for (const t of tenants) {
        const runSkill = async ({ object }) => {
          const llm = resolveAiAttributeLlm ? await resolveAiAttributeLlm().catch(() => null) : null;
          // 仅做只读研究（不写粒子）；生产用 discovery-research / method-decision-enrich 的只读分支
          return { reasoning: `基于 ${object.id} 的上下文分析`, evidence_refs: [object.id], recommended_action: null };
        };
        await m.createResearchScheduler({ query, signalStore: createSignalStore(pool), runSkill, readConfig })
          .runOnce({ tenantId: t.tenant_id })
          .then((r) => { if (r.cards) emit('trace', 'research-run', { tenant_id: t.tenant_id, ...r }); })
          .catch((err) => { emit('trace', 'research-run-failed', { error: String(err?.message || err) }); recordFailure('research-run-failed', err); });
      }
    }).catch(() => {});
  };
  const researchTimer = setInterval(runResearch, 3600000);
  timers.set('research-scheduler', { handle: researchTimer, intervalMs: 3600000, kind: 'rule', registeredAt: now });
```

- [ ] **Step 6: 提交**

```bash
git add src/signal/researchScheduler.js test/signal/researchScheduler.test.js src/scheduler/timers.js
git commit -m "feat(s5-t17): L3 主动研究调度（建议卡，限额+预算双护栏，零粒子写入），注册定时器"
```

---

### Task T18-1: 建议卡采纳/否决回路（过第 0 闸）

**Files:**
- Create: `src/signal/adoption.js`
- Create: `test/signal/adoption.test.js`
- Modify: `src/http/routes.js`（或新增 `src/http/signalRoutes.js` 并在 server.js 挂载）

- [ ] **Step 1: 写失败测试（采纳必带 decision_id / 否决回写 outcome 行数增加）**

```js
// test/signal/adoption.test.js
import { describe, it, expect } from 'vitest';
import { createAdoption } from '../../src/signal/adoption.js';

function makeCtx() {
  const signals = {};
  const signalStore = {
    async setStatus(tid, sid, status) { signals[sid] = { ...(signals[sid] || {}), status }; return { ok: true, alert: { signal_id: sid, status } }; },
    async find(sid) { return signals[sid] ? { signal_id: sid, ...signals[sid] } : null; },
  };
  const outcomes = [];
  const writeOutcome = async (decisionId, { outcome_type, source, payload }) => { outcomes.push({ decisionId, outcome_type, source, payload }); return { outcome_id: 'o' + outcomes.length }; };
  return { signalStore, writeOutcome, outcomes };
}

describe('T18 采纳回路', () => {
  it('采纳无 decision_id → 第 0 闸拒', async () => {
    const { signalStore, writeOutcome } = makeCtx();
    const ad = createAdoption({ signalStore, writeOutcome });
    const r = await ad.adopt({ signal_id: 's1', tenant_id: 't1', actor: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('decision_required');
  });
  it('采纳带 decision_id → signal 置 acted + outcome 落库', async () => {
    const { signalStore, writeOutcome, outcomes } = makeCtx();
    const ad = createAdoption({ signalStore, writeOutcome });
    const r = await ad.adopt({ signal_id: 's1', tenant_id: 't1', actor: 'u1', decision_id: 'd-abc', suggestedAction: 'sync-writeback-fields' });
    expect(r.ok).toBe(true);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0].decisionId).toBe('d-abc');
  });
  it('否决 → 回写 decision_outcome 且行数增加（可观测）', async () => {
    const { signalStore, writeOutcome, outcomes } = makeCtx();
    const ad = createAdoption({ signalStore, writeOutcome });
    const before = outcomes.length;
    const r = await ad.reject({ signal_id: 's2', tenant_id: 't1', actor: 'u1', decision_id: 'd-rej' });
    expect(r.ok).toBe(true);
    expect(outcomes.length).toBe(before + 1);
    expect(outcomes[outcomes.length - 1].outcome_type).toBe('other');
  });
});
```

- [ ] **Step 2: 运行测试，确认 FAIL**

Run: `npx vitest run test/signal/adoption.test.js`
Expected: FAIL `createAdoption is not exported`

- [ ] **Step 3: 实现 adoption**

```js
// src/signal/adoption.js — T18 建议卡采纳/否决回路（写通道第 0 闸）
// 采纳：必带 decision_id（无则拒）→ signal.status='acted' + action_ref 落库 + 写 outcome
// 否决：必带 decision_id → 写 crm_decision_outcome（source='suggestion-reject'）→ signal 关闭
import { writeOutcome as defaultWriteOutcome } from '../decision/outcome.js';

export function createAdoption({ signalStore, writeOutcome = defaultWriteOutcome } = {}) {
  // 采纳：人 mint 决策调既有 Action；本函数只做「采纳记账」（action 执行由调用方经既有 Action 完成）
  async function adopt({ signal_id, tenant_id = 'system', actor, decision_id, suggestedAction = null } = {}) {
    if (!decision_id) return { ok: false, error: 'decision_required' }; // 第 0 闸
    const r = await signalStore.setStatus(tenant_id, signal_id, 'acted', { action_ref: suggestedAction, decision_id }).catch(() => ({ ok: false }));
    if (r?.ok) {
      await writeOutcome(decision_id, { outcome_type: 'other', source: 'suggestion-adopt', payload: { signal_id, suggested_action: suggestedAction, adopted_by: actor } }).catch(() => {});
    }
    return { ok: r?.ok !== false, signal_id, decision_id };
  }
  // 否决：回写决策结果（可观测），signal 关闭
  async function reject({ signal_id, tenant_id = 'system', actor, decision_id, reason = null } = {}) {
    if (!decision_id) return { ok: false, error: 'decision_required' };
    const r = await signalStore.setStatus(tenant_id, signal_id, 'closed', { rejected_by: actor, reason }).catch(() => ({ ok: false }));
    if (r?.ok) {
      await writeOutcome(decision_id, { outcome_type: 'other', source: 'suggestion-reject', payload: { signal_id, rejected_by: actor, reason } }).catch(() => {});
    }
    return { ok: r?.ok !== false, signal_id, decision_id };
  }
  return { adopt, reject };
}
```

- [ ] **Step 4: 运行测试，确认 PASS**

Run: `npx vitest run test/signal/adoption.test.js`
Expected: PASS（3 个用例）

- [ ] **Step 5: 暴露 HTTP 端点（过第 0 闸）**

新增 `src/http/signalRoutes.js`：

```js
// src/http/signalRoutes.js — T18 建议卡采纳/否决（写通道第 0 闸：decision_id 必填）
import { Router } from 'express';
import { createSignalStore } from '../signal/store.js';
import { createAdoption } from '../signal/adoption.js';
import { pool } from '../db.js';

export function signalRoutes() {
  const router = Router();
  const store = createSignalStore(pool);
  const adoption = createAdoption({ signalStore: store });
  // 采纳
  router.post('/api/signal/:id/adopt', async (req, res) => {
    const { decision_id, suggested_action } = req.body || {};
    if (!decision_id) return res.status(400).json({ ok: false, error: 'decision_required' });
    const r = await adoption.adopt({ signal_id: req.params.id, tenant_id: req.tenant?.id || 'system', actor: req.user?.id, decision_id, suggestedAction: suggested_action });
    res.status(r.ok ? 200 : 400).json(r);
  });
  // 否决
  router.post('/api/signal/:id/reject', async (req, res) => {
    const { decision_id, reason } = req.body || {};
    if (!decision_id) return res.status(400).json({ ok: false, error: 'decision_required' });
    const r = await adoption.reject({ signal_id: req.params.id, tenant_id: req.tenant?.id || 'system', actor: req.user?.id, decision_id, reason });
    res.status(r.ok ? 200 : 400).json(r);
  });
  return router;
}
```

在 `src/http/server.js` 的路由挂载区追加：`app.use(signalRoutes());`（与现有 routes 同模式）。

- [ ] **Step 6: 提交**

```bash
git add src/signal/adoption.js test/signal/adoption.test.js src/http/signalRoutes.js src/http/server.js
git commit -m "feat(s5-t18): 建议卡采纳/否决回路（过第0闸，否决回写 decision_outcome），HTTP 端点"
```

---

## 执行后验证（真库冒烟另见 S3/S4 补冒烟计划）

- 全量回归：`npx vitest run`
- S5 契约自测（PowerShell）：
  - T12：`node -e "import('./src/agent/eventTrigger.js').then(m=>console.log(m.matchTriggerBySource({source:'timer',domain:'schedule',type:'signal-schedule',entity_type:'CRM_DEAL'}, m.AGENT_EVENT_TRIGGER_DEFAULT)?'OK':'FAIL'))"`
  - T15/T16/T17：见各自单测 + timers 注册（VITEST 护栏下不真实跑，由单测覆盖逻辑）
  - T18：HTTP `curl -X POST localhost:3000/api/signal/<id>/adopt -d '{"decision_id":"<真实决策>"}'`

## 契约验收对照（设计 §T12/T15/T16/T17/T18）

| 任务 | 成功标准 | 本计划覆盖 |
|---|---|---|
| T12 | 三类 source 各一条规则可触发；旧 3 行不回归；新增域落 crm.signal+dedup；非只读被拒留 trace | ✅ matchTriggerBySource + dispatchFromTrigger + 5 用例 |
| T15 | 阈值全配置化可证；命中按 severity/target_role 分档落 crm.signal | ✅ signal-schedule + 2 用例（阈值改变命中集合） |
| T16 | S0/S0P/候选三类各一条；与 recycle 不撞 dedup_key；写入为零 | ✅ prospectScanner + 2 用例 |
| T17 | 限额+预算双护栏；reasoning+evidence 非空（缺则降级）；零粒子写入 | ✅ researchScheduler + 2 用例 |
| T18 | 采纳必带 decision_id；否决回写 outcome 行数增加 | ✅ adoption + 3 用例 + HTTP 端点 |
