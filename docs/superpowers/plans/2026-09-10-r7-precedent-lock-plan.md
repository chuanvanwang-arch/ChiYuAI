# R7 先例自锁 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用量化脚本 + 两道回归护栏锁定「先例池仅收 CONFIRMED/AUTONOMOUS 态」这一既正确行为，消除 R7「先例自锁」的不确定性，零语义变更、零回滚成本。

**Architecture:** 先例池即 `crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS')`（消费者侧闸门 `searchPrecedents` `decisionRepo.js:544`）。`confirmDecision`（`decisionRepo.js:630`）把 HUMAN 升 CONFIRMED 后自动入池；`createDecision` 仅以新决策为 `decision_id` 写 `decision_precedent_rel`，HUMAN 决策永不会成为 `precedent_id`。本计划不改动任何 src 行为，仅追加：① 只读诊断脚本（T1）；② T2/T3 回归测试锁定既有正确路径。设计文档：`docs/2026-09-10-r7-precedent-lock-design.md`。

**Tech Stack:** Node.js (ESM, `.mjs`) + Vitest + PostgreSQL（`src/db.js` 连接，库 `crm_native_test`）。测试沿用现有 `createDecision`/`searchPrecedents`/`confirmDecision` 接口与 `afterEach` TRUNCATE 清理纪律。

**契约对齐：** T1→`ct-retro-decision`(agent: decision-retro)；T2/T3→`ct-decision`(agent: decision-agent)。`validate-contract.mjs` 已校验设计文档契约 `{"valid":true,"errors":[]}`。

---

### Task 1: T1 量化 HUMAN 缺口诊断脚本（只读、可观测）

**Files:**
- Create: `scripts/r7-precedent-gap.mjs`

- [ ] **Step 1: 编写只读聚合脚本**

```js
// scripts/r7-precedent-gap.mjs
// R7-T1：量化 HUMAN 态决策占比与升级→确认率（只读，不写库）
import { query } from '../src/db.js';

const r = await query(`
  SELECT state, count(*)::int n
  FROM crm.decision
  GROUP BY state ORDER BY n DESC
`);
const total = r.rows.reduce((s, x) => s + x.n, 0);
const byState = Object.fromEntries(r.rows.map((x) => [x.state, x.n]));
const human = byState['HUMAN'] || 0;
const humanShare = total ? ((human / total) * 100).toFixed(2) : '0.00';

const ev = await query(`
  SELECT event_type, count(*)::int n
  FROM crm.decision_event
  WHERE event_type IN ('escalated', 'confirmed')
  GROUP BY event_type
`);
const evMap = Object.fromEntries(ev.rows.map((x) => [x.event_type, x.n]));
const escalated = evMap['escalated'] || 0;
const confirmed = evMap['confirmed'] || 0;
const confirmRate = escalated ? ((confirmed / escalated) * 100).toFixed(2) : 'N/A';

const report = `# R7 先例自锁 — HUMAN 缺口量化报告
生成时间: ${new Date().toISOString()}

## 决策状态分布（crm.decision）
${r.rows.map((x) => `- ${x.state}: ${x.n}`).join('\n')}
- 总计: ${total}

## HUMAN 缺口
- HUMAN 态决策数: ${human}
- HUMAN 占比: ${humanShare}%
- 升级事件数(escalated): ${escalated}
- 确认事件数(confirmed): ${confirmed}
- 升级→确认率: ${confirmRate}%

## 结论
${
  human === 0
    ? '当前无 HUMAN 态滞留决策，先例池未被未确认人工决策污染。'
    : `存在 ${human} 条 HUMAN 态滞留决策（占比 ${humanShare}%），需关注是否经 HITL 确认闭环；升级→确认率 ${confirmRate}%。`
}
`;
console.log(report);
```

- [ ] **Step 2: 运行脚本核验（只读）**

Run: `node scripts/r7-precedent-gap.mjs`
Expected: 打印状态分布 + HUMAN 缺口 + 结论，进程退出 0。库为空时 total=0、各状态 0、`confirmRate=N/A`，不报错。

- [ ] **Step 3: 提交**

```bash
git add scripts/r7-precedent-gap.mjs
git commit -m "R7-T1: add read-only HUMAN-gap diagnostic for precedent pool"
```

---

### Task 2: T2 回归护栏 — HUMAN 经确认后必入先例池

**Files:**
- Create: `test/decision/r7-precedent-lock.test.js`

- [ ] **Step 1: 编写 T2 测试（锁定既有正确流转，预期直接 PASS）**

```js
// test/decision/r7-precedent-lock.test.js
import { createDecision, searchPrecedents, confirmDecision } from '../../src/decision/decisionRepo.js';
import { query, queryWrite } from '../../src/db.js';
import { describe, it, expect, afterEach } from 'vitest';

const SID = 'LEAD_FOLLOW_UP'; // 种子场景，含维度，confirmed 可正常入池
const CTX = { customer: 'normal', project: 'pilot', conditions: { B: true } };
const COND = [{ cond: 'B', met: true }];

afterEach(async () => {
  await queryWrite(
    `TRUNCATE crm.decision_event, crm.decision_precedent_rel, crm.decision_provenance,
              crm.memory_log, crm.decision RESTART IDENTITY CASCADE`
  );
});

describe('R7 先例自锁', () => {
  it('T2: HUMAN 决策经 confirmDecision 后进入先例池（确认前不在、确认后在）', async () => {
    const d = await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'HUMAN',
    });
    // 确认前：HUMAN 决策不在先例池
    let precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    expect(precs.find((p) => p.decision_id === d.decision_id)).toBeFalsy();

    // HITL 确认 → CONFIRMED
    const c = await confirmDecision(d.decision_id, { by_role: 'manager' });
    expect(c.state).toBe('CONFIRMED');

    // 确认后：进入先例池
    precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    const hit = precs.find((p) => p.decision_id === d.decision_id);
    expect(hit).toBeTruthy();
    expect(hit.similarity).toBeGreaterThan(0.45); // C4 结构相似度（与决策.test.js:114 同口径）
  });
});
```

