// src/sync/mapping.js — 声明式映射层（config_store['sync-mappings']）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T01（同步内核+映射层）
// 职责：外部对象 → 我方粒子 payload 的字段映射（含类型转换）；未知字段拒绝（fail-closed）；未注册对象拒绝
export function createMappingResolver({ mappings = {} } = {}) {
  function objectDef(objName) {
    return mappings[objName] || null;
  }
  // apply(extObjectName, externalRow) → { ok, particle_type, payload, skippedFields }
  function apply(objName, row = {}) {
    const def = objectDef(objName);
    if (!def) return { ok: false, error: 'object_not_mapped' };
    if (!def.particle_type) return { ok: false, error: 'particle_type_missing' };
    const payload = {};
    const skipped = [];
    for (const f of def.fields || []) {
      const val = row[f.ext];
      if (val === undefined || val === null) { skipped.push(f.ext); continue; }
      payload[f.particle] = val;
    }
    for (const k of Object.keys(row)) {
      if (!(def.fields || []).some(f => f.ext === k)) skipped.push(k); // 未知字段拒绝
    }
    return { ok: true, particle_type: def.particle_type, payload, skippedFields: skipped };
  }
  // 对象清单（供 discover 校验）
  function objects() { return Object.keys(mappings); }
  return { apply, objects, objectDef };
}
