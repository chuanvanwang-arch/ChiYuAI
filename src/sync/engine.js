// src/sync/engine.js — 同步内核（runOnce）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01 + §T04（L3 回写分支）
// 职责：read（provider）→ map（mapping）→ upsert（resolver 幂等）→ 计数（created/updated/skipped）
//       L3 额外：writeback（callWriteback 注入的回写函数 → 白名单字段 → 字段级 CAS）
// 幂等前提：resolver.upsert 按 external_id 对齐，二次同步不新建粒子
export function createSyncEngine({ provider, mapping, resolver, cursor, trust = { level: () => 'L1' }, callWriteback } = {}) {
  async function runOnce({ object, tenantId = 'system', decisionId = null } = {}) {
    if (!provider) return { ok: false, error: 'provider_missing' };
    const auth = await provider.verifyAuth().catch(() => ({ ok: false }));
    if (!auth?.ok) return { ok: false, error: `verifyAuth_failed: ${auth?.error || 'unknown'}` };
    // 信任分级闸：L1 只读 → 不 upsert（仅 read 计数）；L2 批量入库；L3 = L2 + 回写
    const level = await trust.level(tenantId);
    const allowWrite = level === 'L2' || level === 'L3';
    const allowWriteback = level === 'L3';
    const cur = await cursor.get({ tenantId, provider: provider.kind || 'mock', object }).catch(() => null);
    // ⚠ 必须传 object：描述符按对象声明（§9.3 objects[]），provider 需据此定位查询目标
    // ⚠ 去假健康（2026-09-16 P0-2）：provider 失败必须留痕并短路返回。
    //   旧实现 `.catch(() => ({ rows: [], cursor: null }))` 吞掉异常 + 不检查 `ok:false`
    //   → counts.read=0 且 last_status='ok' →「同步在跑」与「一条都没读到」不可区分（F2）。
    let inc;
    try {
      inc = await provider.readIncremental({ object, cursor: cur?.cursor_value || null });
    } catch (e) {
      inc = { ok: false, error: String(e?.message || e) };
    }
    if (inc?.ok === false) {
      const errMsg = String(inc.error || 'read_failed');
      const zeroCounts = { read: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0 };
      // 只读路径同样落 failed：L1 也不是「可以静默失败」的理由
      await cursor.set({
        tenantId, provider: provider.kind || 'mock', object,
        counts: zeroCounts, status: 'failed', error: errMsg,
        cursor: cur?.cursor_value || null, decisionId,
      }).catch(() => {});
      return { ok: false, error: errMsg, ...zeroCounts };
    }
    const read = (inc.rows || []).length;
    const counts = { read, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0 };
    if (!allowWrite) {
      await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, decisionId });
      return { ok: true, ...counts, readOnly: true };
    }
    for (const row of inc.rows || []) {
      const m = mapping.apply(object, row);
      if (!m.ok) { counts.skipped++; continue; } // 映射失败（未知对象/字段）计入 skipped
      // 外部 id 优先取映射声明的 identity.external_id_field（§9.1；如纷享 _id），回退通用名（零回归）
      const extId = m.external_id || row.id || row.external_id;
      if (!extId) { counts.skipped++; continue; }
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
    await cursor.set({ tenantId, provider: provider.kind || 'mock', object, counts, status: 'ok', error: null, cursor: inc.cursor, decisionId });
    return { ok: true, ...counts, readOnly: false };
  }
  return { runOnce };
}
