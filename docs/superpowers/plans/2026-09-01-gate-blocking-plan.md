# gate 阻断式（② review-gate 不通过 → 主任务挂起）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 review-gate 的「不通过」真正阻断重大商机主任务——gated(major/L3) 任务先跑主 agent 出草稿，再经 `method-review-gate` 评审；verdict=pass 才 `completeTask`（定稿），reject 则主任务转 `blocked`(`block_kind='gate_reject'`) 挂起等人工裁决。

**Architecture:** 编排层两阶段（草稿→评审）由 `dispatchOneCore` 改造实现，无需 SKILL draft/apply 拆分（推理 agent 产物即 episode，非独立业务态）。verdict 契约落在 `method-review-gate` outcome（`verdict: pass|reject` + `defects`）；`runGateAgents` 读 verdict（异常/缺 verdict → 保守 reject）；`gateBlockTask`/`approveGateBlock` 复用既有 `blocked` 态 + `block_kind` 列，零 schema 迁移。设计文档：`docs/2026-09-01-gate-blocking-design.md`（已批准，validate-contract `valid:true`）。

**Tech Stack:** Node 22 + ESM + vitest 3（mock pg）；PostgreSQL 16（`crm` schema，复用既有 `tasks.blocked`/`block_kind`/`error` 列）；事件总线 `src/events/bus.js`。

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/kanban/kanban.js` | 状态机。新增 `gateBlockTask`（running→blocked gate_reject）+ `approveGateBlock`（blocked→done 人工放行） | Modify |
| `src/kanban/scheduler.js` | 编排。`runGateAgents` 读 verdict（fail-safe）；`dispatchOneCore` 末尾分支 reject→gateBlockTask | Modify |
| `skills/method-review-gate/SKILL.md` | 评审把关方法论。补结构化 verdict 输出契约 | Modify |
| `test/kanban/gate-block.test.js` | `gateBlockTask`/`approveGateBlock` 单测 | Create |
| `test/kanban/scheduler-gate.test.js` | `runGateAgents` verdict 解析单测 | Create |
| `test/kanban/dispatch-gate-block.test.js` | `dispatchOneCore` 分支单测（reject→block / pass→done / L2 不受影响） | Create |

> 影响范围：仅 `gateAgents.length>0`（major/L3）任务；L2 复盘任务（`gateAgents=[]`，事件触发式复盘 ③）不受影响。零 schema 迁移。

---

### Task 1: kanban 新增 gateBlockTask + approveGateBlock（TDD）

**Files:**
- Modify: `src/kanban/kanban.js`（在 `failTask` 之后、`:90` 之后插入两个函数）
- Test: `test/kanban/gate-block.test.js`

- [ ] **Step 1: 写失败单测**

```js
// test/kanban/gate-block.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/db.js', () => ({ query: vi.fn(), queryWrite: vi.fn() }));
import { query, queryWrite } from '../src/db.js';
import { gateBlockTask, approveGateBlock } from '../src/kanban/kanban.js';

const mockTask = (over = {}) => ({ id: 't1', status: 'running', block_kind: null, error: null, consecutive_failures: 0, ...over });

describe('gateBlockTask', () => {
  beforeEach(() => vi.clearAllMocks());
  it('running → blocked(gate_reject)', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'running' })] });
    queryWrite.mockResolvedValue({ rows: [{ id: 't1', status: 'blocked', block_kind: 'gate_reject' }] });
    const gate = { 'review-gate': { ok: false, verdict: 'reject', defects: ['毛利不达标'] } };
    const r = await gateBlockTask('t1', { gate });
    expect(r.status).toBe('blocked');
    expect(queryWrite.mock.calls[0][0]).toContain("status='blocked'");
    expect(queryWrite.mock.calls[0][0]).toContain("block_kind='gate_reject'");
  });
  it('非 running 抛错', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'done' })] });
    await expect(gateBlockTask('t1', {})).rejects.toThrow('不可 gate 阻断');
  });
});

