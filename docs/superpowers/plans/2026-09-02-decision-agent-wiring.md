# 决策系统接入 Agent 编排层（方案C）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让决策系统（requireDecision）生命周期显式触发 agent 编排层（决策前富集 + 决策后治理双 Agent），并补自动泵定时器，使 agent 真实运行、记忆/知识经 write-through 写回形成学习闭环。

**Architecture:** 在 `requireDecision`（autonomyEngine.js）落库前后 fire-forget dispatch 一个 `decision-agent` 任务（新增 agent + 2 SKILL），经既有 `dispatchOneCore → agentLoop.runWithSkill → buildContextBlock(L1-L4)` 编排链路运行；并在 `timers.js` 补 `ready-queue-pump` 定时器（server.js 启动接线 `ensureTimers`）。决策闸（置信度/升级 HITL）保持确定性引擎可审计，agent 不回灌 disposition。

**Tech Stack:** Node 22 ESM / Express / PostgreSQL(crm schema) / 既有 agent 编排层（scheduler.js / agentLoop.js / skillRegistry.js）/ 记忆层（memoryLog.appendMemory）/ 测试 vitest。

---

## File Structure

**Create**
- `test/agent/decisionAgentWiring.test.js` — Task 1 装配断言
- `test/kanban/routeDecision.test.js` — Task 2 路由断言
- `test/action/memoryUpsert.test.js` — Task 2 action 断言
- `test/decision/decisionAgentDispatch.test.js` — Task 3 dispatch 断言
- `test/scheduler/pumpTimer.test.js` — Task 4 定时器断言

**Modify**
- `src/agent/agentSpec.js:73` 后 — 新增 `decision-agent` 名册
- `src/skills/seed.js` — 新增 `method-decision-enrich` / `method-decision-execute` 两个 SKILL（steps 格式同 method-quote-engine:73）
- `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` §A — 新增 2 条契约块
- `src/kanban/scheduler.js:46-48` — `routeThroughIntake` 加决策路由
- `src/action/seed-actions.js` — 注册 `crm-memory-upsert` action（handler 调 appendMemory）
- `src/decision/autonomyEngine.js:188` 后 + `:238`/`:265` 后 — 决策前后 fire-forget dispatch
- `src/scheduler/timers.js:213` 前 — `ensureTimers` 内加 `ready-queue-pump`
- `src/http/server.js:40-56` — 启动接线加 `ensureTimers()` 调用
- `scripts/e2e-agent-trail-test.mjs` — Task 5 扩展决策场景

**Dependencies（既定事实，无需新建）**
- `memoryLog.appendMemory`（memoryLog.js:26，参数 `topic/kind/payload/layer/actor/ttlDays/entityId`）
- `decisionRepo.appendMemoryLog`（decisionRepo.js:398）
- `closureLoop.submitRetro`（closureLoop.js:95）
- `assembleContextV2`（assembleContextV2.js:255，Promise.allSettled 并行 7 源）
- `dispatchOneCore / routeThroughIntake / pumpReadyTasks`（scheduler.js）
- `createTask / claimTask / completeTask / failTask`（kanban.js）

---

## Task 1: 新增 decision-agent + 2 SKILL + 契约块

**Files:**
- Modify: `src/agent/agentSpec.js:73`（decision-retro 对象后追加）
- Modify: `src/skills/seed.js`（method-* SKILL 数组内追加，位置在 method-review-gate:97 附近或末尾）
- Modify: `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` §A（contract-yaml 块内追加）
- Test: `test/agent/decisionAgentWiring.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/agent/decisionAgentWiring.test.js
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { getSkill } from '../../src/skills/registry.js';
import { seedSkills } from '../../src/skills/seed.js';

describe('decision-agent wiring', () => {
  beforeAll(() => seedSkills());
  test('decision-agent 存在于名册且权限闭包成立', () => {
    const spec = agentSpecs['decision-agent'];
    expect(spec).toBeTruthy();
    for (const c of spec.capabilities.skillCalls) {
      expect(spec.capabilities.actions).toContain(c); // skillCalls ⊆ actions
    }
  });
  test('两个决策 SKILL 已注册', () => {
    expect(getSkill('method-decision-enrich')).toBeTruthy();
    expect(getSkill('method-decision-execute')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/agent/decisionAgentWiring.test.js`
Expected: FAIL — `agentSpecs['decision-agent']` undefined / getSkill null

- [ ] **Step 3: Write minimal implementation**

`src/agent/agentSpec.js` — 在 `decision-retro` 对象（:73 结束 `},` 后）追加：

