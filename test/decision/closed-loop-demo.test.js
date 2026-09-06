// test/decision/closed-loop-demo.test.js — T-D8 端到端闭环 demo（闭包 100%）
// 调 seedClosedLoopDemo 造单决策三图全闭合示例，断言 closure 的 D1-D5 全部 exists。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { seedClosedLoopDemo } from '../../scripts/seed-closed-loop-demo.mjs';
import { getDecisionClosure } from '../../src/decision/closure.js';

const PARTICLE_ID = 'c1c1c1c1-0000-0000-0000-0000000000c1';
const PARTICLE_TYPE = 'CL_DEMO_DEAL';
const SCEN = 'CLOSED_LOOP_DEMO';

describe('T-D8 端到端闭环 demo（闭包 100%）', () => {
  let ids;
  beforeEach(async () => { ids = await seedClosedLoopDemo(); });
  afterEach(async () => {
    await queryWrite(
      `TRUNCATE crm.decision, crm.decision_provenance, crm.decision_relation, crm.decision_outcome,
                crm.decision_precedent_rel, crm.calibration_patch RESTART IDENTITY CASCADE`
    );
    await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [PARTICLE_ID]);
    await queryWrite(`DELETE FROM crm.meta_attr WHERE particle_type=$1`, [PARTICLE_TYPE]);
    await queryWrite(`DELETE FROM crm.decision_scenario WHERE scenario_id=$1`, [SCEN]);
  });

  it('demo 决策使 D1-D5 全部 exists（闭包 100%）', async () => {
    const b = await getDecisionClosure(ids.decisionId);
    expect(b).toBeTruthy();
    for (const d of ['D1', 'D2', 'D3', 'D4', 'D5']) {
      expect(b.crossLoopMap[d].exists).toBe(true);
    }
  });

  it('K 区解析到粒子、J 区含业务结果与校准处方', async () => {
    const b = await getDecisionClosure(ids.decisionId);
    expect(b.k.particles.length).toBeGreaterThan(0);     // D1 K→M
    expect(b.j.outcomes.length).toBeGreaterThan(0);       // D4 J→M
    expect(b.j.calibration_patches.length).toBeGreaterThan(0); // D3 J→K
  });
});
