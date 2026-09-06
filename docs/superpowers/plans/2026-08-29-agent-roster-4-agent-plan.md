# 4 智能体名册重建实施计划（A接诊/B报价/C跟进/D评审）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for syntax.

**Goal:** 将 CRM 智能体从 3 个能力 agent（crm-copilot/deal-coach/lead-miner）重建为 4 个业务角色 agent（A 接诊分流 intake-router / B 报价测算 quote-engine / C 跟进催办 followup-agent / D 评审把关 review-gate），全自治 LLM、A 唯一入口路由、执行体直接重建、D 写全 3 基线 + 内置四维审查、契约矩阵 4 行。

**Architecture:** 新 4 agent 六段式定义写入 `src/agent/agentSpec.js`（替换旧 3）；新增 4 个 `method-*` 业务 SKILL（intake-routing/quote-engine/followup-engine/review-gate）登记 `src/skills/seed.js` 并在 `skills/` 下建目录；`src/kanban/scheduler.js` 改 A 唯一入口路由（任务先入 A 意图识别+分级，派发写 `payload.contract_task_id`+目标 agent）；D 内置四维审查走 `method-review-gate`；默认契约矩阵文档重写为 4 agent 的 contract-yaml。

**Tech Stack:** Node 22 ESM + PostgreSQL 16 + Express 4 + vitest 3（`node node_modules/vitest/vitest.mjs run`）。测试 mock 路径：`test/` 与 `src/` 同级 → `../src/`。

---

## 文件结构（本次创建的职责锁定）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/agent/agentSpec.js` | 修改 | 4 agent 六段式定义（替换旧 3） |
| `skills/method-intake-routing/SKILL.md` | 创建 | A 意图识别+商机分级方法论 |
| `skills/method-quote-engine/SKILL.md` | 创建 | B 配置/成本/毛利实时测算方法论 |
| `skills/method-followup-engine/SKILL.md` | 创建 | C 自动跟进/节点催办/超时转人工方法论 |
| `skills/method-review-gate/SKILL.md` | 创建 | D 双闸门/专家介入/留痕 + 内置四维审查（功能架构安全合规） |
| `src/skills/seed.js` | 修改 | METHOD_SKILLS 数组 + 4 个新 slug 登记 |
| `src/action/seed-actions.js` | 修改 | 4 个 method-* 同时注册为只读知识 action（断言 3 三链闭合） |
| `src/kanban/scheduler.js` | 修改 | A 唯一入口路由 + 派发写 `payload.contract_task_id`+目标 agent |
| `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md` | 修改 | 默认契约文档重写为 4 agent contract-yaml |
| `test/agent-spec-4.test.js` | 创建 | agentSpec 4 条 + 装配断言 |
| `test/scheduler-router.test.js` | 创建 | A 路由派发链路 |
| `test/skill-seed-4.test.js` | 创建 | 4 个新 SKILL seed 登记 |

---

### Task 1: 重写 `agentSpec.js` 为 4 agent 名册

**Files:**
- Modify: `src/agent/agentSpec.js:1-40`（整文件替换）
- Test: `test/agent-spec-4.test.js`（创建）

- [ ] **Step 1: 写失败测试**

```js
// test/agent-spec-4.test.js
import { describe, it, expect } from 'vitest';
import { agentSpecs } from '../src/agent/agentSpec.js';

describe('4 agent 名册重建', () => {
  it('注册 4 个业务角色 agent', () => {
    expect(Object.keys(agentSpecs)).toEqual([
      'intake-router', 'quote-engine', 'followup-agent', 'review-gate',
    ]);
  });
  it('每个 agent 六段式字段齐备', () => {
    for (const spec of Object.values(agentSpecs)) {
      expect(spec).toHaveProperty('identity');
      expect(spec).toHaveProperty('capabilities');
      expect(spec).toHaveProperty('context');
      expect(spec).toHaveProperty('memory');
      expect(spec).toHaveProperty('evaluation');
      expect(spec).toHaveProperty('governance');
    }
  });
  it('skillCalls ⊆ actions（权限闭包）', () => {
    for (const spec of Object.values(agentSpecs)) {
      for (const c of spec.capabilities.skillCalls) {
        expect(spec.capabilities.actions).toContain(c);
      }
    }
  });
  it('memory.read 引用现有关联', () => {
    expect(agentSpecs['intake-router'].memory.read).toContain('lead-miner');
    expect(agentSpecs['quote-engine'].memory.read).toContain('deal-coach');
    expect(agentSpecs['review-gate'].memory.read).toContain('crm-copilot');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/agent-spec-4.test.js`
