// src/federation/conflict.js — 冲突检测（G3 窜货/撞单 + G6 渠道归属，1:N 聚合）
// 设计：docs/2026-09-18-dealer-portal-design.md §13.4(3)
// 纪律：厂商侧只读聚合各经销商报备 → 同 territory 跨经销商命中 → 记 dealer-conflict-log（自动仲裁替代人工报备）
import { getFederation as _getFederation, addConflict as _addConflict } from './config.js';
import { listFederatedParticles as _listFederatedParticles } from './read.js';

function territoryOf(p) {
  return p?.payload?.territory || p?.payload?.attributes?.territory || null;
}

// 检测新报备与既有经销商报备的 territory 冲突。返回冲突记录或 null。
export async function detectTerritoryConflict(
  { vendorTenant, newProject, decisionId = null },
  { getFederation = _getFederation, listParticles = _listFederatedParticles, addConflict = _addConflict } = {},
) {
  if (!newProject?.territory || !newProject?.dealer_tenant) return null;
  const fed = await getFederation(vendorTenant);
  if (!fed) return null;
  // 排除自身，取其余 active 经销商租户
  const others = fed.dealers
    .filter((d) => d.status === 'active' && d.dealer_tenant !== newProject.dealer_tenant)
    .map((d) => d.dealer_tenant);
  if (!others.length) return null;
  const existing = await listParticles({ tenantIds: others, type: 'MFG_PROJECT', limit: 500 });
  const hits = existing.filter((p) => {
    if (p.payload?.state === 'lost') return false; // 已丢单不参与冲突
    return territoryOf(p) === newProject.territory;
  });
  if (!hits.length) return null;
  const other = hits[0];
  return addConflict({
    vendorTenant,
    conflict: {
      dealer_a: newProject.dealer_tenant,
      dealer_b: other.tenant_id,
      territory: newProject.territory,
      project_refs: [newProject.ref || `MFG_PROJECT#${newProject.slug}`, `MFG_PROJECT#${other.slug || other.id}`],
      type: 'territory_conflict',
    },
    decisionId,
  });
}
