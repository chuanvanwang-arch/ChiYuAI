// src/agent/discoverySchema.js — 线索发现 payload 组装（P0#1：AI 属性 2D + glass-box why_narrative）
// 设计：docs/2026-09-10-lead-discovery-design.md §5（数据模型 2D）+ §4（C2 glass-box 推理链）
// 铁律：纯函数、零副作用、不触 DB、不新增粒子；无行业/租户字面量。
// 复用点：Task 7 orchestrator（import './discoverySchema.js'）、Task 15 glassBox、Task 16 monitorAccount。

// 知识资产分层（与 src/agent/agents.js:19 KG_LAYER_ORDER 同口径）
export const LAYERS = ['L1', 'L2', 'L3', 'L4'];

// 「本体同步」来源的 provider：其数据由 src/ontology/hooks.js:39 ontologySync 写时入图，
//   故 source 轴记 'ontologySync'（非 'provider_adapter'）。attio 为例（设计 §5 示例逐字）。
export const ONTOLOGY_SYNC_PROVIDERS = ['attio', 'ontologySync', 'native'];

const sourceOf = (v) => v.source || (ONTOLOGY_SYNC_PROVIDERS.includes(v.provider) ? 'ontologySync' : 'provider_adapter');

// 富集字段 2D：来源轴（provider / confidence / ts）+ 能力轴（layer / source）
export function buildEnrichmentPayload(fields, { ts } = {}) {
  const now = ts || new Date().toISOString();
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const layer = v.layer || 'L2';
    // 非法 layer 显式抛错：layer 决定 L1–L4 检索语义，静默改写 = 假绿
    if (!LAYERS.includes(layer)) throw new TypeError(`invalid layer: ${layer} (expected ${LAYERS.join('/')})`);
    out[k] = { ...v, ts: v.ts || now, layer, source: sourceOf(v) };
  }
  return out;
}

// 发现评分 2D：value（来源轴）+ judge（能力轴 axis/rule_ref/j_score），并产 glass-box why_narrative。
// ruleRef 可覆盖（scenario/ruler 由 decision_scenario 侧配置驱动，C1）。
export function buildDiscoveryPayload(fit, intent, signals, decisionId, { ruleRef = {} } = {}) {
  const refFit = ruleRef.fit || 'scenario:lead-fit#ruler:industry';
  const refIntent = ruleRef.intent || 'scenario:lead-fit#ruler:hiring';
  const list = Array.isArray(signals) ? signals : [];
  return {
    icp_fit_score: { value: fit, judge: { axis: 'capability', rule_ref: refFit, j_score: fit } },
    intent_score: { value: intent, judge: { axis: 'capability', rule_ref: refIntent, j_score: intent } },
    signals: list,
    why_narrative: `由 discovery scenario 判定为目标客户（rule_ref=${refFit}；decision_id=${decisionId}）；信号=${list.map((s) => s.type).join(',')}`,
  };
}
