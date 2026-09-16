// src/connectors/discovery/tenantInstances.js
// 读 config_store['integration-providers']（per-tenant）→ 按 kind 实例化通用适配器。
// 刻意不反向 import providerRegistry（防静态环）；由 discoveryOrchestrator 把本函数注入 deps.loadTenantAdapters。
// 描述符解释权归 src/connectors/discovery/providerDescriptor.js（A-B1 单一事实源）——本文件不再自行解析字段。
import { resolveCredentials } from './credentialVault.js';
import { normalizeProviderDescriptors } from './providerDescriptor.js';
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
  // A-B1：统一归一化（扩 objects[]/token_mode/trust_level），非法项进 issues 不静默
  const { descriptors, issues } = normalizeProviderDescriptors((row && row.value) || null);
  if (issues.length && typeof deps.emit === 'function') {
    deps.emit('trace', 'integration-providers-invalid', { tenant_id: tenantId, issues });
  }
  const creds = await resolveCreds({ tenantId, providerIds: descriptors.map((d) => d.id), deps }).catch(() => ({}));
  const out = [];
  for (const d of descriptors) {
    if (!d.enabled) continue;
    const factory = factories[d.kind];
    if (!factory) {
      // 未知 kind 跳过（不抛，防扫描中断）；但**留痕**，否则"配了却不生效"无人知晓
      if (typeof deps.emit === 'function') deps.emit('trace', 'integration-kind-unknown', { tenant_id: tenantId, id: d.id, kind: d.kind });
      continue;
    }
    out.push(factory({ ...d, credentials: creds[d.id] || null }));
  }
  return out;
}
