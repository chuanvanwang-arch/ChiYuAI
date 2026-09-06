# 设计文档：决策系统接入 Agent 编排层（前后双 Agent + 自动泵）

- 版本：1.0
- 日期：2026-09-02
- 方案：用户选定 **方案 C（决策前富集 + 决策后治理 双 Agent）**
- 参考范式：`D:\system\reference\semantica-main`（写时构建 write-through / 知识即图谱 agent 即遍历器 / 记忆分层治理 / 决策显式触发+因果回溯）
- 关联文档：`docs/2026-08-29-agent-workbench-contract-monitor-design.md`（契约合规矩阵）、`docs/2026-09-02-decision-e2e-deep-test-report.html`（E2E 报告）

---

## §0 背景与问题（证据驱动）

用户质疑：「agent 不运行，知识系统、记忆系统设计的意义何在？决策系统必须接入 agent。」

排查根因（file:line）：

- **根因 1 — 决策落库全程不调 agent 编排层**：`requireDecision`（`src/decision/autonomyEngine.js:94`）在自主分支（:233-258）与升级分支（:260-275）**只调 `createDecision(...)`**，全程无 `dispatchOneCore` / `runWithSkill` / `createTask`。记忆/知识仅由引擎同步直调 `assembleContextV2`（:188，`pre_context`）消费，不经过 `agentLoop` 的 agent 装配、不写回、不落 `monitor_event` 轨迹。
- **根因 2 — 编排层无自动泵，任务建了也不被消费**：`pumpReadyTasks` 仅出现在 `retroTrigger.js:120`（决策 confirmed 后复盘）与 HTTP/MCP 显式调用；`src/scheduler/timers.js` 7 个定时器（nightly/crm-risk/lead/recycle/retro/sales/namedVisit/slaSnap）**无一是扫描 ready 队列派发**。即便决策创建 agent 任务也不会自动执行 → agent 不运行。
- **根因 3 — 记忆/知识真空的因果闭环**：供给层实证 `assembleContextV2` 的 S2 先例 0 hit、S3 冲突 0 hit、S4 规则 0 hit、S7 恒空 → auditability 21%。根因是**无 agent 往里写**（无 write-through 学习闭环）。semantica 用 `AgentMemory.store`（`semantica/agent_memory.py:301`）写时构建（短期+长期向量+KG 同步）解决此问题——本设计直接借鉴。

---

## §1 目标与范围

**目标**
1. 决策生命周期显式触发 agent（决策前富集 + 决策后治理），使编排层真实运行、落 `monitor_event` 轨迹。
2. 记忆/知识经 agent **write-through 写回**（先例库更新 + 记忆沉淀 + 故事线 + 决策网络挂接），形成学习闭环，消除 21% 真空（CRM 用 decision_relation+particles 映射 semantica 知识图谱，不引 graph store）。
3. 补 `ready-queue-pump` 定时器，使真实业务事件能自动派发 agent（编排层"真正跑起来"）。
4. **决策闸（置信度/升级 HITL）保持确定性引擎、可审计**——agent 不改动决策结果，只做富集与写回。

**范围（本设计）**
- 新增 1 个 agent（decision-agent）、2 个 SKILL（method-decision-enrich / method-decision-execute）、路由 2 条、requireDecision 前后 2 处 dispatch、1 个定时器。
- 不含：LLM 推理内核改写（复用现有 `j_judge` + `llmThink` 降级）、置信度算法改动、决策闸语义改动。

**不在范围**
- 把决策推理本身改成 LLM agent（方案 B，已否决——破坏确定性治理）。
- intake-router 改独立调度（已是路由纯函数，设计既定）。

---

## §2 方案 C 架构总览

```
业务/事件触发
   │
   ▼
requireDecision()  ← 确定性引擎（分级/证据/先例/置信度/闸，autonomyEngine.js:94）
   │  ├─[前·fire-forget·fail-open] dispatch(intent='decision-enrich')
   │  │      → routeThroughIntake → decision-agent
   │  │      → agentLoop.runWithSkill(method-decision-enrich)
   │  │      → buildContextBlock L1-L4（记忆/知识并行装配）
   │  │      → monitor_event(loop-started / context-injected / loop-done)
   │  │      ⚠ 结果不回灌决策判定（保持确定性）
   │  │
   │  └─ createDecision()  ← 落库（state=AUTONOMOUS / HUMAN）
   │        └─[后·fire-forget·fail-open] dispatch(intent='decision-execute')
   │              → routeThroughIntake → decision-agent
   │              → agentLoop.runWithSkill(method-decision-execute)
   │              → L1-L4 装配 + write-through 写回：
   │                 ① 先例库更新（submitRetro/appendPrecedent）
   │                 ② 记忆沉淀（memory_log / particles 更新）
   │                 ③ 故事线更新（retrieveTimeline 回写）
   │                 ④ 决策网络挂接：写 decision_relation（因果链）+ upsert 长期记忆 particles（CRM 无 graph store，用关系表+粒子图映射）
   │              → monitor_event(轨迹) + task_audit(状态转换)
   │
   ▼
ready-queue-pump 定时器（timers.js，60s）← 扫描 ready 任务自动派发
   （弥补"无自动泵"：真实业务事件建的任务被自动消费）
```

