// test/page/renderTargetCard.test.js — renderer target-card 组件
// 契约：COMPONENT_KINDS 含 target-card；renderPage 输出 {html} 含档位/实际次数/达标标记
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';
import { COMPONENT_KINDS } from '../../src/page/schema.js';

describe('renderer target-card 组件', () => {
  it('COMPONENT_KINDS 白名单含 target-card', () => {
    expect(COMPONENT_KINDS).toContain('target-card');
  });

  it('renderPage 输出 target vs actual + 达标标记', () => {
    const schema = {
      type: 'detail',
      title: '客户画像',
      navigation: { to: '/accounts/:id' },
      components: [
        { kind: 'target-card', title: '目标达标', dataBinding: { source: 'data', key: '目标达标' } },
      ],
    };
    const data = {
      components: {
        'target-card': {
          '目标达标': { tier: '重点', target: 1, window: 'week', actual: 2, pass: true },
        },
      },
    };
    const r = renderPage(schema, data);
    expect(r.html).toContain('重点');
    expect(r.html).toContain('2 次');
    expect(r.html).toContain('达标');
  });

  it('未达标 → warn 标记（⚠️）', () => {
    const schema = { type: 'detail', title: '客户画像', navigation: { to: '/accounts/:id' }, components: [{ kind: 'target-card', title: '目标达标', dataBinding: { source: 'data', key: '目标达标' } }] };
    const data = { components: { 'target-card': { '目标达标': { tier: '目标', target: 1, window: 'month', actual: 0, pass: false } } } };
    const r = renderPage(schema, data);
    expect(r.html).toContain('未达标');
  });
});