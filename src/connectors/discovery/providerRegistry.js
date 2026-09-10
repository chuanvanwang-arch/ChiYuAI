// src/connectors/discovery/providerRegistry.js
// 注意：本模块 **不 import 任何 adapter 文件**（避免 Task 2 → Task 3 反向依赖）；
// 适配器在 Task 3 由各自模块加载时调用 registerProvider(id, factory) 自注册。
import { mergedDiscoveryRules } from '../../config/discoveryRules.js';

const REGISTRY = new Map();

export function registerProvider(id, factory) {
  if (!id || typeof factory !== 'function') throw new Error('registerProvider(id, factory) 参数非法');
  REGISTRY.set(id, factory);
  return factory;
}
export function listProviderIds() { return [...REGISTRY.keys()]; }
export function _resetRegistry() { REGISTRY.clear(); }

// 纯函数：enabled 过滤 → allowIds 过滤 → costTier 升序 → 实例化（零 IO，单测友好）
export function resolveAdapters(rules, { allowIds, registry = REGISTRY } = {}) {
  const providers = Array.isArray(rules?.providers) ? rules.providers : [];
  return providers
    .filter((p) => p && p.enabled && registry.has(p.id))     // 未注册 / disabled（付费源出厂 false）一律跳过
    .filter((p) => !Array.isArray(allowIds) || allowIds.includes(p.id))
    .slice()
    .sort((a, b) => (a.costTier ?? 3) - (b.costTier ?? 3))   // cheapest-first
    .map((p) => registry.get(p.id)(p));
}

// 租户感知加载：config_store['discovery-rules']（per-tenant）⊕ 出厂默认
export async function loadAdapters({ tenantId = 'system' } = {}, deps = {}) {
  const rules = await mergedDiscoveryRules({ tenantId }, deps);
  return resolveAdapters(rules, { allowIds: deps.allowIds, registry: deps.registry });
}
