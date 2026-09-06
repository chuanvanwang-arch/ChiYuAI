// test/page/insight-skin.test.js — layout.skin 透传（通用机制，不再绑定 insight 浅色）
// 设计输入：UI 统一要求全站深色；renderer 仍保留 skin 透传能力，但生产 schema 不再声明 skin。
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';

const base = (layout) => ({
  type: 'workspace', title: '客户洞察', navigation: { to: '/accounts/:id/insight' },
  layout, components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }],
});

describe('layout.skin 透传 data-skin 输出', () => {
  it('声明 layout.skin 时 → .pg-page 输出对应 data-skin', () => {
    const { html } = renderPage(base({ columns: 1, theme: 'light', skin: 'custom-x' }), { state: 'partial' });
    expect(html).toContain('class="pg-page"');
    expect(html).toContain('data-skin="custom-x"');
  });

  it('无 layout.skin → 不输出 data-skin 属性（保持深色门户页不变）', () => {
    const { html } = renderPage(base({ columns: 1, theme: 'light' }), { state: 'partial' });
    expect(html).not.toContain('data-skin');
  });
});
