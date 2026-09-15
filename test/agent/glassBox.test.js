// test/agent/glassBox.test.js — Task 15（C2）glass-box 可解释推理链
import { describe, it, expect } from 'vitest';
import { buildGlassBox } from '../../src/agent/glassBox.js';
import { buildDiscoveryPayload } from '../../src/agent/discoverySchema.js';

describe('glass-box (C2)', () => {
  it('① emits why_narrative with rule_ref + j_score per decision', () => {
    const gb = buildGlassBox({ score: 0.82, ruleRef: 'scenario:lead-fit#ruler:industry', signals: ['funding_round'] });
    expect(gb.why_narrative).toContain('industry');
    expect(gb.judge.rule_ref).toBe('scenario:lead-fit#ruler:industry');
    expect(gb.judge.j_score).toBe(0.82);
    expect(gb.trace.length).toBe(1);
    expect(gb.trace[0].rule_ref).toBe('scenario:lead-fit#ruler:industry');
  });

  it('①b handles empty signals without throwing', () => {
    const gb = buildGlassBox({ score: 0.3, ruleRef: 'scenario:lead-fit#ruler:geo', signals: [] });
    expect(gb.why_narrative).toContain('无信号');
    expect(gb.trace).toEqual([]);
  });

  it('② 结构与 P0#1 的 2D judge 同源（字段集一致）', () => {
    const gb = buildGlassBox({ score: 0.5, ruleRef: 'r', signals: [] });
    const d = buildDiscoveryPayload(0.5, 0.5, [], 'dec_x');
    expect(Object.keys(gb.judge).sort()).toEqual(Object.keys(d.icp_fit_score.judge).sort());
    expect(gb.judge.axis).toBe('capability');
    expect(Object.keys(gb).sort()).toEqual(['judge', 'trace', 'why_narrative']);
  });

  it('③ 脏信号被过滤：trace 项数 = 有效信号数（与 localGlassBox 同构）', () => {
    const gb = buildGlassBox({ score: 0.6, ruleRef: 'r', signals: [null, { type: 'funding_round' }, {}] });
    expect(gb.trace.map((t) => t.signal)).toEqual(['funding_round']);
  });

  it('④ ruleRef / axis 可覆盖（配置驱动，禁硬编码 ruler 名）', () => {
    const gb = buildGlassBox({ score: 0.4, ruleRef: 'x#ruler:y', signals: [], axis: 'coverage' });
    expect(gb.judge.axis).toBe('coverage');
    expect(gb.judge.rule_ref).toBe('x#ruler:y');
  });
});
