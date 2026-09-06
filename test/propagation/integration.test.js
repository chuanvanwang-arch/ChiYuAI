// test/propagation/integration.test.js
// Task 8（真实 PG 全链路）：retro 落库产候选 → 读回候选 → accept（第0闸+upsert）→ loadPrecedentConf 即时回读 0.4
// 设计依据：docs/2026-09-04-param-propagation-hub-plan.md Task 8；设计文档 §7「闭环贯通」
// 铁律：
//   ① 禁 DELETE —— 播种数据不清理，追加式留痕；
//   ② per-tenant 隔离 —— accept 只改 TID 租户，system 租户不受影响（断言）；
//   ③ 决策第0闸 —— accept 必须经 requireDecision（此处桩掉决策链，避免污染 crm.decision / 依赖决策场景种子）。
// 运行：npx vitest run test/propagation/integration.test.js（依赖 crm_native_test@5433）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db.js';
import { runDecisionRetro } from '../../src/decision/retro.js';
import { acceptSuggestion, __setDeps } from '../../src/http/propagationRoutes.js';
import { loadPrecedentConf } from '../../src/decision/precedentScoring.js';
import { writeConfig, readConfig } from '../../src/config/configStore.js';

const TID = 'prop-test-tenant';
const SCENARIO = 'PROP_TEST_SCENARIO';
const N = 20; // MIN_SAMPLE=20，样本不足会走"不出处方"分支

// crm.decision.scenario_id 有外键 → decision_scenario(scenario_id)（PK 单列），须先播种场景。
// 用专属场景 PROP_TEST_SCENARIO 而非复用既有场景，避免污染其它测试的场景决策计数。
// ON CONFLICT DO NOTHING：场景已存在（重复跑）时幂等，符合迁移铁律。
async function seedScenario() {
  await pool.query(
    `INSERT INTO crm.decision_scenario (scenario_id, stage, trigger, eval_dimensions, tenant_id)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    ['PROP_TEST_SCENARIO', 'TEST_STAGE', '{}', '[]', 'system']
  );
}

// crm.decision 必填列（NOT NULL 且无默认）：scenario_id/trigger_context/involved_entities/
//   conditions_evaluated/disposition/decider_type/rationale/business_tier
async function seedDecisions() {
  for (let i = 0; i < N; i++) {
    await pool.query(
      `INSERT INTO crm.decision
         (scenario_id, trigger_context, involved_entities, conditions_evaluated,
          disposition, decider_type, rationale, business_tier, tenant_id, attribution, feedback, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
      [
        SCENARIO,
        JSON.stringify({ test: true, i }),
        JSON.stringify([]),
        JSON.stringify([]),
        'APPROVE',
        'AUTONOMOUS_AGENT',
        `传播中枢集成测试样本 ${i}`,
        'NORMAL',
        TID,
        JSON.stringify({ category: 'precedent_missing', required_fill: { missing: [] }, edge_compliance: {} }),
        JSON.stringify({ usable: true, major_deviation: false }),
      ]
    );
  }
}

describe('传播中枢 全链路（真实 PG）', () => {
  beforeAll(async () => {
    // 基线：该租户先例阈值 0.45（对应用户例子"从 0.45 调到 0.4"）
    await writeConfig('precedent-conf', { minSimilarity: 0.45 }, { tenantId: TID, updatedBy: 'seed' });
    await seedScenario(); // 外键前置（decision → decision_scenario）
    await seedDecisions();
    // 第0闸：桩掉决策链（集成关注配置生效，决策链由 unit test + e2e 覆盖）
    __setDeps({
      requireDecision: async () => ({ decision: { decision_id: 'TEST-D' } }),
      writeConfig,
      readConfig,
    });
  });

  it('retro 产 config_store 候选 → accept → loadPrecedentConf 回读 0.4（无需重启）', async () => {
    // ① 复盘落库（dryRun:false 才会 INSERT report，验证候选可持久化 + 可读回）
    const llmFactory = async () => async () => ({
      root_cause_class: 'DATA_QUALITY_PRECEDENT',
      draft_patches: [
        {
          knob: 'config_store',
          target: 'precedent-conf.minSimilarity',
          from_value: 0.45,
          to_value: 0.4,
          risk: 'LOW',
          label: '放宽先例检索阈值',
          evidence: { hit_rate: '0.21' },
        },
      ],
      confidence: 0.7,
      predicted_impact: '提升先例召回',
    });

    const report = await runDecisionRetro({ windowHours: 24, dryRun: false, llmFactory });
    expect(report.report_id).toBeTruthy(); // 已落库

    // ② 从库里读回最新 report 的 config_store 候选
    const rep = await pool.query(
      `SELECT report_id, draft_patches FROM crm.decision_retro_report WHERE report_id=$1`,
      [report.report_id]
    );
    const patches = Array.isArray(rep.rows[0]?.draft_patches)
      ? rep.rows[0].draft_patches
      : JSON.parse(rep.rows[0]?.draft_patches || '[]');
    const p = patches.find((x) => x.knob === 'config_store');
    expect(p, 'retro 应产出 config_store 候选').toBeTruthy();
    expect(p.tenant_id, '候选须带 tenant_id（Task 5）').toBe(TID);

    // ③ accept：经第0闸 + upsert 落盘
    const r = await acceptSuggestion(pool, {
      kind: 'config_store',
      ref: `retro:${report.report_id}:0`,
      patch: p,
      by: 'tester',
    });
    expect(r.ok).toBe(true);
    expect(r.decisionId).toBe('TEST-D'); // 第0闸命中
    expect(r.value.minSimilarity).toBe(0.4);

    // ④ 即时生效：loadPrecedentConf 无需重启即读到 0.4
    const conf = await loadPrecedentConf({ tenantId: TID });
    expect(conf.minSimilarity).toBe(0.4);
  });

  it('per-tenant 隔离：accept 不污染 system 租户', async () => {
    const sysConf = await loadPrecedentConf({ tenantId: 'system' });
    expect(sysConf.minSimilarity).not.toBe(0.4);
    // 该租户仍为 0.4（上一条用例已落）
    const own = await readConfig('precedent-conf', { tenantId: TID });
    expect(own?.value?.minSimilarity).toBe(0.4);
  });

  afterAll(async () => {
    // 禁 DELETE：播种决策与报告保留（追加式留痕，供审计/排查）
    await pool.end().catch(() => {});
  });
});
