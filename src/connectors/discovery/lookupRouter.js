// src/connectors/discovery/lookupRouter.js
// 意图路由处理器（设计 T2）：provider → providerRegistry 解析适配器 → 凭据注入 → search/enrich。
// 铁律：零 DB 写；fail-open（适配器异常/未启用 → 空结果，不抛业务异常）。
import { loadAdapters } from './providerRegistry.js';
import { resolveCredentials } from './credentialVault.js';

// 把适配器的 enrich fieldHit map（{ field: {value,confidence,provider} }）扁平成草稿 items
function flattenEnrich(out = {}) {
  return Object.entries(out).map(([field, v]) => ({
    field, value: v?.value, confidence: v?.confidence, provider: v?.provider,
  }));
}

export async function routeExternalLookup({ provider, kind = 'prospect', payload = {}, tenantId = 'system', deps = {} } = {}) {
  const load = deps.loadAdapters || loadAdapters;
  const resolve = deps.resolveCredentials || resolveCredentials;
  // 转发 override deps（readConfig 等）到 loadAdapters，使注入的配置覆盖（如单测显式启用付费源）
  // 真实生效；生产路径 deps 为空则走真实 config_store。否则 paid 源出厂 enabled:false 会被静默过滤。
  const loadDeps = {
    allowIds: [provider],
    registry: deps.registry,
    readConfig: deps.readConfig,
    writeConfig: deps.writeConfig,
    env: deps.env,
    loadTenantAdapters: deps.loadTenantAdapters,
  };

  const adapters = await load({ tenantId }, loadDeps);
  const adapter = adapters.find((a) => a.id === provider);
  if (!adapter) return { provider, kind, items: [], error: 'provider_not_enabled_or_unknown' };

  const credentials = await resolve({ tenantId, providerIds: [provider], deps });
  const ctx = { tenantId, credentials };

  if (kind === 'enrich') {
    const entity = payload.entity || {};
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    const out = await adapter.enrich(entity, fields, ctx).catch(() => ({}));
    return { provider, kind, items: flattenEnrich(out) };
  }

  // prospect（默认）：调 adapter.search（无 search 适配器跳过）
  const query = payload.icp || payload.query || payload;
  const list = typeof adapter.search === 'function'
    ? await adapter.search(query, ctx).catch(() => [])
    : [];
  return { provider, kind, items: list };
}