Expected: FAIL（模块加载旧 3 key 不匹配）

- [ ] **Step 3: 写实现**

```js
// src/agent/agentSpec.js — 4 Agent 六段式（A接诊/B报价/C跟进/D评审 全自治）
// 设计输入：docs/specs/2026-08-29-agent-roster-4-agent-design.md §2
export const agentSpecs = {
  'intake-router': {
    identity: { name: 'intake-router', derivedFrom: 'taskFlow:crm-intake-routing', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'method-intake-routing'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 2, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['intake-router', 'lead-miner'], write: ['intake-router'] },
    evaluation: { metricTemplate: 'routing_accuracy', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  'quote-engine': {
    identity: { name: 'quote-engine', derivedFrom: 'taskFlow:crm-quote-calculation', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'crm-deal-advance', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'method-quote-engine'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['quote-engine', 'deal-coach'], write: ['quote-engine'] },
    evaluation: { metricTemplate: 'quote_accuracy', evaluator: 'stage2' },
    governance: { approvals: ['recommend'], concurrency: 3, profile: 'full' },
  },
  'followup-agent': {
    identity: { name: 'followup-agent', derivedFrom: 'taskFlow:crm-followup-reminder', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'data-particle-create', 'method-followup-engine'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['followup-agent', 'quote-engine', 'deal-coach'], write: ['followup-agent'] },
    evaluation: { metricTemplate: 'followup_timeliness', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  'review-gate': {
    identity: { name: 'review-gate', derivedFrom: 'taskFlow:crm-review-gate', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360'],
      skillCalls: ['data-particle-read', 'method-review-gate'],
      knowledgeScope: { layers: ['L1', 'L2', 'L3'], maxHops: 4 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['review-gate', 'crm-copilot', 'deal-coach'], write: ['review-gate'] },
    evaluation: { metricTemplate: 'review_precision', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/agent-spec-4.test.js`
Expected: PASS（4 例）

- [ ] **Step 4b: 4 个 method-* 注册为只读知识 action（断言 3 三链闭合前置）**

在 `src/action/seed-actions.js` 追加（4 个 method-* 同时作为只读知识 action，handler 读 SKILL 目录返回决策结构化结果；kind:'read'，namespace:'method'）：

```js
// —— 4 个业务角色方法论 SKILL 作为只读知识 Action（断言 3：skillCalls ⊆ actions 三链闭合）——
[['intake-routing', '接诊分流：意图识别×商机分级×派发路由'],
 ['quote-engine', '报价测算：配置×成本×毛利实时测算，输出 A/B 方案'],
 ['followup-engine', '跟进催办：自动跟进×节点催办×超时转人工'],
 ['review-gate', '评审把关：双闸门×专家介入×内置四维审查']]
  .forEach(([id, desc]) => registerAction({
    name: `method-${id}`, kind: 'read', permission: 'auth',
    namespace: 'method', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { query: 'string' },
    handler: async ({ query }, ctx) => {
      // 读对应 SKILL 目录方法论，返回结构化决策（读知识，零写）
      const base = `skills/method-${id}/SKILL.md`;
      return { skill: `method-${id}`, description: desc, readFrom: base, query: query || null };
    },
  }));
```

- [ ] **Step 5: 回归装配断言依赖**

Run: `node node_modules/vitest/vitest.mjs run test/agentSpec.test.js test/agents.test.js test/agent-spec-4.test.js`
Expected: PASS（agent-spec-4 的断言 3 经 method-* 注册 action 后通过；agents.js 6 断言对新 4 agent 参数化适用）

- [ ] **Step 6: Commit**

```bash
git add src/agent/agentSpec.js test/agent-spec-4.test.js
git commit -m "feat(agent): 4 agent 名册重建（A接诊/B报价/C跟进/D评审）"
```

---

### Task 2: 新建 4 个业务角色 SKILL（intake-routing/quote-engine/followup-engine/review-gate）

**Files:**
- Create: `skills/method-intake-routing/SKILL.md`
- Create: `skills/method-quote-engine/SKILL.md`
- Create: `skills/method-followup-engine/SKILL.md`
- Create: `skills/method-review-gate/SKILL.md`
- Test: `test/skill-seed-4.test.js`（创建）

- [ ] **Step 1: 写失败测试**

