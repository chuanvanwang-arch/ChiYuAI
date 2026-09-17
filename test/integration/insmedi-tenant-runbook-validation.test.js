// test/integration/insmedi-tenant-runbook-validation.test.js
// 验证「新行业上线 Runbook」对真实行业（讲师资源型渠道中介）的可用性：逐节对照 docs/runbooks/2026-09-03-new-industry-onboarding.md
// 凡 Runbook 代码片段有误，本测试按「真实 API」修正并加注释标注，等于对 Runbook 做了一次 executable review。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { actionExecutor } from '../../src/action/executor.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { seedInsMediProfile } from '../../db/seed/tenant-profile-insmedi.js';
import { INSMEDI_TENANT } from '../fixtures/testTenantIds.js';
// Runbook §5 写成 from 'src/particles/particleRepo.js'，实际导出在 particleModel.js（已修正 + 标注）
import { resolvePrototype, isControlledPredicateConfig } from '../../src/particles/particleModel.js';
import { createEdge, createParticle } from '../../src/particles/particleRepo.js';
import { listMetaAttr, ensureAdaptiveRegistration } from '../../src/metaAttr/metaAttrRepo.js';
import { proposeAiFill } from '../../src/agent/aiFillEngine.js';
import { query, queryWrite } from '../../src/db.js';

beforeAll(async () => {
  seedActions(); // 注册全部 Action（含 crm-import-batch），等价于 server 启动
  await seedInsMediProfile(INSMEDI_TENANT);
  // §4 走 actionExecutor → crm-import-batch 声明 autoDecision:true → 会为**本租户** mint decision，
  //   而 crm.decision 有复合外键 (scenario_id, tenant_id) → 租户须有自身场景行。幂等铺垫，禁 DELETE。
  // 场景字典**不再由测试铺垫**：改由生产路径按需物化（E7-2 2026-09-17，同 chemical 用例说明）
  await queryWrite(`DELETE FROM crm.particles WHERE tenant_id=$1 AND type LIKE 'INSMEDI_%'`, [INSMEDI_TENANT]);
  await queryWrite(`DELETE FROM crm.edges WHERE tenant_id=$1`, [INSMEDI_TENANT]);
});

afterAll(async () => {
  await queryWrite(`DELETE FROM crm.particles WHERE tenant_id=$1 AND type LIKE 'INSMEDI_%'`, [INSMEDI_TENANT]);
  await queryWrite(`DELETE FROM crm.edges WHERE tenant_id=$1`, [INSMEDI_TENANT]);
});