---

## §3 详细设计（file:line 接入点）

### §3.1 新增 agent：`decision-agent`（src/agent/agentSpec.js）
在 5 agent 名册（intake-router/quote-engine/followup-agent/review-gate/decision-retro，agentSpec.js:4-62）后新增：
```js
'decision-agent': {
  identity: { id: 'decision-agent', derivedFrom: 'DECISION' },
  capabilities: {
    actions: ['data-particle-read', 'data-particle-create', 'decision-retrospective',
              'method-decision-enrich', 'method-decision-execute', 'crm-memory-upsert'],
    skillCalls: ['method-decision-enrich', 'method-decision-execute', 'data-particle-read', 'data-particle-create'],
    knowledgeScope: { layers: ['L1', 'L2', 'L3', 'L4'], maxHops: 5 },
  },
  memory: { read: ['decision-agent', 'review-gate'], write: ['decision-agent'] },
},
```
- 权限闭包：`skillCalls ⊆ actions`（agents.js:64 断言 3 校验）。
- 契约块：在 `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` §A 新增两条（ct-decision-enrich / ct-decision-execute），`knowledge_scope.layers: [L1,L2,L3,L4]`（与 quote-engine 等对齐，要求真实 context-injected）。

### §3.2 新增 2 个 SKILL（src/skills/seed.js）
沿用 `method-quote-engine`（seed.js:73-83）steps 格式（rule 步骤走 action、`j_judge` 走 LLM 降级）：
```js
{ slug: 'method-decision-enrich', version: 1,
  description: '决策前上下文富集——并行装配 L1-L4 记忆/知识，补充先例与图谱线索，供决策审计轨迹（不阻塞决策判定）',
  rbac_roles: ['sales', 'manager'],
  steps: [
    { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
    { step: 2, action: 'crm-memory-upsert', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
    { step: 3, action: null, decision: 'j_judge',
      prompt: '基于装配上下文 {{steps[1].result}} 归纳本次决策可用的记忆/知识线索与风险注解',
      preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
  ] },
{ slug: 'method-decision-execute', version: 1,
  description: '决策后治理写回——先例库更新+记忆沉淀+故事线+决策网络挂接（write-through 学习闭环，CRM 用 decision_relation+particles）',
  rbac_roles: ['sales', 'manager'],
  steps: [
    { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
    { step: 2, action: 'crm-memory-upsert', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
    { step: 3, action: 'decision-retrospective', decision: 'rule', params: {}, preconditions: ['steps[1].done'], postconditions: ['result.ok'] },
    { step: 4, action: null, decision: 'j_judge',
      prompt: '基于决策结果 {{steps[2].result}} 生成可复核整改/沉淀结论并建议决策关系(decision_relation)/粒子图关联',
      preconditions: ['steps[2].done'], postconditions: ['decision.finalized'] },
  ] },
```
- `crm-memory-upsert` action **当前未注册**（Grep `crm-memory-upsert` 0 命中），本设计 Task 2 在 `seed-actions.js` 注册，内部调 `memoryLog.appendMemory`（memoryLog.js:26，参数 `layer`/`ttlDays` 分层治理 + `entityId` 锚定）与 `decisionRepo.appendMemoryLog`（decisionRepo.js:398），属确定性写回、走 actionExecutor 第 0 闸。
- `decision-retrospective` 已存在于 `decision-retro` agent 的 skillCalls（agentSpec.js:62），复用其 SKILL 实体。

### §3.3 路由扩展（src/kanban/scheduler.js:38 routeThroughIntake）
现有路由（:46-48）：retro→decision-retro / followup→followup-agent / 其他→quote-engine。新增：
```js
if (intent === 'decision-enrich' || intent === 'decision-execute') return routeTo('decision-agent', payload);
```
- `primarySkillFor('decision-agent')` 取首个 skillCall（method-decision-enrich），但**决策后任务需注入 `payload.skill_slug='method-decision-execute'`**（与 retro 同理，scheduler.js:139 `primarySkillFor(g)` 显式注入）。
- 重大商机 gateAgents：决策任务不挂 review-gate（避免与决策闸双重），`gateAgents: []`。

