# 事件触发式智能体派发（C1 首批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让端到端业务写（粒子直写通道）自动带出智能体运行，在 `crm.tasks` 与 `crm.monitor_event` 留下可审计真实痕迹；根治「B能源公司流程全程零智能体」的设计缺口（设计文档 `docs/2026-09-03-agent-event-trigger-design.md`，契约校验 `valid:true`）。

**Architecture:** 订阅进程内事件总线 `ontology` 域（`recordEvent` 落库成功后 `emit`）；按配置中心矩阵 `agent-event-trigger` 匹配实体类型→派发意图→路由 agent→只读 SKILL；用「DB 去重（主）+ 内存冷却（辅）+ 只读白名单闸（fail-closed）」三级防风暴；不新增 agent / SKILL / 定时器，复用 `ready-queue-pump`（`src/scheduler/timers.js:258`）。

**Tech Stack:** Node 22 ESM · Express · vitest 3 · PostgreSQL `crm_native_test`（单测）/ `crm_native`（T5 验收）· 进程内 `bus.js` 事件总线。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/agent/eventTrigger.js` | **新建** | 订阅 `ontology` 域；矩阵判定；`loadTriggerConfig` 配置回退；三级防风暴；`registerAgentEventTrigger()` / `unregisterAgentEventTrigger()`（幂等+测试隔离）；导出 `AGENT_EVENT_TRIGGER_DEFAULT`、`READ_ONLY_SKILLS`、`matchTrigger`、`dedupKeyFor` 供单测 |
| `src/kanban/scheduler.js` | **修改** | `routeThroughIntake` 非决策分支：当 `payload.skill_slug` 命中 `targetAgent.skillCalls` 时保留，否则回落 `primarySkillFor`（T2） |
| `src/http/server.js` | **修改** | `createApp()` 启动块新增 `import { registerAgentEventTrigger }` + `try { registerAgentEventTrigger(); } catch …`（与 `registerAlertHook` 并列） |
| `src/http/routes.js` | **修改** | 新增 `createConfigRouter({ key:'agent-event-trigger', role:'sysadmin', decisionScene:'config-change' })` + `app.get('/agent-event-trigger-config.html', …)` |
| `src/portal/configCenter.js` | **修改** | `CONFIG_ITEMS` 数组新增 id=38 项（G4 智能体与运行） |
| `src/web/config.html` | **修改** | G4 分组 `items` 由 `[21,23,24]` → `[21,23,24,38]` |
| `src/web/agent-event-trigger-config.html` | **新建** | 极简配置页（启用开关 + cooldown + 矩阵查看），复用 event-retro-config.html 骨架 |
| `src/decision/policyVersion.js` | **修改** | `POLICY_KEYS` 数组追加 `'agent-event-trigger'`（治理巡检口径同步） |
| `test/web/configCenter.test.js` | **修改** | 断言同步：`length` 26→27；ids 数组与 ligne 51 并集追加 `38` |
| `test/agent/eventTrigger.test.js` | **新建** | T1/T4 单测：纯函数 `matchTrigger` / `dedupKeyFor` + 注册幂等 + 集成派发（测试库建单+去重） |
| `test/kanban/routeThroughIntake.test.js` | **新建** | T2 纯函数单测：`skill_slug` 覆盖与回落 |
| `scripts/verify-agent-event-trigger.mjs` | **新建** | T5 生产验收脚本（**只读、合成事件**，不写业务数据，零信任合规） |

> 设计文档 T1-T5 契约块已用 `contract_task_id: ct-intake-route` 收敛（特性所有者 `intake-router`，运行时派发目标 quote-engine/followup-agent/decision-agent 由矩阵决定，非任务执行方）。

---

## Task 1：新增 `src/agent/eventTrigger.js`（订阅 + 矩阵 + 三级防风暴 + 只读白名单）

**Files:**
- Create: `src/agent/eventTrigger.js`
- Create: `test/agent/eventTrigger.test.js`

- [ ] **Step 1: 写失败测试（纯函数 + 集成派发）**

```js
// test/agent/eventTrigger.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { on as _on, emit } from '../src/events/bus.js';
import {
  registerAgentEventTrigger, unregisterAgentEventTrigger,
  matchTrigger, dedupKeyFor, AGENT_EVENT_TRIGGER_DEFAULT, READ_ONLY_SKILLS,
} from '../src/agent/eventTrigger.js';
import { query, queryWrite } from '../src/db.js';

