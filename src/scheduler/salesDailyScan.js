// src/scheduler/salesDailyScan.js — 三分类 A 类巡检纯函数（只读 + 产出告警清单，不写粒子）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.2
// 铁律：巡检只读 + 产出告警清单；处置由 crm-* 写 Action 显式触发
//       （对齐 07 文档 §5-2：定时扫描直接写粒子即违 D4 反模式，本函数零 DB 零写）
import { readThreshold, mergedThresholds } from '../sales/salesThresholds.js'; // mergedThresholds 别名消费（测试导入）
import { salesPotential, funnelHealth, commitAccuracy } from '../sales/funnelQuality.js';

const DAY = 86400000;

function lastVisitAt(p) {
  const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
  if (!notes.length) return null;
  const ts = notes.map(n => (n?.at ? new Date(n.at).getTime() : NaN)).filter(t => !Number.isNaN(t));
  return ts.length ? Math.max(...ts) : null;
}

function daysSince(ts) {
  return ts == null ? null : Math.floor((Date.now() - ts) / DAY);
}

const tierOf = (p) => String(p?.tier || p?.tier_type || '潜力');

/**
 * 巡检主函数（纯函数，零 DB）：输入账户/商机/阈值 → 命中告警清单。
 * @param {object} opts
 *   accounts   - CRM_ACCOUNT 粒子数组
 *   deals      - CRM_DEAL 粒子数组
 *   thresholds - mergedThresholds 输出（缺省回退出厂默认）
 *   annualTarget / closedAmount - 漏斗健康性输入（缺省 0 → 不判漏斗）
 * @returns {Array<{kind, particle_id, metric, severity}>}
 */
export function salesDailyScan({ accounts = [], deals = [], thresholds = null, annualTarget = 0, closedAmount = 0 } = {}) {
  const th = thresholds || mergedThresholds({});
  const hits = [];
  const targetDays = readThreshold(th, 'coverage.target_month_days', 30);
  const potentialDays = readThreshold(th, 'coverage.potential_quarter_days', 90);
  const lostDays = readThreshold(th, 'coverage.lost_contact_days', 90);
  const dailyTarget = readThreshold(th, 'coverage.daily_visits_target', 3);
  const weeklyTarget = readThreshold(th, 'coverage.weekly_visits_target', 15);
  const weeklyMin = readThreshold(th, 'coverage.info_collect_weekly', 5);

  // ── 账户级：覆盖缺口 / 流失警戒 / 拜访达标 / 信息收集 ──
  const week0 = Date.now() - 6 * DAY;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  let dailyVisits = 0, weekVisits = 0, weekNew = 0;

  for (const a of accounts) {
    const p = a?.payload || {};
    const ds = daysSince(lastVisitAt(p));
    const tier = tierOf(p);
    if (tier === '目标' && ds != null && ds >= targetDays) {
      hits.push({ kind: 'coverage_gap', particle_id: a.id, metric: { tier: '目标', daysSinceVisit: ds, windowDays: targetDays }, severity: 'medium' });
    }
    if (tier === '潜力' && ds != null && ds >= potentialDays) {
      hits.push({ kind: 'coverage_gap', particle_id: a.id, metric: { tier: '潜力', daysSinceVisit: ds, windowDays: potentialDays }, severity: 'medium' });
    }
    if (ds != null && ds >= lostDays) {
      hits.push({ kind: 'lost_contact', particle_id: a.id, metric: { daysSinceVisit: ds }, severity: 'high' });
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
    hits.push({ kind: 'visit_shortfall', particle_id: null, metric: { dailyVisits, dailyTarget }, severity: 'medium' });
  }
  if (accounts.length && weekVisits < weeklyTarget) {
    hits.push({ kind: 'visit_shortfall', particle_id: null, metric: { weeklyVisits: weekVisits, weeklyTarget }, severity: 'medium' });
  }
  if (accounts.length && weekNew < weeklyMin) {
    hits.push({ kind: 'info_collect_lag', particle_id: null, metric: { weekNew, weeklyMin }, severity: 'low' });
  }

  // ── 商机级：漏斗健康 / 承诺红 / 抖动率（annualTarget > 0 才判）──
  if (annualTarget > 0 && deals.length) {
    const potential = salesPotential(deals, annualTarget, closedAmount, th);
    const healthMin = readThreshold(th, 'funnel.health_min_ratio', 1.0);
    if (Number(potential) < healthMin || !funnelHealth(potential, th)) {
      hits.push({ kind: 'funnel_unhealthy', particle_id: null, metric: { salesPotential: potential, health_min: healthMin }, severity: 'high' });
    }
    const baselineTotal = deals.reduce((s, d) => s + Number(d?.payload?.funnel?.baseline_amount || 0), 0);
    if (baselineTotal > 0) {
      const movedTotal = deals.reduce((s, d) => {
        const p = d?.payload || {};
        const prev = Number(p.funnel?.baseline_amount || 0);
        const cur = Number(p.expected_amount || 0);
        return s + Math.abs(cur - prev);
      }, 0);
      const jitter = movedTotal / baselineTotal;
      const jitterMax = readThreshold(th, 'funnel.jitter_max', 0.3);
      if (jitter > jitterMax) {
        hits.push({ kind: 'funnel_jitter', particle_id: null, metric: { jitterRate: jitter, jitter_max: jitterMax }, severity: 'medium' });
      }
    }
    for (const d of deals) {
      const p = d?.payload || {};
      const promised = Number(p.committed?.amount || p.committed?.promised || 0);
      const actual = Number(p.actual_amount || 0);
      if (promised > 0) {
        const { rate } = commitAccuracy(promised, actual, th);
        const yellowLow = readThreshold(th, 'funnel.commit.yellow_low', 0.8);
        if (rate < yellowLow) {
          hits.push({ kind: 'commit_red', particle_id: d.id, metric: { commitRate: rate, yellow_low: yellowLow }, severity: 'medium' });
        }
      }
    }
  }

  return hits;
}