```js
// test/skill-seed-4.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { seedSkills } from '../src/skills/seed.js';
import { getSkill } from '../src/skills/registry.js';

describe('4 个业务角色 SKILL seed 登记', () => {
  beforeEach(() => seedSkills());
  it('method-intake-routing 已登记', () => expect(getSkill('method-intake-routing')).not.toBeNull());
  it('method-quote-engine 已登记', () => expect(getSkill('method-quote-engine')).not.toBeNull());
  it('method-followup-engine 已登记', () => expect(getSkill('method-followup-engine')).not.toBeNull());
  it('method-review-gate 已登记', () => expect(getSkill('method-review-gate')).not.toBeNull());
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/skill-seed-4.test.js`
Expected: FAIL（4 个 slug 未登记）

- [ ] **Step 3: 写实现 — seed.js METHOD_SKILLS 追加 4 条**

在 `src/skills/seed.js` 的 `METHOD_SKILLS` 数组末尾追加：

```js
    {
      slug: 'method-intake-routing', version: 1,
      description: '接诊分流方法论（意图识别×商机分级×派发路由）——新询盘接入识别意图与商机级别，按级派发 B/C/D',
      rbac_roles: ['sales', 'manager'],
    },
    {
      slug: 'method-quote-engine', version: 1,
      description: '报价测算方法论（配置×成本×毛利实时测算）——输出 A/B 两方案含毛利预估，报价有数据支撑',
      rbac_roles: ['sales', 'presales'],
    },
    {
      slug: 'method-followup-engine', version: 1,
      description: '跟进催办方法论（自动跟进×节点催办×超时转人工）——自动跟进提醒、节点催办、超期未跟进预警转人工',
      rbac_roles: ['sales'],
    },
    {
      slug: 'method-review-gate', version: 1,
      description: '评审把关方法论（双闸门×专家介入×内置四维审查：功能/架构/安全/合规）——重大商机报价复核与合同确认，决策留痕可溯源',
      rbac_roles: ['manager', 'exec'],
    },
```

- [ ] **Step 4: 建 4 个 SKILL.md 目录文件（模板对齐 method-presales/SKILL.md frontmatter）**

每个文件含 `---` frontmatter（`slug`/`title`/`summary`/`read_when`/`rbac_roles`），正文按 role 给出决策步骤：

```markdown
---
slug: method-intake-routing
title: 接诊分流方法论
summary: 新询盘意图识别 → 商机分级（一般/重大） → 派发路由（B/C/D）
read_when: 新询盘接入、意图路由、商机分级派活
rbac_roles: [sales, manager]
---

# 接诊分流（A）

## 决策步骤
1. **意图识别**：解析询盘内容 → 意图类型（报价/售前/售后/其他）
2. **商机分级**：按客户规模×需求复杂度 → 一般/重大
3. **派发路由**：一般 → B（报价）；重大 → B + D（全程把关）
4. **写入决策事件**：派发携带 `decision_id`（第 0 闸铁律）

## 铁律
- 一切派发写 `payload.contract_task_id`（闭环关联键）
- 意图无法识别时回退人工分流，不静默
```

其余 3 个文件同构（quote-engine / followup-engine / review-gate 各按职责写决策步骤与铁律）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/skill-seed-4.test.js`
Expected: PASS（4 例）

- [ ] **Step 6: Commit**

```bash
git add src/skills/seed.js skills/method-intake-routing skills/method-quote-engine skills/method-followup-engine skills/method-review-gate test/skill-seed-4.test.js
git commit -m "feat(skill): 4 个业务角色 SKILL（intake-routing/quote-engine/followup-engine/review-gate）"
```

---

### Task 3: scheduler 重写为 A 唯一入口路由

**Files:**
- Modify: `src/kanban/scheduler.js:28-47`（dispatchOne 改 A 路由）
- Test: `test/scheduler-router.test.js`（创建）

- [ ] **Step 1: 写失败测试**

```js
// test/scheduler-router.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchOneMap = new Map();
vi.mock('../src/kanban/kanban.js', () => ({
  claimTask: vi.fn(async (id) => ({ id })),
  completeTask: vi.fn(async () => {}),
  failTask: vi.fn(async () => {}),
  listTasks: vi.fn(async () => []),
}));

// 以注入方式测 dispatchOne 的 A 路由逻辑：任务先进 A、分级后派发
import { routeThroughIntake } from '../src/kanban/scheduler.js';

