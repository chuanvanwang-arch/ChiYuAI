// src/federation/scope.js — 1:N 读作用域解析（本方案唯一内核点）
// 设计：docs/2026-09-18-dealer-portal-design.md §13.2
// 纪律：
//   - 无联邦配置 / 功能总闸关闭 → 返回 [actorTenant]（与既有 scopeTenant 行为一致，纯自营零侵入）
//   - 跨租户写入恒由 particleRepo.cross_tenant_write_denied 物理拦截，本模块只解析「可读」集合
//   - 依赖注入：getFederation / isFeatureOn 可注入（单测无需 DB）；生产默认从 config.js 取

// 解析 actor 可读的 tenant_id 集合（数组）。
export async function federationReadScope(actorTenant, { getFederation, isFeatureOn } = {}) {
  const featureOn = isFeatureOn || (await import('./config.js')).isFeatureOn;
  // 平台级 kill-switch（feature:dealer-portal）关闭 → 全平台退化为单租户（零侵入最终闸）
  if (!(await featureOn())) return [actorTenant];
  const resolve = getFederation || (await import('./config.js')).getFederation;
  const fed = await resolve(actorTenant);
  if (!fed) return [actorTenant]; // 无联邦 → 仅自身（与 scopeTenant 一致）
  if (fed.vendor_tenant === actorTenant) {
    // 厂商视角：可读自身 + 所有 active 经销商
    return [actorTenant, ...fed.dealers.filter((d) => d.status === 'active').map((d) => d.dealer_tenant)];
  }
  const me = (fed.dealers || []).find((d) => d.dealer_tenant === actorTenant);
  if (me) return [actorTenant, fed.vendor_tenant]; // 经销商视角：可读自身 + 厂商 push 视图
  return [actorTenant];
}

// 判定 actor 是否可读取 targetTenant（联邦感知）。自身恒 true。
export async function canReadTenant(actorTenant, targetTenant, opts = {}) {
  if (actorTenant === targetTenant) return true;
  const scope = await federationReadScope(actorTenant, opts);
  return scope.includes(targetTenant);
}
