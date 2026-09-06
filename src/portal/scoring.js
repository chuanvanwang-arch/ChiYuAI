// src/portal/scoring.js — 今日优先打分 + L2C 聚合（浏览器 ESM 与 vitest 共用单源）
export function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }

export function scoreDeal(d, decisions = 0) {
  const updated = d.updated_at ? new Date(d.updated_at).getTime() : Date.now();
  const idleDays = Math.max(0, (Date.now() - updated) / 86400000);
  const FIT = clamp((d.probability ?? 0.5) * 100);
  const TIMING = clamp(100 - idleDays * 4);
  const CONN = clamp((decisions / 5) * 100);
  const total = 0.3 * FIT + 0.4 * TIMING + 0.3 * CONN;
  return { FIT, TIMING, CONN, total: Math.round(total), idleDays };
}

export function suggestAction(s, stage) {
  if (s.idleDays > 30) return `已沉寂 ${Math.round(s.idleDays)} 天，建议发送唤醒邮件`;
  if (stage === '报价' && s.idleDays > 3) return '报价未跟进，推进合同签署';
  if (s.CONN < 40) return '关系薄弱，安排一次高层拜访';
  return '状态健康，按节奏推进下一阶段';
}

export function buildTodayPriority(deals, decisionsByDeal = {}) {
  return deals
    .map((d) => {
      const s = scoreDeal(d, decisionsByDeal[d.id] || 0);
      return { ...d, score: s, how: suggestAction(s, d.stage) };
    })
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, 3);
}

// ─── 销售管道六段（商机流，与 pipeline.html 同源）───────────
// 方案 B（用户拍板 2026-08-27）：首页 L2C 六段与管道页完全同源，按 DEAL.stage 计数。
// 2026-09-02 修复（S 码迁移漏改前端）：六段键从旧英文改为 S 码（与 src/sales/stageTaxonomy.js S_LABEL 对齐）。
// 浏览器 ESM 无法 import 后端模块 → 内联 S_ALIAS 映射（等价 S_ALIAS_FWD 语义）。
const S_ALIAS = {
  lead: 'S1', opportunity: 'S2', quoted: 'S3', contracted: 'S4', ordered: 'S5', paid: 'S6',
  lost: 'S7', disqualified: 'S8',
};
export const pipelineStages = [
  { key: 'S1', title: '线索发掘' },
  { key: 'S2', title: '需求确认' },
  { key: 'S3', title: '方案匹配' },
  { key: 'S4', title: '报价谈判' },
  { key: 'S5', title: '合同确认' },
  { key: 'S6', title: '赢单移交' },
];
export const LOST_STAGES = ['S7', 'S8'];
export function dealStageOf(p) {
  const raw = (p && p.payload && p.payload.stage) || 'S1';
  return S_ALIAS[raw] || raw; // 旧英文 → S 码；已是 S 码原样返回
}

// 六段计数：仅统计管道六段内的 DEAL（lost/disqualified 折叠不计入，与 pipeline.html 一致）
export function pipelineCounts(board) {
  const grouped = (board && board.grouped) || {};
  const deals = grouped.CRM_DEAL || [];
  return pipelineStages.map((st) => ({
    stage: st.title,
    count: deals.filter((p) => dealStageOf(p) === st.key).length,
  }));
}
// 兼容别名：l2cCounts ≡ pipelineCounts（方案 B 语义）
export const l2cCounts = pipelineCounts;

// ─── L2C 价值流派生指标（2026-08-29 completion plan Task 4）───────────
// 纯函数：输入 DEAL 粒子数组（shape 与 pipeline.html 同源：{payload:{stage,expected_amount|amount,probability},updated_at}），
// 输出六段 count/amount + 段间转化率 + 总览四联。口径对齐 §5.5：
//   - 缺省概率 prob=0.5
//   - inPipeline 排除 LOST_STAGES（lost/disqualified 不计入管道）
//   - 停滞阈值 >7 天（updated_at 距今）
// 零依赖、可在浏览器 ESM 与 vitest 共用单源（与 scoreDeal/buildTodayPriority 一致）。

function dealAmountOf(d) {
  const raw = d?.payload?.expected_amount ?? d?.payload?.amount;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
function dealProbOf(d) {
  const n = Number(d?.payload?.probability);
  return Number.isFinite(n) ? n : 0.5; // 缺省 0.5
}
const STALE_DAYS = 7;

export function pipelineMetrics(deals) {
  const list = Array.isArray(deals) ? deals : [];
  const now = Date.now();

  // 六段 count / amount
  const stages = pipelineStages.map((st) => {
    const inStage = list.filter((d) => dealStageOf(d) === st.key);
    const amount = inStage.reduce((s, d) => s + dealAmountOf(d), 0);
    return { key: st.key, name: st.title, count: inStage.length, amount };
  });

  // 段间转化率（长度 stages-1）：后段 count / 前段 count；前段为 0 → null
  const conversions = stages.slice(1).map((s, i) => {
    const prev = stages[i].count;
    return prev > 0 ? Math.round((s.count / prev) * 100) : null;
  });

  // 在管道内（排除 LOST_STAGES）
  const inPipe = list.filter((d) => !LOST_STAGES.includes(dealStageOf(d)));
  const inPipelineCount = inPipe.length;
  const totalAmount = inPipe.reduce((s, d) => s + dealAmountOf(d), 0);
  const weightedForecast = inPipe.reduce((s, d) => s + dealAmountOf(d) * dealProbOf(d), 0);
  const weightedWinRate = totalAmount > 0 ? Math.round((weightedForecast / totalAmount) * 100) : 0;

  // 停滞：>7 天未更新（且仍在管道内）
  const isStale = (d) => {
    const upd = d?.updated_at ? new Date(d.updated_at).getTime() : 0;
    return upd > 0 && (now - upd) / 86400000 > STALE_DAYS;
  };
  const staleDeals = inPipe.filter(isStale);
  const staleCount = staleDeals.length;
  const staleAmount = staleDeals.reduce((s, d) => s + dealAmountOf(d), 0);
  const staleAmountPct = totalAmount > 0 ? Math.round((staleAmount / totalAmount) * 100) : 0;

  // 胜率：末段(S6 赢单) / (末段 + 流失)；2026-09-02 修复：不再写死旧键 'paid'，跟随 pipelineStages 尾键
  const WIN_KEY = pipelineStages[pipelineStages.length - 1].key;
  const won = list.filter((d) => dealStageOf(d) === WIN_KEY).length;
  const lost = list.filter((d) => LOST_STAGES.includes(dealStageOf(d))).length;
  const winRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0;

  const avgDealAmount = inPipelineCount > 0 ? totalAmount / inPipelineCount : 0;

  return {
    stages, conversions,
    inPipelineCount, totalAmount, weightedForecast, weightedWinRate,
    staleCount, staleAmountPct, winRate, avgDealAmount,
  };
}
