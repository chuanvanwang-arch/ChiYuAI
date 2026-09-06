// src/sales/namedAccountAssign.js — 指名客户分配派生 + 应访日/告警状态纯函数（零 DB，浏览器 + vitest 共用）
// 设计：docs/2026-08-30-named-account-manage-design.md §1
// 契约：namedOwnerOf/namedStateOf/namedTierOf 供分配读取；visitDueAt 供应访日判定；
//       namedVisitStatus 供页面/定时扫描消费（红/黄/绿）。阈值 100% 经 readThreshold 读配置（零硬编码）。
import { visitTargetFor, visitDueAt } from './namedAccountTargets.js';
import { readThreshold } from './salesThresholds.js';

// re-export：visitDueAt 实现归属 namedAccountTargets（档位-窗口逻辑），
// 但对本模块契约（供应页面/定时扫描应访日判定）保持对外可见。
export { visitDueAt };

// 分配负责人：named_owner 优先，回退 owner_id/owner（向后兼容旧数据）
// 兼容历史/测试数据把分配信息存在 payload.payload 嵌套中的情况（namedAccountBoard 过滤链需要命中）
export function namedOwnerOf(payload = {}) {
  const nested = payload.payload || {};
  return payload.named_owner || payload.owner_id || payload.owner
      || nested.named_owner || nested.owner_id || nested.owner || null;
}

// 分配状态：缺省 active（旧数据视为指名）
export function namedStateOf(payload = {}) {
  const nested = payload.payload || {};
  return payload.named_state || nested.named_state || 'active';
}

// 档位：named_tier 优先，回退 payload.tier，再回退默认潜力（保守）
export function namedTierOf(payload = {}) {
  const nested = payload.payload || {};
  return payload.named_tier || nested.named_tier || payload.tier || nested.tier || '潜力';
}

// 告警状态：绿(pass, alert=null) / 黄(yellow) / 红(red)
// 阈值：coverage.named_visit_warn_days（默认1）/ named_visit_alert_days（默认2），经 readThreshold 读 sales-thresholds
export function namedVisitStatus(payload = {}, tier, targets, thresholds = {}) {
  const tv = visitTargetFor({ ...payload, tier }, targets);
  if (tv.pass) return { ...tv, pass: true, alert: null, overdueDays: 0, dueAt: null };
  const due = visitDueAt(payload, tier, targets);
  const overdueDays = Math.max(0, Math.floor((Date.now() - due.getTime()) / 86400000));
  const warnDays = readThreshold(thresholds, 'coverage.named_visit_warn_days', 1);
  const alertDays = readThreshold(thresholds, 'coverage.named_visit_alert_days', 2);
  if (overdueDays >= alertDays) return { ...tv, pass: false, alert: 'red', overdueDays, dueAt: due.toISOString() };
  if (overdueDays >= warnDays) return { ...tv, pass: false, alert: 'yellow', overdueDays, dueAt: due.toISOString() };
  return { ...tv, pass: false, alert: null, overdueDays, dueAt: due.toISOString() };
}