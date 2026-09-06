// src/sales/orderService.js — 订单状态机 + 状态看板（T3-9；设计 §G25：业务对象看板视图）
// 订单粒子 CRM_ORDER：{ order_no, deal_id, contract_id, amount, status: draft|confirmed|shipped|completed }
// 状态机：draft → confirmed → shipped → completed（单向前进；看板 = 状态分组聚合视图）
// 写时管线：推进走 crm-order-advance（confirm:critical 对齐 deal-advance）+ 看板 boardView 聚合
import { emit } from '../events/bus.js';

// —— 订单状态机（纯函数）：当前状态 → 目标状态 单向合法性 ——
// 铁律对齐 01 文档 line13（交易实体单向前进）：只允许 flow 顺序推进，回头 = 非法跃迁
const ORDER_FLOW = ['draft', 'confirmed', 'shipped', 'completed'];

// 允许的推进步（一次性一步；跨步/回退拒绝）
export function canAdvanceOrder(from, to) {
  const i = ORDER_FLOW.indexOf(from);
  const j = ORDER_FLOW.indexOf(to);
  if (i < 0 || j < 0) return { ok: false, reason: `未知状态: from=${from}, to=${to}` };
  if (j === i + 1) return { ok: true, next: to };
  if (j <= i) return { ok: false, reason: `订单单向前进：${from} → ${to} 为回退/同态（非法跃迁）` };
  return { ok: false, reason: `订单状态不可跨步：${from} → ${to}（只能逐步 ${ORDER_FLOW.join('→')}）` };
}

// —— 看板聚合（纯函数）：按 status 分组 → { count, amount } + 合计 ——
// G25 业务对象看板视图：订单按阶段分组呈现（draft/confirmed/shipped/completed 四桶 + total）
export function boardView(orders) {
  const buckets = Object.fromEntries(ORDER_FLOW.map((s) => [s, { count: 0, amount: 0 }]));
  for (const o of orders || []) {
    const st = buckets[o.status] ? o.status : 'draft'; // 未知状态归入 draft 桶（前端容错）
    buckets[st].count += 1;
    buckets[st].amount += Number(o.amount) || 0;
  }
  const total = {
    count: (orders || []).length,
    amount: (orders || []).reduce((s, o) => s + (Number(o.amount) || 0), 0),
  };
  return { buckets, total, flow: ORDER_FLOW };
}

// —— 写时管线：订单推进（单向闸 + 审计事件；持久化走 updateParticle）——
export async function advanceOrder({ order_id, to_status, transitionedBecause, tenantId = 'system', decisionId = null }) {
  const { getParticle, updateParticle } = await import('../particles/particleRepo.js');
  const order = await getParticle(order_id);
  if (!order) throw new Error(`ORDER 不存在: ${order_id}`);
  const check = canAdvanceOrder(order.payload.status, to_status);
  if (!check.ok) throw new Error(`订单推进拒绝: ${check.reason}`);
  const updated = await updateParticle(order_id, {
    patch: { status: to_status, transitioned_because: transitionedBecause, status_changed_at: new Date().toISOString() },
    requireDecisionId: decisionId,
  });
  emit('crm', 'order-advanced', { order_id, from: order.payload.status, to: to_status, reason: transitionedBecause });
  return updated;
}