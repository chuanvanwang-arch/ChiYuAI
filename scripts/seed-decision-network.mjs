// scripts/seed-decision-network.mjs — 为 sales-decision-monitor 决策网络补充真实因果链样本
// 设计：围绕现有 OPP_QUALIFY 根决策 a9660788-... 构造一条从线索跟进到丢单复盘的完整决策链。
// 幂等：所有 INSERT 使用 ON CONFLICT DO NOTHING；可重复执行。
// 影响表：crm.decision（1 条新决策 + 5 条 rationale 更新）、crm.decision_precedent_rel、crm.decision_relation（7 类边齐备）、crm.decision_outcome（4 条结果回写）、crm.decision_provenance、AGE crm_decision_network。

import { pool, queryWrite } from '../src/db.js';
import { ensureGraph, addDecision as addAgeDecision, addEdge } from '../src/decision/ageGraph.js';
import { trackEntry } from '../src/decision/provenance.js';

const ROOT_ID = 'a9660788-2e72-4c8b-9a69-c55ed421e8c4';
const LEAD_ID = 'dec00001-0000-0000-0000-000000000001';
const QUOTE_ID = 'c4384ad6-d6fb-4803-99c3-90cfd0be8070';
const SIGN_RISK_ID = '1ae078b5-e9f1-481b-b1b1-ab4e7130ae65';
const LOSS_REVIEW_ID = '34e33897-eaeb-46c2-b86b-97867b126d00';
const TENANT_ID = 'system';

const nowIso = new Date().toISOString();

function ctx(name, stage, amount, accountId, dealId) {
  return JSON.stringify({
    name,
    stage,
    expected_amount: amount,
    account_id: accountId,
    deal_id: dealId,
    event: 'decision_required',
    owner: '王川',
  });
}

function entities(dealId, accountId) {
  return JSON.stringify([
    { id: dealId, type: 'CRM_DEAL' },
    { id: accountId, type: 'CRM_ACCOUNT' },
  ]);
}

function conds(evaluated) {
  return JSON.stringify({ evaluated, engine_version: 'seed-v1' });
}

async function upsertDecision(id, scenario, tier, disposition, rationale, triggerContext, involvedEntities, conditionsEvaluated) {
  await queryWrite(
    `INSERT INTO crm.decision
       (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated,
        disposition, decider_type, decider_id, decider_role, rationale,
        business_tier, state, referenced_precedents, tenant_id, decided_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$15)
     ON CONFLICT (decision_id) DO UPDATE SET
       scenario_id=EXCLUDED.scenario_id,
       trigger_context=EXCLUDED.trigger_context,
       involved_entities=EXCLUDED.involved_entities,
       conditions_evaluated=EXCLUDED.conditions_evaluated,
       disposition=EXCLUDED.disposition,
       rationale=EXCLUDED.rationale,
       business_tier=EXCLUDED.business_tier,
       updated_at=EXCLUDED.updated_at`,
    [id, scenario, triggerContext, involvedEntities, conditionsEvaluated,
      disposition, 'engine', 'seed-script', 'seed', rationale,
      tier, 'REQUIRED', JSON.stringify([]), TENANT_ID, nowIso]
  );
}

async function upsertPrecedent(decisionId, precedentId, similarity = 0.92) {
  await queryWrite(
    `INSERT INTO crm.decision_precedent_rel (decision_id, precedent_id, similarity)
     VALUES ($1,$2,$3) ON CONFLICT (decision_id, precedent_id) DO NOTHING`,
    [decisionId, precedentId, similarity]
  );
  // 同步决策行 referenced_precedents（jsonb 幂等去重追加）：
  // listDecisions 读的是 decision 行字段而非关系表——不同步则记忆闭环读数为 0（2026-09-01 实测）。
  await queryWrite(
    `UPDATE crm.decision SET
       referenced_precedents = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) FROM (
           SELECT DISTINCT elem FROM jsonb_array_elements(
             COALESCE(referenced_precedents, '[]'::jsonb) || to_jsonb($2::uuid)
           ) elem
         ) t
       ),
       updated_at = $3
     WHERE decision_id = $1`,
    [decisionId, precedentId, nowIso]
  );
}

async function upsertRelation(fromId, toId, relType, servesDimension) {
  await queryWrite(
    `INSERT INTO crm.decision_relation (from_id, to_id, rel_type, serves_dimension, props, source)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (from_id, to_id, rel_type) DO NOTHING`,
    [fromId, toId, relType, servesDimension, JSON.stringify({ seeded: true, at: nowIso }), 'seed-script']
  );
}

