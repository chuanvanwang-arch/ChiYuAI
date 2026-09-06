// test/trace/infoCompleteness.test.js — 6.3 溯源④跳信息完整性检测
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.7：computeAttribution 增加 stale/late 检测——读 meta_attr.source_refresh_sla，
//   超期标记 category='INPUT_STALE'；required 缺失标记 'input_missing'；溯源④跳据此触发告警。
// 现状对账：traceRootCause.inspectParticlePayload 已有三检（field/info/stale），
//   但写时物化 computeAttribution 未并入 stale —— 本测试锁定该缺口补强。
import { describe, it, expect } from 'vitest';
import { computeAttribution, computeEdgeCompliance } from '../../src/monitor/attribution.js';

// 假 sevenDimensionsCheck：缺 identity（input_missing）时返回 missing；否则返回全齐
function makeCheck({ missingDims = [], provided = [] } = {}) {
  return async () => ({
    missing: missingDims.map((d) => ({ dim: d })),
    required: provided,
    level: 'warn',
  });
}

describe('6.3 溯源④跳信息完整性检测', () => {
  it('stale_particle_checks 传入 → category 标 INPUT_STALE（输入不及时）', async () => {
    const r = await computeAttribution({
      scenario_id: 'SC',
      trigger_context: { identity: 'acme' },
      check: makeCheck(),
      stale_particle_checks: { input_stale: true, info_incomplete: false, field_mismatch: false },
    });
    expect(r.category).toContain('INPUT_STALE');
  });

  it('required 缺失 → category 保留 input_missing（与既有语义兼容）', async () => {
    const r = await computeAttribution({
      scenario_id: 'SC',
      trigger_context: {},
      check: makeCheck({ missingDims: ['identity'] }),
      stale_particle_checks: {},
    });
    expect(r.category).toBe('input_missing');
  });

  it('computeEdgeCompliance 纯函数 E1–E7 全覆盖（present/missing 二元 + 结构键）', () => {
    const c = computeEdgeCompliance(['DECIDED_ON', 'REFERENCED_PRECEDENT']);
    // 7 边投影 + 3 结构键（required_edges/required_missing/known）→ 10 键（attribution.js:40-57 实现契约）
    expect(Object.keys(c)).toHaveLength(10);
    expect(c.DECIDED_ON).toBe('present');
    expect(c.INFLUENCED).toBe('missing');
    // 无 requiredDims → known=false（无应连边依据，E 缺不可判——防误判护栏 attribution.js:51-54）
    expect(c.known).toBe(false);
    expect(c.required_edges).toEqual([]);
    expect(c.required_missing).toEqual([]);
  });
});