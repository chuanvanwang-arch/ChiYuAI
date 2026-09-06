// test/attr-form-schema.test.js — 组合层 buildAttrFormSchema：角色权限预解析 + renderPage 端到端（V3）
// 设计输入：docs/2026-08-26-particle-attr-ui-patch-design.md §3（缺口1 组合层预解析）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { seedMetaAttr, setMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { buildAttrFormSchema } from '../src/page/attrFormSchema.js';
import { renderPage } from '../src/page/renderer.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
  await seedMetaAttr('system');
});

describe('buildAttrFormSchema 角色权限预解析', () => {
  it('mode=hidden → 组件 hidden=true 且 renderPage 无 <input>', async () => {
    await setMetaAttr('CRM_DEAL', 'name', { permission: { roles: { finance: 'hidden' } } });
    const schema = await buildAttrFormSchema('CRM_DEAL', 'finance');
    const comp = schema.components.find((c) => c.attrSlug === 'name');
    expect(comp.hidden).toBe(true);
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="hidden"');
    expect(out.html).not.toContain('<input');
  });

  it('mode=readonly → 组件 readonly=true 且 renderPage 含 disabled input', async () => {
    await setMetaAttr('CRM_DEAL', 'name', { permission: { roles: { finance: 'readonly' } } });
    const schema = await buildAttrFormSchema('CRM_DEAL', 'finance');
    const comp = schema.components.find((c) => c.attrSlug === 'name');
    expect(comp.readonly).toBe(true);
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="readonly"');
    expect(out.html).toContain('<input');
    expect(out.html).toContain('disabled');
  });

  it('默认 editable → 无权限标记、正常 input', async () => {
    await setMetaAttr('CRM_DEAL', 'name', { permission: {} });
    const schema = await buildAttrFormSchema('CRM_DEAL', 'finance');
    const comp = schema.components.find((c) => c.attrSlug === 'name');
    expect(comp.hidden).toBe(false);
    expect(comp.readonly).toBe(false);
    const out = renderPage(schema, {});
    expect(out.html).not.toContain('data-perm');
    expect(out.html).toContain('<input');
  });
});
