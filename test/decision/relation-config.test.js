// test/decision/relation-config.test.js — T32 边绑定配置运行时接线（relation.js 缓存 + override）
// 契约：
//   · loadEdgeSpecOnce({query}) 模块级懒加载：首写边读 config_store['seven-dim']，之后缓存；
//   · fail-safe：缺配置/校验失败 → spec 回退默认（linkDecisions 的 primaryDimension 不受影响）；
//   · invalidateEdgeSpecCache() 清缓存（供测试/配置变更后重载）；
//   · linkDecisions(edgeSpecOverride) 显式注入覆盖（测试友好，不依赖真实 DB）。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  linkDecisions, loadEdgeSpecOnce, invalidateEdgeSpecCache,
} from '../../src/decision/relation.js';
import { DEFAULT_EDGE_DIMENSION_SPEC } from '../../src/decision/edgeDimensionSpec.js';

const SCN = 'REL_CFG_SCEN';
const D_A = 'd1000000-0000-0000-0000-0000000001a0';
const D_B = 'd1000000-0000-0000-0000-00000000b1d0';

function fakeQuery(returns) {
  let calls = 0;
  const fn = async () => { calls += 1; return { rows: returns }; };
  fn.calls = () => calls;
  return fn;
}

beforeEach(() => invalidateEdgeSpecCache());

describe('T32 loadEdgeSpecOnce（模块级缓存）', () => {
  it('无配置 → fail-safe 回退默认 spec + loaded=false', async () => {
    const q = fakeQuery([{ value: null }]);
    const c = await loadEdgeSpecOnce({ query: q });
    expect(c.loaded).toBe(false);
    expect(c.spec).toBe(DEFAULT_EDGE_DIMENSION_SPEC);
  });

  it('有合法 edge_bindings → loaded=true + 采用配置 spec', async () => {
    const q = fakeQuery([{ value: { edge_bindings: DEFAULT_EDGE_DIMENSION_SPEC } }]);
    const c = await loadEdgeSpecOnce({ query: q });
    expect(c.loaded).toBe(true);
    expect(c.spec).toHaveLength(7);
  });

  it('懒加载缓存：第二次调用不再查 DB', async () => {
    const q = fakeQuery([{ value: null }]);
    await loadEdgeSpecOnce({ query: q });
    await loadEdgeSpecOnce({ query: q });
    expect(q.calls()).toBe(1);
  });

  it('invalidate 后重新加载（配置变更后可刷新）', async () => {
    const q = fakeQuery([{ value: null }]);
    await loadEdgeSpecOnce({ query: q });
    invalidateEdgeSpecCache();
    await loadEdgeSpecOnce({ query: q });
    expect(q.calls()).toBe(2);
  });
});

describe('T32 linkDecisions edgeSpecOverride（真实 DB 集成）', () => {
  it('显式注入覆盖 spec → serves_dimension 取配置主维度', async () => {
    const spec = [
      ...DEFAULT_EDGE_DIMENSION_SPEC.filter((r) => r.edge_type !== 'REFERENCED_PRECEDENT'),
      { edge_type: 'REFERENCED_PRECEDENT', serves_dimension: ['governance'], direction: 'decision->decision' },
    ];
    const qw = (await import('../../src/db.js')).queryWrite;
    // 清理上一次残留 + 满足 FK（decision_relation 引用 crm.decision，决策引用 crm.decision_scenario）
    // to_id 已放宽为 TEXT：跨 uuid/text 两列比较须 ::text 显式转换（避免 inconsistent types 参数推断）
    await qw('DELETE FROM crm.decision_relation WHERE from_id::text=$1::text OR to_id::text=$1::text', [D_A]);
    await qw('DELETE FROM crm.decision_relation WHERE from_id::text=$1::text OR to_id::text=$1::text', [D_B]);
    await qw('DELETE FROM crm.decision WHERE decision_id IN ($1,$2)', [D_A, D_B]);
    await qw(`INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions)
              VALUES ('REL_CFG_SCEN','测试','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, []);
    const mkDecision = async (id) => qw(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
       VALUES ($1,'REL_CFG_SCEN','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','AUTONOMOUS')`,
      [id]
    );
    await mkDecision(D_A);
    await mkDecision(D_B);
    const r = await linkDecisions(D_A, D_B, 'REFERENCED_PRECEDENT', { edgeSpecOverride: spec, servesDimension: null });
    expect(r.servesDimension).toBe('governance');
    const row = (await qw('SELECT serves_dimension FROM crm.decision_relation WHERE from_id::text=$1::text AND rel_type=$2', [D_A, 'REFERENCED_PRECEDENT'])).rows[0];
    expect(row.serves_dimension).toBe('governance');
    await qw('DELETE FROM crm.decision_relation WHERE from_id::text=$1::text OR from_id::text=$2::text', [D_A, D_B]);
    await qw('DELETE FROM crm.decision WHERE decision_id IN ($1,$2)', [D_A, D_B]);
  });
});