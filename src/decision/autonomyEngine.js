// src/decision/autonomyEngine.js — 自主决策引擎（读 business_tier + 检索先例 + 置信度 → 自主/升级）
// 设计输入：spec-decision-event-detailed-design-2026-08-25.md §5（算法级）
// 铁律：所有阈值/权重走配置，不硬编码；EXCEPTION 强制 HITL + 上级 role 背书 + 审计高亮
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { computeBusinessTier, createDecision, searchPrecedents, recordDecisionEvent } from './decisionRepo.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
// 方法论评分单一事实源（与 calibration/replay.js 共用，防两端公式漂移）
import { scoreMethodology, composeConfidence } from './methodologyScoring.js';
import { loadMethodologyEvidence } from './methodologyEvidence.js';
// F5 兜底供给：落库断言为空时从商机结构化事实读时派生（derived 垫底，不落库）
import { deriveDealEvidence, mergeEvidence, runEvidenceExtraction } from './methodologyExtractor.js';
import { mergedThresholds } from '../sales/salesThresholds.js';
// C3 决策时刻冻结（2026-09-03）：把 effective_policy_version 从「恒 null」改为「当时生效的配置快照版本」。
//   静态引入安全：policyVersion.js 仅依赖 db/configStore/bus/monitorStore/embedding，不反向依赖本模块。
import { resolvePolicyVersion } from './policyVersion.js';

// 权重和恒为 1.0（否则置信度不再是 0..1 语义，阈值失去可解释性；test 锁死）
// F5 修复（2026-09-02）：原 method:0.2 拆为 method:0.1（已采集维度达标率）+ evidence_coverage:0.1（证据采齐度），
//   allMet 由「全维度 every(met)」重定义为「required 维度全达标」。三处 DEFAULT_CONF 须同步：
//   本行 / src/calibration/store.js:13 / test/calibration/parity.test.js（parity 守卫）。
// 阈值调低（2026-09-02，用户批准）：0.8 → 0.7。理由：无先例时置信度≈0.69 < 0.7 仍升级（保留保守语义），
//   但 1-2 条扎实先例 + 中等证据即可自主放行，减少对强关系 boost（0.3+0.3=0.6）的依赖——强关系不应成为自主的充要条件。
//   影响实测：1 先例+强关系 conf≈0.755（0.8 下升级 → 0.7 下自主）；5 先例+强关系 conf=0.950（仍自主）。
const DEFAULT_CONF = {
  threshold: 0.7,
  weights: { similarity: 0.4, coverage: 0.3, method: 0.1, evidence_coverage: 0.1, allMet: 0.1 },
};

// 校准参数外置读取（P1）：config_store['autonomy-conf'] 缺省回退 DEFAULT_CONF。
// 契约：写必经校准 store（第0闸），引擎只读；parity 由 test/calibration/parity.test.js 锁死「无配置时与 DEFAULT_CONF 逐字一致」。
// 低频热路径（每次业务决策调用一次单行 KV 读），不做缓存，避免批准后不生效的失效复杂性。
export async function loadEngineConf() {
  const r = await readConfig('autonomy-conf', { tenantId: 'system' });
  const v = r?.value;
  if (!v || typeof v !== 'object') return { ...DEFAULT_CONF };
  return {
    threshold: typeof v.threshold === 'number' ? v.threshold : DEFAULT_CONF.threshold,
    weights: { ...DEFAULT_CONF.weights, ...(v.weights || {}) },
  };
}

// 加载方法论维度 → 生成 conditions 模板并填充
// 证据来源两路合并（F5 修复，设计 §11 Q1=B+C）：
//   ① trigger_context.conditions —— 调用方显式传入（老通道兼容 / 特殊场景覆盖，优先级最高）
//   ② CRM_METHODOLOGY_EVIDENCE 证据粒子 —— 引擎自动加载（7 个业务通道零改动即全通道生效）
// 显式传入优先：允许调用方对单维证据做即时覆盖，而不必先落一条证据粒子。
// required 必须带出（新 allMet 语义 = required 维度全达标；旧实现丢了这个字段导致硬闸无从判定）。
async function buildConditions(scenario, evidence = {}) {
  const dims = [];
  for (const mid of scenario.methodology_ids || []) {
    const r = await query(`SELECT * FROM methodology_dimension WHERE methodology_id=$1 ORDER BY dim_key`, [mid]);
    for (const d of r.rows) dims.push(d);
  }
  const supplied = (scenario.trigger_context || {}).conditions || {};
  return dims.map((d) => {
    const hasExplicit = Object.prototype.hasOwnProperty.call(supplied, d.dim_key);
    const ev = evidence[d.dim_key];
    const met = hasExplicit ? supplied[d.dim_key] : (ev ? ev.met : undefined);
    return {
      cond: d.dim_key, label: d.label, weight: d.weight, required: d.required,
      met: met == null ? null : Boolean(met),
      value: hasExplicit ? (met ?? null) : (ev ? (ev.value ?? null) : null),
      // 证据溯源：回答「为什么判这一维达标」——人工纠偏与审计的落脚点
      evidence_source: hasExplicit ? 'trigger_context' : (ev ? ev.source : null),
      evidence_ref: hasExplicit ? null : (ev ? ev.evidence_ref : null),
    };
  });
}

