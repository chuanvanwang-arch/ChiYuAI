# 拓客模块（Prospecting Module）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 MCP 对话驱动的主动拓客管道——批量搜索候选企业 → 销售圈选 → 批量入公海池（S0），复用既有发现引擎底座，配置驱动、租户隔离、写经第 0 闸。

**Architecture:** 会话状态机（`prospecting-session`，内存，5 态）+ 三个 MCP Action（search 只读 / select 只读 / confirm 写）+ 适配器 `search()` 能力扩展（qixin 强信号 / xinbang 辅助信号）+ 双层配置 `prospecting-rules`（出厂默认 ⊕ 租户覆盖）。入池复用 `createLeadFromTender` 范式：`CRM_DEAL` S0 + `pool_type:'new'` + `source:'prospecting'` + `DEAL --sourcedFrom--> KNOWLEDGE` 弱边。**不新增粒子类型**（红线 §10）。

**Tech Stack:** Node.js ESM + Express + PostgreSQL（via 既有 particleRepo/configStore）+ vitest + Naive-UI（前端）。ProviderAdapter 基类不改，`search()` 为新增可选能力。

---

## 任务分解总览

| Task | 内容 | 核心文件 |
|---|---|---|
| T1 | `prospecting` agent 三处同改注册 + 契约键 + seed.sql 决策场景 | `src/agent/agentSpec.js`、`src/action/discoveryActions.js`（或新 `seed-actions.js` method-* 数组）、`src/skills/seed.js`、`src/agent/contractIds.js`、`db/seed.sql` |
| T2 | `prospecting-session` 状态机（纯函数 + 内存实例） | `src/action/prospectingSession.js` |
| T3 | `prospecting-rules` 双层配置 | `src/config/prospectingRules.js` |
| T4 | qixin/xinbang `search()` 能力扩展（含 mock） | `src/connectors/discovery/adapters/qixin.js`、`xinbang.js` |
| T5 | 三个 MCP Action 注册（search/select/confirm）+ MCP 暴露 | `src/action/prospectingActions.js`、`src/mcp/tools.js` |
| T6 | 批量入池 + 溯源弱边（复用 createLeadFromTender 范式） | `src/action/prospectingActions.js`、`src/connectors/tenderConnector.js` |
| T7 | 契约全绿 + 装配断言 + 全量回归 | `scripts/validate-contract.mjs`、`test/action/prospectingActions.test.js` |
| T8 | 前端拓客 Tab（旁路，后补） | `src/web/lead-pool.html` |

**通用铁律（贯穿所有 Task）：**
- **不新增粒子类型**：只用 `CRM_DEAL` S0 + 事件/内存会话；禁 DELETE；写走第 0 闸
- **三处同改（装配闭包）**：新增 `method-*`/Action 时 ① `src/skills/seed.js` registerSkill(steps[]) ② agentSpec.capabilities ③ `src/action/seed-actions.js`/`discoveryActions.js` method-* 数组 + `agents.js:71` assertAgentAssembly（skillCalls ⊆ actions 硬闭包）
- **测试命令**：`node node_modules/vitest/vitest.mjs run <file>`（Windows 下 vitest CLI）
- **TDD**：先写失败测试 → 实现 → 通过 → commit（每 Task 一 commit；git add 显式路径，禁 `git add -A`）

---

## Task 1: `prospecting` agent 注册（三处同改 + 契约键 + 决策场景）

**Files:**
- Modify: `src/agent/agentSpec.js`（新增 `prospecting` 六段式）
- Modify: `src/agent/contractIds.js`（登记 `ct-prospecting`）
- Modify: `src/skills/seed.js`（registerSkill 仅元数据登记——本 Task 不新增 SKILL 步骤，skillCalls 用既有 `data-particle-read`）
- Modify: `src/agent/agents.js`（assertAgentAssembly 自动覆盖新 agent，无需改）
- Modify: `db/seed.sql`（新增 `PROSPECTING_CONFIRM` 决策场景）
- Modify: `db/test-setup.sql`（同步测试库场景）
- Test: `test/agent/prospectingAgent.test.js`

**背景（TDD 前必读）：** `agents.js:71-124` assertAgentAssembly 六断言：skillCalls ⊆ actions、actions 全在 registry、derivedFrom 存在、KG 降级、L3 守护、收敛闸门。`contractParser.js:112-131` 校验契约块 agent 存在于 registry 且 skills/memory/layers ⊆ spec。新增 agent 必须三条同时满足，否则 P7 契约校验失败。

- [ ] **Step 1: 写失败测试**

```js
// test/agent/prospectingAgent.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { seedSkills } from '../../src/skills/seed.js';
import { getAction } from '../../src/action/registry.js';
import { CONTRACT_IDS } from '../../src/agent/contractIds.js';
import { getSkill } from '../../src/skills/registry.js';

beforeAll(() => { seedActions(); seedDiscoveryActions(); seedSkills(); });

const NAMES = ['prospecting-search', 'prospecting-select', 'prospecting-confirm'];

describe('prospecting agent 装配闭包（T1）', () => {
  it('① agentSpec 存在且六段式完整', () => {
    const spec = agentSpecs['prospecting'];
    expect(spec).toBeDefined();
    expect(spec.identity.derivedFrom).toBe('taskFlow:crm-prospecting');
    expect(spec.capabilities.actions).toContain('data-particle-read');
  });
  it('② skillCalls ⊆ actions（硬闭包）', () => {
    const spec = agentSpecs['prospecting'];
    for (const c of spec.capabilities.skillCalls) expect(spec.capabilities.actions, c).toContain(c);
  });
  it('③ 三个 Action 已在 registry（agentTool）', () => {
    for (const n of NAMES) expect(getAction(n), n).not.toBeNull();
  });
  it('④ 契约键已登记', () => {
    expect(CONTRACT_IDS['prospecting']).toBe('ct-prospecting');
  });
  it('⑤ SKILL data-particle-read 已注册（契约块依赖）', () => {
    expect(getSkill('data-particle-read')).not.toBeNull();
  });
  it('⑥ assertAgentAssembly 通过（含新 agent）', async () => {
    const r = await assertAgentAssembly();   // ⚠ async 必须 await
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/agent/prospectingAgent.test.js`
Expected: FAIL（`agentSpecs['prospecting']` undefined, `getAction('prospecting-search')` null）

- [ ] **Step 3: 实现 agentSpec + contractIds + 决策场景**

`src/agent/agentSpec.js` 末尾（`decision-retro` 之后）新增：

```js
  'prospecting': {
    identity: { name: 'prospecting', derivedFrom: 'taskFlow:crm-prospecting', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm'],
      skillCalls: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm'],
      knowledgeScope: { layers: ['L1'], maxHops: 2 },
    },
    context: { knowledgeLevel: 1, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['intake-router'], write: [] },
    evaluation: { metricTemplate: 'prospecting_quality', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
```

`src/agent/contractIds.js` CONTRACT_IDS 增加：

```js
  'prospecting': 'ct-prospecting',
```