describe('approveGateBlock', () => {
  beforeEach(() => vi.clearAllMocks());
  it('blocked(gate_reject) → done', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'blocked', block_kind: 'gate_reject' })] });
    queryWrite.mockResolvedValue({ rows: [{ id: 't1', status: 'done' }] });
    const r = await approveGateBlock('t1', { byActor: 'user' });
    expect(r.status).toBe('done');
    expect(queryWrite.mock.calls[0][0]).toContain("status='done'");
  });
  it('非 blocked(gate_reject) 抛错', async () => {
    query.mockResolvedValue({ rows: [mockTask({ status: 'running' })] });
    await expect(approveGateBlock('t1', {})).rejects.toThrow('不在 blocked(gate_reject)');
  });
});
```

- [ ] **Step 2: 运行单测确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/gate-block.test.js`
Expected: FAIL（`gateBlockTask is not exported`）

- [ ] **Step 3: 实现两个函数（插入 `failTask` 之后）**

在 `src/kanban/kanban.js` 的 `failTask` 函数（`export async function failTask ...` 结束的 `}`）之后追加：

```js
// gate 阻断：running → blocked(gate_reject)；主任务未定稿，等人工裁决（② gate 阻断式）
export async function gateBlockTask(id, { gate = null, byActor = 'scheduler' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'running') throw new Error(`任务 ${id} 状态 ${t.status} 不可 gate 阻断（需 running）`);
  const summary = gate ? JSON.stringify(gate) : null;
  const r = await queryWrite(
    `UPDATE tasks SET status='blocked', block_kind='gate_reject', error=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [summary, id]
  );
  await auditTransition(id, 'running', 'blocked', byActor, `gate_reject: ${(summary || '').slice(0, 200)}`);
  emit('task', 'blocked', { id, block_kind: 'gate_reject' });
  return r.rows[0];
}

// 人工放行：blocked(gate_reject) → done（定稿）
export async function approveGateBlock(id, { byActor = 'user' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'blocked' || t.block_kind !== 'gate_reject') throw new Error(`任务 ${id} 不在 blocked(gate_reject)`);
  const r = await queryWrite(
    `UPDATE tasks SET status='done', block_kind=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  await auditTransition(id, 'blocked', 'done', byActor, 'gate_approve');
  emit('task', 'done', { id });
  return r.rows[0];
}
```

- [ ] **Step 4: 运行单测确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/gate-block.test.js`
Expected: PASS（4/4）

- [ ] **Step 5: Commit**

```bash
git add src/kanban/kanban.js test/kanban/gate-block.test.js
git commit -m "feat(kanban): add gateBlockTask/approveGateBlock for gate-reject hold"
```

---

### Task 2: runGateAgents 读 verdict（fail-safe）

**Files:**
- Modify: `src/kanban/scheduler.js`（`runGateAgents` `:126-142` 整段替换）
- Test: `test/kanban/scheduler-gate.test.js`

- [ ] **Step 1: 写失败单测**

```js
// test/kanban/scheduler-gate.test.js
import { describe, it, expect } from 'vitest';
import { runGateAgents } from '../src/kanban/scheduler.js';

const routed = (gateAgents) => ({ gateAgents, payload: { level: 'major' } });
const task = { id: 't1', payload: {} };

describe('runGateAgents verdict', () => {
  it('verdict=pass → ok true', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => ({ verdict: 'pass', defects: [] }));
    expect(out['review-gate'].ok).toBe(true);
    expect(out['review-gate'].verdict).toBe('pass');
  });
  it('verdict=reject → ok false + defects', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => ({ verdict: 'reject', defects: ['毛利不达标'] }));
    expect(out['review-gate'].ok).toBe(false);
    expect(out['review-gate'].verdict).toBe('reject');
    expect(out['review-gate'].defects).toContain('毛利不达标');
  });
  it('异常 → 保守 reject（fail-safe）', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => { throw new Error('llm down'); });
    expect(out['review-gate'].ok).toBe(false);
    expect(out['review-gate'].verdict).toBe('reject');
  });
  it('缺 verdict → 保守 reject', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => ({ summary: 'ok' }));
    expect(out['review-gate'].ok).toBe(false);
    expect(out['review-gate'].verdict).toBe('reject');
  });
});
```

- [ ] **Step 2: 运行单测确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/scheduler-gate.test.js`
Expected: FAIL（当前 `out[g]` 无 `verdict` 字段，`ok` 恒 true）

