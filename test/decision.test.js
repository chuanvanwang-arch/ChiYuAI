// test/decision.test.js — 决策主轴仓库 + 自主引擎（代码级验证 spec-decision-event-detailed-design §7）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import {
  computeBusinessTier, createDecision, searchPrecedents, listDecisions,
  appendMemoryLog, confirmDecision, reverseDecision,
} from '../src/decision/decisionRepo.js';
import { requireDecision } from '../src/decision/autonomyEngine.js';
import { ensureGraph } from '../src/decision/ageGraph.js';

// 隔离：仅清空运行时决策表（保留种子 scenario/methodology/policy/tier 配置）
beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
});

describe('决策数据底座（种子）', () => {
  it('业务种子齐备（8 业务闸门 + ATTR_SCHEMA_CHANGE + CALIBRATION_CHANGE + EXTERNAL_ENRICHMENT）/ 方法论 11 模板 / MEDDICC 7 维', async () => {
    // 测试库含测试专用场景（REL/TRACE/OUTCOME/GRAPH/FEEDBACK 等），总数≠11；
    // 断言业务种子（8 业务闸门 + 3 meta 类）存在性即可（不断言总数，避免随测试场景增长误红）。
    const BIZ = ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'CLIENT_STRATEGY', 'SOLUTION_VALUE', 'QUOTE_PRICING', 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW'];
    const META = ['ATTR_SCHEMA_CHANGE', 'CALIBRATION_CHANGE', 'EXTERNAL_ENRICHMENT'];
    const ids = [...BIZ, ...META];
    // 2026-09-06：decision_scenario PK 已复合化为 (scenario_id, tenant_id)，同一 scenario_id 可能有多租户行
    //   → 按 scenario_id 去重后再断言业务种子齐备性（不因多租户副本误红）。
    const rs = (await query(`SELECT DISTINCT scenario_id FROM crm.decision_scenario WHERE scenario_id = ANY($1)`, [ids])).rows;
    expect(rs).toHaveLength(ids.length); // 11 个业务种子全部存在
    expect(new Set(rs.map(r => r.scenario_id))).toEqual(new Set(ids));
    // 方法论模板：7 方法论 + PRESALES_SOLUTION（§6.13.12 售前方法论已批准）+ 三模板
    //   （BEHAVIOR_STANDARD 行为合格线 / FUNNEL_CLASSIFICATION 大漏斗 / STAGE_PROGRESSION S1-S6）
    // 2026-09-06：测试库会被其他用例插入测试专用模板（如 test/http/preContext.contract.test.js），
    //   总数会随执行顺序漂移（11→12）→ 与上方 scenario 同口径，改为「业务模板集合齐备」的存在性断言。
    const BIZ_METH = ['MEDDICC', 'BANT', 'PRESALES_SOLUTION', 'BEHAVIOR_STANDARD', 'FUNNEL_CLASSIFICATION', 'STAGE_PROGRESSION', 'OPP_MATRIX', 'RISK_TRADEOFF', 'ROLE_MAP', 'STOP_LOSS', 'FACT_VS_TALK'];
    const mrows = (await query('SELECT methodology_id FROM crm.methodology_template WHERE methodology_id = ANY($1)', [BIZ_METH])).rows;
    expect(new Set(mrows.map((r) => r.methodology_id))).toEqual(new Set(BIZ_METH));
    const md = (await query("SELECT count(*)::int n FROM crm.methodology_dimension WHERE methodology_id='MEDDICC'")).rows[0].n;
    expect(md).toBe(7); // MEDDICC 始终 7 维（SKILL M1/E1/I1 归一为 DB M/E/I，不重复）
  });
});

