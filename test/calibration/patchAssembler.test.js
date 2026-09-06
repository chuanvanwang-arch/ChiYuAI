// test/calibration/patchAssembler.test.js — T23 共享处方组装（HTTP 与 MCP 同口径）契约测试
// 设计依据：docs/2026-08-30-j2-j3-comprehensive-design.md L185-L190
// 锁定：守卫命中→不出处方（blocked_by）；threshold/weight 推导 from/to/target；
//   影子重放预期影响；幂等落库（savePatches 注入 mock）；第0闸 produceDecision 透传。
import { describe, it, expect, vi } from 'vitest';
import { enrichPatchesAndSave } from '../../src/calibration/patchAssembler.js';

const conf = { threshold: 0.8, weights: { similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 } };

function dec(len = 25) {
  return Array.from({ length: len }, (_, i) => ({
    decision_id: `d${i}`, decider_type: 'HUMAN', created_at: new Date().toISOString(),
    conditions_evaluated: [], referenced_precedents: [],
  }));
}

describe('patchAssembler.enrichPatchesAndSave — T23 共享链路', () => {
  it('守卫命中 → created=0 + blocked_by=[R6]，不落库', async () => {
    const att = { patches: [], guards: [{ id: 'R6', reason: '样本不足', evidence: { sample_size: 3 } }], reason: '守卫命中' };
    const save = vi.fn(async () => ({ created: 0, skipped: [] }));
    const r = await enrichPatchesAndSave({ decisions: dec(3), metrics: { sample_size: 3 }, att, conf, scenario_id: 'S1', savePatches: save });
    expect(r.created).toBe(0);
    expect(r.blocked_by?.[0]?.rule_id).toBe('R6');
    expect(save).not.toHaveBeenCalled();
  });

  it('无规则命中 → created=0 + blocked_by=[]，不落库', async () => {
    const att = { patches: [], guards: [], reason: 'no hit' };
    const save = vi.fn(async () => ({ created: 0, skipped: [] }));
    const r = await enrichPatchesAndSave({ decisions: dec(25), metrics: { sample_size: 25 }, att, conf, scenario_id: 'S1', savePatches: save });
    expect(r.created).toBe(0);
    expect(r.blocked_by).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });

  it('threshold 处方：from/to 按当前配置推导 + 影子重放预期影响', async () => {
    const att = {
      patches: [{ id: 'R1', knob: 'threshold', delta: { threshold: +0.05 }, risk: 'LOW', label: 'x', evidence: { autonomy_override_rate: 0.3 } }],
      guards: [], reason: 'hit R1',
    };
    const save = vi.fn(async () => ({ created: 1, skipped: [] }));
    const replay = (rows, cfg) => ({ autonomy: rows.length, escalated: 0, delta: 0, estimated_override_rate: null, base_autonomy: 0 });
    const r = await enrichPatchesAndSave({ decisions: dec(25), metrics: { sample_size: 25 }, att, conf, scenario_id: 'S1', savePatches: save, replayScenario: replay, produceDecision: async () => ({ decisionId: 'dec-1' }) });
    expect(r.created).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('S1', expect.any(Array), { decision_id: 'dec-1' });
    const p = save.mock.calls[0][1][0];
    expect(p.knob).toBe('threshold');
    expect(p.from_value).toEqual({ threshold: 0.8 });
    expect(p.to_value.threshold).toBeCloseTo(0.85, 10); // 浮点误差（0.8+0.05=0.8500000000000001）
    expect(p.evidence.rule_id).toBe('R1');
    expect(p.expected_impact.sample_size).toBe(25);
    expect(r.decision_id).toBe('dec-1');
  });

  it('weight 处方：target=method + from/to 定向推导', async () => {
    const att = {
      patches: [{ id: 'R4', knob: 'weight', delta: { weights: { method: +0.05 } }, risk: 'MEDIUM', label: 'y', evidence: { weight_sensitivity_method: 0.4 } }],
      guards: [], reason: 'hit R4',
    };
    const save = vi.fn(async () => ({ created: 1, skipped: [] }));
    const replay = () => ({ autonomy: 0, escalated: 25, delta: 0, estimated_override_rate: null });
    const r = await enrichPatchesAndSave({ decisions: dec(25), metrics: { sample_size: 25 }, att, conf, scenario_id: 'S1', savePatches: save, replayScenario: replay, produceDecision: async () => ({ decisionId: 'dec-2' }) });
    const p = save.mock.calls[0][1][0];
    expect(p.knob).toBe('weight');
    expect(p.target).toBe('method');
    expect(p.from_value).toEqual({ weights: { method: 0.2 } });
    expect(p.to_value).toEqual({ weights: { method: 0.25 } });
  });

  it('非 threshold/weight 处方（如 required_dims）不自动产出 → 不入 valid', async () => {
    const att = {
      patches: [{ id: 'R8', knob: 'required_dims', delta: {}, risk: 'LOW', label: 'z', evidence: {} }],
      guards: [], reason: 'hit R8',
    };
    const save = vi.fn(async () => ({ created: 0, skipped: [] }));
    const r = await enrichPatchesAndSave({ decisions: dec(25), metrics: { sample_size: 25 }, att, conf, scenario_id: 'S1', savePatches: save });
    expect(r.created).toBe(0);
    expect(save).toHaveBeenCalledWith('S1', [], { decision_id: null });
  });

  it('produceDecision 缺省 null（不注入）→ 不调用第0闸，decision_id=null（防注入式测试意外连 DB）', async () => {
    const att = { patches: [{ id: 'R1', knob: 'threshold', delta: { threshold: +0.05 }, risk: 'LOW', label: 'x', evidence: {} }], guards: [], reason: 'hit' };
    const save = vi.fn(async () => ({ created: 1, skipped: [] }));
    const r = await enrichPatchesAndSave({ decisions: dec(25), metrics: { sample_size: 25 }, att, conf, scenario_id: 'S1', savePatches: save });
    expect(save).toHaveBeenCalledWith('S1', expect.any(Array), { decision_id: null });
    expect(r.decision_id).toBe(null);
  });
});