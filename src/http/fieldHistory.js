// src/http/fieldHistory.js — 审计字段历史投影（P1③ 纯函数，可注入测试）
// 设计（docs/2026-09-05-security-hardening-design.md §3.3）：
//   消费 crm.audit_event.payload（写通道必经，before/after 已留痕）；
//   price_change 场景 payload 已带 field/before/after（recordPriceChangeAudit 补 field 键）。
// 范围（YAGNI）：价格字段 list_price 起步；接口已支持任意 field 参数（通用 update 差分留待后续）。
export function projectFieldHistory(events, field) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => e?.payload && e.payload.field === field)
    .map((e) => ({
      before: e.payload.before ?? null,
      after: e.payload.after ?? null,
      reason: e.payload.price_change_reason || e.payload.reason || null,
      actor: e.actor ?? null,
      decision_id: e.decision_id ?? null,
      created_at: e.created_at ?? null,
    }))
    .sort((a, b) => (a.created_at > b.created_at ? 1 : -1)); // 时间线顺序（旧→新）
}