// T6 业务结果回写（L2 反馈回路）：幂等 upsert outcome + 回写决策行 outcome_verified
// 回写决策行是「真闭环」关键：/api/monitor/gate-outcome 读 crm.decision.outcome_verified，
// 仅写 decision_outcome 表时 L2 看板仍读不到结果（2026-09-01 实测 decision.outcome_verified 全 null）。
async function upsertOutcome(decisionId, outcomeType, payload, confidence, createdBy) {
  await queryWrite(
    `INSERT INTO crm.decision_outcome
       (decision_id, outcome_type, source, payload, confidence, verified_at, created_by)
     VALUES ($1,$2,$3,$4,$5, $6::timestamptz, $7)
     ON CONFLICT (decision_id, outcome_type, source) DO UPDATE SET
       payload=EXCLUDED.payload, confidence=EXCLUDED.confidence, verified_at=EXCLUDED.verified_at`,
    [decisionId, outcomeType, 'seed-script', JSON.stringify(payload), confidence, nowIso, createdBy]
  );
  // 回写决策行（口径：outcome_type 直接映射 outcome_verified；与 getGateOutcome 的 won/paid 判定一致）
  await queryWrite(
    `UPDATE crm.decision SET outcome_verified=$2, updated_at=$3 WHERE decision_id=$1`,
    [decisionId, outcomeType, nowIso]
  );
}

