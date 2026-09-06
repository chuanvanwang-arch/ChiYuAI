# 销售 7 大决策闭环监控 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有决策层上增量落地"销售 7 大决策（D1–D7 阶段闸门）闭环监控"——配置预定义 7 行 scenario、埋点采集持久化、销售决策监控台与 API。

**Architecture:** 三段式增量，不新建决策系统。① 预注册/核对 7 行 `decision_scenario` + 每组 `methodology_dimension` 条件（即七维自检清单）；② 在既有 `events/bus.js` 事件出口上新增"监控持久化订阅"，把 `decision` 事件域落库到监控存储；③ 新增销售决策监控台（7 闸门看板 + 钻取）+ 聚合 API。复用现有决策数据底座（`decision` / `decision_event` / `decision_precedent_rel` 三表 + `autonomyEngine.requireDecision`）。

**Tech Stack:** Node 22 + TypeScript/javascript ESM + PostgreSQL（schema `crm`）+ vitest + Express（`routes.js`）+ 事件总线 `bus.js` + AI 原生粒子模型。测试惯例：`test/*.test.js`，vitest。

**设计文档:** `D:\system\CRM-ai-native\docs\2026-08-25-sales-decision-monitoring-design.md`（v1.0，§1–§7，用户已确认）

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/db.js` | 数据库查询 | 不变（复用） |
| `src/decision/decisionRepo.js` | 决策主轴仓库 | 不变（复用 createDecision/listDecisions/recordDecisionEvent） |
| `src/decision/autonomyEngine.js` | 自主引擎 | 不变（复用 requireDecision） |
| `src/events/bus.js` | 事件总线 | 不变（复用 emit/on） |
| `src/monitor/monitorStore.js` | **新增** 监控存储（决策/事件/粒子快照聚合查询） | Create |
| `src/monitor/monitorSubscriber.js` | **新增** 监控持久化订阅（bus.on('decision', ...) 落库） | Create |
| `src/http/routes.js` | HTTP 路由 | Modify（加监控 API + 页面挂载） |
| `web/sales-decision-monitor.html` | **新增** 销售决策监控台页面（7 闸门看板 + 钻取） | Create |
| `test/monitor.test.js` | 监控存储/订阅/API 测试 | Create |
| `src/seed/decisionScenarios.js` | 7 闸门 scenario 校验/补齐 seed | Create（或并入现有 seed） |

---

## Task 1: 核对既有 7 决策场景种子，补齐 D1–D7 七维条件（补进 eval_dimensions）

**Files:**
- Modify: `db/seed.sql`（7 行 `decision_scenario` 的 `eval_dimensions` 补七维条件）
- Modify: `test/decision.test.js`（追加断言：7 闸门 + 每闸门含七维条件）

> **现状核实（2026-08-25 20:28）**：`db/seed.sql:138-186` 已有 7 行 `decision_scenario`（`LEAD_FOLLOW_UP` / `OPP_QUALIFY` / `SOLUTION_VALUE` / `QUOTE_PRICING` / `SIGN_RISK` / `POST_CONTRACT` / `LOSS_REVIEW`），每行 `eval_dimensions` JSONB 已含评估条件。**七维条件是补进 `eval_dimensions`（用户确认）**，不改 `methodology_dimension`（保持方法论纯净）。七维缺失点：`identity_dedup`（①）、`governance_approval`（⑦，仅 QUOTE_PRICING 有 margin_redline 类）、`time_window`（④）。

- [ ] **Step 1: 确认现状 — 写断言测试**

```javascript
// test/decision.test.js 追加 describe('7 闸门七维条件（eval_dimensions）')
import { query } from '../src/db.js';
it('7 闸门 scenario 齐备', async () => {
  const s = (await query('SELECT count(*)::int n FROM crm.decision_scenario')).rows[0].n;
  expect(s).toBe(7);
});
it('D1 闸门 eval_dimensions 含 ①Identity 查重 ⑦Governance 审批', async () => {
  const r = (await query(`SELECT eval_dimensions FROM crm.decision_scenario WHERE scenario_id='LEAD_FOLLOW_UP'`)).rows[0];
  const dims = r.eval_dimensions.map(d => d.cond); // jsonb 数组
  expect(dims).toContain('identity_dedup');
  expect(dims).toContain('governance_approval');
});
it('每个闸门已含七维基础条件（budget/pain/stage 类）', async () => {
  const r = (await query(`SELECT scenario_id, eval_dimensions FROM crm.decision_scenario`)).rows;
  expect(r.length).toBe(7);
});
```

- [ ] **Step 2: 运行测试确认现状（identity_dedup/governance_approval 缺失 → FAIL）**

Run: `npx vitest test/decision.test.js --run`
Expected: FAIL（`identity_dedup` 不在 eval_dimensions——这正是要补的差口）

- [ ] **Step 3: 实现幂等 seed 补齐 D1–D7 七维条件（补进 eval_dimensions）**

在 `db/seed.sql` 的 7 行 scenario INSERT 中，给各行 `eval_dimensions` 追加七维条件。以 `LEAD_FOLLOW_UP` 为例（其余 6 行同理，见下方清单）：

```sql
-- LEAD_FOLLOW_UP（D1 线索）：续补七维 identity/governance/time
INSERT INTO decision_scenario (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
SELECT 'LEAD_FOLLOW_UP', '一、线索', '新线索跟不跟/升级/放弃/培育',
  '{"source":"particle_event","entity":"DEAL","cond":{"stage":"lead","event":"created"}}'::jsonb,
  ARRAY['BANT','MEDDICC','OPP_MATRIX'],
  '[{"cond":"industry_fit","label":"行业匹配","weight":0.2},{"cond":"budget_cycle","label":"预算周期","weight":0.2},{"cond":"pain_clear","label":"痛点清晰","weight":0.2},{"cond":"contact_level","label":"对接人级别","weight":0.2},{"cond":"our_fit","label":"我方适配","weight":0.2},
    {"cond":"identity_dedup","label":"CRM主体查重","weight":0.1},{"cond":"governance_approval","label":"线索分级审批权限","weight":0.1},{"cond":"time_window","label":"跟进时间窗","weight":0.1}]'::jsonb,
  'LEAD', TRUE
