// src/sales/salesThresholds.js — 判定阈值配置层（业务阈值唯一事实源）
// 原则（用户 2026-08-30 明确）：拜访数量之类的业务阈值一律走后台配置，
//   不得硬编码在 SKILL 或代码里——客户需要能按自身需求调整。
// 分层职责：
//   SKILL(method-*)  → 方法论定义 + 默认建议值（标注配置键，不承载可调数值）
//   config_store['sales-thresholds'] → 客户可调阈值（唯一事实源）
//   本模块           → 读取 / 铺底 / 派生；代码只经此入口取阈值
// 向后兼容：未传配置时一律回退 DEFAULT_THRESHOLDS，行为与改造前完全一致。

/** 兜底默认（与改造前代码中的硬编码值逐项一致，保证既有行为不变） */
export const DEFAULT_THRESHOLDS = Object.freeze({
  bantcc: {
    pass: 0.6,     // BANTCC 达标线（21 条 03-01 / P3→P4 门控 / 缺口提示 三处同源）
    unknown: 0.5,  // 未评估时的兜底值（按缺口处理）
  },
  behavior: {
    min_customer_types: 2, // 02-01 拜访过的客户类型种数
    min_contacts: 2,       // 04-02 联系人数量
    recent_visit_days: 7,  // 01-01 近 N 天有拜访
  },
  // 客户覆盖频度与拜访数量（默认建议值来自外部 SKILL to-b-sales-management / sales-knowledge-free，均为出厂建议、客户可调）
  coverage: {
    target_month_days: 30,        // 目标客户：至少 1 个月拜访 1 次（月覆盖频度）
    potential_quarter_days: 90,   // 潜力客户：至少 3 个月拜访 1 次（季覆盖频度）
    lost_contact_days: 90,        // 3 个月以上不接触 → 关系水平下降、大概率流失
    daily_visits_target: 3,       // 当前标准：日均 3 次拜访
    weekly_visits_target: 15,     // 当前标准：每周 15 次
    daily_visits_optimized: 4,    // 优化目标：日均 4 次拜访
    info_collect_weekly: 5,       // 信息收集指标分解到周：每周 5-10 个客户（取下限 5）
    customer_count_min: 60,       // 客户数量合理范围下限：60-90
    customer_count_target: 75,    // 客户数量定额：日均 3 次 → 75 个客户
    named_visit_warn_days: 1,     // 指名客户告警：应访日过后 N 天进入黄色提醒（须 < alert_days）
    named_visit_alert_days: 2,    // 指名客户告警：应访日过后 N 天进入红色告警（默认 2 天）
  },
  rhythm: {
    adherence_window_days: 30, // sales_visit_frequency_adherence 统计窗口
  },
  stage: {
    stuck_days: 30, // 阶段停留告警 / 推进卡点判定
  },
  gate: {
    s1_s2_min_need_facts: 2, // S1→S2 需求事实项数（product/qty/spec）
  },
  // 漏斗转化率 KPI 健康线（设计 §4：AI 计算、低于健康线标记预警、人辅导改善，非门禁）
  //   出厂默认取自行业基准：S1→S2 ≥60% / S2→S3 ≥50% / S3→S4 ≥40% / S4→S5 ≥70%
  funnelKpi: {
    s1_s2: 0.6,
    s2_s3: 0.5,
    s3_s4: 0.4,
    s4_s5: 0.7,
  },
  ui: {
    behavior_pass_rate_ok: 80, // 21 条合格率着色阈值（%）
  },
  taoran: {
    achieved_ratio: 80,     // TAORAN-A 达标比例分档（%），≥80% 为达到目的
    unachieved_ratio: 20,   // TAORAN-A 未达分数档（%），<20% 为未达到（外部 SKILL 建议值）
  },
  funnel: {
    weighted: { win: 0.9, adv: 0.6, even: 0.3, weak: 0 }, // 预测分类加权值：确保/优势/可能+/可能-（SKILL 定死，但客户可配）
    jitter_max: 0.3,   // 抖动率健康阈值（季度/月 ≤30%，周 ≤40% 仅监控）
    health_min_ratio: 1.0,      // 漏斗健康线：滚动 2 个 Q 销售潜力达标（≥100%）
    month_new_bid_ratio: 0.35,  // 月新增开标占比健康阈值（当月新增开标占比 ≤35%）
    commit: { green_low: 0.9, green_high: 1.1, yellow_low: 0.8, purple_low: 1.1 }, // 承诺兑现评价带：90-110%绿 / 80-90%黄 / <80%红 / ≥110%紫
    forecast_breach_ratio: 1.0, // 预测缺口阈值：销售潜力 < 此值触发 forecast_breach 告警
  },
  swas: {
    stale_days: 30,          // SWAS 回顾新鲜度阈值（>30 天未回顾触发 stuck_warning 联动，设计 §4.1）
    soft_warn_below: 0.5,   // S2→S3 soft 闸：SWAS 齐全度低于此值提示「未做商机回顾」（不硬拦，设计 §4.2）
  },
  // 方法论维度证据自动派生（F5，2026-09-02）：把结构化事实转成"该维达标/不达标"的判定线。
  //   BANT 四维与 MEDDICC C1/C2 复用 bantcc.pass —— 不另立键，避免同一条达标线两处配置各调一半。
  methodology: {
    opp_value_min: 100000, // OPP_MATRIX.value（商业价值）达标线：预期金额 ≥ 10 万（出厂建议值，客户可调）
    win_prob_min: 0.5,     // OPP_MATRIX.win_prob（可行性）达标线：赢率 ≥ 50%
  },
});