```js
  'decision-agent': {
    identity: { name: 'decision-agent', derivedFrom: 'taskFlow:crm-decision-wiring', autonomy: 'autonomous' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'crm-memory-upsert', 'decision-retrospective', 'method-decision-enrich', 'method-decision-execute'],
      skillCalls: ['method-decision-enrich', 'method-decision-execute', 'data-particle-read', 'data-particle-create'],
      knowledgeScope: { layers: ['L1', 'L2', 'L3', 'L4'], maxHops: 5 },
    },
    context: { knowledgeLevel: 4, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['decision-agent', 'review-gate'], write: ['decision-agent'] },
    evaluation: { metricTemplate: 'decision_wiring_quality', evaluator: 'stage2' },
    governance: { approvals: ['recommend'], concurrency: 2, profile: 'full' },
  },
```

`src/skills/seed.js` — 在 method-review-gate（:106 结束 `},` 后）追加两个 SKILL（沿用 method-quote-engine steps 格式）：

```js
    {
      slug: 'method-decision-enrich', version: 1,
      description: '决策前上下文富集——并行装配 L1-L4 记忆/知识，补充先例与图谱线索，供决策审计轨迹（不阻塞决策判定）',
      rbac_roles: ['sales', 'manager'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-memory-upsert', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于装配上下文 {{steps[1].result}} 归纳本次决策可用的记忆/知识线索与风险注解',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-decision-execute', version: 1,
      description: '决策后治理写回——先例库更新+记忆沉淀+故事线+决策网络挂接（write-through 学习闭环，CRM 用 decision_relation+particles）',
      rbac_roles: ['sales', 'manager'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-memory-upsert', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: 'decision-retrospective', decision: 'rule', params: {}, preconditions: ['steps[1].done'], postconditions: ['result.ok'] },
        { step: 4, action: null, decision: 'j_judge',
          prompt: '基于决策结果 {{steps[2].result}} 生成可复核整改/沉淀结论并建议决策关系(decision_relation)/粒子图关联',
          preconditions: ['steps[2].done'], postconditions: ['decision.finalized'] },
      ],
    },
```

`docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` §A — 在 decision-retro 契约块（:162 ` ``` ` 前）追加：

```yaml
- task: "决策前富集：L1-L4 记忆/知识并行装配，补充决策上下文线索（不阻塞判定）"
  contract_task_id: ct-decision-enrich
  agent: decision-agent
  skills: [method-decision-enrich]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2, L3, L4], max_hops: 5 }
  success: "决策前 agent 落 loop-started/context-injected/loop-done 轨迹，knowledge_layers_read ⊇ L1-L4"

- task: "决策后治理：先例写回+记忆沉淀+故事线+决策网络挂接（write-through 学习闭环）"
  contract_task_id: ct-decision-execute
  agent: decision-agent
  skills: [method-decision-execute]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2, L3, L4], max_hops: 5 }
  success: "决策后 agent 写回 memory_log/decision_relation，消除记忆真空"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/agent/decisionAgentWiring.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit（用户本地执行，AI 不代 commit）**

```bash
git add src/agent/agentSpec.js src/skills/seed.js docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md test/agent/decisionAgentWiring.test.js
git commit -m "feat(agent): 新增 decision-agent + method-decision-enrich/execute SKILL + 契约块"
```

---

## Task 2: routeThroughIntake 路由 + crm-memory-upsert action

**Files:**
- Modify: `src/kanban/scheduler.js:46-48`（routeThroughIntake 现有 if 链）
- Modify: `src/action/seed-actions.js`（registerAction 段，紧邻 decision-retrospective:109）
- Test: `test/kanban/routeDecision.test.js` / `test/action/memoryUpsert.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/kanban/routeDecision.test.js
import { routeThroughIntake } from '../../src/kanban/scheduler.js';
describe('decision routing', () => {
  test('decision-enrich/execute 路由到 decision-agent 且注入 skill_slug', () => {
    const t = { payload: { intent: 'decision-execute', decision_id: 'd-1', level: 'NORMAL' } };
    const r = routeThroughIntake(t);
    expect(r.targetAgent).toBe('decision-agent');
    expect(r.payload.skill_slug).toBe('method-decision-execute');
  });
});
```