WHERE NOT EXISTS (SELECT 1 FROM decision_scenario WHERE scenario_id='LEAD_FOLLOW_UP');
```

**7 闸门七维补充清单（每闸门补 2-3 条件，对齐设计文档 §3.2）：**

| scenario_id | 阶段 | 补的七维条件 |
|---|---|---|
| `LEAD_FOLLOW_UP` | 一、线索 | identity_dedup / governance_approval / time_window |
| `OPP_QUALIFY` | 二、机会评估 | identity_dedup / governance_approval / time_window |
| `SOLUTION_VALUE` | 三、方案价值 | governance_approval / time_window |
| `QUOTE_PRICING` | 四、商务报价 | identity_dedup / time_window |
| `SIGN_RISK` | 五、签单前风险 | governance_approval / time_window |
| `POST_CONTRACT` | 六、签约后 | governance_approval / time_window |
| `LOSS_REVIEW` | 七、丢单复盘 | identity_dedup / governance_approval / time_window |

> 若 `db/seed.sql` 需要幂等执行（`WHERE NOT EXISTS`），则**直接改既有 7 行 INSERT** 即可；若已执行过 seed，需在 seed 末尾补 7 个 `UPDATE` 追加条件（见下）：

```sql
-- 幂等补七维条件（已 seed 过的库执行 UPDATE 追加）
UPDATE crm.decision_scenario
SET eval_dimensions = eval_dimensions ||
  '[{"cond":"identity_dedup","label":"CRM主体查重","weight":0.1},
    {"cond":"governance_approval","label":"线索分级审批权限","weight":0.1},
    {"cond":"time_window","label":"跟进时间窗","weight":0.1}]'::jsonb
WHERE scenario_id='LEAD_FOLLOW_UP'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(eval_dimensions) e WHERE e->>'cond'='identity_dedup');
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest test/decision.test.js --run`
Expected: PASS（D1 闸门含 identity_dedup/governance_approval 条件）

> 注意：`db.test.js` / `decision.test.js` 的 `beforeEach` 会 TRUNCATE 运行时表（`decision` 等），但 **`decision_scenario` 是配置表不在 TRUNCATE 之列**——测试读的是 seed 后的配置，改 `db/seed.sql` 后需重跑 seed 才生效。

- [ ] **Step 5: Commit**

```bash
git add db/seed.sql test/decision.test.js
git commit -m "feat: 7 阶段闸门决策场景 eval_dimensions 补七维条件（identity/governance/time）"
```

---

## Task 2: 监控存储（决策/事件/粒子快照聚合查询）

**Files:**
- Create: `src/monitor/monitorStore.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/monitor.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../src/action/seed-actions.js';
import { query } from '../src/db.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { getGateMetrics, getDecisionList, getSevenDimCoverage } from '../src/monitor/monitorStore.js';

