// src/page/permissionComposer.js — 角色权限预解析（渲染前把字段级权限编译成 attr-field 的 hidden/readonly/edit）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 5 + src/metaAttr/fieldPermission.js#modeFor
// 契约：composeAttrFields(particleType, role, fields, {recSource}) → fields 每项带 mode ∈ editable|readonly|hidden
//   recSource 默认异步查 metaAttr；测试可注入同步 recSource（纯逻辑无 DB）；未配置角色权限 → editable
import { getMetaAttr } from '../metaAttr/metaAttrRepo.js';
import { modeFor } from '../metaAttr/fieldPermission.js';

export async function composeAttrFields(particleType, role, fields, { recSource } = {}) {
  const src = recSource || (async (t, s) => getMetaAttr(t, s));
  const out = [];
  for (const f of fields || []) {
    const rec = await src(particleType, f.slug);
    const mode = modeFor(rec, role);
    out.push({ ...f, mode, permission: rec?.permission || null });
  }
  return out;
}