### §3.4 决策前 dispatch（src/decision/autonomyEngine.js ~:188 后）
在 `pre_context` 装配（:188-203）之后、置信度计算之前，fire-forget 派发 enrich agent：
```js
// [前·决策前富集] 不阻塞、fail-open：结果不回灌决策判定
try {
  const { createTask } = await import('../kanban/kanban.js');
  const { pumpReadyTasks } = await import('../kanban/scheduler.js');
  await createTask({ tenantId: tenant, chainId: scenario_id, step: 'decision-enrich',
    title: `决策前富集:${scenario_id}`, actionName: 'decision-enrich',
    payload: { intent: 'decision-enrich', level: tier, contract_task_id: 'ct-decision-enrich', source: 'decision-wiring' },
    decisionId: null });
  await pumpReadyTasks({ tenantId: tenant }); // 即时泵（同 retroTrigger.js:120 模式）
} catch (e) { emit('trace', 'decision-enrich-dispatch-failed', { scenario_id, error: String(e?.message||e) }); }
```
- 动态 import 避免与 scheduler/kanban 循环依赖（同 retroTrigger.js:120 模式）。
- **不 await 结果**：enrich 是旁路轨迹，失败仅 trace，不阻断决策。

### §3.5 决策后 dispatch（src/decision/autonomyEngine.js :238 / :265 后）
在 `createDecision` 返回 `decision` 后，fire-forget 派发 execute agent：
```js
// [后·决策后治理写回] write-through 学习闭环，fail-open
try {
  const { createTask } = await import('../kanban/kanban.js');
  const { pumpReadyTasks } = await import('../kanban/scheduler.js');
  await createTask({ tenantId: tenant, chainId: scenario_id, step: 'decision-execute',
    title: `决策后治理:${decision.decision_id}`, actionName: 'decision-execute',
    payload: { intent: 'decision-execute', level: tier, decision_id: decision.decision_id,
               contract_task_id: 'ct-decision-execute', source: 'decision-wiring' },
    decisionId: decision.decision_id });
  await pumpReadyTasks({ tenantId: tenant });
} catch (e) { emit('trace', 'decision-execute-dispatch-failed', { decision_id: decision?.decision_id, error: String(e?.message||e) }); }
```
- 插入点：自主分支 `return` 前（:257 后）、升级分支 `return` 前（:275 后）。
- 传递 `decision_id` 供 agent 写回挂接因果链（L4 治理，contractMonitor.js 因果回溯）。

### §3.6 自动泵定时器（src/scheduler/timers.js）
新增 `ready-queue-pump`（弥补"无自动泵"），纯编排、无第 0 闸阻塞：
```js
const PUMP_INTERVAL = 60_000; // 60s，config_store['agent-pump'].interval_ms 可配
setInterval(async () => {
  try { const { pumpReadyTasks } = await import('./scheduler.js'); await pumpReadyTasks({}); }
  catch (e) { emit('trace', 'ready-queue-pump-failed', { error: String(e?.message||e) }); }
}, PUMP_INTERVAL);
```
- 频率配置化（阈值配置化铁律）：`config_store['agent-pump']={ interval_ms: 60000 }`，缺省 60s。
- 与 `server.js` 启动接线：`ensureTimers()` 内调用（当前 server.js:101 全读无 ensureTimers 调用——需补 `import { ensureTimers } from './scheduler/timers.js'` + 启动调用，与 seedSkills/registerRetroTrigger 同级）。

---

## §4 治理与审计

- **决策闸不变**：置信度计算、tier=HIGH/EXCEPTION 强制升级 HITL（autonomyEngine.js:205-231）保持确定性引擎，agent 不改动 `disposition`/`state`。
- **agent 不回灌决策**：enrich 结果不入置信度；execute 只做写回，不修正已落库决策（修正走 CALIBRATION_CHANGE 处方，已有机制）。
- **第 0 闸**：dispatch 是编排动作（非业务写操作）；execute 的写回走 `crm-memory-upsert`/`decision-retrospective` action，受 actionExecutor 第 0 闸约束（如该 action 属写操作需 HITL，则 agent 在 awaiting_confirm 挂起，符合治理）。
- **轨迹可审计**：agent 运行落 `monitor_event`（domain='agent'），契约矩阵（contractMonitor.js:45-54）三维度判定（skill_ok / memory_ok）对 ct-decision-enrich / ct-decision-execute 生效——工作台可见决策 agent 轨迹，直接回应"看不到智能体运行轨迹"的质疑。
- **fail-open 一致性**：前后 dispatch 均 try/catch + emit trace，决策主链路不因 agent 故障而失败（与 assembleContextV2 fail-open 一致）。