// 决策理由里的方法论证据交代（「用户看得懂的语言」原则：不写 methodScore=0.21 这类机器读数，
//   写「BANT/MEDDICC 共 14 维，已采集 3 维、其中 3 维达标；必填维度 A/B/N 缺证据」）。
// 升级人工时这句话就是人工要补的活儿清单 —— 此前理由只写「置信度不足」，人看完不知道该干什么。
function evidenceSummary(conditions, evidenceCov) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return '';
  const assessed = list.filter((c) => c.met != null);
  const passed = assessed.filter((c) => c.met === true);
  const missingReq = list.filter((c) => c.required && c.met == null).map((c) => c.cond);
  const failedReq = list.filter((c) => c.required && c.met === false).map((c) => c.cond);
  let s = `；方法论 ${list.length} 维，已采集 ${assessed.length} 维（覆盖率 ${(evidenceCov * 100).toFixed(0)}%）、其中 ${passed.length} 维达标`;
  if (missingReq.length) s += `；必填维缺证据：${missingReq.join('/')}`;
  if (failedReq.length) s += `；必填维未达标：${failedReq.join('/')}`;
  return s;
}

// 方案C（2026-09-02）：决策前后双 Agent fire-and-forget 派发——把"决策系统接入 agent 编排层"真正接通。
//   decision-enrich（决策落库前，不依赖 decision_id）：并行装配 L1-L4 记忆/知识，富集先例线索写回记忆；
//   decision-execute（决策落库后，携带 decision_id）：写回 memory_log（write-through 已闭环）；decision_relation 挂接为后续 Task（依赖先例发现通道回填 to_id），
//     消除"记忆真空"根因（auditability 恒 21% 因无 agent 写回）。
// 经 routeThroughIntake 路由到 decision-agent（注入 skill_slug + 契约键 ct-decision-enrich/execute），
// 再直接 runWithSkill（不落 kanban 行、不 claim，纯后台写回）。确定性引擎（置信度/tier/HITL）零改动；
// agent 不回灌 disposition/state；fail-open：派发失败只 emit trace + recordFailure，绝不阻塞判定。
async function dispatchDecisionAgent(intent, { scenario_id, decision_id = null, trigger_context, involved_entities, tenantId = 'system', preContext = null }) {
  try {
    const { routeThroughIntake } = await import('../kanban/scheduler.js');
    const routed = routeThroughIntake({
      id: `decision-${intent}-${decision_id || scenario_id}-${Date.now()}`,
      payload: { intent, scenario_id, decision_id, trigger_context, involved_entities, tenant_id: tenantId, pre_context: preContext },
    });
    const { runWithSkill } = await import('../agent/agentLoop.js');
    const task = { id: routed.payload.contract_task_id, payload: routed.payload, skill_slug: routed.payload.skill_slug };
    const ctx = { contractTask: routed.payload.contract_task_id, actor: routed.targetAgent, tenantId, decision_id: decision_id || null };
    runWithSkill(task, { ctx }).catch((e) => {
      emit('trace', 'decision-agent-run-failed', { intent, decision_id, error: String(e?.message || e) });
      recordFailure('decision-agent-run-failed', e);
    });
  } catch (err) {
    emit('trace', 'decision-agent-dispatch-error', { intent, decision_id, error: String(err?.message || e) });
    recordFailure('decision-agent-dispatch-error', err);
  }
}