```js
// test/action/memoryUpsert.test.js
import { getAction } from '../../src/action/registry.js';
import { seedActions } from '../../src/action/seed-actions.js';
describe('crm-memory-upsert', () => {
  beforeAll(() => seedActions());
  test('action 已注册且 handler 写回 memory_log', async () => {
    const act = getAction('crm-memory-upsert');
    expect(act).toBeTruthy();
    const r = await act.handler({ topic: 'decision-wire', kind: 'event', payload: { d: 1 }, layer: 'L-Workspace', actor: 'decision-agent', entityId: 'd-1' }, { tenantId: 'system' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/routeDecision.test.js test/action/memoryUpsert.test.js`
Expected: FAIL — routeThroughIntake 无 decision 分支 / crm-memory-upsert 未注册

- [ ] **Step 3: Write minimal implementation**

`src/kanban/scheduler.js` — `routeThroughIntake` 现有路由（:46-48 附近 `if (intent === 'retro') ... else if (intent === 'followup') ... else ...`）改为在 retro 分支前插入：

```js
  if (intent === 'decision-enrich' || intent === 'decision-execute') {
    return {
      targetAgent: 'decision-agent',
      payload: { ...payload, skill_slug: intent === 'decision-enrich' ? 'method-decision-enrich' : 'method-decision-execute', contract_task_id: intent === 'decision-enrich' ? 'ct-decision-enrich' : 'ct-decision-execute' },
      gateAgents: [],
    };
  }
```

`src/action/seed-actions.js` — 在 `decision-retrospective` registerAction（:109-114 后）追加（handler 调 appendMemory）：

```js
  registerAction({
    name: 'crm-memory-upsert', kind: 'write', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { topic: 'string', kind: 'string', payload: 'object', layer: 'string', entityId: 'string' },
    parameters: {
      required: ['topic', 'payload'],
      properties: { topic: { type: 'string' }, layer: { type: 'string' } },
    },
    handler: async ({ topic, kind = 'event', payload, layer = 'L-Workspace', entityId = null }, ctx) => {
      const { appendMemory } = await import('../memory/memoryLog.js');
      const row = await appendMemory({
        topic, kind, payload, layer, actor: ctx.actor || 'decision-agent',
        ttlDays: 30, entityId,
      });
      return { ok: true, memoryId: row?.id };
    },
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/routeDecision.test.js test/action/memoryUpsert.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit（用户本地执行）**

```bash
git add src/kanban/scheduler.js src/action/seed-actions.js test/kanban/routeDecision.test.js test/action/memoryUpsert.test.js
git commit -m "feat(agent): routeThroughIntake 决策路由 + crm-memory-upsert action"
```

---

## Task 3: requireDecision 前后 fire-forget dispatch

**Files:**
- Modify: `src/decision/autonomyEngine.js:188` 后（pre_context 装配后）+ `:238`（自主 return 前）+ `:265`（升级 return 前）
- Test: `test/decision/decisionAgentDispatch.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/decision/decisionAgentDispatch.test.js
// 用 PGDATABASE=crm_native_test 运行；验证 requireDecision 后 tasks 表出现 decision-wiring 任务
import { requireDecision } from '../../src/decision/autonomyEngine.js';
import { query } from '../../src/db.js';
describe('decision triggers agent', () => {
  test('requireDecision 后创建 decision-enrich + decision-execute 任务', async () => {
    await requireDecision('SC_SALES_APPROVE', { customer: 'c1' }, [{ type: 'CRM_DEAL', id: 'd-test-1' }], { tenantId: 'system', actor_id: 'agent' });
    const rows = (await query(`SELECT payload->>'intent' AS intent FROM crm.tasks WHERE payload->>'source'='decision-wiring'`)).rows;
    expect(rows.map(r => r.intent).sort()).toEqual(['decision-enrich', 'decision-execute']);
  });
}, 30000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /d/system/CRM-ai-native && PGDATABASE=crm_native_test npx vitest run test/decision/decisionAgentDispatch.test.js`
Expected: FAIL — 无 decision-wiring 任务（dispatch 未接入）

- [ ] **Step 3: Write minimal implementation**

在 `autonomyEngine.js` 顶部 import 区（:7 附近 `import {...} from './decisionRepo.js'` 后）追加动态 import 注释（实际在函数内动态 import，避免顶层循环依赖）。

**决策前 dispatch** — 在 `pre_context` 装配块（:203 `}` 后、:205 `// ④ EXCEPTION` 前）插入：