- [ ] **Step 3: 实现 verdict 解析（替换 `runGateAgents` 整段）**

将 `src/kanban/scheduler.js` 的 `runGateAgents`（`:125-142`）整段替换为：

```js
// gate agent 串行把关：每个 gate 用自身身份执行，读结构化 verdict，失败隔离不抛
export async function runGateAgents(routed, task, runWithSkill) {
  const out = {};
  for (const g of routed.gateAgents || []) {
    const contractTask = contractIdForAgent(g) || `gate:${g}`;
    const gCtx = { contractTask, actor: g };
    const gTask = {
      ...task,
      payload: { ...routed.payload, skill_slug: primarySkillFor(g), contract_task_id: contractTask },
    };
    try {
      const o = await runWithSkill(gTask, { ctx: gCtx });
      const verdict = o?.verdict || o?.outcome?.verdict; // 兼容 outcome 包裹
      // fail-safe：verdict 缺失或非 'pass' → 保守 reject（避免静默通过）
      const ok = verdict === 'pass';
      out[g] = {
        ok,
        verdict: ok ? 'pass' : 'reject',
        outcome: o,
        defects: ok ? [] : (o?.defects || ['verdict 非 pass 或缺失']),
      };
    } catch (e) {
      // 异常 → 保守 reject（fail-safe），避免"抛异常被当成通过"
      out[g] = { ok: false, verdict: 'reject', error: e?.message || String(e), defects: ['gate 执行异常'] };
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行单测确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/scheduler-gate.test.js`
Expected: PASS（4/4）

- [ ] **Step 5: Commit**

```bash
git add src/kanban/scheduler.js test/kanban/scheduler-gate.test.js
git commit -m "feat(scheduler): runGateAgents reads structured verdict (fail-safe reject)"
```

---

### Task 3: dispatchOneCore 两阶段分支（reject→block）

**Files:**
- Modify: `src/kanban/scheduler.js:5`（import 加 `gateBlockTask`）+ `:100-101`（替换无条件 completeTask 为分支）
- Test: `test/kanban/dispatch-gate-block.test.js`

- [ ] **Step 1: 写失败单测**

```js
// test/kanban/dispatch-gate-block.test.js
vi.mock('../src/kanban/kanban.js', () => ({
  claimTask: vi.fn(async (id) => ({ id, status: 'running' })),
  completeTask: vi.fn(async (id) => ({ id, status: 'done' })),
  failTask: vi.fn(async (id) => ({ id, status: 'failed' })),
  gateBlockTask: vi.fn(async (id) => ({ id, status: 'blocked', block_kind: 'gate_reject' })),
}));
import { dispatchOneCore } from '../src/kanban/scheduler.js';
import { completeTask, gateBlockTask } from '../src/kanban/kanban.js';
import { describe, it, expect, beforeEach } from 'vitest';

const majorTask = { id: 'm1', payload: { intent: 'quote', level: 'major' } };

describe('dispatchOneCore gate blocking', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('major reject → gateBlockTask, 不 completeTask', async () => {
    const runWithSkillFn = async (t) =>
      t.payload.contract_task_id === 'ct-quote-calc'
        ? { draft: 'quote' }
        : { verdict: 'reject', defects: ['毛利不达标'] };
    await dispatchOneCore(majorTask, { runWithSkillFn });
    expect(gateBlockTask).toHaveBeenCalledWith('m1', expect.any(Object));
    expect(completeTask).not.toHaveBeenCalled();
  });
  it('major pass → completeTask', async () => {
    const runWithSkillFn = async (t) =>
      t.payload.contract_task_id === 'ct-quote-calc'
        ? { draft: 'quote' }
        : { verdict: 'pass', defects: [] };
    await dispatchOneCore(majorTask, { runWithSkillFn });
    expect(completeTask).toHaveBeenCalledWith('m1', expect.any(Object));
    expect(gateBlockTask).not.toHaveBeenCalled();
  });
  it('L2 复盘任务(gateAgents=[]) → 不受影响', async () => {
    const retroTask = { id: 'r1', payload: { intent: 'retro', level: 'L2' } };
    const runWithSkillFn = async () => ({ draft: 'retro' });
    await dispatchOneCore(retroTask, { runWithSkillFn });
    expect(completeTask).toHaveBeenCalledWith('r1', expect.any(Object));
    expect(gateBlockTask).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行单测确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/dispatch-gate-block.test.js`
