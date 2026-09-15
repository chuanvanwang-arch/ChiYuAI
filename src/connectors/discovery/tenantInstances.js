// src/connectors/discovery/tenantInstances.js
// 读 config_store['integration-providers']（per-tenant）→ 按 kind 实例化通用适配器。
// 刻意不反向 import providerRegistry（防静态环）；由 discoveryOrchestrator 把本函数注入 deps.loadTenantAdapters。
import { resolveCredentials } from './credentialVault.js';
import { genericRestAdapter } from './adapters/genericRest.js';
import { genericMcpAdapter } from './adapters/genericMcp.js';
import { genericCliAdapter } from './adapters/genericCli.js';

const KIND_FACTORY = {
  'generic-rest': genericRestAdapter,
  'generic-mcp': genericMcpAdapter,
  'generic-cli': genericCliAdapter,
};

export async function loadTenantAdapters(tenantId, deps = {}) {
  const read = deps.readConfig || (await import('../../config/configStore.js')).readConfig;
  const resolveCreds = deps.resolveCredentials || resolveCredentials;
  const factories = deps.genericFactories || KIND_FACTORY;
  const row = await read('integration-providers', { tenantId }).catch(() => null);
  const descs = (row && row.value) || [];
  const creds = await resolveCreds({ tenantId, providerIds: descs.map((d) => d.id), deps }).catch(() => ({}));
  const out = [];
  for (const d of descs) {
    if (!d.enabled) continue;
    const factory = factories[d.kind];
    if (!factory) continue; // 未知 kind 跳过（不抛，防扫描中断）
    out.push(factory({ ...d, credentials: creds[d.id] || null }));
  }
  return out;
}
