// src/sync/engine.js — 同步内核（runOnce）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01 + §T04（L3 回写分支）
// 职责：read（provider）→ map（mapping）→ upsert（resolver 幂等）→ 计数（created/updated/skipped）
//       L3 额外：writeback（callWriteback 注入的回写函数 → 白名单字段 → 字段级 CAS）
// 幂等前提：resolver.upsert 按 external_id 对齐，二次同步不新建粒子
export function createSyncEngine({ provider, mapping, resolver, cursor, trust = { level: () => 'L1' }, callWriteback } = {}) {
  async function runOnce({ object, tenantId = 'system' } = {}) {
    if (!provider) return { ok: false, error: 'provider_missing' };
    const auth = await provider.verifyAuth().catch(() => ({ ok: false }));
    if (!auth?.ok) return { ok: false, error: `verifyAuth_failed: ${auth?.error || 'unknown'}` };
    // 信任分级闸：L1 只读 → 不 upsert（仅 read 计数）；L2 批量入库；L3 = L2 + 回写
    const level = await trust.level(tenantId);
    const allowWrite = level === 'L2' || level === 'L3';
    const allowWriteback = level === 'L3';
    const cur = await cursor.get({ tenantId, provider: provider.kind || 'mock', object }).catch(() => null);
    const inc = await provider.readIncremental({ cursor: cur?.cursor_value || null }).catch(() => ({ rows: [], cursor: null }));
    const read = (inc.rows || []).length;
    const counts = { read, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0 };
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
      // L3 回写：把判定字段（白名单内的 AI 结论）写回客户侧（callWriteback 注入，带字段级 CAS）
      if (allowWriteback && typeof callWriteback === 'function') {
        const w = await callWriteback({
          tenantId, object, externalId: extId, particleId: u.particle_id,
          row, level, counts,
        }).catch(() => ({ ok: false }));
        if (w?.ok) counts.writeback++;
        else counts.conflicted++; // 回写失败（CAS 拒绝/外部已改）计入 conflicted，不静默
      }
    }
    await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, cursor: inc.cursor });
    return { ok: true, ...counts, readOnly: false };
  }
  return { runOnce };
}
