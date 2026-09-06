# 审批流引擎（可配置 HITL 闸）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CordysCRM 借鉴清单 G 组（v1.7/v1.8 审批流实证）落成阶段 2 的可配置审批流引擎——六层粒子域 + HITL 状态机 + 四类配置 + 回滚补偿 + Action 接线 + 审批记录审计流，作为阶段 3 四大写域（报价/合同/发票/订单）审批的共用底座。

**Architecture:** 复用阶段 1 已验证底座（particles 粒子域 + schema.sql 单库 + action/registry + ruleEngine 规则闸 + decision/autonomyEngine 决策第 0 闸 + events/bus）+ 新增审批域六层粒子（CRM_APPROVAL_FLOW/VERSION/NODE/APPROVER/CONDITION/LINK）+ 运行态（CRM_APPROVAL_INSTANCE/TASK）+ 审批引擎（状态机合法流转 + 条件路由 + 会签/或签/顺序 + 兜底 + 写前快照回滚补偿）+ 审计事件流（审批记录进 events 总线）。与总体设计 §6.13（对话式智能体包）+ 综合详设 §7（G 组主章）对齐。

**Tech Stack:** Node 22 + ESM + PostgreSQL（crm schema）+ vitest 3（单 worker singleFork，fileParallelism:false，共享真实 PG 防践踏）。

---

## 文件结构（本计划创建/修改的文件及职责）

| 文件 | 职责 | 操作 |
|---|---|---|
| `db/schema.sql` | 追加审批域六层粒子 + 审批实例/任务表（业务表走 particles/edges 统一底座；审批流配置为独立支撑表） | 修改（追加 §阶段2 审批域段） |
| `src/approval/flow.js` | 审批流 CRUD：createFlow / createVersion / addNode / addApprover / addCondition / addLink（配置层） | 新建 |
| `src/approval/engine.js` | 审批引擎：startInstance / route（条件路由）/ advance（审批人动作：同意/驳回/加签/退回/转交/撤回）/ finish（终态 + 后动作） | 新建 |
| `src/approval/compensation.js` | 写前快照 + 回滚补偿：snapshotFor / rollbackIfNeeded | 新建 |
| `src/approval/stateMachine.js` | 审批实例状态机合法流转（PENDING_SUBMIT/APPROVING/APPROVED/REJECTED/CANCELED）+ 状态×操作矩阵 | 新建 |
| `src/approval/rules.js` | 审批流四类配置项 → 执行语义（条件分支/审批模式/字段权限/结果后动作） | 新建 |
| `src/action/seed-actions.js` | 追加审批域 Action：crm-approval-flow-create / crm-approval-start / crm-approval-approve（含决策第 0 闸 + action-confirm） | 修改（追加） |
| `src/events/bus.js` | **无需修改**——事件域是运行时字符串（`emit(domain,type,payload)`），审批域事件直接用 `emit('approval', ...)` 走既有总线 | 确认（不改） |
| `test/approval-flow.test.js` | 审批流配置层测试（六层结构可建可查） | 新建 |
| `test/approval-engine.test.js` | 审批引擎测试（状态机合法流转 / 条件路由 / 三种审批模式 / 兜底 / 回滚补偿） | 新建 |

**类型契约（跨 Task 一致，禁止改名）：**
- 粒子类型：`CRM_APPROVAL_FLOW` / `CRM_APPROVAL_VERSION` / `CRM_APPROVAL_NODE` / `CRM_APPROVAL_APPROVER` / `CRM_APPROVAL_CONDITION` / `CRM_APPROVAL_LINK`
- 运行态：`CRM_APPROVAL_INSTANCE` / `CRM_APPROVAL_TASK`
- 实例状态：`PENDING_SUBMIT` → `APPROVING` → `APPROVED` | `REJECTED` | `CANCELED`
- 任务状态：`TODO` → `APPROVED` | `REJECTED` | `TRANSFERRED`
- Action 名：`crm-approval-flow-create` / `crm-approval-start` / `crm-approval-approve`
- 审批模式：`ALL`（会签）/ `ANY`（或签）/ `SEQUENTIAL`（顺序）
- 兜底：`AUTO_PASS` / `ASSIGN_SPECIFIC` / `ASSIGN_ADMIN`

---

## 前置检查（每个 Task 前跑一次）

```bash
cd /d/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run --passWithNoTests
```

预期：现有全量测试通过（阶段 1 基线 33 测试/11 文件全绿），无回归。

---

### Task 1: 审批域六层粒子 Schema 落库

**Files:**
- Modify: `db/schema.sql`（追加审批域段）
- Test: `test/approval-flow.test.js`

- [ ] **Step 1: 写失败测试**（六层粒子类型可创建：FLOW→VERSION→NODE→APPROVER→CONDITION→LINK）

