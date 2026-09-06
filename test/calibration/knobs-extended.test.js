// test/calibration/knobs-extended.test.js — 6.5 回落：KNOBS 13 类策略全注册 + 新 knob apply 落点
// 依据：dev-plan §3 Task 12 回落规则（§6 风险 5）+ j2-j3 §3.2(c) + full-traceability §3.2/§5
// 代码事实（基线）：getStrategy 对 10 类新 KNOBS 返回 null（REGISTRY 仅 threshold/weight/required_dims）
//   → rules.js R7–R17 出方引用 8 类新 knob → approvePatch 抛「未知 knob」→ J3 闭环断。
// 契约：
//   ① getStrategy 对 KNOBS 全部 13 类返回非 null（当前 FAIL：新 10 类返回 null）
//   ② EdgeBindingStrategy.apply 落 config_store['seven-dim'].edge_bindings（与 edgeDimensionSpec 同 key 形态）
//   ③ approvePatch 对 8 类 R7–R17 knob 处方可批准且状态 APPLIED（当前 FAIL：抛「未知 knob」）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query } from '../../src/db.js';
import { getStrategy } from '../../src/calibration/knobs/index.js';
import { KNOBS, createPatch, approvePatch, getPatch } from '../../src/calibration/store.js';
import { loadEdgeDimensionSpecFromConfig, DEFAULT_EDGE_DIMENSION_SPEC } from '../../src/decision/edgeDimensionSpec.js';

// R7–R17 出方实际引用的 8 类新 knob（rules.js:74-145）
const RULE_REF_KNOBS = ['confidence', 'edge_binding', 'outcome_threshold', 'meta_attr_map', 'particle_attr_add', 'source_refresh', 'dim_order', 'precedent_distill'];
beforeEach(async () => {
  // 隔离：清测试残留配置行（保留 seed 默认，只清我们写入的子键）
  await query(`DELETE FROM crm.config_store WHERE key='seven-dim' AND value->>'edge_bindings' IS NOT NULL`);
});

// 对称卫生（同 store-p3 修复）：approvePatch 会把 edge_bindings/confidence 留在 seven-dim 配置，
// 单进程共享库下污染后续读 seven-dim 的测试。afterEach 还原子键。
afterEach(async () => {
  await query(`DELETE FROM crm.config_store WHERE key='seven-dim' AND value->>'edge_bindings' IS NOT NULL`);
  await query(`DELETE FROM crm.config_store WHERE key='seven-dim' AND value->>'confidence' IS NOT NULL`);
});

describe('6.5 KNOBS 17 类策略全注册（回落实施 + Task 12 config_store + P1-5 路由旋钮）', () => {
  it('KNOBS 声明 17 类（14 既有 + 2026-09-05 P1 routing_tracks/weight/threshold）', () => {
    expect(KNOBS).toHaveLength(17);
    for (const k of ['threshold', 'weight', 'required_dims', 'confidence', 'edge_binding', 'outcome_threshold', 'strictness', 'meta_attr_map', 'particle_attr_add', 'k_edge_add', 'source_refresh', 'dim_order', 'precedent_distill', 'config_store', 'routing_tracks', 'routing_weight', 'routing_threshold']) {
      expect(KNOBS).toContain(k);
    }
  });

  it('getStrategy 对 KNOBS 全部 17 类返回非空策略（当前 FAIL：新 10 类返回 null）', () => {
    for (const k of KNOBS) {
      const s = getStrategy(k);
      expect(s, `getStrategy('${k}') 不应为 null`).toBeTruthy();
      expect(typeof s.apply).toBe('function');
      expect(typeof s.riskLevel).toBe('function');
    }
  });

  it('R7–R17 引用的 8 类新 knob 均可 getStrategy（闭环不因 REGISTRY 断）', () => {
    for (const k of RULE_REF_KNOBS) {
      const s = getStrategy(k);
      expect(s, `规则引用 knob '${k}' 应可解析`).toBeTruthy();
    }
  });
});

describe('EdgeBindingStrategy apply 落 config_store[seven-dim].edge_bindings', () => {
  it('apply 写 edge_bindings 且 loadEdgeDimensionSpecFromConfig 可读（闭环读回）', async () => {
    // 契约：loadEdgeDimensionSpecFromConfig 只对「完整 7 边 spec」loaded=true（fail-safe 校验）；
    // 片段 spec 会被 validateEdgeDimensionSpec 拒绝（预期行为）。故用完整 7 边验证读回闭环。
    const spec = structuredClone(DEFAULT_EDGE_DIMENSION_SPEC);
    const s = getStrategy('edge_binding');
    const cur = await (await import('../../src/calibration/store.js')).readConf();
    // 直接驱动策略（与 knobs.test.js 同风格：withTx 传 client）
    const { withTx } = await import('../../src/db.js');
    await withTx(async (client) => {
      await s.apply(client, { edge_bindings: spec }, { target: null, current: cur, decisionId: 'e0000000-0000-0000-0000-0000000000e1' });
    });
    const r = await query(`SELECT value, decision_id FROM crm.config_store WHERE key='seven-dim'`);
    const v = r.rows[0]?.value;
    const loaded = loadEdgeDimensionSpecFromConfig(v);
    expect(loaded.loaded).toBe(true);
    expect(loaded.spec).toEqual(spec);
    expect(r.rows[0]?.decision_id).toBe('e0000000-0000-0000-0000-0000000000e1'); // 第0闸凭证落表列（非 value 子键）
  });
});

describe('approvePatch 对 R7–R17 knob 处方可批准（J3 闭环断点修复）', () => {
  it('edge_binding 处方：approvePatch 不抛「未知 knob」且状态 APPLIED', async () => {
    const patch = await createPatch({
      scenario_id: null, knob: 'edge_binding', target: null,
      from_value: [], to_value: { edge_bindings: [{ edge_type: 'CAUSED', serves_dimension: ['time_config'], direction: 'decision->decision' }] },
      evidence: { rule_id: 'R9' }, expected_impact: { edge_missing_rate: '下降' }, risk: 'MEDIUM',
    });
    const r = await approvePatch(patch.patch_id, {
      // 第0闸注入：测试隔离下不留假 FK（既有 store-p3 同款；真实第0闸由 rootCause/db 集成测试覆盖）
      produce: async () => ({ decisionId: null }),
      resolved_by: 'sysadmin',
    });
    expect(r.patch.status).toBe('APPLIED');
    const cfg = await query(`SELECT value FROM crm.config_store WHERE key='seven-dim'`);
    expect(Array.isArray(cfg.rows[0]?.value?.edge_bindings)).toBe(true);
    expect(cfg.rows[0]?.value?.edge_bindings[0]?.edge_type).toBe('CAUSED');
  });

  it('confidence 处方：approvePatch 可批准且写回 seven-dim.confidence', async () => {
    const patch = await createPatch({
      scenario_id: null, knob: 'confidence', target: null,
      from_value: { confidence: 1.0 }, to_value: { confidence: 0.5 },
      evidence: { rule_id: 'R8' }, expected_impact: { avg_confidence: '下降' }, risk: 'MEDIUM',
    });
    const r = await approvePatch(patch.patch_id, {
      // 第0闸注入：测试隔离下不留假 FK（同 edge_binding 用例）
      produce: async () => ({ decisionId: null }),
      resolved_by: 'sysadmin',
    });
    expect(r.patch.status).toBe('APPLIED');
    const cfg = await query(`SELECT value FROM crm.config_store WHERE key='seven-dim'`);
    expect(cfg.rows[0]?.value?.confidence).toBe(0.5);
  });
});