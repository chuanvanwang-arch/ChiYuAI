import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { query, withTx } from '../../src/db.js';
import { createPatch, approvePatch, rollbackPatch, getPatch } from '../../src/calibration/store.js';
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';
import { snapshotRequiredDims, restoreRequiredDims } from '../fixtures/scenarioDimsBaseline.js';

describe('store · required_dims 处方批准/回滚', () => {
  // 共享库快照/还原（2026-09-17 升级）：approve 会把 block/降级后的 required_dims 留在库中，
  // 单进程顺序执行下污染后续其它文件的 OPP_QUALIFY 断言。原先还原值硬编码 '[]' —— 非种子
  // 真值（真值 = 4 个 warn 维），且整场景 UPDATE 无租户谓词 = 跨租户写全部行（复合主键落地后）。
  // 改为「开跑前快照各租户现值 → afterEach 按租户还原」。
  let baseline;
  beforeAll(async () => {
    baseline = await snapshotRequiredDims('OPP_QUALIFY');
  });
  beforeEach(async () => {
    await withTx(async (client) => {
      for (const s of baseline) {
        await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP_QUALIFY' AND tenant_id=$1`, [s.tenant_id]);
      }
    });
  });

  // 修复共享库污染（2026-08-30 起因）：对称还原改为按租户快照还原。
  afterEach(async () => {
    await restoreRequiredDims('OPP_QUALIFY', baseline);
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
