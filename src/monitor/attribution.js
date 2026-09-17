// src/monitor/attribution.js — 决策质量稽核台：写时物化 + 滞后回写核心（纯函数，可单测）
// 口径红线：required_fill 的「必填齐缺」判定复用 sevenDimensionsCheck 的 ctx[dim] 空值语义（单一事实源），
//   严禁再用 DIM_PREFIX 前缀匹配（旧覆盖体检口径）。conditions_evaluated 不进 required_fill 主判定。
import { sevenDimensionsCheck as defaultCheck } from '../sevenDimensions/engine.js';
import { EDGES, DEFAULT_EDGE_DIMENSION_SPEC } from '../decision/edgeDimensionSpec.js';
import { DEMO_EDGE_SOURCES, splitEdgesByCaliber } from '../decision/edgeSource.js'; // T0(BG-04) 边来源双口径

// T29 attribution.category 七态（金律19 四象限升级为七类根因；写时占位，根因计算时填充）
// 设计 full-traceability-root-cause-design.md §3.2 / §5(T29)
export const CATEGORY_STATES = [
  'ok', 'input_missing', 'inference_bias',                                   // 旧三态
  'FIELD_MISMATCH', 'INFO_INCOMPLETE', 'INPUT_STALE',                        // 粒子库三检
  'DIM_MISSING', 'EDGE_MISSING', 'NEED_DIM_ORDER', 'DATA_QUALITY_PRECEDENT', // M/K 层
  'UNKNOWN',
];

// T29 应连边推导（7×7 交叉校验语义，edgeDimensionSpec.js:88-94 既有声明）：
//   应连边 = 服务场景必填维度（required_dims）的边的并集。
//   如 required_dims=['identity','structure'] → 服务这两维的边 = [DECIDED_ON] = 该场景应连边。
//   无 requiredDims（空数组 / null）→ 返回 null（无应连边依据，不可判 E 缺）。
export function requiredEdgesForDims(requiredDims = null, spec = DEFAULT_EDGE_DIMENSION_SPEC) {
  const dims = Array.isArray(requiredDims) ? requiredDims : null;
  if (!dims) return null;
  const dimSet = new Set(dims.map((d) => (typeof d === 'string' ? d : d?.dim)).filter(Boolean));
  if (dimSet.size === 0) return [];
  return spec
    .filter((r) => {
      const served = Array.isArray(r.serves_dimension) ? r.serves_dimension : [r.serves_dimension];
      return served.some((d) => dimSet.has(d));
    })
    .map((r) => r.edge_type);
}

// T29 E1-E7 边合规（设计 §5 三元组语义）：
//   输入 actualEdgeTypes（决策实存 rel_type）+ requiredEdges（该决策「应连」边集，来自 edgeDimensionSpec 绑定）。
//   requiredEdges 缺省时按 requiredDims 自动推导（7×7 交叉校验：服务必填维的边 = 应连边）。
//   返回 { [edge_type]: 'present'|'missing', required_missing: string[], known: bool }
//     - [edge_type] 投影：实存边 present / 其余 missing（旧消费方兼容）
//     - required_missing：应连未连清单（仅当有应连边依据才可判定）
//     - known：是否具备应连边依据（无 requiredEdges 且无 requiredDims → known=false，E 缺不可判）
export function computeEdgeCompliance(actualEdgeTypes = [], { requiredEdges = null, requiredDims = null } = {}) {
  const actual = new Set(actualEdgeTypes || []);
  const out = {};
  for (const e of EDGES) out[e.key] = actual.has(e.key) ? 'present' : 'missing';
  const req = Array.isArray(requiredEdges)
    ? requiredEdges
    : (Array.isArray(requiredDims) ? requiredEdgesForDims(requiredDims) : null);
  if (Array.isArray(req)) {
    out.required_edges = req; // 应连边全清单（供消费方做分母/展示）
    out.required_missing = req.filter((k) => !actual.has(k));
    out.known = true;
  } else {
    out.required_edges = [];
    out.required_missing = [];
    out.known = false; // 无应连边依据 → E 缺不可判
  }
  return out;
}


