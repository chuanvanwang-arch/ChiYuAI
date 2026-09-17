import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { withTx, query } from '../../src/db.js';
import { getStrategy } from '../../src/calibration/knobs/index.js';
import { readConf } from '../../src/calibration/store.js';
import { snapshotRequiredDims, restoreRequiredDims } from '../fixtures/scenarioDimsBaseline.js';

// 共享库卫生（2026-08-30 起因 → 2026-09-17 升级）：RequiredDimsStrategy.apply 写
// OPP_QUALIFY.required_dims 后不还原，单进程顺序下污染后续依赖 OPP_QUALIFY 的测试
// （decision.test.js / decision-gate.test.js）。原先还原值硬编码 '[]' —— 那不是种子真值
// （真值 = 4 个 warn 维，见主库 system 行），且整场景 UPDATE 无租户谓词 = 跨租户写全部行。
// 改为「开跑前快照各租户现值 → afterEach 按租户还原」。
let baseline;
beforeAll(async () => {
  baseline = await snapshotRequiredDims('OPP_QUALIFY');
});
afterEach(async () => {
  await restoreRequiredDims('OPP_QUALIFY', baseline);
});

describe('旋钮策略 · 接口与落点', () => {
  it('getStrategy 返回三策略实例', () => {
    expect(getStrategy('threshold')).toBeTruthy();
    expect(getStrategy('weight')).toBeTruthy();
    expect(getStrategy('required_dims')).toBeTruthy();
    expect(getStrategy('bogus')).toBeNull();
  });

  it('ThresholdStrategy.apply 写 config_store autonomy-conf.threshold', async () => {
    const strat = getStrategy('threshold');
    await withTx(async (client) => {
      await strat.apply(client, { threshold: 0.91 }, { scenario_id: null, target: null, decisionId: null, current: await readConf() });
    });
    const c = await readConf();
    expect(c.threshold).toBe(0.91);
  });

  it('WeightStrategy.apply 写 config_store autonomy-conf.weights[target]', async () => {
    const strat = getStrategy('weight');
    const cur = await readConf();
    await withTx(async (client) => {
      await strat.apply(client, { weights: { method: 0.5 } }, { scenario_id: null, target: 'method', decisionId: null, current: cur });
    });
    const c = await readConf();
    expect(c.weights.method).toBe(0.5);
  });
});

describe('RequiredDimsStrategy', () => {
  it('readCurrent 读 decision_scenario.required_dims', async () => {
    const s = getStrategy('required_dims');
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id='OPP_QUALIFY'`,
        [JSON.stringify([{ dim: 'identity', on_missing: 'warn' }])]);
    });
    const cur = await s.readCurrent('OPP_QUALIFY');
    expect(cur).toEqual([{ dim: 'identity', on_missing: 'warn' }]);
  });

  it('apply 写 decision_scenario.required_dims（不写 config_store）', async () => {
    const s = getStrategy('required_dims');
    const before = await readConf();
    await withTx(async (client) => {
      await s.apply(client, [{ dim: 'identity', on_missing: 'block' }], { scenario_id: 'OPP_QUALIFY' });
    });
    const after = await readConf();
    expect(after).toEqual(before); // config_store 不变
    const r = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id='OPP_QUALIFY'`);
    expect(r.rows[0].required_dims).toEqual([{ dim: 'identity', on_missing: 'block' }]);
  });

  it('riskLevel：block→warn 降级返回 HIGH', () => {
    const s = getStrategy('required_dims');
    expect(s.riskLevel([{ dim: 'identity', on_missing: 'block' }], [{ dim: 'identity', on_missing: 'warn' }])).toBe('HIGH');
  });
  it('riskLevel：warn→block 升严返回 MEDIUM', () => {
    const s = getStrategy('required_dims');
    expect(s.riskLevel([{ dim: 'identity', on_missing: 'warn' }], [{ dim: 'identity', on_missing: 'block' }])).toBe('MEDIUM');
  });
  it('riskLevel：移除 dim 要求返回 HIGH', () => {
    const s = getStrategy('required_dims');
    expect(s.riskLevel([{ dim: 'identity', on_missing: 'block' }], [])).toBe('HIGH');
  });
});
