// src/http/tenantScope.js — 读/写作用域解析（纯函数，便于单测）
// 设计基线：docs/2026-08-31-multi-tenant-design.md（system=种子租户；admin 跨租户通配）
// 读作用域：admin（sysadmin）跨租户通配 '*'；普通用户取自身租户；缺省回退种子租户 'system'
export function scopeTenant(me) {
  if (me && (me.role === 'admin' || me.role === 'sysadmin')) return '*';
  return (me && me.tenantId) || 'system';
}
// 写作用域：永远取自身租户（写不跨租户）；admin 也写自身所属租户（system），
// 绝不能写 '*'（否则粒子落进无人读取的通配租户）
export function scopeOf(me) {
  return (me && me.tenantId) || 'system';
}
// 读作用域覆写（2026-09-04 租户筛选器）：admin/sysadmin 可经 ?tenant= 显式收窄到某租户
// 复用 calibrationRouter.js:177 既有 ?tenant_id= 先例。普通用户的 ?tenant 一律忽略（不可越权）。
//   - base!=='*'（普通用户）→ 早返自身租户，SQL 仍用其 tenant_id
//   - admin 且 ?tenant 缺省/'all'/'*' → '*'（全量，兼容现状）
//   - admin 且 ?tenant=<id> → 该租户（非法值仅返回空结果，安全，不会泄漏他租户）
export function applyTenantOverride(req, me) {
  const base = scopeTenant(me);
  if (base !== '*') return base;
  const t = req && req.query && req.query.tenant;
  if (!t || t === '*' || t === 'all') return '*';
  return String(t).trim();
}