---

## §5 数据流（端到端）

```
trigger_context
  → requireDecision (确定性引擎)
    →[前] createTask(intent=decision-enrich) → pumpReadyTasks → dispatchOneCore
         → claimTask → routeThroughIntake(decision-agent) → runWithSkill(method-decision-enrich)
         → buildContextBlock L1-L4 (assembleContext 并行多源) → executeSkill (data-particle-read→crm-memory-upsert→j_judge)
         → recordEpisode(loop-started/context-injected/loop-done) → completeTask(done)
    → createDecision (落库, state=AUTONOMOUS/HUMAN)
    →[后] createTask(intent=decision-execute, decision_id) → pumpReadyTasks → dispatchOneCore
         → runWithSkill(method-decision-execute) → L1-L4 + write-through:
            先例库↑ / 记忆沉淀↑ / 故事线↑ / decision_relation 因果链↑ + particles↑
         → recordEpisode + task_audit → completeTask(done)
  → ready-queue-pump(60s) 兜底扫描未消费 ready 任务
```

---

## §6 验收口径

1. **编排层跑起来**：启动服务器，`ensureTimers` 调用后 `ready-queue-pump` 生效；手动 `POST /api/agent/dispatch` 或决策触发后，tasks 表出现 `decision-wiring` 来源任务且状态自动流转至 `done`（无需人工泵）。
2. **决策接入 agent**：跑任一决策场景（e2e-decision-deep-test），`crm.tasks` 出现 `intent=decision-enrich` + `decision-execute` 任务；`crm.monitor_event` 出现 `agent_id='decision-agent'` 的 loop-started/context-injected/loop-done 轨迹。
3. **记忆/知识加载证据**：context-injected episode 的 `knowledge_layers_read` ⊇ [L1,L2,L3,L4]（contractMonitor.js:48-54 判定 memory_ok=true）——直接消解 21% 真空质疑。
4. **学习闭环**：决策后 `crm.memory_log` / 先例表 / `decision_relation` 因果链出现新写入（与决策 decision_id 关联），消除 21% 真空。
5. **决策闸不被破坏**：9 PASS / 6 PARTIAL 的 E2E 结论不变（agent 接入不改 disposition/state）；反假绿判定仍生效。
6. **契约矩阵可见**：agent-workbench 契约矩阵新增 ct-decision-enrich / ct-decision-execute 两行，skill_ok + memory_ok 双 ✓（对比 decision-retro 此前 ✗✗，证明 agent 真跑了）。

---

## §7 风险与回滚

- **循环依赖**：autonomyEngine ↔ scheduler/kanban 用动态 `import()`（同 retroTrigger.js:120），已验证可规避。
- **enrich 阻塞风险**：严禁 await enrich 结果（§3.4 明确 fire-forget），避免拉长决策延迟。
- **自动泵频率**：60s 默认；高频场景可调 `config_store['agent-pump'].interval_ms`，过低会增加 PG 扫描压力。
- **写回副作用**：execute 写回若错误（如重复先例），靠 `decision_id` 幂等键 + memory_log 去重（meta.merged_into 软合并，禁 DELETE）兜底。
- **回滚**：本设计为新增（agent/SKILL/路由/定时器/dispatch），不改动既有决策闸语义；回滚 = 删除 §3.4/§3.5 dispatch 块 + 定时器，既有决策 E2E 不受影响。

---

## §8 实施序（writing-plans 阶段细化，每 Task 一 commit）

- **Task 1**：agentSpec.js 新增 decision-agent + seed.js 新增 2 SKILL + 契约块（ct-decision-enrich/execute）。
- **Task 2**：routeThroughIntake 路由扩展（intent→decision-agent），primarySkillFor 显式注入 decision-execute。
- **Task 3**：autonomyEngine.js 决策前/后 dispatch（§3.4/§3.5），动态 import + fail-open。
- **Task 4**：timers.js 新增 ready-queue-pump + server.js ensureTimers 接线。
- **Task 5**：crm-memory-upsert action 补种（若缺失）+ E2E 扩展（e2e-agent-trail-test 加决策场景），验证 §6 六条口径。
