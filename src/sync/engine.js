// src/sync/engine.js — 同步内核（runOnce）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01
// 职责：read（provider）→ map（mapping）→ upsert（resolver 幂等）→ 计数（created/updated/skipped）
// 幂等前提：resolver.upsert 按 external_id 对齐，二次同步不新建粒子
export function createSyncEngine({ provider, mapping, resolver, cursor, trust = { level: () => 'L1' } } = {}) {
  async function runOnce({ object, tenantId = 'system' } = {}) {
    if (!provider) return { ok: false, error: 'provider_missing' };
    const auth = await provider.verifyAuth().catch(() => ({ ok: false }));
    if (!auth?.ok) return { ok: false, error: `verifyAuth_failed: ${auth?.error || 'unknown'}` };
    // 信任分级闸：L1 只读 → 不 upsert（仅 read 计数）
    const level = await trust.level(tenantId);
    const allowWrite = level === 'L2' || level === 'L3';
    const cur = await cursor.get({ tenantId, provider: provider.kind || 'mock', object }).catch(() => null);
    const inc = await provider.readIncremental({ cursor: cur?.cursor_value || null }).catch(() => ({ rows: [], cursor: null }));
    const read = (inc.rows || []).length;
    const counts = { read, created: 0, updated: 0, skipped: 0, conflicted: 0 };
    if (!allowWrite) {
      await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null });
      return { ok: true, ...counts, readOnly: true };
    }
    for (const row of inc.rows || []) {
      const extId = row.id || row.external_id;
      if (!extId) { counts.skipped++; continue; }
      const m = mapping.apply(object, row);
      if (!m.ok) { counts.skipped++; continue; } // 映射失败（未知对象/字段）计入 skipped
      const u = await resolver.upsert({
        tenantId, provider: provider.kind || 'mock', object,
        externalId: extId, particleType: m.particle_type, payload: m.payload,
      });
      if (u.created) counts.created++;
      else if (u.updated) counts.updated++;
      else counts.skipped++;
    }
    await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, cursor: inc.cursor });
    return { ok: true, ...counts, readOnly: false };
  }
  return { runOnce };
}