- [ ] **Step 2: 单独运行该文件（避免共享库并发 TRUNCATE 互扰）**

Run: `node node_modules/vitest/vitest.mjs run test/decision/r7-precedent-lock.test.js`
Expected: `T2` 测试 PASS（既有行为已正确，护栏只是锁定它）。

- [ ] **Step 3: 提交**

```bash
git add test/decision/r7-precedent-lock.test.js
git commit -m "R7-T2: regression guard — HUMAN->CONFIRMED enters precedent pool"
```

---

### Task 3: T3 回归护栏 — 先例池闸门（仅 CONFIRMED/AUTONOMOUS 入池）

**Files:**
- Modify: `test/decision/r7-precedent-lock.test.js`（在 `describe('R7 先例自锁')` 内追加 `it('T3 ...')`）

- [ ] **Step 1: 在 describe 内补充 T3 用例**

在 `test/decision/r7-precedent-lock.test.js` 的 `describe('R7 先例自锁', () => {` 块内、T2 的 `it` 之后追加：

```js
  it('T3: HUMAN 态决策永不被先例池召回（仅 CONFIRMED/AUTONOMOUS 入池）', async () => {
    // 同 scenario 放一个已确认先例 + 一个 HUMAN 决策
    await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
    });
    const h = await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'ESCALATE', business_tier: 'LEAD', state: 'HUMAN',
    });
    const precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    // HUMAN 决策绝不应作为候选先例出现
    expect(precs.find((p) => p.decision_id === h.decision_id)).toBeFalsy();
    // HUMAN 决策也绝不应作为 precedent_id 出现在 decision_precedent_rel
    const rel = (await query(
      'SELECT count(*)::int n FROM crm.decision_precedent_rel WHERE precedent_id=$1',
      [h.decision_id]
    )).rows[0].n;
    expect(rel).toBe(0);
  });
```

- [ ] **Step 2: 单独运行该文件核验两道护栏**

Run: `node node_modules/vitest/vitest.mjs run test/decision/r7-precedent-lock.test.js`
Expected: `T2` + `T3` 均 PASS。

- [ ] **Step 3: 提交**

```bash
git add test/decision/r7-precedent-lock.test.js
git commit -m "R7-T3: regression guard — HUMAN never enters precedent pool"
```

---

### Task 4: 全量回归核验（不写代码，仅验证）

- [ ] **Step 1: 跑决策相关测试集，确认无新增红**

Run: `node node_modules/vitest/vitest.mjs run test/decision.test.js test/decision/`
Expected: 全 PASS（既有 692 基线不因本计划变动；本计划零 src 改动，风险面仅为新增测试文件）。

- [ ] **Step 2: 复跑 T1 脚本，确认可重复输出**

Run: `node scripts/r7-precedent-gap.mjs`
Expected: 同 Task 1 Step 2，退出 0。

- [ ] **Step 3: 回填设计文档闭环表 + 工作日志（不提交代码，仅文档）**

更新 `docs/2026-09-10-r7-precedent-lock-design.md` §5 闭环回写表：填入 T1 实测 HUMAN 占比/确认率、T2/T3 护栏状态。追加 `D:\system\CRM-ai-native\.workbuddy\memory\2026-09-10.md` 一条：R7 实施收口（T1 脚本 + T2/T3 回归护栏，零 src 变更，全绿）。

```bash
git add docs/2026-09-10-r7-precedent-lock-design.md
git commit -m "R7: close the loop — fill §5 with T1 metrics and T2/T3 guard status"
```

---

## Self-Review

**1. Spec coverage:**
- §0 根因（HUMAN 不入池=覆盖度缺口）→ Task 2/3 护栏锁定既有正确路径，印证根因结论。✅
- §1 方案 A（保持语义+可观测+加固+护栏）→ Task 1（可观测）+ Task 2/3（护栏），零语义变更。✅
- §2 T1 量化缺口 → Task 1。✅ / T2 加固 HUMAN→CONFIRMED → Task 2。✅ / T3 闸门护栏 → Task 3。✅
- §3 验收 1-4 → Task 1（归档量化）+ Task 2/3（护栏）+ Task 4（全量无新增红）。✅
- §4 零回滚 → 本计划仅新增脚本+测试，删之即回滚。✅

**2. Placeholder scan:** 无 TBD/TODO/“类似 Task N”/“加适当处理”。每步含完整代码与命令。✅

**3. Type consistency:** `createDecision`/`searchPrecedents`/`confirmDecision` 签名与 `decisionRepo.js` 一致；`query`/`queryWrite` 取自 `src/db.js`（与既有测试同款）；`SID/CTX/COND` 在 Task 2/3 间一致复用。✅

**4. 风险备注:** 共享测试库并发两 vitest 互 TRUNCATE 致伪失败（项目已知）——Task 2/3 均**单独运行**该文件规避；如确需并入全量，须确保同一时刻仅一个 vitest 进程。
