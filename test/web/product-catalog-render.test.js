import { describe, it, expect } from 'vitest';
import { renderProductList, renderProductForm } from '../../src/portal/productCatalogRender.js';

describe('productCatalogRender', () => {
  it('新建表单：使用 crm-* 组件，不含裸 input/select/button', () => {
    const html = renderProductForm();
    expect(html).toContain('<crm-input');
    expect(html).toContain('<crm-select');
    expect(html).toContain('<crm-button');
    expect(html).not.toMatch(/<input\b/);
    expect(html).not.toMatch(/<select\b/);
    expect(html).not.toMatch(/<button\b/);
  });

  it('列表：已停用品显示徽章且不渲染停用按钮', () => {
    const html = renderProductList([{ id: 'x', tenant_id: 't1', state: 'discontinued', payload: { name: 'A' } }]);
    expect(html).toContain('badge-off');
    expect(html).not.toContain('data-stop');
  });

  it('列表：在售品渲染徽章与停用按钮', () => {
    const html = renderProductList([{ id: 'x', tenant_id: 't1', state: 'on_sale', payload: { name: 'A' } }]);
    expect(html).toContain('badge-on');
    expect(html).toContain('data-stop="x"');
  });

  it('列表：空数据返回空态提示', () => {
    expect(renderProductList([])).toContain('暂无产品');
  });
});
