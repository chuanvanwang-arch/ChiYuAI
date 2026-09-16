// src/sync/factory.js — 同步 provider 工厂（kind → 同步 provider 实例）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B3 + §9.3
// ⚠ 与 connectors/discovery/tenantInstances.js 的 KIND_FACTORY **刻意分离**：
//   那边是 enrich 适配器契约（enrich + coverageFields，供 runWaterfall 富化瀑布消费）；
//   这边是同步 provider 契约（verifyAuth/discoverObjects/readIncremental，供 sync engine 消费）。
//   两者混用会让 runWaterfall 调到无 enrich 的实例 → 富化链路回归。
//   计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md §1 判断 1
import { createFxiaokeProvider } from './fxiaoke.js';

// 通用 REST 同步 provider：零租户代码，差异全在 descriptor（endpoint / objects[] / 凭据）
// 契约对齐 provider.js：verifyAuth() / discoverObjects() / readIncremental({object, cursor})
export function createGenericRestSyncProvider(cfg = {}) {
  const { endpoint, token, objects = [] } = cfg;
  const cred = cfg.credentials || null;
  const authToken = token || (typeof cred === 'string' ? cred : cred?.token);
  const doFetch = cfg.__fetch || ((url, opts) => fetch(url, opts));

  async function verifyAuth() {
    if (!endpoint) return { ok: false, error: 'endpoint_missing' };
    if (!authToken) return { ok: false, error: 'credentials_missing' }; // fail-closed，零请求
    return { ok: true };
  }

  async function discoverObjects() {
    const a = await verifyAuth();
    if (!a.ok) return { ok: false, error: a.error };
    return { ok: true, objects: objects.map((o) => ({ name: o.name, label: o.label || o.name })) };
  }

  // 增量：按 since_field 游标查询；游标推进到本批最大 since（无新记录则保持原游标 → 幂等）
  async function readIncremental({ object, cursor = null } = {}) {
    const a = await verifyAuth();
    if (!a.ok) return { ok: false, error: a.error, rows: [], cursor };
    const def = objects.find((o) => o.name === object);
    if (!def) return { ok: false, error: `object_not_declared: ${object}`, rows: [], cursor };
    const since = def.since_field || 'updated_at';
    const url = `${endpoint}?object=${encodeURIComponent(object)}&${since}=${encodeURIComponent(cursor || '')}`;
    try {
      const resp = await doFetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!resp.ok) return { ok: false, error: `http_${resp.status}`, rows: [], cursor };
      const j = await resp.json();
      const rows = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
      const maxSince = rows.reduce((m, r) => {
        const v = r?.[since];
        return v && String(v) > String(m || '') ? v : m;
      }, null);
      return { ok: true, rows, cursor: maxSince || cursor };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), rows: [], cursor };
    }
  }

  return { kind: 'generic-rest', verifyAuth, discoverObjects, readIncremental };
}

export const SYNC_PROVIDER_FACTORY = {
  fxiaoke: createFxiaokeProvider,
  // 自研 / 其它套装：generic-rest 覆盖（设计 §6.1 A-B3「自研 CRM 用 generic-rest 覆盖」）
  neocrm: createGenericRestSyncProvider,
  'generic-rest': createGenericRestSyncProvider,
};