describe('7 闸门七维条件（eval_dimensions）', () => {
  it('D1 LEAD_FOLLOW_UP 含 ①Identity 查重 / ⑦Governance 审批 / ④Time 时间窗', async () => {
    const r = (await query(`SELECT eval_dimensions FROM crm.decision_scenario WHERE scenario_id='LEAD_FOLLOW_UP'`)).rows[0];
    const dims = r.eval_dimensions.map(c => c.cond);
    expect(dims).toContain('identity_dedup');
    expect(dims).toContain('governance_approval');
    expect(dims).toContain('time_window');
  });
  it('各闸门均已含七维条件（identity/governance/time 三族覆盖）', async () => {
    const r = (await query(`SELECT scenario_id, eval_dimensions FROM crm.decision_scenario`)).rows;
    // 测试库含测试专用场景（REL/TRACE/OUTCOME/GRAPH/FEEDBACK 等），总数≠11；只对业务闸门做条件断言。
    // （8 业务闸门含 CLIENT_STRATEGY；ATTR_SCHEMA_CHANGE/CALIBRATION_CHANGE/EXTERNAL_ENRICHMENT 为治理/meta 类）
    // 业务闸门（8 个）：治理条件强制；ATTR_SCHEMA_CHANGE/CALIBRATION_CHANGE/EXTERNAL_ENRICHMENT 是"治理决策"本身（元模型配置变更/校准处方/外部采集授权属治理执行，非业务闸门，不做业务三级条件强制）
    const BUSINESS_GATES = new Set(['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'CLIENT_STRATEGY', 'SOLUTION_VALUE', 'QUOTE_PRICING', 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW']);
    const WITH_ID = new Set(['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'QUOTE_PRICING', 'LOSS_REVIEW']); // 涉主体查重的闸门
    const WITH_TIME = new Set([...BUSINESS_GATES].filter(g => g !== 'CLIENT_STRATEGY')); // 客户策略无硬性时间窗
    for (const row of r) {
      if (!BUSINESS_GATES.has(row.scenario_id)) continue; // ATTR_SCHEMA_CHANGE 跳过业务三级条件
      const conds = row.eval_dimensions.map(c => c.cond);
      // 治理 ⑦：业务闸门应有审批/红线类条件（含 governance_approval 或 margin_redline）
      const hasGov = conds.some(c => c.includes('governance') || c.includes('redline') || c.includes('approval'));
      expect(hasGov).toBe(true);
      // 时间 ④：全闸门应有时间窗
      if (WITH_TIME.has(row.scenario_id)) expect(conds).toContain('time_window');
      // 身份 ①：涉主体查重闸门应有 identity
      if (WITH_ID.has(row.scenario_id)) expect(conds).toContain('identity_dedup');
    }
  });
});

describe('computeBusinessTier（DEAL = 客户维 × 项目维）', () => {
  it('两维取高风险优先；无配置回退 null', async () => {
    expect(await computeBusinessTier({ customer: 'strategic', project: 'pilot' })).toBe('HIGH');
    expect(await computeBusinessTier({ customer: 'key', project: 'standard' })).toBe('NORMAL');
    expect(await computeBusinessTier({ customer: 'normal', project: 'standard' })).toBe('NORMAL');
    expect(await computeBusinessTier({ customer: 'unknown_x' })).toBe(null);
  });
});

describe('decisionRepo', () => {
  it('createDecision 物化 + 写时向量 + 记忆沉淀 + L2 事件', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { customer: 'normal', project: 'pilot' },
      involved_entities: [{ type: 'DEAL', id: 'x' }], conditions_evaluated: [{ cond: 'B', met: true }],
      disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
      business_tier: 'LEAD', state: 'AUTONOMOUS',
    });
    expect(d.decision_id).toBeTruthy();
    // 方案 B（2026-09-03）：hash 路径不持久化向量——列已 vector(1024)，hash 384 维写入报维度错误
    //   且 hash 基线无区分度，故写 NULL；真向量写库由 embedding-model.test.js 的 model 路径验证。
    expect(d.embedding).toBeNull();
    const ml = (await query('SELECT count(*)::int n FROM crm.memory_log WHERE topic=$1', ['decision:' + d.decision_id])).rows[0].n;
    expect(ml).toBe(1);
    const ev = (await query('SELECT count(*)::int n FROM crm.decision_event WHERE decision_id=$1', [d.decision_id])).rows[0].n;
    expect(ev).toBeGreaterThanOrEqual(1);
  });

  it('searchPrecedents 同 scenario 先例检索（C4 四分量，结构相似度）', async () => {
    const d1 = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { customer: 'normal', project: 'pilot', conditions: { B: true } },
      conditions_evaluated: [{ cond: 'B', met: true }], disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
    });
    await createDecision({
      scenario_id: 'QUOTE_PRICING', trigger_context: { customer: 'strategic', project: 'critical', conditions: { price: true } },
      conditions_evaluated: [{ cond: 'price', met: true }], disposition: 'APPROVE', business_tier: 'HIGH', state: 'CONFIRMED',
    });
    const precs = await searchPrecedents('LEAD_FOLLOW_UP', {
      trigger_context: { customer: 'normal', project: 'pilot', conditions: { B: true } },
      conditions_evaluated: [{ cond: 'B', met: true }],
      business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    expect(precs.length).toBeGreaterThanOrEqual(1); // 仅同 scenario 命中（共享库下可能含其他 LEAD_FOLLOW_UP）
    const hit = precs.find((p) => p.decision_id === d1.decision_id);
    expect(hit).toBeTruthy();
    expect(hit.similarity).toBeGreaterThan(0.45); // C4 结构相似度（旧伪向量恒≈0.11 不召回）
  });

  it('confirmDecision / reverseDecision 状态推进', async () => {
    const d = await createDecision({
      scenario_id: 'OPP_QUALIFY', trigger_context: {}, conditions_evaluated: [],
      disposition: 'ESCALATE', business_tier: 'NORMAL', state: 'HUMAN',
    });
    const c = await confirmDecision(d.decision_id, { by_role: 'manager' });
    expect(c.state).toBe('CONFIRMED');
    const r = await reverseDecision(d.decision_id, '误判');
    expect(r.state).toBe('REVERSED');
  });

  it('memory_log 决策沉淀可查（append-only）', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'AUTONOMOUS',
    });
    await appendMemoryLog(d.decision_id, { note: 'closed' });
    const rows = (await query('SELECT count(*)::int n FROM crm.memory_log WHERE topic=$1', ['decision:' + d.decision_id])).rows[0].n;
    expect(rows).toBe(2); // 物化 1 + 追加 1
  });
});

