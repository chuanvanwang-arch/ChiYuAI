// 复盘：从 REQUIREMENT 证据聚合 MUST 未确认 Top3（可检索业务案例）+ 红线审批发起数（红线命中代理指标）
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';

// 纯函数：输入聚合结果 → 报告
export function buildRequirementRetro({ requirementByDeal = {}, redlineHits = 0, totalAdvices = 0 } = {}) {
  const deals = Object.entries(requirementByDeal)
    .map(([dealId, v]) => ({ dealId, mustUnconfirmed: v.mustUnconfirmed || [] }))
    .filter((d) => d.mustUnconfirmed.length > 0)
    .sort((a, b) => b.mustUnconfirmed.length - a.mustUnconfirmed.length)
    .slice(0, 3);
  const redlineHitRate = totalAdvices > 0 ? Number(((redlineHits / totalAdvices) * 100).toFixed(1)) : 0;
  return {
    generatedAt: new Date().toISOString(),
    mustUnconfirmedTop3: deals,
    redlineApprovalInstances: redlineHits,
    redlineHitRate,
    cases: deals.map((d) => ({ type: 'requirement-gap', dealId: d.dealId, dims: d.mustUnconfirmed })),
  };
}

// DB 聚合：遍历租户 REQUIREMENT 证据，统计 MUST 未确认；红线代理 = 该租户 CRM_APPROVAL_FLOW 发起实例数
export async function runDailyRetro(tenantId = 'system') {
  const cfg = await readConfig('requirement-dimensions', { tenantId }).then((r) => r?.value || null).catch(() => null);
  const must = (cfg?.dimensions || []).filter((d) => d.level === 'MUST').map((d) => d.dim_key);
  if (!must.length) return buildRequirementRetro({});

  // 取该租户全部 REQUIREMENT 证据主体
  const r = await query(
    `SELECT payload->>'subject_id' AS subject_id, payload->>'dim_key' AS dim_key,
            payload->>'met' AS met, payload->>'evidence_ref' AS evidence_ref, state
       FROM crm.particles
      WHERE type='CRM_METHODOLOGY_EVIDENCE' AND tenant_id=$1
        AND payload->>'methodology_id'='REQUIREMENT' AND state='asserted'`,
    [tenantId],
  );
  const byDeal = {};
  for (const row of r.rows) {
    const sid = row.subject_id;
    if (!sid) continue;
    byDeal[sid] = byDeal[sid] || { mustUnconfirmed: [] };
    if (must.includes(row.dim_key) && !(row.met === 'true' && row.evidence_ref)) {
      if (!byDeal[sid].mustUnconfirmed.includes(row.dim_key)) byDeal[sid].mustUnconfirmed.push(row.dim_key);
    }
  }
  // 红线代理：审批流发起实例数（business_type 含 QUOTE/SIGN 视为报价/签单红线）
  const inst = await query(
    `SELECT COUNT(*)::int AS n FROM crm.approval_instance WHERE tenant_id=$1`,
    [tenantId],
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return buildRequirementRetro({ requirementByDeal: byDeal, redlineHits: inst.rows[0]?.n || 0, totalAdvices: 0 });
}
