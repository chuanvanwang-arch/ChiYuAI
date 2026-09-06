// assembleContext 场景路由：routing-excluded（审计场景不注入叙事）vs 全轨
// 消费 src/context/routing.js 出厂默认矩阵；用 retrievers 注入避免真 DB 依赖
import { describe, it, expect } from 'vitest';
import { assembleContext } from '../../src/context/assembler.js';

// 全空 retrievers：L1-L4 都注入 stub，确保聚焦路由逻辑本身
const emptyRetrievers = {
  L1: async () => [],
  L2: async () => ({ decisions: [], memories: [] }),
  L3: async () => ({ tasks: [], agents: [] }),
  L4: async () => ({ profile: null, data_scope: null, tiers: [] }),
};

const narrativeRows = [
  { ts: '2026-09-01T08:00:00.000Z', type: 'event', title: '客户拜访', source: 'events', actor: 'alice', entity: 'CRM_ACCOUNT', summary: '' },
];

describe('assembleContext 场景路由选轨', () => {
  it('审计场景（sales_decision_monitor）narrative 被排除且留痕 routing-excluded', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', intent: { scenario: 'sales_decision_monitor' }, query: '风险' },
      { ...emptyRetrievers, narrative: async () => narrativeRows }
    );
    expect(bundle.routing.scene).toBe('sales_decision_monitor');
    expect(bundle.routing.tracks).toEqual(['graph_decision']);
    expect(bundle.routing.mode).toBe('GRAPH_PRIMARY');
    expect(bundle.narrative.available).toBe(false);
    expect(bundle.narrative.unavailable_reason).toBe('routing-excluded');
    expect(bundle.degraded).toBe(false); // 排除 ≠ 缺失
  });

  it('理解场景（account_insight）narrative 正常注入', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', intent: { scenario: 'account_insight', accountId: 'a1111111-1111-1111-1111-111111111111' }, query: '客户' },
      { ...emptyRetrievers, narrative: async () => narrativeRows }
    );
    expect(bundle.routing.tracks).toContain('narrative');
    expect(bundle.narrative.available).toBe(true);
    expect(bundle.narrative.rows.length).toBe(1);
  });

  it('未知场景回退全轨安全默认（不中断装配）', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', intent: { scenario: 'whatever_new' }, query: 'x' },
      { ...emptyRetrievers, narrative: async () => narrativeRows }
    );
    expect(bundle.routing.mode).toBe('UNKNOWN');
    expect(bundle.routing.tracks.length).toBe(4);
    expect(bundle.narrative.available).toBe(true); // 全轨 → 叙事正常
    expect(bundle.degraded).toBe(false);
  });
});