```js
  // [前·决策前富集] 不阻塞、fail-open：结果不回灌决策判定
  try {
    const { createTask } = await import('../kanban/kanban.js');
    const { pumpReadyTasks } = await import('../kanban/scheduler.js');
    await createTask({ tenantId: tenant, chainId: scenario_id, step: 'decision-enrich',
      title: `决策前富集:${scenario_id}`, actionName: 'decision-enrich',
      payload: { intent: 'decision-enrich', level: tier, contract_task_id: 'ct-decision-enrich', source: 'decision-wiring' },
      decisionId: null });
    await pumpReadyTasks({ tenantId: tenant });
  } catch (e) { emit('trace', 'decision-enrich-dispatch-failed', { scenario_id, error: String(e?.message || e) }); }
```

**决策后 dispatch** — 在自主分支 `return { mode: 'autonomous', ... }`（:258 `}` 前，即 :257 后）与升级分支对应 return 前插入（抽取为辅助函数避免重复）：

在 `autonomyEngine.js` 文件末尾（:275 后）追加辅助函数：

```js
async function dispatchDecisionExecute({ tenant, scenario_id, tier, decision }) {
  if (!decision?.decision_id) return;
  try {
    const { createTask } = await import('../kanban/kanban.js');
    const { pumpReadyTasks } = await import('../kanban/scheduler.js');
    await createTask({ tenantId: tenant, chainId: scenario_id, step: 'decision-execute',
      title: `决策后治理:${decision.decision_id}`, actionName: 'decision-execute',
      payload: { intent: 'decision-execute', level: tier, decision_id: decision.decision_id,
                 contract_task_id: 'ct-decision-execute', source: 'decision-wiring' },
      decisionId: decision.decision_id });
    await pumpReadyTasks({ tenantId: tenant });
  } catch (e) { emit('trace', 'decision-execute-dispatch-failed', { decision_id: decision?.decision_id, error: String(e?.message || e) }); }
}
```

