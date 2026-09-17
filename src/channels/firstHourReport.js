// src/channels/firstHourReport.js — 需求② §4.7：Rox「价值前置第一小时」本土化
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.7（第一小时价值物 / 浮现纪律）
//
// 立论：接入后的**首个可见回报必须由系统主动交付**（而非等用户来问）——Rox 的可迁移洞察是
//   「用户还没意识到系统能做什么时，先把价值送上来」。故向导完成 → 用**本次真实汇入量**生成报告。
//
// 铁律（反假绿）：零导入**不伪装成功**——`has_data=false` 且文案明示「未接入或无数据」。
//   若零导入也渲染「已汇入 0 条，价值已交付」，用户会对一个空系统产生错误信任（比不交付更坏）。
// 纯函数：无 DB / 无 IO，单测零依赖。
export function buildFirstHourReport({ tenantId = 'system', imported = {}, accountsHit = [], window_days = 30 } = {}) {
  const entries = Object.entries(imported || {});
  const total = entries.reduce((a, [, n]) => a + (Number(n) || 0), 0);
  const byChannel = entries
    .filter(([, n]) => (Number(n) || 0) > 0)
    .map(([k, v]) => k + ':' + (Number(v) || 0));
  const accounts = Array.isArray(accountsHit) ? accountsHit : [];
  return {
    tenant_id: tenantId,
    title: '第一小时价值物',
    has_data: total > 0,
    summary: total > 0
      ? '过去 ' + window_days + ' 天已自动汇入 ' + total + ' 条通道事件（' + byChannel.join('、') + '），'
        + '命中 ' + accounts.length + ' 个既有客户' + (accounts.length ? '（' + accounts.join('、') + '）' : '')
        + '，已可查看客户 360 的「外部沟通维度」。'
      : '当前通道未接入或最近窗口内无数据——不影响核心功能，随时可补接。',
    accounts,
    by_channel: Object.fromEntries(entries.map(([k, v]) => [k, Number(v) || 0])),
    total,
    window_days,
    // 主动交付提示语（呈现层直接用，避免各页各自造句＝多源文案）
    headline: total > 0 ? '系统已替你把外部沟通接进图谱' : '尚未产生可展示的外部沟通数据',
  };
}