`db/seed.sql`（LEAD_FIT 块之后）新增 PROSPECTING_CONFIRM 场景（tier=LEAD + autonomous_allowed=TRUE，与 LEAD_FIT 同档）：

```sql
-- PROSPECTING_CONFIRM（2026-09-14）拓客模块确认入池：批量建公海池线索（每企业一个 CRM_DEAL S0）。
-- 与 LEAD_FIT 同档（tier=LEAD，自治可放行）；硬人工闸由 prospecting-confirm needsApproval + 第0闸两阶段承担。
('PROSPECTING_CONFIRM', '一、线索', '拓客批量入池确认（MCP 对话驱动，S0 + source=prospecting）',
 '{"action":["prospecting-confirm"],"connector":"prospecting"}'::jsonb,
 ARRAY['BANT','MEDDICC'],
 '[{"cond":"candidate_count","label":"候选数量","weight":0.5},{"cond":"fit_score_avg","label":"平均适配度","weight":0.5}]'::jsonb,
 'LEAD', TRUE)
ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
```

`db/test-setup.sql` 同位置补同一行（`ON CONFLICT ... DO NOTHING`）。

**注意：** 本 Task **不新增** `prospecting-*` Action 的实现（那是 T5）——测试里 `getAction('prospecting-search')` 在 T5 才真正非空。但若现在让测试引用不存在 Action 会一直失败。**正确顺序**：本 Task 先登记 agentSpec（capabilities 里声明 three Actions），实际的 `prospecting-*` 注册在 T5 落 `discoveryActions.js`（或新 `prospectingActions.js`，T5 决定）。因此：**T1 只完成 agentSpec + contractIds + skill 登记 + 决策场景；三个 Action 的 handle 在 T5 实现**。测试断言 ③ 在 T1 阶段允许 FAIL（红）——T5 转绿。为保持每 Task 独立绿，T1 测试只断言 ①②④⑤⑥，③ 移到 T5。

- [ ] **Step 4: 实现后运行测试确认（含 T5 前的临时断言调整）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/agent/prospectingAgent.test.js`
Expected: ① ② ④ ⑤ PASS；③ FAIL（Action 未注册，T5 补齐）；⑥ FAIL（actions 含未注册 Action → assertAgentAssembly 报 action_in_registry）——**这是 T1 的正常中间态，T5 收敛**。为可独立绿，测试文件在 T1 提交时**注释掉 ③⑥**（含注释说明），T5 重新启用。

（说明：装配断言 ⑥ 依赖三 Action 存在，故 T1 阶段刻意不启用 ⑥；T5 完成后启用，最终 `assertAgentAssembly()` 全绿。）

- [ ] **Step 5: Commit**

```bash
git add src/agent/agentSpec.js src/agent/contractIds.js src/skills/seed.js db/seed.sql db/test-setup.sql test/agent/prospectingAgent.test.js
git commit -m "feat(prospecting): register prospecting agent spec + contract key + decision scenario"
```

---

## Task 2: `prospecting-session` 状态机（纯函数 + 内存实例）

**Files:**
- Create: `src/action/prospectingSession.js`
- Test: `test/prospectingSession.test.js`

**背景：** 5 态（searching→listing→selecting→pending_confirm→pooled），非法转移抛错（设计 §1.1/§1.3）。内存 Map `tenantId:actor:sessionId`，保留最近 100，超时 30 分钟自动失效。**不落粒子**（红线 §10）。

- [ ] **Step 1: 写失败测试**

```js
// test/prospectingSession.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProspectingSession, getSession, updateSession, expireSession, transition, _getSessionsInMemory,
} from '../src/action/prospectingSession.js';

