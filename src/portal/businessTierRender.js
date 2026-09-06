// src/portal/businessTierRender.js — businessTierRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 businessTier.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 businessTier.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/businessTier.js — 业务分级配置（第 18 项）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸）
// 设计输入：docs/superpowers/plans/2026-08-27-business-tier-config.md
// tier 取值：LEAD / NORMAL / HIGH；引擎 computeBusinessTier 按两维取高风险优先

export const TIER_RANK = { LEAD: 1, NORMAL: 2, HIGH: 3 };
export const VALID_DIMENSIONS = ['customer', 'project'];
export const VALID_TIERS = ['LEAD', 'NORMAL', 'HIGH'];

export function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

export function tierBadge(tier) {
  const cls = (tier || '').toLowerCase();
  return `<span class="tier-badge tier-${cls}">${tier || '—'}</span>`;
}

export function renderBusinessTier(rows = []) {
  if (!rows.length) {
    return `<div class="empty">尚未配置任何分级规则（DEAL=客户维×项目维 → 驱动自主边界）</div>`;
  }
  const trs = rows
    .map(
      (r) => `<tr class="business-tier-row">
        <td>${r.dimension}</td>
        <td>${r.dimension_value}</td>
        <td>${tierBadge(r.tier)}</td>
      </tr>`
    )
    .join('');
  return `<table class="tier-table">
    <thead><tr><th>维度</th><th>取值</th><th>分级</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}