Expected: FAIL（`gateBlockTask` 未被调用；`completeTask` 恒被调用）

- [ ] **Step 3: 实现分支 + 补 import**

`src/kanban/scheduler.js:5` 改为：
```js
import { claimTask, completeTask, failTask, gateBlockTask, listTasks } from './kanban.js';
```

`src/kanban/scheduler.js:100-101`（原 `const gate = await runGateAgents(...); await completeTask(task.id, { result: { ...(outcome || {}), gate } });`）替换为：
```js
    const gate = await runGateAgents(routed, task, runWithSkill);
    const rejected = Object.values(gate).some((g) => g && g.ok === false);
    if (rejected) {
      await gateBlockTask(task.id, { gate });
    } else {
      await completeTask(task.id, { result: { ...(outcome || {}), gate } });
    }
```
（同时删除上方 `:97-99` 注释中「gate 失败不阻断主任务」的旧说明，改为「gate reject → 主任务 blocked(gate_reject) 挂起」）

- [ ] **Step 4: 运行单测确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/dispatch-gate-block.test.js`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add src/kanban/scheduler.js test/kanban/dispatch-gate-block.test.js
git commit -m "feat(scheduler): two-phase gated dispatch, reject blocks main task"
```

---

### Task 4: method-review-gate SKILL 补 verdict 输出契约

**Files:**
- Modify: `skills/method-review-gate/SKILL.md`（在「决策步骤」之后新增一节）

- [ ] **Step 1: 编辑 SKILL.md 新增 verdict 输出约定**

在 `## 决策步骤` 之后、`## 铁律` 之前插入：

```markdown
## 结构化 verdict 输出契约（gate 阻断前置，2026-09-01）

> 调度器 `runGateAgents` 据此判定「通过/不通过」，非仅靠异常。
> 每次评审**必须**以如下结构化结论收尾（写入 outcome 顶层字段）：

- `verdict`: `'pass'` | `'reject'` —— 四维审查全过且双闸门均放行才 `pass`；任一不通过即 `reject`
- `defects`: `string[]` —— `reject` 时列出具体缺陷（如「毛利低于阈值 18%」「合同缺少 SLA 条款」）；`pass` 时为空数组
- `summary`: `string` —— 一句评审结论

示例（reject）：
\`\`\`json
{ "verdict": "reject", "defects": ["报价毛利 12% < 阈值 18%", "合同未含数据合规条款"], "summary": "双闸门未过，退回重做" }
\`\`\`

> fail-safe：若未输出 `verdict` 或 `verdict!=='pass'`，调度器保守判 `reject`（主任务挂起），避免静默通过。
```

- [ ] **Step 2: 契约校验**

Run: `cd /d/system/CRM-ai-native && node scripts/validate-contract.mjs docs/2026-09-01-gate-blocking-design.md --registry src/agent/agentSpec.js`
Expected: `{ "valid": true, "errors": [] }`

- [ ] **Step 3: Commit**

```bash
git add skills/method-review-gate/SKILL.md
git commit -m "docs(review-gate): add structured verdict output contract"
```

---

### Task 5: 回归 + 质量门禁

