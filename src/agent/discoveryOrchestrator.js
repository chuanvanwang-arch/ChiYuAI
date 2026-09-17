// src/agent/discoveryOrchestrator.js — 线索自主发现主编排（设计 v8.1 §2 发现循环 ①-④）
// 契约校正（2026-09-11）：ctx 上**没有** createParticle/updateParticle/findParticle/createEdge
//   （executor.js:208 只传 (params, ctx)；ctx = {tenantId, actor, decision_id, bootstrap, channel, ...}）。
//   故一律**直调 particleRepo 并透传 ctx.tenantId**（设计 §9.1 原话；范式同 connectorActions.js:38,41），
//   同时开放 deps 注入供单测替换（生产默认=真实现，不留假绿缝隙）。
// 铁律：
//   ① 写必带第 0 闸 decision_id（requireDecisionId 透传 repo；缺值由 Task 5 的 requireMintedDecision 先拦）
//   ② 租户隔离 = 每次写透传 tenantId（对照 id18/17/21/15 伪隔离坑：本路径走「载体自带 tenant_id + 透传」）
//   ③ 禁 DELETE：查重为预防式（命中即复用赢家），不删任何记录
//   ④ 配置驱动：ICP / 数据源三档 / 查重条件 / 覆盖字段全部来自 mergedDiscoveryRules，禁硬编码
//   ⑤ 本体优先：写粒子即由 ontology hooks 自动入图补全，外部适配器只补缺口
import { createParticle, updateParticle, createEdge } from '../particles/particleRepo.js';
import { query } from '../db.js';
import { mergedDiscoveryRules } from '../config/discoveryRules.js';
import { resolveAdapters } from '../connectors/discovery/providerRegistry.js';
import { runWaterfall } from '../connectors/discovery/waterfall.js';
import { resolveExistingOrCreate } from '../connectors/discovery/dedupResolver.js';
import { buildEnrichmentPayload, buildDiscoveryPayload, enforceContextByteLimit } from './discoverySchema.js';
import { scoreLeadFit } from '../connectors/discovery/leadFitScorer.js';
import { selectPlaybook, compilePlaybook } from '../connectors/discovery/orchestrationCompiler.js';
import { registerBuiltinAdapters } from '../connectors/discovery/builtinAdapters.js'; // 幂等：确保内置适配器已注册
import { emit } from '../events/bus.js';

// 生产写助手的 opts（抽为纯函数 → 单测可断言「租户 / decision_id 真的透传」，无需连库）
export function repoWriteOpts(ctx = {}) {
  return { tenantId: ctx.tenantId || 'system', actor: ctx.actor || null, requireDecisionId: ctx.decision_id || null };
}

// 默认查找器：按 payload 字段值查同类型同租户粒子。
// key 走 $3 参数化（不是字符串拼接）→ 无注入面；tenant_id 显式收窄 → 真隔离。
async function defaultFind(type, key, value, tenantId) {
  const r = await query(
    `SELECT id, type, payload FROM crm.particles WHERE type=$1 AND tenant_id=$2 AND payload->>$3 = $4 LIMIT 1`,
    [type, tenantId, key, String(value)]
  );
  return r.rows[0] || null;
}

