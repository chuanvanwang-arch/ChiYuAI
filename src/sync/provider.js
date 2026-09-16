// src/sync/provider.js — CrmProvider 契约 + 注册表
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T02（纷享适配器）
// 契约：每个 provider 实现 verifyAuth()/discoverObjects()/readIncremental({cursor}) / pullObject 四方法
export function createProviderRegistry({ providers = {} } = {}) {
  function get(kind) { return providers[kind] || null; }
  function kinds() { return Object.keys(providers); }
  // 校验 provider 契约齐备（不合规拒绝注册，fail-closed）
  function validate(kind, p) {
    if (!p || typeof p.verifyAuth !== 'function' || typeof p.discoverObjects !== 'function' || typeof p.readIncremental !== 'function') {
      return { ok: false, error: `provider ${kind} 契约不完整` };
    }
    return { ok: true };
  }
  return { get, kinds, validate };
}
