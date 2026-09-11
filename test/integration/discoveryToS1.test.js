// test/integration/discoveryToS1.test.js
// Task 10：S1 衔接验证（复用 intake-router + BANT，不新增 · test-only）。
// 连接真实 PG（crm_native_test），专用租户 'discovery-t10'。
// 目的：证明「自主发现 → S1 落库 → 第 0 闸真落决策 → 既有阶段/BANT 闸 + A 接诊分流复用」整链无新增代码即成立。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { actionExecutor, salesStageGate } from '../../src/action/executor.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { routeThroughIntake } from '../../src/kanban/scheduler.js';
import { S_STAGES, S_GATE_DEFS } from '../../src/sales/stageTaxonomy.js';
import { query, queryWrite } from '../../src/db.js';

const TENANT = 'discovery-t10';

// 租户场景预置（G5「全隔离」必需）：crm.decision(#0 闸 mint) 的复合外键
//   decision_scenario_tenant_fkey 要求 (scenario_id, tenant_id) 在 decision_scenario 存在。
//   getScenario 的「租户缺失回退 system」只解决**读取**，不解决**写入** FK → 新租户首 mint 会 FK 违例，
//   故须先把 system 模板克隆到本租户。范式同 portal/decisionScenario.js:192-202 与
//   migration-decision-scenario-tenant-pk.sql:41-49；亦为既有集成测试惯例
//   （test/propagation/integration.test.js:20-27「crm.decision 有外键，须先播种场景」）。
async function seedTenantScenario() {
  await queryWrite(
    `INSERT INTO crm.decision_scenario
       (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions,
        default_tier, autonomous_allowed, dispositions, tenant_id)
     SELECT scenario_id, stage, description, trigger, methodology_ids, eval_dimensions,
            default_tier, autonomous_allowed, dispositions, $1
     FROM crm.decision_scenario WHERE scenario_id='LEAD_FIT' AND tenant_id='system'
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [TENANT]
  );
}

beforeAll(async () => {
  seedActions();               // 全部基础 Action 注册（等价 server 启动）
  seedDiscoveryActions();      // 必须显式调用：seedActions() 不含 discovery 族注册
  await seedTenantScenario();  // 租户专属 LEAD_FIT 场景（#0 闸 mint 的 FK 前置）
  await queryWrite(`DELETE FROM crm.particles WHERE tenant_id=$1`, [TENANT]);
  await queryWrite(`DELETE FROM crm.edges WHERE tenant_id=$1`, [TENANT]);
});

afterAll(async () => {
  await queryWrite(`DELETE FROM crm.particles WHERE tenant_id=$1`, [TENANT]);
  await queryWrite(`DELETE FROM crm.edges WHERE tenant_id=$1`, [TENANT]);
});

describe('Task 10 · discovery → S1 衔接（复用既有管道，零新增）', () => {
  // 共享一次 discovery-run 的落库结果，供①②共用（避免重复触发发现）
  let dealRow;
  let accountRow;

  it('① 落库归一：discovery-run 经真实写通道产出 S1 DEAL + potential ACCOUNT', async () => {
    const res = await actionExecutor.dispatch(
      'discovery-run',
      { seed: { name: 'T10 线索客户', domain: 't10.example.com' } },
      { tenantId: TENANT, actor: 't10', bootstrap: true }
    );
    // bootstrap:true 已豁免第 1.7 闸（entitlement，executor.js:106）与第 3 闸（needsApproval，executor.js:156）；
    // 第 0 闸守卫仍生效（handler 内 requireMintedDecision），故 res.ok=true 即证明决策确已 mint。
    expect(res.ok).toBe(true);

    const deals = await query(
      `SELECT id, payload FROM crm.particles WHERE tenant_id=$1 AND type='CRM_DEAL'`,
      [TENANT]
    );
    expect(deals.rows.length).toBe(1);
    dealRow = deals.rows[0];
    // 归一依据：stageTaxonomy S_ALIAS_FWD.lead='S1'；particleRepo.normalizeStage 写入时即归一（particleRepo.js:20-27）
    expect(dealRow.payload.stage).toBe('S1');
    expect(dealRow.payload.source).toBe('discovery');
    expect(dealRow.payload.account_id).toBeTruthy();

    const accounts = await query(
      `SELECT id, payload FROM crm.particles WHERE tenant_id=$1 AND type='CRM_ACCOUNT'`,
      [TENANT]
    );
    expect(accounts.rows.length).toBe(1);
    accountRow = accounts.rows[0];
    expect(accountRow.payload.state).toBe('potential');
    expect(accountRow.payload.name).toBe('T10 线索客户');
  });

  it('② 决策第 0 闸真落行（防「场景缺失→静默不写」假绿）', async () => {
    // 契约校正：runDiscovery 的返回值不含 decision_id；why_narrative 由 discoveryOrchestrator.js:82
    //   写入 **ACCOUNT** 粒子（update(account.id, { enrichment, discovery })），**不在 DEAL** 上。
    //   （任务书原文写「从 DEAL payload 提取」与源码不符——以源码为准，读 ACCOUNT。）
    const narrative = accountRow?.payload?.discovery?.why_narrative;
    expect(typeof narrative).toBe('string');
    const m = narrative.match(/decision_id=([\w-]+)/);
    expect(m).not.toBeNull();
    const decisionId = m[1];
    expect(decisionId).toBeTruthy();
    expect(decisionId).not.toBe('pending');

    const d = await query(`SELECT decision_id FROM crm.decision WHERE decision_id=$1`, [decisionId]);
    expect(d.rows.length).toBe(1); // 第 0 闸真实落行（非静默跳过）
  });

  it('③ 既有阶段/BANT 闸复用（不新增）：salesStageGate S1→S2 需求事实硬闸', () => {
    // BANT/阶段闸在 executor.js:165 的第 3.5 闸内联调用；直调 handler 会绕过 → 此处直调真闸函数。
    const blocked = salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: {} });
    expect(blocked.ok).toBe(false);
    expect(Array.isArray(blocked.gaps)).toBe(true);
    expect(blocked.gaps.length).toBeGreaterThan(0);

    // needs 三维齐备（product/qty/spec）→ 放行（阈值 gate.s1_s2_min_need_facts 出厂 2）
    const passed = salesStageGate({
      curStage: 'S1', toStage: 'S2',
      dealPayload: { needs: { product: 'X', qty: 1, spec: 'Y' } },
    });
    expect(passed.ok).toBe(true);
  });

  it('④ 既有接诊分流复用（不新增）：routeThroughIntake A 入口路由', () => {
    // 纯函数（scheduler.js:38-91）：入参 kanban task（payload.intent / payload.level），零 DB。
    const routed = routeThroughIntake({
      id: 'task-t10-lead',
      payload: { intent: 'followup', level: 'L2', source: 'discovery' },
    });
    expect(routed.targetAgent).toBe('followup-agent'); // 线索跟进 → C 智能体
    expect(routed.payload.level).toBe('normal');       // L2 → normal（非 major，不挂 review-gate）
    expect(routed.payload.dispatchedFrom).toBe('intake-router');
    expect(Array.isArray(routed.gateAgents)).toBe(true);
  });

  it('⑤ 零新增护栏：阶段字典与闸定义未被本 Task 改动', () => {
    expect(S_STAGES.length).toBe(8);
    expect(S_GATE_DEFS[0].from).toBe('S1');
    expect(S_GATE_DEFS[0].to).toBe('S2');
  });
});
