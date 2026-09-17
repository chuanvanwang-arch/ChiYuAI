// test/integration/training-tenant-e2e.test.js
// 选项 1：把培训租户画像接进「真实 MCP 写通道」跑端到端。
// 关键事实：src/mcp/gateway.js:150 的 MCP 写工具即 actionExecutor.dispatch(session.action, session.params, ctx)，
// 故本测试直接 dispatch('crm-import-batch', ...) 等价于经 MCP 写通道写入，是同一代码路径的确定性端到端证明。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { actionExecutor } from '../../src/action/executor.js';
// 副作用引入：seed-actions.js 模块顶层 registerAction(...) 注册全部 Action（含 crm-import-batch），
// 等价于 server 启动时的注册；不引入则 actionExecutor.dispatch 找不到 Action（返回未知 Action）。
import { seedActions } from '../../src/action/seed-actions.js';
import { seedTrainingProfile } from '../../db/seed/tenant-profile-training.js';
import { TRAINING_TENANT } from '../fixtures/testTenantIds.js';
import { resolvePrototype, isControlledPredicateConfig } from '../../src/particles/particleModel.js';
import { createEdge } from '../../src/particles/particleRepo.js';
import { listMetaAttr, ensureAdaptiveRegistration } from '../../src/metaAttr/metaAttrRepo.js';
import { query, queryWrite } from '../../src/db.js';

beforeAll(async () => {
  seedActions(); // 注册全部 Action（含 crm-import-batch），等价于 server 启动
  await seedTrainingProfile(TRAINING_TENANT);
  // 用例 1 走 actionExecutor → crm-import-batch 声明 autoDecision:true → 会为**本租户** mint decision，
  //   而 crm.decision 有复合外键 (scenario_id, tenant_id) → 租户须有自身场景行。幂等铺垫，禁 DELETE。
  // 场景字典**不再由测试铺垫**：改由生产路径按需物化（E7-2 2026-09-17，同 chemical 用例说明）
  await queryWrite(`DELETE FROM crm.particles WHERE tenant_id=$1 AND type LIKE 'TRAINING_%'`, [TRAINING_TENANT]);
  await queryWrite(`DELETE FROM crm.edges WHERE tenant_id=$1`, [TRAINING_TENANT]);
});

afterAll(async () => {
  await queryWrite(`DELETE FROM crm.particles WHERE tenant_id=$1 AND type LIKE 'TRAINING_%'`, [TRAINING_TENANT]);
  await queryWrite(`DELETE FROM crm.edges WHERE tenant_id=$1`, [TRAINING_TENANT]);
});

describe('培训租户 · 真实 MCP 写通道端到端', () => {
  it('crm-import-batch 经 actionExecutor 写入 TRAINING 粒子并触发 on_write 公式', async () => {
    const res = await actionExecutor.dispatch(
      'crm-import-batch',
      {
        particle_type: 'TRAINING_SETTLEMENT',
        rows: [{ slug: 'settle-e2e', title: '结算e2e', revenue: 100, cost: 60, commission_rate: 0.1 }],
        mode: 'upsert',
        required: ['slug'],
      },
      { tenantId: TRAINING_TENANT, actor: 'e2e', bootstrap: true }
    );
    expect(res.ok).toBe(true);
    expect(res.data.created).toBe(1);
    const r = await query(
      `SELECT payload FROM crm.particles WHERE tenant_id=$1 AND type=$2 AND payload->>'slug'=$3`,
      [TRAINING_TENANT, 'TRAINING_SETTLEMENT', 'settle-e2e']
    );
    // profile.calculations: (revenue - cost) * commission_rate = (100-60)*0.1 = 4
    expect(r.rows[0].payload.commission).toBe(4);
  });

  it('隔离：crm 租户解析不到培训原型、查不到培训粒子', async () => {
    const def = await resolvePrototype('TRAINING_PROJECT', 'crm');
    expect(def).toBeNull();
    const rows = await query(`SELECT id FROM crm.particles WHERE tenant_id='crm' AND type='TRAINING_PROJECT'`);
    expect(rows.rows.length).toBe(0);
  });

  it('受控谓词：培训租户 supplies 合法、crm 租户不可见、乱写被拒', async () => {
    const e = await createEdge(
      'TRAINING_PROVIDER', '11111111-1111-1111-1111-111111111111',
      'supplies', 'TRAINING_PROJECT', '22222222-2222-2222-2222-222222222222', {}, TRAINING_TENANT
    );
    expect(e.edge_type).toBe('supplies');
    expect(e.cardinality).toBe('many');
    expect(await isControlledPredicateConfig('supplies', TRAINING_TENANT)).toBe(true);
    expect(await isControlledPredicateConfig('supplies', 'crm')).toBe(false); // 隔离
    await expect(
      createEdge('TRAINER', 'a', 'illegal_pred', 'TRAINING_PROJECT', 'b', {}, TRAINING_TENANT)
    ).rejects.toThrow(/未受控/);
  });

  it('listMetaAttr 合并 system 基线 + 租户覆盖（universal core + per-tenant override）', async () => {
    await ensureAdaptiveRegistration('CRM_DEAL', { x_system_only: 1 }, 'system', 'system');
    await ensureAdaptiveRegistration('CRM_DEAL', { y_tenant_only: 1 }, TRAINING_TENANT, 'system');
    const rows = await listMetaAttr({ particleType: 'CRM_DEAL', tenantId: TRAINING_TENANT, applyPermission: true });
    const slugs = rows.map((r) => r.attr_slug);
    expect(slugs).toContain('x_system_only'); // system 基线对培训租户可见（universal core）
    expect(slugs).toContain('y_tenant_only');  // 租户自有覆盖
  });
});