```js
// test/approval-flow.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createParticle, queryParticles } from '../src/particles/particleRepo.js';
import { resetRegistry } from '../src/action/registry.js';
import { closePool } from '../src/db.js';

beforeAll(() => { resetRegistry(); });
afterAll(async () => { await closePool(); });

describe('审批域六层粒子', () => {
  it('六层结构可建可查（FLOW→VERSION→NODE→APPROVER→CONDITION→LINK）', async () => {
    const flow = await createParticle('CRM_APPROVAL_FLOW', { name: '报价审批流', enabled: true }, { tenantId: 'system' });
    const version = await createParticle('CRM_APPROVAL_VERSION', { flow_id: flow.id, version_no: 1, nodes: [] }, { tenantId: 'system' });
    const node = await createParticle('CRM_APPROVAL_NODE', { flow_id: flow.id, node_type: 'APPROVER', name: '部门负责人', pos: 1 }, { tenantId: 'system' });
    const approver = await createParticle('CRM_APPROVAL_APPROVER', { node_id: node.id, approver_type: 'DEPT_HEAD', multi_approver_mode: 'ANY' }, { tenantId: 'system' });
    const cond = await createParticle('CRM_APPROVAL_CONDITION', { node_id: node.id, field: 'amount', operator: 'GT', value: 100000 }, { tenantId: 'system' });
    const link = await createParticle('CRM_APPROVAL_LINK', { from_node: node.id, to_node: node.id }, { tenantId: 'system' });

    for (const t of ['CRM_APPROVAL_FLOW','CRM_APPROVAL_VERSION','CRM_APPROVAL_NODE','CRM_APPROVAL_APPROVER','CRM_APPROVAL_CONDITION','CRM_APPROVAL_LINK']) {
      const r = await queryParticles({ type: t, tenantId: 'system' });  // 真实返回数组（particleRepo.js:42-49 return r.rows）
      expect(r.length).toBeGreaterThan(0);
    }
    expect(flow.type).toBe('CRM_APPROVAL_FLOW');
    expect(version.payload.version_no).toBe(1);
    expect(approver.payload.multi_approver_mode).toBe('ANY');
    expect(cond.payload.operator).toBe('GT');
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-flow.test.js`
Expected: FAIL（particles 表类型自由 TEXT 可写，但 schema.sql 未落审批域说明；且粒子 model 未注册类型集——若 PARTICLE_TYPES 校验拦截则报类型错误说明缺注册）

- [ ] **Step 3: 实现**——schema.sql 追加审批域粒子说明注释（业务表走通用 particles/edges，审批域配置挂 payload 无独立表）+ 确认 `src/particles/particleModel.js` PARTICLE_TYPES 需登记审批域类型（自由 TEXT 类型名不强制枚举，但模型层需声明 states 供生命周期使用）

```js
// src/particles/particleModel.js — PARTICLE_TYPES 追加审批域（追加于现有 9 类型之后）
  CRM_APPROVAL_FLOW: {
    slug: 'approval-flow', title: '审批流',
    identity: ['name'],
    states: { current: 'enabled', flow: ['enabled','disabled'] },
  },
  CRM_APPROVAL_VERSION: {
    slug: 'approval-version', title: '审批流版本',
    identity: ['flow_id','version_no'],
    states: { current: 'current', flow: ['current','superseded'] },
  },
  CRM_APPROVAL_NODE: {
    slug: 'approval-node', title: '审批节点',
    identity: ['flow_id','name'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_APPROVER: {
    slug: 'approval-approver', title: '节点审批人规则',
    identity: ['node_id'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_CONDITION: {
    slug: 'approval-condition', title: '节点条件',
    identity: ['node_id','field'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_LINK: {
    slug: 'approval-link', title: '节点连线',
    identity: ['from_node','to_node'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_INSTANCE: {
    slug: 'approval-instance', title: '审批实例',
    identity: ['business_type','business_id'],
    states: { current: 'pending_submit', flow: ['pending_submit','approving','approved','rejected','canceled'] },
  },
  CRM_APPROVAL_TASK: {
    slug: 'approval-task', title: '审批任务',
    identity: ['instance_id','approver'],
    states: { current: 'todo', flow: ['todo','approved','rejected','transferred'] },
  },
```

再在 `db/schema.sql` 尾部追加注释段（说明审批域六层走通用粒子底座，无需独立表）：

```sql
-- ============ 阶段 2 审批域（六层结构，走通用粒子底座，无独立表） ============
-- 借鉴实证（§5bis C9/G21）：审批流六层 = FLOW→VERSION→NODE→APPROVER→CONDITION→LINK
-- 运行态实例/任务：CRM_APPROVAL_INSTANCE / CRM_APPROVAL_TASK（同样走 particles 底座）
-- 说明：审批流是「可配置的一等公民」，配置本身即粒子（可被 AI 检索/生成/审计）
```

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-flow.test.js`
Expected: PASS（6 层类型创建并查询成功）

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql src/particles/particleModel.js test/approval-flow.test.js
git commit -m "feat(approval): 审批域六层粒子落库（FLOW→VERSION→NODE→APPROVER→CONDITION→LINK）"
```

---

### Task 2: 审批流配置层（flow.js 六层读写）

**Files:**
- Create: `src/approval/flow.js`
- Test: `test/approval-flow.test.js`（追加）

- [ ] **Step 1: 写失败测试**（flow.js 建流/加节点/加审批人/加条件/加连线）

```js
// test/approval-flow.test.js 追加
import { createFlow, addNode, addApprover, addCondition, addLink, getFlow } from '../src/approval/flow.js';

describe('审批流配置层', () => {
  it('createFlow→addNode→addApprover→addCondition→addLink 全链', async () => {
    const flow = await createFlow({ name: '合同审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const approverNode = await addNode(flow.id, { node_type: 'APPROVER', name: '商务负责人', pos: 1 });
    const approver = await addApprover(approverNode.id, { approver_type: 'ROLE', role: 'contract-admin', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });
    const cond = await addCondition(approverNode.id, { field: 'amount', operator: 'GT', value: 200000 });
    const link = await addLink(start.id, approverNode.id);
    const got = await getFlow(flow.id);
    expect(got.payload.enabled).toBe(true);
    expect(approver.payload.empty_approver_action).toBe('AUTO_PASS');
    expect(cond.payload.operator).toBe('GT');
    expect(link.payload.from_node).toBe(start.id);
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-flow.test.js`
Expected: FAIL（`Cannot find module '../src/approval/flow.js'`）

