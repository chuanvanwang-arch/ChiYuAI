# 决策校准 P1：度量 / 归因 / 处方 / 影子重放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0 采集到的人工处置信号变成可度量、可归因、可执行的调整处方，并让每张处方自带「预期影响」（影子重放）。

**Architecture:** 四个纯函数模块（`metrics` 度量 / `rules` 归因 / `replay` 影子重放 / `store` 配置与处方落库）+ 一个 DI 式路由（`calibrationRouter`）。置信度公式参数从 `autonomyEngine.js:8` 的硬编码常量外置到 `config_store['autonomy-conf']`，引擎缺省行为由 parity 测试锁死不变。处方只产出 `threshold` 与 `weight` 两类旋钮（`required_dims` 留 P3）。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL（pg）+ vitest 3

**设计依据：** `docs/2026-08-28-decision-quality-calibration-design.md` §2.2–§2.4、§4–§7（已批准）

**前置依赖：** P0（`2026-08-28-calibration-p0-disposition-wiring.md`）已合入——`decision.human_*` 四列与 `tasks.decision_id` 必须存在，否则 `autonomy_override_rate` 恒为 0。

**测试命令约定：** 沙箱内禁 `npx`，统一用
`node node_modules/vitest/vitest.mjs run <files>`

**路由工厂惯例（已核实）：** `export function createXRouter({ deps = {} } = {})` → `Router()`，`app.use(createXRouter({}))` 挂载；参照 `src/http/workbenchRouter.js:153` 与 `routes.js:1433`。