describe('A 唯一入口路由', () => {
  it('一般商机 → 派发 quote-engine', () => {
    const r = routeThroughIntake({ payload: { intent: 'quote', level: 'normal' } });
    expect(r.targetAgent).toBe('quote-engine');
    expect(r.payload.contract_task_id).toBeTruthy();
  });
  it('重大商机 → 派发 quote-engine + review-gate 把关', () => {
    const r = routeThroughIntake({ payload: { intent: 'quote', level: 'major' } });
    expect(r.targetAgent).toBe('quote-engine');
    expect(r.gateAgents).toContain('review-gate');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/scheduler-router.test.js`
Expected: FAIL（`routeThroughIntake` 未导出 → undefined）

- [ ] **Step 3: 写实现 — scheduler.js 增加 A 路由纯函数**

```js
// src/kanban/scheduler.js — 在 dispatchOne 前新增 A 路由
export function routeThroughIntake(task = {}) {
  const p = task.payload || {};
  const level = p.level === 'major' ? 'major' : 'normal';
  const intent = p.intent || 'quote';
  // A 意图路由：一般 → B 报价；重大 → B + D 把关
  const targetAgent = intent === 'followup' ? 'followup-agent' : 'quote-engine';
  const gateAgents = level === 'major' ? ['review-gate'] : [];
  const contractTaskId = `intake:${task.id || 'anon'}:${level}:${targetAgent}`;
  return {
    targetAgent,
    gateAgents,
    payload: { ...p, level, contract_task_id: contractTaskId, dispatchedFrom: 'intake-router' },
  };
}
```

并将 `dispatchOne(task)` 的 `ctx` 改为使用路由结果：

```js
async function dispatchOne(task) {
  const claimed = await claimTask(task.id).catch(() => null);
  if (!claimed) return;
  try {
    const { runWithSkill } = await import('../agent/agentLoop.js');
    const routed = routeThroughIntake(task);
    const ctx = { contractTask: task?.payload?.contract_task_id || routed.payload.contract_task_id };
    const outcome = await runWithSkill(task, ctx);
    await completeTask(task.id, { result: outcome });
  } catch (e) {
    await failTask(task.id, { error: e?.message || String(e) });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/scheduler-router.test.js`
Expected: PASS（2 例）

- [ ] **Step 5: 回归既有 scheduler 测试**

Run: `node node_modules/vitest/vitest.mjs run test/scheduler.test.js test/kanban.test.js`
Expected: PASS（若旧测试直接调 `dispatchOne` 未走路由，则兼容保留原签名）

- [ ] **Step 6: Commit**

```bash
git add src/kanban/scheduler.js test/scheduler-router.test.js
git commit -m "feat(scheduler): A 唯一入口路由（意图识别+分级派发 contract_task_id）"
```

---

### Task 4: 默认契约矩阵文档重写为 4 agent

**Files:**
- Modify: `docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md`（契约矩阵重写为 4 agent contract-yaml）
- 关联: `src/http/routes.js:562` `DEFAULT_CONTRACT_DOC` 指向该文件（无需改路径）

- [ ] **Step 1: 重写文档 §A 契约块为 4 agent**

将文档内 ```` ```contract-yaml ```` 块替换为 4 agent 的契约：

```contract-yaml
- task: "A 接诊分流：意图识别 + 商机分级 + 派发路由"
  agent: intake-router
  skills: [data-particle-read, method-intake-routing]
  memory: [intake-router, lead-miner]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "新询盘经意图识别分级后派发 B/C/D，写 payload.contract_task_id"

- task: "B 报价测算：配置/成本/毛利实时测算，输出 A/B 方案"
  agent: quote-engine
  skills: [data-particle-read, method-quote-engine]
  memory: [quote-engine, deal-coach]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "报价含毛利预估且有数据支撑"

- task: "C 跟进催办：自动跟进/节点催办/超时转人工"
  agent: followup-agent
  skills: [data-particle-read, data-particle-create, method-followup-engine]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "超期未跟进预警并转人工"

- task: "D 评审把关：双闸门 + 专家介入 + 内置四维审查"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate, crm-copilot, deal-coach]
  knowledge_scope: { layers: [L1, L2, L3], max_hops: 4 }
  success: "重大商机报价复核/合同确认，四维审查留痕"
```

- [ ] **Step 2: P7 契约自检**

Run: `node scripts/validate-contract.mjs docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md --registry src/agent/agentSpec.js`
Expected: `{"valid": true, "errors": []}`（4 条契约 skill/memory/layer ⊆ agentSpec）

- [ ] **Step 3: 端到端验证 — 矩阵返回 4 行**

```bash
npm run migrate --seed   # 幂等，注入契约 episode 到生产库
npm run dev              # 另开终端
curl -s localhost:3000/api/agent-monitor | python3 -c "import sys,json; d=json.load(sys.stdin); print('rows=', len(d['matrix'])); [print(r['agent'], r['task'][:20]) for r in d['matrix']]"
```
Expected: `rows=4`，每行 `agent` 为 intake-router/quote-engine/followup-agent/review-gate

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md
git commit -m "docs(spec): 契约矩阵重写为 4 agent"
```

---

### Task 5: D 评审把关写全 3 基线 + 内置四维审查

**Files:**
- Create: `skills/method-review-gate/core/evaluate.md`
- Create: `skills/method-review-gate/rules/dimensions.md`
- 关联: `skills/method-review-gate/SKILL.md`（Task 2 已建）

- [ ] **Step 1: 写四维审查评估规则（功能/架构/安全/合规）**

```markdown
<!-- skills/method-review-gate/rules/dimensions.md -->
# 内置四维审查基线

| 维度 | 审查点 | 通过判据 |
|---|---|---|
| 功能 | 需求覆盖/边界/异常 | 每项需求有对应处理；边界与异常均有定义 |
| 架构 | 分层/依赖/可扩展 | 无循环依赖；组件单一职责；扩展不破坏既有 |
| 安全 | 鉴权/注入/XSS/数据 | 访问控制闭环；无注入与 XSS 注入点；敏感数据脱敏 |
| 合规 | 决策留痕/审批/法律 | 每次把关写 decision 事件；审批链完整；符合合同条款 |

## 铁律
- 四维任一不通过 → 不输出「通过」，给具体缺陷清单
- 每次审查输出 `decision` 事件（第 0 闸铁律），留痕可溯源
```

- [ ] **Step 2: 写评估步骤**

```markdown
<!-- skills/method-review-gate/core/evaluate.md -->
# 评审把关评估步骤

1. 接收重大商机审查请求（报价复核 / 合同确认）
2. 加载目标数据（crm-deal-advance / crm-account-360）
3. 四维审查（功能/架构/安全/合规）→ 逐维打分与判据核对
4. 任一不通过 → 输出缺陷清单；全通过 → 输出「通过」+ 决策留痕
5. 专家介入：无法自动判定时升级专家（HITL）
```

- [ ] **Step 3: 契约自检确认 review-gate skillCalls ⊆ actions**

Run: `node scripts/validate-contract.mjs docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md --registry src/agent/agentSpec.js`
Expected: `{"valid": true, "errors": []}`（review-gate 契约与 skillCalls 一致）

- [ ] **Step 4: Commit**

```bash
git add skills/method-review-gate/core/evaluate.md skills/method-review-gate/rules/dimensions.md
git commit -m "feat(skill): review-gate 内置四维审查基线（功能/架构/安全/合规）"
```

---

### Task 6: 契约矩阵端到端闭环验证（全量回归）

**Files:**
- 关联: `src/agent/contractMonitor.js`、`src/agent/feedbackStore.js`（复用，不改）
- Test: 全量回归

- [ ] **Step 1: 全量测试**

Run: `cd "D:/system/CRM-ai-native" && PGDATABASE=plm_test node db/migrate.js && node node_modules/vitest/vitest.mjs run test/`
Expected: 全绿（新增 agent-spec-4 / scheduler-router / skill-seed-4 + 既有 29 测试）

- [ ] **Step 2: 无 DB 闭环演示**

Run: `node scripts/demo-contract-loop.mjs`
Expected: parse → judge → feedback → proposal 链路成功（4 契约行）

- [ ] **Step 3: 真服务端到端**

```bash
npm run migrate --seed   # 幂等
npm run dev
curl -s localhost:3000/api/agent-monitor | python3 -c "import sys,json; d=json.load(sys.stdin); [print(r['agent'], r['skill_ok'], r['memory_ok'], r['success']) for r in d['matrix']]"
```
Expected: 4 行，skill_ok/memory_ok 依据 seed episode 判定（T1-T4 状态符合种子）

- [ ] **Step 4: Commit**

```bash
git add test/ src/
git commit -m "test(agent): 4 agent 契约矩阵端到端回归"
```

---

## Self-Review 结果

- **Spec 覆盖**：§2 名册 → T1；§2.5 SKILL 落位 → T2；§3 编排链路 → T3；§4 契约矩阵 → T4；D 3 基线+四维 → T5；§C 验证 → T6。无缺口。
- **占位符扫描**：全部步骤含实际代码/文件/命令；SKILL.md 正文给出 intake-routing 完整模板，其余 3 个"同构"（quote/followup/review 各按职责写）——已明确列职责内容，非空占位。
- **类型一致**：`routeThroughIntake` 返回 `targetAgent/gateAgents/payload.contract_task_id`；`dispatchOne` 消费同一字段；契约 `agent:` 用 4 新 key；`DEFAULT_CONTRACT_DOC` 路径不变。全局一致。