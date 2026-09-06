// src/decision/edgeDimensionSpec.js — 边↔维度规范（T1，纯函数，可单测）
// 命名体系：K 知识系统 / M 记忆系统（L1–L7 维度 + E1–E7 边）/ J 决策脊柱
// 单一事实源：7 边 × 7 维绑定。config_store['seven-dim'].edge_bindings（T32）可由配置覆盖默认映射。
// 中文名 + 一句话意思双双保留（用户硬要求：每个决策 7×7 巡检卡可读）。

// L1–L7 七维度（Oleg 七维度上下文模型）
export const DIMENSIONS = [
  { key: 'identity',           name: '身份',     meaning: '决策针对的业务实体是谁（客户/商机/报价）' },
  { key: 'structure',          name: '结构',     meaning: '决策对象的结构化属性是否齐备' },
  { key: 'semantics',          name: '语义',     meaning: '业务语义与上下文是否一致、无歧义' },
  { key: 'time_config',        name: '时间配置', meaning: '时效与时机窗口（决策是否在有效期内）' },
  { key: 'decision_history',   name: '决策历史', meaning: '是否引用了正确且有效的历史先例' },
  { key: 'operational_state',  name: '运行状态', meaning: '系统/业务当前运行状态是否支撑该决策' },
  { key: 'governance',         name: '治理',     meaning: '是否符合权限、合规与组织治理要求' },
];

// E1–E7 七决策边（设计 T2 定稿枚举）
export const EDGES = [
  { key: 'DECIDED_ON',             name: '针对',       meaning: '决策直接作用于某业务实体（客户/商机/报价）' },
  { key: 'REFERENCED_PRECEDENT',   name: '参考先例',   meaning: '决策引用了某历史先例作为依据' },
  { key: 'DERIVED_FROM_EXCEPTION', name: '由异常触发', meaning: '决策由某异常/告警事件触发升级' },
  { key: 'ESTABLISHES_FRAME',      name: '确立标杆',   meaning: '决策确立了一个新的判定框架/标杆' },
  { key: 'OVERRIDES',              name: '推翻翻案',   meaning: '后续决策推翻/覆盖本决策' },
  { key: 'CAUSED',                 name: '直接引发',   meaning: '决策直接引发了下游决策或业务动作' },
  { key: 'INFLUENCED',            name: '间接影响',   meaning: '决策间接影响了其他上下文（弱于参考先例）' },
];

// 默认边↔维度绑定（设计 T1 定稿；可被 config_store.edge_bindings 覆盖）
// serves_dimension 为多值数组；decision_relation.serves_dimension 单值列取 primaryDimension()。
export const DEFAULT_EDGE_DIMENSION_SPEC = [
  { edge_type: 'DECIDED_ON',             serves_dimension: ['identity', 'structure'],          direction: 'decision->entity' },
  { edge_type: 'REFERENCED_PRECEDENT',   serves_dimension: ['decision_history'],               direction: 'decision->decision' },
  { edge_type: 'DERIVED_FROM_EXCEPTION', serves_dimension: ['operational_state'],             direction: 'decision->exception' },
  { edge_type: 'ESTABLISHES_FRAME',      serves_dimension: ['semantics', 'governance'],       direction: 'decision->decision' },
  { edge_type: 'OVERRIDES',              serves_dimension: ['governance', 'decision_history'], direction: 'decision->decision' },
  { edge_type: 'CAUSED',                 serves_dimension: ['time_config'],                   direction: 'decision->decision' },
  { edge_type: 'INFLUENCED',             serves_dimension: ['time_config'],                    direction: 'decision->decision' },
];

export function loadEdgeDimensionSpec(override) {
  return (override && Array.isArray(override) && override.length) ? override : DEFAULT_EDGE_DIMENSION_SPEC;
}

// T32：从 config_store['seven-dim'].edge_bindings（value 形态）加载边绑定；
//   校验通过才采用，否则回退默认（fail-safe，绝不因错误配置阻断业务写边）。
//   value 即 config_store 行 value；可为 null/undefined/对象。
export function loadEdgeDimensionSpecFromConfig(value) {
  const eb = value && Array.isArray(value?.edge_bindings) && value.edge_bindings.length
    ? value.edge_bindings : null;
  if (!eb) return { loaded: false, spec: DEFAULT_EDGE_DIMENSION_SPEC, errors: ['未配置 edge_bindings'] };
  const v = validateEdgeDimensionSpec(eb);
  if (!v.valid) return { loaded: false, spec: DEFAULT_EDGE_DIMENSION_SPEC, errors: v.errors };
  return { loaded: true, spec: eb, errors: [] };
}

// 校验：7 边全覆盖 7 维、每维≥1 条边服务、无悬空边/悬空维
export function validateEdgeDimensionSpec(spec = DEFAULT_EDGE_DIMENSION_SPEC) {
  const dimKeys = new Set(DIMENSIONS.map((d) => d.key));
  const edgeKeys = new Set(EDGES.map((e) => e.key));
  const errors = [];
  const dimsServed = new Set();
  const seenEdges = new Set();

  for (const row of spec) {
    if (!edgeKeys.has(row.edge_type)) errors.push(`悬空边: ${row.edge_type} 不在 E1-E7`);
    if (seenEdges.has(row.edge_type)) errors.push(`重复边: ${row.edge_type}`);
    seenEdges.add(row.edge_type);
    const dims = Array.isArray(row.serves_dimension) ? row.serves_dimension : [row.serves_dimension];
    for (const d of dims) {
      if (!dimKeys.has(d)) errors.push(`悬空维: 边 ${row.edge_type} 指向未知维度 ${d}`);
      else dimsServed.add(d);
    }
  }
  for (const d of dimKeys) if (!dimsServed.has(d)) errors.push(`维度未被任何边服务: ${d}`);
  for (const e of edgeKeys) if (!seenEdges.has(e)) errors.push(`边缺失: ${e} 无绑定`);

  return { valid: errors.length === 0, errors };
}

// 取某边服务的主维度（用于 decision_relation.serves_dimension 单值列）
export function primaryDimension(edgeType, spec = DEFAULT_EDGE_DIMENSION_SPEC) {
  const row = spec.find((r) => r.edge_type === edgeType);
  if (!row) return null;
  const dims = Array.isArray(row.serves_dimension) ? row.serves_dimension : [row.serves_dimension];
  return dims[0] || null;
}

// 取某维度由哪些边服务（供 7×7 交叉校验：维度应有边支撑但边缺失 → ❌）
export function edgesServingDimension(dimKey, spec = DEFAULT_EDGE_DIMENSION_SPEC) {
  return spec.filter((r) => {
    const dims = Array.isArray(r.serves_dimension) ? r.serves_dimension : [r.serves_dimension];
    return dims.includes(dimKey);
  }).map((r) => r.edge_type);
}