---

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` | 改 | `crm.calibration_patch` 建表 |
| `db/seed.sql` / `db/test-setup.sql` | 改 | `CALIBRATION_CHANGE` 场景种子（幂等） |
| `scripts/seed-test-config.mjs` | 改 | 测试库补 `calibration_patch` 表 + 场景 |
| `src/calibration/constants.js` | 新建 | `REPLAY_K` / `MIN_SAMPLE` / `FATIGUE_HOURS` 单一事实源 |
| `src/calibration/metrics.js` | 新建 | 6 项指标纯函数 |
| `src/calibration/replay.js` | 新建 | 影子重放（置信度复算 + 场景级影响估算） |
| `src/calibration/rules.js` | 新建 | 归因规则（含 2 条拒绝出方守卫） |
| `src/calibration/store.js` | 新建 | 配置读写 + 处方 CRUD + 第0闸应用/回滚 |
| `src/decision/autonomyEngine.js` | 改 | 消费 `config_store['autonomy-conf']` |
| `src/http/calibrationRouter.js` | 新建 | `/api/calibration/*`（sysadmin） |
| `src/http/routes.js` | 改 | 挂载 |
| `test/calibration/metrics.test.js` | 新建 | 指标纯函数 |
| `test/calibration/replay.test.js` | 新建 | 重放准确性（对 `decision_event.payload.confidence` 误差 < 1e-6） |
| `test/calibration/rules.test.js` | 新建 | 出方与拒绝出方 |
| `test/calibration/parity.test.js` | 新建 | 外置后引擎行为与 `DEFAULT_CONF` 完全一致 |
| `test/http/calibrationRouter.test.js` | 新建 | 端点契约（403 / 第0闸 / 回滚） |

---

## Task 1: 处方表与 `CALIBRATION_CHANGE` 场景

**Files:**
- Modify: `db/schema.sql`、`db/seed.sql`、`db/test-setup.sql`、`scripts/seed-test-config.mjs`

- [ ] **Step 1: 建表**

在 `db/schema.sql` 末尾追加：

```sql
-- 决策校准处方（设计 2026-08-28 §2.2）
CREATE TABLE IF NOT EXISTS crm.calibration_patch (
  patch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     TEXT NOT NULL REFERENCES crm.decision_scenario(scenario_id),
  knob            TEXT NOT NULL CHECK (knob IN ('threshold', 'weight', 'required_dims')),
  target          TEXT,
  from_value      JSONB NOT NULL,
  to_value        JSONB NOT NULL,
  evidence        JSONB NOT NULL,
  expected_impact JSONB,
  risk            TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','ROLLED_BACK')),
  decision_id     UUID REFERENCES crm.decision(decision_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_calibration_patch_status
  ON crm.calibration_patch(status, created_at DESC);
```

> `knob` 枚举含 `required_dims` 是 **P3 预留**（7×7 落地后再实现），本期 `rules.js` 只产出 `threshold` / `weight`。提前入枚举可免二次 DDL。

- [ ] **Step 2: 场景种子**

在 `db/seed.sql` 的 `ATTR_SCHEMA_CHANGE` 行之后（约 `:268`）、`ON CONFLICT (scenario_id) DO NOTHING;` 之前插入；**并在 `db/test-setup.sql`（约 `:49` 起同类 INSERT 块）做同样插入**：

```sql
('CALIBRATION_CHANGE', 'meta', '决策引擎校准参数变更（阈值/权重）',
 '{"action":["calibration-patch-apply"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"impact","label":"影响面","weight":1,"required":true},{"cond":"evidence","label":"证据充分性","weight":1,"required":true},{"cond":"rollback","label":"可回滚性","weight":1,"required":true}]'::jsonb,
 'HIGH', FALSE)
```

> 两处都要写：`db/seed.sql` 供业务库 `npm run seed`，`db/test-setup.sql` 供测试。`HIGH` + `autonomous_allowed=FALSE` 是刻意的——改阈值直接影响自主放行边界，与 `ATTR_SCHEMA_CHANGE` 同级，不允许自主执行。

- [ ] **Step 3: 测试库前置补表**

在 `scripts/seed-test-config.mjs` 追加（并挂进 `main()` 的 steps）：

```js
// ⑨ 决策校准处方表 + CALIBRATION_CHANGE 场景
async function ensureCalibrationPatch() {
  return run(`
    CREATE TABLE IF NOT EXISTS crm.calibration_patch (
      patch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scenario_id TEXT NOT NULL REFERENCES crm.decision_scenario(scenario_id),
      knob TEXT NOT NULL CHECK (knob IN ('threshold','weight','required_dims')),
      target TEXT,
      from_value JSONB NOT NULL, to_value JSONB NOT NULL,
      evidence JSONB NOT NULL, expected_impact JSONB,
      risk TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','ROLLED_BACK')),
      decision_id UUID REFERENCES crm.decision(decision_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ, resolved_by TEXT
    );
    INSERT INTO crm.decision_scenario
      (scenario_id, stage, name, action_scope, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
    VALUES ('CALIBRATION_CHANGE','meta','决策引擎校准参数变更（阈值/权重）',
      '{"action":["calibration-patch-apply"]}'::jsonb, ARRAY[]::TEXT[], '[]'::jsonb, 'HIGH', FALSE)
    ON CONFLICT (scenario_id) DO NOTHING;
  `);
}
```

- [ ] **Step 4: 执行并验证**

Run: `node db/migrate.js && node db/migrate.js --seed`
Run: `PGDATABASE=plm_test node scripts/seed-test-config.mjs`
Expected: 均成功；`SELECT count(*) FROM crm.decision_scenario WHERE scenario_id='CALIBRATION_CHANGE'` 返回 1

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql db/seed.sql db/test-setup.sql scripts/seed-test-config.mjs
git commit -m "feat(calibration-p1): calibration_patch 表 + CALIBRATION_CHANGE 场景"
```

---

## Task 2: 常量与度量纯函数

**Files:**
- Create: `src/calibration/constants.js`
- Create: `src/calibration/metrics.js`
- Test: `test/calibration/metrics.test.js`

> **指标口径的关键决定：决策来源用 `decider_type` 判定，不用 `state`**。P0 之后被覆写的自主决策 `state` 会变成 `REVERSED`，若按 `state==='AUTONOMOUS'` 筛选，被覆写的样本会被排除，`autonomy_override_rate` 将恒为 0。`decider_type` 由 P0 明确保留（不覆写），是唯一可靠的来源标记。

- [ ] **Step 1: 写失败测试**

```js
// test/calibration/metrics.test.js — 校准指标纯函数
import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/calibration/metrics.js';

const d = (o = {}) => ({
  decision_id: 'd1', scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE',
  decider_type: 'AUTONOMOUS_AGENT', state: 'AUTONOMOUS', business_tier: 'LEAD',
  human_disposition: null, human_decided_at: null, outcome: null,
  created_at: '2026-08-01T00:00:00.000Z',
  referenced_precedents: [{ precedent_id: 'p1', similarity: 0.9 }],
  conditions_evaluated: [{ cond: 'a', weight: 1, met: true }],
  trigger_context: {},
  ...o,
});

describe('computeMetrics', () => {
  it('空样本 → 全零且 sufficient_sample=false', () => {
    const m = computeMetrics([]);
    expect(m.sample_size).toBe(0);
    expect(m.autonomy_override_rate).toBe(0);
    expect(m.sufficient_sample).toBe(false);
  });

  it('自主决策被覆写 → autonomy_override_rate 正确（state 已变 REVERSED 仍计入）', () => {
    const rows = [
      d({ decision_id: 'a1', state: 'REVERSED', human_disposition: 'REJECT', outcome: 'REVERSED' }),
      d({ decision_id: 'a2', state: 'CONFIRMED', human_disposition: 'APPROVE' }),
      d({ decision_id: 'a3', state: 'AUTONOMOUS', human_disposition: null }),
    ];
    const m = computeMetrics(rows);
    expect(m.autonomy_override_rate).toBeCloseTo(1 / 3, 6);
    expect(m.autonomous_count).toBe(3);
  });

  it('升级决策超时未处置 → escalation_fatigue_rate 正确', () => {
    const now = new Date('2026-08-02T00:00:00.000Z').getTime(); // 距今 24h
    const rows = [
      d({ decision_id: 'h1', decider_type: 'HUMAN', state: 'HUMAN', human_disposition: null }),
      d({ decision_id: 'h2', decider_type: 'HUMAN', state: 'CONFIRMED', human_disposition: 'APPROVE' }),
    ];
    const m = computeMetrics(rows, { now });
    expect(m.escalation_fatigue_rate).toBeCloseTo(0.5, 6);
  });

  it('人工延迟 p50 与先例覆盖率', () => {
    const rows = [
      d({ decision_id: 'x1', human_disposition: 'APPROVE', human_decided_at: '2026-08-01T01:00:00.000Z' }),
      d({ decision_id: 'x2', human_disposition: 'APPROVE', human_decided_at: '2026-08-01T03:00:00.000Z' }),
    ];
    const m = computeMetrics(rows);
    expect(m.human_latency_p50_ms).toBe(3 * 3600 * 1000);
    expect(m.precedent_coverage_avg).toBeCloseTo(1 / 5, 6); // REPLAY_K=5
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/metrics.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现常量**

```js
// src/calibration/constants.js — 校准层常量单一事实源
// REPLAY_K：先例检索条数，与 autonomyEngine.js:79 的 `opts.k || 5` 对齐。
//   技术债：k 未落库，重放端只能取常量。若运行端未来传入自定义 k，须同步落库或配置化，否则重放失真。
export const REPLAY_K = 5;
export const MIN_SAMPLE = 20;      // 最小样本闸门（R6）
export const FATIGUE_HOURS = 24;   // 升级件超过此时长无人处置 = 升级疲劳
export const CONF_FLOOR = 0.5;     // 有效阈值下限，与 autonomyEngine.js:93 的 Math.max(..., 0.5) 对齐
export const REL_BOOST = 0.3;      // 强关系单项加成
export const REL_THRESHOLD_RELAX = 0.1;
export const CONF_CAP = 0.95;
```

- [ ] **Step 4: 实现度量**

```js
// src/calibration/metrics.js — 决策质量度量（纯函数，无 PG 依赖）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §4
// 口径：决策来源以 decider_type 判定（AUTONOMOUS_AGENT=自主 / HUMAN=升级），
//   不用 state —— P0 后覆写会使 state 变为 REVERSED，用 state 筛会把被覆写样本排除、指标恒为 0。
import { REPLAY_K, MIN_SAMPLE, FATIGUE_HOURS } from './constants.js';

const isOverridden = (x) => Boolean(x.human_disposition) && x.human_disposition !== x.disposition;

export function computeMetrics(decisions, { now = Date.now(), fatigueHours = FATIGUE_HOURS, minSample = MIN_SAMPLE } = {}) {
  const list = Array.isArray(decisions) ? decisions : [];
  const n = list.length;

  const autonomous = list.filter((x) => x.decider_type === 'AUTONOMOUS_AGENT');
  const escalated = list.filter((x) => x.decider_type === 'HUMAN');
  const reviewed = list.filter((x) => x.human_disposition);

  const autonomyOverrideRate = autonomous.length
    ? autonomous.filter(isOverridden).length / autonomous.length : 0;
  const escalatedOverrideRate = escalated.length
    ? escalated.filter(isOverridden).length / escalated.length : 0;

  const fatigueMs = fatigueHours * 3600 * 1000;
  const fatigue = escalated.filter(
    (x) => !x.human_disposition && (now - new Date(x.created_at).getTime()) > fatigueMs).length;

  const latencies = reviewed
    .filter((x) => x.human_decided_at && x.created_at)
    .map((x) => new Date(x.human_decided_at).getTime() - new Date(x.created_at).getTime())
    .sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  const coverageOf = (x) =>
    Math.min((Array.isArray(x.referenced_precedents) ? x.referenced_precedents.length : 0) / REPLAY_K, 1);

  return {
    sample_size: n,
    autonomous_count: autonomous.length,
    escalated_count: escalated.length,
    reviewed_count: reviewed.length,
    autonomy_rate: n ? autonomous.length / n : 0,
    escalate_rate: n ? escalated.length / n : 0,
    autonomy_override_rate: autonomyOverrideRate,
    escalated_override_rate: escalatedOverrideRate,
    escalation_fatigue_rate: escalated.length ? fatigue / escalated.length : 0,
    human_latency_p50_ms: p50,
    reversal_rate: n ? list.filter((x) => x.outcome === 'REVERSED').length / n : 0,
    precedent_coverage_avg: n ? list.reduce((s, x) => s + coverageOf(x), 0) / n : 0,
    sufficient_sample: n >= minSample,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/metrics.test.js`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add src/calibration/constants.js src/calibration/metrics.js test/calibration/metrics.test.js
git commit -m "feat(calibration-p1): 校准常量 + 6 项质量指标纯函数"
```

---

## Task 3: 影子重放

**Files:**
- Create: `src/calibration/replay.js`
- Test: `test/calibration/replay.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/calibration/replay.test.js — 影子重放（处方预期影响的计算器）
import { describe, it, expect } from 'vitest';
import { replayConfidence, replayScenario, DEFAULT_AUTONOMY_CONF } from '../../src/calibration/replay.js';

const d = (o = {}) => ({
  scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
  state: 'AUTONOMOUS', business_tier: 'LEAD', human_disposition: null,
  conditions_evaluated: [{ cond: 'a', weight: 1, met: true }],
  referenced_precedents: [{ precedent_id: 'p1', similarity: 0.9 }],
  trigger_context: {}, ...o,
});

describe('replayConfidence', () => {
  it('公式与 autonomyEngine 一致：手算可复核', () => {
    const row = d({
      conditions_evaluated: [{ cond: 'a', weight: 3, met: true }, { cond: 'b', weight: 1, met: false }],
      referenced_precedents: [{ similarity: 0.8 }, { similarity: 0.6 }],
    });
    // methodScore = 3/4 = 0.75；avgSimilarity = 0.7；coverage = 2/5 = 0.4；allMet = false
    const expectConf = 0.4 * 0.7 + 0.3 * 0.4 + 0.2 * 0.75 + 0.1 * 0;
    expect(replayConfidence(row, DEFAULT_AUTONOMY_CONF)).toBeCloseTo(expectConf, 10);
  });

  it('强关系加成与 0.95 封顶', () => {
    const row = d({
      conditions_evaluated: [{ cond: 'a', weight: 1, met: true }],
      referenced_precedents: [{ similarity: 1 }, { similarity: 1 }, { similarity: 1 }, { similarity: 1 }, { similarity: 1 }],
      trigger_context: { relations: { champion_strength: 'high', relationship_strength: 'strong' } },
    });
    // base = 0.4*1 + 0.3*1 + 0.2*1 + 0.1*1 = 1.0；+0.6 relBoost → 封顶 0.95
    expect(replayConfidence(row, DEFAULT_AUTONOMY_CONF)).toBe(0.95);
  });
});

describe('replayScenario', () => {
  it('阈值上调 → 自主数不增、升级数不减', () => {
    const rows = [
      d({ conditions_evaluated: [{ cond: 'a', weight: 1, met: true }], referenced_precedents: [{ similarity: 0.95 }] }),
      d({ conditions_evaluated: [{ cond: 'a', weight: 1, met: false }], referenced_precedents: [] }),
    ];
    const before = replayScenario(rows, { ...DEFAULT_AUTONOMY_CONF, threshold: 0.5 });
    const after = replayScenario(rows, { ...DEFAULT_AUTONOMY_CONF, threshold: 0.9 });
    expect(after.autonomy).toBeLessThanOrEqual(before.autonomy);
    expect(after.escalated).toBeGreaterThanOrEqual(before.escalated);
  });

  it('HIGH 分级恒升级（与引擎同律）', () => {
    const rows = [d({ business_tier: 'HIGH', referenced_precedents: [{ similarity: 1 }] })];
    const r = replayScenario(rows, { ...DEFAULT_AUTONOMY_CONF, threshold: 0.1 });
    expect(r.escalated).toBe(1);
  });

  it('传入 current 指标 → 输出预估覆写率', () => {
    const rows = [d()];
    const r = replayScenario(rows, DEFAULT_AUTONOMY_CONF, {
      current: { autonomy_override_rate: 0.3, escalated_override_rate: 0.05 },
    });
    expect(typeof r.estimated_override_rate).toBe('number');
    expect(r.estimated_override_rate).toBeGreaterThanOrEqual(0);
    expect(r.estimated_override_rate).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/replay.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```js
// src/calibration/replay.js — 影子重放（用历史决策精确重算候选参数下的判定）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §6
// 可行性：置信度公式所需输入全部已落库（conditions_evaluated / referenced_precedents[].similarity /
//   business_tier / trigger_context.relations），故重放是纯确定性计算、零 LLM 成本。
//   且 similarity 用的是决策当时的值，不受先例库后续演化影响——这是本方案成立的前提。
import { REPLAY_K, CONF_FLOOR, REL_BOOST, REL_THRESHOLD_RELAX, CONF_CAP } from './constants.js';

export const DEFAULT_AUTONOMY_CONF = Object.freeze({
  threshold: 0.8,
  weights: Object.freeze({ similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 }),
});

// 导出给 rules.js 使用（R4 归因需对比被覆写/未覆写的自主样本的方法论得分）
export function methodScoreOf(conditions) {
  const cs = Array.isArray(conditions) ? conditions : [];
  if (!cs.length) return 1.0;
  const total = cs.reduce((s, c) => s + (Number(c.weight) || 1), 0);
  const earned = cs.reduce((s, c) => s + (Number(c.weight) || 1) * (c.met ? 1 : 0), 0);
  return total ? earned / total : 1.0;
}

function relBoostOf(trigger_context) {
  const rel = (trigger_context && trigger_context.relations) || {};
  return (['high', 'champion'].includes(rel.champion_strength) ? REL_BOOST : 0)
       + (['high', 'strong'].includes(rel.relationship_strength) ? REL_BOOST : 0);
}

// 复算单条决策在给定参数下的置信度（与 autonomyEngine.js:37-97 同公式）
export function replayConfidence(decision, cfg = DEFAULT_AUTONOMY_CONF) {
  const w = cfg.weights || DEFAULT_AUTONOMY_CONF.weights;
  const prec = Array.isArray(decision.referenced_precedents) ? decision.referenced_precedents : [];
  const avgSimilarity = prec.length
    ? prec.reduce((s, p) => s + (Number(p.similarity) || 0), 0) / prec.length : 0;
  const coverage = Math.min(prec.length / REPLAY_K, 1);
  const methodScore = methodScoreOf(decision.conditions_evaluated);
  const cs = Array.isArray(decision.conditions_evaluated) ? decision.conditions_evaluated : [];
  const allMet = cs.length ? cs.every((c) => c.met) : true;

  const base = (w.similarity || 0) * avgSimilarity
             + (w.coverage || 0) * coverage
             + (w.method || 0) * methodScore
             + (w.allMet || 0) * (allMet ? 1 : 0);
  return Math.min(base + relBoostOf(decision.trigger_context), CONF_CAP);
}

// 重放整批：返回自主/升级分布与预估覆写率
export function replayScenario(decisions, cfg = DEFAULT_AUTONOMY_CONF, { current = null } = {}) {
  const list = Array.isArray(decisions) ? decisions : [];
  let autonomy = 0;
  let escalated = 0;
  for (const d of list) {
    const conf = replayConfidence(d, cfg);
    const relax = relBoostOf(d.trigger_context) > 0 ? REL_THRESHOLD_RELAX : 0;
    const effectiveThreshold = Math.max((cfg.threshold ?? 0.8) - relax, CONF_FLOOR);
    const forceException = d.disposition === 'EXCEPTION';
    const isEsc = forceException
      || d.business_tier === 'HIGH'
      || (d.business_tier !== 'HIGH' && conf < effectiveThreshold);
    if (isEsc) escalated++; else autonomy++;
  }
  const n = list.length || 1;
  let estimated_override_rate = null;
  if (current) {
    const ar = autonomy / n;
    estimated_override_rate =
      ar * (current.autonomy_override_rate || 0) + (1 - ar) * (current.escalated_override_rate || 0);
  }
  return { total: list.length, autonomy, escalated, autonomy_rate: autonomy / n, estimated_override_rate };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/replay.test.js`
Expected: 5 passed

- [ ] **Step 5: 重放准确性校验（对真实引擎产物）**

在 `test/calibration/replay.test.js` 末尾追加：

```js
describe('重放准确性（对引擎真实产物复核）', () => {
  it('重放 conf 与 decision_event.payload.confidence 误差 < 1e-6', async () => {
    const { query } = await import('../../src/db.js');
    const { requireDecision } = await import('../../src/decision/autonomyEngine.js');
    await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event RESTART IDENTITY CASCADE');

    const r = await requireDecision('LEAD_FOLLOW_UP', { name: '重放校验' }, []);
    const ev = (await query(
      `SELECT payload FROM crm.decision_event WHERE decision_id=$1 AND event_type IN ('autonomous','escalated')`,
      [r.decision.decision_id])).rows[0];
    const replayed = replayConfidence(r.decision, DEFAULT_AUTONOMY_CONF);
    expect(Math.abs(replayed - ev.payload.confidence)).toBeLessThan(1e-6);
  });
});
```

Run: `node node_modules/vitest/vitest.mjs run test/calibration/replay.test.js`
Expected: 6 passed（若该用例失败，说明重放公式与引擎漂移，**必须先修公式再继续**，否则所有"预期影响"都是错的）

- [ ] **Step 6: Commit**

```bash
git add src/calibration/replay.js test/calibration/replay.test.js
git commit -m "feat(calibration-p1): 影子重放（置信度复算 + 场景级影响估算）"
```

---

## Task 4: 归因规则

**Files:**
- Create: `src/calibration/rules.js`
- Test: `test/calibration/rules.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/calibration/rules.test.js — 归因规则（出方与拒绝出方）
import { describe, it, expect } from 'vitest';
import { attribute } from '../../src/calibration/rules.js';
import { computeMetrics } from '../../src/calibration/metrics.js';
import { DEFAULT_AUTONOMY_CONF } from '../../src/calibration/replay.js';

const base = { ...computeMetrics([]), sample_size: 50, sufficient_sample: true, precedent_coverage_avg: 0.8 };
const d = (o = {}) => ({
  decider_type: 'AUTONOMOUS_AGENT', disposition: 'APPROVE', human_disposition: null,
  conditions_evaluated: [{ cond: 'a', weight: 1, met: true }],
  referenced_precedents: [{ similarity: 0.9 }], trigger_context: {}, ...o,
});

describe('归因守卫（拒绝出方优先）', () => {
  it('R6 样本不足 → 不出方', () => {
    const m = { ...base, sample_size: 5, sufficient_sample: false, autonomy_override_rate: 0.9 };
    const r = attribute(m, { scenario_id: 'X', config: DEFAULT_AUTONOMY_CONF, decisions: [] });
    expect(r.patches).toHaveLength(0);
    expect(r.blocked_by[0].rule_id).toBe('R6');
  });

  it('R5 先例覆盖不足 → 不出方', () => {
    const m = { ...base, precedent_coverage_avg: 0.1, autonomy_override_rate: 0.9 };
    const r = attribute(m, { scenario_id: 'X', config: DEFAULT_AUTONOMY_CONF, decisions: [] });
    expect(r.patches).toHaveLength(0);
    expect(r.blocked_by[0].rule_id).toBe('R5');
  });
});

describe('归因出方', () => {
  it('R1 覆写率高且置信度贴边 → 上调 threshold 0.05（LOW）', () => {
    const m = { ...base, autonomy_override_rate: 0.4, autonomous_count: 30 };
    const r = attribute(m, {
      scenario_id: 'QUOTE_PRICING', config: DEFAULT_AUTONOMY_CONF, decisions: [],
      confidenceStats: { avg: 0.82, threshold: 0.8, gap: 0.02 },
    });
    const p = r.patches.find((x) => x.rule_id === 'R1');
    expect(p).toBeTruthy();
    expect(p.knob).toBe('threshold');
    expect(p.from).toBe(0.8);
    expect(p.to).toBeCloseTo(0.85, 10);
    expect(p.risk).toBe('LOW');
  });

  it('R2 升级率高且升级件几乎不被改判 → 下调 threshold（MEDIUM）', () => {
    const m = { ...base, escalate_rate: 0.8, escalated_override_rate: 0.01, escalated_count: 40 };
    const r = attribute(m, {
      scenario_id: 'OPP_QUALIFY', config: DEFAULT_AUTONOMY_CONF, decisions: [],
      confidenceStats: { avg: 0.5, threshold: 0.8, gap: 0.3 },
    });
    const p = r.patches.find((x) => x.rule_id === 'R2');
    expect(p).toBeTruthy();
    expect(p.to).toBeCloseTo(0.75, 10);
    expect(p.risk).toBe('MEDIUM');
  });

  it('R3 升级疲劳 > 0.3 → 下调 threshold', () => {
    const m = { ...base, escalation_fatigue_rate: 0.5, escalated_count: 20 };
    const r = attribute(m, {
      scenario_id: 'SIGN_RISK', config: DEFAULT_AUTONOMY_CONF, decisions: [],
      confidenceStats: { avg: 0.5, threshold: 0.8, gap: 0.3 },
    });
    expect(r.patches.some((x) => x.rule_id === 'R3')).toBe(true);
  });

  it('R4 被覆写样本方法论得分显著更低 → 上调 method 权重', () => {
    const decisions = [
      ...Array.from({ length: 5 }, () => d({ conditions_evaluated: [{ cond: 'a', weight: 1, met: true }], human_disposition: 'REJECT' })),
      ...Array.from({ length: 5 }, () => d({ conditions_evaluated: [{ cond: 'a', weight: 1, met: false }], human_disposition: 'APPROVE' })),
    ];
    const m = computeMetrics(decisions);
    const r = attribute({ ...m, sufficient_sample: true, precedent_coverage_avg: 0.8 }, {
      scenario_id: 'QUOTE_PRICING', config: DEFAULT_AUTONOMY_CONF, decisions,
      confidenceStats: { avg: 0.6, threshold: 0.8, gap: 0.2 },
    });
    const p = r.patches.find((x) => x.rule_id === 'R4');
    expect(p).toBeTruthy();
    expect(p.knob).toBe('weight');
    expect(p.target).toBe('method');
  });
});
```

> R4 的方向说明：测试里「被改判的样本 `met:true`（方法论得分高）」「未改判的 `met:false`（得分低）」，即**被覆写者得分反而更高**，说明方法论得分与实际正确性负相关。规则因此上调 `method` 权重（让该分项在置信度中分量更大，从而放大这个已被观测到的信号）。规则实现须与测试口径一致：`(ms(ok) - ms(ov))` 为负且绝对值超过阈值即触发——**实现时以测试为准，不要臆造方向**。

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/rules.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```js
// src/calibration/rules.js — 归因规则（指标偏差 → 可调旋钮）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §5
// 守卫规则（kind='guard'）优先级最高：一旦命中即拒绝出方。小样本上出方 = 过拟合噪声。
import { methodScoreOf } from './replay.js';

const round = (x) => Math.round(x * 1000) / 1000;

export const RULES = [
  {
    id: 'R6', kind: 'guard', priority: 0,
    test: ({ metrics }) => !metrics.sufficient_sample,
    reason: (m) => `样本不足（${m.sample_size} < 20），不产生处方`,
  },
  {
    id: 'R5', kind: 'guard', priority: 1,
    test: ({ metrics }) => metrics.precedent_coverage_avg < 0.3,
    reason: (m) => `先例覆盖率过低（${m.precedent_coverage_avg.toFixed(2)}），调参无效`,
  },
  {
    id: 'R1', kind: 'patch', priority: 2, risk: 'LOW',
    test: ({ metrics, gap }) => metrics.autonomy_override_rate > 0.25 && gap < 0.05,
    patch: ({ config }) => ({
      knob: 'threshold', target: null,
      from: config.threshold, to: round(Math.min(config.threshold + 0.05, 0.95)),
    }),
    reason: (m) => `自主决策覆写率 ${(m.autonomy_override_rate * 100).toFixed(1)}% 偏高，且置信度贴边阈值 → 收紧自主边界`,
  },
  {
    id: 'R2', kind: 'patch', priority: 3, risk: 'MEDIUM',
    test: ({ metrics }) => metrics.escalate_rate > 0.6 && metrics.escalated_override_rate < 0.05,
    patch: ({ config }) => ({
      knob: 'threshold', target: null,
      from: config.threshold, to: round(Math.max(config.threshold - 0.05, 0.5)),
    }),
    reason: (m) => `升级率 ${(m.escalate_rate * 100).toFixed(1)}% 且升级件几乎不被改判 → 可放权`,
  },
  {
    id: 'R3', kind: 'patch', priority: 4, risk: 'MEDIUM',
    test: ({ metrics }) => metrics.escalation_fatigue_rate > 0.3,
    patch: ({ config }) => ({
      knob: 'threshold', target: null,
      from: config.threshold, to: round(Math.max(config.threshold - 0.05, 0.5)),
    }),
    reason: (m) => `升级件 ${(m.escalation_fatigue_rate * 100).toFixed(1)}% 超时无人处置 → 升级虚设，宜放权`,
  },
  {
    id: 'R4', kind: 'patch', priority: 5, risk: 'MEDIUM',
    test: ({ metrics, decisions }) => {
      if (metrics.autonomy_override_rate <= 0.25) return false;
      const a = decisions.filter((x) => x.decider_type === 'AUTONOMOUS_AGENT');
      const ov = a.filter((x) => x.human_disposition && x.human_disposition !== x.disposition);
      const ok = a.filter((x) => !(x.human_disposition && x.human_disposition !== x.disposition));
      if (ov.length < 3 || ok.length < 3) return false;
      const avgMs = (arr) => arr.reduce((s, x) => s + methodScoreOf(x.conditions_evaluated), 0) / arr.length;
      return Math.abs(avgMs(ok) - avgMs(ov)) > 0.15;
    },
    patch: ({ config }) => ({
      knob: 'weight', target: 'method',
      from: config.weights.method, to: round(Math.min(config.weights.method + 0.05, 0.9)),
    }),
    reason: () => '被覆写与未覆写的自主决策，方法论得分差异显著 → 调整 method 权重使该信号在置信度中更有分量',
  },
];

export function attribute(metrics, { scenario_id, config, decisions = [], confidenceStats = null } = {}) {
  const ctx = {
    metrics,
    decisions,
    avg: confidenceStats?.avg ?? 0,
    threshold: config?.threshold ?? 0.8,
    gap: confidenceStats?.gap ?? 1,
  };
  const patches = [];
  const blocked_by = [];
  for (const rule of [...RULES].sort((a, b) => a.priority - b.priority)) {
    if (!rule.test(ctx)) continue;
    if (rule.kind === 'guard') {
      blocked_by.push({ rule_id: rule.id, reason: rule.reason(metrics) });
      return { scenario_id, patches: [], blocked_by };
    }
    patches.push({
      rule_id: rule.id, scenario_id, risk: rule.risk,
      reason: rule.reason(metrics),
      ...rule.patch({ config, metrics }),
    });
  }
  return { scenario_id, patches, blocked_by };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/rules.test.js`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/calibration/rules.js test/calibration/rules.test.js
git commit -m "feat(calibration-p1): 归因规则（2 守卫 + 4 出方）"
```

---

## Task 5: 配置外置与 parity

**Files:**
- Modify: `src/decision/autonomyEngine.js:8,47`
- Create: `src/calibration/store.js`
- Test: `test/calibration/parity.test.js`

- [ ] **Step 1: 写 parity 测试**

```js
// test/calibration/parity.test.js — 配置外置不改变引擎缺省行为
import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTONOMY_CONF } from '../../src/calibration/replay.js';
import { loadAutonomyConf } from '../../src/calibration/store.js';
import { query } from '../../src/db.js';

describe('autonomy-conf 外置 parity', () => {
  it('DEFAULT_AUTONOMY_CONF 与 autonomyEngine 历史常量逐字一致', () => {
    expect(DEFAULT_AUTONOMY_CONF.threshold).toBe(0.8);
    expect(DEFAULT_AUTONOMY_CONF.weights).toEqual({ similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 });
  });

  it('config_store 无该键 → loadAutonomyConf 返回默认值', async () => {
    await query(`DELETE FROM crm.config_store WHERE key='autonomy-conf'`);
    expect(await loadAutonomyConf()).toEqual(DEFAULT_AUTONOMY_CONF);
  });

  it('CALIBRATION_CHANGE 场景在业务库与测试库均存在', async () => {
    const r = (await query(`SELECT default_tier, autonomous_allowed FROM crm.decision_scenario WHERE scenario_id='CALIBRATION_CHANGE'`)).rows[0];
    expect(r).toBeTruthy();
    expect(r.default_tier).toBe('HIGH');
    expect(r.autonomous_allowed).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/parity.test.js`
Expected: FAIL —— `loadAutonomyConf` 不存在

- [ ] **Step 3: 实现 store.js（配置部分）**

```js
// src/calibration/store.js — 校准配置与处方落库
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §2.3 / §7
import { query, queryWrite } from '../db.js';
import { createDecision } from '../decision/decisionRepo.js';
import { DEFAULT_AUTONOMY_CONF } from './replay.js';

export const CONF_KEY = 'autonomy-conf';
export { DEFAULT_AUTONOMY_CONF };

// 读取生效配置；无配置 → 返回默认值（对象副本，防调用方就地修改污染默认值）
export async function loadAutonomyConf() {
  const r = (await query(`SELECT value FROM crm.config_store WHERE key=$1`, [CONF_KEY])).rows[0];
  const v = r?.value;
  if (!v || typeof v.threshold !== 'number' || typeof v.weights !== 'object' || v.weights === null) {
    return { threshold: DEFAULT_AUTONOMY_CONF.threshold, weights: { ...DEFAULT_AUTONOMY_CONF.weights } };
  }
  return {
    threshold: v.threshold,
    weights: { ...DEFAULT_AUTONOMY_CONF.weights, ...v.weights },
  };
}
```

- [ ] **Step 4: 引擎改为消费配置**

把 `src/decision/autonomyEngine.js:47`：

```js
  const cfg = { ...DEFAULT_CONF, ...(opts.conf || {}) };
```

改为：

```js
  const cfg = { ...DEFAULT_CONF, ...(opts.conf || loadAutoConfSync || {}) };
```

**不可行**——`requireDecision` 已是 async，正确改法是显式 await：

```js
  // 阈值/权重外置（设计 §2.3）：opts.conf 优先（测试/调用方显式注入），否则读 config_store
  const cfg = opts.conf || (await loadAutonomyConf());
```

并在文件顶部 import：

```js
import { loadAutonomyConf } from '../calibration/store.js';
```

> **循环依赖检查**：`store.js` 只 import `replay.js`（纯函数）与 `decisionRepo.js`；`autonomyEngine.js` import `store.js`。`store.js` 不 import `autonomyEngine.js`，无环。若后续 store.js 需要引擎能力，改为运行时 `await import()`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/parity.test.js`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add src/calibration/store.js src/decision/autonomyEngine.js test/calibration/parity.test.js
git commit -m "feat(calibration-p1): 阈值/权重外置到 config_store（parity 锁死缺省行为）"
```

---

## Task 6: 处方落库与第0闸审批

**Files:**
- Modify: `src/calibration/store.js`（追加处方 CRUD）
- Test: `test/calibration/store.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/calibration/store.test.js — 处方落库与第0闸审批
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import {
  savePatches, listPatches, approvePatch, rejectPatch, rollbackPatch, loadAutonomyConf,
} from '../../src/calibration/store.js';

beforeEach(async () => {
  await query(`TRUNCATE crm.calibration_patch, crm.decision, crm.decision_event RESTART IDENTITY CASCADE`);
  await query(`DELETE FROM crm.config_store WHERE key='autonomy-conf'`);
});

const patch = { knob: 'threshold', target: null, from: 0.8, to: 0.85, risk: 'LOW', reason: 'r', rule_id: 'R1' };

describe('处方生命周期', () => {
  it('savePatches 幂等：同内容 PENDING 不重复插入', async () => {
    await savePatches('QUOTE_PRICING', [patch], { evidence: { sample_size: 30 } });
    await savePatches('QUOTE_PRICING', [patch], { evidence: { sample_size: 30 } });
    const rows = await listPatches({ status: 'PENDING' });
    expect(rows).toHaveLength(1);
  });

  it('approvePatch → 写 config_store + 携带 decision_id（第0闸）+ APPLIED', async () => {
    await savePatches('QUOTE_PRICING', [patch], {});
    const [p] = await listPatches({ status: 'PENDING' });
    const r = await approvePatch(p.patch_id, { by_id: 'admin', by_role: 'sysadmin' });
    expect(r.ok).toBe(true);
    expect((await loadAutonomyConf()).threshold).toBe(0.85);
    const after = (await query(`SELECT * FROM crm.calibration_patch WHERE patch_id=$1`, [p.patch_id])).rows[0];
    expect(after.status).toBe('APPLIED');
    expect(after.decision_id).toBeTruthy();
    const dec = (await query(`SELECT scenario_id FROM crm.decision WHERE decision_id=$1`, [after.decision_id])).rows[0];
    expect(dec.scenario_id).toBe('CALIBRATION_CHANGE');
  });

  it('rollbackPatch → 恢复 from_value + ROLLED_BACK', async () => {
    await savePatches('QUOTE_PRICING', [patch], {});
    const [p] = await listPatches({ status: 'PENDING' });
    await approvePatch(p.patch_id, { by_id: 'admin', by_role: 'sysadmin' });
    const r = await rollbackPatch(p.patch_id, { by_id: 'admin', by_role: 'sysadmin' });
    expect(r.ok).toBe(true);
    expect((await loadAutonomyConf()).threshold).toBe(0.8);
    const after = (await query(`SELECT status FROM crm.calibration_patch WHERE patch_id=$1`, [p.patch_id])).rows[0];
    expect(after.status).toBe('ROLLED_BACK');
  });

  it('rejectPatch → REJECTED 且不动配置', async () => {
    await savePatches('QUOTE_PRICING', [patch], {});
    const [p] = await listPatches({ status: 'PENDING' });
    await rejectPatch(p.patch_id, { by_id: 'admin' });
    expect((await query(`SELECT status FROM crm.calibration_patch WHERE patch_id=$1`, [p.patch_id])).rows[0].status).toBe('REJECTED');
    expect((await loadAutonomyConf()).threshold).toBe(0.8);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/store.test.js`
Expected: FAIL —— 函数不存在

- [ ] **Step 3: 实现**

在 `src/calibration/store.js` 末尾追加：

```js
// ───────── 处方落库与第0闸审批 ─────────

export async function savePatches(scenario_id, patches, { evidence = {} } = {}) {
  const out = [];
  for (const p of patches || []) {
    // 幂等：同 scenario + knob + target + to 且仍 PENDING → 跳过（不制造重复待办）
    // scenario_id 可为 NULL（全场景处方，P2 引入）：NULL 等值比较恒 unknown → 必须用 IS NOT DISTINCT FROM
    const dup = (await query(
      `SELECT patch_id FROM crm.calibration_patch
        WHERE scenario_id IS NOT DISTINCT FROM $1 AND knob=$2 AND target IS NOT DISTINCT FROM $3
          AND to_value=$4::jsonb AND status='PENDING'`,
      [scenario_id, p.knob, p.target ?? null, JSON.stringify(p.to)])).rows[0];
    if (dup) { out.push(dup); continue; }
    const r = await queryWrite(
      `INSERT INTO crm.calibration_patch (scenario_id, knob, target, from_value, to_value, evidence, risk, status)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'PENDING') RETURNING *`,
      [scenario_id, p.knob, p.target ?? null, JSON.stringify(p.from), JSON.stringify(p.to),
       JSON.stringify({ rule_id: p.rule_id, reason: p.reason, ...evidence }), p.risk]);
    out.push(r.rows[0]);
  }
  return out;
}

export async function listPatches({ status = null, limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE status=$1`; }
  params.push(limit);
  return (await query(
    `SELECT * FROM crm.calibration_patch ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params)).rows;
}

export async function getPatch(patch_id) {
  return (await query(`SELECT * FROM crm.calibration_patch WHERE patch_id=$1`, [patch_id])).rows[0];
}

async function writeConf(value, decision_id, actor) {
  await queryWrite(
    `INSERT INTO crm.config_store (key, value, decision_id, updated_by, updated_at)
     VALUES ($1,$2::jsonb,$3,$4, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, decision_id=EXCLUDED.decision_id,
       updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [CONF_KEY, JSON.stringify(value), String(decision_id), actor || 'system']);
}

// 批准：先建 CALIBRATION_CHANGE 决策（第0闸），再写配置，最后回写 patch
export async function approvePatch(patch_id, { by_id = null, by_role = null } = {}) {
  const p = await getPatch(patch_id);
  if (!p) return { ok: false, error: '处方不存在' };
  if (p.status !== 'PENDING') return { ok: false, error: `处方状态 ${p.status} 不可批准` };

  const conf = await loadAutonomyConf();
  const next = { threshold: conf.threshold, weights: { ...conf.weights } };
  if (p.knob === 'threshold') next.threshold = p.to_value;
  else if (p.knob === 'weight') next.weights[p.target] = p.to_value;
  else return { ok: false, error: `旋钮 ${p.knob} 尚未实现（P3）` };

  const dec = await createDecision({
    scenario_id: 'CALIBRATION_CHANGE',
    trigger_context: { scenario_id: p.scenario_id, knob: p.knob, target: p.target,
                       from: p.from_value, to: p.to_value, rule_id: p.evidence?.rule_id },
    involved_entities: [], conditions_evaluated: [],
    disposition: 'APPROVE', decider_type: 'HUMAN', decider_id: by_id, decider_role: by_role,
    rationale: `校准处方批准：${p.scenario_id} ${p.knob}${p.target ? '.' + p.target : ''} ${JSON.stringify(p.from_value)} → ${JSON.stringify(p.to_value)}`,
    business_tier: 'HIGH', state: 'CONFIRMED',
  });

  await writeConf(next, dec.decision_id, by_id);
  await queryWrite(
    `UPDATE crm.calibration_patch SET status='APPLIED', decision_id=$2, resolved_by=$3, resolved_at=now()
      WHERE patch_id=$1`, [patch_id, dec.decision_id, by_id]);
  return { ok: true, decision_id: dec.decision_id, config: next };
}

export async function rejectPatch(patch_id, { by_id = null } = {}) {
  const p = await getPatch(patch_id);
  if (!p || p.status !== 'PENDING') return { ok: false, error: '处方不存在或状态不可驳回' };
  await queryWrite(
    `UPDATE crm.calibration_patch SET status='REJECTED', resolved_by=$2, resolved_at=now() WHERE patch_id=$1`,
    [patch_id, by_id]);
  return { ok: true };
}

export async function rollbackPatch(patch_id, { by_id = null, by_role = null } = {}) {
  const p = await getPatch(patch_id);
  if (!p || p.status !== 'APPLIED') return { ok: false, error: '仅已应用（APPLIED）的处方可回滚' };

  const conf = await loadAutonomyConf();
  const back = { threshold: conf.threshold, weights: { ...conf.weights } };
  if (p.knob === 'threshold') back.threshold = p.from_value;
  else if (p.knob === 'weight') back.weights[p.target] = p.from_value;

  const dec = await createDecision({
    scenario_id: 'CALIBRATION_CHANGE',
    trigger_context: { rollback_of: patch_id, scenario_id: p.scenario_id, knob: p.knob,
                       target: p.target, to: p.from_value },
    involved_entities: [], conditions_evaluated: [],
    disposition: 'ROLLBACK', decider_type: 'HUMAN', decider_id: by_id, decider_role: by_role,
    rationale: `校准处方回滚：${p.scenario_id} ${p.knob} 恢复为 ${JSON.stringify(p.from_value)}`,
    business_tier: 'HIGH', state: 'CONFIRMED',
  });

  await writeConf(back, dec.decision_id, by_id);
  await queryWrite(
    `UPDATE crm.calibration_patch SET status='ROLLED_BACK', resolved_by=$2, resolved_at=now() WHERE patch_id=$1`,
    [patch_id, by_id]);
  return { ok: true, decision_id: dec.decision_id, config: back };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/store.test.js`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/calibration/store.js test/calibration/store.test.js
git commit -m "feat(calibration-p1): 处方落库 + 第0闸审批/驳回/回滚"
```

---

## Task 7: 路由

**Files:**
- Create: `src/http/calibrationRouter.js`
- Modify: `src/http/routes.js`
- Test: `test/http/calibrationRouter.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/http/calibrationRouter.test.js — /api/calibration/*（sysadmin）
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import { createCalibrationRouter } from '../../src/http/calibrationRouter.js';

function makeApp(deps, role = 'sysadmin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.me = role ? { ok: true, role, username: 'u' } : null; next(); });
  app.use(createCalibrationRouter(deps));
  app.fetch = (path, opts = {}) => new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = require('http').request(
        { host: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers || {} },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => { server.close(); res.status = res.statusCode; res.json = async () => JSON.parse(data || '{}'); resolve(res); });
        });
      req.on('error', (e) => { server.close(); reject(e); });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  });
  return app;
}

const deps = {
  loadMetrics: async () => ({ sample_size: 0, sufficient_sample: false }),
  listPatches: async () => [],
  getPatch: async (id) => ({ patch_id: id, status: 'PENDING' }),
  approve: async () => ({ ok: true, decision_id: 'dec-1' }),
  reject: async () => ({ ok: true }),
  rollback: async () => ({ ok: true }),
  replayPreview: async () => ({ total: 0, autonomy: 0, escalated: 0 }),
};

describe('calibrationRouter', () => {
  it('非 sysadmin → 403', async () => {
    const app = makeApp(deps, 'sales');
    const res = await app.fetch('/api/calibration/metrics');
    expect(res.status).toBe(403);
  });

  it('未登录 → 401', async () => {
    const app = makeApp(deps, null);
    const res = await app.fetch('/api/calibration/metrics');
    expect(res.status).toBe(401);
  });

  it('sysadmin → 200 返回指标', async () => {
    const app = makeApp(deps);
    const res = await app.fetch('/api/calibration/metrics');
    expect(res.status).toBe(200);
    expect((await res.json()).sample_size).toBe(0);
  });

  it('POST approve → 200 且返回 decision_id', async () => {
    const app = makeApp(deps);
    const res = await app.fetch('/api/calibration/patches/p1/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).decision_id).toBe('dec-1');
  });
});
```

> 若 `require` 在 ESM 下不可用，改为顶部 `import http from 'node:http'` 并使用 `http.request`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/calibrationRouter.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现路由**

```js
// src/http/calibrationRouter.js — 决策校准端点（sysadmin）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7
import { Router } from 'express';
import { computeMetrics } from '../calibration/metrics.js';
import { replayScenario, replayConfidence } from '../calibration/replay.js';
import { attribute } from '../calibration/rules.js';
import {
  loadAutonomyConf, savePatches, listPatches, approvePatch, rejectPatch, rollbackPatch,
} from '../calibration/store.js';
import { listDecisions } from '../decision/decisionRepo.js';
import { resolveMe } from './auth.js';

const SYSADMIN = 'sysadmin';

async function defaultDeps_loadMetrics({ scenario_id, windowDays }) {
  const rows = await listDecisions({ scenario_id: scenario_id || null, limit: 500 });
  const cutoff = Date.now() - windowDays * 86400000;
  const inWindow = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);

  const metrics = computeMetrics(inWindow);
  const conf = await loadAutonomyConf();
  // 置信度是逐条属性：直接对每条历史决策复算后取均值
  const avg = inWindow.length
    ? inWindow.reduce((s, d) => s + replayConfidence(d, conf), 0) / inWindow.length
    : null;

  const att = attribute(metrics, {
    scenario_id: scenario_id || null,
    config: conf,
    decisions: inWindow,
    confidenceStats: avg == null
      ? null
      : { avg, threshold: conf.threshold, gap: Math.abs(avg - conf.threshold) },
  });
  return { metrics, ...att, avg_confidence: avg, window_days: windowDays };
}

export function createCalibrationRouter({ deps = {} } = {}) {
  const D = {
    loadMetrics: defaultDeps_loadMetrics,
    listPatches, savePatches, approvePatch, rejectPatch, rollbackPatch,
    replayScenario, loadAutonomyConf,
    ...deps,
  };
  const router = Router();

  const guard = (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) { res.status(401).json({ error: '未登录' }); return null; }
    if (me.role !== SYSADMIN) { res.status(403).json({ error: '需要 sysadmin' }); return null; }
    return me;
  };

  router.get('/api/calibration/metrics', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const scenario_id = req.query.scenario_id || null;
      const windowDays = Number(req.query.window_days) || 30;
      res.json(await D.loadMetrics({ scenario_id, windowDays }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get('/api/calibration/patches', async (req, res) => {
    if (!guard(req, res)) return;
    try { res.json({ patches: await D.listPatches({ status: req.query.status || null }) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get('/api/calibration/replay', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const conf = await D.loadAutonomyConf();
      const next = { threshold: req.query.threshold ? Number(req.query.threshold) : conf.threshold, weights: { ...conf.weights } };
      for (const k of ['similarity', 'coverage', 'method', 'allMet']) {
        if (req.query[k] != null) next.weights[k] = Number(req.query[k]);
      }
      const rows = await listDecisions({ scenario_id: req.query.scenario_id || null, limit: 500 });
      res.json({ current: D.replayScenario(rows, conf), candidate: D.replayScenario(rows, next), candidate_conf: next });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/api/calibration/patches/:id/approve', async (req, res) => {
    const me = guard(req, res); if (!me) return;
    try {
      const r = await D.approvePatch(req.params.id, { by_id: me.username, by_role: me.role });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/api/calibration/patches/:id/reject', async (req, res) => {
    const me = guard(req, res); if (!me) return;
    try {
      const r = await D.rejectPatch(req.params.id, { by_id: me.username });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/api/calibration/patches/:id/rollback', async (req, res) => {
    const me = guard(req, res); if (!me) return;
    try {
      const r = await D.rollbackPatch(req.params.id, { by_id: me.username, by_role: me.role });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}
```

> `replayConfidence` 逐条复算后取均值，是"平均置信度"的唯一正确算法——不要用 `replayScenario([d], conf)` 的返回值去反推置信度（它只返回自主/升级计数）。

- [ ] **Step 4: 挂载**

在 `src/http/routes.js` 顶部 import 区追加：

```js
import { createCalibrationRouter } from './calibrationRouter.js';
```

在 `app.use(createWorkbenchRouter({}));`（`routes.js:1433`）之前插入：

```js
  app.use(createCalibrationRouter({}));
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/calibrationRouter.test.js`
Expected: 4 passed

> **`routes.js` 改动需重启 server 才生效。**

- [ ] **Step 6: Commit**

```bash
git add src/http/calibrationRouter.js src/http/routes.js test/http/calibrationRouter.test.js
git commit -m "feat(calibration-p1): /api/calibration/* 端点（sysadmin + 第0闸）"
```

---

## Task 8: 全量回归与验收

- [ ] **Step 1: 跑全量**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 无新增失败（基线 1107 例 / 1099 通过 / 6 失败，6 条均为既有问题且与本计划无关）

- [ ] **Step 2: 验收口径逐条核对**

```bash
# 1) 样本不足时不出方
curl -s -H "authorization: Bearer <sysadmin-token>" \
  'http://127.0.0.1:3000/api/calibration/metrics?scenario_id=QUOTE_PRICING&window_days=30' | head -c 400
# 期望：patches=[] 且 blocked_by[0].rule_id='R6'（真实库样本通常不足 20）

# 2) 影子重放预览可用
curl -s -H "authorization: Bearer <sysadmin-token>" \
  'http://127.0.0.1:3000/api/calibration/replay?scenario_id=QUOTE_PRICING&threshold=0.9'
# 期望：返回 current / candidate 两组分布，且 candidate.escalated >= current.escalated

# 3) 非 sysadmin 被拦
curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer <sales-token>" \
  'http://127.0.0.1:3000/api/calibration/metrics'
# 期望：403
```

- [ ] **Step 3: Commit（若有修补）**

```bash
git add -A
git commit -m "fix(calibration-p1): 回归修补"
```

---

## 自检清单

- [x] 覆盖设计 §4（度量）、§5（归因，含 R5/R6 守卫）、§6（影子重放）、§7（端点）、§2.2–§2.4（表与种子）
- [x] 决策来源以 `decider_type` 判定（避开 P0 后 `state` 变更导致的指标恒零陷阱）
- [x] 重放准确性有对 `decision_event.payload.confidence` 的硬校验（误差 < 1e-6）
- [x] 配置外置有 parity 测试锁死缺省行为
- [x] 处方生命周期完整（PENDING → APPLIED / REJECTED → ROLLED_BACK），每步走第0闸
- [x] 每个 Task 自带测试与 commit