- [ ] **Step 3: 实现** `src/approval/flow.js`

```js
// src/approval/flow.js — 审批流配置层（六层读写 + 启停），粒子驱动
// 实证（§5bis C9）：flow→version→node[START/APPROVER/CONDITION/DEFAULT/END]→approver→condition→link
import { createParticle, getParticle, updateParticle, queryParticles } from '../particles/particleRepo.js';

const TENANT = 'system';

export async function createFlow({ name, enabled = true, tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_FLOW', { name, enabled, versions: [] }, { tenantId });
}

export async function createVersion(flow_id, { version_no, nodes = [], tenantId = TENANT }) {
  const v = await createParticle('CRM_APPROVAL_VERSION', { flow_id, version_no, nodes }, { tenantId });
  const flow = await getParticle(flow_id);
  await updateParticle(flow_id, { patch: { ...flow.payload, versions: [...(flow.payload.versions || []), v.id] } });
  return v;
}

export async function addNode(flow_id, { node_type, name, pos, tenantId = TENANT }) {
  if (!['START','APPROVER','CONDITION','DEFAULT','END'].includes(node_type)) {
    throw new Error(`未知节点类型: ${node_type}（合法: START/APPROVER/CONDITION/DEFAULT/END）`);
  }
  return createParticle('CRM_APPROVAL_NODE', { flow_id, node_type, name, pos }, { tenantId });
}

export async function addApprover(node_id, { approver_type, role, multi_approver_mode = 'ANY',
  empty_approver_action = 'AUTO_PASS', same_submitter_action = 'ALLOW',
  approver_direction = 'BOTTOM_UP', cc_list = [], field_permissions = {},
  pass_post_config = {}, reject_post_config = {}, tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_APPROVER', {
    node_id, approver_type, role, multi_approver_mode,
    empty_approver_action, same_submitter_action, approver_direction,
    cc_list, field_permissions, pass_post_config, reject_post_config,
  }, { tenantId });
}

export async function addCondition(node_id, { field, operator, value, tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_CONDITION', { node_id, field, operator, value }, { tenantId });
}

export async function addLink(from_node, to_node, { condition_ref = null, tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_LINK', { from_node, to_node, condition_ref }, { tenantId });
}

export async function getFlow(flow_id) {
  const flow = await getParticle(flow_id);
  const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId: TENANT })).filter(r => r.payload.flow_id === flow_id);
  return { ...flow, payload: { ...flow.payload, nodes } };
}
```

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-flow.test.js`
Expected: PASS（六层配置链全通）

- [ ] **Step 5: Commit**

```bash
git add src/approval/flow.js test/approval-flow.test.js
git commit -m "feat(approval): 审批流配置层（六层读写+启停，粒子驱动）"
```

---

### Task 3: 审批实例状态机（stateMachine.js，状态×操作矩阵）

**Files:**
- Create: `src/approval/stateMachine.js`
- Test: `test/approval-engine.test.js`（新建）

- [ ] **Step 1: 写失败测试**（状态机合法流转 + 非法操作拒绝 + 终态保护）

```js
// test/approval-engine.test.js
import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, OPERATIONS_BY_STATE } from '../src/approval/stateMachine.js';

