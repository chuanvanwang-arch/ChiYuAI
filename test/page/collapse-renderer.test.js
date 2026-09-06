// test/page/collapse-renderer.test.js — Task 1: collapse 折叠容器（决策2）
// 设计输入：docs/2026-08-29-insight-metrics-redesign-completion-plan.md Task 1
// 契约：kind:'collapse' 纯布局容器（无 dataBinding，跳过粒子四护栏），渲染 <details class="pg-collapse">，
//       open 可选（默认 false），内部 components[] 子组件递归渲染。
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';
import { validatePageSchema } from '../../src/page/validator.js';

const wrap = (collapseComp) => ({
  type: 'detail', title: '客户360', navigation: { to: '/accounts/:id' }, layout: { columns: 1, theme: 'light' },
  components: [collapseComp],
});

const tableInner = { kind: 'table', title: '时间线', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } };

describe('Task1 · collapse 折叠容器契约', () => {
  it('默认渲染 <details class="pg-collapse"> 且未 open', () => {
    const schema = wrap({ kind: 'collapse', title: '明细段', open: false, components: [tableInner] });
    const { html } = renderPage(schema, { state: 'partial', components: { table: { rows: [{ a: '1' }] } } });
    expect(html).toContain('<details class="pg-collapse">');
    expect(html).not.toContain('<details class="pg-collapse" open');
  });

  it('open=true 时渲染 open 属性', () => {
    const schema = wrap({ kind: 'collapse', title: '明细段', open: true, components: [tableInner] });
    const { html } = renderPage(schema, { state: 'partial', components: { table: { rows: [{ a: '1' }] } } });
    expect(html).toContain('<details class="pg-collapse" open>');
  });

  it('内部 table 子组件正常渲染（summary 标题 + pg-table）', () => {
    const schema = wrap({ kind: 'collapse', title: '明细段', components: [tableInner] });
    const { html } = renderPage(schema, { state: 'partial', components: { table: { rows: [{ a: '1' }] } } });
    expect(html).toContain('明细段');          // <summary> 标题
    expect(html).toContain('pg-table');        // 内部表格组件
    expect(html).toContain('pg-collapse-body');
  });

  it('collapse 无 components → validator 拒绝', () => {
    const v = validatePageSchema(wrap({ kind: 'collapse', title: 'x' }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('collapse'))).toBe(true);
  });
});