export async function requireDecision(scenario_id, trigger_context = {}, involved_entities = [], opts = {}) {
  // cfg 优先级：opts.conf（显式注入，测试/特殊通道）> config_store['autonomy-conf']（校准外置）> DEFAULT_CONF（出厂缺省）
  const cfg = { ...(await loadEngineConf()), ...(opts.conf || {}) };
  const tenant = opts.tenantId || 'system'; // T5 多租户：决策场景按租户隔离（默认 system=平台级）
  let scenario = await query(`SELECT * FROM decision_scenario WHERE scenario_id=$1 AND tenant_id=$2`, [scenario_id, tenant]);
  // 租户专属场景缺失 → 回退平台种子场景（system），保持共享库语义（与 configStore 回退一致，不破坏现有共享场景）
  if (!scenario.rows[0] && tenant !== 'system') {
    scenario = await query(`SELECT * FROM decision_scenario WHERE scenario_id=$1 AND tenant_id='system'`, [scenario_id]);
  }
  if (!scenario.rows[0]) throw new Error(`未知决策场景: ${scenario_id}`);
  const sc = scenario.rows[0];

  // ③-C3 决策时刻冻结：解析「本次决策生效的策略版本」，随决策落库（decision.effective_policy_version）。
  //   背景：此前 18 处调用方无一传 policy_version → 该列恒 null，改一次阈值即洗掉所有历史决策的判定依据。
  //   显式注入优先（保留 e2e / 特殊通道），未注入则按当前配置内容哈希解析（幂等复用）。
  //   fail-open（I1）：解析失败不阻断决策，但落 null 时已 emit trace + recordFailure，巡检可发现，不留假绿。
  //   开销说明：每次决策多读 6 个配置键（冻结快照的必要代价，无法用「上次版本」跳过——
  //     不读就不知道内容是否已变）。配置表单行 KV 读有索引，非热瓶颈。
  const policyVersion = opts.policy_version || await resolvePolicyVersion({ tenantId: tenant })
    .then((r) => r?.policy_version_id || null)
    .catch((err) => {
      emit('trace', 'policy-version-resolve-failed', { scenario_id, tenantId: tenant, error: String(err?.message || err) });
      recordFailure('policy-version-resolve-failed', err);
      return null;
    });

  await recordDecisionEvent('required', { scenario_id, trigger_context });

  // ① 业务分级（DEAL = 客户维 × 项目维；无配置回退 scenario.default_tier）
  // 2026-09-09 修复：透传 tenant（requireDecision 内 tenant=opts.tenantId），隔离跨租户读取
  const tier = (await computeBusinessTier({
    customer: trigger_context.customer, project: trigger_context.project, tenantId: tenant,
  })) || sc.default_tier;

  // ②a 加载方法论证据（F5：输入端接线，7 个业务通道零改动全生效）
  //   证据主体 = involved_entities 首个实体（业务通道恒传 [{type:'CRM_DEAL', id}]）
  //   fail-open：证据加载失败不阻断决策，退化为「零证据」→ 覆盖率 0 → 保守升级（诚实降级，不静默）
  const subjectId = (involved_entities || []).map((e) => e && (e.id || e.particle_id)).find(Boolean) || null;
  let autofillPayload = null; // ②a-3 落库填充：DEAL 派生事实的 payload，createDecision 落库后固化为 auto 断言
  let evidence = {};
  try {
    evidence = await loadMethodologyEvidence({
      subject_id: subjectId,
      methodology_ids: sc.methodology_ids || [],
      tenantId: tenant,
    });
  } catch (err) {
    emit('trace', 'methodology-evidence-failed', { scenario_id, error: String(err?.message || err) });
    recordFailure('methodology-evidence-failed', err);
    evidence = {};
  }
  // ②a-1 落库断言快照：分离「内存 derived」与「已落库断言」，供 ②a-3 runEvidenceExtraction 做幂等/优先级判定
  const storedEvidence = evidence;

  // ②a-2 读时派生证据（F5 兜底供给，设计 §11 Q1=B+C 的 C 部分）
  //   为什么必须有这一步：存量商机的落库断言是 0 条。若只靠人工/填充器录入，F5 的锁死
  //   要等到有人把维度一条条填完才解除 —— 等于"修了但没生效"。此处从商机**既有结构化事实**
  //   （expected_amount / probability / bantcc 显式评分…）现算证据，不落库、不过第 0 闸、无版本膨胀。
  //   优先级：derived 垫最底，任何 manual/enrich/auto 落库断言都覆盖它（人工纠偏不会被算回去）。
  //   实体类型按 **DB 真实 type** 判定，不信调用点声明 —— seed-actions.js:563 传 'DEAL'、
  //   其余通道传 'CRM_DEAL'，按声明匹配会漏掉 deal-advance 这条最主要的通道。
  //   subjectId 形状闸：particles.id 是 uuid 列，而部分通道/测试传的是业务短键（'d1'/'DX'）。
  //   不先判形状就查库会抛 invalid input syntax for type uuid，被 catch 后每次都往 monitor 记一条
  //   假故障 —— 把正常情况上报成故障，与静默吞错同样是失真。非 UUID 即"不是粒子引用"，直接跳过。
  const isParticleRef = subjectId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(subjectId));
  if (isParticleRef && (sc.methodology_ids || []).length) {
    try {
      const dr = await query(`SELECT type, payload FROM particles WHERE id=$1 AND tenant_id=$2`, [subjectId, tenant]);
      const row = dr.rows[0];
      if (!row) {
        // 不静默：主体不在本租户下（或已被物理迁移）→ 派生跳过，如实留痕
        emit('trace', 'methodology-derive-skipped', { scenario_id, subject_id: subjectId, reason: 'subject-not-found-in-tenant' });
      } else if (String(row.type).endsWith('DEAL')) {
        const thrCfg = await readConfig('sales-thresholds', { tenantId: tenant }).catch(() => null);
        const derived = deriveDealEvidence(row.payload, {
          methodology_ids: sc.methodology_ids || [],
          thresholds: mergedThresholds(thrCfg?.value || {}),
          subject_id: subjectId,
        });
        evidence = mergeEvidence(derived, storedEvidence); // derived 垫底，落库断言胜出
        autofillPayload = row.payload;                     // ②a-3：本决策落库后把派生事实固化为 auto 断言（可审计+人工纠偏）
      }
    } catch (err) {
      // fail-open：派生失败退回"仅用落库证据"，决策不阻断；但必须留痕（禁静默吞错）
      emit('trace', 'methodology-derive-failed', { scenario_id, subject_id: subjectId, error: String(err?.message || err) });
      recordFailure('methodology-derive-failed', err);
    }
  }

  // ②b conditions 模板 + 三项正交评估（达标率 / 证据覆盖率 / required 硬闸，见 methodologyScoring.js）
  const conditions = await buildConditions({ ...sc, trigger_context }, evidence);
  const { methodScore, evidenceCov, allMet } = scoreMethodology(conditions);

  // ③ 先例检索（C4 两段式：结构分量主导，向量仅 model provider 计入；阈值读配置默认 0.45）
  const precedents = await searchPrecedents(scenario_id, {
    trigger_context,
    conditions_evaluated: conditions,
    business_tier: tier,
    disposition: null,
    // C8（2026-09-10）：C5 的强制伴随项。C5 把决策归到真实租户后，若此处不传 tenantId，
    //   先例池仍按 system 过滤 → 租户自己的历史决策全被排除，「修了归属反而断了先例」。
    //   与 searchPrecedents 内 `tenant_id=$3 OR tenant_id='system'` 回退范式协同：本租户优先 + 基线兜底。
  }, { k: opts.k || 5, tenantId: tenant });
  const avgSimilarity = precedents.length
    ? precedents.reduce((s, p) => s + p.similarity, 0) / precedents.length : 0;
  const coverage = Math.min(precedents.length / (opts.k || 5), 1);

  // ③b【F4 单轨 2026-09-02】7×7 上下文**事前装配**（决策物化之前完成，不是落库后补解释）。
  //   关键：把引擎刚算出的同一批 precedents 注入 S2 —— 保证「算置信度用的先例」
  //   ≡ 「落到 decision_context_snapshot 里归档的先例」。旧实现两条链路各检索一次
  //   （k=5/qvec(cond) vs k=3/minSim=0.6/qvec(cond=[])），归档的是另一批 → 可审计性失效。
  //   persist:false —— 决策 id 尚不存在，落库与 PROV-O 延后到 createDecision 冻结，不留孤儿快照。
  //   失败 fail-open（emit trace + recordFailure），决策判定逻辑不受影响。
  let preContext = null;
  try {
    const { assembleContextV2 } = await import('../context/assembleContextV2.js');
    preContext = await assembleContextV2({
      actor: opts.actor_id || 'agent',
      scenario_id,
      query: (trigger_context && (trigger_context.query || trigger_context.summary)) || opts.rationale || '',
      entities: involved_entities,
      trigger_context,
      tenant_id: tenant,
      precedents,                 // ← 同一批先例，S2 不再二次检索
      phase: 'pre',
      persist: false,
    });
  } catch (err) {
    emit('trace', 'context-assembly-failed', { scenario_id, phase: 'pre', source: 'autonomyEngine', error: String(err?.message || err) });
    recordFailure('context-assembly-failed', err);
    preContext = null;
  }

  // ④ EXCEPTION 强制 HITL + 上级背书 + 审计高亮（无论置信度）
  const forceException = opts.disposition === 'EXCEPTION';
  // 高风险 + 不允许自主 → 升级
  // E1 修复（2026-09-16，用户批准方案 a）：此前该判断只存在于 dead variable highNoAuto（赋值后从未被读取），
  //   而 :274 的 escalated 只看 tier/置信度 → 场景级 autonomous_allowed 在配置面承诺（decisionScenario.js:126
  //   渲染「✅自主/⛔人工」）与执行面背离 = 假绿。现接入：autonomous_allowed !== true → 一律升级（fail-closed）。
  //   ⚠ 兼容 2026-08-28 裁定（docs/specs/2026-08-25-ai-native-crm-overall-design.md:617「自主闸门不得无条件放行」）：
  //   本改动**只收紧 FALSE 侧**——== true 时仍需过置信度门控（:274 后半段不变），裁定禁止的路径依然被禁止。
  const sceneAllowsAuto = sc.autonomous_allowed === true;
  // ATTIO relation 组置信度调节（12 §7.4 决策层承接，spec 语义：关系强→可自主度高、升级阈值放宽）
  // 当前实现是微弱 +0.05/+0.05 点缀，远够不到阈值 → 与 spec「关系强即拉高置信度到可自主」不符。
  // 按 spec §7.4 合规修法：relation 组作为自主边界调节因子——双强关系时置信度显著上调（能过阈值），
  // 弱/缺失时零干扰（基线不变）。权重取强关系直接抬升 0.3/0.3（≥0.8 阈值所需，见测试 T9）。
  const rel = (trigger_context.relations || {});
  const relBoost = (['high', 'champion'].includes(rel.champion_strength) ? 0.3 : 0)
                 + (['high', 'strong'].includes(rel.relationship_strength) ? 0.3 : 0);
  // spec「升级阈值放宽」：强关系时阈值本身也放宽 0.1（双强关系下更容易自主，弱/缺失不生效）
  const relThresholdRelax = relBoost > 0 ? 0.1 : 0;
  const effectiveThreshold = Math.max(cfg.threshold - relThresholdRelax, 0.5);
  const conf = Math.min(
    composeConfidence(cfg.weights, { avgSimilarity, coverage, methodScore, evidenceCov, allMet }) + relBoost,
    0.95
  );

  // tier==HIGH 一律升级（自主仅限 LEAD/NORMAL，见 §5.2 step4d）；
  // 置信度门控对【所有非 HIGH 分级】统一生效（对齐总体设计 §6.9 step4e / §6.10「无高置信先例则升级，杜绝瞎自主」）：
  //   无先例（coverage==0）→ 置信度≈0 < 阈值 → 保守升级 HITL（403）——「无先例即 HITL」
  //   有先例但相似度/覆盖不足 → 置信度 < 阈值 → 仍升级（避免弱先例误导的「瞎自主」）
  //   仅当 置信度 ≥ 阈值（先例 grounded）且分级 ∈ {LEAD,NORMAL} 且场景声明 autonomous_allowed → 自主放行（201）
  //   （2026-08-28 设计裁定：扭转此前「autonomous_allowed=TRUE 低位场景无条件自主放行」的引擎偏差，
  //    使引擎与总体设计文档 §6.9 算法级一致；routes.js:200 第0闸 403 语义对应）
  //   ★ 2026-09-16 补：!sceneAllowsAuto —— 场景未声明允许自主（FALSE/未设）一律升级。
  //     这是 2026-08-28 裁定的**同向补完**（裁定只禁 TRUE 侧无条件放行，未规定 FALSE 侧行为；
  //     :251 原 highNoAuto 是 dead variable，证明原意图本就含此判断）。语义为 fail-closed。
  let escalated = forceException || tier === 'HIGH' || !sceneAllowsAuto || (tier !== 'HIGH' && conf < effectiveThreshold);

  // S6 T19 B/C 轴（常驻授权）：在 A 轴放行结果上叠加动作边界 + 凭证状态。
  // opt-in：仅当调用方显式传 opts.standingAction 时介入；既有调用方不传 → 行为不变。fail-closed。
  //   A 轴已升级（tier=HIGH / 置信度不足 / 场景未授权）→ 保持升级；
  //   A 轴放行但动作无活跃 T1 凭证 / 字段越界 / T3 对外动作 → 升级 HITL（白名单外字段写入被拒）。
  if (!escalated && opts.standingAction) {
    try {
      const { consultStandingGate } = await import('../authorization/standingAuthorization.js');
      escalated = await consultStandingGate(false, {
        tenantId: tenant, standingAction: opts.standingAction, standingFields: opts.standingFields || [],
      });
    } catch (err) {
      emit('trace', 'standing-auth-gate-failed', { scenario_id, tenantId: tenant, error: String(err?.message || err) });
      recordFailure('standing-auth-gate-failed', err);
      escalated = true; // fail-closed
    }
  }

  // 方案C：决策落库前 fire-forget 派发 decision-enrich（并行装配 L1-L4 + 富集先例，不阻塞判定）
  //   放在分支外——富集适用于所有决策（自主/升级），决策前上下文装配与判定结果无关，非仅自主分支。
  //   VITEST 护栏：单测共享 crm_native_test，后台派发会异步写 monitor_event/memory_log 与断言竞态（时红时绿），
  //   故测试环境关闭；派发接线由 e2e-agent-trail / verify-decision-agent-live（plain-node）真实覆盖。
  if (!process.env.VITEST) dispatchDecisionAgent('decision-enrich', { scenario_id, trigger_context, involved_entities, tenantId: tenant, preContext }).catch(() => {});

  if (!escalated) {
    // 自主拍板（强制 referenced_precedents + rationale）
    const referenced = precedents.map((p) => ({ precedent_id: p.decision_id, similarity: p.similarity }));
    const rationale = opts.rationale
      || `自主决策：置信度 ${conf.toFixed(3)}≥阈值 ${cfg.threshold}，tier=${tier}，参考先例 ${precedents.length} 条${evidenceSummary(conditions, evidenceCov)}`;
    const decision = await createDecision({
      scenario_id, trigger_context, involved_entities,
      conditions_evaluated: conditions,
      effective_policy_version: policyVersion,
      disposition: opts.disposition || 'APPROVE',
      decider_type: 'AUTONOMOUS_AGENT', decider_id: opts.actor_id || 'agent',
      decider_role: opts.actor_role || 'agent',
      rationale, referenced_precedents: referenced,
      business_tier: tier, state: 'AUTONOMOUS',
    tenantId: tenant,
    pre_context: preContext, // F4：冻结同一份事前上下文，不重检索
  });
    // 方案C：决策落库后 fire-forget 派发 decision-execute（写回记忆/决策网络，消除真空）
    if (!process.env.VITEST) dispatchDecisionAgent('decision-execute', { scenario_id, decision_id: decision.decision_id, trigger_context, involved_entities, tenantId: tenant, preContext }).catch(() => {});
    await recordDecisionEvent('autonomous', { decision_id: decision.decision_id, scenario_id, confidence: conf });
  // ②a-3 落库填充（F5 既定后续步）：把本次决策算出的读时派生证据固化为 source='auto' 断言，
  //   使其可审计、可被人工纠偏（manual 覆盖 auto）。用本决策 id 作第 0 闸凭据；fail-open 不阻断决策。
  const evidenceAutofill = await autofillMethodologyEvidence({
    decision, subjectId, dealPayload: autofillPayload,
    methodology_ids: sc.methodology_ids || [], tenantId: tenant, storedEvidence,
  });
  return { mode: 'autonomous', decision, confidence: conf, tier, precedents, conditions, method_score: methodScore, evidence_coverage: evidenceCov, required_met: allMet, evidence_autofill: evidenceAutofill };
}

  // 升级 HITL（附引擎建议 disposition + 先例依据）
  const suggested = opts.disposition
    || (allMet && avgSimilarity >= cfg.threshold ? 'APPROVE' : 'ESCALATE');
  const rationale = opts.rationale
    || `升级人工：置信度 ${conf.toFixed(3)}<阈值 ${cfg.threshold} 或 tier=${tier} 高风险/例外，建议 ${suggested}，参考先例 ${precedents.length} 条${evidenceSummary(conditions, evidenceCov)}`;
  const decision = await createDecision({
    scenario_id, trigger_context, involved_entities,
    conditions_evaluated: conditions,
    effective_policy_version: policyVersion,
    disposition: forceException ? 'EXCEPTION' : suggested,
    decider_type: 'HUMAN', decider_id: opts.escalate_to || null,
    decider_role: forceException ? 'superior' : (opts.escalate_role || 'manager'),
    rationale, referenced_precedents: precedents.map((p) => ({ precedent_id: p.decision_id, similarity: p.similarity })),
    business_tier: tier, state: 'HUMAN',
    outcome: forceException ? 'AUDIT_HIGHLIGHT' : null,
    tenantId: tenant,
    pre_context: preContext, // F4：升级路径同样归档同一份事前上下文（人工处置依据 == 引擎看到的依据）
  });
    // 方案C：升级路径同样 fire-forget 派发 decision-execute（决策仍落库，写回通道不可少）
    if (!process.env.VITEST) dispatchDecisionAgent('decision-execute', { scenario_id, decision_id: decision.decision_id, trigger_context, involved_entities, tenantId: tenant, preContext }).catch(() => {});
    await recordDecisionEvent('escalated', {
    decision_id: decision.decision_id, scenario_id, confidence: conf,
    audit_highlight: forceException, suggested,
  });
  // ②a-3 落库填充（升级路径同样固化派生证据，见 autonomous 分支注释）
  const evidenceAutofill = await autofillMethodologyEvidence({
    decision, subjectId, dealPayload: autofillPayload,
    methodology_ids: sc.methodology_ids || [], tenantId: tenant, storedEvidence,
  });
  return { mode: 'escalated', decision, confidence: conf, tier, suggested, precedents, conditions, auditHighlight: forceException, method_score: methodScore, evidence_coverage: evidenceCov, required_met: allMet, evidence_autofill: evidenceAutofill };
}

