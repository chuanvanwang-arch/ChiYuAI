import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';

const navSchema = {
  type: 'dashboard', title: 'T', navigation: { to: '/home' },
  layout: { columns: 1, theme: 'light' },
  components: [
    { kind: 'metric-card', title: 'CARD', navigation: { to: '/x.html?focus=quoted' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '口径' }] } },
    { kind: 'table', title: 'TBL',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [],
        columns: ['name'], rowLink: { textField: 'name', idField: 'id', href: '/deal-detail.html?id={id}' } }, metrics: [] },
  ],
};
const navData = { components: {
  'metric-card': { 'CARD': { value: 3 } },
  table: { 'TBL': { rows: [{ id: 'd1', name: '商机A' }] } },
} };

describe('renderer navigation', () => {
  it('metric-card with navigation.to 渲染为 <a href>', () => {
    const { html } = renderPage(navSchema, navData);
    expect(html).toContain('<a class="pg-metric-card" href="/x.html?focus=quoted"');
    expect(html).toContain('口径'); // 该用例 CARD 的 label 为'口径'，校验口径文案落片
  });
  it('table rowLink 把 textField 渲染为 <a href> 带 id', () => {
    const { html } = renderPage(navSchema, navData);
    expect(html).toContain('<a href="/deal-detail.html?id=d1">商机A</a>');
  });
  it('无 navigation 的 metric-card 维持 <div>（回归安全）', () => {
    const plain = { ...navSchema, components: [navSchema.components[0]] };
    delete plain.components[0].navigation;
    const { html } = renderPage(plain, navData);
    expect(html).toContain('<div class="pg-metric-card"');
    expect(html).not.toContain('<a class="pg-metric-card"');
  });
});
