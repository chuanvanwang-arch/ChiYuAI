// scripts/seed-closed-loop-demo.mjs — T-D8 端到端闭环 demo 种子（闭包 100%）
// 目的：在测试库 crm_native_test 造一个「单决策三图全闭合」示例，使 closure 的 D1-D5 全部 exists，
//   为 J3 校准写回、溯源面板提供首个真实闭环证据（替代 12:12 探测发现的 40% 桩）。
// 幂等：固定 UUID + ON CONFLICT DO NOTHING；决策本身用 createDecision（随机 UUID）走全链路物化路径，
//   故重复裸跑会追加新决策（不报错），测试 beforeEach/afterEach 自清理。
import { fileURLToPath } from 'node:url';
import { pool, queryWrite } from '../src/db.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { writeOutcome } from '../src/decision/outcome.js';

const SCEN = 'CLOSED_LOOP_DEMO';
const PARTICLE_ID = 'c1c1c1c1-0000-0000-0000-0000000000c1';
const PARTICLE_TYPE = 'CL_DEMO_DEAL';
const CAL_PATCH = 'd1d1d1d1-0000-0000-0000-0000000000d1';

// 导出供测试调用：返回 { parentId, decisionId }
export async function seedClosedLoopDemo() {
  // 场景（required_dims=[] 绕过维度守卫，专注闭环）
  await queryWrite(
    `INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions, required_dims)
     VALUES ($1,'sales','{}'::jsonb,'[]'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [SCEN]
  );

  // D5 K↔M：粒子类型的写时约束（meta_attr.required / source_refresh_sla）
  await queryWrite(
    `INSERT INTO crm.meta_attr(particle_type, attr_slug, title, attr_type, required, enabled, source_refresh_sla)
     VALUES ($1,'customer_name','客户名','text',true,true,'24 hours'),
            ($1,'amount','金额','number',true,true,'24 hours')
     ON CONFLICT (particle_type, attr_slug, tenant_id) DO NOTHING`,
    [PARTICLE_TYPE]
  );

  // D1 K→M：K 原料粒子（被决策 involved_entities 指向）
  await queryWrite(
    `INSERT INTO crm.particles(id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
     VALUES ($1,'system',$2,'cl-demo-deal','闭环示例商机','ACTIVE','{"customer_name":"示例客户","amount":100000}'::jsonb, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [PARTICLE_ID, PARTICLE_TYPE]
  );

  // 先例决策（供 D2 引用边）
  const parent = await createDecision({
    scenario_id: SCEN, disposition: 'APPROVED',
    trigger_context: { dim: 'B' }, involved_entities: [{ type: PARTICLE_TYPE, id: PARTICLE_ID }],
    conditions_evaluated: [{ name: 'x', met: true }], rationale: '先例（闭环示例）',
  });

  // 主决策：引用先例（D2 自动落 REFERENCED_PRECEDENT 边）+ 关联粒子（D1）+ 业务结果核验
  const child = await createDecision({
    scenario_id: SCEN, disposition: 'APPROVED',
    trigger_context: { dim: 'B' }, involved_entities: [{ type: PARTICLE_TYPE, id: PARTICLE_ID }],
    conditions_evaluated: [{ name: 'x', met: true }], rationale: '闭环示例主决策',
    referenced_precedents: [parent.decision_id], outcome_verified: 'won',
  });

  // D4 J→M：J2 业务结果回写 decision_outcome
  await writeOutcome(child.decision_id, { outcome_type: 'paid', source: 'manual', payload: { amount: 100000 } });

  // D3 J→K：经第0闸写回 K/M 的校准处方（运行时由 produceDecision 产生；此处 seed 一条 APPLIED 示例）
  await queryWrite(
    `INSERT INTO crm.calibration_patch(patch_id, scenario_id, knob, target, from_value, to_value, evidence, expected_impact, risk, status, decision_id, resolved_at, resolved_by)
     VALUES ($1,$2,'threshold','decision-context-guard','{"mode":"warn"}'::jsonb,'{"mode":"warn"}'::jsonb,'{"demo":true}'::jsonb,'{}'::jsonb,'LOW','APPLIED',$3, now(),'seed')
     ON CONFLICT (patch_id) DO NOTHING`,
    [CAL_PATCH, SCEN, child.decision_id]
  );

  return { parentId: parent.decision_id, decisionId: child.decision_id };
}

// 仅当以主模块方式运行（node scripts/seed-closed-loop-demo.mjs）时执行；被测试 import 时不触发
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  seedClosedLoopDemo()
    .then((r) => { console.log('[seed-closed-loop-demo] 完成，主决策：', r.decisionId); return pool.end(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[seed-closed-loop-demo] 失败：', e); process.exit(1); });
}
