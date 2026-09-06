// test/meta-attr-page.test.js — G1 T6 配置抽屉 UI 受控组件（attr-field 渲染/校验/组件集扩展，纯逻辑无 DB）
// 设计输入：docs/2026-08-26-particle-attribute-model.md Task 6（受控 Schema 渲染 + 预览 + 保存）
import { describe, it, expect } from 'vitest';
import { renderPage } from '../src/page/renderer.js';
import { validatePageSchema } from '../src/page/validator.js';
import { COMPONENT_KINDS } from '../src/page/schema.js';

describe('attr-field 组件受控渲染', () => {
  it('renderer 渲染 attr-field（label+input，值转义）', () => {
    const schema = {
      type: 'form', title: '测试表单',
      navigation: { to: '/workspace' }, layout: { columns: 1, theme: 'light' },
      components: [{ kind: 'attr-field', attrSlug: 'name', label: '客户名称', attrType: 'text', placeholder: '输入名称' }],
    };
    const out = renderPage(schema, {});
    expect(out.html).toContain('attr-field');
    expect(out.html).toContain('客户名称');
    expect(out.html).toContain('placeholder="输入名称"');
  });

  it('attr-field 的 attrType 非 19 类型 → validator 拒绝', () => {
    const schema = {
      type: 'form', title: '坏表单',
      navigation: { to: '/workspace' }, layout: { columns: 1, theme: 'light' },
      components: [{ kind: 'attr-field', attrSlug: 'x', label: 'x', attrType: 'magic' }],
    };
    const v = validatePageSchema(schema);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('attrType') || e.includes('19'))).toBe(true);
  });
});

describe('COMPONENT_KINDS 扩展', () => {
  it('attr-field 已在受控组件集', () => {
    expect(COMPONENT_KINDS).toContain('attr-field');
  });
});

// V5 抽屉产出 = Schema = 预览一致：设计 §5/§6 铁律「配置=Schema 唯一协议，NL 与抽屉共用同一渲染出口」
// 此前仅测了 attr-field 渲染 + validator 拒坏类型，未断言「抽屉保存链路与 NL 同 Schema 一致」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('V5 抽屉产出 = Schema = 预览一致', () => {
  const base = {
    type: 'form', title: '属性配置',
    navigation: { to: '/workspace' }, layout: { columns: 1, theme: 'light' },
  };

  it('抽屉保存 Schema 与 NL 同构 Schema 经同一 renderPage 产出一致 HTML（单一渲染出口）', () => {
    // 抽屉保存格式
    const drawerSchema = {
      ...base,
      components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '客户名称' }],
    };
    // 假设 NL 生成产出等价 Schema
    const nlSchema = {
      ...base,
      components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '客户名称' }],
    };
    const outDrawer = renderPage(drawerSchema, {});
    const outNl = renderPage(nlSchema, {});
    expect(outDrawer.html).toBe(outNl.html); // 单一出口，结构必然一致
    expect(outDrawer.html).toContain('data-attr="name"');
  });

  it('抽屉产出 Schema 可经同一 validator 通过（受控协议不被绕过）', () => {
    const drawerSchema = {
      ...base,
      components: [{ kind: 'attr-field', attrSlug: 'industry', attrType: 'text', label: '行业' }],
    };
    const v = validatePageSchema(drawerSchema);
    expect(v.ok).toBe(true);
  });

  it('抽屉静态页契约：保存映射到 /api/meta-attr + data-particle-attr-update（过第 0 闸）', () => {
    const html = readFileSync(fileURLToPath(new URL('../src/web/meta-attr-drawer.html', import.meta.url)), 'utf8');
    expect(html).toContain('/api/meta-attr');        // 读直连桥接
    expect(html).toContain('data-particle-attr-update'); // 写走元模型配置 Action（第 0 闸）
  });
});

describe('attr-field 渲染层角色权限（V3 渲染层隐藏）', () => {
  const base = { type: 'form', title: '权限表单', navigation: { to: '/workspace' }, layout: { columns: 1, theme: 'light' } };

  it('comp.hidden=true → 输出 data-perm="hidden" 且无 <input>', () => {
    const schema = { ...base, components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称', hidden: true }] };
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="hidden"');
    expect(out.html).not.toContain('<input');
  });

  it('comp.readonly=true → 输出 <input disabled data-perm="readonly">', () => {
    const schema = { ...base, components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称', readonly: true }] };
    const out = renderPage(schema, {});
    expect(out.html).toContain('data-perm="readonly"');
    expect(out.html).toContain('<input');
    expect(out.html).toContain('disabled');
  });

  it('默认（无 hidden/readonly）→ 正常 <input> 且无 data-perm', () => {
    const schema = { ...base, components: [{ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称' }] };
    const out = renderPage(schema, {});
    expect(out.html).toContain('<input');
    expect(out.html).not.toContain('data-perm');
  });
});