// scripts/smoke-lead-fit.mjs — LF-6 端到端冒烟（真库 crm_native_test）
//
// 计划：docs/superpowers/plans/2026-09-16-lead-fit-scorer.md §Task LF-6
// 链路：造测试 CRM_ACCOUNT → scoreLeadFit(纯函数) → 真铸 decision → createMonitorCtx(真实四件套+第0闸)
//       → monitorAccount（真库写回 payload + 追加 rescore 记忆）→ 断言落库
// 反证：decisionId=null → monitorAccount 写路径必拒（decision_required）
//
// ⚠ 相对导入（禁 file:///<绝对路径> 绝对路径——本仓已清零该反模式）
// ⚠ 仅跑 crm_native_test；勿对生产库执行写操作
// 运行：node scripts/smoke-lead-fit.mjs
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';

const { query, queryWrite } = await import('../src/db.js');
const { scoreLeadFit } = await import('../src/connectors/discovery/leadFitScorer.js');
const { createMonitorCtx } = await import('../src/connectors/discovery/monitorCtx.js');
const { monitorAccount } = await import('../src/connectors/discovery/monitorAccount.js');

const TENANT = `smoke-lead-fit-${process.pid.toString(36)}${Date.now().toString(36)}`;
const counts = [];
const log = (name, ok, detail) => { counts.push([name, ok]); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };

// 与单元测试同形的权重表（键为 discovery 全称——陷阱②），手算可复现
const RULES = {
  signals: {
    funding_round: { weight: 0.9 }, hiring_icp_role: { weight: 0.7 }, tender_match: { weight: 0.8 },
    leadership_change: { weight: 0.5 }, tech_adopt: { weight: 0.6 },
    website_redesign: { weight: 0.3 }, social_content: { weight: 0.4 },
  },
  signal_time_fields: { funding_round: 'funding_ts', hiring_icp_role: 'hiring_ts' },
  signal_age_tiers: [
    { max_days: 7, multiplier: 1.0 }, { max_days: 30, multiplier: 0.6 },
    { max_days: 90, multiplier: 0.3 }, { max_days: null, multiplier: 0.1 },
  ],
  icp: { industries: ['industrial_coatings', 'chemical'], min_headcount: 50, geo: ['CN'] },
};

const enrich = { industry: { value: 'chemical' }, headcount: { value: 120 }, country: { value: 'CN' } };
const sigs = [{ type: 'funding_round', ts: new Date().toISOString() }];

try {
  // ── ① 真评分：非占位 0.5，且与手算一致 ──
  const scored = scoreLeadFit({ account: { payload: { enrichment: enrich } }, signals: sigs, rules: RULES });
  // 手算：icp_fit=3/3=1.0；intent=0.9/(0.9+0.7+0.8+0.5+0.6+0.3+0.4)=0.9/4.2（ts 新鲜→mult 1.0）
  const handIcp = 1.0;
  const handIntent = 0.9 / 4.2;
  const ok1 = scored.icp_fit === handIcp && Math.abs(scored.intent - handIntent) < 1e-4
    && scored.icp_fit !== 0.5 && scored.intent !== 0.5;
  log('① scoreLeadFit 真评分（非占位0.5，与手算一致）', ok1, `icp=${scored.icp_fit} intent=${scored.intent}`);

  // ── ② 造测试 CRM_ACCOUNT（含 enrichment）──
  const accId = (await queryWrite(
    `INSERT INTO crm.particles (tenant_id, type, slug, title, state, payload)
     VALUES ($1,'CRM_ACCOUNT',$2,'smoke-lf','active',$3::jsonb) RETURNING id`,
    [TENANT, `smoke-lf-${TENANT}`, JSON.stringify({ name: 'smoke-lf', enrichment: enrich })]
  )).rows[0].id;
  log('② 造测试 CRM_ACCOUNT', !!accId, `accId=${accId}`);

  // ── ③ 真铸决策（满足 FK + 全部 NOT NULL）：取已存在的 system 场景 ──
  const scenarioId = (await query(
    `SELECT scenario_id FROM crm.decision_scenario WHERE tenant_id='system' LIMIT 1`
  )).rows[0]?.scenario_id;
  if (!scenarioId) throw new Error('crm_native_test 无 decision_scenario 种子，无法真铸决策');
  const decisionId = (await queryWrite(
    `INSERT INTO crm.decision
       (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'smoke','system','lead-fit smoke','NORMAL','REQUIRED')
     RETURNING decision_id`,
    [scenarioId]
  )).rows[0].decision_id;
  log('③ 真铸决策（落 crm.decision）', !!decisionId, `decisionId=${decisionId}`);

  // ── ④ monitorAccount 真跑通（真实四件套 + 第0闸）──
  const ctx = createMonitorCtx({ tenantId: TENANT, decisionId });
  const res = await monitorAccount(ctx, accId, sigs);
  const ok4 = res && res.accountId === accId && typeof res.score === 'number' && res.score > 0;
  log('④ monitorAccount 真跑通（写回 payload）', ok4, `score=${res?.score}`);

  // ── ⑤ 持久化落库断言 ──
  const part = (await query(
    `SELECT payload, decision_id FROM crm.particles WHERE id=$1`, [accId]
  )).rows[0];
  const disc = part?.payload?.discovery;
  const ok5a = disc && typeof disc.intent_score?.value === 'number'
    && Math.abs(disc.intent_score.value - res.score) < 1e-6;
  const ok5b = part?.decision_id === decisionId;
  const mem = await query(
    `SELECT count(*)::int n FROM crm.memory_log WHERE entity_id=$1 AND kind='rescore' AND tenant_id=$2`,
    [accId, TENANT]
  );
  const ok5c = mem.rows[0].n >= 1;
  log('⑤a payload.discovery.intent_score 已更新且等于返回分', ok5a, `value=${disc?.intent_score?.value}`);
  log('⑤b 粒子 decision_id 锚定到第0闸决策', ok5b);
  log('⑤c memory_log 含 kind=rescore 新行', ok5c, `n=${mem.rows[0].n}`);

  // ── ⑥ 反证：无决策 → 写路径拒（decision_required）──
  const ctx0 = createMonitorCtx({ tenantId: TENANT, decisionId: null });
  let threw = null;
  try { await monitorAccount(ctx0, accId, sigs); }
  catch (e) { threw = e; }
  const ok6 = threw && /decision_required/.test(threw.message);
  log('⑥ 反证：decisionId=null → monitorAccount 拒写（第0闸生效）', ok6, threw?.message);
} catch (e) {
  log('运行时异常', false, e.message);
  console.error(e.stack);
}

console.log('\n=== LF-6 冒烟结果 ===');
const allOk = counts.length > 0 && counts.every(([, ok]) => ok);
process.exit(allOk ? 0 : 1);
