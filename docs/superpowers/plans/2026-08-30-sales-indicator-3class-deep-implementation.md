# 指标三分类深入落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 sales-thresholds 13 键 + 阶段闸 + 商机三要素全部落入 A（预警）/B（展示）/C（控制）三分类，零新增阈值键，全部阈值仍走 `config_store['sales-thresholds']`。

**Architecture:** A 类=写事件+每日巡检双轨（复用 timers 30 分钟巡检模式，只读+告警不写粒子）；B 类=boardSummary 已注入 cov* 六键，本轮只做前端消费 + 修 2 处硬编码 80；C 类=executor STAGE_GATES P4→P5/P5→P6 升级 hard + 新增商机三要素闸（读 bantcc.*）。

**Tech Stack:** Node 22 + ESM + vitest 3（PGDATABASE=plm_test 单进程）+ PostgreSQL 16（复用 plm 实例 @5433）。

**设计文档**：`docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md`（用户已批准 2026-08-30）

**关键既有代码锚点**（实现前必读）：
- `src/sales/salesThresholds.js` — `readThreshold(cfg,path,fallback)` / `DEFAULT_THRESHOLDS` / `deriveRhythmDays`
- `src/sales/namedAccountBoard.js` — `boardSummary` 已注入 cov* 六键 + `covVisitsOk/covWeekVisitsOk/covCustomerOk`（2026-08-30 A-D 接线产物）
- `src/sales/funnelQuality.js` — `funnelHealth` / `commitAccuracy` / `jitterRate` / `salesPotential`
- `src/alerts/ruleEvaluator.js` — `evaluateAlertRule(rule,event)` 只支持 4 类 metric（stuck/overdue/due/breach），**本轮扩展**
- `src/alerts/alertRegistry.js` — `DEFAULT_RULES` + `cloneRule` + `evaluateForEvent`
- `src/alerts/alertStore.js` — `createAlert({kind,severity,target_role,particle_id,payload})`
- `src/scheduler/timers.js` — `ensureTimers` 已有 lead-pool-recycle 30min 巡检模式（只读+emit，不写粒子）
- `src/action/executor.js` — `STAGE_GATES`（第 3.5 闸）+ 写通道第 0 闸（decision_id）
- `src/pages/S02.schema.js` — 首页作战室 schema（collapse + kpi-strip + progress-card）
- `src/web/named-accounts.html` — `renderKpis(summary)` + `renderBehaviorCard` + `renderBoard`（21 条两处 `>= 80` 硬编码）
- `src/http/routes.js:756` — 首页 21 条合格率 `>= 80` 硬编码

---

### Task 1: ruleEvaluator 扩展 指标分支（A 类基础）

**Files:**
- Modify: `src/alerts/ruleEvaluator.js`
- Test: `test/alerts/ruleEvaluator-sales.test.js`（新建）

**背景**：评估器目前只认识 `stuck_days/overdue_days/due_days/breach_pct` 四种 metric。A 类 9 项指标（覆盖率/流失/漏斗健康/抖动/承诺/拜访达标/信息收集）需要新增 metric 分支，否则规则命中永远 false。

- [ ] **Step 1: 写失败测试** `test/alerts/ruleEvaluator-sales.test.js`

```js
import { describe, it, expect } from 'vitest';
import { evaluateAlertRule } from '../../src/alerts/ruleEvaluator.js';

describe('ruleEvaluator 指标分支', () => {
  it('coverage_gap：目标客户超 target_days 未拜访 -> hit', () => {
    const rule = { kind: 'coverage_gap', enabled: true, match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { target_days: 30, potential_days: 90 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { tier: 'target', daysSinceVisit: 45, windowDays: 30 } });
    expect(hit.hit).toBe(true);
    expect(hit.payload.tier).toBe('target');
  });
  it('coverage_gap：潜力客户超 potential_days -> hit', () => {
    const rule = { kind: 'coverage_gap', enabled: true, match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { target_days: 30, potential_days: 90 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { tier: 'potential', daysSinceVisit: 120, windowDays: 90 } });
    expect(hit.hit).toBe(true);
  });
  it('coverage_gap：达标不命中', () => {
    const rule = { kind: 'coverage_gap', enabled: true, match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { target_days: 30, potential_days: 90 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { tier: 'target', daysSinceVisit: 10, windowDays: 30 } });
    expect(hit.hit).toBe(false);
  });
  it('lost_contact：无拜访超 lost_days -> hit', () => {
    const rule = { kind: 'lost_contact', enabled: true, match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { lost_days: 90 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { daysSinceVisit: 100 } });
    expect(hit.hit).toBe(true);
  });
  it('funnel_unhealthy：销售潜力低于 health_min -> hit', () => {
    const rule = { kind: 'funnel_unhealthy', enabled: true, match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan'] }, check_params: { health_min: 1.0 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_DEAL', action: 'daily_scan', metric: { salesPotential: 0.7 } });
    expect(hit.hit).toBe(true);
  });
  it('commit_red：承诺准确率低于 yellow_low -> hit', () => {
    const rule = { kind: 'commit_red', enabled: true, match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan'] }, check_params: { yellow_low: 0.8 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_DEAL', action: 'daily_scan', metric: { commitRate: 0.55 } });
    expect(hit.hit).toBe(true);
  });
  it('visit_shortfall：当日拜访低于 daily_target -> hit', () => {
    const rule = { kind: 'visit_shortfall', enabled: true, match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { daily_target: 3, weekly_target: 15 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { dailyVisits: 1, weeklyVisits: 8 } });
    expect(hit.hit).toBe(true);
  });
  it('info_collect_lag：周新增客户低于 weekly_min -> hit', () => {
    const rule = { kind: 'info_collect_lag', enabled: true, match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { weekly_min: 5 } };
    const hit = evaluateAlertRule(rule, { particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { weekNew: 2 } });
    expect(hit.hit).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/alerts/ruleEvaluator-sales.test.js`