**Files:** 无新增；运行既有测试 + lint

- [ ] **Step 1: 运行 gate 相关三套新单测**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban/gate-block.test.js test/kanban/scheduler-gate.test.js test/kanban/dispatch-gate-block.test.js`
Expected: PASS（合计 11/11）

- [ ] **Step 2: 事件触发复盘回归（③ 不受影响）**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/event-triggered-retro.test.js`
Expected: PASS（21/21，L2 复盘任务 `gateAgents=[]` 不被 gate 影响）

- [ ] **Step 3: 改动面回归（scheduler/kanban 全集）**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/kanban test/scheduler 2>/dev/null || npx vitest run test/ --silent 2>&1 | tail -n 20`
Expected: 全绿（无 gate 改动引入的回退）

- [ ] **Step 4: UI lint + CSS 变量审计**

Run: `cd /d/system/CRM-ai-native && node scripts/ui-lint.mjs && python tmp/audit_css_vars.py`
Expected: ui-lint 通过（exit 0）；CSS 变量审计 OK

- [ ] **Step 5: 契约文档最终校验（设计 + spec）**

Run: `cd /d/system/CRM-ai-native && node scripts/validate-contract.mjs docs/2026-09-01-gate-blocking-design.md --registry src/agent/agentSpec.js && node scripts/validate-contract.mjs docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md --registry src/agent/agentSpec.js`
Expected: 两份均 `valid: true`

- [ ] **Step 6: 回填设计文档 §8（实施记录）**

编辑 `docs/2026-09-01-gate-blocking-design.md` 的 `## §8 实施记录（落地后回填）`，替换 `_待批准 writing-plans 并落地后回填 §8.1-§8.5_`，写入：§8.1 改动清单表（Task1-4 对应文件）、§8.2 验证结果（11+21 单测绿、回归绿、lint 通过）、§8.3 阈值配置化（fail-safe 默认保守、预留 `gate-failsafe` config 开关）、§8.4 边界（仅 major/L3；L2 复盘不受影响；零 schema 迁移）、§8.5 提交状态（未 commit，无凭证）。

- [ ] **Step 7: 追加工作日志**

向 `D:\system\CRM-ai-native\.workbuddy\memory\2026-09-01.md` 追加「② gate 阻断式收口」工作笔记（缺口/方案 C/改动面/验证/铁律遵守/高复用经验）。

- [ ] **Step 8: Commit**

```bash
git add docs/2026-09-01-gate-blocking-design.md docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md .workbuddy/memory/2026-09-01.md
git commit -m "docs(gate-blocking): backfill §8 implementation record + memory note"
```

---

## 自我复查（Self-Review）

1. **Spec 覆盖**：§3 verdict 契约 → Task 2（runGateAgents）+ Task 4（SKILL）；§3.3/§3.4 两阶段编排 + blocked 态 → Task 1（gateBlockTask/approveGateBlock）+ Task 3（dispatchOneCore）；§4 改动清单四项全部映射到 Task 1-4；§5 验收 → Task 3 覆盖 5.1/5.3、Task 2 覆盖 5.2、Task 5 覆盖 5.4/5.5。**无缺口。**
2. **Placeholder 扫描**：所有 Step 均含完整代码或精确命令；无 TBD/TODO/「类似 Task N」。
3. **类型一致性**：`gateBlockTask(id,{gate})` 在 Task1 定义、Task3 调用一致；`approveGateBlock(id,{byActor})` 定义一致；`runGateAgents` 返回 `{ok,verdict,defects,outcome,error}` 在 Task2 定义、Task3 `Object.values(gate).some(g=>g.ok===false)` 消费一致。
4. **零 schema 迁移**：未新增列/枚举；`blocked`/`block_kind`/`error` 列复用（`failTask` 已用）。
5. **铁律遵守**：阈值配置化（fail-safe 默认保守 + 预留 `gate-failsafe` config，未硬编码阻断阈值）；禁 DELETE（仅 UPDATE 状态）；每 Task 一 commit；测试先行。
