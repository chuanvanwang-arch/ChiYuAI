// src/sales/funnelQuality.js — 漏斗质量管理纯函数（零 DB，零 AI 推断）
// 依据：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5
// 原则（用户 2026-08-30）：加权值/抖动阈值/承诺评价带一律走后台配置（config_store['sales-thresholds']），
//   不得硬编码——本模块经 readThreshold() 读取，缺失回退 DEFAULT_THRESHOLDS。
//   加权是确定性业务规则（非 AI 推断）→ 只算业务事实，不进 payload.ai.*。

import { readThreshold, DEFAULT_THRESHOLDS } from './salesThresholds.js';

// 预测分类 → 加权值配置键（DEFAULT 见 salesThresholds.js funnel.weighted）
const FORECAST_WEIGHT_KEY = {
  '确保': 'weighted.win',
  '优势': 'weighted.adv',
  '可能+': 'weighted.even',
  '可能-': 'weighted.weak',
};
const DEFAULT_WEIGHTS = { '确保': 0.9, '优势': 0.6, '可能+': 0.3, '可能-': 0 };

const MANT_KEYS = ['m', 'a', 'n', 't'];

/** MANT 四要素齐全性。四要素全明确（ok===true）才可进漏斗。 */
export function mantOk(funnel = {}) {
  const mant = funnel?.mant || {};
  const missing = MANT_KEYS.filter((k) => mant[k]?.ok !== true);
  return { ok: missing.length === 0, missing };
}

/**
 * 漏斗区域判定。
 * 线索=四要素全不清；机会-=ANT≥1 且 M 不清；机会+=M 明确且 ANT 未全清；漏斗内=四要素全清。
 */
export function funnelZone(deal = {}) {
  const mant = deal?.payload?.funnel?.mant || deal?.funnel?.mant || {};
  const ok = (k) => mant[k]?.ok === true;
  const m = ok('m'), a = ok('a'), n = ok('n'), t = ok('t');
  const ant = a || n || t;
  if (m && a && n && t) return '漏斗内';
  if (m && !ant) return '机会+';
  if (!m && ant) return '机会-';
  return '线索';
}

/**
 * 预测分类（从事实信号推导，不读已存值优先）。
 * 确保=中标通知书；优势=决策者为我司支持者；可能+=势均力敌；可能-=劣势。
 */
export function forecastClass(deal = {}) {
  const f = deal?.payload?.funnel || deal?.funnel || {};
  if (f.win_notice === true) return '确保';
  if (f.supporter === true) return '优势';
  if (f.stance === 'even') return '可能+';
  if (f.stance === 'weak') return '可能-';
  return f.forecast_class || null; // 兜底读已存值
}

/** 加权金额 = 金额 × 预测分类加权值（配置驱动）。无分类 → 0。 */
export function weightedAmount(deal = {}, thresholds = null) {
  const cls = deal?.payload?.funnel?.forecast_class || deal?.funnel?.forecast_class || null;
  if (!cls || !(cls in FORECAST_WEIGHT_KEY)) return 0;
  const wkey = FORECAST_WEIGHT_KEY[cls];
  const w = thresholds
    ? readThreshold(thresholds, `funnel.${wkey}`, DEFAULT_WEIGHTS[cls])
    : DEFAULT_WEIGHTS[cls];
  const amount = Number(deal?.payload?.expected_amount || deal?.expected_amount || 0);
  return Math.round(amount * w);
}

/**
 * 销售潜力（健康性）=（已下单 + Σ加权）/ 年任务。要求 ≥100%。
 * @param {Array} deals - CRM_DEAL 列表
 * @param {number} annualTarget - 年任务金额
 * @param {number} [closedAmount=0] - 已下单（已签单）金额
 * @param {object} [thresholds] - 合并后阈值（驱动加权值）
 */
export function salesPotential(deals = [], annualTarget = 0, closedAmount = 0, thresholds = null) {
  const weighted = (deals || []).reduce((s, d) => s + weightedAmount(d, thresholds), 0);
  const target = Number(annualTarget) || 0;
  if (target <= 0) return 0; // 防除零
  return (Number(closedAmount) + weighted) / target;
}

