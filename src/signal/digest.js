// src/signal/digest.js — 每日作战简报（对齐 Rox Daily Digest）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3（信号统一收口）+ 竞争学习 §P0-A（学习 Rox Inbox → 主动运行时 S1）
// 职责：按状态/严重度/角色聚合信号 → 每日简报结构（供工作台第 7 视角与首页信号卡消费）
export function buildDailyDigest(signals = []) {
  const by_role = {};
  for (const s of signals) {
    (by_role[s.target_role] ||= []).push(s);
  }
  return {
    open_high: signals.filter(s => s.status === 'open' && s.severity === 'high').length,
    open_medium: signals.filter(s => s.status === 'open' && s.severity === 'medium').length,
    open_low: signals.filter(s => s.status === 'open' && s.severity === 'low').length,
    open_total: signals.filter(s => s.status === 'open').length,
    acted_total: signals.filter(s => s.status === 'acted').length,
    by_role,
  };
}