export async function runDiscovery(ctx = {}, input = {}, deps = {}) {
  const tenantId = ctx.tenantId || input.tenantId || 'system';
  const decisionId = ctx.decision_id || null;
  const seed = input.seed || {};
  // fail-closed：ACCOUNT/DEAL 的 identity 均为 name（particleModel.js:10,18），缺 name 必抛 missing required field
  if (!seed.name) throw new Error('discovery-run: seed.name 必填（CRM_ACCOUNT / CRM_DEAL 的 identity 均为 name）');

  // ① 内置适配器注册（幂等）：必须**显式调用**，否则 REGISTRY 恒空 → 富集静默零产出
  registerBuiltinAdapters();

  // ② 规则：租户感知（config_store['discovery-rules'] ⊕ 出厂默认）；deps.rules 可整体注入
  const rules = deps.rules || await mergedDiscoveryRules({ tenantId }, deps.ruleDeps || {});

  // ③ 数据源：playbook 推导 allowIds（配置驱动）；enabled 过滤 + costTier 升序；deps.adapters 可注入（单测零 IO）
  //    playbook 未配置（selectPlaybook → null）⇒ 退回 input.allowIds 原语义（不过滤 = 全量启用源）
  const playbook = selectPlaybook(rules, input.signals || []);
  const dataStep = playbook ? compilePlaybook(playbook).steps.find((st) => st.stage === 'data') : null;
  const allowIds = dataStep?.adapters?.length ? dataStep.adapters : input.allowIds;
  const adapters = deps.adapters || resolveAdapters(rules, { allowIds });

  // ③-b 凭据注入：按已启用适配器 id 解析 per-tenant 解密凭据 → 透传 ctx.credentials
  //   deps.resolveCredentials 可注入（单测零 IO）；生产默认走 credentialVault.resolveCredentials（pgcrypto 解密）
  const providerIds = adapters.map((a) => a.id);
  const credentials = deps.resolveCredentials
    ? await deps.resolveCredentials({ tenantId, providerIds, deps })
    : (await import('../connectors/discovery/credentialVault.js')).resolveCredentials({ tenantId, providerIds });

  // ④ 写助手：生产默认真实现（直调 repo + 透传 tenantId / decision_id），单测可注入替身
  const opts = repoWriteOpts(ctx);
  const find = deps.find || ((type, key, value) => defaultFind(type, key, value, opts.tenantId));
  const create = deps.create || ((type, attrs) => createParticle(type, attrs, opts));
  const update = deps.update || ((id, attrs) =>
    updateParticle(id, { patch: attrs, tenantId: opts.tenantId, requireDecisionId: opts.requireDecisionId }));
  const addEdge = deps.createEdge || ((...a) => createEdge(...a));

  // ⑤ 本体优先 + 查重：先查后建（duplicate_criteria 配置驱动 → 命中即复用赢家，零 DELETE）
  const criteria = (rules.duplicate_criteria || {})['CRM_ACCOUNT'] || undefined;
  const account = await resolveExistingOrCreate(
    'CRM_ACCOUNT',
    { state: 'potential', name: seed.name, domain: seed.domain, source: seed.source || 'discovery' },
    { find, create, update, criteria }
  );

  // ⑥ 缺口瀑布：字段默认取「已启用适配器的 coverageFields 并集」（配置驱动；禁硬编码字段清单）
  const fields = Array.isArray(input.fields) && input.fields.length
    ? input.fields
    : [...new Set(adapters.flatMap((a) => a.coverageFields || []))];
  const { values, cost, calls } = await runWaterfall(adapters, { ...seed, id: account.id }, fields, { ...ctx, credentials });
  const enrichment = buildEnrichmentPayload(values);

  // ⑦ 评分入 payload：**真实** lead-fit 双维评分（LF-2，2026-09-16）
  //   此前为硬编码占位 buildDiscoveryPayload(0.5, 0.5, ...) —— 注释承诺「由 lead-fit 场景回写」从未落地；
  //   判据（可复跑）：旧实现下 grep -n "0.5, 0.5" src/agent/discoveryOrchestrator.js 非 0。
  //   评分器与 monitorCtx.rescore **共用 scoreLeadFit** ⇒ 两条路径同源，不会出现"发现时 0.3、重评时 0.8"的分裂。
  //   铁律：不假填充 —— 零信号则 intent=0、缺 ICP 字段则 icp_fit=0 且 degraded，绝不返 0.5 冒充"中等意向"。
  //   R-1（2026-09-17）：信号构造补 confidence 透传（providerAdapter.fieldHit 默认 0.5，
  //   waterfall.js:19 已透传至此；此前丢弃 → leadFitScorer 的 min_confidence 置信闸恒不触发）。
  // R-5（2026-09-17）：无富化 provider 时 icp_fit=0 + degraded 是**正确结果**，不是缺陷。
  //   - 适配器只覆盖 seed 自带字段（名称/行业等），富化字段（规模/地域）本就缺失 → 分子不命中是数据实况；
  //   - 判断「0 分」的解读权在 score_degraded 与 score_breakdown（下方 L102-103 随 payload 落库）——
  //     degraded=true 表示「缺数据而非零意向」，UI/下游据此区分，而不是把 0 当成「必然无意向」；
  //   - 铁律承上：缺 ICP 字段时**绝不**返 0.5 冒充中等意向（那是旧占位实现的行为；判据：grep "0.5, 0.5" 本文件应为空）。
  const signals = Object.entries(values).map(([field, v]) => ({ type: field, provider: v?.provider, ts: v?.ts, confidence: v?.confidence ?? null }));
  const scored = scoreLeadFit({ account: { payload: { ...seed, enrichment } }, signals, rules });
  const discovery = buildDiscoveryPayload(scored.icp_fit, scored.intent, signals, decisionId || 'pending', {
    ruleRef: scored.ruleRefs,
  });
  // 可解释性与降级必须随 payload 一同落库（否则 UI 无从判断「0 分」是"没意向"还是"没数据"）
  discovery.score_breakdown = scored.breakdown;
  discovery.score_degraded = scored.degraded;

  // ⑧ 写回客户（只增改，不删除）
  await update(account.id, { enrichment, discovery });

  // ⑨ 产出线索商机（identity=name 必填；T9 2026-09-11：直落公海 S0+pool_type=new，
  //    须经销售认领→BANT 校验才升 S1 正式线索，不再直接写 'lead'）
  const deal = await create('CRM_DEAL', {
    name: seed.deal_name || `${seed.name} · 线索`,
    stage: 'S0', pool_type: 'new', source: 'discovery', account_id: account.id,
    pooled_at: new Date().toISOString(),
  });

  // ⑩ 溯源弱边：仅在确实拿到知识粒子 id 时落边（沿用 connectorActions.js:41 范式）；无则不落，绝不伪造
  const kid = values?.source_knowledge_id?.value;
  if (kid) {
    await addEdge('CRM_ACCOUNT', account.id, 'sourcedFrom', 'CRM_KNOWLEDGE', kid, {
      edge_source: 'auto_weak',
      relation_confidence: values.source_knowledge_id.confidence ?? 0.5,
      provenance: 'discovery-run', decision_id: decisionId,
    }, opts.tenantId).catch(() => {});
  }

  // ⑪ 记忆捕获源（P0#2）：发现结论 emit 到 'discovery' 域 → capture.js 白名单捕获 → memory_log
  //   三条硬约束：① 必须带非空 summary（injector.memoryText 只认 text|summary|note|content）
  //              ② 必须带 account_id（memoryLog.js:55 C2 锚点 → entity_type=ACCOUNT，跨商机累积）
  //              ③ 不得含瞬态噪声形态（judge.js judgeWorthiness 命中即静默不落库）
  emit('discovery', 'lead-discovered', enforceContextByteLimit({
    summary: `发现线索 ${seed.name} → ${deal.id}（rule_ref=scenario:lead-fit；decision_id=${decisionId || 'pending'}）`,
    account_id: account.id,
    deal_id: deal.id,
    tenant_id: tenantId,
    evidence: enrichment,
  }));

  return {
    accountId: account.id, dealId: deal.id, tenantId,
    enriched: Object.keys(values), cost, calls,
    payload: { enrichment, discovery },
  };
}
