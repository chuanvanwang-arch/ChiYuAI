// test/action/particle-update-tenant.test.js — data-particle-update 跨租户防御 + 场景可 mint（Action 层，DB 支撑）
// 背景（2026-09-09 方案 A）：data-particle-update 经 mcpExpose 对外开放前，handler 未传 tenantId →
//   particleRepo.js:190 的 F1 跨租户防御「不传即不校验」，外部智能体凭任意 id 可跨租户写（P0-1）；
//   且 gateway 代 mint 需 PARTICLE_UPDATE 场景存在（requireDecision 强校验，autonomyEngine.js:124）（P0-2）。
// 本用例为 P0-1 的验证锚点：去掉 tenantId 透传 → ② 必红；补上 → ② 必绿。
// 设计：docs/2026-09-09-mcp-particle-update-expose-design.md §5.2 / §5.4
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { seedActions } from '../../src/action/seed-actions.js';
import { actionExecutor } from '../../src/action/executor.js';
import { query, queryWrite } from '../../src/db.js';
import { requireDecision } from '../../src/decision/autonomyEngine.js';

const T1 = 'pu-tenant-a';
const T2 = 'pu-tenant-b';

describe('data-particle-update 跨租户防御（P0-1 锚点）', () => {
  let pa, pb, decId;
  beforeAll(async () => {
    seedActions();
    // P0-2 自播种：确保 PARTICLE_UPDATE 场景存在（与 db/test-setup.sql 同构，幂等）
    await query(
      `INSERT INTO crm.decision_scenario
         (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
       VALUES ('PARTICLE_UPDATE','meta','MCP/对话通道粒子事实变更（字段级并入，禁删）',
               '{"action":["data-particle-update"]}'::jsonb, ARRAY[]::TEXT[],
               '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"目标唯一（id 精确定位）","weight":0.33},{"cond":"ownership","label":"归属完整（同租户）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
               'NORMAL', TRUE)
       ON CONFLICT (scenario_id, tenant_id) DO NOTHING`
    ).catch(() => {});
    // 真实 mint（验证场景可 mint；亦满足 particles.decision_id 外键——必须是已存在的 decision 行）
    const d = await requireDecision('PARTICLE_UPDATE', { action: 'data-particle-update' }, [], { actor_id: 'alice' });
    decId = d?.decision?.decision_id;
    expect(decId, 'PARTICLE_UPDATE 场景必须能 mint 出 decision_id').toBeTruthy();
    // 注：payload 必须含 name（CRM_DEAL 元模型 required，缺则 normalizeFacts 抛错——
    //     与 test/particles/particleRepo.tenant.test.js 的既有失败同源，此处显式规避）
    const a = await queryWrite(
      `INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','pu-pa','pa','ACTIVE','{"name":"pa"}') RETURNING *`,
      [T1]
    );
    const b = await queryWrite(
      `INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','pu-pb','pb','ACTIVE','{"name":"pb"}') RETURNING *`,
      [T2]
    );
    pa = a.rows[0];
    pb = b.rows[0];
  });
  afterAll(async () => {
    await queryWrite(`DELETE FROM crm.particles WHERE slug IN ('pu-pa','pu-pb')`);
  });

  it('① 本租户更新放行（基线：非误伤）', async () => {
    const r = await actionExecutor.dispatch(
      'data-particle-update',
      { id: pa.id, patch: { name: 'pa' }, force: true },
      { tenantId: T1, actor: 'alice', decision_id: decId }
    );
    expect(String(r.error || '')).toBe('');
    expect(r.ok).toBe(true);
  });

  it('② 跨租户更新必须被拒（P0-1 锚点）', async () => {
    const r = await actionExecutor.dispatch(
      'data-particle-update',
      { id: pb.id, patch: { name: 'hacked' }, force: true },
      { tenantId: T1, actor: 'alice', decision_id: decId }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/cross_tenant_write_denied/);
  });

  it('③ system 租户豁免（平台/admin 跨租户治理写不被误伤）', async () => {
    const r = await actionExecutor.dispatch(
      'data-particle-update',
      { id: pb.id, patch: { name: 'pb' }, force: true },
      { tenantId: 'system', actor: 'admin', decision_id: decId }
    );
    expect(String(r.error || '')).toBe('');
    expect(r.ok).toBe(true);
  });
});
