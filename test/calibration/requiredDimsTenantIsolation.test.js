// test/calibration/requiredDimsTenantIsolation.test.js
// 验证「按租户」裁决落地：required_dims 校准写入/读取**只**作用于本租户行，不污染其他租户（含 system）。
// 对应 2026-09-17 待裁决项：src/calibration/knobs/requiredDims.js:16（apply 无 tenant 谓词 → 跨租户写）
//   与 src/sevenDimensions/engine.js:13（sevenDimensionsCheck 无 tenant 谓词 → 跨租户读）。
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { withTx } from '../../src/db.js';
import { ensureTenantScenarioSafely } from '../../src/decision/decisionRepo.js';
import { RequiredDimsStrategy } from '../../src/calibration/knobs/requiredDims.js';
import { snapshotRequiredDims, restoreRequiredDims } from '../fixtures/scenarioDimsBaseline.js';

const SCENARIO = 'OPP_QUALIFY';
const TENANT_A = 'test-tenant-iso-a';
const TENANT_B = 'test-tenant-iso-b';

describe('required_dims 按租户隔离', () => {
  let baseline;
  beforeAll(async () => {
    await ensureTenantScenarioSafely({ tenantId: TENANT_A, scenario_id: SCENARIO, where: 'iso-test' });
    await ensureTenantScenarioSafely({ tenantId: TENANT_B, scenario_id: SCENARIO, where: 'iso-test' });
    baseline = await snapshotRequiredDims(SCENARIO); // ⚠ 必须 await：返回数组而非 Promise
  });
  afterEach(async () => {
    await restoreRequiredDims(SCENARIO, baseline);
  });

  it('apply 只改本租户行，不污染其他租户 / system', async () => {
    const toValue = [{ dim: 'identity', on_missing: 'block' }];
    await withTx(async (client) => {
      const strat = new RequiredDimsStrategy('required_dims');
      await strat.apply(client, toValue, { scenario_id: SCENARIO, tenantId: TENANT_A });
      const rows = await client.query(
        `SELECT tenant_id, required_dims FROM crm.decision_scenario WHERE scenario_id=$1`,
        [SCENARIO]
      );
      const byTenant = Object.fromEntries(rows.rows.map((r) => [r.tenant_id, r.required_dims]));
      const baseA = baseline.find((b) => b.tenant_id === TENANT_A)?.required_dims;
      const baseB = baseline.find((b) => b.tenant_id === TENANT_B)?.required_dims;
      const baseSys = baseline.find((b) => b.tenant_id === 'system')?.required_dims;
      // 本租户行被改写
      expect(byTenant[TENANT_A]).toEqual(toValue);
      expect(byTenant[TENANT_A]).not.toEqual(baseA);
      // 其他租户（含 system）保持基线 —— 跨租户写已消除
      expect(byTenant[TENANT_B]).toEqual(baseB);
      expect(byTenant['system']).toEqual(baseSys);
    });
  });

  it('sevenDimensionsCheck 读本租户行（缺则回退 system）', async () => {
    const toValueA = [{ dim: 'identity', on_missing: 'block' }];
    // 写入在事务内提交（apply 用限定名 crm.decision_scenario，不依赖 search_path）
    await withTx(async (client) => {
      const strat = new RequiredDimsStrategy('required_dims');
      await strat.apply(client, toValueA, { scenario_id: SCENARIO, tenantId: TENANT_A });
    });
    // 读侧走默认池连接（带 search_path=crm）—— 即生产真实读路径
    const { sevenDimensionsCheck } = await import('../../src/sevenDimensions/engine.js');
    const chkA = await sevenDimensionsCheck(SCENARIO, {}, { tenantId: TENANT_A });
    expect(chkA.required).toEqual(toValueA); // 读本租户行
    const chkB = await sevenDimensionsCheck(SCENARIO, {}, { tenantId: TENANT_B });
    const baseB = baseline.find((b) => b.tenant_id === TENANT_B)?.required_dims || [];
    expect(chkB.required).toEqual(baseB); // 未改 B，仍读 B 的基线
  });
});