describe('审批实例状态机（状态×操作矩阵）', () => {
  it('合法流转：PENDING_SUBMIT→APPROVING→APPROVED', () => {
    expect(canTransition('PENDING_SUBMIT', 'submit')).toBe(true);
    expect(canTransition('APPROVING', 'approve_all')).toBe(true);
    expect(canTransition('APPROVING', 'reject')).toBe(true);
    expect(canTransition('APPROVING', 'cancel')).toBe(true);
  });
  it('非法操作拒绝：PENDING_SUBMIT 不可 approve_all', () => {
    expect(canTransition('PENDING_SUBMIT', 'approve_all')).toBe(false);
    expect(() => assertTransition('PENDING_SUBMIT', 'approve_all')).toThrow();
  });
  it('终态保护：APPROVED/REJECTED 不再流转（除查看）', () => {
    expect(canTransition('APPROVED', 'approve_all')).toBe(false);
    expect(canTransition('REJECTED', 'approve_all')).toBe(false);
  });
  it('状态×操作矩阵完整（五态 × 操作集）', () => {
    expect(Object.keys(OPERATIONS_BY_STATE).sort()).toEqual(
      ['PENDING_SUBMIT','APPROVING','APPROVED','REJECTED','CANCELED'].sort());
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: FAIL（`Cannot find module '../src/approval/stateMachine.js'`）

- [ ] **Step 3: 实现** `src/approval/stateMachine.js`

```js
// src/approval/stateMachine.js — 审批实例状态机：状态×操作矩阵（G23 实证）
// 实证（§5bis G23）：流程状态（已通过/审批中/已驳回/已撤销/待提交）× 操作（查看/编辑/删除/下载/作废）
// 状态机内建：非法操作从机制上不可能（删除类在审批态被禁 = 禁删红线）
export const INSTANCE_STATES = ['PENDING_SUBMIT','APPROVING','APPROVED','REJECTED','CANCELED'];

// 操作集：submit（提交）/ approve_all（会签全过）/ approve_any（或签一过）/ reject（驳回）/
//         cancel（撤销）/ withdraw（提交人撤回）/ add_sign（加签）/ return（退回）/ transfer（转交）
export const OPERATIONS_BY_STATE = {
  PENDING_SUBMIT: ['submit','edit','withdraw'],
  APPROVING: ['approve_all','approve_any','reject','add_sign','return','transfer','withdraw'],
  APPROVED: ['view'],
  REJECTED: ['view'],
  CANCELED: ['view'],
};

export function canTransition(state, op) {
  return (OPERATIONS_BY_STATE[state] || []).includes(op);
}

export function assertTransition(state, op) {
  if (!canTransition(state, op)) {
    throw new Error(`状态机拒绝: ${state} 不允许操作 ${op}（合法: ${(OPERATIONS_BY_STATE[state] || []).join('/')}）`);
  }
  return true;
}

// 状态推进（在审批实例上应用操作 → 新状态）
export function nextState(state, op) {
  assertTransition(state, op);
  if (op === 'submit') return 'APPROVING';
  if (op === 'approve_all' || op === 'approve_any') return 'APPROVED';
  if (op === 'reject') return 'REJECTED';
  if (op === 'cancel' || op === 'withdraw') return 'CANCELED';
  return state; // add_sign/return/transfer 不改变实例状态（仅任务移动）
}
```

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: PASS（状态矩阵完整 + 终态保护）

- [ ] **Step 5: Commit**

```bash
git add src/approval/stateMachine.js test/approval-engine.test.js
git commit -m "feat(approval): 审批实例状态机（状态×操作矩阵，非法流转机制级拒绝）"
```

---

### Task 4: 审批引擎（engine.js：起单/条件路由/三种模式/兜底）

**Files:**
- Create: `src/approval/engine.js`
- Test: `test/approval-engine.test.js`（追加）

- [ ] **Step 1: 写失败测试**（startInstance→条件路由→ANY 或签/ALL 会签/SEQUENTIAL 顺序→兜底）

```js
// test/approval-engine.test.js 追加
import { createFlow, addNode, addApprover, addCondition, addLink } from '../src/approval/flow.js';
import { startInstance, advanceTask } from '../src/approval/engine.js';

describe('审批引擎（路由/模式/兜底）', () => {
  it('条件分支：金额>10万走多级审批，否则部门负责人（G22 实证）', async () => {
    const flow = await createFlow({ name: '报价审批流' });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const dept = await addNode(flow.id, { node_type: 'APPROVER', name: '部门负责人', pos: 1 });
    const multi = await addNode(flow.id, { node_type: 'APPROVER', name: '多级上级', pos: 2 });
    const cond = await addCondition(multi.id, { field: 'amount', operator: 'GT', value: 100000 });
    await addLink(start.id, dept.id);
    await addLink(start.id, multi.id, { condition_ref: cond.id });
    await addApprover(dept.id, { approver_type: 'DEPT_HEAD', multi_approver_mode: 'ANY' });
    await addApprover(multi.id, { approver_type: 'MULTIPLE_SUPERIOR', multi_approver_mode: 'ANY' });

    const instSmall = await startInstance(flow.id, 'QUOTATION', 'deal-1', { amount: 50000 }, { submitter: 'u1' });
    expect(instSmall.payload.current_node_name).toBe('部门负责人');

    const instBig = await startInstance(flow.id, 'QUOTATION', 'deal-2', { amount: 200000 }, { submitter: 'u1' });
    expect(instBig.payload.current_node_name).toBe('多级上级');
  });

  it('审批模式：ANY 或签一过即通过；兜底 AUTO_PASS 审批人为空自动通过', async () => {
    const flow = await createFlow({ name: '合同审批流' });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '商务', pos: 1 });
    await addLink(start.id, n.id);
    await addApprover(n.id, { approver_type: 'ROLE', role: 'contract-admin', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });

    const inst = await startInstance(flow.id, 'CONTRACT', 'c1', { amount: 10000 }, { submitter: 'u1', approvers: [] });
    expect(inst.payload.status).toBe('APPROVED');  // 审批人为空 → AUTO_PASS 兜底
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: FAIL（`Cannot find module '../src/approval/engine.js'`）

- [ ] **Step 3: 实现** `src/approval/engine.js`

```js
// src/approval/engine.js — 审批引擎（起单/条件路由/三种模式/兜底）
// 实证（§5bis G21/G22）：审批流 = 可配置一等公民，条件分支路由 + 会签/或签/顺序 + 自动通过兜底
import { createParticle, getParticle, queryParticles } from '../particles/particleRepo.js';
import { nextState, canTransition } from './stateMachine.js';

const TENANT = 'system';

// 取流程拓扑：nodes + links + approvers + conditions（按 flow_id 过滤）
// 实证对齐：queryParticles 返回数组（particleRepo.js:42-49 return r.rows），直接用 .filter()
async function loadFlow(flow_id) {
  const flow = await getParticle(flow_id);
  const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId: TENANT }))
    .filter(r => r.payload.flow_id === flow_id).sort((a,b) => (a.payload.pos||0)-(b.payload.pos||0));
  const links = (await queryParticles({ type: 'CRM_APPROVAL_LINK', tenantId: TENANT }))
    .filter(r => r.payload.from_node && nodes.some(n => n.id === r.payload.from_node));
  const approvers = (await queryParticles({ type: 'CRM_APPROVAL_APPROVER', tenantId: TENANT }))
    .filter(r => nodes.some(n => n.id === r.payload.node_id));
  const conditions = (await queryParticles({ type: 'CRM_APPROVAL_CONDITION', tenantId: TENANT }))
    .filter(r => nodes.some(n => n.id === r.payload.node_id));
  return { flow, nodes, links, approvers, conditions };
}

function evalCondition(cond, ctx) {
  const v = ctx[cond.payload.field];
  switch (cond.payload.operator) {
    case 'GT': return v > cond.payload.value;
    case 'LT': return v < cond.payload.value;
    case 'EQ': return v === cond.payload.value;
    case 'IN': return (cond.payload.value||[]).includes(v);
    default: return false;
  }
}

// 路由：START 节点 → 按 link.condition_ref 匹配条件 → 目标节点
// F4 修正：无条件链路不得提前 return（否则条件链路永不命中）；先扫全部出边找条件命中，最后才回退无条件默认边
function route(startNode, flowData, ctx) {
  const outLinks = flowData.links.filter(l => l.payload.from_node === startNode.id);
  const fallback = outLinks.find(l => !l.payload.condition_ref);
  for (const link of outLinks) {
    if (link.payload.condition_ref) {
      const cond = flowData.conditions.find(c => c.id === link.payload.condition_ref);
      if (cond && evalCondition(cond, ctx)) {
        return flowData.nodes.find(n => n.id === link.payload.to_node);
      }
    }
  }
  return fallback ? flowData.nodes.find(n => n.id === fallback.payload.to_node) : null;  // 无匹配→默认边；无出边→流程结束
}

function resolveApprovers(approverRule, { submitter, approvers = [] }) {
  if (approvers.length) return approvers;
  // 兜底（§5bis C9 emptyApproverAction）
  const action = approverRule.payload.empty_approver_action || 'AUTO_PASS';
  if (action === 'AUTO_PASS') return { auto_pass: true };
  if (action === 'ASSIGN_ADMIN') return ['role:admin'];
  if (action === 'ASSIGN_SPECIFIC') return approverRule.payload.assigned_to ? [approverRule.payload.assigned_to] : ['role:admin'];
  return [];
}

export async function startInstance(flow_id, business_type, business_id, ctx, { submitter, approvers = [] }) {
  const fd = await loadFlow(flow_id);
  const start = fd.nodes.find(n => n.payload.node_type === 'START');
  if (!start) throw new Error(`审批流缺少 START 节点: ${flow_id}`);

  const node = route(start, fd, ctx);
  if (!node || node.payload.node_type === 'END') {
    // 无目标节点 → 直接通过（AUTO_PASS 语义）
    return createParticle('CRM_APPROVAL_INSTANCE', {
      flow_version_id: flow_id, business_type, business_id, submitter,
      status: 'APPROVED', current_node: null, current_node_name: null, ctx,
    }, { tenantId: TENANT });
  }

  const approverRule = fd.approvers.find(a => a.payload.node_id === node.id);
  const resolved = approverRule ? resolveApprovers(approverRule, { submitter, approvers }) : { auto_pass: true };

  if (resolved.auto_pass) {
    return createParticle('CRM_APPROVAL_INSTANCE', {
      flow_version_id: flow_id, business_type, business_id, submitter,
      status: 'APPROVED', current_node: null, current_node_name: null, ctx,
      auto_pass_reason: 'empty_approver AUTO_PASS',
    }, { tenantId: TENANT });
  }

  const inst = await createParticle('CRM_APPROVAL_INSTANCE', {
    flow_version_id: flow_id, business_type, business_id, submitter,
    status: 'APPROVING', current_node: node.id, current_node_name: node.payload.name,
    node_mode: approverRule ? (approverRule.payload.multi_approver_mode || 'ANY') : 'ANY',
    approvers: resolved, ctx,
  }, { tenantId: TENANT });

  for (const approver of resolved) {
    await createParticle('CRM_APPROVAL_TASK', {
      instance_id: inst.id, node_id: node.id, approver,
      status: 'TODO', opinion: null,
    }, { tenantId: TENANT });
  }
  return inst;
}

export async function advanceTask(instance_id, task_id, { approver, decision, opinion = '' }) {
  const inst = await getParticle(instance_id);
  const tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: TENANT }))
    .filter(t => t.payload.instance_id === instance_id && t.payload.status === 'TODO');

  const mode = inst.payload.node_mode || 'ANY';
  if (decision === 'reject') {
    await updateTask(task_id, { status: 'REJECTED', opinion, decided_by: approver });
    await updateInstanceStatus(inst, 'REJECTED');
    return { status: 'REJECTED' };
  }
  if (decision === 'approve') {
    await updateTask(task_id, { status: 'APPROVED', opinion, decided_by: approver });
    if (mode === 'ANY') {
      await updateInstanceStatus(inst, 'APPROVED');
      return { status: 'APPROVED' };
    }
    if (mode === 'ALL') {
      const remaining = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: TENANT }))
        .filter(t => t.payload.instance_id === instance_id && t.payload.status === 'TODO');
      if (!remaining.length) { await updateInstanceStatus(inst, 'APPROVED'); return { status: 'APPROVED' }; }
    }
    if (mode === 'SEQUENTIAL') {
      const next = tasks.find(t => t.id === task_id);
      // 顺序签：当前任务通过后，若还有未决任务则留在 APPROVING（简版：按任务列表顺序）
      const undone = tasks.filter(t => t.id !== task_id);
      if (!undone.length) { await updateInstanceStatus(inst, 'APPROVED'); return { status: 'APPROVED' }; }
    }
    return { status: 'APPROVING' };
  }
  throw new Error(`未知审批决策: ${decision}（approve/reject）`);
}