Expected: FAIL（8 例全红，evaluateAlertRule 不认识新 metric）

- [ ] **Step 3: 最小实现** `src/alerts/ruleEvaluator.js`（在 `breach_pct` 分支之后追加）

```js
  // 指标分支（2026-08-30 三分类 A 类）——覆盖/流失/漏斗健康/承诺/拜访达标/信息收集
  // 阈值出厂商建议在 alertRegistry DEFAULT_RULES.check_params；运行时被 config_store['sales-thresholds'] 覆盖（同 financeAlertHook 动态读）
  if (params.target_days != null && typeof metric.daysSinceVisit === 'number' && metric.tier) {
    const need = metric.tier === 'target' ? params.target_days : params.potential_days;
    if (need != null && metric.daysSinceVisit >= need) {
      payload.tier = metric.tier;
      payload.daysSinceVisit = metric.daysSinceVisit;
      payload.threshold = need;
      return { hit: true, payload };
    }
  }

  if (params.lost_days != null && typeof metric.daysSinceVisit === 'number' && !metric.tier) {
    if (metric.daysSinceVisit >= params.lost_days) {
      payload.daysSinceVisit = metric.daysSinceVisit;
      payload.threshold = params.lost_days;
      return { hit: true, payload };
    }
  }

  if (params.health_min != null && typeof metric.salesPotential === 'number') {
    if (metric.salesPotential < params.health_min) {
      payload.salesPotential = metric.salesPotential;
      payload.threshold = params.health_min;
      return { hit: true, payload };
    }
  }

  if (params.yellow_low != null && typeof metric.commitRate === 'number') {
    if (metric.commitRate < params.yellow_low) {
      payload.commitRate = metric.commitRate;
      payload.threshold = params.yellow_low;
      return { hit: true, payload };
    }
  }

  if (params.daily_target != null && typeof metric.dailyVisits === 'number') {
    if (metric.dailyVisits < params.daily_target || (params.weekly_target != null && metric.weeklyVisits < params.weekly_target)) {
      payload.dailyVisits = metric.dailyVisits;
      payload.weeklyVisits = metric.weeklyVisits;
      payload.threshold = { daily: params.daily_target, weekly: params.weekly_target };
      return { hit: true, payload };
    }
  }

  if (params.weekly_min != null && typeof metric.weekNew === 'number') {
    if (metric.weekNew < params.weekly_min) {
      payload.weekNew = metric.weekNew;
      payload.threshold = params.weekly_min;
      return { hit: true, payload };
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/alerts/ruleEvaluator-sales.test.js`
Expected: PASS（8/8）

- [ ] **Step 5: 提交**

```bash
git add src/alerts/ruleEvaluator.js test/alerts/ruleEvaluator-sales.test.js
git commit -m "feat(alerts): ruleEvaluator 扩展 指标分支（覆盖/流失/漏斗健康/承诺/拜访/信息收集）"
```

---

### Task 2: alertRegistry 新增 4 条 预警规则

**Files:**
- Modify: `src/alerts/alertRegistry.js`
- Test: `test/alerts/alertRegistry-sales.test.js`（新建）

- [ ] **Step 1: 写失败测试** `test/alerts/alertRegistry-sales.test.js`

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { listAlertRules, evaluateForEvent, resetAlertRegistry } from '../../src/alerts/alertRegistry.js';

beforeEach(() => resetAlertRegistry());

