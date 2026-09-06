// src/alerts/ruleEvaluator.js — 预警规则纯函数判定器（无状态，无 PG 依赖）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §D（evaluateAlertRule 纯函数）
// 职责：evaluateAlertRule(rule, event) → {hit, payload}
//  - match 判定：event.particleType ∈ rule.match.particleTypes 且 event.action ∈ rule.match.actions（* 通配）
//  - check_params 计算（MVP 三档）：stuck_days/overdue_days 超限、breach_pct 破口 → hit + payload

// 事件样本：{ particleType, action, metric: { stuckDays/overdueDays/amount/forecast/... } , ... }
export function evaluateAlertRule(rule, event) {
  if (!rule || !rule.enabled) return { hit: false, payload: null };
  if (!event || typeof event !== 'object') return { hit: false, payload: null };

  const match = rule.match || {};
  const types = match.particleTypes || [];
  const actions = match.actions || [];
  const { particleType, action } = event;

  // match 判定：粒子类型命中（* 通配）且动作命中
  const typeHit = types.includes('*') || types.includes(particleType);
  const actionHit = actions.includes('*') || actions.includes(action);
  if (!typeHit || !actionHit) return { hit: false, payload: null };

  // check_params 计算（MVP 三档）
  const params = rule.check_params || {};
  const metric = event.metric || {};
  const payload = { kind: rule.kind, particleType, action };

  if (params.stuck_days != null && typeof metric.stuckDays === 'number') {
    const stuckDays = metric.stuckDays;
    if (stuckDays >= params.stuck_days) {
      payload.stuckDays = stuckDays;
      payload.threshold = params.stuck_days;
      return { hit: true, payload };
    }
  }

  if (params.overdue_days != null && typeof metric.overdueDays === 'number') {
    const overdueDays = metric.overdueDays;
    if (overdueDays >= params.overdue_days) {
      payload.overdueDays = overdueDays;
      payload.threshold = params.overdue_days;
      return { hit: true, payload };
    }
  }

  // payment_due 档：发票到期未付（INVOICE 粒子落地后启用）
  // 修复：规则 check_params 用 due_days，评估器此前无对应分支 → invoice_create 命中永 hit:false（T4 红）
  if (params.due_days != null && typeof metric.dueDays === 'number') {
    const dueDays = metric.dueDays;
    if (dueDays >= params.due_days) {
      payload.dueDays = dueDays;
      payload.threshold = params.due_days;
      return { hit: true, payload };
    }
  }

  if (params.breach_pct != null && typeof metric.ratio === 'number') {
    const ratio = metric.ratio;
    if (ratio < params.breach_pct) {
      payload.ratio = ratio;
      payload.threshold = params.breach_pct;
      return { hit: true, payload };
    }
  }

  // ── 指标分支（2026-08-30 三分类 A 类）──────────────────────────────
  // 阈值出厂建议在 alertRegistry DEFAULT_RULES.check_params；运行时被
  // config_store['sales-thresholds'] 覆盖（同 financeAlertHook 动态读模式）。
  //
  // coverage_gap：账户覆盖缺口（目标>target_days / 潜力>potential_days 未拜访）
  if (params.target_days != null && typeof metric.daysSinceVisit === 'number' && metric.tier) {
    const need = metric.tier === '目标' ? params.target_days : params.potential_days;
    if (need != null && metric.daysSinceVisit >= need) {
      payload.tier = metric.tier;
      payload.daysSinceVisit = metric.daysSinceVisit;
      payload.windowDays = metric.windowDays ?? need;
      payload.threshold = need;
      return { hit: true, payload };
    }
  }

  // lost_contact：>lost_days 无任何拜访（非 tier 输入，通用流失警戒）
  if (params.lost_days != null && typeof metric.daysSinceVisit === 'number' && !metric.tier) {
    if (metric.daysSinceVisit >= params.lost_days) {
      payload.daysSinceVisit = metric.daysSinceVisit;
      payload.threshold = params.lost_days;
      return { hit: true, payload };
    }
  }

  // funnel_unhealthy：销售潜力 < health_min（滚动 2 Q 达标线）
  if (params.health_min != null && typeof metric.salesPotential === 'number') {
    if (metric.salesPotential < params.health_min) {
      payload.salesPotential = metric.salesPotential;
      payload.threshold = params.health_min;
      return { hit: true, payload };
    }
  }

  // commit_red：承诺准确率 < yellow_low（红带）
  if (params.yellow_low != null && typeof metric.commitRate === 'number') {
    if (metric.commitRate < params.yellow_low) {
      payload.commitRate = metric.commitRate;
      payload.threshold = params.yellow_low;
      return { hit: true, payload };
    }
  }

  // visit_shortfall：日/周拜访量未达标
  if (params.daily_target != null && typeof metric.dailyVisits === 'number') {
    const dayHit = metric.dailyVisits < params.daily_target;
    const weekHit = params.weekly_target != null && typeof metric.weeklyVisits === 'number'
      && metric.weeklyVisits < params.weekly_target;
    if (dayHit || weekHit) {
      payload.dailyVisits = metric.dailyVisits;
      payload.weeklyVisits = metric.weeklyVisits ?? null;
      payload.threshold = { daily: params.daily_target, weekly: params.weekly_target };
      return { hit: true, payload };
    }
  }

  // info_collect_lag：周新增客户 < weekly_min（信息收集进度落后）
  if (params.weekly_min != null && typeof metric.weekNew === 'number') {
    if (metric.weekNew < params.weekly_min) {
      payload.weekNew = metric.weekNew;
      payload.threshold = params.weekly_min;
      return { hit: true, payload };
    }
  }

  // funnel_jitter：抖动率 > jitter_max（漏斗抖动超标）
  if (params.jitter_max != null && typeof metric.jitterRate === 'number') {
    if (metric.jitterRate > params.jitter_max) {
      payload.jitterRate = metric.jitterRate;
      payload.threshold = params.jitter_max;
      return { hit: true, payload };
    }
  }

  return { hit: false, payload: null };
}