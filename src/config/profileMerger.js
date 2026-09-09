// src/config/profileMerger.js —— 一租户多行业画像合并层（纯函数，无外部依赖，不写库）
//
// 设计（方案 Y 嵌套 / 合并 C 静默覆盖）：
//   - 存储结构 v2：{ version:2, industries:[{id,label,prototypes,approvalDomains,calculations,assigned_*}], merge_meta }
//   - 消费点（resolvePrototype / isControlledPredicateConfig / runProfileCalculations）只认「扁平对象」
//     { prototypes, calculations, approvalDomains }，故 mergeProfile 把多 industries 合并成扁平对象返回，
//     下游三消费点零改动（design §4.3）。
//   - v1 兼容：value 无 industries 数组（旧单行业格式）时，mergeProfile 原样返回（.prototypes 已在顶层）。
//   - edgeTypes 真实挂在每个 prototype 内部（seed 例 CHEM_SUPPLIER.edgeTypes），合并自 prototype 级，
//     与 isControlledPredicateConfig 现有消费形态一致（design §3.2 行业级 edge_types 已按真实数据修正）。
//   - 同名类型合并规则 = C 静默覆盖：industries 按数组顺序，后者覆盖前者（不告警，仅记 conflict_keys）。
// 注意：本模块不 import particleModel（避免 configStore→profileMerger→particleModel 循环依赖）；
//   代码基线判断（PARTICLE_TYPES / CONTROLLED_PREDICATES）由消费点 resolvePrototype / isControlledPredicateConfig 负责，
//   本模块的 *InMerged 镜像函数只查询「已合并扁平对象」。

// 收集多个 industry 中重复出现的 prototype 类型名（被覆盖者）
function computeConflictKeys(industries) {
  const seen = new Set();
  const conflict = [];
  for (const ind of industries || []) {
    for (const k of Object.keys(ind.prototypes || {})) {
      if (seen.has(k) && !conflict.includes(k)) conflict.push(k);
      seen.add(k);
    }
  }
  return conflict;
}

// v1（无 industries 数组）→ 原样返回；v2 → 合并为扁平 { prototypes, calculations, approvalDomains }
export function mergeProfile(value) {
  if (!value || !Array.isArray(value.industries)) return value; // v1 兼容：顶层已有 prototypes
  const prototypes = {};
  const calculations = [];
  const approvalDomains = [];
  // 按数组顺序合并：后者覆盖前者（C 静默覆盖）
  for (const ind of value.industries) {
    if (ind && ind.prototypes) {
      for (const [k, v] of Object.entries(ind.prototypes)) prototypes[k] = v;
    }
    if (Array.isArray(ind?.calculations)) calculations.push(...ind.calculations);
    if (Array.isArray(ind?.approvalDomains)) approvalDomains.push(...ind.approvalDomains);
  }
  return { ...value, prototypes, calculations, approvalDomains };
}

// v1 → v2 升级（幂等起点）。rawValue 已是 v2 数组则原样返回。
export function migrateFromV1(rawValue, opts = {}) {
  if (rawValue && Array.isArray(rawValue.industries)) return { value: rawValue, upgraded: false };
  const v = rawValue || {};
  // 空画像（新租户尚未分配任何行业，rawValue 为 null 或 {}）：返回空 industries，
  // 等待首个模板追加；绝不以 templateId 生成占位 industry（否则首个 assign 会被误判幂等跳过）。
  if (Object.keys(v).length === 0) {
    return {
      value: { version: 2, industries: [], merge_meta: { last_merge_at: new Date().toISOString(), conflict_keys: [] }, meta: {} },
      upgraded: true,
    };
  }
  const meta = v.meta || {};
  const label = meta.industry_label || opts.fallbackLabel || 'legacy';
  const id = meta.template_id || opts.fallbackId || opts.fallbackLabel || 'legacy';
  const value = {
    version: 2,
    industries: [{
      id,
      label,
      prototypes: v.prototypes || {},
      approvalDomains: v.approvalDomains || [],
      calculations: v.calculations || [],
      assigned_at: v.assigned_at || null,
      assigned_from_template_id: meta.template_id || null,
      assigned_decision_id: v.decision_id || null,
    }],
    merge_meta: { last_merge_at: new Date().toISOString(), conflict_keys: [] },
    meta,
  };
  return { value, upgraded: true };
}

// 追加一个行业（克隆模板）。幂等：同 templateId 已存在则 skipped。
// 返回 { next, merge_meta, skipped }
export function assignIndustry(rawValue, { template, templateId, decisionId = null }) {
  const startLabel = (template?.meta?.industry_label) || templateId;
  const { value: base } = migrateFromV1(rawValue, { fallbackId: templateId, fallbackLabel: startLabel });
  if (base.industries.some((i) => i.id === templateId)) {
    return { next: base, merge_meta: base.merge_meta || { conflict_keys: [] }, skipped: true };
  }
  const entry = {
    id: templateId,
    label: startLabel,
    prototypes: template?.prototypes || {},
    approvalDomains: template?.approvalDomains || [],
    calculations: template?.calculations || [],
    assigned_at: new Date().toISOString(),
    assigned_from_template_id: templateId,
    assigned_decision_id: decisionId,
  };
  const industries = [...base.industries, entry];
  const conflict_keys = computeConflictKeys(industries);
  const merge_meta = { last_merge_at: new Date().toISOString(), conflict_keys };
  return {
    next: { version: 2, industries, merge_meta, meta: base.meta || {} },
    merge_meta,
    skipped: false,
  };
}

// 移除一个行业。不存在抛错（调用方转 400）。返回 { next, removed }
export function removeIndustry(rawValue, industryId) {
  if (!rawValue || !Array.isArray(rawValue.industries)) throw new Error('INVALID_PROFILE_NO_INDUSTRIES');
  const idx = rawValue.industries.findIndex((i) => i.id === industryId);
  if (idx < 0) throw new Error('INDUSTRY_NOT_FOUND:' + industryId);
  const removed = rawValue.industries[idx];
  const industries = rawValue.industries.filter((i) => i.id !== industryId);
  const next = {
    ...rawValue,
    industries,
    merge_meta: { ...(rawValue.merge_meta || {}), last_merge_at: new Date().toISOString(), conflict_keys: computeConflictKeys(industries) },
  };
  return { next, removed };
}

// 镜像 particleModel.resolvePrototype（仅查询合并后的扁平 value；代码基线判断由消费点负责）
export function resolvePrototypeInMerged(merged, type) {
  const proto = merged?.prototypes?.[type];
  return proto ? { source: 'config', ...proto, type } : null;
}

// 镜像 particleModel.isControlledPredicateConfig（仅查询合并后的扁平 value；代码基线由消费点负责）
export function isControlledPredicateInMerged(merged, edgeType) {
  const edgeTypes = Object.values(merged?.prototypes || {}).flatMap((p) => p.edgeTypes || []);
  return edgeTypes.includes(edgeType);
}