// 写时物化：直接复用拦截引擎判定，不另算
// T-D4：category 取 CATEGORY_STATES；edge_compliance(E1-E7) 缺省全 missing，
//   传 decisionId 时查 decision_relation 实存边 → 对应 E present（供闭环巡检卡/closure）。
export async function computeAttribution({ scenario_id, trigger_context = {}, check = defaultCheck, query, decisionId = null, stale_particle_checks = null, tenantId = 'system' } = {}) {
  const { missing, required, level } = await check(scenario_id, trigger_context, { query, tenantId });
  const missingDims = new Set(missing.map((m) => m.dim));
  const provided = (required || [])
    .map((r) => (typeof r === 'string' ? r : r?.dim))
    .filter((d) => d && !missingDims.has(d));
  let category = missing.length === 0 ? 'ok' : 'input_missing';
  // 6.3 溯源④跳信息完整性检测：读 particle 三检结果（来自 traceRootCause.inspectParticlePayload），
  //   input_stale 命中且 required 已齐 → 升级 INPUT_STALE（输入不及时）；info_incomplete/field_mismatch 同样并入。
  //   优先级：field_mismatch > info_incomplete > input_stale（与 classifyRootCause 命中即止同序）
  const pc = stale_particle_checks || {};
  if (pc.field_mismatch) category = 'FIELD_MISMATCH';
  else if (pc.info_incomplete) category = 'INFO_INCOMPLETE';
  else if (pc.input_stale) category = 'INPUT_STALE';
  // 边合规：决策已存在时查实存边，否则全缺（写时物化路径无 decisionId）。
  // T0(BG-04)：仅认运行时真实边（排除 source='seed-script' 等演示/种子边），演示边不充真实边。
  let actualEdges = [];
  let edgeCaliber = { runtime: 0, demo: 0 };
  if (decisionId && query) {
    // to_id 已放宽为 TEXT（BG-03 方案 B），两侧列类型不同（from_id=uuid, to_id=text）；
    // 统一用 ::text 显式比较，避免 text = uuid 运算符不存在（与 relation.js:83-84 同模式）
    const rel = await query('SELECT rel_type, source FROM crm.decision_relation WHERE from_id::text=$1::text OR to_id::text=$1::text', [decisionId]);
    const { runtime, demo } = splitEdgesByCaliber((rel.rows || []));
    actualEdges = runtime.map((r) => r.rel_type);
    edgeCaliber = { runtime: runtime.length, demo: demo.length };
  }
  // T29-b：读场景 required_dims → 推导应连边（7×7 交叉校验语义）；fail-safe 空 → known=false
  let reqDims = [];
  if (scenario_id && query) {
    try {
      const sRes = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`, [scenario_id, tenantId]);
      reqDims = sRes.rows[0]?.required_dims || [];
      if (!Array.isArray(reqDims)) reqDims = [];
    } catch { reqDims = []; }
  }
  const edge_compliance = computeEdgeCompliance(actualEdges, { requiredDims: reqDims });
  return {
    required_fill: { provided, missing: missing.map((m) => m.dim) },
    category,
    accuracy_signal: 'pending',
    outcome_verified: null,
    level,
    edge_compliance,
    edge_caliber: edgeCaliber,
    computed_at: new Date().toISOString(),
  };
}

// 滞后回写：人工处置（即时判准否）
// T29 升级：人工推翻不再只回写 inference_bias/ok 旧三态，而是按 classifyRootCause R0-R3 同序推导七态：
//   ① 粒子三检命中 → FIELD_MISMATCH / INFO_INCOMPLETE / INPUT_STALE
//   ② L 维度缺 → DIM_MISSING；③ E 边缺（已查实，全 missing 仅未查不视为缺）→ EDGE_MISSING
//   ④ 全齐仍推翻 → inference_bias（兼容旧态，等价于 DATA_QUALITY_PRECEDENT 的推理侧）
// 人工确认 → ok（保持 accurate）。
// 防误判护栏：edge_compliance 全 missing = 「未查实边」而非「真缺失」——
//   computeAttribution 无 decisionId 时全 missing，喂分类器会把未查边误判 EDGE_MISSING；
//   故只在「至少查到 1 条 present」时才把 E 缺纳入推导。
import { classifyRootCause } from '../decision/rootCauseClassifier.js';

function hasRealEdgeMissing(edgeCompliance = {}) {
  // 设计 §5 语义：edge_compliance = 「E1-E7 应存/实存/缺」三元组。
  // 单纯 present/missing 投影不构成「应连未连」证据——决策可合理未连可选边；
  // 仅当显式携带 required_missing（应连未连清单）非空时才判定 E 缺。
  return Array.isArray(edgeCompliance?.required_missing) && edgeCompliance.required_missing.length > 0;
}

export function applyHumanDisposition(attribution, humanDisposition) {
  if (!attribution) return attribution;
  const a = JSON.parse(JSON.stringify(attribution));
  const overturned = humanDisposition === 'OVERRIDDEN' || humanDisposition === 'CORRECTED';
  const accurate = humanDisposition === 'CONFIRMED' || humanDisposition === 'APPROVED';
  if (overturned) {
    // 人工推翻 = usable=false + major=true（业务不可用且重大偏差）→ 走 R0 树
    // 已写时归七态（FIELD/INFO/INPUT/…）时保留原判定（更精细，不重算覆盖）；
    // 仍处旧三态（ok/input_missing/inference_bias）才按分类器推导。
    if (a.category && !['ok', 'input_missing', 'inference_bias'].includes(a.category)) {
      a.accuracy_signal = 'inaccurate';
      return a;
    }
    const cls = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: {
        required_fill: a.required_fill,
        edge_compliance: hasRealEdgeMissing(a.edge_compliance) ? a.edge_compliance : {},
      },
      particleChecks: a.particle_checks || {},
    });
    // classifyRootCause 对 L+E 全齐 + major 返回 DATA_QUALITY_PRECEDENT；
    // 但人工"推翻"语义在推理侧——全齐仍被推翻 = 推理偏差（兼容旧态 inference_bias）
    a.category = (cls.code === 'DATA_QUALITY_PRECEDENT')
      ? 'inference_bias'
      : cls.code;
    a.root_cause = cls.code !== 'UNKNOWN' ? cls : undefined;
  } else if (accurate) {
    a.category = 'ok';
  }
  a.accuracy_signal = overturned ? 'inaccurate' : 'accurate';
  return a;
}

// 滞后回写：业务结果（迟滞校验当初判得对不对）
export function applyOutcome(attribution, outcome) {
  if (!attribution) return attribution;
  const a = JSON.parse(JSON.stringify(attribution));
  a.outcome_verified = outcome || null;
  return a;
}