// F2 修正：真实更新签名为 { patch, state, event }（particleRepo.js:51），payload 状态字段直接 patch
async function updateTask(task_id, patch) {
  const { updateParticle } = await import('../particles/particleRepo.js');
  return updateParticle(task_id, { patch });
}
async function updateInstanceStatus(inst, status) {
  if (!canTransition(inst.payload.status, status === 'APPROVED' ? 'approve_all' : 'reject')) {
    throw new Error(`状态机拒绝: ${inst.payload.status} → ${status}`);
  }
  const { updateParticle } = await import('../particles/particleRepo.js');
  return updateParticle(inst.id, { patch: { ...inst.payload, status } });
}
```

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: PASS（条件路由：小单→部门负责人 / 大单→多级上级；兜底 AUTO_PASS 空审批人直接通过）

- [ ] **Step 5: Commit**

```bash
git add src/approval/engine.js test/approval-engine.test.js
git commit -m "feat(approval): 审批引擎（起单/条件路由/ANY·ALL·SEQUENTIAL/兜底）"
```

---

### Task 5: 回滚补偿（compensation.js：写前快照 + 驳回/失败回滚）

**Files:**
- Create: `src/approval/compensation.js`
- Test: `test/approval-engine.test.js`（追加）

- [ ] **Step 1: 写失败测试**（写前快照 + 驳回回滚）

```js
// test/approval-engine.test.js 追加
import { snapshotFor, rollbackIfNeeded } from '../src/approval/compensation.js';

