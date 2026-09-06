// src/http/particleDetail.js — 粒子详情组装（纯函数，供 GET /api/particles/:id 与页面共用）
// 设计输入：docs/specs/2026-08-25-12-data-origin-full-plan.md §7-2（前端数据来源展示）
// 契约：{ particle, outEdges, related } —— outEdges 透传 edgeType/meta（来源语义下游判定），
//        related 映射 target_id → 关联实体名（详情页展示关联与来源链路用）
export function buildParticleDetail(particle, outEdges, relatedParticles) {
  const related = {};
  for (const p of relatedParticles || []) {
    related[p.id] = p.payload?.name || p.payload?.title || `${p.type}:${p.id}`;
  }
  return {
    particle,
    outEdges: (outEdges || []).map(e => ({
      edgeType: e.edge_type ?? e.edgeType,
      targetType: e.target_type ?? e.targetType,
      targetId: e.target_id ?? e.targetId,
      meta: e.meta || {},
    })),
    related,
  };
}