import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, withTx } from '../../src/db.js';
import { createPatch, approvePatch, rollbackPatch, getPatch } from '../../src/calibration/store.js';
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';

describe('store · required_dims 处方批准/回滚', () => {
  beforeEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP_QUALIFY'`);
    });
  });

  // 修复共享库污染（2026-08-30）：approve 会把 block/降级后的 required_dims 留在库中，
  // 单进程顺序执行下污染后续其它文件的 OPP_QUALIFY 断言。afterEach 对称还原。
  afterEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP_QUALIFY'`);
    });
  });

  it('批准 required_dims 处方 → decision_scenario 生效 → sevenDimensionsCheck 拦截', async () => {
    const patch = await createPatch({
      scenario_id: 'OPP_QUALIFY', knob: 'required_dims', target: null,
      from_value: [], to_value: [{ dim: 'identity', on_missing: 'block' }],
      evidence: { source: 'test' }, expected_impact: { sample_size: 0 }, risk: 'MEDIUM',
    });
    await approvePatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    const p = await getPatch(patch.patch_id);
    expect(p.status).toBe('APPLIED');
    const chk = await sevenDimensionsCheck('OPP_QUALIFY', { identity: null });
    expect(chk.allowed).toBe(false); // block 生效
  });

  it('降级（block→warn）批准标 HIGH 且放宽拦截', async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id='OPP_QUALIFY'`,
        [JSON.stringify([{ dim: 'identity', on_missing: 'block' }])]);
    });
    const patch = await createPatch({
      scenario_id: 'OPP_QUALIFY', knob: 'required_dims', target: null,
      from_value: [{ dim: 'identity', on_missing: 'block' }], to_value: [{ dim: 'identity', on_missing: 'warn' }],
      evidence: { source: 'test' }, expected_impact: { sample_size: 0 }, risk: 'HIGH',
    });
    await approvePatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    const chk = await sevenDimensionsCheck('OPP_QUALIFY', { identity: null });
    expect(chk.allowed).toBe(true); // 放宽后允许写
  });

  it('回滚恢复 from_value', async () => {
    const patch = await createPatch({
      scenario_id: 'OPP_QUALIFY', knob: 'required_dims', target: null,
      from_value: [], to_value: [{ dim: 'identity', on_missing: 'block' }],
      evidence: { source: 'test' }, expected_impact: { sample_size: 0 }, risk: 'MEDIUM',
    });
    await approvePatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    await rollbackPatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    const p = await getPatch(patch.patch_id);
    expect(p.status).toBe('ROLLED_BACK');
    const r = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id='OPP_QUALIFY'`);
    expect(r.rows[0].required_dims).toEqual([]);
  });
});
