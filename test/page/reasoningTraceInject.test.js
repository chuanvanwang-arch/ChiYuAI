// test/page/reasoningTraceInject.test.js
// T2：renderer 的 reasoning-trace 分支优先读服务端注入 steps（方案 B），无注入回退 schema 写死 steps
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';

const schema = {
  type: 'detail',
  title: '测试页',
  layout: { columns: 1, theme: 'light' },
  navigation: { to: '/decision-graph' },
  components: [
    {
      kind: 'reasoning-trace',
      title: 'AI 洞察',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL' },
      steps: [
        { status: 'ok', label: '聚合四源数据' },
        { status: 'ok', label: '权限裁剪' },
        { status: 'ok', label: '生成下一步建议' },
      ],
    },
  ],
};

describe('renderPage reasoning-trace 注入优先', () => {
  it('有 data 注入 steps → 渲染注入状态', () => {
    const data = {
      components: {
        'reasoning-trace': {
          'AI 洞察': {
            steps: [
              { status: 'ok', label: '聚合四源数据' },
              { status: 'ok', label: '权限裁剪' },
              { status: 'idle', label: '生成下一步建议' },
            ],
          },
        },
      },
    };
    const { html } = renderPage(schema, data);
    expect(html).toContain('data-trace-step="idle"');
    expect(html).toContain('生成下一步建议');
  });

  it('无 data 注入 → 回退 schema 写死 steps（向后兼容）', () => {
    const { html } = renderPage(schema, { components: {} });
    expect(html).toContain('data-trace-step="ok"');
    expect(html).toContain('聚合四源数据');
  });
});
