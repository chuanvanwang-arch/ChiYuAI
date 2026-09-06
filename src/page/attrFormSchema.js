// src/page/attrFormSchema.js — 组合层：粒子属性 → 受控表单 Schema（单一出口，角色权限预解析）
// 设计输入：docs/2026-08-26-particle-attr-ui-patch-design.md §3.2（缺口1 组合层预解析）
// 权限解析在组合层（可异步接触 DB）；渲染器保持纯函数/同步，仅消费 comp.hidden/comp.readonly
import { listMetaAttr } from '../metaAttr/metaAttrRepo.js';
import { modeFor } from '../metaAttr/fieldPermission.js';

// 产出受控表单 Schema：每个启用属性用既有 modeFor 解析角色权限（hidden/readonly），不新写权限逻辑
export async function buildAttrFormSchema(particleType, roleTag) {
  const rows = await listMetaAttr({ particleType, enabled: true });
  const components = rows.map((rec) => {
    const mode = modeFor(rec, roleTag);
    return {
      kind: 'attr-field',
      attrSlug: rec.attr_slug,
      attrType: rec.attr_type,
      label: rec.title,
      hidden: mode === 'hidden',
      readonly: mode === 'readonly',
    };
  });
  return {
    type: 'form',
    title: `${particleType} 属性表单`,
    navigation: { to: '/workspace' },
    layout: { columns: 1, theme: 'light' },
    components,
  };
}
