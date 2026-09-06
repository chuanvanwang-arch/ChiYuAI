// src/sales/gateThresholdDelta.js — T4 门控阈值回归（BANTCC 五维→六维 S3→S4 拦截率统计）
// 设计输入：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §3.2（分母 5→6 风险）+ §4 T4
// 目标：统计六维改造前后 P3→P4 拦截率变化；delta>20% 触发回调阈值建议（0.6→0.5），但不自动改配置。
// 铁律（用户 2026-08-30）：业务阈值走 config_store['sales-thresholds']，本模块只「读」阈值做决策，绝不写配置。
//
// 口径说明（同一原始 payload，两口径对照，避免拿存储的 ai.* 混淆）：
//   before（旧五维）：B/A/N/T/C，分母 5；C = 竞争(competition)∨内线(coach) 任一即记 1。
//   after （新六维）：B/A/N/T/C1/C2，分母 6；复用 evaluator.deterministicEval 六维明细（含旧数据迁移回退）。
//   两者均从 raw payload 现算 → apples to apples。

import { deterministicEval } from '../aiAttributes/evaluator.js';

/** 信号判定：真值/非空字符串/正数记 1，0/负/空/undefined 记 0 */
function sig(x) {
  if (x === undefined || x === null || x === '') return false;
  if (typeof x === 'number') return x > 0;
  return true;
}

/**
 * 旧五维 BANTCC 齐全度（分母 5）——改造前口径，仅用于回归对照。
 * @param {object} payload - 商机原始 payload（B/A/N/T/competition/coach 等信号）
 * @returns {number} 0~1
 */
export function scoreBantcc5(payload) {
  const p = payload || {};
  const b = (p.bantcc && typeof p.bantcc === 'object') ? p.bantcc : {};
  const scoreOf = (key, ...fallbacks) => {
    const explicit = Number(b[key]);
    if (b[key] !== undefined && b[key] !== null && !Number.isNaN(explicit)) {
      return Math.max(0, Math.min(1, explicit)); // 显式评分（0~1）
    }
    // 旧五维：C 维度混用 competition 与 coach
    return sig(fallbacks.find(f => f !== undefined && f !== null)) ? 1 : 0;
  };
  const dims = {
    B: scoreOf('b', p.expected_amount, p.budget),
    A: scoreOf('a', p.authority, p.decision_maker),
    N: scoreOf('n', p.needs?.product, p.needs?.qty, (Array.isArray(p.pain_points) ? p.pain_points.length : p.pain_points)),
    T: scoreOf('t', p.expected_close_date, p.timeline),
    C: scoreOf('c', p.competition, p.coach),
  };
  return Object.values(dims).reduce((s, v) => s + v, 0) / 5;
}

/**
 * 新六维 BANTCC 齐全度（分母 6）——复用 evaluator 确定性兜底（含旧数据迁移回退）。
 * @param {object} payload
 * @returns {number} 0~1
 */
export function scoreBantcc6(payload) {
  const r = deterministicEval('CRM_DEAL', payload || {}, { key: 'bantcc_completeness' });
  return typeof r?.value === 'number' ? r.value : 0;
}

/**
 * 按某个齐全度打分函数与 pass 阈值，统计一组商机中被拦截（齐全度<pass）的占比。
 * @param {object[]} deals - 原始 payload 数组
 * @param {(p:object)=>number} scoreFn - scoreBantcc5 / scoreBantcc6
 * @param {number} pass - 拦截阈值（默认 0.6，取自 bantcc.pass 配置）
 * @returns {number} 0~1 拦截率
 */
export function interceptRate(deals, scoreFn, pass = 0.6) {
  const list = Array.isArray(deals) ? deals : [];
  if (!list.length) return 0;
  const blocked = list.filter(d => scoreFn(d) < pass).length;
  return blocked / list.length;
}

/**
 * 计算改造前后 P3→P4 拦截率差（delta 取绝对值）。
 * @param {object[]} deals
 * @param {{pass?:number}} [opts]
 * @returns {{before:number, after:number, delta:number}}
 */
export function computeDelta(deals, { pass = 0.6 } = {}) {
  const before = interceptRate(deals, scoreBantcc5, pass);
  const after = interceptRate(deals, scoreBantcc6, pass);
  return { before, after, delta: Math.abs(after - before) };
}

/**
 * 根据拦截率 delta 给出阈值处置建议。
 * 铁律：本函数只返回建议，**绝不写 config_store**；超 20% 需人工确认回调至 0.5。
 * @param {number} delta - 拦截率变化绝对值
 * @param {number} [currentPass=0.6] - 当前 bantcc.pass
 * @returns {{action:'keep'|'suggest', change:boolean, threshold?:number, suggested?:number, note?:string}}
 */
export function recommendBantccThreshold(delta, currentPass = 0.6) {
  const d = Number(delta);
  if (!Number.isNaN(d) && d > 0.2) {
    return {
      action: 'suggest',
      change: true,
      current: currentPass,
      suggested: 0.5,
      note: '拦截率变化超 20%，建议回调 bantcc.pass 至 0.5；不自动改配置，需人工确认后调整 config_store[\'sales-thresholds\']',
    };
  }
  return { action: 'keep', change: false, threshold: currentPass };
}
