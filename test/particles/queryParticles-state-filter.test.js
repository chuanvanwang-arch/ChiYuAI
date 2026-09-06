// test/particles/queryParticles-state-filter.test.js
// 业务主数据软停用默认过滤：CRM_PRODUCT 停用(discontinued) 不在默认列表出现
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderProductList } from '../../src/portal/productCatalogRender.js';

const captured = { calls: [] };

vi.mock('../../src/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    captured.calls.push({ sql, params });
    return { rows: [] };
  }),
  queryWrite: vi.fn(async () => ({ rows: [] })),
}));

const { queryParticles } = await import('../../src/particles/particleRepo.js');

describe('queryParticles state 过滤', () => {
  beforeEach(() => { captured.calls = []; });

  it('默认查询不过滤 state（向后兼容）', async () => {
    await queryParticles({ type: 'CRM_KNOWLEDGE', tenantId: 'acme-demo' });
    const call = captured.calls[0];
    expect(call.sql).not.toContain('state');
    expect(call.params).toEqual(['acme-demo', 'CRM_KNOWLEDGE', 100]);
  });

  it('excludeStates 字符串生成 <> ALL 子句', async () => {
    await queryParticles({ type: 'CRM_PRODUCT', tenantId: 'acme-demo', excludeStates: 'discontinued' });
    const call = captured.calls[0];
    expect(call.sql).toContain('state <> ALL($4::text[])');
    expect(call.params).toEqual(['acme-demo', 'CRM_PRODUCT', 100, ['discontinued']]);
  });

  it('excludeStates 数组生成 <> ALL 子句', async () => {
    await queryParticles({ type: 'CRM_PRODUCT', tenantId: 'acme-demo', excludeStates: ['discontinued', 'expired'] });
    const call = captured.calls[0];
    expect(call.sql).toContain('state <> ALL($4::text[])');
    expect(call.params).toEqual(['acme-demo', 'CRM_PRODUCT', 100, ['discontinued', 'expired']]);
  });

  it('admin 通配 * + excludeStates 仍生效', async () => {
    await queryParticles({ type: 'CRM_PRODUCT', tenantId: '*', excludeStates: ['discontinued'] });
    const call = captured.calls[0];
    expect(call.sql).toContain('state <> ALL($3::text[])');
    expect(call.params).toEqual(['CRM_PRODUCT', 100, ['discontinued']]);
  });
});

describe('renderProductList 软停用展示', () => {
  it('在售行显示停用按钮', () => {
    const html = renderProductList([{ id: 'p1', state: 'on_sale', payload: { name: 'A', status: 'on_sale' } }]);
    expect(html).toContain('on_sale');
    expect(html).toContain('data-stop="p1"');
    expect(html).not.toContain('已停用');
  });

  it('已停用行显示"已停用"且不渲染停用按钮', () => {
    const html = renderProductList([{ id: 'p2', state: 'discontinued', payload: { name: 'B', status: 'on_sale' } }]);
    expect(html).toContain('discontinued');
    expect(html).toContain('已停用');
    expect(html).not.toContain('data-stop="p2"');
  });
});
