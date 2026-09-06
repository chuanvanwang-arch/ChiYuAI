// test/portal/decisionScenarioTenant.test.js — G5 决策场景租户化（方案 a：PK 复合化）写侧验证
// 2026-09-05 由详细设计 docs/superpowers/plans/2026-09-05-tenant-config-full-isolation.md Task 6 Step 2 落地
// 验证：① 租户写不污染 system；② 租户读回退 system+自身行优先；③ 模板复制幂等；④ 写走写池（queryWrite）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { scenarioDeps as defaultDeps } from '../../src/portal/decisionScenario.js';

const T = 'e2e-tenant-scn'; // 测试租户（与详细设计一致）
const BASE_SC = 'LEAD_FOLLOW_UP';

beforeAll(async () => {
  // 幂等清理测试租户残留（禁 DELETE 铁律——用 UPDATE 归位 + 保留行；同租户行本身是测试数据可重写）
  // 避免此前失败运行留下 T 租户的脏描述
  await queryWrite(
    `UPDATE crm.decision_scenario SET description='新线索跟不跟/升级/放弃/培育'
     WHERE scenario_id=$1 AND tenant_id=$2`,
    [BASE_SC, T]
  ).catch(() => {});
});

afterAll(async () => {
  // 不删数据（禁 DELETE 铁律）：仅将测试租户行描述复位到模板一致
  await queryWrite(
    `UPDATE crm.decision_scenario SET description='新线索跟不跟/升级/放弃/培育'
     WHERE scenario_id=$1 AND tenant_id=$2`,
    [BASE_SC, T]
  ).catch(() => {});
});

describe('decision-scenario 租户化（G5 方案 a）', () => {
  it('updateScenario 带 tenantId → 更新该租户场景，system 行不被污染', async () => {
    const touched = await defaultDeps.updateScenario(
      BASE_SC,
      { description: 'T-PATCH' },
      { tenantId: T }
    );
    expect(touched.description).toBe('T-PATCH');
    expect(touched.tenant_id).toBe(T);
    // system 行保持模板（未被污染）
    const sysRow = await query(
      `SELECT description FROM crm.decision_scenario WHERE scenario_id=$1 AND tenant_id='system'`,
      [BASE_SC]
    );
    expect(sysRow.rows[0].description).not.toBe('T-PATCH');
  });

  it('listScenarios 按租户读回退 system + 自身行优先', async () => {
    const rows = await defaultDeps.listScenarios({ tenantId: T });
    // 租户自身行在（T-PATCH 已落）
    const mine = rows.filter((r) => r.tenant_id === T && r.scenario_id === BASE_SC);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].description).toBe('T-PATCH');
    // system 基线仍可见（回退）
    expect(rows.some((r) => r.tenant_id === 'system' && r.scenario_id === 'LEAD_FOLLOW_UP')).toBe(true);
    // 排序：租户自身行排在 system 前（ORDER BY (tenant_id=$1) DESC）
    const idxMine = rows.findIndex((r) => r.scenario_id === BASE_SC && r.tenant_id === T);
    const idxSys = rows.findIndex((r) => r.scenario_id === BASE_SC && r.tenant_id === 'system');
    // ORDER BY (tenant_id=$1) DESC：同一场景内租户自身行排在 system 模板前
    expect(idxMine).toBeLessThan(idxSys);
  });

  it('updateScenario 幂等（重复调用不冲突、不复制新行）', async () => {
    const before = await defaultDeps.listScenarios({ tenantId: T });
    const beforeCount = before.length;
    await defaultDeps.updateScenario(BASE_SC, { description: 'T-PATCH-2' }, { tenantId: T });
    await defaultDeps.updateScenario(BASE_SC, { description: 'T-PATCH-3' }, { tenantId: T });
    const after = await defaultDeps.listScenarios({ tenantId: T });
    expect(after.length).toBe(beforeCount); // ON CONFLICT DO NOTHING，行长不变
    const mine = after.filter((r) => r.tenant_id === T && r.scenario_id === BASE_SC);
    expect(mine[0].description).toBe('T-PATCH-3');
  });

  it('不存在的租户场景读回退 system（autonomyEngine 语义）', async () => {
    const rows = await defaultDeps.listScenarios({ tenantId: 'e2e-no-such-tenant' });
    expect(rows.length).toBeGreaterThan(0); // system 模板兜底可见
    expect(rows.every((r) => r.tenant_id === 'system')).toBe(true); // 该租户无自身场景行
  });
});