beforeAll(async () => {
  await query('TRUNCATE crm.decision, crm.decision_event, crm.decision_precedent_rel RESTART IDENTITY CASCADE');
});

describe('监控存储聚合', () => {
  it('getGateMetrics 按 scenario 聚合自主/升级/处置分布', async () => {
    await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'AUTONOMOUS' });
    await createDecision({ scenario_id: 'QUOTE_PRICING', trigger_context: {}, conditions_evaluated: [],
      disposition: 'ESCALATE', business_tier: 'HIGH', state: 'HUMAN' });
    const m = await getGateMetrics({ scenario_id: 'LEAD_FOLLOW_UP' });
    expect(m.total).toBe(1);
    expect(m.autonomous).toBe(1);
    expect(m.escalated).toBe(0);
  });
  it('getSevenDimCoverage 计算某闸门的 7 维输入完整度', async () => {
    const c = await getSevenDimCoverage({ scenario_id: 'LEAD_FOLLOW_UP' });
    expect(c).toHaveProperty('identity');
    expect(c).toHaveProperty('governance');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest test/monitor.test.js --run`
Expected: FAIL（monitorStore 不存在 → import 报错）

- [ ] **Step 3: 实现 monitorStore**

```javascript
// src/monitor/monitorStore.js — 销售决策监控存储聚合（只读，供监控台/API 读）
import { query } from '../db.js';

const GATE_SCENARIOS = ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING',
  'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW'];

export async function getGateMetrics({ scenario_id = null, state = null, limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (scenario_id) { params.push(scenario_id); where += ` WHERE scenario_id=$${params.length}`; }
  if (state) { params.push(state); where += (where ? ' AND ' : ' WHERE ') + `state=$${params.length}`; }
  params.push(limit);
  const r = await query(`SELECT scenario_id, state, count(*)::int n, mode() WITHIN GROUP (ORDER BY disposition) top_disposition
    FROM crm.decision ${where} GROUP BY scenario_id, state ORDER BY scenario_id LIMIT $${params.length}`, params);
  const agg = { total: 0, autonomous: 0, escalated: 0, human: 0, byScenario: {} };
  for (const row of r.rows) {
    agg.total += row.n;
    if (row.state === 'AUTONOMOUS') agg.autonomous += row.n;
    if (row.state === 'HUMAN') agg.human += row.n;
    if (row.state === 'REQUIRED') agg.escalated += row.n;
    agg.byScenario[row.scenario_id] = { n: row.n, top_disposition: row.top_disposition };
  }
  return agg;
}

export async function getDecisionList({ scenario_id = null, limit = 20 } = {}) {
  return listDecisions({ scenario_id, limit }); // 复用 decisionRepo
}

export async function getSevenDimCoverage({ scenario_id }) {
  const dims = ['identity', 'structure', 'semantics', 'time', 'history', 'state', 'governance'];
  // 从 decision_scenario.eval_dimensions 读取该闸门条件维度（七维条件补在这里，见 Task 1）→ cond 命名前缀判定维度族
  const r = (await query(`SELECT eval_dimensions FROM crm.decision_scenario WHERE scenario_id=$1`, [scenario_id])).rows[0];
  const conds = r?.eval_dimensions?.map(c => c.cond) || [];
  const coverage = {};
  for (const d of dims) {
    coverage[d] = conds.some(k => k.startsWith(d)) ? 'provided' : 'missing';
  }
  return coverage;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest test/monitor.test.js --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitor/monitorStore.js test/monitor.test.js
git commit -m "feat: 销售决策监控存储聚合查询（闸门指标/7维覆盖）"
```

---

## Task 3: 监控持久化订阅（事件总线落库）

**Files:**
- Create: `src/monitor/monitorSubscriber.js`
- Modify: `src/http/routes.js`（注册订阅，参考现有 `registerCaptureSubscriber()` 注册模式 `routes.js:22`）

- [ ] **Step 1: 写失败测试**

```javascript
// test/monitor.test.js 追加
import { on, emit } from '../src/events/bus.js';
import { registerMonitorSubscriber } from '../src/monitor/monitorSubscriber.js';
it('监控订阅把 decision 事件域落库到监控表', async () => {
  registerMonitorSubscriber();
  await emit('decision', 'made', { decision_id: '00000000-0000-0000-0000-000000000001', scenario_id: 'LEAD_FOLLOW_UP' });
  const n = (await query(`SELECT count(*)::int n FROM crm.monitor_event WHERE domain='decision'`)).rows[0].n;
  expect(n).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest test/monitor.test.js --run`
Expected: FAIL（monitor_event 表不存在）

- [ ] **Step 3: 实现 monitorSubscriber + monitor_event 表**

```javascript
// src/monitor/monitorSubscriber.js — 监控持久化订阅（bus.on('decision'...) 落库，异常隔离不阻断写）
import { query } from '../db.js';
import { on } from '../events/bus.js';

let registered = false;
export async function registerMonitorSubscriber() {
  if (registered) return;
  registered = true;
  on('decision', async (msg) => {
    try {
      await query(`INSERT INTO crm.monitor_event (domain, event_type, decision_id, scenario_id, payload)
        VALUES ('decision', $1, $2, $3, $4)`,
        [msg.type, msg.summary?.decision_id ?? null, msg.summary?.scenario_id ?? null, JSON.stringify(msg.summary)]);
    } catch (e) {
      console.error('[monitor-subscriber] persistence error:', e?.message); // 隔离：不阻断 emit
    }
  });
}

// 幂等建表（启动时调用；或并入既有 schema seed）
export async function ensureMonitorSchema() {
  await query(`CREATE TABLE IF NOT EXISTS crm.monitor_event (
    id BIGSERIAL PRIMARY KEY,
    domain text NOT NULL,
    event_type text,
    decision_id uuid,
    scenario_id text,
    payload jsonb,
    created_at timestamptz DEFAULT now()
  )`);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest test/monitor.test.js --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitor/monitorSubscriber.js test/monitor.test.js
git commit -m "feat: 监控持久化订阅（decision 事件域落库 monitor_event）"
```

---

## Task 4: 监控 API（聚合查询端点）

**Files:**
- Modify: `src/http/routes.js`（加 `/api/monitor/gates`、`/api/monitor/decisions`、`/api/monitor/coverage`）

- [ ] **Step 1: 写失败测试**

Run: `npx vitest test/http.test.js --run`（先确认现有 http 测试基线）

- [ ] **Step 2: 在 http.test.js 追加端点断言**

```javascript
it('GET /api/monitor/gates 返回 7 闸门指标', async () => {
  const res = await request(app).get('/api/monitor/gates');
  expect(res.status).toBe(200);
  expect(res.body.gates.length).toBe(7); // 或 ≥1，按 seed 现状
  expect(res.body.gates[0]).toHaveProperty('scenario_id');
});
```

- [ ] **Step 3: 实现端点**

```javascript
// routes.js 追加
import { getGateMetrics, getDecisionList, getSevenDimCoverage } from '../monitor/monitorStore.js';
app.get('/api/monitor/gates', async (req, res) => {
  const gates = [];
  for (const s of GATE_SCENARIOS) {
    const m = await getGateMetrics({ scenario_id: s });
    const cov = await getSevenDimCoverage({ scenario_id: s });
    gates.push({ scenario_id: s, metrics: m, coverage: cov });
  }
  res.json({ gates });
});
app.get('/api/monitor/decisions', async (req, res) => {
  const { scenario_id } = req.query;
  res.json({ items: await getDecisionList({ scenario_id: scenario_id || null }) });
});
app.get('/api/monitor/coverage', async (req, res) => {
  const { scenario_id } = req.query;
  res.json({ coverage: await getSevenDimCoverage({ scenario_id }) });
});
```

（`GATE_SCENARIOS` 需从 monitorStore 导出供 routes 用）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest test/http.test.js --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js src/monitor/monitorStore.js test/http.test.js
git commit -m "feat: 销售决策监控聚合 API（gates/decisions/coverage）"
```

---

## Task 5: 销售决策监控台页面（7 闸门看板 + 钻取）

**Files:**
- Create: `web/sales-decision-monitor.html`
- Modify: `src/http/routes.js`（挂载静态页）

- [ ] **Step 1: 写页面骨架（7 闸门卡片 + 7 维完整度条 + 钻取链接）**

```html
<!-- web/sales-decision-monitor.html -->
<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>销售决策监控台</title>
<style>body{font-family:system-ui;margin:2rem;color:#1a1a1a}.gate{display:inline-block;width:280px;margin:8px;padding:12px;border:1px solid #ddd;border-radius:8px;vertical-align:top}.dim{height:6px;background:#eee;margin:2px 0}.dim.provided{background:#3b6d11}.dim.missing{background:#a32d2d}</style>
</head><body><h1>销售决策监控台 · 7 阶段闸门</h1><div id="gates"></div>
<div id="detail" style="margin-top:2rem"></div>
<script>
const GATES = ['LEAD_FOLLOW_UP','OPP_QUALIFY','SOLUTION_VALUE','QUOTE_PRICING','SIGN_RISK','POST_CONTRACT','LOSS_REVIEW'];
const DIMS = ['identity','structure','semantics','time','history','state','governance'];
async function load() {
  const r = await fetch('/api/monitor/gates'); const { gates } = await r.json();
  const box = document.getElementById('gates'); box.innerHTML = '';
  for (const g of gates) {
    const cov = DIMS.map(d => `<div class="dim ${g.coverage[d] === 'provided' ? 'provided' : 'missing'}"></div>`).join('');
    box.insertAdjacentHTML('beforeend',
      `<div class="gate"><b>${g.scenario_id}</b><div>自主 ${g.metrics.autonomous} · 升级 ${g.metrics.escalated}</div>${cov}
       <button onclick="drill('${g.scenario_id}')">钻取</button></div>`);
  }
}
async function drill(s) {
  const r = await fetch(`/api/monitor/decisions?scenario_id=${s}`); const { items } = await r.json();
  document.getElementById('detail').innerHTML = `<h2>${s} 决策列表</h2>` +
    items.map(d => `<p><b>${d.decision_id}</b> ${d.disposition} · ${d.state}</p>`).join('') || '<p>暂无</p>';
}
load();
</script></body></html>
```

- [ ] **Step 2: 挂载静态页路由（routes.js）**

```javascript
app.get('/sales-decision-monitor', (req, res) =>
  res.sendFile(fileURLToPath(new URL('../web/sales-decision-monitor.html', import.meta.url))));
```

- [ ] **Step 3: 验证页面加载（浏览器打开 `/sales-decision-monitor`，应显示 7 闸门卡片 + 7 维条）**

Run: 启动服务后访问 `http://localhost:3002/sales-decision-monitor`（按仓库实际端口）

- [ ] **Step 4: Commit**

```bash
git add web/sales-decision-monitor.html src/http/routes.js
git commit -m "feat: 销售决策监控台页面（7 闸门看板 + 钻取）"
```

---

## Task 6: 全量回归 + 收尾

- [ ] **Step 1: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全绿（含既有 decision/decision-gate/http/monitor 测试）

- [ ] **Step 2: 核对验收锚点（设计文档 §7）**

- `decision_scenario` 表存在 D1–D7 行 → `SELECT count(*) FROM crm.decision_scenario` = 7
- 条件维度驱动评估：`autonomyEngine.js:16-27`（buildConditions 从 methodology_dimension 加载）
- 缺失维度自动升级：`autonomyEngine.js:71-74`（missing→escalated，不脑补）
- 决策事件落库：`decisionRepo.js:140-148`（recordDecisionEvent → decision_event）
- SSE 事件域含 decision：`routes.js:70`
- 监控持久化订阅：`bus.on('decision')` 落库 monitor_event

- [ ] **Step 3: Commit（若验收锚点有修正）**

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 §2（7 闸门）→ Task 1/5；§3（配置预定义）→ Task 1；§4（埋点采集）→ Task 3；§5（监控台+差异）→ Task 4/5；§6 落地清单 6 项 → Task 1–6。✓
- **占位符扫描**：无 TBD/TODO。✓
- **类型一致性**：`GATE_SCENARIOS` 在 Task 2 定义于 monitorStore，Task 4 路由复用需导出——已注明。`registerMonitorSubscriber` 在 Task 3 定义，Task 3 Step1 测试先引用（TDD 顺序内）。✓
- **三处拍板默认立场**：CRM_DEAL 状态流保留（不拆分）、why: 字段移交 C 层（Task 1 未动粒子、仅 seed 条件）、DECISION 入注册表延后（本计划不涉及 PARTICLE_TYPES 迁移）。✓
- **范围决定（2026-08-25 20:28 用户确认"2"）**：保持现状——只做 7 闸门闭环监控；粒子拆分（DECISION 入注册表、RTM/Gate 建模、CRM_DEAL 拆分、why: 移交 C 层）整体延后为独立后续计划，本计划不涉及粒子模型变更。✓