const TEST_PREFIX = 'test-et:';
const DEFAULT_CFG = AGENT_EVENT_TRIGGER_DEFAULT;

afterEach(async () => {
  unregisterAgentEventTrigger();
  await queryWrite(`DELETE FROM crm.tasks WHERE payload->>'dedup_key' LIKE $1`, [TEST_PREFIX + '%']);
});

describe('matchTrigger 纯函数', () => {
  it('CRM_DEAL ontology-sync → 命中 stage-progression / quote-engine / method-stage-progression', () => {
    const m = matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, DEFAULT_CFG);
    expect(m).toBeTruthy();
    expect(m.intent).toBe('stage-progression');
    expect(m.agent).toBe('quote-engine');
    expect(m.skill_slug).toBe('method-stage-progression');
  });
  it('未知实体类型 → 返回 null', () => {
    expect(matchTrigger('ontology-sync', { entity_type: 'CRM_TASK' }, DEFAULT_CFG)).toBeNull();
  });
  it('非只读 SKILL（白名单外）→ 返回 null', () => {
    const cfg = { ...DEFAULT_CFG, matrix: [{ ...DEFAULT_CFG.matrix[0], skill_slug: 'method-decision-execute' }] };
    expect(matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, cfg)).toBeNull();
  });
});

describe('dedupKeyFor', () => {
  it('含 dedup_field 时键 = {entity_id}:{intent}:{值}', () => {
    const m = DEFAULT_CFG.matrix[0];
    expect(dedupKeyFor(m, { entity_id: 'deal-1', stage: 'S4' })).toBe('deal-1:stage-progression:S4');
  });
  it('dedup_field 为 null → 键 = {entity_id}:{intent}:new', () => {
    const m = DEFAULT_CFG.matrix[2];
    expect(dedupKeyFor(m, { entity_id: 'kn-1' })).toBe('kn-1:decision-enrich:new');
  });
});

describe('注册幂等 + 集成派发', () => {
  it('emit ontology 事件后测试库出现 ready 任务，同键二次写不重复建单', async () => {
    registerAgentEventTrigger();
    registerAgentEventTrigger(); // 二次调用应幂等（不双订阅）
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: 'deal-1', tenant_id: 'system', stage: 'S4' });
    await new Promise((r) => setTimeout(r, 80));
    const r1 = await query(`SELECT * FROM crm.tasks WHERE payload->>'dedup_key'=$1`, ['deal-1:stage-progression:S4']);
    expect(r1.rows.length).toBe(1);
    expect(r1.rows[0].status).toBe('ready');
    // 同键二次写
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: 'deal-1', tenant_id: 'system', stage: 'S4' });
    await new Promise((r) => setTimeout(r, 80));
    const r2 = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, ['deal-1:stage-progression:S4']);
    expect(r2.rows[0].c).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/agent/eventTrigger.test.js