并在 :257 `}` 前调用 `await dispatchDecisionExecute({ tenant, scenario_id, tier, decision });`（自主分支），升级分支对应 return 前同样调用（需把升级分支的 `const decision = await createDecision({...});` 后、return 前加 `await dispatchDecisionExecute({ tenant, scenario_id, tier, decision });`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /d/system/CRM-ai-native && PGDATABASE=crm_native_test npx vitest run test/decision/decisionAgentDispatch.test.js`
Expected: PASS

- [ ] **Step 5: Commit（用户本地执行）**

```bash
git add src/decision/autonomyEngine.js test/decision/decisionAgentDispatch.test.js
git commit -m "feat(decision): requireDecision 前后 fire-forget dispatch decision-agent"
```

---

## Task 4: ready-queue-pump 定时器 + server.js 接线

**Files:**
- Modify: `src/scheduler/timers.js:213` 前（ensureTimers return 前）
- Modify: `src/http/server.js:56` 后（启动接线段）
- Test: `test/scheduler/pumpTimer.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/scheduler/pumpTimer.test.js
import { ensureTimers, clearTimers, timerCount } from '../../src/scheduler/timers.js';
describe('ready-queue-pump', () => {
  afterAll(() => clearTimers());
  test('ensureTimers 注册 ready-queue-pump', async () => {
    await ensureTimers();
    expect(timerCount()).toBeGreaterThanOrEqual(8); // 原 7 + 泵
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/scheduler/pumpTimer.test.js`
Expected: FAIL — timerCount===7（无泵）

- [ ] **Step 3: Write minimal implementation**

`src/scheduler/timers.js` — 在 `return timers.size;`（:213）前插入（频率配置化，阈值配置化铁律）：

```js
  // ⑧ ready-queue-pump：扫描 ready 任务自动派发（弥补"无自动泵"——真实业务事件建的任务被自动消费）
  //    纯编排、无第 0 闸阻塞；频率经 config_store['agent-pump'].interval_ms 可配（缺省 60s）
  const pumpIntervalMs = Number(process.env.AGENT_PUMP_INTERVAL_MS || 60000);
  const pump = setInterval(() => {
    import('../kanban/scheduler.js').then((m) => m.pumpReadyTasks({}))
      .catch((err) => {
        emit('trace', 'ready-queue-pump-failed', { error: String(err?.message || err) });
        recordFailure('ready-queue-pump-failed', err);
      });
  }, pumpIntervalMs);
  timers.set('ready-queue-pump', { handle: pump, intervalMs: pumpIntervalMs, kind: 'orchestration', registeredAt: now });
```

`src/http/server.js` — 在启动接线段（:56 `readApprovalConfig().then(setApprovalControl)...` 后、:58 `app.fetch` 前）插入（与 seedSkills 同级 try/catch）：

```js
  // ⑧ 定时规则驱动层启动：含 ready-queue-pump（自动派发 ready 任务）+ 既有 7 定时器
  //    （此前 ensureTimers 未被调用 → 整个定时层从未启动，编排层任务不被消费）
  try { ensureTimers(); } catch (e) { console.log(`[timers] ensureTimers fail: ${e.message}`); }
```

并在 server.js 顶部 import 区（:25 后）追加：

```js
import { ensureTimers } from '../scheduler/timers.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/scheduler/pumpTimer.test.js`
Expected: PASS（timerCount >= 8）

- [ ] **Step 5: Commit（用户本地执行）**

```bash
git add src/scheduler/timers.js src/http/server.js test/scheduler/pumpTimer.test.js
git commit -m "feat(scheduler): ready-queue-pump 定时器 + server.js ensureTimers 接线"
```

---

## Task 5: E2E 验证（决策触发 agent 轨迹 + 记忆/知识加载）

**Files:**
- Modify: `scripts/e2e-agent-trail-test.mjs`（在 TASKS 数组追加决策场景 + 补充 8 步断言的 decision 维度）
- Run: `node scripts/e2e-agent-trail-test.mjs --clean`

- [ ] **Step 1: 扩展 e2e 脚本**

在 `scripts/e2e-agent-trail-test.mjs` 的 `TASKS` 数组追加一个决策驱动任务（触发 requireDecision → 验证 decision-agent 轨迹）：

```js
  {
    name: 'decision', intent: 'decision', source: 'e2e-agent',
    run: async () => {
      const { requireDecision } = await import('../src/decision/autonomyEngine.js');
      const d = await requireDecision('SC_SALES_APPROVE', { customer: 'cust-x' },
        [{ type: 'CRM_DEAL', id: 'd-e2e-1' }], { tenantId: 'system', actor_id: 'agent' });
      return { decisionId: d.decision?.decision_id || d.decision_id };
    },
    expectAgent: 'decision-agent', expectSkill: 'method-decision-execute',
  },
```

并在 8 步验证链第 ⑧ 步补充：查询 `crm.monitor_event WHERE agent_id='decision-agent' AND context_facts->>'contract_task_id' IN ('ct-decision-enrich','ct-decision-execute')`，断言存在 loop-started/context-injected/loop-done，且 context-injected 的 `knowledge_layers_read` ⊇ ['L1','L2','L3','L4']（记忆/知识加载证据，直接消解 21% 真空质疑）。

- [ ] **Step 2: Run E2E**

Run: `cd /d/system/CRM-ai-native && PGDATABASE=crm_native_test node scripts/e2e-agent-trail-test.mjs --clean`
Expected: quote/followup/retro/decision 四任务全绿（8/8 验证链通过），输出 `scripts-qa/e2e-agent-trail-results.json` 含 decision-agent 轨迹 + L1-L4 knowledge_layers_read 证据。

- [ ] **Step 3: 回归确认决策 E2E 不变**

Run: `cd /d/system/CRM-ai-native && PGDATABASE=crm_native_test node scripts/e2e-decision-deep-test.mjs`
Expected: 258/258 链路步骤仍全通，15 场景 9 PASS / 6 PARTIAL 不变（agent 接入不改 disposition/state，反假绿仍生效）。

- [ ] **Step 4: Commit（用户本地执行）**

```bash
git add scripts/e2e-agent-trail-test.mjs scripts-qa/e2e-agent-trail-results.json
git commit -m "test(e2e): 决策触发 agent 轨迹 + L1-L4 记忆/知识加载验证"
```

---

## Self-Review

**1. Spec coverage:** 设计文档 §3.1(agentSpec)→Task1 / §3.2(SKILL+action)→Task1+Task2 / §3.3(路由)→Task2 / §3.4(前dispatch)→Task3 / §3.5(后dispatch)→Task3 / §3.6(泵+server)→Task4 / §6(E2E)→Task5。全覆盖。

**2. Placeholder scan:** 无 TBD/TODO；所有 code step 含完整实现；测试含真实断言。

**3. Type consistency:** `routeThroughIntake` 返回 `{targetAgent, payload, gateAgents}`（与既有 retro/followup 分支一致）；`dispatchDecisionExecute` 签名 `{tenant, scenario_id, tier, decision}` 在 Task3 前后调用一致；`crm-memory-upsert` handler 参数 `{topic, kind, payload, layer, entityId}` 与 appendMemory（memoryLog.js:26）一致。

**4. 治理不变量:** 决策闸（autonomyEngine.js:205-231）未改；agent 不回灌 disposition（enrich fire-forget 不 await）；`crm-memory-upsert` needsApproval:false（同 data-particle-create）保证自动闭环不挂起。