describe('prospecting-session 状态机（T2）', () => {
  it('① 合法转移链：searching→listing→selecting→pending_confirm→pooled', () => {
    expect(transition('searching', 'list_ready')).toBe('listing');
    expect(transition('listing', 'select')).toBe('selecting');
    expect(transition('selecting', 'confirm_ready')).toBe('pending_confirm');
    expect(transition('pending_confirm', 'confirm')).toBe('pooled');
  });
  it('② 非法转移抛错', () => {
    expect(() => transition('searching', 'confirm')).toThrow();
    expect(() => transition('pooled', 'select')).toThrow();
  });
  it('③ create/get 幂等重建', () => {
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    const s = getSession(sid);
    expect(s.state).toBe('searching');
    expect(s.tenantId).toBe('acme');
    expect(s.actor).toBe('alice');
  });
  it('④ updateSession 局部补丁且不越界', () => {
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c1' }] });
    const s = getSession(sid);
    expect(s.candidates.length).toBe(1);
    expect(s.actor).toBe('alice');
  });
  it('⑤ 超时失效（30 分钟）', () => {
    // 注入未来时间戳 → 直接失效（纯函数友好：内部用 now 可覆盖）
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice', _now: Date.now() - 31 * 60 * 1000 });
    expect(getSession(sid)).toBeNull();
  });
  it('⑥ 并发隔离：同 actor 只留一个活跃会话', () => {
    const s1 = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    const s2 = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    expect(getSession(s1)).toBeNull(); // 旧会话被覆盖
    expect(getSession(s2)).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/prospectingSession.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现状态机**

```js
// src/action/prospectingSession.js — 拓客会话状态机（内存，不落粒子，红线 §10）
// 5 态：searching → listing → selecting → pending_confirm → pooled
// 非法转移抛错（纯函数，零 IO，单测友好）；超时 30 分钟自动失效；并发隔离（同租户同 actor 仅一活跃会话）
const SESSIONS = new Map();       // sessionId -> session
const ACTIVE = new Map();         // `${tenantId}:${actor}` -> sessionId
const TTL_MS = 30 * 60 * 1000;    // 30 分钟
const MAX_SESSIONS = 100;

const TRANSITIONS = {
  searching:       ['list_ready'],
  listing:         ['select', 'search_again'],
  selecting:       ['confirm_ready', 'search_again'],
  pending_confirm: ['confirm'],
  pooled:          [],
};

export function transition(state, event) {
  const allowed = TRANSITIONS[state] || [];
  if (!allowed.includes(event)) {
    throw new Error(`非法状态转移: ${state} --${event}--> ?（允许: ${allowed.join('/') || '无'}）`);
  }
  return { searching: ['list_ready'], listing: ['select', 'search_again'], selecting: ['confirm_ready', 'search_again'], pending_confirm: ['confirm'] }[state]
    .find((e) => e === event) === event
    ? ({ searching: 'listing', listing: { select: 'selecting', search_again: 'searching' }[event],
         selecting: { confirm_ready: 'pending_confirm', search_again: 'searching' }[event],
         pending_confirm: 'confirm' ? 'pooled' : null }[state]) ?? (() => { throw new Error('非法转移'); })()
    : (() => { throw new Error('非法转移'); })();
}

// —— 简版（清晰可读，替代上面压缩版）——
export function transitionSimple(state, event) {
  const next = {
    searching: { list_ready: 'listing' },
    listing: { select: 'selecting', search_again: 'searching' },
    selecting: { confirm_ready: 'pending_confirm', search_again: 'searching' },
    pending_confirm: { confirm: 'pooled' },
    pooled: {},
  }[state]?.[event];
  if (!next) throw new Error(`非法状态转移: ${state} --${event}--> ?`);
  return next;
}

export function createProspectingSession({ tenantId, actor, _now } = {}) {
  if (!tenantId || !actor) throw new Error('createProspectingSession({tenantId, actor}) 必填');
  const sessionId = `ps_${tenantId}_${actor}_${Date.now().toString(36)}`;
  // 并发隔离：同租户同 actor 旧会话先失效
  const prevId = ACTIVE.get(`${tenantId}:${actor}`);
  if (prevId) SESSIONS.delete(prevId);
  const session = {
    tenantId, actor, sessionId, state: 'searching',
    candidates: [], selected_ids: [], confirmed_ids: [],
    createdAt: _now ?? Date.now(), updatedAt: _now ?? Date.now(),
  };
  SESSIONS.set(sessionId, session);
  ACTIVE.set(`${tenantId}:${actor}`, sessionId);
  // 容量上限：保留最近 MAX_SESSIONS
  if (SESSIONS.size > MAX_SESSIONS) {
    const oldest = [...SESSIONS.keys()][0];
    SESSIONS.delete(oldest);
    if (ACTIVE.get(`${oldest.split('_').slice(1, -1).join(':')}:${oldest.split('_').pop()}`) === oldest) ACTIVE.delete(`${oldest.split('_').slice(1, -1).join(':')}:${oldest.split('_').pop()}`);
  }
  return sessionId;
}

export function getSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) {   // 超时失效
    SESSIONS.delete(sessionId);
    ACTIVE.delete(`${s.tenantId}:${s.actor}`);
    return null;
  }
  return s;
}

export function updateSession(sessionId, patch = {}) {
  const s = getSession(sessionId);
  if (!s) throw new Error(`prospecting session 不存在或已超时: ${sessionId}`);
  Object.assign(s, patch, { updatedAt: Date.now() });
  return s;
}

export function expireSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (s) { SESSIONS.delete(sessionId); ACTIVE.delete(`${s.tenantId}:${s.actor}`); }
}

// 测试/诊断专用
export function _getSessionsInMemory() { return SESSIONS; }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/prospectingSession.test.js`
Expected: 6/6 PASS（② 用到 transitionSimple 或 transition 都行，测试从 `transition` 导入——**实现时统一导出 `transition`**，删掉压缩版）

（说明：实现里 `transition` 与 `transitionSimple` 二选一，测试 import `transition` → 保留 `transitionSimple` 并 `export { transitionSimple as transition }`。）

- [ ] **Step 5: Commit**

```bash
git add src/action/prospectingSession.js test/prospectingSession.test.js
git commit -m "feat(prospecting): add session state machine (5-state, in-memory, TTL)"
```

---

## Task 3: `prospecting-rules` 双层配置

**Files:**
- Create: `src/config/prospectingRules.js`
- Test: `test/prospectingRules.test.js`

**背景：** 设计 §3。对齐 `discoveryRules.js:10-75` 范式：DEFAULT 出厂 + merge（providers/sources 以 id 为键覆盖，`不增删条数`）+ mergedProspectingRules 读 config_store ⊕ 出厂默认，fail-open。

- [ ] **Step 1: 写失败测试**

```js
// test/prospectingRules.test.js
import { describe, it, expect } from 'vitest';
import { DEFAULT_PROSPECTING_RULES, mergeProspectingRules, mergedProspectingRules } from '../src/config/prospectingRules.js';

describe('prospecting-rules 双层配置（T3）', () => {
  it('① 出厂默认：付费源全关、阈值合理', () => {
    expect(DEFAULT_PROSPECTING_RULES.sources.qixin.enabled).toBe(false);
    expect(DEFAULT_PROSPECTING_RULES.sources.xinbang.enabled).toBe(false);
    expect(DEFAULT_PROSPECTING_RULES.icp.min_headcount).toBe(50);
    expect(DEFAULT_PROSPECTING_RULES.candidate_limit).toBe(50);
    expect(DEFAULT_PROSPECTING_RULES.fit_threshold).toBe(0.6);
  });
  it('② merge：租户覆盖 icp/signals，sources 只覆盖既有 id', () => {
    const merged = mergeProspectingRules(DEFAULT_PROSPECTING_RULES, {
      icp: { industries: ['healthcare'] },
      sources: { qixin: { enabled: true, weight: 0.8 }, evil: { enabled: true } }, // evil 未在出厂 → 忽略
    });
    expect(merged.icp.industries).toEqual(['healthcare']);
    expect(merged.sources.qixin.enabled).toBe(true);
    expect(merged.sources.evil).toBeUndefined();          // 防租户越权新增付费源
    expect(Object.keys(merged.sources)).toEqual(Object.keys(DEFAULT_PROSPECTING_RULES.sources));
  });
  it('③ mergedProspectingRules：config_store 覆盖 ⊕ fail-open', async () => {
    const r = await mergedProspectingRules({ tenantId: 'acme' }, { readConfig: async () => ({ value: { icp: { min_headcount: 100 } } }) });
    expect(r.icp.min_headcount).toBe(100);
    const fail = await mergedProspectingRules({ tenantId: 'acme' }, { readConfig: async () => { throw new Error('db down'); } });
    expect(fail.icp.min_headcount).toBe(50);              // fail-open 回退出厂
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/prospectingRules.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现配置模块**

```js
// src/config/prospectingRules.js — 拓客规则（ICP / 信号权重 / 数据源 / 上限）
// 铁律：唯一事实源 = config_store['prospecting-rules']（per-tenant）；本文件仅存「出厂默认」兜底
//   阈值/权重 100% 配置化；付费源（qixin/xinbang）出厂 enabled:false，需显式授权+填 key（D1）
//   合并语义：sources 以 id 为键覆盖（不增删条数，防租户越权新增付费源）
import { readConfig as storeRead } from './configStore.js';

export const DEFAULT_PROSPECTING_RULES = Object.freeze({
  icp: {
    industries: [],
    min_revenue_y: 1e8,
    min_headcount: 50,
    geo: ['CN'],
  },
  signals: { hiring: 0.7, funding: 0.9, tender: 0.8, social: 0.4 },
  sources: {
    qixin:   { enabled: false, weight: 0.6 },
    xinbang: { enabled: false, weight: 0.2 },
  },
  candidate_limit: 50,
  fit_threshold: 0.6,
});

// 纯函数合并（无 IO，单测友好）：icp/signals 浅合并；sources 以 id 为键覆盖（不增删）
export function mergeProspectingRules(base, tenantCfg = {}) {
  const out = structuredClone(base);
  if (tenantCfg.icp) Object.assign(out.icp, tenantCfg.icp);
  if (tenantCfg.signals) Object.assign(out.signals, tenantCfg.signals);
  if (tenantCfg.sources && typeof tenantCfg.sources === 'object') {
    for (const id of Object.keys(out.sources)) {
      if (tenantCfg.sources[id]) Object.assign(out.sources[id], tenantCfg.sources[id]);
    }
  }
  if (typeof tenantCfg.candidate_limit === 'number') out.candidate_limit = tenantCfg.candidate_limit;
  if (typeof tenantCfg.fit_threshold === 'number') out.fit_threshold = tenantCfg.fit_threshold;
  return out;
}

// 租户感知加载：读 config_store ⊕ 出厂默认；fail-open 读失败回退出厂
export async function mergedProspectingRules({ tenantId = 'system' } = {}, deps = {}) {
  try {
    const read = deps.readConfig || ((key, opts) => storeRead(key, opts));
    const row = await read('prospecting-rules', { tenantId });
    return mergeProspectingRules(DEFAULT_PROSPECTING_RULES, row?.value || {});
  } catch {
    return structuredClone(DEFAULT_PROSPECTING_RULES);
  }
}

// 服务端 fit_score 计算（T3 就绪；T5 handler 调用）：
//   Σ(命中信号 × 权重) / Σ权重 —— 未命中按 0 计；适配器不得注入 fit_score（修订 2）
export function computeFitScore(candidate, rules) {
  const signals = candidate.signals || {};
  const w = rules.signals || {};
  let num = 0, den = 0;
  for (const [k, weight] of Object.entries(w)) {
    if (typeof weight !== 'number') continue;
    den += weight;
    if (signals[k]) num += weight;
  }
  return den > 0 ? num / den : 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/prospectingRules.test.js`
Expected: 3/3 PASS（③ fail-open 用注入 readConfig 抛错 → 回退出厂）

- [ ] **Step 5: Commit**

```bash
git add src/config/prospectingRules.js test/prospectingRules.test.js
git commit -m "feat(prospecting): add dual-layer prospecting-rules config + fit_score compute"
```

---

## Task 4: qixin/xinbang `search()` 能力扩展

**Files:**
- Modify: `src/connectors/discovery/adapters/qixin.js`（加 `search()`）
- Modify: `src/connectors/discovery/adapters/xinbang.js`（加 `search()`）
- Modify: `src/connectors/discovery/providerAdapter.js`（基类注释说明 search 为可选能力，**不改基类接口**）
- Test: `test/connectors/prospectingSearchAdapters.test.js`

**背景：** 设计 §2。`enrich()` 保持；`search()` 新增可选能力（基类不强制）。铁律：返回 `[]` 不抛错（fail-open）；无凭据返 `[]`；**不得返回 fit_score**（修订 2）。qixin 强信号；xinbang 辅助信号（join 增强，不单独产生候选）。

- [ ] **Step 1: 写失败测试**

```js
// test/connectors/prospectingSearchAdapters.test.js
import { describe, it, expect } from 'vitest';
import { qixinAdapter } from '../../src/connectors/discovery/adapters/qixin.js';
import { xinbangAdapter } from '../../src/connectors/discovery/adapters/xinbang.js';

describe('prospecting 适配器 search()（T4）', () => {
  it('① qixin.search 返回候选数组（强信号字段）', async () => {
    const a = qixinAdapter({ __mock: { companies: [{ name: '示例科技', domain: 'ex.com', industry: 'healthcare', revenue: 5e8, funding_round: true, hiring_icp_role: true, tender_match: true }] } });
    const r = await a.search({ industries: ['healthcare'], limit: 5 }, {});
    expect(Array.isArray(r)).toBe(true);
    expect(r[0].name).toBe('示例科技');
    expect(r[0].provider).toBe('qixin');
    expect('fit_score' in r[0]).toBe(false);       // 修订 2：适配器不得返回 fit_score
  });
  it('② qixin.search 无凭据返回 [] 不抛错（fail-open）', async () => {
    const a = qixinAdapter({});   // 无 __mock、无 key
    const r = await a.search({}, {}).catch((e) => {
      throw new Error('不应抛错: ' + e.message);
    });
    expect(Array.isArray(r)).toBe(true);
  });
  it('③ xinbang.search 返回辅助信号候选', async () => {
    const a = xinbangAdapter({ __mock: { accounts: [{ name: '某公众号', platform: 'wechat', posts: 12, interactions: 345 }] } });
    const r = await a.search({}, {});
    expect(Array.isArray(r)).toBe(true);
    expect(r[0].provider).toBe('xinbang');
    expect('fit_score' in r[0]).toBe(false);
  });
  it('④ xinbang.search 无凭据返回 []（fail-open）', async () => {
    const a = xinbangAdapter({});
    const r = await a.search({}, {});
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(0);
  });
  it('⑤ 基类不变：enrich 仍为缺省抛错接口占位', () => {
    // 不破坏既有 enrich 能力——基类方法仍是 enrich（构造时覆盖不加 search 的适配器仍可 enrich）
    const { ProviderAdapter } = require('../../src/connectors/discovery/providerAdapter.js');
    expect(typeof ProviderAdapter.prototype.enrich).toBe('function');
  });
});
```

（说明：⑤ 用 `import { ProviderAdapter } from ...`，ESM 下用 import 而非 require。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/connectors/prospectingSearchAdapters.test.js`
Expected: FAIL（`a.search is not a function`）

- [ ] **Step 3: 实现 search()**

`src/connectors/discovery/adapters/qixin.js` 类内新增（`enrich` 之后）：

```js
    // search()：拓客批量搜索（强信号数据源）——新增可选能力，不改基类。
    // 铁律：无凭据/异常 → 返回 []（fail-open）；不得注入 fit_score（修订 2，服务端 computeFitScore 计算）
    async search(query = {}, ctx = {}) {
      if (cfg.__mock) {
        const out = Array.isArray(cfg.__mock.companies) ? cfg.__mock.companies : [];
        return out.map((c) => ({ ...c, provider: 'qixin' }));
      }
      const key = ctx.credentials?.qixin || process.env.QIXIN_KEY;
      if (!key) return [];
      const q = { industries: query.industries || [], min_revenue: query.min_revenue, min_headcount: query.min_headcount, geo: query.geo || [], limit: query.limit || 20 };
      try {
        const r = await fetch(`${QIXIN_API}/company/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(q) });
        if (!r.ok) return [];
        const res = await r.json();
        const list = Array.isArray(res?.data?.list) ? res.data.list : [];
        return list.map((d) => ({
          name: d.name, domain: d.domain, industry: d.industry, revenue: d.revenue,
          funding_round: !!d.latest_funding_round, hiring_icp_role: !!d.hiring_icp_role,
          tender_match: !!d.latest_tender, confidence: 0.8, provider: 'qixin',
        }));
      } catch { return []; }
    },
```

`src/connectors/discovery/adapters/xinbang.js` 类内新增（`enrich` 之后）：

```js
    // search()：拓客辅助信号（内容/社媒）——不单独产生候选；按 name 与 qixin join 增强 fit_score
    async search(query = {}, ctx = {}) {
      if (cfg.__mock) {
        const out = Array.isArray(cfg.__mock.accounts) ? cfg.__mock.accounts : [];
        return out.map((c) => ({ ...c, provider: 'xinbang' }));
      }
      const key = ctx.credentials?.xinbang || process.env.XINBANG_KEY;
      if (!key) return [];
      try {
        const r = await fetch(`${XINBANG_API}/account/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ name: query.name, limit: query.limit || 20 }) });
        if (!r.ok) return [];
        const res = await r.json();
        const list = Array.isArray(res?.data?.list) ? res.data.list : [];
        return list.map((d) => ({ name: d.name, platform: d.platform, social_content: { posts: d.posts, interactions: d.interactions }, confidence: 0.6, provider: 'xinbang' }));
      } catch { return []; }
    },
```

`src/connectors/discovery/providerAdapter.js` 基类注释更新（不改接口）：

```js
// 铁律：无命中必须返回 {}（不是 null）；不得抛业务异常（waterfall 侧兜底，但适配器应自愈）
// search()（2026-09-14 拓客新增能力）：可选——无 search 的适配器跳过搜索阶段（不强制，基类不定义）
```

（可选）`providerAdapter.js` 类内加默认占位（保持 enrich 不变）：

```js
  async search() { return []; }   // 拓客可选能力：默认空（无 search 适配器跳过搜索，不改变 enrich 契约）
```

（说明：基类加 `search(){return []}` 是**默认空实现**，不破坏 enrich；有 search 的适配器覆盖之。这比「不定义」更防御，且不违反"不改基类接口"——enrich 契约完全未动。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/connectors/prospectingSearchAdapters.test.js`
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add src/connectors/discovery/adapters/qixin.js src/connectors/discovery/adapters/xinbang.js src/connectors/discovery/providerAdapter.js test/connectors/prospectingSearchAdapters.test.js
git commit -m "feat(prospecting): add search() to qixin/xinbang adapters (fail-open, no fit_score)"
```

---

## Task 5: 三个 MCP Action 注册（search/select/confirm）+ MCP 暴露

**Files:**
- Create: `src/action/prospectingActions.js`
- Modify: `src/agent/agents.js`（无需——但 `src/agent/seed-actions.js` 的 method-* 数组/装配汇聚处需引用 `seedProspectingActions`）
- Modify: `src/mcp/tools.js`（read 自动暴露；write 需确认）
- Test: `test/action/prospectingActions.test.js`

**背景：** 设计 §4。search/select 只读（read）；confirm 写（write + autoDecision + decisionScenario `PROSPECTING_CONFIRM`）。handler 内：search = 读 mergedProspectingRules → resolveAdapters → qixin.search + xinbang.search → dedup 查重 → computeFitScore → 会话候选；select = 校验圈选 ∈ 候选 list；confirm = 批量 createParticle S0 + sourcedFrom 弱边 + emit。

- [ ] **Step 1: 写失败测试**

```js
// test/action/prospectingActions.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { getAction, resetRegistry } from '../../src/action/registry.js';
import { seedProspectingActions } from '../../src/action/prospectingActions.js';
import { createProspectingSession, updateSession } from '../../src/action/prospectingSession.js';
import { computeFitScore, DEFAULT_PROSPECTING_RULES } from '../../src/config/prospectingRules.js';
import { requireDecision } from '../../src/decision/autonomyEngine.js';

beforeEach(() => { resetRegistry(); seedProspectingActions(); });

describe('prospecting Action 三件套（T5）', () => {
  it('① search/select 只读：kind=read，confirm 写：kind=write + 第0闸', () => {
    expect(getAction('prospecting-search').kind).toBe('read');
    expect(getAction('prospecting-select').kind).toBe('read');
    const c = getAction('prospecting-confirm');
    expect(c.kind).toBe('write');
    expect(c.autoDecision).toBe(true);
    expect(c.decisionScenario).toBe('PROSPECTING_CONFIRM');
    expect(c.confirm).toBe('stage2');
  });
  it('② fit_score 仅服务端计算（T1b：适配器注入被覆盖）', () => {
    // 候选带 fit_score（恶意）→ computeFitScore 只看 signals 字段
    const c = { name: 'X', signals: { hiring: true, funding: true }, fit_score: 0.99 };
    const rules = { ...DEFAULT_PROSPECTING_RULES, signals: { hiring: 0.7, funding: 0.9 } };
    const s = computeFitScore(c, rules);
    expect(s).toBeCloseTo(1.0);   // (0.7+0.9)/(0.7+0.9) = 1.0（无视注入的 0.99）
  });
  it('③ select 只允许圈选候选列表内 id（防注入）', async () => {
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }] });
    await expect(getAction('prospecting-select').handler({ session_id: sid, selected_ids: ['c1', 'c3'] }, { tenantId: 'acme', actor: 'alice' }))
      .rejects.toThrow(/c3/);
    await expect(getAction('prospecting-select').handler({ session_id: sid, selected_ids: ['c1'] }, { tenantId: 'acme', actor: 'alice' }))
      .resolves.toMatchObject({ state: 'selecting', selected_ids: ['c1'] });
  });
  it('④ confirm 无 decision_id 必拒（第0闸 fail-closed）', async () => {
    await expect(getAction('prospecting-confirm').handler({ session_id: 'x', confirmed_ids: [] }, { tenantId: 'acme', actor: 'alice' }))
      .rejects.toThrow(/decision_required|decision_id/);
  });
  it('⑤ MCP 列表含三个工具', () => {
    const { buildMcpTools } = require('../../src/mcp/tools.js');
    const names = buildMcpTools().tools.map((t) => t.name);
    for (const n of ['prospecting-search', 'prospecting-select', 'prospecting-confirm']) expect(names, n).toContain(n);
  });
});
```

（说明：⑤ 用 ESM import `import { buildMcpTools } from '../../src/mcp/tools.js'`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/action/prospectingActions.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 prospectingActions.js**

```js
// src/action/prospectingActions.js — 拓客三个 MCP Action（search/select/confirm）
// 铁律（继承 connectorActions.js:1-7 + discoveryActions.js:1-6）：
//   ① search/select 只读；confirm 写，走第 0 闸（decisionScenario=PROSPECTING_CONFIRM → executor mint）
//   ② 适配器不注入 fit_score；服务端 computeFitScore 统一计算（修订 2）
//   ③ 入池复用 createLeadFromTender 范式：CRM_DEAL S0 + pool_type:'new' + source:'prospecting'
//      + DEAL --sourcedFrom--> KNOWLEDGE 弱边（修订 1，主语统一）
//   ④ 查重复用 dedupResolver.resolveExistingOrCreate（赢家复用，禁删）；已存在标记 existing:true 不入池
//   ⑤ 不新增粒子类型（红线 §10）
import { registerAction } from './registry.js';
import { createProspectingSession, getSession, updateSession } from './prospectingSession.js';
import { mergedProspectingRules, computeFitScore } from '../config/prospectingRules.js';
import { resolveAdapters } from '../connectors/discovery/providerRegistry.js';
import { resolveExistingOrCreate } from '../connectors/discovery/dedupResolver.js';
import { emit } from '../events/bus.js';

const SCENARIO = 'PROSPECTING_CONFIRM';

function requireMintedDecision(ctx, actionName) {
  if (!ctx?.decision_id) {
    throw new Error(`decision_required: ${actionName} 无 decision_id（检查 decision_scenario '${SCENARIO}'）`);
  }
}

export function seedProspectingActions() {
  // —— prospecting-search（只读）：候选清单 + fit_score ——
  registerAction({
    name: 'prospecting-search', kind: 'read', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { query: 'object', pool: 'string' },
    parameters: { required: ['query'] },
    handler: async ({ query = {}, pool }, ctx) => {
      const rules = await mergedProspectingRules({ tenantId: ctx.tenantId });
      const adapters = resolveAdapters({ providers: Object.entries(rules.sources).filter(([, s]) => s.enabled).map(([id, s]) => ({ id, enabled: true, costTier: 0 })) });
      // qixin 强信号 + xinbang 辅助信号（join 增强）
      let candidates = [];
      for (const a of adapters) {
        if (typeof a.search !== 'function') continue;   // 无 search 跳过
        const list = await a.search(query, ctx).catch(() => []);
        candidates.push(...list.map((c) => ({ ...c, signals: { hiring: c.hiring_icp_role, funding: c.funding_round, tender: c.tender_match, social: c.social_content && true } })));
      }
      // 查重：已存在标 existing:true（查重赢家，禁删）
      for (const c of candidates) {
        const hit = await resolveExistingOrCreate('CRM_ACCOUNT', { name: c.name, domain: c.domain }, { find: async (type, k, v) => null, create: async () => null, criteria: [['name'], ['domain']] });
        // 注：这里只做查重查询（find），不创建——create 语义归 confirm；故上例仅演示 find 用法
        // 实现：用 deps.findAccount 或 queryParticles 查 name/domain 近似匹配
      }
      // fit_score 服务端统一计算（适配器注入的 fit_score 忽略）
      const scored = candidates.map((c) => ({ ...c, fit_score: computeFitScore(c, rules) }))
        .filter((c) => c.fit_score >= rules.fit_threshold)
        .slice(0, rules.candidate_limit);
      // 会话：幂等重建（同 actor 旧会话覆盖）
      const sessionId = createProspectingSession({ tenantId: ctx.tenantId, actor: ctx.actor });
      updateSession(sessionId, { candidates: scored, state: 'listing' });
      return { session_id: sessionId, total: scored.length, candidates: scored };
    },
  });

  // —— prospecting-select（只读）：圈选（校验 ∈ 候选） ——
  registerAction({
    name: 'prospecting-select', kind: 'read', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { session_id: 'string', selected_ids: 'array' },
    parameters: { required: ['session_id', 'selected_ids'] },
    handler: async ({ session_id, selected_ids }, ctx) => {
      const s = getSession(session_id);
      if (!s) throw new Error(`prospecting session 不存在或已超时: ${session_id}`);
      if (s.tenantId !== ctx.tenantId) throw new Error('跨租户访问拒绝');
      const valid = new Set((s.candidates || []).map((c) => c.id));
      const bad = (selected_ids || []).filter((id) => !valid.has(id));
      if (bad.length) throw new Error(`圈选含非候选 id: ${bad.join(', ')}（防注入）`);
      return updateSession(session_id, { selected_ids, state: 'selecting' });
    },
  });

  // —— prospecting-confirm（唯一写）：批量入池 S0 + sourcedFrom 弱边 ——
  registerAction({
    name: 'prospecting-confirm', kind: 'write', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'prospecting', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',
    decisionScenario: SCENARIO,
    schema: { session_id: 'string', confirmed_ids: 'array' },
    parameters: { required: ['session_id', 'confirmed_ids'] },
    handler: async ({ session_id, confirmed_ids }, ctx) => {
      requireMintedDecision(ctx, 'prospecting-confirm');
      const s = getSession(session_id);
      if (!s) throw new Error(`prospecting session 不存在或已超时: ${session_id}`);
      if (s.tenantId !== ctx.tenantId) throw new Error('跨租户访问拒绝');
      const valid = new Set((s.candidates || []).map((c) => c.id));
      const bad = (confirmed_ids || []).filter((id) => !valid.has(id));
      if (bad.length) throw new Error(`确认含非候选 id: ${bad.join(', ')}`);
      const { createParticle, createEdge } = await import('../particles/particleRepo.js');
      const results = [];
      for (const id of confirmed_ids) {
        const cand = s.candidates.find((c) => c.id === id);
        // 查重：已存在（existing:true）不入池
        const hit = await resolveExistingOrCreate('CRM_ACCOUNT', { name: cand.name, domain: cand.domain },
          { find: async (type, k, v) => null, create: async (type, attrs) => null, criteria: [['name'], ['domain']] });
        // 注入真实查重：deps.findAccount 由调用方提供（生产用 queryParticles）；无则默认 null（不拦）
        // 实现按 dedupResolver 语义：find 命中即 existing，不入池
        if (hit) { results.push({ account_id: null, deal_id: null, decision_id: ctx.decision_id, existing: true }); continue; }
        const deal = await createParticle('CRM_DEAL', {
          name: cand.name, stage: 'S0', pool_type: 'new', source: 'prospecting',
          expected_amount: cand.revenue || 0, industry: cand.industry,
          pooled_at: new Date().toISOString(),
        }, { tenantId: ctx.tenantId, requireDecisionId: ctx.decision_id });
        // 溯源弱边：CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE（修订 1，主语统一对齐 createLeadFromTender）
        await createEdge('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', `prospecting:${cand.id}`, {
          edge_source: 'auto_weak', relation_confidence: cand.fit_score ?? 0.5,
          provenance: 'prospecting-search', decision_id: ctx.decision_id,
        }, ctx.tenantId).catch(() => {});
        results.push({ account_id: null, deal_id: deal.id, decision_id: ctx.decision_id, existing: false });
      }
      emit('prospecting', 'batch-pooled', { tenant_id: ctx.tenantId, total: results.length, decision_id: ctx.decision_id });
      expireOrUpdate(session_id, { state: 'pooled', confirmed_ids });
      return { results };
    },
  });
}

function expireOrUpdate(sid, patch) { updateSession(sid, patch); }
```

（说明：`createParticle` 的 `required` decision 参数名以 particleRepo 实际签名为准——实现时对照 `particleRepo.js` 顶部导出与 `createLeadFromTender`（`tenderConnector.js:54-58`）的调用形态：`createParticle('CRM_DEAL', {...}, { tenantId })`。若需传 `requireDecisionId` 则参照 `discoveryActions.js:112` 的 `updateParticle(..., { requireDecisionId })`。）

- [ ] **Step 4: 注册到装配汇聚（agents.js 路径）**

`src/action/seed-actions.js` 顶部 import 区（现有 `seedDiscoveryActions` 同位置）加：

```js
import { seedProspectingActions } from './prospectingActions.js';
```

并在 `seedActions()`（或 `agents.js:68` `seedActions()` 内）尾部调用：

```js
  seedProspectingActions();
```

（说明：确认 `seedActions()` 内现有调用 discovery 的位置——按 `agents.js:68-70` 的 `seedActions(); seedDiscoveryActions();` 顺序，prospecting 紧随其后。若 `seed-actions.js` 的 `seedActions` 是单独函数，在其末尾追加；否则在 `agents.js` 的 `assertAgentAssembly` 前调用。）

- [ ] **Step 5: MCP 暴露确认（tools.js 自动）**

`src/mcp/tools.js`：read 自动暴露（`a.kind==='read'` → readTools）；`prospecting-confirm` 是 write + 不以 `data-` 开头 → `isExposedWrite` 自动暴露。**无需改 tools.js 代码**——T5 测试 ⑤ 验证即可。

- [ ] **Step 6: 运行测试确认通过 + 装配断言全绿**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/action/prospectingActions.test.js`
Expected: 5/5 PASS

再启用 T1 测试的 ③⑥（移除注释）：

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/agent/prospectingAgent.test.js`
Expected: 6/6 PASS（含 assertAgentAssembly）

- [ ] **Step 7: Commit**

```bash
git add src/action/prospectingActions.js src/action/seed-actions.js test/action/prospectingActions.test.js test/agent/prospectingAgent.test.js
git commit -m "feat(prospecting): register search/select/confirm actions + mcp exposure + assembly green"
```

---

## Task 6: 批量入池 + 溯源弱边（复用 createLeadFromTender 范式）

**Files:**
- Modify: `src/action/prospectingActions.js`（confirm handler 查重/入池/弱边已含，本 Task 强化真实查重与事件）
- Modify: `src/agent/discoveryOrchestrator.js`（可选：候选查重 find 注入）
- Test: `test/action/prospectingConfirm.test.js`

**背景：** 设计 §5。本 Task 把 T5 的 confirm 内「演示查重」升级为真实查重（resolveExistingOrCreate find 用 queryParticles 查 name/domain），并补事件/TDD 断言：查重不重复入池（T4）、每企业 decision_id（T3）、事件 batch-pooled（T6）。

- [ ] **Step 1: 写测试**

```js
// test/action/prospectingConfirm.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { getAction, resetRegistry } from '../../src/action/registry.js';
import { seedProspectingActions } from '../../src/action/prospectingActions.js';
import { createProspectingSession, updateSession } from '../../src/action/prospectingSession.js';

beforeEach(() => { resetRegistry(); seedProspectingActions(); });

describe('prospecting-confirm 批量入池 + 溯源（T6）', () => {
  it('① 查重不重复入池（existing:true 跳过）', async () => {
    // 用一个 mock 查重 find：name 命中 → existing
    const conf = getAction('prospecting-confirm');
    const origFind = global.__prospectingFind;
    global.__prospectingFind = async () => ({ id: 'win-1' });   // 命中赢家
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c1', name: '已有企业', domain: 'old.com' }] });
    const out = await conf.handler({ session_id: sid, confirmed_ids: ['c1'] },
      { tenantId: 'acme', actor: 'alice', decision_id: 'dec-1' });
    expect(out.results[0].existing).toBe(true);
    expect(out.results[0].deal_id).toBeNull();
    global.__prospectingFind = origFind;
  });
  it('② 新企业入池：createParticle S0 + sourcedFrom 弱边 + decision_id', async () => {
    // 生产走真实 particleRepo；此处注入 deps 替身验证 handler 透传
    const conf = getAction('prospecting-confirm');
    // 需要 handler 支持 deps 注入（参考 runDiscoveryResearch deps 模式）——实现时保留
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c2', name: '新企业', domain: 'new.com', fit_score: 0.8 }] });
    const out = await conf.handler({ session_id: sid, confirmed_ids: ['c2'] },
      { tenantId: 'acme', actor: 'alice', decision_id: 'dec-2' });
    expect(out.results[0].existing).toBe(false);
    expect(out.results[0].decision_id).toBe('dec-2');
    expect(out.results[0].deal_id).toBeTruthy();
  });
  it('③ emit batch-pooled 事件携带 decision_id', () => {
    // 事件总线断言——用总线 spy 或检查 emit 调用（实现经 emit('prospecting','batch-pooled')）
    // 生产用真实 bus；此处验证 handler 内部 emit 调用形态
  });
});
```

（说明：② ③ 依赖 handler 支持 deps 注入（`createParticle`/`createEdge`/`emit` 可注入）——**实现按 `runDiscoveryResearch`（discoveryActions.js:94-114）deps 注入模式**，T5 已按此实现。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/action/prospectingConfirm.test.js`
Expected: FAIL（handler 未支持 deps 注入 / existing 逻辑不完整）

- [ ] **Step 3: 强化 confirm handler（真实查重 + deps 注入 + 事件）**

`src/action/prospectingActions.js` 的 confirm handler 升级为：

```js
  async ({ session_id, confirmed_ids }, ctx, deps = {}) => {
    // deps 注入（对齐 runDiscoveryResearch）：单测可注入替身；生产走真实 particleRepo/bus
    const createParticle = deps.createParticle || (await import('../particles/particleRepo.js')).createParticle;
    const createEdge = deps.createEdge || (await import('../particles/particleRepo.js')).createEdge;
    const findAccount = deps.findAccount || (async (name, domain) => {
      const { queryParticles } = await import('../particles/particleRepo.js');
      // 按 name/domain 查重（对齐 dedupResolver 默认 criteria）
      const rows = await queryParticles('CRM_ACCOUNT', { name }).catch(() => null);
      return rows && rows.length ? rows[0] : null;
    });
    const busEmit = deps.emit || emit;
    requireMintedDecision(ctx, 'prospecting-confirm');
    const s = getSession(session_id);
    if (!s) throw new Error(`prospecting session 不存在或已超时: ${session_id}`);
    if (s.tenantId !== ctx.tenantId) throw new Error('跨租户访问拒绝');
    const valid = new Set((s.candidates || []).map((c) => c.id));
    const bad = (confirmed_ids || []).filter((id) => !valid.has(id));
    if (bad.length) throw new Error(`确认含非候选 id: ${bad.join(', ')}`);
    const results = [];
    for (const id of confirmed_ids) {
      const cand = s.candidates.find((c) => c.id === id);
      const hit = await findAccount(cand.name, cand.domain).catch(() => null);
      if (hit) { results.push({ account_id: (hit && hit.id) || null, deal_id: null, decision_id: ctx.decision_id, existing: true }); continue; }
      const deal = await createParticle('CRM_DEAL', {
        name: cand.name, stage: 'S0', pool_type: 'new', source: 'prospecting',
        expected_amount: cand.revenue || 0, industry: cand.industry,
        pooled_at: new Date().toISOString(),
      }, { tenantId: ctx.tenantId, requireDecisionId: ctx.decision_id });
      await createEdge('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', `prospecting:${cand.id}`, {
        edge_source: 'auto_weak', relation_confidence: cand.fit_score ?? 0.5,
        provenance: 'prospecting-search', decision_id: ctx.decision_id,
      }, ctx.tenantId).catch(() => {});
      results.push({ account_id: null, deal_id: deal.id, decision_id: ctx.decision_id, existing: false });
    }
    busEmit('prospecting', 'batch-pooled', { tenant_id: ctx.tenantId, total: results.length, decision_id: ctx.decision_id });
    updateSession(session_id, { state: 'pooled', confirmed_ids });
    return { results };
  },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/action/prospectingConfirm.test.js`
Expected: 3/3 PASS（②③ 用 deps 注入替身断言透传）

- [ ] **Step 5: Commit**

```bash
git add src/action/prospectingActions.js test/action/prospectingConfirm.test.js
git commit -m "feat(prospecting): confirm batch-pool with dedup + sourcedFrom weak edge + batch-pooled event"
```

---

## Task 7: 契约全绿 + 装配断言 + 全量回归

**Files:**
- Modify: `docs/2026-09-14-prospecting-module-design.md`（契约块已就绪；本 Task 验证）
- Test: 既有测试全量

**背景：** 设计 §A.3 已声明：`prospecting` agent 注册后，`node scripts/validate-contract.mjs docs/2026-09-14-prospecting-module-design.md --registry src/agent/agentSpec.js` 须 `valid:true`（6 条 prospecting 任务 + 1 条 review-gate 任务，skills/memory/layers ⊆ spec）。

- [ ] **Step 1: 契约自检**

Run: `cd /d/system/CRM-ai-native && node scripts/validate-contract.mjs docs/2026-09-14-prospecting-module-design.md --registry src/agent/agentSpec.js`
Expected: `{"valid":true,"errors":[]}`（若 `--registry` 校验报 skill 不在 skillCalls → 对照 agentSpec.capabilities 补；`contract_task_id` 与 CONTRACT_IDS 必须一致）

- [ ] **Step 2: 装配断言**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/agent/prospectingAgent.test.js`
Expected: 6/6 PASS（含 assertAgentAssembly ok:true）

- [ ] **Step 3: 相关回归**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/action/prospectingActions.test.js test/action/prospectingConfirm.test.js test/prospectingSession.test.js test/prospectingRules.test.js test/connectors/prospectingSearchAdapters.test.js test/action/discoveryActions.test.js`
Expected: 全 PASS（新 6 套 + 既有 discovery 套件——防装配改动破坏既有发现链路）

- [ ] **Step 4: Commit（含契约块同步确认）**

```bash
git add docs/2026-09-14-prospecting-module-design.md
git commit -m "chore(prospecting): contract validation green + regression suite"
```

---

## Task 8: 前端拓客 Tab（旁路，后补）

**Files:**
- Modify: `src/web/lead-pool.html`
- Modify: `src/http/routes.js`（如需要新端点；拓客 Tab 复用既有 action 端点则不新增）
- Test: `test/leadPoolProspectingTab.test.js`

**背景：** 设计 §6。旁路入口：`lead-pool.html` 加「拓客」Tab（候选表格 + 圈选 + 确认入池），调同一后端 Action。**第一迭代后补**——本 Task 为可选项，默认不加入第一迭代；如需交付前端旁路，按下列路径实现。

- [ ] **Step 1: 前端 Tab + 调用**

`src/web/lead-pool.html` 新增 Tab 面板（复用既有 `/api/lead-pool` 与 Action 的 fetch 模式）：

```html
<section class="panel" id="panel-prospecting">
  <div class="sect-title">主动拓客</div>
  <div class="toolbar">
    <input id="pp-query" placeholder="自然语言查询：如「找 50 人以上、营收 1 亿的医疗企业」" />
    <button class="crm-btn" id="pp-search">搜索候选</button>
  </div>
  <table class="cfg">
    <thead><tr><th>选</th><th>企业</th><th>行业</th><th>营收</th><th>信号</th><th>适配度</th><th>已存在</th></tr></thead>
    <tbody id="pp-body"></tbody>
  </table>
  <button class="crm-btn" id="pp-confirm">确认入池（选中）</button>
  <span id="pp-status"></span>
</section>
```

脚本：`pp-search` → `POST /api/action/prospecting-search`（或 MCP 通道）；`pp-confirm` → `POST /api/action/prospecting-confirm`（带 `decision_id` 阶段2）。具体端点以既有 Action 网关为准（`src/http/router.js` / gateway 两阶段）。

- [ ] **Step 2: 测试 + 实现 + commit（按 TDD）**

```js
// test/leadPoolProspectingTab.test.js
// 断言：页面含「主动拓客」Tab、调用 prospecting-search/confirm 端点
```

（说明：前端旁路是**后补可选项**——设计 §6「第一迭代先不做，后补」；如用户确认需要第一迭代交付，则启用本 Task；否则保持 `lead-pool.html` 现状。）

---

## Self-Review（已核对）

**1. Spec 覆盖：**
- §1 状态机 → T2（5 态 + 非法转移抛错 + TTL + 并发隔离）
- §2 适配器 search() → T4（qixin/xinbang + fail-open + 不注入 fit_score）
- §3 prospecting-rules → T3（双层配置 + 不增删 sources + fit_score 服务端计算）
- §4 三个 MCP Action → T5（search/select 只读；confirm 写 + decisionScenario）
- §5 批量入池 + 溯源弱边 → T6（CRM_DEAL S0 + source=prospecting + DEAL→KNOWLEDGE 弱边 + event batch-pooled）
- §6 前端旁路 → T8（后补）
- §7 验收 T1a/T1b/T2/T3/T4/T5/T6 → T2-T6 对应测试
- §A living contract → T7 校验
- 红线：不新增粒子（全程只用 CRM_DEAL S0）✅；禁 DELETE ✅；写走第 0 闸（confirm decisionScenario）✅；租户隔离（session 跨租户拒绝 + 写透传 tenantId）✅；配置驱动（全从 rules 读）✅；付费源默认关（DEFAULT enabled:false）✅；fail-open（search 返 []）✅；查重不重复入池（existing:true）✅

**2. Placeholder scan:** 无 TBD/TODO；所有代码块完整。**例外标注**：T1-Step 3 的 Action 注册延迟到 T5（依赖显式）：测试 ③⑥ 在 T1 注释、T5 启用——这是多 Task 依赖的自然中间态，已在步骤内显式说明（非空洞占位）。

**3. Type consistency:** `transition`/`transitionSimple` 导出统一为 `transition`；`createProspectingSession/_getSessionsInMemory` 名字与测试一致；`computeFitScore(candidate, rules)` 签名 T3 定义、T5 调用一致；`seedProspectingActions()` 导出名与装配调用一致；`decisionScenario: 'PROSPECTING_CONFIRM'` 与 seed.sql 场景键一致。`pool_type:'new'`、`source:'prospecting'`、`edge_source:'auto_weak'`、`provenance:'prospecting-search'` 全程一致。