/**
 * 点路径读取阈值，配置优先、缺失回退默认。
 * @param {object} cfg   - mergedThresholds 的输出（可为 undefined）
 * @param {string} path  - 点路径，如 'bantcc.pass'
 * @param {*} [fallback] - 显式兜底（缺省取 DEFAULT_THRESHOLDS 对应项）
 */
export function readThreshold(cfg, path, fallback) {
  const keys = String(path || '').split('.').filter(Boolean);
  let cur = cfg;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') { cur = undefined; break; }
    cur = cur[k];
  }
  if (cur !== undefined && cur !== null) return cur;
  if (fallback !== undefined) return fallback;
  // 回退默认（深拷贝冻结对象的只读访问，安全）
  let d = DEFAULT_THRESHOLDS;
  for (const k of keys) {
    if (d == null || typeof d !== 'object') return undefined;
    d = d[k];
  }
  return d;
}

/** 铺底 + 深层覆写（按 groups 逐层合并，未提及的键保留默认） */
export function mergedThresholds(cfg) {
  const out = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
  const src = (cfg && typeof cfg === 'object') ? cfg : {};
  for (const [group, val] of Object.entries(src)) {
    if (!out[group] || typeof val !== 'object' || val === null) {
      if (val !== undefined && val !== null) out[group] = val;
      continue;
    }
    out[group] = { ...out[group], ...val };
  }
  return out;
}

/**
 * 从覆盖配置与 id30（named-account-targets）的 window_days 派生 21 条判定用的接触窗口天数。
 * 优先级（消除「id30 配季度天数、21 条里又写 90」的双源漂移，同时让 sales-thresholds coverage 键可直调）：
 *   1) coverage.potential_quarter_days / coverage.target_month_days（sales-thresholds，客户可后台直调）
 *   2) id30 window_days.quarter / window_days.month（named-account-targets，配置中心 id30）
 *   3) 兜底默认 90 / 30
 * @returns {{potential_days:number, target_days:number}}
 */
export function deriveRhythmDays(targetsCfg, thresholds = DEFAULT_THRESHOLDS) {
  const wd = (targetsCfg && typeof targetsCfg === 'object') ? (targetsCfg.window_days || {}) : {};
  // coverage 键「显式生效」判定：merged 值 ≠ 出厂默认时才视为客户显式配置（避免默认 90/30 吞掉 id30 派生）。
  // 未显式配置 → 沿用 id30 window_days（权威派生），再回退默认 90/30。
  const cov = (thresholds && typeof thresholds === 'object') ? (thresholds.coverage || {}) : {};
  const defaultCov = DEFAULT_THRESHOLDS.coverage || {};
  const covPotential = (cov.potential_quarter_days != null && cov.potential_quarter_days !== defaultCov.potential_quarter_days)
    ? Number(cov.potential_quarter_days) : undefined;
  const covTarget = (cov.target_month_days != null && cov.target_month_days !== defaultCov.target_month_days)
    ? Number(cov.target_month_days) : undefined;
  return {
    potential_days: covPotential ?? Number(wd.quarter ?? readThreshold(thresholds, 'rhythm.potential_days', 90)),
    target_days: covTarget ?? Number(wd.month ?? readThreshold(thresholds, 'rhythm.target_days', 30)),
  };
}