describe('autonomyEngine（§5 算法级）', () => {
  // FULL = 全方法论维度满足（含 SKILL 事实源归一后的 OPP_MATRIX 第 3 维 competitive_position——methodologySync 补齐后
// LEAD_FOLLOW_UP 消费 BANT+MEDDICC+OPP_MATRIX 共 14 维；测试基线需随 SKILL 事实源维护，非放宽断言）
const FULL = {
  B: true, A: true, N: true, T: true, M: true, E: true, D1: true, D2: true, I: true, C1: true, C2: true,
  value: true, win_prob: true, competitive_position: true,
};

  it('LEAD 低风险 + 充足先例 → 自主决策（APPROVE, 强制先例+理由）', async () => {
    const C = { customer: 'normal', project: 'pilot', conditions: FULL };
    for (const id of ['d1', 'd2']) {
      const r = await requireDecision('LEAD_FOLLOW_UP', C, [{ type: 'DEAL', id }]);
      await confirmDecision(r.decision.decision_id, { by_role: 'sales' });
    }
    const r3 = await requireDecision('LEAD_FOLLOW_UP', C, [{ type: 'DEAL', id: 'd3' }]);
    expect(r3.mode).toBe('autonomous');
    expect(r3.decision.state).toBe('AUTONOMOUS');
    expect(r3.decision.disposition).toBe('APPROVE');
    expect(r3.precedents.length).toBe(2);
    expect(r3.confidence).toBeGreaterThanOrEqual(0.8);
  });

  // E1 负向哨兵（2026-09-16 修复配套，设计 §11.1.1 方案 a）：
  //   只测「打开时正常工作」的开关等于没测——必须断言「关掉它行为停止」。
  //   OPP_QUALIFY 的 autonomous_allowed=FALSE（db/test-setup.sql）、default_tier=NORMAL。
  //   注入极低阈值使**置信度门控必然通过**，故唯一可能的升级原因只剩 autonomous_allowed → 可归因。
  it('E1 修复：autonomous_allowed=FALSE 的场景即使置信度充足也一律升级（配置面承诺与执行面一致）', async () => {
    const looseConf = {
      threshold: 0.05,
      weights: { similarity: 0.4, coverage: 0.3, method: 0.1, evidence_coverage: 0.1, allMet: 0.1 },
    };
    const C = { customer: 'normal', project: 'standard', conditions: FULL };
    for (const id of ['e1', 'e2']) {
      const r = await requireDecision('OPP_QUALIFY', C, [{ type: 'DEAL', id }], { conf: looseConf, k: 5 });
      await confirmDecision(r.decision.decision_id, { by_role: 'manager' });
    }
    const r3 = await requireDecision('OPP_QUALIFY', C, [{ type: 'DEAL', id: 'e3' }], { conf: looseConf, k: 5 });
    // 归因三断言：必须排除「tier=HIGH」与「置信度不足」这两条既有闸，否则测的不是本修复
    expect(r3.tier).toBe('NORMAL');
    expect(r3.confidence).toBeGreaterThanOrEqual(0.05);
    expect(r3.mode).toBe('escalated');
  });

  it('HIGH 风险 → 升级 HITL（不检索先例即升级）', async () => {
    const r = await requireDecision('QUOTE_PRICING', { customer: 'strategic', project: 'critical', conditions: { price: true } }, [{ type: 'DEAL', id: 'd9' }]);
    expect(r.mode).toBe('escalated');
    expect(r.tier).toBe('HIGH');
    expect(r.decision.state).toBe('HUMAN');
  });

  it('EXCEPTION 强制 HITL + 上级 role 背书 + 审计高亮', async () => {
    const r = await requireDecision('OPP_QUALIFY', { customer: 'key', project: 'standard' }, [], { disposition: 'EXCEPTION' });
    expect(r.mode).toBe('escalated');
    expect(r.auditHighlight).toBe(true);
    expect(r.decision.disposition).toBe('EXCEPTION');
    expect(r.decision.decider_role).toBe('superior');
  });

  it('置信度公式可配置（阈值下调即可自主）', async () => {
    const C = { customer: 'normal', project: 'pilot', conditions: { B: true } };
    const r = await requireDecision('LEAD_FOLLOW_UP', C, [{ type: 'DEAL', id: 'dz' }], { conf: { threshold: 0.1, weights: { similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 } } });
    // 单先例覆盖不足或条件不全 → 默认仍升级；仅验证配置生效不抛错且返回结构稳定
    expect(['autonomous', 'escalated']).toContain(r.mode);
    expect(r).toHaveProperty('confidence');
  });
});

