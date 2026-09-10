import { describe, it, expect } from 'vitest';
import { computeMetrics, sampleTenant } from '../../scripts/sample-system-overview.mjs';

// 注入假数据源，无需真实库
const fakeQuery = async () => ({ rows: [{ tenant_id: 'acme' }, { tenant_id: 'globex' }] });
const fakeListSkill = async () => ([
  { skill_id: 'a', methodology_id: 'm1' },
  { skill_id: 'b', methodology_id: null },
  { skill_id: 'c', methodology_id: 'm2' },
]);
const fakeGate = async () => ([{ total: 4 }, { total: 6 }]);

describe('sample-system-overview computeMetrics', () => {
  it('返回三指标且 K 计 methodology_id 非空、D 计 gate total 之和', async () => {
    const m = await computeMetrics('acme', {
      query: fakeQuery, listSkillRegistry: fakeListSkill, getGateAttribution: fakeGate,
    });
    expect(m).toEqual([
      { metric: 'k_method_skill', value: 2 },
      { metric: 'm_precedent_edge', value: 0 },
      { metric: 'd_l1_intercept', value: 10 },
    ]);
  });
});

describe('sampleTenant upsert', () => {
  it('对每个指标调用一次 queryWrite（幂等 ON CONFLICT）', async () => {
    const upserts = [];
    const fakeQueryWrite = async (_sql, params) => { upserts.push(params); return { rowCount: 1 }; };
    await sampleTenant('acme', '2026-09-10', {
      query: fakeQuery, listSkillRegistry: fakeListSkill, getGateAttribution: fakeGate, queryWrite: fakeQueryWrite,
    });
    expect(upserts.length).toBe(3);
    expect(upserts.map((p) => p[2])).toEqual(['k_method_skill', 'm_precedent_edge', 'd_l1_intercept']);
    expect(upserts[0][0]).toBe('acme');
    expect(upserts[0][1]).toBe('2026-09-10');
  });
});
