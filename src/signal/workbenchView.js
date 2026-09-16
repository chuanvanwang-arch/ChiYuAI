// src/signal/workbenchView.js — 工作台第 7 视角（信号）处理器
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3（信号统一收口）+ §T14（视角/首页卡）
// 对齐 src/http/workbenchRouter.js buildViewRows 的既有视角 case 结构
export function buildSignalView({ store }) {
  return {
    async list({ tenant_id = 'system', status, kind } = {}) {
      const items = await store.list({ tenant_id, status, kind });
      return {
        items,
        open_count: items.filter(i => i.status === 'open').length,
        high_open: items.filter(i => i.status === 'open' && i.severity === 'high').length,
      };
    },
  };
}