/**
 * 漏斗健康线判定（健康性布尔）：销售潜力 ≥ health_min_ratio（默认 1.0 = 100%）。
 * 阈值随配置变化（funnel.health_min_ratio，来源 to-b-sales-management「滚动 2 个 Q 销售潜力达标 ≥100%」）。
 * @param {number} potential - salesPotential 输出（销售潜力比率）
 * @param {object} [thresholds] - 合并后阈值；缺省回退默认 1.0
 * @returns {boolean} 健康（true） / 不健康（false）
 */
export function funnelHealth(potential = 0, thresholds = null) {
  const ratio = thresholds
    ? readThreshold(thresholds, 'funnel.health_min_ratio', 1.0)
    : readThreshold(DEFAULT_THRESHOLDS, 'funnel.health_min_ratio', 1.0);
  return Number(potential) >= ratio;
}

/**
 * 抖动率 = 变动金额 / 取值时（季度初）漏斗内金额。
 * 分母依赖 baseline 快照；缺基线（null/0）返回 null（看板显式标「无基线」，不显示 0）。
 * @param {number} baselineAmount - 取值快照金额（funnel.baseline_amount）
 * @param {number} movedAmount - 取消+降出+后延-中标未下单 的净额
 */
export function jitterRate(baselineAmount, movedAmount) {
  const b = Number(baselineAmount);
  if (!b || b <= 0) return null;
  return Number(movedAmount) / b;
}

/**
 * 承诺兑现率与评价色。
 * 绿=90-110% / 黄=80-90% / 红=<80% / 紫=≥110%（承诺过低）。
 * 评价带随配置变化（funnel.commit）。
 */
export function commitAccuracy(promised, actual, thresholds = null) {
  const p = Number(promised) || 0;
  if (p <= 0) return { rate: 0, level: 'red' };
  const rate = Number(actual) / p;
  const greenLow = thresholds ? readThreshold(thresholds, 'funnel.commit.green_low', 0.9) : 0.9;
  const greenHigh = thresholds ? readThreshold(thresholds, 'funnel.commit.green_high', 1.1) : 1.1;
  const yellowLow = thresholds ? readThreshold(thresholds, 'funnel.commit.yellow_low', 0.8) : 0.8;
  const purpleLow = thresholds ? readThreshold(thresholds, 'funnel.commit.purple_low', 1.1) : 1.1;
  let level;
  if (rate > purpleLow) level = 'purple'; // 紫带随配置（funnel.commit.purple_low），默认 1.1
  else if (rate >= greenLow) level = 'green';
  else if (rate >= yellowLow) level = 'yellow';
  else level = 'red';
  return { rate, level };
}

/**
 * 预测缺口判定（驱动 forecast_breach 告警）。
 * 销售潜力 < 阈值（默认 1.0 = 100%）→ true。阈值随配置变化（funnel.forecast_breach_ratio）。
 */
export function forecastBreach(salesPotential, thresholds = null) {
  const ratio = thresholds ? readThreshold(thresholds, 'funnel.forecast_breach_ratio', 1.0) : 1.0;
  return Number(salesPotential) < ratio;
}

/**
 * 季度 baseline 快照（算抖动率分母）。
 * 取值时漏斗内金额 = 商机当前 expected_amount，落 funnel.baseline_amount。
 * 幂等：重复跑结果一致（只覆写 baseline_amount，不动其它字段）。
 * @param {Array} deals - CRM_DEAL 粒子（{id, payload}）
 * @returns {Array} {id, payload}（已写入 funnel.baseline_amount）
 */
export function applyBaselineSnapshot(deals = []) {
  return (deals || []).map((d) => {
    const payload = d?.payload || d || {};
    const funnel = { ...(payload.funnel || {}) };
    funnel.baseline_amount = Number(payload.expected_amount || 0);
    return { id: d.id, payload: { ...payload, funnel } };
  });
}