async function seed() {
  console.log(' decision network seed: start');

  // 1. 确保 AGE 图存在（幂等）
  await ensureGraph();

  // 2. 新增/补齐「线索跟进」上游决策（根决策的源头）
  await upsertDecision(
    LEAD_ID, 'LEAD_FOLLOW_UP', 'LEAD', 'PROCEED',
    '客户银通包装通过官网询盘进入；行业匹配印刷包装、预计预算 12 万、对接人为采购经理，判定值得跟进并培育为商机。',
    ctx('银通包装·彩盒打样询盘', 'lead', 120000, 'a1111111-1111-1111-1111-111111111101', 'd1111111-1111-1111-1111-111111111111'),
    entities('d1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111101'),
    conds({ industry_fit: 0.85, budget_cycle: 0.60, pain_clear: 0.70, contact_level: 0.65, our_fit: 0.80 })
  );
  console.log('  upserted LEAD_FOLLOW_UP decision:', LEAD_ID);

  // 3. 更新现有决策的 rationale + 上下文元数据，使其更像真实业务理由
  const decisionMeta = {
    [ROOT_ID]: {
      rationale: '基于 LEAD_FOLLOW_UP 结论，客户需求明确（药品说明书画册）、预算周期匹配、决策链相对完整，判定为真机会，允许进入方案阶段。',
      involved: entities('d2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111101'),
      conditions: conds({ pain_source: 0.85, budget_approved: 0.70, decision_chain: 0.75, competition: 0.60, win_prob: 0.65 }),
    },
    [QUOTE_ID]: {
      rationale: 'opp 已确认，客户要求三级报价；我方目标价 38 万、底价 34 万，拟给予 5% 早签折扣并锁定 30% 预付款，折扣未超毛利红线。',
      involved: entities('d2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111101'),
      conditions: conds({ price_vs_floor: 0.80, discount_condition: 0.75, pay_ratio: 0.70, margin_redline: 0.90 }),
    },
    [SIGN_RISK_ID]: {
      rationale: '签单前出现反对者（生产副总质疑交付周期），需求变更量 <10%，已协调交付人力并量化验收标准，风险可控建议签约。',
      involved: entities('d2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111101'),
      conditions: conds({ opposer_level: 0.70, change_volume: 0.20, delivery_staff: 0.85, accept_std: 0.80 }),
    },
    [LOSS_REVIEW_ID]: {
      rationale: '最终客户因竞品低价中标且内部预算冻结选择暂停；保留内部支持者情报，评估 12 个月内预算重启可能性，建议长期孵化。',
      involved: entities('d2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111101'),
      conditions: conds({ future_budget: 0.55, pain_longterm: 0.70, internal_supporter: 0.80, strategic_value: 0.60 }),
    },
  };
  for (const [id, m] of Object.entries(decisionMeta)) {
    await queryWrite(
      `UPDATE crm.decision SET rationale=$1, involved_entities=$2, conditions_evaluated=$3, updated_at=$4 WHERE decision_id=$5`,
      [m.rationale, m.involved, m.conditions, nowIso, id]
    );
    console.log('  updated meta:', id.slice(0, 8) + '…');
  }

  // 4. 构造先例关系（CTE 降级路径 + PG 权威边共用）
  // 语义：decision_precedent_rel(decision_id, precedent_id) 表示 decision_id 引用 precedent_id 作为先例
  // 链：LEAD -> OPP_QUALIFY(root) -> QUOTE -> SIGN_RISK -> LOSS_REVIEW
  await upsertPrecedent(ROOT_ID, LEAD_ID, 0.88);          // root 引用 lead 为先例
  await upsertPrecedent(QUOTE_ID, ROOT_ID, 0.91);          // quote 引用 root 为先例
  await upsertPrecedent(SIGN_RISK_ID, QUOTE_ID, 0.85);     // sign risk 引用 quote 为先例
  await upsertPrecedent(LOSS_REVIEW_ID, SIGN_RISK_ID, 0.82); // loss review 引用 sign risk 为先例
  console.log('  upserted precedent relations');

  // 5. 构造 7 类 typed 决策边（PG 权威）
  // 边方向与 precedent_rel 一致：from=依赖方，to=被依赖方（先例/原因）
  // 7 类齐备：REFERENCED_PRECEDENT / CAUSED / INFLUENCED / DERIVED_FROM_EXCEPTION
  //          + DECIDED_ON / ESTABLISHES_FRAME / OVERRIDES（T6 补齐，使图上 7 色边模型完整）
  await upsertRelation(ROOT_ID, LEAD_ID, 'REFERENCED_PRECEDENT', 'identity_dedup');
  await upsertRelation(QUOTE_ID, ROOT_ID, 'CAUSED', 'budget_approved');
  await upsertRelation(SIGN_RISK_ID, QUOTE_ID, 'INFLUENCED', 'opposer_level');
  await upsertRelation(LOSS_REVIEW_ID, SIGN_RISK_ID, 'DERIVED_FROM_EXCEPTION', 'future_budget');
  // T6 补 3 类：根决策「基于」线索决策作出（决定作用于上游背景）；QUOTE 建立报价框架；SIGN_RISK 覆盖原框架
  await upsertRelation(ROOT_ID, LEAD_ID, 'DECIDED_ON', 'identity');
  await upsertRelation(QUOTE_ID, ROOT_ID, 'ESTABLISHES_FRAME', 'semantics');
  await upsertRelation(SIGN_RISK_ID, QUOTE_ID, 'OVERRIDES', 'governance');
  console.log('  upserted typed relations (7 types complete)');

  // 6. 同步 AGE 图镜像（失败不阻断）
  for (const id of [LEAD_ID, ROOT_ID, QUOTE_ID, SIGN_RISK_ID, LOSS_REVIEW_ID]) {
    const d = (await queryWrite(`SELECT * FROM crm.decision WHERE decision_id=$1`, [id])).rows[0];
    if (d) await addAgeDecision(d).catch((e) => console.log('  AGE addDecision skipped:', e.message));
  }
  await addEdge('REFERENCED_PRECEDENT', ROOT_ID, LEAD_ID, { reason: 'seed' }).catch(() => {});
  await addEdge('CAUSED', QUOTE_ID, ROOT_ID, { reason: 'seed' }).catch(() => {});
  await addEdge('INFLUENCED', SIGN_RISK_ID, QUOTE_ID, { reason: 'seed' }).catch(() => {});
  await addEdge('DERIVED_FROM_EXCEPTION', LOSS_REVIEW_ID, SIGN_RISK_ID, { reason: 'seed' }).catch(() => {});
  console.log('  synced AGE graph');

  // 7. 审计链条目（PROV-O · crm.decision_provenance）
  //    2026-08-31 修复：原实现只给【根决策】写 2 条，且【不幂等】——重跑会重复 append，
  //    而 S14 决策图谱受控页默认取「最新决策」（当前为 LEAD 线索决策）→ 其溯源链 subtable 恒为
  //    「暂无数据」死区。改为：①覆盖决策链上全部 5 个决策；②幂等（已有条目则整体跳过，
  //    保留首次写入的 checksum 链，不重复、不破坏 verifyChain）。
  const PROV_PLAN = [
    { id: LEAD_ID, entries: [
      { entry_type: 'decision', payload: { scenario_id: 'LEAD_FOLLOW_UP', disposition: 'PROCEED', rationale: '官网询盘进入，客户有明确彩盒打样需求，先进入培育流程', source: 'seed-script' } },
      { entry_type: 'outcome', payload: { outcome: 'stalled', rationale: '线索暂缓：客户预算周期未到，转入长期培育', source: 'seed-script' } },
    ] },
    { id: ROOT_ID, entries: [
      { entry_type: 'decision', payload: { scenario_id: 'OPP_QUALIFY', disposition: 'PROCEED', rationale: '预算已批、决策链已识别，商机成立转入方案与报价', source: 'seed-script' } },
      { entry_type: 'relationship', payload: { rel_type: 'REFERENCED_PRECEDENT', precedent_id: LEAD_ID, rationale: '沿用线索阶段的客户身份去重结论', source: 'seed-script' } },
    ] },
    { id: QUOTE_ID, entries: [
      { entry_type: 'decision', payload: { scenario_id: 'QUOTE_PRICING', disposition: 'PROCEED', rationale: '早签折扣 5% 换 30% 预付款，毛利仍在阈值内', source: 'seed-script' } },
      { entry_type: 'outcome', payload: { outcome: 'paid', amount: 380000, rationale: '合同回款已完成', source: 'seed-script' } },
    ] },
    { id: SIGN_RISK_ID, entries: [
      { entry_type: 'decision', payload: { scenario_id: 'SIGN_RISK', disposition: 'PROCEED', rationale: '生产副总反对已通过样板验证协调化解，风险可控', source: 'seed-script' } },
      { entry_type: 'outcome', payload: { outcome: 'won', amount: 380000, rationale: '签约成功', source: 'seed-script' } },
    ] },
    { id: LOSS_REVIEW_ID, entries: [
      { entry_type: 'decision', payload: { scenario_id: 'LOSS_REVIEW', disposition: 'PROCEED', rationale: '丢单复盘：竞品低价中标叠加客户内部预算冻结', source: 'seed-script' } },
      { entry_type: 'outcome', payload: { outcome: 'lost', rationale: '保留内部支持者情报，评估 12 个月内预算重启可能', source: 'seed-script' } },
    ] },
  ];
  let provAppended = 0;
  for (const p of PROV_PLAN) {
    const existing = await pool.query(
      `SELECT count(*)::int AS n FROM crm.decision_provenance WHERE decision_id=$1`, [p.id]
    );
    if (existing.rows[0] && existing.rows[0].n > 0) continue; // 幂等：保留首次写入的链
    for (const e of p.entries) {
      await trackEntry({
        decision_id: p.id, entry_type: e.entry_type, payload: e.payload,
        source: 'seed-script', activity_id: 'seed-decision-network',
      });
      provAppended++;
    }
  }
  console.log(`  provenance entries: +${provAppended}（幂等：已有条目的决策跳过）`);

  // 8. L2 业务结果回写（T6）：为决策链末端补真实 outcome，形成「决策→结果→复盘」闭环
  //    语义：QUOTE→paid（报价后成交）、SIGN_RISK→won（签单成功）、LOSS_REVIEW→lost（丢单复盘）、LEAD→stalled（线索暂缓）
  await upsertOutcome(QUOTE_ID, 'paid', {
    amount: 380000, invoiced: true, paid_at: nowIso,
    note: '客户银通包装早签折扣 5% 锁定 30% 预付款，合同回款已完成',
  }, 0.96, 'seed-script');
  await upsertOutcome(SIGN_RISK_ID, 'won', {
    amount: 380000, signed_at: nowIso,
    note: '生产副总反对经协调化解，签约成功',
  }, 0.90, 'seed-script');
  await upsertOutcome(LOSS_REVIEW_ID, 'lost', {
    amount: 0, reason: '竞品低价中标 + 内部预算冻结',
    note: '保留内部支持者情报，评估 12 个月内预算重启可能性',
  }, 0.88, 'seed-script');
  await upsertOutcome(LEAD_ID, 'stalled', {
    note: '官网询盘进入，培育期暂缓推进',
  }, 0.62, 'seed-script');
  console.log('  upserted L2 outcomes (paid/won/lost/stalled)');

  console.log(' decision network seed: done');
  await pool.end();
}

seed().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  pool.end();
});