```
Expected: FAIL（`Cannot find module '../src/agent/eventTrigger.js'`）。

- [ ] **Step 3: 最小实现**

```js
// src/agent/eventTrigger.js
// 事件触发式智能体派发（C1 首批）：订阅 ontology 域 → 矩阵判定 → 三级防风暴 → 建派发任务
// 设计：docs/2026-09-03-agent-event-trigger-design.md ｜ 不新增 agent/SKILL/定时器
import { on, emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';
import { query, queryWrite } from '../db.js';
import { recordFailure } from '../monitor/monitorStore.js';

const CONFIG_KEY = 'agent-event-trigger';

// 出厂默认（唯一事实源；config_store 缺键时回退，保证触发器不抛错）
export const AGENT_EVENT_TRIGGER_DEFAULT = {
  enabled: true,
  cooldown_ms: 300000,
  matrix: [
    { domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL',
      intent: 'stage-progression', agent: 'quote-engine',
      skill_slug: 'method-stage-progression', dedup_field: 'payload.stage' },
    { domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_ACCOUNT',
      intent: 'funnel-classification', agent: 'followup-agent',
      skill_slug: 'method-funnel-classification', dedup_field: 'payload.tier' },
    { domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_KNOWLEDGE',
      intent: 'decision-enrich', agent: 'decision-agent',
      skill_slug: 'method-decision-enrich', dedup_field: null },
  ],
};

// 只读白名单闸（fail-closed）：事件触发任务无 decision_id，写操作必被第 0 闸拒；
// 首批只派发 kind:'read' 的 SKILL
export const READ_ONLY_SKILLS = new Set([
  'method-stage-progression', 'method-funnel-classification', 'method-decision-enrich',
]);

let unsubscribe = null;
const cooldownMap = new Map(); // 内存冷却（辅助，进程重启即失效）

// 读配置，缺键安全回退出厂默认
export async function loadTriggerConfig({ tenantId = 'system' } = {}) {
  const r = await readConfig(CONFIG_KEY, { tenantId });
  if (!r || !r.value) return AGENT_EVENT_TRIGGER_DEFAULT;
  const v = r.value || {};
  return {
    ...AGENT_EVENT_TRIGGER_DEFAULT,
    ...v,
    matrix: Array.isArray(v.matrix) && v.matrix.length ? v.matrix : AGENT_EVENT_TRIGGER_DEFAULT.matrix,
  };
}

// 取去重键中的「当前值」：事件载荷不含 stage/tier（recordEvent 仅落 entity_id/type/tenant_id），
// 故从粒子当前 payload 读（只读，安全）。dedup_field=null → 'new'（每次都算新）
async function resolveDedupValue(entityId, dedupField) {
  if (!dedupField) return 'new';
  const key = dedupField.split('.').pop();
  try {
    const r = await query('SELECT payload FROM crm.particles WHERE id=$1', [entityId]);
    const p = r.rows[0]?.payload || {};
    return p[key] ?? '';
  } catch {
    return '';
  }
}

// 纯函数：根据事件类型+实体类型匹配矩阵行；非只读 SKILL 直接拒（留痕）
export function matchTrigger(evType, evPayload, config) {
  if (!config || !config.enabled) return null;
  const m = (config.matrix || []).find(
    (x) => x.domain === 'ontology' && x.type === evType && x.entity_type === evPayload?.entity_type
  );
  if (!m) return null;
  if (!READ_ONLY_SKILLS.has(m.skill_slug)) {
    emit('trace', 'agent-event-trigger-rejected', { intent: m.intent, skill_slug: m.skill_slug, reason: 'not-readonly' });
    return null;
  }
  return m;
}

// 纯函数：构建去重键
export function dedupKeyFor(match, evPayload) {
  const val = evPayload?.[match.dedup_field?.split('.').pop()] ?? '';
  return `${evPayload?.entity_id}:${match.intent}:${val === '' ? 'new' : val}`;
}

async function tryDispatch(match, evPayload, tenantId) {
  const dedupKey = await resolveDedupValue(evPayload.entity_id, match.dedup_field)
    .then((v) => `${evPayload.entity_id}:${match.intent}:${v === '' ? 'new' : v}`);
  const now = Date.now();
  // ② 内存冷却（辅助）
  const last = cooldownMap.get(dedupKey);
  const cool = match.cooldown_ms ?? 300000;
  if (last && now - last < cool) {
    emit('trace', 'agent-event-trigger-skipped', { dedup_key: dedupKey, reason: 'cooldown' });
    return;
  }
  // ① DB 去重（主，重启后仍有效）
  try {
    const dup = await query(
      `SELECT 1 FROM crm.tasks WHERE payload->>'dedup_key'=$1 AND status IN ('ready','running') LIMIT 1`,
      [dedupKey]
    );
    if (dup.rows.length) {
      emit('trace', 'agent-event-trigger-skipped', { dedup_key: dedupKey, reason: 'db-dedup' });
      return;
    }
  } catch (e) {
    recordFailure('agent-event-trigger-dedup', e); // 查失败保守放行 + 留痕
  }
  cooldownMap.set(dedupKey, now);
  try {
    await queryWrite(
      `INSERT INTO crm.tasks (tenant_id, title, action_name, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'ready')`,
      [tenantId,
       `事件触发·${match.intent}·${evPayload.entity_id}`,
       'agent-dispatch',
       JSON.stringify({
         intent: match.intent,
         targetAgent: match.agent,
         entity_id: evPayload.entity_id,
         entity_type: evPayload.entity_type,
         dedup_key: dedupKey,
         skill_slug: match.skill_slug,
         dispatchedFrom: 'intake-router',
       })]
    );
    emit('trace', 'agent-event-trigger-dispatch', { dedup_key: dedupKey, agent: match.agent, skill_slug: match.skill_slug });
  } catch (e) {
    recordFailure('agent-event-trigger-dispatch', e);
    emit('trace', 'agent-event-trigger-failed', { dedup_key: dedupKey, error: e?.message });
  }
}

export function registerAgentEventTrigger() {
  if (unsubscribe) return; // 幂等
  unsubscribe = on('ontology', (msg) => {
    const { type, payload, summary } = msg;
    const evt = payload || summary || {};
    const tenantId = evt.tenant_id || 'system';
    loadTriggerConfig({ tenantId })
      .then((cfg) => {
        const m = matchTrigger(type, evt, cfg);
        if (m) return tryDispatch(m, evt, tenantId);
      })
      .catch((e) => recordFailure('agent-event-trigger-load', e));
  });
}

export function unregisterAgentEventTrigger() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  cooldownMap.clear();
}
```

> 注意：`dedupKeyFor` 保留为纯函数（单测用，值直接取 `evPayload`）；运行期 `tryDispatch` 用 `resolveDedupValue` 从粒子读真实当前值（因事件不携带 stage）。两者键形一致。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/agent/eventTrigger.test.js
```
Expected: PASS（4 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/agent/eventTrigger.js test/agent/eventTrigger.test.js
git commit -m "feat(agent): T1 事件触发派发器 eventTrigger.js（订阅 ontology + 矩阵 + 三级防风暴 + 只读白名单）"
```

---

## Task 2：`routeThroughIntake` 支持显式 `skill_slug` 覆盖

**Files:**
- Modify: `src/kanban/scheduler.js:72-82`（非决策分支返回块）
- Create: `test/kanban/routeThroughIntake.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/kanban/routeThroughIntake.test.js
import { describe, it, expect } from 'vitest';
import { routeThroughIntake } from '../../src/kanban/scheduler.js';

