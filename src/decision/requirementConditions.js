// src/decision/requirementConditions.js
// 需求分级证据采集（REQUIREMENT 方法论）。写证据是写操作 → 必须携带 decision_id（第 0 闸凭据）。
import { assertRequirementEvidence } from './methodologyEvidence.js';
import { loadMethodologyEvidence } from './methodologyEvidence.js';
import { readConfig } from '../config/configStore.js';

// dims: [{ dim_key, met, evidence_ref?, value? }]
export async function collectRequirementEvidence(subject_id, dims = [], {
  tenantId = 'system', assertedBy = null, decisionId = null, source = 'manual',
} = {}) {
  const out = [];
  for (const d of dims) {
    if (!d?.dim_key) continue;
    const ev = await assertRequirementEvidence({
      subject_id, dim_key: d.dim_key, met: d.met,
      value: d.value ?? null, source,
      evidence_ref: d.evidence_ref ?? null, asserted_by: assertedBy,
      tenantId, decision_id: decisionId,
    }).catch((e) => ({ error: String(e?.message || e) }));
    out.push(ev);
  }
  return out;
}

// followup-agent 采集 SHOULD/NICE 维度（非 MUST，不进体检红线，仅沉淀证据供复盘）
export async function collectFollowupRequirement(subject_id, dims = [], {
  tenantId = 'system', assertedBy = null, decisionId = null, source = 'auto',
} = {}) {
  return collectRequirementEvidence(subject_id, dims, { tenantId, assertedBy, decisionId, source });
}

// 把 MUST 需求维度注入条件体检：未确认(met!=true 或 无 evidence_ref) → requiredMissing → C 档
export async function buildRequirementConditions(dealId, tenantId = 'system') {
  if (!dealId) return { evalDimensions: [], facts: {} };
  const cfg = await readConfig('requirement-dimensions', { tenantId }).then((r) => r?.value || null).catch(() => null);
  const must = (cfg?.dimensions || []).filter((d) => d.level === 'MUST');
  if (!must.length) return { evalDimensions: [], facts: {} };
  const ev = await loadMethodologyEvidence({ subject_id: dealId, methodology_ids: ['REQUIREMENT'], tenantId }).catch(() => ({}));
  const evalDimensions = [];
  const facts = {};
  for (const d of must) {
    const cond = `REQUIREMENT:${d.dim_key}`;
    const e = ev[d.dim_key];
    evalDimensions.push({ cond, label: d.label || d.dim_key, weight: 10, required: true });
    // 满足 = met 为 true 且有书面出处（evidence_ref）
    facts[cond] = (e && e.met === true && e.evidence_ref) ? true : null;
  }
  return { evalDimensions, facts };
}

// 从配置读取 MUST 维度清单（供体检注入与采集入口提示使用）
export async function listMustDimensions({ tenantId = 'system' } = {}) {
  const r = await readConfig('requirement-dimensions', { tenantId }).then((x) => x?.value || null).catch(() => null);
  return (r?.dimensions || []).filter((d) => d.level === 'MUST');
}
