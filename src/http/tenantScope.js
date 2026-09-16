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

// 信号个人隔离作用域（T21，2026-09-16 用户指令「除管理外，需要进行个人隔离！」）
//
// 返回语义：
//   null                       → 全量视界（**仅管理**：admin/sysadmin 未显式收窄时）
//   { username, role }         → 只回「我负责的 或 无主同角色广播」的信号
//
// 为什么是单一函数而非在各消费点各写一遍：
//   本函数的判定结果直接决定「这个销售员能不能看到别人的客户信号」——属安全边界。
//   一旦 HTTP 端点与工作台视角各写一份（两者参数形态不同：req.query vs actor），
//   极易出现「修了一处、漏了另一处」的**部分假绿**（验收会通过）。故收敛为唯一事实源，
//   并由 test/http/signalOwnerScope.test.js 静态守卫两处消费点都调用它。
//
// ⚠ fail-closed：非管理员一律返回对象（即使 username 缺失也返回字符串空值），
//   绝不因"拿不到身份字段"退回 null（= 全量），那会把隔离变成泄漏。
//
// ⚠ 身份形态兼容（2026-09-16 实测踩坑）：两处调用点的 me 形状**不同**——
//   · HTTP 端点（routes.js）：resolveMe 返回 `{ username, role, tenantId }`（单数 role）
//   · 工作台视角（workbenchRouter.js）：currentActor 返回 `{ username, roles: [me.role], tenantId }`（复数数组）
//   若只读 `me.role`，工作台侧会取到 undefined → role 落 NULL → `target_role = NULL` 永假
//   → 连「无主同角色广播」都看不到（过度收窄，与 HTTP 侧行为不一致）。故此处统一归一为 roles 数组。
export function signalOwnerScope(me, { mine = false } = {}) {
  const roles = Array.isArray(me?.roles) ? me.roles : (me?.role ? [me.role] : []);
  const isAdmin = roles.includes('admin') || roles.includes('sysadmin');
  if (isAdmin && !mine) return null;
  return { username: (me && me.username) || '', role: roles[0] || null };
}
