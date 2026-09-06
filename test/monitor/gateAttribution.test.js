// test/monitor/gateAttribution.test.js
// 验证 getGateAttribution 的交叉矩阵分类（inject fake query，不连 DB）
import { getGateAttribution, classifyAttribution } from '../../src/monitor/monitorStore.js';
import { describe, it, expect } from 'vitest';

function makeAttr({ provided = [], missing = [], category = 'ok', accuracy_signal = 'pending', level = 'ok' }) {
  return { required_fill: { provided, missing }, category, accuracy_signal, level };
}

// 直接验证 classifyAttribution 交叉矩阵（设计 §1/§3 自动交叉矩阵）
describe('classifyAttribution cross-matrix', () => {
  it('必填齐 + 被推翻(不准) → inference_bias', () => {
    expect(classifyAttribution(makeAttr({ provided: ['identity'], missing: [], category: 'inference_bias', accuracy_signal: 'inaccurate' })))
      .toBe('inference_bias');
  });
  it('必填缺 + 不准 → input_error', () => {
    expect(classifyAttribution(makeAttr({ provided: [], missing: ['time'], category: 'input_missing', accuracy_signal: 'inaccurate' })))
      .toBe('input_error');
  });
  it('必填缺 + 非不准 → input_missing', () => {
    expect(classifyAttribution(makeAttr({ provided: [], missing: ['time'], category: 'input_missing', accuracy_signal: 'pending' })))
      .toBe('input_missing');
  });
  it('必填齐 + level=warn 无推翻 → context_insufficient', () => {
    expect(classifyAttribution(makeAttr({ provided: ['identity'], missing: [], category: 'ok', accuracy_signal: 'pending', level: 'warn' })))
      .toBe('context_insufficient');
  });
  it('必填齐 + 准/待定且无 warn → null（良性，不计入错误类）', () => {
    expect(classifyAttribution(makeAttr({ provided: ['identity'], missing: [], category: 'ok', accuracy_signal: 'pending', level: 'ok' })))
      .toBeNull();
  });
});

// 端到端聚合（inject fake query）
function fakeQuery(rows) {
  return async () => ({ rows });
}

describe('getGateAttribution aggregation', () => {
  const rows = [
    // 必填齐 + 被推翻 → inference_bias
    { scenario_id: 'OPP_QUALIFY', human_disposition: 'OVERRIDDEN',
      attribution: makeAttr({ provided: ['identity', 'time'], missing: [], category: 'inference_bias', accuracy_signal: 'inaccurate' }) },
    // 必填缺 + 不准 → input_error
    { scenario_id: 'OPP_QUALIFY', human_disposition: 'OVERRIDDEN',
      attribution: makeAttr({ provided: ['identity'], missing: ['time'], category: 'input_missing', accuracy_signal: 'inaccurate' }) },
    // 必填齐 + 准 → 良性（null 类）
    { scenario_id: 'OPP_QUALIFY', human_disposition: 'CONFIRMED',
      attribution: makeAttr({ provided: ['identity', 'time'], missing: [], category: 'ok', accuracy_signal: 'accurate' }) },
  ];
  it('aggregates accuracy_rate + 4-class categories per gate', async () => {
    const gates = await getGateAttribution(null, { query: fakeQuery(rows) });
    const g = gates.find((x) => x.scenario_id === 'OPP_QUALIFY');
    expect(g).toBeTruthy();
    // 3 决策：accurate=1, inaccurate=2 → accuracy_rate = 1/3 ≈ 33.3
    expect(g.accuracy.accurate).toBe(1);
    expect(g.accuracy.inaccurate).toBe(2);
    expect(g.accuracy.accuracy_rate).toBeCloseTo(33.3, 0);
    // 4 类：inference_bias=1, input_error=1, input_missing=0, context_insufficient=0
    expect(g.categories.inference_bias).toBe(1);
    expect(g.categories.input_error).toBe(1);
    expect(g.categories.input_missing).toBe(0);
    // 必填完整率：filled=2 (两条齐) / total=3 → 66.7
    expect(g.required_fill_rate).toBeCloseTo(66.7, 0);
    expect(g.total).toBe(3);
  });
  it('returns a zeroed entry for gates with no decisions', async () => {
    const gates = await getGateAttribution(null, { query: fakeQuery([]) });
    const le = gates.find((x) => x.scenario_id === 'LEAD_FOLLOW_UP');
    expect(le).toBeTruthy();
    expect(le.total).toBe(0);
    expect(le.accuracy.accuracy_rate).toBeNull();
  });
  // T13 租户隔离（2026-09-04）：显式传租户 → SQL 必须带 (tenant_id=$1 OR tenant_id='system') 条件
  it('T13: adds tenant fallback condition when tenantId given', async () => {
    let captured = null;
    const spyQuery = async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    };
    await getGateAttribution('acme-b', { query: spyQuery });
    expect(captured.sql).toContain("(tenant_id=$1 OR tenant_id='system')");
    expect(captured.params).toEqual(['acme-b']);
  });
  // T13 租户隔离：缺省 '*'=全量 → 不带租户条件（行为兼容现状）
  it('T13: default widlcard leaves no tenant condition', async () => {
    let captured = null;
    const spyQuery = async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    };
    await getGateAttribution('*', { query: spyQuery });
    expect(captured.sql).not.toContain('tenant_id');
    expect(captured.params).toEqual([]);
  });
});