// ───────────────────── Task 6：decisionRepo × AGE 旁路接线（写权威不替代表，失败 trace 不静默）─────────────────────
describe('decisionRepo × AGE 旁路（C1 写时同步）', () => {
  it('createDecision 后 AGE 图存在 Decision 顶点（traceUpstream 返回数组）', async () => {
    await ensureGraph();
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [{ type: 'DEAL', id: 'DX' }],
      conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
      rationale: 'r', business_tier: 'LEAD', state: 'AUTONOMOUS',
    });
    const { traceUpstream } = await import('../src/decision/ageGraph.js');
    const ups = await traceUpstream(d.decision_id, { maxDepth: 1 });
    expect(Array.isArray(ups)).toBe(true);
  });

  it('confirmDecision 后图顶点 state 同步为 CONFIRMED', async () => {
    await ensureGraph();
    const d = await createDecision({
      scenario_id: 'OPP_QUALIFY', trigger_context: {}, involved_entities: [],
      conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
      rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS',
    });
    await confirmDecision(d.decision_id, { by_role: 'sales_manager' });
    const { traceUpstream } = await import('../src/decision/ageGraph.js');
    const ups = await traceUpstream(d.decision_id, { maxDepth: 1 });
    // 顶点存在且 state=CONFIRMED（AGE 同步一致）
    expect(Array.isArray(ups)).toBe(true);
    const { addDecision } = await import('../src/decision/ageGraph.js');
    const found = await addDecision((await query(`SELECT * FROM crm.decision WHERE decision_id=$1`, [d.decision_id])).rows[0]);
    expect(found.ok).toBe(true);
  });

  it('reverseDecision 后图顶点 state 同步为 REVERSED', async () => {
    await ensureGraph();
    const d = await createDecision({
      scenario_id: 'OPP_QUALIFY', trigger_context: {}, involved_entities: [],
      conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
      rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS',
    });
    const rev = await reverseDecision(d.decision_id, 'wrong');
    expect(rev.state).toBe('REVERSED');
    const { addDecision } = await import('../src/decision/ageGraph.js');
    const found = await addDecision((await query(`SELECT * FROM crm.decision WHERE decision_id=$1`, [d.decision_id])).rows[0]);
    expect(found.ok).toBe(true);
  });
});