/**
 * ②a-3 落库填充（F5 既定后续步）：把本次决策算出的读时派生证据固化为 source='auto' 的证据粒子，
 *   使其可审计、可被人工纠偏（manual > enrich > auto > derived，见 methodologyEvidence.js）。
 * 触发条件：主体是真实 DEAL 粒子且场景绑了方法论；否则无结构化事实可派生，跳过（返回 null）。
 * 第 0 闸：用本决策的 decision_id 作写操作凭据（证据是决策依据，写证据本身也是写）。
 * 幂等：runEvidenceExtraction 对「已有落库断言（manual/enrich/auto 等值）」跳过，不制造版本噪音。
 * fail-open：填充失败只 emit trace + recordFailure 留痕，绝不阻断决策主流程（反静默吞错铁律）。
 * @param storedEvidence 仅含「已落库断言」（不含内存 derived）——否则 runEvidenceExtraction 的等值跳过
 *   会把内存 derived 误判为「已存在」，导致派生事实永不落库、人工永远无法在真证据上纠偏。
 */
async function autofillMethodologyEvidence({ decision, subjectId, dealPayload, methodology_ids, tenantId, storedEvidence }) {
  if (!subjectId || !dealPayload || !(methodology_ids || []).length) return null;
  try {
    const thr = await readConfig('sales-thresholds', { tenantId }).catch(() => null);
    const res = await runEvidenceExtraction({
      subject_id: subjectId,
      deal_payload: dealPayload,
      methodology_ids,
      thresholds: mergedThresholds(thr?.value || {}),
      decision_id: decision.decision_id, // 第 0 闸凭据：本决策 id
      tenantId,
      actor: decision.decider_id || 'agent',
      existing: storedEvidence, // 仅落库断言（不含内存 derived），否则等值跳过永不落库
    });
    emit('trace', 'methodology-autofill', {
      decision_id: decision.decision_id, subject_id: subjectId,
      written: res.written, skipped: res.skipped,
    });
    return res;
  } catch (err) {
    emit('trace', 'methodology-autofill-failed', {
      decision_id: decision.decision_id, subject_id: subjectId,
      error: String(err?.message || err),
    });
    recordFailure('methodology-autofill-failed', err);
    return null; // fail-open：不阻断决策
  }
}
