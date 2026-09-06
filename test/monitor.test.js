// test/monitor.test.js — 销售决策监控存储聚合（Task 2）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { getGateMetrics, getDecisionList, getSevenDimCoverage, GATE_SCENARIOS } from '../src/monitor/monitorStore.js';

// 对齐 monitorStore.js:19-22 GATE_SCENARIOS 单一事实源（8 闸门，含 DEAL_REOPEN）
const GATES = ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING', 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW', 'DEAL_REOPEN'];

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event RESTART IDENTITY CASCADE');
});

describe('GATE_SCENARIOS', () => {
  it('7 闸门清单与真实 scenario 一致', () => {
    expect([...GATE_SCENARIOS].sort()).toEqual([...GATES].sort());
  });
});

describe('getGateMetrics', () => {
  it('按 scenario 聚合自主/升级/处置分布', async () => {
    await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'AUTONOMOUS',
    });
    await createDecision({
      scenario_id: 'QUOTE_PRICING', trigger_context: {}, conditions_evaluated: [],
      disposition: 'ESCALATE', business_tier: 'HIGH', state: 'HUMAN',
    });
    const m = await getGateMetrics({ scenario_id: 'LEAD_FOLLOW_UP' });
    expect(m.total).toBe(1);
    expect(m.autonomous).toBe(1);
    expect(m.escalated).toBe(0);
    const all = await getGateMetrics({});
    expect(all.total).toBe(2);
  });
  it('无决策时返回空指标（total=0）', async () => {
    const m = await getGateMetrics({ scenario_id: 'LOSS_REVIEW' });
    expect(m.total).toBe(0);
  });
});

describe('getSevenDimCoverage', () => {
  it('从 eval_dimensions 判定七维 provided/missing（D1 应 identity/governance/time provided）', async () => {
    const c = await getSevenDimCoverage({ scenario_id: 'LEAD_FOLLOW_UP' });
    expect(c.identity).toBe('provided');
    expect(c.governance).toBe('provided');
    expect(c.time).toBe('provided');
    // 未覆盖维（如 history 无 identity 类条件）→ missing
    expect(c.history).toBe('missing');
  });
  it('未知闸门返回全 missing', async () => {
    const c = await getSevenDimCoverage({ scenario_id: 'UNKNOWN_GATE' });
    expect(c.identity).toBe('missing');
  });
});

describe('getDecisionList', () => {
  it('复用 decisionRepo.listDecisions 返回决策列表', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'AUTONOMOUS',
    });
    const items = await getDecisionList({ scenario_id: 'LEAD_FOLLOW_UP' });
    expect(items.length).toBe(1);
    expect(items[0].decision_id).toBe(d.decision_id);
  });
  // T13 租户隔离（2026-09-04）：缺省 '*'=全量可见；显式传租户只见本租户+system 回退
  it('T13: getDecisionList 按租户过滤（缺省全量、显式仅租户+system）', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'AUTONOMOUS', tenantId: 'acme-b',
    });
    // 缺省 '*'=全量可见（现状兼容）
    const all = await getDecisionList({ scenario_id: 'LEAD_FOLLOW_UP' });
    expect(all.map((x) => x.decision_id)).toContain(d.decision_id);
    // 显式传租户 → 只见该租户决策
    const only = await getDecisionList({ scenario_id: 'LEAD_FOLLOW_UP', tenantId: 'acme-b' });
    expect(only.map((x) => x.decision_id)).toEqual([d.decision_id]);
    // 其他租户 → 不见（无 system 回退时为空）
    const other = await getDecisionList({ scenario_id: 'LEAD_FOLLOW_UP', tenantId: 'acme-c' });
    expect(other.length).toBe(0);
  });
});

describe('监控持久化订阅（Task 3）', () => {
  it('注册订阅后 decision 事件落库 crm.monitor_event', async () => {
    const { registerMonitorSubscriber, ensureMonitorSchema } = await import('../src/monitor/monitorSubscriber.js');
    const { on, emit } = await import('../src/events/bus.js');
    await ensureMonitorSchema();
    registerMonitorSubscriber();
    await emit('decision', 'made', {
      decision_id: '00000000-0000-0000-0000-000000000001',
      scenario_id: 'LEAD_FOLLOW_UP',
    });
    const n = (await query(`SELECT count(*)::int n FROM crm.monitor_event WHERE domain='decision'`)).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
  });
});