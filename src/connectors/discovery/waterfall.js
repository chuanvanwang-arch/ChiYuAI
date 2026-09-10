// src/connectors/discovery/waterfall.js
// 瀑布补缺口：成本升序 → 逐字段首命中即停
// **不取并集覆盖**：同字段只记最廉命中一次（对齐 Clay 成本语义；费用不重复消耗）
export async function runWaterfall(adapters, entity, fields, ctx = {}) {
  const values = {};
  const calls = [];
  let cost = 0;
  const ordered = [...(adapters || [])].sort((a, b) => (a?.costTier ?? 3) - (b?.costTier ?? 3));

  for (const field of fields || []) {
    if (values[field]) continue;
    for (const ad of ordered) {
      const call = { provider: ad.id, field };
      calls.push(call);
      try {
        const r = await ad.enrich(entity, [field], ctx);
        const hit = r && r[field] && r[field].value != null;
        if (!hit) continue;
        values[field] = { ...r[field], cost: r[field].cost ?? 0, ts: r[field].ts || new Date().toISOString() };
        cost += values[field].cost;
        break; // 首命中即停
      } catch (err) {
        call.error = String(err?.message || err); // 单源失败不中断整条瀑布（fail-open）
      }
    }
  }
  return { values, cost, calls };
}
