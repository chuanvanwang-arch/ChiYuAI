// src/scheduler/salesDailyScan.js — 三分类 A 类巡检纯函数（只读 + 产出告警清单，不写粒子）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.2
// 铁律：巡检只读 + 产出告警清单；处置由 crm-* 写 Action 显式触发
//       （对齐 07 文档 §5-2：定时扫描直接写粒子即违 D4 反模式，本函数零 DB 零写）
//
// ── 2026-09-17 个人隔离修正（触发：用户实测「没有完全按照销售员进行隔离，很多信息是相同的」）──
// 病灶（真库取证，非推断）：crm.signal 中 visit_shortfall 1003 条 / info_collect_lag 501 条，
//   **owner_id 非空 = 0**（全部无主）；且产出口径是「租户全部账户合计」——
//   accounts 数组进来后不分人地累加 dailyVisits/weekVisits/weekNew，
//   于是同租户内每个销售员看到的是**同一份租户总量**（例：全租户本周拜访 0 次 → 人人都是 0）。
//   两件事叠加：① 数值不区分人（口径错）② 无主 + target_role='sales' 被当作「广播」（可见性错）。
//
// 修法（两层，缺一即仍不正确）：
//   ① **口径按责任人分组**：以 `payload.owner_id` 分组，逐人独立判达标 → 每人看到自己的次数。
//      同时保留**一份团队合计**（target_role='manager'）：团队 KPI 语义依然成立，
//      但只广播给经理，不再广播给全体销售——正好复用 T21「无主 + 同角色广播」的既有谓词。
//   ② **产出携带责任人**：hit 带 `owner_id` / `target_role`，由产生点（timers.js）透传落库，
//      于是 store.list 的 ownerScope 谓词生效 → 「有主信号严格隔离」这条铁律才真正覆盖本类信号。
//
// 附带修正：聚合类 hit 携带**稳定 dedup_key**（不含周期戳）→ 同人同指标只保留一条未关闭行。
//   原实现 dedup_key 恒为 null（particle_id 为 null 时 createAlertWithDb 不派生键），
//   实测每小时新增 12–24 行同义信号（截图中的 21:06:31 / 20:36:33 两套同内容行即此）。
//   代价：稳定键要求「不再命中时必须关闭」，否则达标后残留旧快照 → 由 store.closeStaleAggregates 承担。
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

