// src/metaAttr/fieldPermission.js — 字段级 RBAC 判定（写闸第 2.5 闸；读侧 crm-field-permission Action 同源）
// 设计输入：docs/2026-08-26-particle-attribute-model-ui-design.md §6.3
import { getMetaAttr } from './metaAttrRepo.js';

// mode: editable | readonly | hidden（未配置角色 → editable）
export function modeFor(rec, roleTag) {
  return rec?.permission?.roles?.[roleTag] || 'editable';
}

// 逐字段判定（data-particle-update 的 patch 键逐个核）
export async function checkFieldPermission(particleType, attrSlug, roleTag, patch) {
  const rec = await getMetaAttr(particleType, attrSlug);
  const mode = modeFor(rec, roleTag);
  if (mode === 'hidden') {
    return { ok: false, gate: 'field_permission', mode, field: attrSlug, reason: `字段 ${attrSlug} 对角色隐藏` };
  }
  if (mode === 'readonly' && patch && Object.prototype.hasOwnProperty.call(patch, attrSlug)) {
    return { ok: false, gate: 'field_permission', mode, field: attrSlug, reason: `字段 ${attrSlug} 对角色只读` };
  }
  return { ok: true, mode, field: attrSlug };
}

// 批量：patch 所有键过一次闸；返回第一个违规
export async function checkPatchPermissions(particleType, patch, roleTag) {
  if (!patch || typeof patch !== 'object') return { ok: true };
  for (const slug of Object.keys(patch)) {
    if (['events', 'ai'].includes(slug) || slug.startsWith('ai.')) continue;   // 系统保留键不参与字段闸
    const v = await checkFieldPermission(particleType, slug, roleTag, patch);
    if (!v.ok) return v;
  }
  return { ok: true };
}