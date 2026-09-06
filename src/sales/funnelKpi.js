// src/sales/funnelKpi.js — 漏斗转化率考核 KPI（设计 §4，监控/辅导层，非门禁）
//
// 设计 §4：转化率由 AI 计算（按 S 段跃迁事件统计），低于健康线标记预警，
//   由人（销售经理）辅导改善。阈值配置化（config_store['sales-thresholds'].funnelKpi，出厂默认取自行业基准）。
//
// 计算模型：对每条 S 段跃迁边（S1→S2 / S2→S3 / S3→S4 / S4→S5），
//   转化率 = 到达 to 的商机数 / 到达 from 的商机数；低于健康线 → warning（人辅导改善）。
// 本模块为纯计算（无 DB）；真实埋点（advanceStage 写阶段跃迁事件）由事件聚合层消费，本处只消费归一化输入。

import { S_STAGES } from './stageTaxonomy.js';

// 漏斗转化边（设计 §4 四边）
export const FUNNEL_EDGES = [
  { from: 'S1', to: 'S2' },
  { from: 'S2', to: 'S3' },
  { from: 'S3', to: 'S4' },
  { from: 'S4', to: 'S5' },
];

// 默认健康线（设计 §4）：S1→S2 ≥60% / S2→S3 ≥50% / S3→S4 ≥40% / S4→S5 ≥70%
export const DEFAULT_FUNNEL_KPI = Object.freeze({
  s1_s2: 0.6,
  s2_s3: 0.5,
  s3_s4: 0.4,
  s4_s5: 0.7,
});

// 某商机「已到达的阶段集合」：
//   - stagesReached：显式数组（最权威，直接采用）
//   - maxStage / stage：单值（当前所处阶段）→ 阶段有序递进，到达 Sx 即隐含经过 S1..Sx，
//     故展开为 S_STAGES 前缀（如 maxStage='S3' → ['S1','S2','S3']），否则漏斗上游边转化率恒为 0。
function stagesReachedOf(d) {
  if (Array.isArray(d.stagesReached)) return d.stagesReached;
  const single = d.maxStage || d.stage;
  if (single) {
    const idx = S_STAGES.indexOf(single);
    if (idx >= 0) return S_STAGES.slice(0, idx + 1);
    return [single]; // 非 S 码单值：原样（不做前缀展开假设）
  }
  return [];
}

function healthKey(e) {
  return `${e.from.toLowerCase()}_${e.to.toLowerCase()}`;
}

// 漏斗转化率计算
// @param {Array<{id:*, stagesReached?:string[], maxStage?:string, stage?:string}>} deals 商机阶段轨迹
// @param {{healthLines?:object}} [opts] healthLines 可覆盖默认健康线（key 如 's1_s2'）
// @returns {Object} 以 "S1->S2" 为键的每条边转化率与预警
export function funnelConversionRates(deals = [], opts = {}) {
  const health = opts.healthLines || DEFAULT_FUNNEL_KPI;
  const tally = {};
  for (const e of FUNNEL_EDGES) tally[`${e.from}->${e.to}`] = { from: 0, to: 0 };

  for (const d of deals) {
    const rs = stagesReachedOf(d);
    for (const e of FUNNEL_EDGES) {
      const key = `${e.from}->${e.to}`;
      if (rs.includes(e.from)) tally[key].from += 1;
      if (rs.includes(e.to)) tally[key].to += 1;
    }
  }

  const out = {};
  for (const e of FUNNEL_EDGES) {
    const key = `${e.from}->${e.to}`;
    const c = tally[key];
    const rate = c.from ? c.to / c.from : 0;
    const line = health[healthKey(e)] ?? 0;
    out[key] = {
      from: e.from,
      to: e.to,
      reachedFrom: c.from,
      reachedTo: c.to,
      rate,                       // 0~1
      healthLine: line,
      warning: rate < line,       // 低于健康线 → 预警（人辅导改善，非硬拦）
    };
  }
  return out;
}

// 汇总预警边（供看板标记）；返回 warning=true 的边列表
export function funnelKpiWarnings(result) {
  return Object.values(result || {}).filter((r) => r.warning);
}