describe('alertRegistry 规则', () => {
  it('注册 4 条新规则（coverage_gap/lost_contact/funnel_unhealthy/commit_red）', () => {
    const kinds = listAlertRules().map(r => r.kind);
    expect(kinds).toContain('coverage_gap');
    expect(kinds).toContain('lost_contact');
    expect(kinds).toContain('funnel_unhealthy');
    expect(kinds).toContain('commit_red');
  });
  it('出厂建议值正确', () => {
    const cov = listAlertRules().find(r => r.kind === 'coverage_gap');
    expect(cov.check_params.target_days).toBe(30);
    expect(cov.check_params.potential_days).toBe(90);
    const loss = listAlertRules().find(r => r.kind === 'lost_contact');
    expect(loss.check_params.lost_days).toBe(90);
    const fh = listAlertRules().find(r => r.kind === 'funnel_unhealthy');
    expect(fh.check_params.health_min).toBe(1.0);
    const cr = listAlertRules().find(r => r.kind === 'commit_red');
    expect(cr.check_params.yellow_low).toBe(0.8);
  });
  it('evaluateForEvent 命中 coverage_gap', () => {
    const hits = evaluateForEvent({ particleType: 'CRM_ACCOUNT', action: 'daily_scan', metric: { tier: 'target', daysSinceVisit: 40 } });
    expect(hits.some(h => h.rule.kind === 'coverage_gap')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/alerts/alertRegistry-sales.test.js`
Expected: FAIL（4 条规则未注册 → toContain 红）

- [ ] **Step 3: 最小实现** `src/alerts/alertRegistry.js`（`DEFAULT_RULES` 数组 `payment_due_plan` 之后追加 4 条）

```js
  {
    // 2026-08-30 三分类 A 类：目标/潜力客户覆盖缺口（时间推移型，daily_scan 巡检触发）
    kind: 'coverage_gap',
    match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
    check_params: { target_days: 30, potential_days: 90 }, // 出厂建议；运行时覆盖 sales-thresholds.coverage.*
    severity: 'medium',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
  {
    // 接触流失警戒：>90 天无拜访 → 大概率流失
    kind: 'lost_contact',
    match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
    check_params: { lost_days: 90 },
    severity: 'high',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
  {
    // 漏斗不健康：销售潜力 < 1.0
    kind: 'funnel_unhealthy',
    match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] },
    check_params: { health_min: 1.0 },
    severity: 'high',
    target_role: 'exec',
    enabled: true,
    version: 1,
  },
  {
    // 承诺准确率红带：< 0.8
    kind: 'commit_red',
    match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] },
    check_params: { yellow_low: 0.8 },
    severity: 'medium',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
```

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/alerts/alertRegistry-sales.test.js`
Expected: PASS（3/3）

- [ ] **Step 5: 提交**

```bash
git add src/alerts/alertRegistry.js test/alerts/alertRegistry-sales.test.js
git commit -m "feat(alerts): alertRegistry 新增 4 条 预警规则（覆盖/流失/漏斗健康/承诺红）"
```

---

### Task 3: salesDailyScan 巡检器（纯函数，只读+告警）

**Files:**
- Create: `src/scheduler/salesDailyScan.js`
- Test: `test/scheduler/salesDailyScan.test.js`（新建）

**职责**：输入 accounts/deals/targetsCfg/thresholds → 输出命中告警清单（不落库、不写粒子，由 timers 调度壳负责 createAlert）。纯函数便于单测。

- [ ] **Step 1: 写失败测试** `test/scheduler/salesDailyScan.test.js`

```js
import { describe, it, expect } from 'vitest';
import { salesDailyScan } from '../../src/scheduler/salesDailyScan.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const targetAccount = (id, lastVisit) => ({ id, type: 'CRM_ACCOUNT', payload: { name: id, tier: '目标', visit_notes: lastVisit ? [{ at: daysAgo(lastVisit) }] : [] } });
const potentialAccount = (id, lastVisit) => ({ id, type: 'CRM_ACCOUNT', payload: { name: id, tier: '潜力', visit_notes: lastVisit ? [{ at: daysAgo(lastVisit) }] : [] } });
const deal = (id, payload) => ({ id, type: 'CRM_DEAL', payload });

describe('salesDailyScan 巡检器', () => {
  it('目标客户超 30 天未拜访 -> coverage_gap', () => {
    const hits = salesDailyScan({ accounts: [targetAccount('a1', 45)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'coverage_gap' && h.metric.tier === 'target')).toBe(true);
  });
  it('潜力客户超 90 天未拜访 -> coverage_gap', () => {
    const hits = salesDailyScan({ accounts: [potentialAccount('a2', 120)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'coverage_gap' && h.metric.tier === 'potential')).toBe(true);
  });
  it('无拜访超 90 天 -> lost_contact', () => {
    const hits = salesDailyScan({ accounts: [targetAccount('a3', 100)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'lost_contact')).toBe(true);
  });
  it('漏斗不健康：销售潜力 0.6 -> funnel_unhealthy', () => {
    const deals = [deal('d1', { expected_amount: 600, forecast_class: '确保', st: { probability: 0.8 } })];
    const hits = salesDailyScan({ accounts: [], deals, thresholds: mergedThresholds({}), annualTarget: 1000, closedAmount: 0 });
    expect(hits.some(h => h.kind === 'funnel_unhealthy')).toBe(true);
  });
  it('承诺准确率 0.55 -> commit_red', () => {
    const deals = [deal('d2', { committed: { amount: 1000 }, actual_amount: 550 })];
    const hits = salesDailyScan({ accounts: [], deals, thresholds: mergedThresholds({}), annualTarget: 1000 });
    expect(hits.some(h => h.kind === 'commit_red')).toBe(true);
  });
  it('达标不告警', () => {
    const hits = salesDailyScan({ accounts: [targetAccount('a4', 5)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.length).toBe(0);
  });
  it('阈值随配置变化：target_days 配 60 -> 45 天不告警', () => {
    const thresholds = mergedThresholds({ coverage: { target_month_days: 60 } });
    const hits = salesDailyScan({ accounts: [targetAccount('a5', 45)], deals: [], thresholds });
    expect(hits.some(h => h.kind === 'coverage_gap')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/scheduler/salesDailyScan.test.js`
Expected: FAIL（模块不存在 → import 红）

- [ ] **Step 3: 最小实现** `src/scheduler/salesDailyScan.js`

```js
// src/scheduler/salesDailyScan.js — 三分类 A 类巡检纯函数（只读 + 产出告警清单，不写粒子）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.2
// 铁律：巡检只读 + 产出告警；处置由 crm-* 写 Action 显式触发（对齐 07 文档 §5-2，定时扫描直接写粒子即违 D4 反模式）
import { readThreshold, mergedThresholds } from '../sales/salesThresholds.js';
import { deriveRhythmDays } from '../sales/salesThresholds.js';
import { funnelHealth, commitAccuracy, salesPotential } from '../sales/funnelQuality.js';

function lastVisitAt(p) {
  const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
  if (!notes.length) return null;
  const ts = notes.map(n => (n?.at ? new Date(n.at).getTime() : NaN)).filter(t => !Number.isNaN(t));
  return ts.length ? Math.max(...ts) : null;
}
function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}
const tierOf = (p) => String(p?.tier || p?.tier_type || '潜力');

/**
 * 巡检主函数（纯函数，零 DB）：
 * @param {object} opts
 *   accounts   - CRM_ACCOUNT 粒子数组
 *   deals      - CRM_DEAL 粒子数组
 *   thresholds - mergedThresholds 输出（缺省回退出厂默认）
 *   annualTarget / closedAmount - 漏斗健康性输入（缺省 0 → 不判漏斗）
 * @returns {Array} 命中清单 [{ kind, particle_id, metric, severity }]
 */
export function salesDailyScan({ accounts = [], deals = [], thresholds = null, annualTarget = 0, closedAmount = 0 } = {}) {
  const th = thresholds || mergedThresholds({});
  const rhythm = deriveRhythmDays(null, th); // coverage 显式 ≠ 默认时优先；否则 id30/默认
  const targetDays = readThreshold(th, 'coverage.target_month_days', 30);
  const potentialDays = readThreshold(th, 'coverage.potential_quarter_days', 90);
  const lostDays = readThreshold(th, 'coverage.lost_contact_days', 90);
  const dailyTarget = readThreshold(th, 'coverage.daily_visits_target', 3);
  const weeklyTarget = readThreshold(th, 'coverage.weekly_visits_target', 15);
  const weeklyMin = readThreshold(th, 'coverage.info_collect_weekly', 5);
  const hits = [];

  // 覆盖/流失/拜访达标/信息收集（账户级）
  const week0 = Date.now() - 6 * 86400000;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  let dailyVisits = 0, weekVisits = 0, weekNew = 0;
  for (const a of accounts) {
    const p = a?.payload || {};
    const tier = tierOf(p);
    const last = lastVisitAt(p);
    const ds = daysSince(last);
    if (tier === '目标' && ds != null && ds >= targetDays) {
      hits.push({ kind: 'coverage_gap', particle_id: a.id, metric: { tier: 'target', daysSinceVisit: ds, windowDays: targetDays }, severity: 'medium' });
    }
    if (tier === '潜力' && ds != null && ds >= potentialDays) {
      hits.push({ kind: 'coverage_gap', particle_id: a.id, metric: { tier: 'potential', daysSinceVisit: ds, windowDays: potentialDays }, severity: 'medium' });
    }
    if (ds != null && ds >= lostDays) {
      hits.push({ kind: 'lost_contact', particle_id: a.id, metric: { daysSinceVisit: ds, threshold: lostDays }, severity: 'high' });
    }
    const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
    for (const n of notes) {
      const t = n?.at ? new Date(n.at).getTime() : NaN;
      if (Number.isNaN(t)) continue;
      if (t >= today0.getTime() && n?.type !== 'call') dailyVisits++;
      if (t >= week0) weekVisits++;
    }
    const ca = a.created_at ? new Date(a.created_at).getTime() : NaN;
    if (!Number.isNaN(ca) && ca >= week0) weekNew++;
  }
  if (accounts.length && dailyVisits < dailyTarget) {
    hits.push({ kind: 'visit_shortfall', particle_id: null, metric: { dailyVisits, weeklyVisits: weekVisits, threshold: { daily: dailyTarget, weekly: weeklyTarget } }, severity: 'medium' });
  }
  if (accounts.length && weekVisits < weeklyTarget) {
    hits.push({ kind: 'visit_shortfall', particle_id: null, metric: { dailyVisits, weeklyVisits: weekVisits, threshold: { daily: dailyTarget, weekly: weeklyTarget } }, severity: 'medium' });
  }
  if (accounts.length && weekNew < weeklyMin) {
    hits.push({ kind: 'info_collect_lag', particle_id: null, metric: { weekNew, threshold: weeklyMin }, severity: 'low' });
  }

  // 漏斗健康/承诺（商机级，annualTarget>0 才判）
  if (annualTarget > 0 && deals.length) {
    const potential = salesPotential(deals, annualTarget, closedAmount, th);
    if (!funnelHealth(potential, th)) {
      hits.push({ kind: 'funnel_unhealthy', particle_id: null, metric: { salesPotential: potential, threshold: readThreshold(th, 'funnel.health_min_ratio', 1.0) }, severity: 'high' });
    }
    for (const d of deals) {
      const p = d?.payload || {};
      const promised = Number(p?.committed?.amount || 0);
      const actual = Number(p?.actual_amount || 0);
      if (promised > 0) {
        const { rate } = commitAccuracy(promised, actual, th);
        if (rate < readThreshold(th, 'funnel.commit.yellow_low', 0.8)) {
          hits.push({ kind: 'commit_red', particle_id: d.id, metric: { commitRate: rate, threshold: readThreshold(th, 'funnel.commit.yellow_low', 0.8) }, severity: 'medium' });
        }
      }
    }
  }

  // 漏斗抖动（jitterRate 由巡检计算，baseline 由 applyBaselineSnapshot 提供）
  return hits;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/scheduler/salesDailyScan.test.js`
Expected: PASS（7/7）

- [ ] **Step 5: 提交**

```bash
git add src/scheduler/salesDailyScan.js test/scheduler/salesDailyScan.test.js
git commit -m "feat(scheduler): salesDailyScan 巡检纯函数（覆盖/流失/漏斗健康/承诺/拜访/信息收集）"
```

---

### Task 4: timers 注册 sales-daily-scan 定时器（调度壳）

**Files:**
- Modify: `src/scheduler/timers.js`
- Test: `test/scheduler/timers-sales.test.js`（新建）

**职责**：ensureTimers 注册 sales-daily-scan（30 分钟粒度，与 lead-pool-recycle 同款：只读 → createAlert 落库 → emit('alert') SSE）；salesDailyScan 产出告警清单 → 逐条 createAlert。

- [ ] **Step 1: 写失败测试** `test/scheduler/timers-sales.test.js`

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureTimers, clearTimers, timerCount } from '../../src/scheduler/timers.js';
import { resetAlertStore, listAlerts } from '../../src/alerts/alertStore.js';
import { resetAlertRegistry } from '../../src/alerts/alertRegistry.js';

beforeEach(() => { resetAlertStore(); resetAlertRegistry(); });
afterEach(() => clearTimers());

describe('timers sales-daily-scan', () => {
  it('ensureTimers 注册 sales-daily-scan', () => {
    ensureTimers();
    expect(timerCount()).toBeGreaterThanOrEqual(4);
  });
  it('salesDailyScan 命中 -> createAlert 落库（目标客户超期）', async () => {
    // 直接调巡检器验证落库链路（定时器回调不易在单测触发，链路用纯函数 + createAlert 组合验证）
    const { salesDailyScan } = await import('../../src/scheduler/salesDailyScan.js');
    const { mergedThresholds } = await import('../../src/sales/salesThresholds.js');
    const { createAlert } = await import('../../src/alerts/alertStore.js');
    const hits = salesDailyScan({
      accounts: [{ id: 'a1', payload: { tier: '目标', visit_notes: [{ at: new Date(Date.now() - 45 * 86400000).toISOString() }] } }],
      deals: [], thresholds: mergedThresholds({}),
    });
    for (const h of hits) createAlert({ kind: h.kind, severity: h.severity, target_role: 'sales', particle_id: h.particle_id, payload: h.metric });
    const alerts = listAlerts();
    expect(alerts.some(a => a.kind === 'coverage_gap')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/scheduler/timers-sales.test.js`
Expected: FAIL（第 1 例 timerCount 期望 ≥4，实际 3——sales-daily-scan 未注册）

- [ ] **Step 3: 最小实现** `src/scheduler/timers.js`（`lead-pool-recycle` 注册之后追加 sales-daily-scan）

```js
  // ⑤ 三分类 A 类巡检（2026-08-30）：每 30 分钟扫一次覆盖/流失/漏斗健康/承诺红/拜访达标/信息收集
  //    只读 + createAlert 落库 + emit('alert') SSE；不做跨粒子写（处置走 crm-* 写 Action，对齐 07 文档 §5-2）
  //    阈值经 config_store['sales-thresholds']，巡检器读 mergedThresholds（客户可后台直调）
  const salesScan = setInterval(() => {
    (async () => {
      const { salesDailyScan } = await import('./salesDailyScan.js');
      const { createAlert } = await import('../alerts/alertStore.js');
      const { mergedThresholds } = await import('../sales/salesThresholds.js');
      const [accRes, dealRes] = await Promise.all([
        query(`SELECT id, payload, created_at FROM crm.particles WHERE type='CRM_ACCOUNT'`),
        query(`SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL'`),
      ]);
      const thresholds = mergedThresholds(
        await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`)
          .then(r => r.rows[0]?.value || {}).catch(() => ({}))
      );
      // 年度任务/已下单金额（漏斗健康输入；缺省不判漏斗）
      const annualTarget = Number(
        await query(`SELECT value FROM crm.config_store WHERE key='named-account-targets'`)
          .then(r => r.rows[0]?.value?.annual_target || 0).catch(() => 0)
      ) || 0;
      const hits = salesDailyScan({
        accounts: accRes.rows, deals: dealRes.rows, thresholds, annualTarget,
      });
      for (const h of hits) {
        const a = createAlert({ kind: h.kind, severity: h.severity, target_role: h.severity === 'high' ? 'exec' : 'sales', particle_id: h.particle_id, payload: h.metric });
        if (a.ok) emit('alert', h.kind, { alert: a.alert.id ?? a.alert.alert_id, kind: h.kind, metric: h.metric });
      }
      if (hits.length) emit('trace', 'sales-daily-scan', { scanned: accRes.rows.length + dealRes.rows.length, hits: hits.length });
    })().catch((err) => {
      emit('trace', 'sales-daily-scan-failed', { error: String(err?.message || err) });
      recordFailure('sales-daily-scan-failed', err);
    });
  }, 1800000);
  timers.set('sales-daily-scan', { handle: salesScan, intervalMs: 1800000, kind: 'rule', registeredAt: now });
```

（`createAlert` 返回 `{ok, alert}`，alert 对象含 `alert_id`——参考上文 alertStore.js:31）

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/scheduler/timers-sales.test.js`
Expected: PASS（2/2）

- [ ] **Step 5: 提交**

```bash
git add src/scheduler/timers.js test/scheduler/timers-sales.test.js
git commit -m "feat(scheduler): timers 注册 sales-daily-scan（30min 只读巡检 → createAlert + SSE）"
```

---

### Task 5: executor STAGE_GATES P4→P5/P5→P6 升级 hard + 商机三要素闸 C6

**Files:**
- Modify: `src/action/executor.js`
- Test: `test/action/executor-gate-hard.test.js`（新建）

**背景**：STAGE_GATES 里 P4→P5/P5→P6 目前 `hard:false`（soft，缺口转 warnings）；本轮升级 `hard:true`（缺口转 gaps → 拦截）。C6 商机三要素闸：`data-particle-create` + CRM_DEAL + 非 lead → 校验 `bantcc.*` 三维（budget/authority/timetable）。

- [ ] **Step 1: 写失败测试** `test/action/executor-gate-hard.test.js`

```js
import { describe, it, expect } from 'vitest';
import { salesStageGate } from '../../src/action/executor.js';

describe('executor C4/C5 hard 升级', () => {
  it('P4→P5 无 review-gate 通过且无合同事实 -> 拦截（hard）', () => {
    const r = salesStageGate({ curStage: 'P4', toStage: 'P5', dealPayload: {} });
    expect(r.ok).toBe(false);
    expect(r.gaps.some(g => g.includes('review-gate'))).toBe(true);
  });
  it('P4→P5 有签署事实 -> 放行（证据兜底）', () => {
    const r = salesStageGate({ curStage: 'P4', toStage: 'P5', dealPayload: { contract_no: 'HT-001' } });
    expect(r.ok).toBe(true);
  });
  it('P5→P6 无合同/全款 -> 拦截（hard）', () => {
    const r = salesStageGate({ curStage: 'P5', toStage: 'P6', dealPayload: {} });
    expect(r.ok).toBe(false);
  });
  it('P5→P6 有合同+全款 -> 放行', () => {
    const r = salesStageGate({ curStage: 'P5', toStage: 'P6', dealPayload: { contract_no: 'HT-001', signed_at: '2026-08-01', paid_at: '2026-08-15' } });
    expect(r.ok).toBe(true);
  });
});

describe('executor C6 商机三要素闸', () => {
  it('data-particle-create CRM_DEAL 非 lead 缺三要素 -> 拦截', async () => {
    const { actionExecutor } = await import('../../src/action/executor.js');
    const r = await actionExecutor.dispatch('data-particle-create', {
      type: 'CRM_DEAL', payload: { name: '测试商机', stage: 'P1' },
    }, { tenantId: 'system', actor: 'alice', bootstrap: true, decision_id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_deal_prereq');
  });
  it('data-particle-create CRM_DEAL 三要素齐全 -> 放行', async () => {
    const { actionExecutor } = await import('../../src/action/executor.js');
    const r = await actionExecutor.dispatch('data-particle-create', {
      type: 'CRM_DEAL', payload: { name: '测试商机', stage: 'P1', bantcc: { budget_ok: true, authority_ok: true, timetable_ok: true } },
    }, { tenantId: 'system', actor: 'alice', bootstrap: true, decision_id: 'x' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/action/executor-gate-hard.test.js`
Expected: FAIL（P4→P5/P5→P6 目前 soft → ok:true；C6 未实现）

- [ ] **Step 3: 最小实现** `src/action/executor.js`

**3a. STAGE_GATES P4→P5/P5→P6 `hard:false → hard:true`**（两处，check 函数不变）

找到：
```js
    from: 'P4', to: 'P5', hard: false,
```
改为：
```js
    from: 'P4', to: 'P5', hard: true, // 2026-08-30 三分类 C 类：证据缺口硬拦（review-gate/合同事实任一存在即放行）
```

找到：
```js
    from: 'P5', to: 'P6', hard: false,
```
改为：
```js
    from: 'P5', to: 'P6', hard: true, // 2026-08-30 三分类 C 类：合同+全款未落事实硬拦
```

**3b. 新增 C6 商机三要素闸**（`dispatch` 方法内，`crm-deal-advance` 第 3.5 闸块之后追加）

```js
    // 写通道第 3.6 闸（2026-08-30 三分类 C 类 C6）：商机创建三要素闸
    // 触发：data-particle-create + CRM_DEAL + 非 lead 阶段
    // 校验 bantcc.* 三维（budget/authority/timetable，与 P3→P4 闸同源字段）；兼容 ai.bantcc_completeness 已评估
    if (def.name === 'data-particle-create' && !ctx.bootstrap
        && (params?.type === 'CRM_DEAL' || params?.particle_type === 'CRM_DEAL')) {
      const payload = params?.payload || {};
      const stage = payload.stage || payload.state || 'lead';
      if (stage !== 'lead' && stage !== '线索') {
        const b = payload.bantcc || {};
        const aiComp = Number(payload.ai?.bantcc_completeness?.value ?? 0);
        const bOk = b.budget_ok === true || b.budget != null && String(b.budget) !== '';
        const aOk = b.authority_ok === true || b.authority != null && String(b.authority) !== '';
        const tOk = b.timetable_ok === true || b.schedule != null || b.timeline != null;
        const pass = readThreshold(thresholdsForGate(ctx), 'bantcc.pass', 0.6);
        const essentialsOk = (bOk && aOk && tOk) || aiComp >= pass;
        if (!essentialsOk) {
          const missing = [];
          if (!bOk) missing.push('预算');
          if (!aOk) missing.push('责任人');
          if (!tOk) missing.push('时间表');
          emit('trace', 'sales-deal-prereq-blocked', { action: actionName, actor: ctx.actor, missing });
          return { ok: false, gate: 'sales_deal_prereq', error: `商机三要素缺失（${missing.join('/')}）` };
        }
      }
    }
```

> 注：`thresholdsForGate(ctx)` 需先在函数内定义（读 config_store 的 sales-thresholds，可失败回退 DEFAULT_THRESHOLDS）——若 executor 已 import `query`，直接内联查询；实现时可仿照现有 `readThreshold(th,'bantcc.pass')` 的调用方式传 `DEFAULT_THRESHOLDS` 兜底。**简化建议**：本轮 C6 直接用 `readThreshold(DEFAULT_THRESHOLDS,'bantcc.pass',0.6)`（出厂默认 0.6；配置化读取留待 routes 层注入 thresholds 时接入，避免 executor 异步查库增加复杂度）。

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/action/executor-gate-hard.test.js`
Expected: PASS（6/6）

**回归**：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/action/sales-executor-gate.test.js`
Expected: PASS（原 16 例 P4→P5 soft 断言需同步改 hard——见**注意事项**）

> ⚠️ **回归注意**：`test/action/sales-executor-gate.test.js` 原有 P4→P5/P5→P6 的 soft 断言（期望 `ok:true` + warnings），本轮升级 hard 后这些用例会红。**必须在同一 Task 内同步更新**：把「无证据 → 期望 ok:false + gaps」、把「有证据 → 期望 ok:true」。这是行为变更（非 bug），测试需随语义更新。

- [ ] **Step 5: 提交**

```bash
git add src/action/executor.js test/action/executor-gate-hard.test.js test/action/sales-executor-gate.test.js
git commit -m "feat(executor): STAGE_GATES P4→P5/P5→P6 升级 hard + 商机三要素闸 C6"
```

---

### Task 6: S02 schema 新增「标准达标」区（B 类展示）

**Files:**
- Modify: `src/pages/S02.schema.js`
- Test: `test/pages/S02-sales-standard.test.js`（新建）

**背景**：S02 首页 My Behavior collapse 现有 4 个 progress-card（今日拜访/今日电话/本周拜访客户/本周新客户，走 id31 个人目标）。本轮新增「标准达标」区，展示 cov* 六键（走 sales-thresholds 出厂标准）。

- [ ] **Step 1: 写失败测试** `test/pages/S02-sales-standard.test.js`

```js
import { describe, it, expect } from 'vitest';
import { schema as s02 } from '../../src/pages/S02.schema.js';

describe('S02 标准达标区', () => {
  it('My Behavior collapse 含「标准达标」progress-card 组', () => {
    const mb = s02.components.find(c => c.title === '销售行为达标 · My Behavior');
    expect(mb).toBeTruthy();
    const pcs = mb.components.filter(c => c.kind === 'progress-card');
    const titles = pcs.map(p => p.title);
    expect(titles.some(t => t.includes('标准'))).toBe(true);
  });
  it('区含 客户数达标/日均拜访/周拜访/信息收集 四项', () => {
    const mb = s02.components.find(c => c.title === '销售行为达标 · My Behavior');
    const sales = mb.components.find(c => c.kind === 'progress-card' && c.title.includes('标准'));
    expect(sales).toBeTruthy();
    const kpis = sales.sub  // 若 progress-card 支持嵌套，此处断言子项
    // 简版：断言 collapse 内任一 progress-card 的 dataBinding.metrics 含 cov* 键
    const covPcs = mb.components.filter(c => c.dataBinding?.source === 'aggregate' && c.dataBinding.metrics[0]?.key?.startsWith('cov'));
    expect(covPcs.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/pages/S02-sales-standard.test.js`
Expected: FAIL（S02 无 cov* 绑定）

- [ ] **Step 3: 最小实现** `src/pages/S02.schema.js`（My Behavior collapse components 数组末尾追加）

```js
        {
          // 2026-08-30 三分类 B 类：标准达标（boardSummary 注入的 cov* 六键，走 sales-thresholds 出厂标准）
          kind: 'progress-card',
          title: '标准 · 日均拜访',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covDailyVisitTarget', agg: 'value' }] },
        },
        {
          kind: 'progress-card',
          title: '标准 · 周拜访数',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covWeeklyVisitTarget', agg: 'value' }] },
        },
        {
          kind: 'progress-card',
          title: '标准 · 客户数下限',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covCustomerCountMin', agg: 'value' }] },
        },
        {
          kind: 'progress-card',
          title: '标准 · 信息收集/周',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covInfoCollectWeekly', agg: 'value' }] },
        },
```

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/pages/S02-sales-standard.test.js`
Expected: PASS（2/2）

**回归**：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/pages/S02.test.js`（若有）
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/pages/S02.schema.js test/pages/S02-sales-standard.test.js
git commit -m "feat(pages): S02 新增 标准达标区（cov* 六键 progress-card）"
```

---

### Task 7: named-accounts.html + routes.js 前端消费 cov* + 21 条合格率配置化

**Files:**
- Modify: `src/web/named-accounts.html`
- Modify: `src/http/routes.js:756`
- Test: `test/http/named-accounts-cov.test.js`（新建）

**背景**：boardSummary 已注入 cov* 六键（上轮 C 接线），前端零消费。本轮 renderKpis 补 标准比对 KPI；21 条合格率两处硬编码 `>= 80` 改读配置（routes.js:756 + named-accounts.html 两处）。

- [ ] **Step 1: 写失败测试** `test/http/named-accounts-cov.test.js`

```js
import { describe, it, expect } from 'vitest';
import { boardSummary } from '../../src/sales/namedAccountBoard.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

describe('boardSummary cov* 消费', () => {
  it('cov* 六键 + 达标布尔齐全', () => {
    const s = boardSummary([], [], [], {}, null, [], {}, mergedThresholds({}));
    expect(s.covDailyVisitTarget).toBe(3);
    expect(s.covWeeklyVisitTarget).toBe(15);
    expect(s.covDailyVisitOptimized).toBe(4);
    expect(s.covInfoCollectWeekly).toBe(5);
    expect(s.covCustomerCountMin).toBe(60);
    expect(s.covCustomerCountTarget).toBe(75);
  });
  it('客户数 < 60 -> covCustomerOk false', () => {
    const accounts = [{ id: 'a1', payload: { owner_id: 'alice', owner: 'alice' } }];
    const s = boardSummary(accounts, [], [], {}, 'alice', [], {}, mergedThresholds({}));
    expect(s.covCustomerOk).toBe(false);
  });
  it('阈值随配置变化', () => {
    const s = boardSummary([], [], [], {}, null, [], {}, mergedThresholds({ coverage: { customer_count_min: 80 } }));
    expect(s.covCustomerCountMin).toBe(80);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/http/named-accounts-cov.test.js`
Expected: FAIL（cov* 六键未注入）

> ⚠️ **注意**：上轮 A-D 接线已给 boardSummary 注入 cov* 六键（namedAccountBoard.js），若测试直接 PASS 说明注入已在——本测试是**消费层回归锁**，防止未来删注入。Step 3 的实现才是真正改动（前端 renderKpis）。

- [ ] **Step 3: 最小实现**

**3a. `src/web/named-accounts.html` renderKpis 末尾追加 标准比对**：

```js
      // 2026-08-30 三分类 B 类：标准达标（cov* 六键，走 sales-thresholds 出厂标准）
      kpi('客户数≥', `${summary.covCustomerCountMin ?? 60}（当前 ${summary.targetCustomers ?? 0}）`, (summary.covCustomerOk ? 'ok' : 'warn')) +
      kpi('日均拜访≥', summary.covDailyVisitTarget ?? 3, (summary.covVisitsOk ? 'ok' : 'warn')) +
      kpi('周拜访≥', summary.covWeeklyVisitTarget ?? 15, (summary.covWeekVisitsOk ? 'ok' : 'warn')) +
      kpi('信息收集/周≥', summary.covInfoCollectWeekly ?? 5, 'ok') +
```

**3b. `src/web/named-accounts.html` 21 条合格率两处硬编码改读配置**（renderBehaviorCard:287、renderBoard:235）：

`renderBehaviorCard`：
```js
    const pct = Math.round((pass / total) * 100);
    const threshold = summary?.behaviorPassRateThreshold ?? 80; // 2026-08-30 B 类：读配置
    const cls = pct >= threshold ? 'ok' : 'warn';
```

`renderBoard` 的 21 条列：
```js
          <td class="${bhPct >= 80 ? 'pass' : 'warn'}">${bh.pass ?? 0}/${bh.total ?? 21}</td>
```
改为：
```js
          <td class="${bhPct >= (summary?.behaviorPassRateThreshold ?? 80) ? 'pass' : 'warn'}">${bh.pass ?? 0}/${bh.total ?? 21}</td>
```

**3c. `src/http/routes.js:756`**：
```js
        { label: '21条合格率', value: s.behaviorPassRate ?? 0, unit: '%', state: ((s.behaviorPassRate ?? 0) >= (s.behaviorPassRateThreshold ?? 80)) ? 'ok' : 'warn' },
```

**3d. `src/sales/namedAccountBoard.js` boardSummary 补 `behaviorPassRateThreshold` 注入**：
```js
    behaviorPassRateThreshold: readThreshold(thresholds, 'ui.behavior_pass_rate_ok', 80), // 2026-08-30 B 类：21 条合格率着色阈值配置化
```

- [ ] **Step 4: 运行确认通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/http/named-accounts-cov.test.js`
Expected: PASS（3/3）

**回归**：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/http/home-page.test.js`
Expected: PASS（首页 21 条合格率断言若钉死 80 需同步改为读配置语义）

- [ ] **Step 5: 提交**

```bash
git add src/web/named-accounts.html src/http/routes.js src/sales/namedAccountBoard.js test/http/named-accounts-cov.test.js
git commit -m "feat(web): named-accounts + 首页消费 cov* 六键；21 条合格率阈值配置化（修复硬编码80）"
```

---

## Self-Review（写作后自查）

**1. 规格覆盖**（对设计文档 §1/§2/§3）：
- §1 A 类：✔ Task 1（评估器分支）+ Task 2（4 规则注册）+ Task 3（巡检纯函数）+ Task 4（定时器壳）——A1-A10 全覆盖（A4/A5 已有，不加）；A6 漏斗抖动规则未入 Task 1/2（jitterRate 需 baseline，巡检里 annualTarget>0 分支可加——**已列入 Task 3 待扩展**，见下方「缺口备注」）
- §2 B 类：✔ Task 6（S02 区）+ Task 7（named-accounts 消费+配置化）——B1-B8 全覆盖（B6 漏斗三指标进 S02 管道区 kpi-strip，Task 6）
- §3 C 类：✔ Task 5（C4/C5 hard + C6 商机三要素）——C1-C3 保留（不新增），C4-C6 本轮落地

**2. 占位符扫描**：无 TBD/TODO；Task 5 C6 的 `thresholdsForGate(ctx)` 有「简化建议」明确指向 `DEFAULT_THRESHOLDS`（非占位）；Task 6 测试中 `sales.sub` 一行含注释「若 progress-card 支持嵌套」——**这是占位，需修复**（见下方）。

**3. 类型一致性**：
- `salesDailyScan` 返回 `{kind, particle_id, metric, severity}`（Task 3 定义）→ Task 4 消费 `h.kind/h.severity/h.particle_id/h.metric` ✔
- `createAlert({kind,severity,target_role,particle_id,payload})` 签名（alertStore.js）→ Task 4 传入一致 ✔
- `funnelHealth(potential, th)` / `commitAccuracy(promised, actual, th)` / `salesPotential(deals, annualTarget, closedAmount, th)` 签名（funnelQuality.js）→ Task 3 调用一致 ✔
- `deriveRhythmDays(targetsCfg, thresholds)` 签名 → Task 3 调用 `deriveRhythmDays(null, th)` ✔
- `behaviorPassRateThreshold` 字段名：Task 7 3a/3b/3c/3d 一致 ✔

**4. 缺口备注（需在 Task 3 补）**：A6 漏斗抖动（`funnel_jitter`）巡检判定在 Task 3 未实现（annualTarget 分支只有健康/承诺）。**补齐**：Task 3 Step 3 尾部加：

```js
  // 漏斗抖动（baseline 由 applyBaselineSnapshot 提供；无基线不判）
  if (annualTarget > 0 && deals.length) {
    const baselineTotal = deals.reduce((s, d) => s + Number(d?.payload?.funnel?.baseline_amount || 0), 0);
    if (baselineTotal > 0) {
      const movedTotal = deals.reduce((s, d) => {
        const p = d?.payload || {};
        const prev = Number(p.funnel?.baseline_amount || 0);
        const cur = Number(p.expected_amount || 0);
        return s + Math.abs(cur - prev); // 简化：净变动额绝对值
      }, 0);
      const rate = movedTotal / baselineTotal;
      if (rate > readThreshold(th, 'funnel.jitter_max', 0.3)) {
        hits.push({ kind: 'funnel_jitter', particle_id: null, metric: { jitterRate: rate, threshold: readThreshold(th, 'funnel.jitter_max', 0.3) }, severity: 'medium' });
      }
    }
  }
```

同时 Task 1 测试补 `funnel_jitter` 分支用例 + Task 2 注册 `funnel_jitter` 规则（`check_params: { jitter_max: 0.3 }`）。

**5. 修复占位**：Task 6 测试第 2 例的 `sales.sub` 注释改为具体断言：

```js
  it('区含 客户数/日均/周拜访/信息收集 四项 progress-card', () => {
    const mb = s02.components.find(c => c.title === '销售行为达标 · My Behavior');
    const covPcs = mb.components.filter(c => c.kind === 'progress-card' && c.title.startsWith('标准'));
    expect(covPcs.length).toBeGreaterThanOrEqual(4);
    const titles = covPcs.map(c => c.title).join('|');
    expect(titles).toContain('客户数');
    expect(titles).toContain('日均拜访');
    expect(titles).toContain('周拜访');
    expect(titles).toContain('信息收集');
  });
```

---

## 执行移交

Plan 已保存到 `docs/superpowers/plans/2026-08-30-sales-indicator-3class-deep-implementation.md`。两个执行选项：

**1. Subagent-Driven（推荐）**——每个 Task 派独立子代理，Task 间审查，迭代快

**2. Inline Execution**——本会话按 executing-plans 批执行，带检查点

选哪个？