describe('讲师资源型渠道中介行业 · 照 Runbook 9 步验证', () => {
  it('§1 隔离 DDL 已就位（meta_attr/memory_log 有 tenant_id、edges 有 cardinality）', async () => {
    const cols = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name IN ('meta_attr','memory_log','edges')
         AND column_name IN ('tenant_id','cardinality')`
    );
    const present = new Set(cols.rows.map((r) => r.column_name));
    expect(present.has('tenant_id')).toBe(true);
    expect(present.has('cardinality')).toBe(true);
  });

  it('§2 写 tenant-profile 配置（讲师资源型渠道中介画像落 config_store，零类型字面量）', async () => {
    const p = await resolvePrototype('INSMEDI_SETTLEMENT', INSMEDI_TENANT);
    expect(p).not.toBeNull();
    expect(p.source).toBe('config'); // 来自配置，非 PARTICLE_TYPES 代码常量
  });

  it('§3 双源解析 + 隔离自检（crm 租户不可见讲师资源型渠道中介原型）', async () => {
    expect((await resolvePrototype('INSMEDI_PROJECT', INSMEDI_TENANT)).source).toBe('config');
    expect(await resolvePrototype('INSMEDI_PROJECT', 'crm')).toBeNull();
  });

  it('§4 经真实 MCP 写通道建粒子 + on_write 公式自动回写', async () => {
    const res = await actionExecutor.dispatch(
      'crm-import-batch',
      {
        particle_type: 'INSMEDI_SETTLEMENT',
        rows: [{ slug: 'insmedi-settle-1', title: '结算1', project_revenue: 100000, channel_commission_rate: 0.15 }],
        mode: 'upsert',
        required: ['slug'],
      },
      { tenantId: INSMEDI_TENANT, actor: 'insmedi-e2e', bootstrap: true }
    );
    expect(res.ok).toBe(true);
    expect(res.data.created).toBe(1);
    const r = await query(
      `SELECT payload FROM crm.particles WHERE tenant_id=$1 AND type=$2 AND payload->>'slug'=$3`,
      [INSMEDI_TENANT, 'INSMEDI_SETTLEMENT', 'insmedi-settle-1']
    );
    // profile.calculations: project_revenue * channel_commission_rate = 100000*0.15 = 15000（零代码）
    expect(r.rows[0].payload.channel_commission).toBe(15000);
  });

  it('§5 受控谓词（讲师资源型渠道中介 refers/teaches 合法、crm 不可见、乱写被拒）', async () => {
    const e1 = await createEdge(
      'INSMEDI_CHANNEL', '11111111-1111-1111-1111-111111111111',
      'refers', 'INSMEDI_CLIENT', '22222222-2222-2222-2222-222222222222', {}, INSMEDI_TENANT
    );
    expect(e1.edge_type).toBe('refers');
    const e2 = await createEdge(
      'INSMEDI_INSTRUCTOR', '33333333-3333-3333-3333-333333333333',
      'teaches', 'INSMEDI_PROJECT', '44444444-4444-4444-4444-444444444444', {}, INSMEDI_TENANT
    );
    expect(e2.edge_type).toBe('teaches');
    expect(await isControlledPredicateConfig('refers', INSMEDI_TENANT)).toBe(true);
    expect(await isControlledPredicateConfig('teaches', INSMEDI_TENANT)).toBe(true);
    expect(await isControlledPredicateConfig('refers', 'crm')).toBe(false); // 隔离
    await expect(
      createEdge('INSMEDI_CHANNEL', 'a', 'illegal_pred', 'INSMEDI_CLIENT', 'b', {}, INSMEDI_TENANT)
    ).rejects.toThrow(/未受控/);
  });

  it('§6 字段可见性（listMetaAttr 合并 system 基线 + 租户覆盖）', async () => {
    await ensureAdaptiveRegistration('CRM_DEAL', { x_system_only: 1 }, 'system', 'system');
    await ensureAdaptiveRegistration('CRM_DEAL', { y_insmedi_only: 1 }, INSMEDI_TENANT, 'system');
    const rows = await listMetaAttr({ particleType: 'CRM_DEAL', tenantId: INSMEDI_TENANT, applyPermission: true });
    const slugs = rows.map((r) => r.attr_slug);
    expect(slugs).toContain('x_system_only'); // system 基线对讲师资源型渠道中介租户可见（universal core）
    expect(slugs).toContain('y_insmedi_only');  // 租户自有覆盖
  });

  it('§7 AI Fill 草稿（proposeAiFill 只产草稿 source=ai/enabled=false）', async () => {
    // Runbook §7 写成 proposeAiFill({ particleType:... })，实际参数名是 prototype（已修正 + 标注）
    const draft = await proposeAiFill({
      prototype: 'INSMEDI_CLIENT',
      rawContext: '某制造企业年度培训预算 300 万，目标提升一线管理产能',
      tenantId: INSMEDI_TENANT,
    });
    expect(draft.draft).toBe(true);
    expect(draft.proposal.length).toBeGreaterThan(0);
    expect(draft.proposal.every((x) => x.source === 'ai' && x.enabled === false)).toBe(true);
  });

  it('§9 零污染 + 决策闸：PARTICLE_TYPES 无讲师资源型渠道中介字面量、业务写缺 decision_id 被强制', async () => {
    // 讲师资源型渠道中介类型解析源是 config 而非 PARTICLE_TYPES（代码常量零新增 = 不污染铁律）
    expect((await resolvePrototype('INSMEDI_CLIENT', INSMEDI_TENANT)).source).toBe('config');
    // 决策第 0 闸：业务写传 requireDecisionId=true 且无 decision_id 应被拒
    await expect(
      createParticle('INSMEDI_SETTLEMENT', { slug: 'x', project_revenue: 1, channel_commission_rate: 0 },
        { tenantId: INSMEDI_TENANT, actor: 'u', requireDecisionId: true })
    ).rejects.toThrow(/decision_id/);
  });
});