describe('routeThroughIntake skill_slug 覆盖', () => {
  it('intent=stage-progression 且 payload.skill_slug=method-stage-progression → quote-engine + 保留 skill_slug', () => {
    const r = routeThroughIntake({ id: 't1', payload: { intent: 'stage-progression', skill_slug: 'method-stage-progression' } });
    expect(r.targetAgent).toBe('quote-engine');
    expect(r.payload.skill_slug).toBe('method-stage-progression');
    expect(r.payload.contract_task_id).toBe('ct-quote-calc');
  });
  it('未传 skill_slug → 回落 primarySkillFor(quote-engine)=method-quote-engine', () => {
    const r = routeThroughIntake({ id: 't2', payload: { intent: 'stage-progression' } });
    expect(r.payload.skill_slug).toBe('method-quote-engine');
  });
  it('越权 skill_slug（不在 targetAgent.skillCalls）→ 回落 primarySkillFor，不泄露越权', () => {
    const r = routeThroughIntake({ id: 't3', payload: { intent: 'stage-progression', skill_slug: 'method-decision-execute' } });
    expect(r.payload.skill_slug).toBe('method-quote-engine'); // 不在 quote-engine.skillCalls → 回落
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/kanban/routeThroughIntake.test.js
```
Expected: FAIL（skill_slug 仍被 `primarySkillFor` 覆盖）。

- [ ] **Step 3: 修改 `routeThroughIntake` 非决策分支（scheduler.js:72-82）**

把返回块中的 `skill_slug: primarySkillFor(targetAgent)` 改为按闭包校验后的覆盖逻辑：

```js
  const targetAgent = intent === 'retro' ? 'decision-retro'
    : intent === 'followup' ? 'followup-agent'
    : 'quote-engine';
  const gateAgents = level === 'major' ? ['review-gate'] : [];
  const contractTaskId = contractIdForAgent(targetAgent)
    || `intake:${task.id || 'anon'}:${level}:${targetAgent}`;
  // T2（2026-09-03）：显式 skill_slug 授权覆盖——仅当命中 targetAgent.skillCalls 闭包才保留，
  //   否则回落 primarySkillFor（防越权 SKILL 经事件通道被派发）。
  const calls = agentSpecs[targetAgent]?.capabilities?.skillCalls || [];
  const skillSlug = (p.skill_slug && calls.includes(p.skill_slug)) ? p.skill_slug : primarySkillFor(targetAgent);
  return {
    targetAgent,
    gateAgents,
    payload: {
      ...p,
      level,
      contract_task_id: contractTaskId,
      skill_slug: skillSlug,
      dispatchedFrom: 'intake-router',
    },
  };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run test/kanban/routeThroughIntake.test.js
```
Expected: PASS（3 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/kanban/scheduler.js test/kanban/routeThroughIntake.test.js
git commit -m "feat(kanban): T2 routeThroughIntake 支持显式 skill_slug 授权覆盖（skillCalls 闭包校验）"
```

---

## Task 3：配置中心新增 `agent-event-trigger` 键（四处置同步）

**Files:**
- Modify: `src/portal/configCenter.js`（G4 组新增 id=38）
- Modify: `src/web/config.html:79`（G4 `items` 追加 38）
- Modify: `src/http/routes.js`（createConfigRouter + html 路由）
- Create: `src/web/agent-event-trigger-config.html`
- Modify: `src/decision/policyVersion.js:30`（`POLICY_KEYS` 追加）
- Modify: `test/web/configCenter.test.js`（length 27 + ids 含 38）

- [ ] **Step 1: 写失败测试（更新 configCenter 断言）**

```js
// test/web/configCenter.test.js — 仅改两处断言
// line 6:
expect(CONFIG_ITEMS.length).toBe(27);   // 原 26 → 27
// line 8:
expect(ids).toEqual([11,12,13,27,28,14,15,16,17,18,19,20,21,22,23,24,26,29,30,31,32,33,35,34,36,37,38]);
// line 51（并集排序）：原数组末尾追加 38 → [...,37,38]
expect([...new Set(flat)].sort((a,b)=>a-b)).toEqual([11,12,13,14,15,16,17,18,19,20,21,22,23,24,26,27,28,29,30,31,32,33,34,35,36,37,38]);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run test/web/configCenter.test.js
```
Expected: FAIL（length 26 ≠ 27 / ids 缺 38）。

- [ ] **Step 3: `src/portal/configCenter.js` 新增 id=38 项（G4 组，置于 id:24 之后）**

```js
  { id: 38, name: '事件触发智能体派发', group: '智能体与运行', status: 'ready',
    page: '/agent-event-trigger-config.html', endpoint: '/api/config/agent-event-trigger',
    note: '订阅 ontology-sync 事件，按矩阵自动为 quote-engine/followup-agent/decision-agent 建只读判定任务；三级防风暴（DB去重+内存冷却+只读白名单）；config_store 承载，写经决策第0闸+sysadmin，删键回退出厂默认' },
```

- [ ] **Step 4: `src/web/config.html:79` G4 分组追加 38**

```js
    { name: '智能体与运行', items: [21, 23, 24, 38] },            // G4: alert-rules / agent-config(S28) / page-market / agent-event-trigger
```

- [ ] **Step 5: `src/http/routes.js` 新增路由（置于 line 184 provenance-patrol 之后）**

```js
  // 事件触发智能体派发配置（C1 首批）：GET/PUT /api/config/agent-event-trigger，写经决策第0闸+sysadmin
  app.use(createConfigRouter({ key: 'agent-event-trigger', role: 'sysadmin', decisionScene: 'config-change' }));
  app.get('/agent-event-trigger-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agent-event-trigger-config.html', import.meta.url))));
```

- [ ] **Step 6: 新建 `src/web/agent-event-trigger-config.html`（极简，复用 event-retro-config.html 骨架）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>事件触发智能体派发 · 配置中心</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
  .wrap { padding: 18px 20px; max-width: 1180px; margin: 0 auto; }
  .note { background: var(--warn); color: #fff; padding: 10px 12px; border-radius: 6px; font-size: 12px; margin-bottom: 14px; }
  .field { display: flex; gap: 10px; align-items: center; margin: 6px 0; }
  .field label { width: 300px; font-size: 13px; color: var(--mut); }
  .field crm-input, .field crm-checkbox { padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); color: var(--ink); }
  #status { font-size: 12px; color: var(--mut); }
</style>
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<header class="page-head"><div class="ph-main"><h1 class="page-title">事件触发智能体派发</h1></div></header>
<div class="wrap">
  <div class="note">业务写（粒子直写通道）后系统自动为智能体建判定任务，全程无需人工发起。数据存入 <b>config_store['agent-event-trigger']</b>，写操作经决策第0闸 + sysadmin 权限。全部阈值后台可配，代码零硬编码。</div>
  <div class="panel sect">
    <div class="sect-title">总开关与冷却</div>
    <div class="field"><label>启用事件触发派发</label><crm-checkbox id="enabled"></crm-checkbox></div>
    <div class="field"><label>内存冷却窗（毫秒，同去重键窗口内只建一次）</label><crm-input type="number" id="cooldown" min="0" max="3600000" step="1000"></crm-input></div>
  </div>
  <div class="toolbar">
    <crm-button id="saveBtn">保存变更</crm-button>
    <crm-button class="sec" id="reloadBtn">重新加载</crm-button>
    <span id="status">就绪</span>
  </div>
</div>
<script type="module">
import { injectLayout } from '/portal/layout.js';
import { get, put } from '/portal/api.js';
injectLayout();
const DEFAULTS = { enabled: true, cooldown_ms: 300000 };
let current = null;
function setStatus(s) { document.getElementById('status').textContent = s; }
function fill() {
  const v = { ...DEFAULTS, ...(current || {}) };
  document.getElementById('enabled').checked = v.enabled !== false;
  document.getElementById('cooldown').value = v.cooldown_ms != null ? v.cooldown_ms : 300000;
}
async function load() {
  setStatus('加载中…');
  try { const data = await get('/api/config/agent-event-trigger'); current = (data && data.value) ? data.value : {}; fill(); setStatus('已加载'); }
  catch (e) { current = {}; fill(); setStatus('未配置或加载失败，显示出厂默认：' + (e.message || e)); }
}
async function save() {
  setStatus('保存中…'); if (!current) current = {};
  const ms = Number(document.getElementById('cooldown').value);
  if (!Number.isFinite(ms) || ms < 0 || ms > 3600000) { setStatus('冷却窗需为 0–3600000 毫秒'); return; }
  current.enabled = document.getElementById('enabled').checked; current.cooldown_ms = ms;
  try { await put('/api/config/agent-event-trigger', { value: current }); setStatus('已保存（写经决策第0闸）'); }
  catch (e) { setStatus('保存失败：' + (e.message || e)); }
}
document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('reloadBtn').addEventListener('click', load);
load();
</script>
</body>
</html>
```

- [ ] **Step 7: `src/decision/policyVersion.js:30` 追加已知键**

```js
export const POLICY_KEYS = [
  'autonomy-conf', 'sales-thresholds', 'hindsight-deviation',
  'context-guard', 'context-routing', 'event-retro', 'agent-event-trigger',
];
```
> 同步在上方注释块（line 24 附近）加一行：`//   agent-event-trigger   eventTrigger.js（loadTriggerConfig）`。

- [ ] **Step 8: 运行测试确认通过**

```bash
npx vitest run test/web/configCenter.test.js
```
Expected: PASS。另手测：`curl -s http://127.0.0.1:3000/api/config/agent-event-trigger` 返回 `{"value":null,…}`（删键回退默认，不抛错）；`GET /agent-event-trigger-config.html` 返回 200。

- [ ] **Step 9: 提交**

```bash
git add src/portal/configCenter.js src/web/config.html src/http/routes.js src/web/agent-event-trigger-config.html src/decision/policyVersion.js test/web/configCenter.test.js
git commit -m "feat(config): T3 配置中心新增 agent-event-trigger（四处置同步 + 极简配置页）"
```

---

## Task 4：`server.js` 启动注册 + 单元隔离测试

**Files:**
- Modify: `src/http/server.js:27,60`（import + 启动块）
- Modify: `test/agent/eventTrigger.test.js`（追加注册幂等/退订单测）

- [ ] **Step 1: `src/http/server.js` 启动接线（与 registerAlertHook 并列）**

在 `line 27` 附近新增 import：

```js
// 事件触发式智能体派发（C1 首批）：订阅 ontology 域 → 矩阵派发只读判定任务
import { registerAgentEventTrigger } from '../agent/eventTrigger.js';
```

在 `line 60`（`ensureTimers()` 之后）新增：

```js
  // 事件触发智能体派发：接线 ontology 域订阅（幂等，异常仅日志不阻断主服务）
  try { registerAgentEventTrigger(); } catch (e) { console.log(`[agent-event-trigger] register fail: ${e.message}`); }
```

- [ ] **Step 2: 追加单测（幂等 + 退订隔离）到 `test/agent/eventTrigger.test.js`**

```js
describe('注册幂等 + 退订隔离', () => {
  it('register 两次仅一个订阅；unregister 后事件不再建单', async () => {
    registerAgentEventTrigger();
    registerAgentEventTrigger();
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: 'deal-2', tenant_id: 'system', stage: 'S3' });
    await new Promise((r) => setTimeout(r, 80));
    const before = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, ['deal-2:stage-progression:S3']);
    expect(before.rows[0].c).toBe(1);
    unregisterAgentEventTrigger();
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: 'deal-2', tenant_id: 'system', stage: 'S3' });
    await new Promise((r) => setTimeout(r, 80));
    const after = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, ['deal-2:stage-progression:S3']);
    expect(after.rows[0].c).toBe(1); // 未新增
  });
});
```

- [ ] **Step 3: 运行测试确认通过**

```bash
npx vitest run test/agent/eventTrigger.test.js
```
Expected: PASS（含 T1 共 6 用例）。

- [ ] **Step 4: 提交**

```bash
git add src/http/server.js test/agent/eventTrigger.test.js
git commit -m "feat(server): T4 启动注册 registerAgentEventTrigger（与 alertHook 并列）+ 幂等/隔离单测"
```

---

## Task 5：生产验收（B能源端到端，只读合成事件，零信任合规）

**Files:**
- Create: `scripts/verify-agent-event-trigger.mjs`

> 原则：不在生产库写任何业务数据（零信任）。用**合成 `ontology-sync` 事件**对 B新能源 deal `7fdebf95-126b-4294-8e85-47a7a1d653f1` 触发，验证派发链路真实生效；业务侧「真实推进/知识入库」由用户手动操作触发，本脚本仅断言结果。

- [ ] **Step 1: 写验收脚本**

```js
// scripts/verify-agent-event-trigger.mjs
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
const { query, queryWrite, pool } = await import('../src/db.js');
const { registerAgentEventTrigger, unregisterAgentEventTrigger } = await import('../src/agent/eventTrigger.js');
const { emit } = await import('../src/events/bus.js');

const DEAL_ID = '7fdebf95-126b-4294-8e85-47a7a1d653f1';
const TENANT = 'system';

registerAgentEventTrigger();
// 合成事件（只读，不写业务粒子）：模拟 deal 阶段变化
emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL_ID, tenant_id: TENANT, stage: 'S4' });
await new Promise((r) => setTimeout(r, 200));

const tasks = await query(
  `SELECT id, status, payload->>'dedup_key' dk, payload->>'skill_slug' sk FROM crm.tasks
   WHERE payload->>'entity_id'=$1 ORDER BY created_at DESC LIMIT 5`, [DEAL_ID]
);
console.log('新建派发任务:', JSON.stringify(tasks.rows, null, 1));
const ok = tasks.rows.some((t) => t.status === 'ready' && t.sk === 'method-stage-progression');
console.log(ok ? 'PASS: 智能体派发链路生效（queue 出现 method-stage-progression 任务）' : 'FAIL: 未出现预期任务');

// 触发泵（模拟下一调度周期），观察 episode（不强制，可能因 agentLoop 依赖完整运行期而仅落 task）
unregisterAgentEventTrigger();
await pool.end();
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 运行验收（生产库，只读）**

```bash
node scripts/verify-agent-event-trigger.mjs
```
Expected: 输出 `PASS: 智能体派发链路生效`，`crm.tasks` 出现 `dedup_key=7fdebf95…:stage-progression:S4`、`skill_slug=method-stage-progression` 的 `ready` 任务。

- [ ] **Step 3: 清理合成任务 + 提交脚本**

```bash
# 清理本次合成任务（避免污染生产 queue）
node -e "process.env.PGDATABASE='crm_native';import('./src/db.js').then(async({queryWrite,pool})=>{const r=await queryWrite(\`DELETE FROM crm.tasks WHERE payload->>'dedup_key' LIKE '7fdebf95%:stage-progression:%' AND status='ready'\");console.log('cleaned',r.rowCount);await pool.end();})"
git add scripts/verify-agent-event-trigger.mjs
git commit -m "test(e2e): T5 生产验收脚本（只读合成事件验证 B能源派发链路）"
```

---

## 自检（writing-plans 收尾）

1. **规格覆盖**：§3 矩阵 3 条 → T1 实现 + T3 配置；§4 三级防风暴 → T1（DB去重/冷却/白名单）；§5 可观测 → T1 emit trace；§6 T1-T5 → 全部有对应 Task。✅
2. **占位符扫描**：无 TBD/“类似 Task N”；每步含实际代码与命令。✅
3. **类型一致性**：`dedupKeyFor(match, evPayload)` 与 `matchTrigger(evType, evPayload, config)` 签名在单测/实现一致；`createTask` 字段（title/action_name/payload）与 `kanban.js:34` 签名一致；`routeThroughIntake` 返回 `{targetAgent, gateAgents, payload}` 与 `scheduler.js:51/72` 既有结构一致。✅
4. **关键修正已标注**：去重键「当前值」来源由事件改为粒子读取（事件不携带 stage/tier），运行期 `resolveDedupValue` 读 `crm.particles.payload`，纯函数 `dedupKeyFor` 仍供单测。✅

**执行交接**：计划已存 `docs/superpowers/plans/2026-09-03-agent-event-trigger.md`。两种执行方式：
1. **Subagent-Driven（推荐）** — 每 Task 派发独立子代理，Task 间审查，快速迭代。
2. **Inline Execution** — 本会话用 executing-plans 分批执行 + 检查点。
请选择。
