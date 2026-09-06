// src/http/middleware/rbac.js — RBAC 角色闸门（§15 权限重分组）
// 设计输入：docs/2026-09-04-param-propagation-hub-design.md §15（15.1 矩阵 / 15.3 路由闸门 / 15.4 别名映射）
// 用户决议：系统级仅 ADMIN；租户级 tan_admin+sysadmin+ADMIN（tan_admin 限本租户）；上下贯通（broadcast/tenant→system）强制 ADMIN。
// 纪律：
//   · 本模块只做角色判定与 HTTP 闸门，不查库（角色来自会话 token 的 resolveMe），保持纯函数可单测；
//   · 与决策第 0 闸（requireDecision）串行：先角色闸（本模块）、后决策闸（各写路由内）；
//   · 别名归一（§15.4）：实际角色枚举（admin/sales，历史 sys-admin/tenant-admin 变体）映射到
//     ADMIN/SYSADMIN/TAN_ADMIN 三档，不改传播中枢与业务路由逻辑。
import { resolveMe } from '../auth.js';

// 角色别名表：任何新别名只改此处（§15.4 单点归一）
const ROLE_ALIAS = {
  admin: 'ADMIN', ADMIN: 'ADMIN',
  sysadmin: 'SYSADMIN', 'sys-admin': 'SYSADMIN', SYSADMIN: 'SYSADMIN',
  tan_admin: 'TAN_ADMIN', 'tan-admin': 'TAN_ADMIN', 'tenant-admin': 'TAN_ADMIN', TAN_ADMIN: 'TAN_ADMIN',
  // 实际用户管理页角色名（2026-09-05 落地）：ten_admin（userManagement ROLE_TAGS）。
  // 计划缺陷 #12：漏此别名会 fail-closed 误杀真实租户管理员。
  ten_admin: 'TAN_ADMIN',
};

// 归一化：未知角色 → null（fail-closed，绝不模糊放行）
export function normalizeRole(role) {
  return ROLE_ALIAS[role] || null;
}

// 单角色判定：normalize 后精确相等（sysadmin ≠ ADMIN——系统级仅 ADMIN，档位不相通）
export function hasRole(me, required) {
  const r = normalizeRole(me?.role);
  return !!r && r === normalizeRole(required);
}

// 多角色判定；tan_admin 限本租户（指定 targetTenantId 时必须与会话租户一致，§15.1）
export function hasAnyRole(me, roles, { targetTenantId } = {}) {
  const r = normalizeRole(me?.role);
  if (!r) return false;
  if (r === 'TAN_ADMIN' && targetTenantId != null && me.tenantId !== targetTenantId) return false;
  return (roles || []).some((x) => normalizeRole(x) === r);
}

// §15.1 两档常量（调用方统一引用，避免各处散写字面量漂移）
export const SYSTEM_LEVEL_ROLES = ['ADMIN'];
export const TENANT_LEVEL_ROLES = ['tan_admin', 'sysadmin', 'ADMIN'];

function gateError(res, status, error) {
  res.status(status).json({ error });
}

// Express 中间件工厂：requireRole('ADMIN') —— 系统级/上下贯通闸
export function requireRole(role) {
  return (req, res, next) => {
    const me = resolveMe(req);
    if (!me?.ok) return gateError(res, 401, '未登录');
    if (!hasRole(me, role)) return gateError(res, 403, `需要 ${role} 权限`);
    next();
  };
}

// Express 中间件工厂：requireAnyRole(['tan_admin','sysadmin','ADMIN'], { targetTenantId }) —— 租户级闸
// targetTenantId 为常量时直接传字符串；需按请求取租户时传 (req) => tenantId 函数
export function requireAnyRole(roles, { targetTenantId } = {}) {
  return (req, res, next) => {
    const me = resolveMe(req);
    if (!me?.ok) return gateError(res, 401, '未登录');
    const target = typeof targetTenantId === 'function' ? targetTenantId(req) : targetTenantId;
    if (!hasAnyRole(me, roles, { targetTenantId: target })) {
      return gateError(res, 403, '需要 tan_admin(本租户)/sysadmin/ADMIN 权限');
    }
    next();
  };
}

// level → 角色策略映射表（§15 单一事实源）。
//   propagation（第三一级分组，传播中枢）：UI 上独立成组，但**权限等同系统级**——
//   §15.5 规定上下贯通（broadcast / tenant→system 推广）强制 ADMIN，若按租户级放行会让
//   sysadmin 触达传播中枢，属静默放宽。故显式映射为 ADMIN-only。
//   新增 level 必须在此登记；未登记的 level 一律 fail-closed（零信任），不静默降级为租户级。
export const LEVEL_ROLE_MAP = {
  system: { roles: ['ADMIN'], message: '系统级配置仅 ADMIN 可访问' },
  tenant: { roles: TENANT_LEVEL_ROLES, message: '租户级配置仅 tan_admin/sysadmin/ADMIN 可访问' },
  propagation: { roles: ['ADMIN'], message: '传播中枢（上下贯通）仅 ADMIN 可访问（§15.5）' },
};

// 注册表闸：以 configCenter.js CONFIG_ITEMS 为单一事实源（item.level + item.endpoint），
// 对命中端点的 GET/PUT/POST 统一施加 §15 闸门——覆盖配置中心全部带端点条目（含专用 Router 承载的面）。
// 未注册路径一律直通（不拦业务 API）；本闸先于各路由的第 0 决策闸（双闸串行）。
export function createConfigLevelGate(items, { resolve = resolveMe } = {}) {
  const levelByPath = new Map();
  for (const it of items || []) {
    if (it?.endpoint && it?.level) levelByPath.set(it.endpoint, it.level);
  }
  return (req, res, next) => {
    const level = levelByPath.get(req.path);
    if (!level) return next();
    const me = resolve(req);
    if (!me?.ok) return gateError(res, 401, '未登录');
    const policy = LEVEL_ROLE_MAP[level];
    if (!policy) {
      // 零信任 fail-closed：level 未登记 → 拒绝并要求先在 LEVEL_ROLE_MAP 登记
      return gateError(res, 403, `配置层级 "${level}" 未在 LEVEL_ROLE_MAP 登记（§15 零信任，拒绝放行）`);
    }
    const ok = hasAnyRole(me, policy.roles);
    if (!ok) return gateError(res, 403, policy.message);
    next();
  };
}
