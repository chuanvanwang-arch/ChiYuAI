// src/context/routing.js 单测：加载回退 / 分类 / 选轨（纯函数，不触 DB）
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROUTING, DEFAULT_TRACKS_ARR, DEFAULT_L_ARR,
  classifyScene, resolveTracks, MODE_GRAPH, MODE_STORY, MODE_BOTH, loadRouting,
} from '../../src/context/routing.js';

const DEFAULT_TRACKS_ARR_TEST = ['narrative', 'graph_decision', 'graph_entity', 'structured'];
const DEFAULT_L_ARR_TEST = ['L1', 'L2', 'L3', 'L4'];

describe('routing 场景路由', () => {
  it('loadRouting 配置缺失回退全轨安全默认（不抛错）', async () => {
    const cfg = await loadRouting({ tenantId: 'no-such-tenant' });
    expect(cfg.scene_matrix).toBeDefined();
    expect(Array.isArray(cfg.dims)).toBe(true);
    expect(cfg.thresholds.graph).toBe(0.6);
  });

  it('classifyScene 加权聚合：审计场景回 GRAPH_PRIMARY、理解场景回 STORY_PRIMARY', () => {
    expect(classifyScene('sales_decision_monitor').mode).toBe(MODE_GRAPH);
    expect(classifyScene('account_insight').mode).toBe(MODE_STORY);
    // 未声明维度的场景 → BOTH（score 0 在 [0.4, 0.6) 区间）
    expect(classifyScene('unknown_scenario').mode).toBe('UNKNOWN');
  });

  it('resolveTracks 按场景返回轨道，缺失回退全轨', async () => {
    const audit = await resolveTracks('sales_decision_monitor');
    expect(audit.tracks).toEqual(['graph_decision']);
    const unknown = await resolveTracks('anything');
    expect(unknown.tracks.length).toBe(4);
    expect(unknown.mode).toBe('UNKNOWN');
  });
});