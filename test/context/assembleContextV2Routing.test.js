// assembleContextV2 场景路由闸门（2026-09-05 修复护栏）
//
// 缺陷背景：V2 是**决策落库主路径**（decisionRepo / autonomyEngine / decisionReadRoutes 均走此），
//   但此前完全不读 config_store['context-routing']，S5 叙事**无条件注入** →
//   配置中心把场景设为「图谱主（tracks 不含 narrative）」对生产决策不生效；
//   而 agentLoop 走的 assembleContext（assembler.js:181）却遵守 → 两条路径行为分裂。
// 本文件锁定：V2 的 S5 必须与 assembler.js:181 同口径受 tracks 约束，且排除时留痕、不计 degraded。
//
// 依赖出厂默认矩阵（db.js 被 mock 成空 → loadRouting 回退 DEFAULT_ROUTING），零真实 DB。
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWrite: vi.fn(async () => ({ rowCount: 1 })),
}));
vi.mock('../../src/decision/provenance.js', () => ({
  trackEntry: vi.fn(async () => ({ ok: true })),
}));

const { assembleContextV2 } = await import('../../src/context/assembleContextV2.js');

const narrativeRow = {
  ts: '2026-09-01T08:00:00.000Z', type: 'decision', title: '阶段推进',
  source: 'decision', actor: 'alice', entity: 'CRM_ACCOUNT', summary: '推进到 S3',
};

// S1–S7 全注入；S5 默认返回一条叙事（可被路由闸门拦掉）
function mkRetrievers(overrides = {}) {
  const base = {
    S1: async () => ({ items: [{ id: 'p-1', label: 'CRM_ACCOUNT', source: 'particle:p-1' }] }),
    S2: async () => ({ items: [] }),
    S3: async () => ({ items: [] }),
    S4: async () => ({ items: [{ rule: 'R1', result: 'ok' }] }),
    S5: async () => ({ items: [narrativeRow] }),
    S6: async () => ({ items: [] }),
    S7: async () => ({ items: [] }),
  };
  return { ...base, ...overrides };
}

const s5 = (r) => r.ops.find((o) => o.op === 'S5');

describe('V2 场景路由闸门 — 图谱主场景必须拦掉 S5 叙事', () => {
  it('QUOTE_PRICING（tracks=structured/graph_decision，不含 narrative）→ S5 被闸且留痕 routing-excluded', async () => {
    const r = await assembleContextV2(
      { actor: 'alice', scenario_id: 'QUOTE_PRICING', persist: false },
      mkRetrievers()
    );
    expect(r.routing.tracks).toEqual(['structured', 'graph_decision']);
    expect(r.routing.tracks).not.toContain('narrative');
    // 闸门生效：S5 不取数 → 无条目
    expect(s5(r).items).toEqual([]);
    expect(s5(r).status).toBe('empty');
    // 不静默：原因写进 note（随 ops 落进快照 JSONB 可审计）
    expect(s5(r).note).toContain('routing-excluded');
    // 排除 ≠ 缺失：不得计 degraded（与 assembler.js:181-197 同语义）
    expect(r.degraded).toBe(false);
    // prompt 不得出现叙事段
    expect(r.prompt_block).not.toContain('故事时间线');
  });

  it('LEAD_FOLLOW_UP（tracks 含 narrative）→ S5 正常注入', async () => {
    const r = await assembleContextV2(
      { actor: 'alice', scenario_id: 'LEAD_FOLLOW_UP', persist: false },
      mkRetrievers()
    );
    expect(r.routing.tracks).toContain('narrative');
    expect(s5(r).items).toHaveLength(1);
    expect(s5(r).status).toBe('hit');
    expect(s5(r).note).toBe(null); // 未受闸 → 无排除留痕
    expect(r.prompt_block).toContain('故事时间线');
  });

  it('未知场景回退全轨 → S5 不受闸（安全默认，不阻断装配）', async () => {
    const r = await assembleContextV2(
      { actor: 'alice', scenario_id: 'BRAND_NEW_SCENE', persist: false },
      mkRetrievers()
    );
    expect(r.routing.mode).toBe('UNKNOWN');
    expect(r.routing.tracks).toHaveLength(4);
    expect(s5(r).items).toHaveLength(1);
    expect(s5(r).status).toBe('hit');
  });

  it('闸门只清条目、不删操作：ops 仍为 7 条（防 A-T4 PROV-O 逐操作留痕计数回潮）', async () => {
    const r = await assembleContextV2(
      { actor: 'alice', scenario_id: 'QUOTE_PRICING', persist: false },
      mkRetrievers()
    );
    expect(r.ops).toHaveLength(7);
    expect(r.ops.map((o) => o.op).sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    // 被闸的 S5 仍参与 PROV-O 留痕（状态 empty + item_count 0，可审计）
    expect(s5(r).items).toHaveLength(0);
  });

  it('routing 回带与 routing.js classifyScene 同口径（QUOTE_PRICING→GRAPH_PRIMARY/score 1.0）', async () => {
    const r = await assembleContextV2(
      { actor: 'alice', scenario_id: 'QUOTE_PRICING', persist: false },
      mkRetrievers()
    );
    expect(r.routing.scene).toBe('QUOTE_PRICING');
    expect(r.routing.mode).toBe('GRAPH_PRIMARY');
    // goal=verify(1)*0.4 + event_mix=pure_decision(1)*0.3 + time_sensitivity=false(1)*0.3 = 1.0
    expect(r.routing.score).toBeCloseTo(1.0, 5);
  });
});