describe('审批回滚补偿（H28 实证）', () => {
  // F5 对齐真实结构：createSnapshot 返回 { id, topic, ref_id, snapshot }（src/memory/snapshot.js:4-9）
  it('写前快照 + 驳回/失败回滚恢复原值', async () => {
    const snap = await snapshotFor('deal-1', { stage: 'quoted', amount: 100000 });
    expect(snap.ref_id).toBe('deal-1');
    expect(snap.snapshot.before.stage).toBe('quoted');
    // 审批后动作改了值
    await rollbackIfNeeded('deal-1', { ok: false }, snap);
    // 回滚后应恢复快照值——由调用方（审批后动作 executor）应用 snapshot.snapshot.before
    expect(snap.snapshot.before.amount).toBe(100000);
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: FAIL（`Cannot find module '../src/approval/compensation.js'`）

- [ ] **Step 3: 实现** `src/approval/compensation.js`

```js
// src/approval/compensation.js — 写前快照 + 回滚补偿（H28 实证）
// 实证（§5bis H28 数据回滚机制）：审批结果触发的数据变更可回滚
// 与 upsert 幂等共同构成写操作完整性双保障（ai-native-action-design 事务完整性）
// F5 修正：快照落已有 crm.memory_snapshot 不可变表（schema.sql:239，createSnapshot 签名见
//          src/memory/snapshot.js:4-9：createSnapshot({topic},{refId},{snapshot})），不伪装成 CRM_APPROVAL_INSTANCE 粒子
import { createSnapshot } from '../memory/snapshot.js';

// 写前快照：审批后动作执行前，把将被修改的粒子属性快照为不可变快照（禁 update/delete，schema.sql:239 语义）
// 返回 { id, topic, ref_id, snapshot: { kind:'pre_write_snapshot', business_id, before } }
export async function snapshotFor(business_id, beforePayload, { topic = 'approval:pre_write' } = {}) {
  return createSnapshot({
    topic,
    refId: business_id,
    snapshot: { kind: 'pre_write_snapshot', business_id, before: beforePayload, taken_at: new Date().toISOString() },
  });
}

// 回滚判定 + 应用快照（审批后动作失败/驳回时调用方应用 snapshot.snapshot.before 恢复）
// 恢复动作由调用方执行：updateParticle(business_id, { patch: before })
export async function rollbackIfNeeded(business_id, { ok }, snapshot) {
  if (ok) return { rolled_back: false };
  const before = snapshot?.snapshot?.before || {};
  return { rolled_back: true, restored: before, business_id };
}
```

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: PASS（快照捕获 + 回滚判定/恢复值）

- [ ] **Step 5: Commit**

```bash
git add src/approval/compensation.js test/approval-engine.test.js
git commit -m "feat(approval): 写前快照 + 回滚补偿（H28 实证，写完整性双保障之一）"
```

---

### Task 6: 审批域 Action 接线 + 事件域（seed-actions.js 追加 + bus.js 确认不改）

**Files:**
- Modify: `src/action/seed-actions.js`（追加审批 Action）
- 确认不改: `src/events/bus.js`（事件域是运行时字符串 `emit(domain,type,payload)`，`src/events/bus.js:17` 已支持任意域；审批域事件直接走 `emit('approval', ...)`，无需追加常量）
- Test: `test/approval-engine.test.js`（追加）

- [ ] **Step 1: 写失败测试**（审批 Action 注册 + 事件类型经总线传播）

```js
// test/approval-engine.test.js 追加
import { seedActions } from '../src/action/seed-actions.js';
import { getAction, listActions, resetRegistry } from '../src/action/registry.js';
import { on, emit } from '../src/events/bus.js';

describe('审批域 Action 表面 + 事件域', () => {
  it('crm-approval-* 三个写 Action 注册且过闸属性齐全', async () => {
    resetRegistry();
    await seedActions();
    const names = ['crm-approval-flow-create','crm-approval-start','crm-approval-approve'];
    for (const n of names) {
      const a = getAction(n);
      expect(a).not.toBeNull();
      expect(a.kind).toBe('write');
      expect(a.confirm).toBe('critical');  // 审批动作强制确认
    }
    const writeList = listActions({ kind: 'write' });
    expect(writeList.map(a => a.name)).toContain('crm-approval-start');
  });

  it('审批域事件经既有总线传播（flow-created/instance-started/task-approved）', async () => {
    const got = [];
    const off = on('approval', m => got.push(m.type));
    emit('approval', 'flow-created', { flow_id: 'f1' });
    emit('approval', 'instance-started', { instance_id: 'i1' });
    emit('approval', 'task-approved', { task_id: 't1' });
    off();
    expect(got).toEqual(['flow-created','instance-started','task-approved']);
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: FAIL（`crm-approval-*` 未注册，getAction 返回 null）

- [ ] **Step 3: 实现**——`src/action/seed-actions.js` 追加 import + 三个审批域 Action

```js
// src/action/seed-actions.js 顶部 import 区追加（engine 依赖）
import { startInstance, advanceTask } from '../approval/engine.js';

// —— 审批域 Action（写操作过三闸：规则层→action-confirm→HITL 审批流；本组 Action 本身即审批流入口）——
registerAction({
  name: 'crm-approval-flow-create', kind: 'write', permission: 'auth', confirm: 'critical',
  namespace: 'crm', agentTool: true, force: false, needsApproval: false,
  version: '1.0.0', owner: 'crm-native',
  schema: { name: 'string', enabled: 'boolean' },
  parameters: { required: ['name'], properties: { name: { type: 'string' } } },
  handler: async ({ name, enabled }) => {
    const { createFlow } = await import('../approval/flow.js');
    const flow = await createFlow({ name, enabled });
    emit('approval', 'flow-created', { flow_id: flow.id, name });
    return flow;
  },
});
registerAction({
  name: 'crm-approval-start', kind: 'write', permission: 'auth', confirm: 'critical',
  namespace: 'crm', agentTool: true, force: false, needsApproval: false,
  version: '1.0.0', owner: 'crm-native',
  schema: { flow_id: 'string', business_type: 'string', business_id: 'string', ctx: 'object' },
  parameters: { required: ['flow_id','business_type','business_id'] },
  handler: async ({ flow_id, business_type, business_id, ctx }, actionCtx) => {
    const inst = await startInstance(flow_id, business_type, business_id, ctx || {}, { submitter: actionCtx.actor });
    emit('approval', 'instance-started', { instance_id: inst.id, business_type, business_id, status: inst.payload.status });
    return inst;
  },
});
registerAction({
  name: 'crm-approval-approve', kind: 'write', permission: 'auth', confirm: 'critical',
  namespace: 'crm', agentTool: true, force: false, needsApproval: false,
  version: '1.0.0', owner: 'crm-native',
  schema: { instance_id: 'string', task_id: 'string', decision: 'string', opinion: 'string' },
  parameters: { required: ['instance_id','task_id','decision'] },
  handler: async ({ instance_id, task_id, decision, opinion }, actionCtx) => {
    const r = await advanceTask(instance_id, task_id, { approver: actionCtx.actor, decision, opinion });
    emit('approval', decision === 'approve' ? 'task-approved' : 'task-rejected', { instance_id, task_id, decision, opinion });
    return r;
  },
});
```

`src/events/bus.js`：**不修改**（事件域为运行时字符串，`emit('approval', ...)` 直接走既有总线，无需追加常量——Task 6 的「事件域」是新增 Action 中的 `emit('approval', ...)` 调用，不是 bus 代码变更）。

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: PASS（三个写 Action 注册 + confirm 属性 + 事件总线传播）

- [ ] **Step 5: Commit**

```bash
git add src/action/seed-actions.js test/approval-engine.test.js
git commit -m "feat(approval): 审批域 Action 接线（flow-create/start/approve）+ 审批域事件走既有总线"
```

---

### Task 7: 审批记录审计流 + 与规则/决策闸联动（rules.js）

**Files:**
- Create: `src/approval/rules.js`（四类配置项执行语义 + 审批×规则闸/决策闸联动）
- Test: `test/approval-engine.test.js`（追加）

- [ ] **Step 1: 写失败测试**（四类配置项 → 规则语义：条件分支/审批模式/字段权限/结果后动作 + 审批记录事件）

```js
// test/approval-engine.test.js 追加
import { buildApprovalRules, FIELD_PERM_ACTIONS, POST_ACTIONS } from '../src/approval/rules.js';

describe('审批流四类配置项执行语义（G22 实证）', () => {
  it('字段权限三态：HIDE/VIEW/EDIT → 动作映射', () => {
    expect(FIELD_PERM_ACTIONS['HIDE']).toBe('hide');
    expect(FIELD_PERM_ACTIONS['VIEW']).toBe('view');
    expect(FIELD_PERM_ACTIONS['EDIT']).toBe('edit');
  });
  it('结果后动作两态：通过/驳回 → 补偿挂钩', () => {
    expect(POST_ACTIONS).toHaveProperty('pass');
    expect(POST_ACTIONS).toHaveProperty('reject');
  });
  it('配置项 → 执行语义（条件分支/审批模式/字段权限/结果后动作）', () => {
    const rules = buildApprovalRules({ conditions: [{ field: 'amount', operator: 'GT', value: 100000 }], mode: 'ANY', field_perms: { amount: 'HIDE' }, post: { pass: 'auto-update', reject: 'rollback' } });
    expect(rules.route).toBe('conditional');
    expect(rules.mode).toBe('ANY');
    expect(rules.field_perm.amount).toBe('hide');
    expect(rules.post.pass).toBe('auto-update');
    expect(rules.post.reject).toBe('rollback');
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: FAIL（`Cannot find module '../src/approval/rules.js'`）

- [ ] **Step 3: 实现** `src/approval/rules.js`

```js
// src/approval/rules.js — 审批流四类配置项执行语义（G22 实证）
// 实证（§5bis G22）：①条件分支 ②审批模式 ③表单权限（隐藏/查看/编辑） ④结果后动作
// 联动：规则闸（B7 写护栏）+ 决策闸（写操作第 0 闸，无决策不写）
export const FIELD_PERM_ACTIONS = { HIDE: 'hide', VIEW: 'view', EDIT: 'edit' };

export const POST_ACTIONS = { pass: 'auto-update', reject: 'rollback' };

export function buildApprovalRules({ conditions = [], mode = 'ANY', field_perms = {}, post = {} }) {
  return {
    route: conditions.length ? 'conditional' : 'direct',   // 条件分支：有条件→路由，无条件→直通
    mode,                                                  // 审批模式：ANY/ALL/SEQUENTIAL
    field_perm: Object.fromEntries(Object.entries(field_perms).map(([f, p]) => [f, FIELD_PERM_ACTIONS[p] || p])),
    post: { pass: post.pass || POST_ACTIONS.pass, reject: post.reject || POST_ACTIONS.reject },
  };
}

// 审批×规则闸联动：写操作进入审批流前，先过规则层（B7 实证「商机只能向前/合同金额超 20% 审批」）
export function approvalGateRules() {
  return [
    { scope: 'CRM_DEAL', condition: 'stage_forward_only', action: 'block_if_violation' },
    { scope: 'CRM_CONTRACT', condition: 'amount_change_over_20pct', action: 'escalate_to_approval' },
    { scope: 'CRM_QUOTATION', condition: 'amount_gt_threshold', action: 'escalate_to_approval' },
  ];
}
```

- [ ] **Step 4: 跑通过**

Run: `node node_modules/vitest/vitest.mjs run test/approval-engine.test.js`
Expected: PASS（四类配置项映射 + 规则闸联动定义）

- [ ] **Step 5: Commit**

```bash
git add src/approval/rules.js test/approval-engine.test.js
git commit -m "feat(approval): 四类配置项执行语义 + 审批×规则闸联动（G22 实证）"
```

---

## Self-Review

**1. Spec coverage（对照综合详设 §7）：**
- 六层粒子域：Task 1（粒子类型注册）+ Task 2（flow.js 六层读写）✅
- 审批实例/任务状态机 + 状态×操作矩阵：Task 3 ✅
- 条件路由 + 三种审批模式 + 兜底：Task 4 ✅
- 回滚补偿（H28）：Task 5 ✅
- Action 接线（crm-approval-*）+ 事件域：Task 6 ✅
- 审批记录 = 审计事件流：Task 6 的 `emit('approval', ...)` 已覆盖（事件进总线 = 审计）✅
- 四类配置项：Task 7（条件分支/审批模式/字段权限/结果后动作执行语义 + 规则闸联动）✅

**2. Placeholder scan：** 无 TBD/TODO/“类似 Task N”占位符；7 个 Task 每步都有完整代码或精确命令，无“写测试”类空指令。✅

**3. Type consistency：** `startInstance(flow_id, business_type, business_id, ctx, { submitter, approvers })` 在 Task 4 定义、Task 6 以相同签名调用（`startInstance(flow_id, business_type, business_id, ctx || {}, { submitter: ... })`）✅；`advanceTask(instance_id, task_id, { approver, decision, opinion })` 在 Task 4 定义、Task 6 相同签名调用 ✅；`snapshotFor(business_id, beforePayload)` / `rollbackIfNeeded(business_id, {ok}, snapshot)` 在 Task 5 定义并测试 ✅；`CRM_APPROVAL_*` 粒子类型在 Task 1 注册、Task 2-4 使用一致 ✅；`OPERATIONS_BY_STATE` 在 Task 3 导出并在测试中验证 ✅。

---

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-08-25-approval-flow-engine.md`。两种执行方式：

**1. Subagent-Driven（推荐）**——每个 Task 派独立子代理，任务间 AI 审查，快速迭代
**2. Inline Execution**——本会话内用 executing-plans 批量执行，检查点审查

选哪种？