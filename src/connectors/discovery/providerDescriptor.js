// src/connectors/discovery/providerDescriptor.js — 线A A-B1：integration-providers 描述符归一化（单一事实源）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B1 + §9.3
//
// 为什么必须单一事实源：同一份描述符被两处消费，且两处"必备字段"不同——
//   ① connectors/discovery/tenantInstances.js  enrich 适配器（field_map / signal_map / coverageFields）
//   ② sync/mount.js loadTenantSyncTargets      同步目标（objects[] / trust_level / token_mode）
// 若各自维护解析与缺省，就会出现"同名字段两套语义"。设计附录 E.2 对 A-B3 的更正（两个同名工厂）
// 正是此类风险的先例——**描述符的解释权只能有一处**。
//
// 三条铁律：
//   ① 未知 direction / 缺 name 的 object 一律**丢弃并记入 issues**（不猜、不静默）；
//   ② trust_level 非法 → null，由消费方按最严处理（绝不回落成宽松值）；
//   ③ 旧字段（id/kind/enabled/endpoint/field_map/signal_map/credentials）**原样透传**，零回归。
export const TRUST_LEVELS = Object.freeze(['L1', 'L2', 'L3']);
export const SYNC_DIRECTIONS = Object.freeze(['in', 'out']);

// 单个 objects[] 项 → 归一化形状（失败即 issue，不返回半成品）
export function normalizeSyncObject(raw, ctx = {}) {
  const where = `objects[${ctx.index ?? 0}]`;
  if (!raw || typeof raw !== 'object') return { issue: `${where}: not_an_object` };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { issue: `${where}: name_missing` };
  const dir = raw.direction === undefined || raw.direction === null || raw.direction === ''
    ? 'in' // 缺省入向（与设计 §9.3 示例一致；出向必须显式声明）
    : raw.direction;
  if (!SYNC_DIRECTIONS.includes(dir)) return { issue: `${where}(${name}): unknown_direction:${String(dir)}` };
  const out = { name, direction: dir };
  // 可选字段：仅在给出时落键（避免用 undefined 造出"存在但为空"的第三态）
  if (raw.cadence_min !== undefined && raw.cadence_min !== null) out.cadence_min = Number(raw.cadence_min);
  if (raw.mapping_ref) out.mapping_ref = String(raw.mapping_ref);
  if (raw.cursor) out.cursor = String(raw.cursor);
  if (raw.id_field) out.id_field = String(raw.id_field);
  if (raw.since_field) out.since_field = String(raw.since_field);
  return { value: out };
}

// 单个 provider 描述符 → 归一化形状；返回 { descriptor|null, issues[] }
export function normalizeProviderDescriptor(raw) {
  const issues = [];
  if (!raw || typeof raw !== 'object') return { descriptor: null, issues: ['descriptor: not_an_object'] };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!id) issues.push('descriptor: id_missing');
  if (!kind) issues.push(`descriptor(${id || '?'}): kind_missing`);
  if (!id || !kind) return { descriptor: null, issues }; // 无 id/kind 无法实例化 → 拒绝整个描述符

  const descriptor = { ...raw, id, kind }; // 旧字段原样透传（零回归）

  // A-B1 新增三字段
  descriptor.enabled = Boolean(raw.enabled);
  descriptor.token_mode = typeof raw.token_mode === 'string' && raw.token_mode.trim() ? raw.token_mode.trim() : null;
  if (raw.trust_level !== undefined && raw.trust_level !== null && !TRUST_LEVELS.includes(raw.trust_level)) {
    // 非法档位 → null（消费方按最严 L1 处理）；不静默改写成 L1 会造成"看起来配了、实际降级"
    issues.push(`descriptor(${id}): unknown_trust_level:${String(raw.trust_level)}`);
    descriptor.trust_level = null;
  } else {
    descriptor.trust_level = raw.trust_level ?? null;
  }

  // objects[]：非数组 → 空数组（既有无 objects[] 的描述符零行为变化）
  const rawObjects = Array.isArray(raw.objects) ? raw.objects : [];
  descriptor.objects = [];
  if (raw.objects !== undefined && !Array.isArray(raw.objects)) {
    issues.push(`descriptor(${id}): objects_not_array`);
  }
  rawObjects.forEach((o, i) => {
    const r = normalizeSyncObject(o, { index: i });
    if (r.issue) issues.push(`descriptor(${id}): ${r.issue}`);
    else descriptor.objects.push(r.value);
  });

  // event_subscription：缺省关闭（未知形状不假装开启）
  const es = raw.event_subscription;
  descriptor.event_subscription = {
    enabled: Boolean(es && typeof es === 'object' && es.enabled),
    objects: Array.isArray(es?.objects) ? es.objects.filter((x) => typeof x === 'string' && x.trim()) : [],
  };

  return { descriptor, issues };
}

// 描述符数组 → { descriptors, issues }（issues 供调用方留痕；**不得静默丢弃**）
export function normalizeProviderDescriptors(list) {
  const issues = [];
  if (!Array.isArray(list)) {
    if (list !== undefined && list !== null) issues.push('integration-providers: not_an_array');
    return { descriptors: [], issues };
  }
  const descriptors = [];
  list.forEach((d) => {
    const r = normalizeProviderDescriptor(d);
    issues.push(...r.issues);
    if (r.descriptor) descriptors.push(r.descriptor);
  });
  return { descriptors, issues };
}

// 入向对象（所有消费方共用同一判据；出向由回写通道消费，不进读入面）
// 判据与 normalizeSyncObject 的缺省一致：**缺 direction 即视为 in**。
// 容错是为调用方直接构造 targets（未经归一化）时保持向后兼容——判据只此一处，不得各自实现。
export function inboundObjects(descriptor) {
  return (descriptor?.objects || []).filter((o) => o?.name && (!o.direction || o.direction === 'in'));
}
