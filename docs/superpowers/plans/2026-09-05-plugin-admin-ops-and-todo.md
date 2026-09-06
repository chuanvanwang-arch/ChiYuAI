# 两插件更新——平台管理运营洞察 + 业务待办/单据/记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 platform-admin 插件增加运营洞察（租户经营/智能体汇总/决策健康/参数诊断/待办审批），为 crm-native 插件增加待办审批/业务单据/客户记忆，后台新增 3 个只读聚合端点 + 1 个只读 Action + MCP 工具面。

**Architecture:** 后台复用既有数据面（monitor_event/decision_event/calibration_patch/memory_log），新增 3 个只读聚合 REST 端点 + 注册 10 个 MCP 工具（写走两阶段确认）。两个插件分别新增 SKILL/意图路由与面孔映射，改版本号并重打包。全程零新表、零 DELETE。

**Tech Stack:** Node 22 + ESM + Express 4 + pg (node-postgres) + MCP SDK；插件为 `.codebuddy-plugin` 结构（SKILL + agent face + openclaw.plugin.json）。

**前置检查（每任务开始先做）：**
- PG 探活（连 `localhost:5433`，勿用 127.0.0.1）：`node -e "const {Pool}=require('pg');const p=new Pool({host:'localhost',port:5433,user:'agent2b',password:'agent2b',database:'crm_native'});p.query('SELECT 1').then(()=>{console.log('PG OK');process.exit(0)}).catch(e=>{console.error('PG DOWN',e.message);process.exit(1)})"`
- 提交前双检：`git log -1 --oneline`（确认 HEAD 存在）+ `git status --short | wc -l`（确认暂存规模小）。分支若 unborn 或暂存数百文件 → **立即停手**不要 commit。
- 禁 `git add -A`；每 Task 显式路径 add 单文件组。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/http/routes.js` | 修改 | 新增 3 个聚合端点（agent-summary / decision-health / param-diagnosis） |
| `src/action/seed-actions.js` | 修改 | 注册 10 个 Action（my-todo-* / tune-* / admin-* / crm-memory-read） |
| `src/http/workbenchRouter.js` | 修改 | 导出 `buildViewRows` 供 MCP 复用 |
| `src/monitor/monitorStore.js` | 新增导出 | `getAgentSummary` / `getDecisionHealth`（聚合函数） |
| `src/monitor/diagnosis.js`（新） | 新增 | `getParamDiagnosis`（综合诊断报告） |
| `src/mcp/tools.js` | 修改 | 无代码改动（自动覆盖新 Action），仅验证 |
| `plugin-platform-admin/skills/platform-ops-insight/SKILL.md` | 新增 | 运营洞察 Runbook |
| `plugin-platform-admin/skills/platform-ops-insight/registry.json` | 新增 | rbac_roles ["sysadmin"] |
| `plugin-platform-admin/agents/platform-admin.md` | 修改 | 能力映射表补 5 行 |
| `plugin-platform-admin/*.json` | 修改 | 版本 1.1.0，skills 数组加新项 |
| `plugin/skills/crm-native/SKILL.md` | 修改 | 意图路由补待办/单据/记忆 |
| `plugin/skills/crm-query/SKILL.md` | 修改 | 查询矩阵补 2 行 |
| `plugin/agents/crm-native.md` | 修改 | 能力映射补 3 行 |
| `plugin/*.json` | 修改 | 版本 1.5.0 |
| `test/monitor/agent-summary.test.js`（新） | 新增 | 聚合端点测试 |
| `test/monitor/param-diagnosis.test.js`（新） | 新增 | 诊断报告测试 |
| `test/mcp/mcp-admin-tools.test.js`（新） | 新增 | MCP 工具面测试 |

---

## Task 1: 后台聚合函数（monitorStore）

**Files:**
- Modify: `src/monitor/monitorStore.js`
- Test: `test/monitor/agent-summary.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/monitor/agent-summary.test.js
import { describe, it, expect } from 'vitest';
import { getAgentSummary } from '../../src/monitor/monitorStore.js';

describe('getAgentSummary', () => {
  it('按 agent 聚合运行成败（monitor_event agent 域）', async () => {
    const r = await getAgentSummary({ days: 7 });
    expect(r).toHaveProperty('totals');
    expect(r).toHaveProperty('by_agent');
    expect(Array.isArray(r.by_agent)).toBe(true);
    expect(r.totals).toHaveProperty('runs');
    expect(r.totals).toHaveProperty('fail_rate');
  });

  it('无数据时返回空聚合而非抛错', async () => {
    const r = await getAgentSummary({ days: 0 });
    expect(r.totals.runs).toBe(0);
    expect(r.by_agent).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node_modules/.bin/vitest test/monitor/agent-summary.test.js -v`
Expected: FAIL — `getAgentSummary` 未导出（`TypeError: ... is not a function`）

- [ ] **Step 3: 实现 `getAgentSummary`**

在 `src/monitor/monitorStore.js` 末尾追加：

```js
// ─── 平台运营洞察：智能体成败聚合（2026-09-05 设计 §2.1）───
// 数据源：monitor_event（agent 域 loop-started/done/failed）+ agent_contract_feedback（契约 pass/miss）
// 失败原因归一：loop-failed 的 context_facts.error（agentLoop.js:119 已埋点），无 error → 'unknown'
export async function getAgentSummary({ days = 7, tenantId = 'system' } = {}) {
  const since = new Date(Date.now() - Number(days) * 864e5).toISOString();
  const evs = (await query(
    `SELECT agent_id, event_type, context_facts, created_at, tenant_id
       FROM crm.monitor_event
      WHERE domain='agent' AND created_at >= $1
        AND ($2::text IS NULL OR tenant_id=$2)
      ORDER BY created_at`,
    [since, scopeTenantFilter(tenantId)]
  )).rows;
  // 契约反馈（agent_contract_feedback 无 tenant_id，按 agent 聚合）
  const feedback = (await query(
    `SELECT agent, gap_type, severity FROM crm.agent_contract_feedback WHERE ts >= $1`,
    [since]
  )).rows;
  const byAgent = {};
  for (const e of evs) {
    const a = byAgent[e.agent_id] || (byAgent[e.agent_id] = { agent_id: e.agent_id, runs: 0, done: 0, failed: 0, degraded: 0, reasons: [] });
    a.runs += 1;
    if (e.event_type === 'loop-done') { a.done += 1; if (e.context_facts?.degraded) a.degraded += 1; }
    else if (e.event_type === 'loop-failed') {
      a.failed += 1;
      const err = e.context_facts?.error || 'unknown';
      a.reasons.push(err);
    }
  }
  for (const f of feedback) {
    const a = byAgent[f.agent] || (byAgent[f.agent] = { agent_id: f.agent, runs: 0, done: 0, failed: 0, degraded: 0, reasons: [] });
    a.contract = { pass: (a.contract?.pass || 0) + (f.gap_type === 'success' ? 1 : 0), miss: a.contract?.miss || 0 };
    if (f.gap_type !== 'success') a.contract.miss += 1;
  }
  const rows = Object.values(byAgent).map((a) => ({
    ...a,
    reasons: a.reasons.slice(0, 5), // 只保留前 5 条（展示聚合不铺全量）
  }));
  const totals = rows.reduce((acc, a) => ({
    runs: acc.runs + a.runs, done: acc.done + a.done, failed: acc.failed + a.failed,
    degraded: acc.degraded + a.degraded,
  }), { runs: 0, done: 0, failed: 0, degraded: 0 });
  // 失败原因全局归一（按前缀/关键字归并）
  const reasonCounts = {};
  for (const a of rows) for (const r of a.reasons) {
    const key = normFailReason(r);
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }
  const failReasons = Object.entries(reasonCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return {
    window: { days: Number(days), from: since, to: new Date().toISOString() },
    totals: { ...totals, fail_rate: totals.runs ? totals.failed / totals.runs : 0, degrade_rate: totals.runs ? totals.degraded / totals.runs : 0 },
    by_agent: rows,
    fail_reasons: failReasons,
    feedback: { rows: feedback.length },
  };
}

function normFailReason(err) {
  const s = String(err || '');
  if (s.includes('SKILL 不存在')) return 'SKILL 不存在';
  if (s.includes('parse_empty')) return 'parse_empty（生成失败）';
  if (s.includes('timeout') || s.includes('超时')) return 'LLM/网络超时';
  if (s.includes('ECONNREFUSED')) return '连接拒绝';
  return s.slice(0, 80) || 'unknown';
}
```

同步在文件顶部 import 区补 `query`（若已导入跳过）。`scopeTenantFilter` 为本地辅助函数：tenantId==='system' 或 '*' → null（通配），否则返回具体值；若无此函数则直接内联三元：

```js
const scopeTenantFilter = (tenantId) => (tenantId === 'system' || tenantId === '*' ? null : tenantId);
```

- [ ] **Step 4: 运行确认通过**

Run: `node_modules/.bin/vitest test/monitor/agent-summary.test.js -v`
Expected: PASS（两用例）

- [ ] **Step 5: 提交**

```bash
git add src/monitor/monitorStore.js test/monitor/agent-summary.test.js
git commit -m "feat(monitor): getAgentSummary 智能体成败聚合（loop-failed 已埋点，归一原因）"
```

---

## Task 2: `getDecisionHealth` 聚合函数

纳入 Task 1 同一文件（monitorStore.js），TDD 单独提交。

**Files:**
- Modify: `src/monitor/monitorStore.js`
- Test: `test/monitor/agent-summary.test.js`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `test/monitor/agent-summary.test.js` 追加：

```js
import { getDecisionHealth } from '../../src/monitor/monitorStore.js';

describe('getDecisionHealth', () => {
  it('按场景聚合决策 made/escalated 与结果分布', async () => {
    const r = await getDecisionHealth({ days: 30 });
    expect(r).toHaveProperty('by_scenario');
    expect(r).toHaveProperty('outcomes');
    expect(r).toHaveProperty('made');
    expect(typeof r.made).toBe('number');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node_modules/.bin/vitest test/monitor/agent-summary.test.js -v`
Expected: FAIL — `getDecisionHealth` 未导出

- [ ] **Step 3: 实现**

在 monitorStore.js 追加：

```js
// ─── 决策健康聚合（2026-09-05 设计 §2.2）───
// 数据源：decision_event（made/required/escalated）+ decision_outcome（won/lost/stalled/paid + reason）+ agent_sla（4 问审计）
export async function getDecisionHealth({ days = 30, tenantId = 'system' } = {}) {
  const since = new Date(Date.now() - Number(days) * 864e5).toISOString();
  const evs = (await query(
    `SELECT event_type, scenario_id, tenant_id FROM crm.decision_event WHERE created_at >= $1
       AND ($2::text IS NULL OR tenant_id=$2)`,
    [since, scopeTenantFilter(tenantId)]
  )).rows;
  const outs = (await query(
    `SELECT outcome_type, payload, created_at FROM crm.decision_outcome WHERE created_at >= $1`,
    [since]
  )).rows;
  const byScenario = {};
  const made = evs.filter((e) => e.event_type === 'made').length;
  const required = evs.filter((e) => e.event_type === 'required').length;
  const escalated = evs.filter((e) => e.event_type === 'escalated').length;
  for (const e of evs) {
    const s = byScenario[e.scenario_id] || (byScenario[e.scenario_id] = { scenario_id: e.scenario_id || '(none)', total: 0, made: 0, escalated: 0 });
    s.total += 1;
    if (e.event_type === 'made') s.made += 1;
    if (e.event_type === 'escalated') s.escalated += 1;
  }
  const outcomes = { won: 0, lost: 0, stalled: 0, paid: 0 };
  const lostReasons = {};
  for (const o of outs) {
    if (outcomes[o.outcome_type] !== undefined) outcomes[o.outcome_type] += 1;
    if (o.outcome_type === 'lost') {
      const reason = o.payload?.reason || o.payload?.note || '未记录';
      lostReasons[reason] = (lostReasons[reason] || 0) + 1;
    }
  }
  const byScenarioList = Object.values(byScenario).map((s) => ({ ...s, fail_rate: s.total ? s.escalated / s.total : 0 }));
  // agent_sla 4 问审计（近快照，latest 取最新一条）
  let audit4q = { pass: 0, warn: 0, fail: 0 };
  const sla = (await query(
    `SELECT q1_pass, q1_warn, q1_fail, q2_pass, q2_warn, q2_fail, q3_pass, q3_warn, q3_fail, q4_pass, q4_warn, q4_fail
       FROM crm.agent_sla ORDER BY measured_at DESC LIMIT 1`
  )).rows[0];
  if (sla) {
    audit4q = {
      pass: sla.q1_pass + sla.q2_pass + sla.q3_pass + sla.q4_pass,
      warn: sla.q1_warn + sla.q2_warn + sla.q3_warn + sla.q4_warn,
      fail: sla.q1_fail + sla.q2_fail + sla.q3_fail + sla.q4_fail,
    };
  }
  return {
    window: { days: Number(days) },
    made, required, escalated,
    by_scenario: byScenarioList,
    outcomes,
    lost_reasons: Object.entries(lostReasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    audit_4q: audit4q,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node_modules/.bin/vitest test/monitor/agent-summary.test.js -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/monitor/monitorStore.js test/monitor/agent-summary.test.js
git commit -m "feat(monitor): getDecisionHealth 决策成败聚合（场景/结果/失单原因/4问审计）"
```

---

## Task 3: 综合诊断报告 `getParamDiagnosis`

**Files:**
- Create: `src/monitor/diagnosis.js`
- Test: `test/monitor/param-diagnosis.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/monitor/param-diagnosis.test.js
import { describe, it, expect } from 'vitest';
import { getParamDiagnosis } from '../../src/monitor/diagnosis.js';

describe('getParamDiagnosis', () => {
  it('综合智能体+决策+处方，patches 附 recommend', async () => {
    const r = await getParamDiagnosis({ days: 7 });
    expect(r).toHaveProperty('agent');
    expect(r).toHaveProperty('decision');
    expect(r).toHaveProperty('patches');
    expect(Array.isArray(r.patches)).toBe(true);
    expect(r.red_lines).toContain('context-routing');
  });

  it('context-routing 相关处方不出现在 patches（红线）', async () => {
    const r = await getParamDiagnosis({ days: 7 });
    for (const p of r.patches) {
      expect(p.knob).not.toMatch(/routing|context-routing/i);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node_modules/.bin/vitest test/monitor/param-diagnosis.test.js -v`
Expected: FAIL — `getParamDiagnosis` 模块不存在

- [ ] **Step 3: 实现**

创建 `src/monitor/diagnosis.js`：

```js
// src/monitor/diagnosis.js — 参数诊断报告（2026-09-05 设计 §2.3）
// 综合：智能体成败归因 + 决策场景失败率 + calibration_patch PENDING 处方（risk 排序 + recommend）
// 红线：context-routing 系 knob 只展示实验数据，不产处方（patch 过滤掉）
import { query } from '../db.js';
import { getAgentSummary } from './monitorStore.js';
import { getDecisionHealth } from './monitorStore.js';

const ROUTING_KNOBS = ['routingStrategy', 'routing', 'context-routing']; // 红线前缀；新增 routing 系 knob 须同步此处

function isRoutingKnob(k) {
  return ROUTING_KNOBS.some((p) => String(k || '').toLowerCase().includes(p.toLowerCase()));
}

export async function getParamDiagnosis({ days = 7 } = {}) {
  const [agent, decision, patchRows] = await Promise.all([
    getAgentSummary({ days }),
    getDecisionHealth({ days }),
    query(`SELECT patch_id, scenario_id, knob, target, from_value, to_value, evidence, expected_impact, risk, status, assignee, tenant_id, created_at
             FROM crm.calibration_patch WHERE status='PENDING' ORDER BY created_at DESC LIMIT 100`),
  ]);
  // 处方 → 附 recommend（确定性规则；仅非 routing knob）
  const patches = (patchRows.rows || [])
    .filter((p) => !isRoutingKnob(p.knob))
    .map((p) => {
      const risk = p.risk || 'LOW';
      const scenarioFail = decision.by_scenario.find((s) => s.scenario_id === p.scenario_id)?.fail_rate || 0;
      const recommend = risk === 'HIGH' && scenarioFail > 0.3 ? 'approve'
        : risk === 'MEDIUM' && scenarioFail > 0 ? 'approve'
        : 'reject';
      return {
        patch_id: p.patch_id, knob: p.knob, target: p.target, risk,
        from_value: p.from_value, to_value: p.to_value,
        recommend, rationale: `场景 ${p.scenario_id || '(none)'} 失败率 ${(scenarioFail * 100).toFixed(1)}%`,
      };
    });
  // 智能体建议：失败 agent → 检查 SKILL/配置
  const agentIssues = (agent.by_agent || []).filter((a) => a.failed > 0).map((a) => ({
    agent: a.agent_id, issue: `失败 ${a.failed} 次`, suggest: '检查对应 SKILL 步骤或该 agent 配置',
  }));
  // 决策建议：高失败率场景 → 检查审批链/规则
  const decisionIssues = (decision.by_scenario || []).filter((s) => s.fail_rate > 0.3).map((s) => ({
    scenario: s.scenario_id, fail_rate: s.fail_rate, suggest: '查看该场景审批链配置与决策规则',
  }));
  return {
    report_date: new Date().toISOString().slice(0, 10),
    agent: { summary: agent, suggestions: agentIssues },
    decision: { summary: decision, suggestions: decisionIssues },
    patches,
    red_lines: ['context-routing 仅展示实验数据（routing_experiment），不产处方'],
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node_modules/.bin/vitest test/monitor/param-diagnosis.test.js -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/monitor/diagnosis.js test/monitor/param-diagnosis.test.js
git commit -m "feat(monitor): getParamDiagnosis 参数诊断报告（智能体+决策+处方，context-routing 红线过滤）"
```

---

## Task 4: workbenchRouter 导出 buildViewRows

**Files:**
- Modify: `src/http/workbenchRouter.js`

- [ ] **Step 1: 确认现状**

`buildViewRows(view, actor, deps)` 目前是模块内函数（workbenchRouter.js:91），未被导出。MCP `my-todo-query` 需复用它。

- [ ] **Step 2: 导出**

在 `src/http/workbenchRouter.js` 的 `function buildViewRows` 前加 `export`：

```js
export async function buildViewRows(view, actor, deps) {
```

末尾 `export { defaultDeps };` 保留，另补：

```js
export { buildViewRows, matchApprover };
```

（`matchApprover` 同样导出，供 MCP 工具校验）

- [ ] **Step 3: 运行相关测试**

Run: `node_modules/.bin/vitest test/http/workbench* -v`（或该文件既有测试）
Expected: PASS（导出不破坏既有行为）

- [ ] **Step 4: 提交**

```bash
git add src/http/workbenchRouter.js
git commit -m "refactor(workbench): 导出 buildViewRows/matchApprover 供 MCP 复用"
```

---

## Task 5: 后台 REST 聚合端点（3 个）

**Files:**
- Modify: `src/http/routes.js`
- Test: `test/monitor/agent-summary.test.js`（追加端点用例）

- [ ] **Step 1: 写失败测试（端点级）**

在 `test/monitor/agent-summary.test.js` 追加（注入式，对齐既有测试范式）：

```js
import { createTestApp } from '../helpers/http.js';

describe('聚合端点（admin 只读）', () => {
  it('/api/monitor/agent-summary 返回聚合结构', async () => {
    const app = createTestApp();
    const res = await app.request('/api/monitor/agent-summary?days=7');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('by_agent');
  });

  it('/api/monitor/decision-health 返回决策聚合', async () => {
    const app = createTestApp();
    const res = await app.request('/api/monitor/decision-health?days=30');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('outcomes');
  });

  it('/api/admin/param-diagnosis 非 admin 403', async () => {
    const app = createTestApp();
    const res = await app.request('/api/admin/param-diagnosis?days=7');
    expect(res.status).toBe(403); // 未登录/非 admin
  });
});
```

（`createTestApp` 若不存在，参照既有测试的注入范式直接对 `createApp` 断言，或按项目实际 helper 命名。）

- [ ] **Step 2: 运行确认失败**

Run: `node_modules/.bin/vitest test/monitor/agent-summary.test.js -v`
Expected: FAIL — 端点未定义（404/403）

- [ ] **Step 3: 实现端点**

在 `src/http/routes.js` 的 `/api/monitor/*` 段（约 2192 行附近）追加：

```js
  // ─── 平台运营洞察聚合端点（2026-09-05 设计 §2.1-2.3；admin/sysadmin 只读）───
  app.get('/api/monitor/agent-summary', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { getAgentSummary } = await import('../monitor/monitorStore.js');
      const days = Number(req.query.days || 7) || 7;
      const me = resolveMe(req);
      const tenantId = me?.ok ? me.tenantId : 'system';
      res.json(await getAgentSummary({ days, tenantId }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/monitor/decision-health', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { getDecisionHealth } = await import('../monitor/monitorStore.js');
      const days = Number(req.query.days || 30) || 30;
      const me = resolveMe(req);
      const tenantId = me?.ok ? me.tenantId : 'system';
      res.json(await getDecisionHealth({ days, tenantId }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/param-diagnosis', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { getParamDiagnosis } = await import('../monitor/diagnosis.js');
      const days = Number(req.query.days || 7) || 7;
      res.json(await getParamDiagnosis({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

（`resolveMe` 已在 routes.js 导入；`requireAdminRole` 已存在（routes.js:164）。）

- [ ] **Step 4: 运行确认通过**

Run: `node_modules/.bin/vitest test/monitor/agent-summary.test.js -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js test/monitor/agent-summary.test.js
git commit -m "feat(http): 平台运营洞察 3 聚合端点（agent-summary/decision-health/param-diagnosis，admin 只读）"
```

---

## Task 6: 注册 MCP 工具 Action（seed-actions.js）

**Files:**
- Modify: `src/action/seed-actions.js`
- Test: `test/mcp/mcp-admin-tools.test.js`（新）

- [ ] **Step 1: 写失败测试**

```js
// test/mcp/mcp-admin-tools.test.js
import { describe, it, expect } from 'vitest';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('MCP 管理工具面', () => {
  it('tools 含 my-todo-query / admin-tenant-usage / crm-memory-read', () => {
    const { tools } = buildMcpTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('my-todo-query');
    expect(names).toContain('admin-tenant-usage');
    expect(names).toContain('crm-memory-read');
    expect(names).toContain('my-todo-approve');
    expect(names).toContain('tune-approve');
  });

  it('写工具 inputSchema 含 confirm_token/choice（两阶段）', () => {
    const { tools } = buildMcpTools();
    const appr = tools.find((t) => t.name === 'my-todo-approve');
    expect(appr.kind).toBe('write');
    const schema = appr.inputSchema;
    expect(schema.confirm_token).toBeDefined();
    expect(schema.choice).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node_modules/.bin/vitest test/mcp/mcp-admin-tools.test.js -v`
Expected: FAIL — 工具缺失

- [ ] **Step 3: 实现 Action 注册**

在 `src/action/seed-actions.js` 的 registerAction 区（末尾追加一批）：

```js
  // ─── 平台运营洞察 / 待办 / 记忆读（2026-09-05 设计 §3）───
  // my-todo-query：六视角待办（复用 workbenchRouter.buildViewRows）
  registerAction({
    name: 'my-todo-query', kind: 'read', permission: 'auth', namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { view: 'string', limit: 'number' },
    handler: async ({ view = 'approval', limit = 50 }, ctx) => {
      const { buildViewRows } = await import('../http/workbenchRouter.js');
      const actor = { username: ctx?.actor || 'system', roles: [ctx?.role || ctx?.actor || 'system'], tenantId: ctx?.tenantId || 'system' };
      const rows = await buildViewRows(view, actor, null).catch((e) => { recordFailure('my-todo-query-failed', e); return []; });
      return { view, rows: rows.slice(0, Number(limit) || 50) };
    },
  });

  // my-todo-approve / reject：审批任务签批（复用 advanceTask）
  const todoSign = (decision) => ({
    name: decision === 'approve' ? 'my-todo-approve' : 'my-todo-reject',
    kind: 'write', permission: 'auth', namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { task_id: 'string', instance_id: 'string', opinion: 'string' },
    handler: async ({ task_id, instance_id, opinion = '' }, ctx) => {
      const { advanceTask } = await import('../approval/engine.js');
      const r = await advanceTask(instance_id, task_id, {
        approver: ctx?.actor || 'system', decision, opinion, tenantId: ctx?.tenantId || 'system',
      });
      return { ok: true, ...r };
    },
  });
  registerAction(todoSign('approve'));
  registerAction(todoSign('reject'));

  // tune-approve / tune-reject：参数调优处方签批（复用 approvePatch/rejectPatch）
  const tuneSign = (approve) => ({
    name: approve ? 'tune-approve' : 'tune-reject',
    kind: 'write', permission: 'auth', namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { patch_id: 'string', opinion: 'string' },
    handler: async ({ patch_id, opinion = '' }, ctx) => {
      const { approvePatch, rejectPatch } = await import('../calibration/store.js');
      const fn = approve ? approvePatch : rejectPatch;
      const r = await fn(patch_id, { resolved_by: ctx?.actor || 'sysadmin' });
      return { ok: true, ...r };
    },
  });
  registerAction(tuneSign(true));
  registerAction(tuneSign(false));

  // admin-tenant-usage：租户套餐/用量/到期/缴费（只读聚合现有表）
  registerAction({
    name: 'admin-tenant-usage', kind: 'read', permission: 'auth', namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { tenantId: 'string' },
    handler: async ({ tenantId = null }, ctx) => {
      const { query } = await import('../db.js');
      const rows = (await query(
        `SELECT ts.tenant_id, ts.plan_id, ts.status, ts.expires_at, ts.grace_until, ts.payment_ref,
                mu.calls, mu.tokens_in, mu.tokens_out, mu.period
           FROM crm.tenant_subscription ts
           LEFT JOIN crm.module_usage mu ON mu.tenant_id = ts.tenant_id AND mu.period = to_char(now(),'YYYY-MM')
          WHERE ($1::text IS NULL OR ts.tenant_id=$1)
          ORDER BY ts.expires_at`,
        [tenantId]
      )).rows;
      return { rows };
    },
  });

  // admin-agent-summary / admin-decision-health / admin-param-diagnosis：聚合报告转 MCP
  registerAction({
    name: 'admin-agent-summary', kind: 'read', permission: 'auth', namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { days: 'number', tenantId: 'string' },
    handler: async ({ days = 7, tenantId = 'system' }, ctx) => {
      const { getAgentSummary } = await import('../monitor/monitorStore.js');
      return getAgentSummary({ days: Number(days) || 7, tenantId });
    },
  });
  registerAction({
    name: 'admin-decision-health', kind: 'read', permission: 'auth', namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { days: 'number', tenantId: 'string' },
    handler: async ({ days = 30, tenantId = 'system' }, ctx) => {
      const { getDecisionHealth } = await import('../monitor/monitorStore.js');
      return getDecisionHealth({ days: Number(days) || 30, tenantId });
    },
  });
  registerAction({
    name: 'admin-param-diagnosis', kind: 'read', permission: 'auth', namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { days: 'number' },
    handler: async ({ days = 7 }, ctx) => {
      const { getParamDiagnosis } = await import('../monitor/diagnosis.js');
      return getParamDiagnosis({ days: Number(days) || 7 });
    },
  });

  // crm-memory-read：客户记忆查询（memory_log by entity，scopeTenant 收敛）
  registerAction({
    name: 'crm-memory-read', kind: 'read', permission: 'auth', namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { entityId: 'string', topic: 'string', layer: 'string', limit: 'number', windowDays: 'number' },
    handler: async ({ entityId, topic = null, layer = null, limit = 20, windowDays = 30 }, ctx) => {
      const tenantId = ctx?.tenantId || 'system';
      const where = ['tenant_id=$1', 'archived=false'];
      const params = [tenantId];
      if (entityId) { params.push(entityId); where.push(`entity_id=$${params.length}`); }
      if (topic) { params.push(`%${topic}%`); where.push(`topic LIKE $${params.length}`); }
      if (layer) { params.push(layer); where.push(`layer=$${params.length}`); }
      params.push(new Date(Date.now() - Number(windowDays) * 864e5).toISOString());
      where.push(`created_at >= $${params.length}`);
      params.push(Number(limit) || 20);
      where.push('1=1'); // 占位对齐 LIMIT 参数序号
      const rows = (await query(
        `SELECT id, topic, kind, layer, entity_id, payload, created_at FROM crm.memory_log
          WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      )).rows;
      return { rows, count: rows.length };
    },
  });
```

注意：
- `recordFailure` 已在 seed-actions.js 顶部导入（import { recordFailure } from '../monitor/monitorStore.js'）。
- `query` 已在 seed-actions.js 顶部导入。
- admin-* Action 的**角色闸在 gateway / registry rbac_roles 层**：为严格对齐「仅 sysadmin」，给三个 admin-* 与 tune-* 的注册补充 `rbac_roles: ['sysadmin']`（Action Registry 第 1.5 闸自动消费；见 crm-native 插件 rbac 语义）。
- my-todo-approve/reject 的 approver 匹配在 `buildViewRows`/`advanceTask` 内校验（越权拒）。

- [ ] **Step 4: 运行确认通过**

Run: `node_modules/.bin/vitest test/mcp/mcp-admin-tools.test.js -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/action/seed-actions.js test/mcp/mcp-admin-tools.test.js
git commit -m "feat(mcp): 10 工具面（my-todo 六视角+签批 / tune 签批 / admin 聚合 / crm-memory-read）"
```

---

## Task 7: plugin-platform-admin 新 SKILL + 面孔 + 版本

**Files:**
- Create: `plugin-platform-admin/skills/platform-ops-insight/SKILL.md`
- Create: `plugin-platform-admin/skills/platform-ops-insight/registry.json`
- Modify: `plugin-platform-admin/agents/platform-admin.md`
- Modify: `plugin-platform-admin/.codebuddy-plugin/plugin.json`、`openclaw.plugin.json`、`package.json`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: platform-ops-insight
description: 平台管理员 / sysadmin 视角的「运营洞察」Runbook——租户套餐/用量/到期/缴费一览、智能体运作汇总（成败+原因）、决策健康（场景/结果/失单原因）、后台参数诊断报告（含处方建议与批准）、管理员待办审批。须 crm_login 登录验证 + 仅 sysadmin 角色可执。触发词：运营报告、运营诊断、租户套餐、用量、到期、缴费、智能体汇总、决策健康、参数报告、待办审批、sysadmin。
type: domain
immutable_baseline: true
related_skills:
  - user-rbac-admin        # 治理角色/权限同源
  - industry-onboarding    # 租户经营视角（套餐/到期）与行业上线衔接
---

# 平台运营洞察 Runbook（Platform Ops Insight）

## 0. 定位与边界

- 本 SKILL 管**平台运行可见性与治理**（读聚合 + 处方签批），与业务销售（crm-native）、行业上线（industry-onboarding）严格分离。
- 全部数据聚合为**只读**；唯一写 = 管理员待办签批（my-todo-approve / tune-approve，两阶段确认）。
- **准入双闸（缺一不可）**：① `crm_login(username,password)` 验证通过；② 角色 `sysadmin`。普通 admin / 其它角色 → 403。
- **红线**：`context-routing` 相关 knob **仅展示实验数据、不产处方**；绝对禁删；per-tenant 隔离（sysadmin 通配，租户管理员限本租户）。

## 1. 能力映射

| 用户意图 | 工具 | 说明 |
|---|---|---|
| "各租户套餐/用量/到期/缴费" | `admin-tenant-usage` | 套餐档位/状态/到期日/宽限/用量/周期 |
| "智能体运作汇总/失败原因" | `admin-agent-summary` | runs/done/failed/degraded + 失败原因归一 |
| "决策成败/失单原因" | `admin-decision-health` | 场景级 made/escalated + 结果分布 |
| "后台参数怎么调/诊断报告" | `admin-param-diagnosis` | 三段报告 + 处方 recommend |
| "批准参数调优/驳回" | `tune-approve` / `tune-reject` | 处方签批（两阶段） |
| "我的待办/待审批" | `my-todo-query`（view=approval/tuning） | 六视角待办 |
| "批准/驳回审批" | `my-todo-approve` / `my-todo-reject` | 审批签批（两阶段） |

## 2. 调用范式

**场景 A — 出运营诊断报告**
用户：「出个运营诊断报告」
→ ① `admin-agent-summary`（days=7）
→ ② `admin-decision-health`（days=30）
→ ③ `admin-param-diagnosis`（days=7）
→ 呈现三段报告 + red_lines 声明（context-routing 不产处方）+ patches 处方清单（附 recommend）。
→ 处方可接 `tune-approve`/`tune-reject`（phase1 表单 → phase2 confirm_token）。

**场景 B — 各租户经营**
用户：「各租户套餐/用量/到期/缴费情况」
→ `admin-tenant-usage` → 表格化呈现（套餐/状态/到期日/用量/缴费）。

**场景 C — 管理员待办审批**
用户：「我的待办」
→ `my-todo-query`（view=approval）→ 待审批列表。
→ `my-todo-approve`（task_id, instance_id, opinion）→ phase1 确认表单 → phase2 执行。

## 3. 红线与验收

| 红线 | 说明 |
|---|---|
| 双闸 | 登录验证 + sysadmin，缺一即拒 |
| context-routing 不产处方 | 诊断报告只展示实验数据，patches 过滤该族 |
| 两阶段写 | 签批写 phase1 表单 → phase2 confirm_token |
| 禁删 | 无 delete/remove 工具 |
| per-tenant | sysadmin 通配，租户管理员限本租户 |

验收：`admin-param-diagnosis` 报告含 red_lines；`my-todo-approve` 签批后任务状态变更；非 sysadmin 调 admin-* → 403。

## 4. 铁律声明

本 SKILL 是**领域专属**平台运营手册，与 10 大 ai-* 方法论能力 SKILL 无关、不交叉写入。通用方法论以交叉引用复用。
```

- [ ] **Step 2: 写 registry.json**

```json
{
  "id": "platform-ops-insight",
  "name": "platform-ops-insight",
  "type": "domain",
  "immutable_baseline": true,
  "rbac_roles": ["sysadmin"],
  "description": "平台运营洞察 Runbook：租户经营/智能体汇总/决策健康/参数诊断/待办审批。双闸：登录验证+sysadmin"
}
```

- [ ] **Step 3: 改面孔 `platform-admin.md`**

在能力映射表（roles 分发表）追加 5 行：

```markdown
| "出个运营诊断报告 / 各租户套餐/用量/到期/缴费 / 智能体汇总 / 决策健康" | `platform-ops-insight` |
| "批准/驳回参数调优处方" | `platform-ops-insight`（tune-approve/tune-reject） |
| "我的待办 / 待我审批 / 批准审批" | `platform-ops-insight`（my-todo-query/approve/reject） |
```

并把「一句话能力映射」表补 3 行同源。

同时更新 SKILL 声明段：

```markdown
> 能力本体在 `skills/` 下 4 个领域 SKILL：`industry-onboarding`（行业新增）/ `user-rbac-admin`（用户与权限）/ `system-bootstrap`（系统初始化）/ `platform-ops-insight`（运营洞察：租户经营/智能体/决策/参数诊断/待办审批）。
```

- [ ] **Step 4: 版本与清单**

`.codebuddy-plugin/plugin.json`、`openclaw.plugin.json`、`package.json` 三处 `version` → `1.1.0`；
`openclaw.plugin.json` 的 `skills` 数组加 `"skills/platform-ops-insight"`。

- [ ] **Step 5: 提交**

```bash
git add plugin-platform-admin/skills/platform-ops-insight/ plugin-platform-admin/agents/platform-admin.md plugin-platform-admin/.codebuddy-plugin/plugin.json plugin-platform-admin/openclaw.plugin.json plugin-platform-admin/package.json
git commit -m "feat(plugin-platform-admin): platform-ops-insight 运营洞察 SKILL + 面孔映射 + 版本 1.1.0"
```

---

## Task 8: plugin/crm-native 扩意图路由 + 面孔 + 版本

**Files:**
- Modify: `plugin/skills/crm-native/SKILL.md`
- Modify: `plugin/skills/crm-query/SKILL.md`
- Modify: `plugin/agents/crm-native.md`
- Modify: `plugin/.workbuddy-plugin/plugin.json`、`openclaw.plugin.json`、`package.json`

- [ ] **Step 1: crm-native SKILL 意图路由补 3 行**

在「意图路由」表（SKILL.md 第 45-51 行区）追加：

```markdown
| "我的待办 / 待我审批 / 批准" | `crm-query` → `my-todo-query` / `crm-write` → `my-todo-approve` / `my-todo-reject` |
| "查目前所有合同/报价/订单" | `crm-query` → `data-particle-read`（by type） |
| "查 XX 客户的记忆" | `crm-query` → `crm-memory-read` |
```

在「安全红线」段（第 63-67 行）补一条：

```markdown
- 待办签批为两阶段写：phase1 表单 → phase2 confirm_token；approver 匹配才可签（越权拒）。
```

- [ ] **Step 2: crm-query SKILL 查询矩阵补 2 行**

在「查询能力矩阵」（SKILL.md 第 20-26 行区）追加：

```markdown
| "查目前所有合同/报价/订单" | 粒子检索 by type（data-particle-read） | 单据清单（类型/状态/金额） |
| "查 XX 客户的记忆" | memory_log 检索（crm-memory-read） | 客户记忆条（时间线/主题） |
```

- [ ] **Step 3: 面孔 `crm-native.md` 能力映射补 3 行**

在 crm-native.md 的能力映射段补：

```markdown
| "我的待办/待我审批/批准" | my-todo-query / my-todo-approve / my-todo-reject（两阶段写） |
| "查业务单据（合同/报价/订单）" | data-particle-read（by type） |
| "查客户记忆" | crm-memory-read |
```

- [ ] **Step 4: 版本与清单**

三处 `version` → `1.5.0`。

- [ ] **Step 5: 提交**

```bash
git add plugin/skills/crm-native/SKILL.md plugin/skills/crm-query/SKILL.md plugin/agents/crm-native.md plugin/.workbuddy-plugin/plugin.json plugin/openclaw.plugin.json plugin/package.json
git commit -m "feat(plugin-crm-native): 待办审批/业务单据/客户记忆意图路由 + 版本 1.5.0"
```

---

## Task 9: 重打包 + 合规校验（V8）

**Files:**
- Run: `scripts/pack-platform-admin-plugin.py`、`scripts/pack-crm-plugin.py`

- [ ] **Step 1: 重打 platform-admin 包**

Run:
```bash
python scripts/pack-platform-admin-plugin.py
# 或用 node 等价脚本（如项目实际是 py，按既有 readme）
```

- [ ] **Step 2: 重打 crm-native 包**

Run:
```bash
python scripts/pack-crm-plugin.py
```

- [ ] **Step 3: 合规校验**

Run: `python scripts/verify-plugin-zips.py`（或对应校验脚本）
Expected: 全部 PASS（元数据位 `.codebuddy-plugin/plugin.json`、tags=3、quickPrompts=3、资源包根、版本一致）

- [ ] **Step 4: 提交**

```bash
git add crm-native-plugin.zip plugin-platform-admin.zip scripts/  # 注意 zip 是否入仓库（gitignore 若排除则只 add 脚本）
git commit -m "build(plugin): 两包重打包（platform-admin 1.1.0 / crm-native 1.5.0）+ 合规校验"
```

---

## Task 10: 端到端验收（V1-V6, V9）

- [ ] **Step 1: 起服务 + 探活**

```bash
# PG 探活后启动
npm run dev  # 或项目实际启动命令
```

- [ ] **Step 2: 三个聚合端点**

```bash
# sysadmin token（crm_login）后
curl -H "Authorization: Bearer <token>" "http://localhost:3000/api/monitor/agent-summary?days=7"
curl -H "Authorization: Bearer <token>" "http://localhost:3000/api/monitor/decision-health?days=30"
curl -H "Authorization: Bearer <token>" "http://localhost:3000/api/admin/param-diagnosis?days=7"
# 期望：结构化 JSON，param-diagnosis 含 red_lines，patches 无 routing knob
```

- [ ] **Step 3: MCP tools/list**

连 MCP（localhost:3001/mcp）后 `tools/list` → 含 my-todo-query / my-todo-approve / tune-approve / admin-* / crm-memory-read。

- [ ] **Step 4: 签批端到端**

`my-todo-query`（view=approval）→ 取 task_id/instance_id → `my-todo-approve` phase1 → confirm_token → phase2 → 返回 `{ok:true}`，任务状态变更。

- [ ] **Step 5: 权限验证**

sales 账号调 `admin-param-diagnosis` → 403；sysadmin → 200。

- [ ] **Step 6: 提交（如有文档/脚本修补）**

无新文件则跳过 commit；有则显式 add。

---

## 自检（Self-Review）

**Spec 覆盖**：
- §2.1 agent-summary → Task 1
- §2.2 decision-health → Task 2
- §2.3 param-diagnosis → Task 3（含 context-routing 红线过滤）
- §2.4 crm-memory-read → Task 6
- §3 MCP 工具面 → Task 5+6（seed-actions 注册 10 工具）
- §4.1 platform-admin 扩展 → Task 7
- §4.2 crm-native 扩展 → Task 8
- §7 验收 V1-V8 → Task 5/6/9/10

**Placeholder scan**：无 TBD/TODO。代码块均完整。

**Type consistency**：`getAgentSummary`/`getDecisionHealth` 导出自 monitorStore.js（Task 1/2 定义，Task 5 routes 引用），`getParamDiagnosis` 导出自 diagnosis.js（Task 3 定义，Task 5 引用）；Action 名与 SKILL 引用一致（my-todo-query/approve/reject、tune-approve/reject、admin-*、crm-memory-read）。