// 责任人：粒子 payload.owner_id（= crm_users.username，真库实测逐值对齐）。
//   类型闸 + 去空白后判空：不接受非字符串/空串作为责任人——无主就落 NULL，绝不臆造。
export function accountOwner(a) {
  const v = a?.payload?.owner_id;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// 聚合类信号的作用域
//   owner → 个人（target_role='sales'，只该本人可见）
//   team  → 团队合计（target_role='manager'，团队 KPI 只广播给经理）
const TEAM_ROLE = 'manager';
const OWNER_ROLE = 'sales';

/**
 * 巡检主函数（纯函数，零 DB）：输入账户/商机/阈值 → 命中告警清单。
 * @param {object} opts
 *   accounts   - CRM_ACCOUNT 粒子数组
 *   deals      - CRM_DEAL 粒子数组
 *   thresholds - mergedThresholds 输出（缺省回退出厂默认）
 *   annualTarget / closedAmount - 漏斗健康性输入（缺省 0 → 不判漏斗）
 * @returns {Array<{
 *   kind, severity, metric,
 *   particle_id,            // 粒子级信号的对象；聚合类为 null（该信号针对一组对象而非单个）
 *   owner_id,               // 责任人（username）；null = 无主（团队级聚合）
 *   target_role,            // 目标角色：sales（个人）/ manager（团队）
 *   dedup_key               // 聚合类：稳定键（同人同指标不堆行）；粒子级：null（交由产生点按粒子派生）
 * }>}
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

  const week0 = Date.now() - 6 * DAY;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);

  // ── ① 账户级（粒子级）：覆盖缺口 / 流失警戒 —— 责任人随账户走 ──
  for (const a of accounts) {
    const p = a?.payload || {};
    const owner = accountOwner(a);
    const ds = daysSince(lastVisitAt(p));
    const tier = tierOf(p);
    if (tier === '目标' && ds != null && ds >= targetDays) {
      hits.push({ kind: 'coverage_gap', particle_id: a.id, owner_id: owner, target_role: OWNER_ROLE, metric: { tier: '目标', daysSinceVisit: ds, windowDays: targetDays }, severity: 'medium' });
    }
    if (tier === '潜力' && ds != null && ds >= potentialDays) {
      hits.push({ kind: 'coverage_gap', particle_id: a.id, owner_id: owner, target_role: OWNER_ROLE, metric: { tier: '潜力', daysSinceVisit: ds, windowDays: potentialDays }, severity: 'medium' });
    }
    if (ds != null && ds >= lostDays) {
      hits.push({ kind: 'lost_contact', particle_id: a.id, owner_id: owner, target_role: OWNER_ROLE, metric: { daysSinceVisit: ds }, severity: 'high' });
    }
  }

  // ── ② 聚合级：拜访达标 / 信息收集 —— 按 owner 分组逐人算，再算一份团队合计 ──
  //   分组键为 owner_id；无主账户（owner_id 缺失）不进任何个人组——
  //   它们只体现在团队合计里（按角色广播给经理），不会冒充某个人的指标。
  const byOwner = new Map();
  for (const a of accounts) {
    const owner = accountOwner(a);
    if (!owner) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(a);
  }

  const agg = (accts, { owner_id, target_role, scope }) => {
    let dailyVisits = 0, weekVisits = 0, weekNew = 0;
    for (const a of accts) {
      const p = a?.payload || {};
      for (const n of (Array.isArray(p.visit_notes) ? p.visit_notes : [])) {
        const t = n?.at ? new Date(n.at).getTime() : NaN;
        if (Number.isNaN(t)) continue;
        // 电话拜访不计入「上门拜访量」（沿用原口径）
        if (t >= today0.getTime() && n?.type !== 'call') dailyVisits++;
        if (t >= week0) weekVisits++;
      }
      const ca = a.created_at ? new Date(a.created_at).getTime() : NaN;
      if (!Number.isNaN(ca) && ca >= week0) weekNew++;
    }
    const tag = owner_id ? `owner:${owner_id}` : 'team';
    const base = { owner_id, target_role, particle_id: null };
    if (dailyVisits < dailyTarget) {
      hits.push({
        ...base, kind: 'visit_shortfall', severity: 'medium',
        metric: { dailyVisits, dailyTarget, scope },
        dedup_key: `visit_shortfall:${tag}:daily`,
      });
    }
    if (weekVisits < weeklyTarget) {
      hits.push({
        ...base, kind: 'visit_shortfall', severity: 'medium',
        metric: { weeklyVisits: weekVisits, weeklyTarget, scope },
        dedup_key: `visit_shortfall:${tag}:weekly`,
      });
    }
    if (weekNew < weeklyMin) {
      hits.push({
        ...base, kind: 'info_collect_lag', severity: 'low',
        metric: { weekNew, weeklyMin, scope },
        dedup_key: `info_collect_lag:${tag}:weekly`,
      });
    }
  };

  for (const [owner, accts] of byOwner) agg(accts, { owner_id: owner, target_role: OWNER_ROLE, scope: 'owner' });
  if (accounts.length) agg(accounts, { owner_id: null, target_role: TEAM_ROLE, scope: 'team' });

  // ── ③ 商机级：漏斗健康 / 承诺红 / 抖动率（annualTarget > 0 才判）──
  //   注：商机尚未按 owner 分组（漏斗健康是经营级指标，分子分母为整租户管道）。
  //   与 ①② 的差别是**有意保留**的：团队漏斗合计本身是 exec/manager 视角，
  //   故 target_role='exec'，不广播给销售员（sales 视角看不到，避免"与我无关"的噪声）。
  if (annualTarget > 0 && deals.length) {
    const potential = salesPotential(deals, annualTarget, closedAmount, th);
    const healthMin = readThreshold(th, 'funnel.health_min_ratio', 1.0);
    if (Number(potential) < healthMin || !funnelHealth(potential, th)) {
      hits.push({ kind: 'funnel_unhealthy', particle_id: null, owner_id: null, target_role: 'exec', metric: { salesPotential: potential, health_min: healthMin }, severity: 'high', dedup_key: 'funnel_unhealthy:team:rolling' });
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
        hits.push({ kind: 'funnel_jitter', particle_id: null, owner_id: null, target_role: 'exec', metric: { jitterRate: jitter, jitter_max: jitterMax }, severity: 'medium', dedup_key: 'funnel_jitter:team:rolling' });
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
          // 承诺红是**单商机**指标 → 责任人取商机 owner（与账户级同口径）
          const dealOwner = typeof p.owner_id === 'string' && p.owner_id.trim() ? p.owner_id.trim() : null;
          hits.push({ kind: 'commit_red', particle_id: d.id, owner_id: dealOwner, target_role: OWNER_ROLE, metric: { commitRate: rate, yellow_low: yellowLow }, severity: 'medium' });
        }
      }
    }
  }

  return hits;
}
