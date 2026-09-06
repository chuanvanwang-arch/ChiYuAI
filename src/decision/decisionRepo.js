// B4 2026-09-02：评分线接入 decision_scenario 真实 required_dims/focus_rulers（P1-B3/B4 接线，消除硬传 null 的空转）。
//   事实（生产库直查 2026-09-02）：decision_scenario 8 个业务场景 required_dims 非空（3–4 维），focus_elements/focus_rulers 已回填；
//   但 createDecision 评分线硬传 {required_dims:null, focus_rulers:null} → 「相关性（4）」恒走 no_required 口径（无评分对象）、
//   「重要性（8）/深度（5）/广度（6）」无聚焦权重 → 九尺子全部在「无对象」上出分，与设计 §6.2 阶段加权机制脱节。
//   修复：评分前经 loadScenarioConfig 读场景行（focus_rulers/required_dims/rubric_pass_line/retro_required），
//   连同 pre_context 的真实 suppliedDims 一并传入评分器（无场景行/读取失败 fail-open 保持 null 口径，不静默不假填充）。

// src/decision/decisionRepo.js — 决策主轴仓库（判断源主轴物化 + 先例检索 + 记忆沉淀）
// 设计输入：spec-decision-event-detailed-design-2026-08-25.md §2.2/§4.2/§4.3
// 注：向量维度对齐底座 vector(384)（hashVector 确定性向量，零外部依赖，可跑全量测试）
import { query, queryWrite, pool } from '../db.js';
import { applyHumanDisposition, applyOutcome } from '../monitor/attribution.js';
import { deriveDisplayName } from './decisionName.js'; // 【C 方案 2026-09-03】决策可读名称（单一事实源，供 createDecision + 回填脚本复用）
import { stableStringify, embedText, EMBED_PROVIDER, parsePgVector } from '../ontology/embedding.js';
import { emit } from '../events/bus.js';
import { appendMemory } from '../memory/memoryLog.js';
import { addDecision, addParticleVertex, isAvailable } from './ageGraph.js'; // 写时同步 AGE 图（决策网络 / 因果边）
import { mirrorEdge } from './edgeWrite.js'; // T2(BG-06) 边写降级留痕：替代裸 addEdge().catch(()=>{})
// G3 R1/R1b 可观测化：先例关系/记忆沉淀失败静默 → emit trace + monitor.recordFailure
import { recordFailure } from '../monitor/monitorStore.js';
import { sevenDimensionsCheck } from '../sevenDimensions/engine.js'; // T3 拦截闭环（单一事实源）
// C2 审计链（静态引入安全：provenance.js 仅依赖 db/bus/monitorStore/crypto，不反向依赖本模块）
import { trackEntry } from './provenance.js';
import { decideInterception, missingContextMessage } from './interception.js'; // T3 纯函数拦截判定
import { computeConfidence } from './confidence.js'; // T8 置信度反算（G5）
import { checkContextGuard } from './contextGuard.js'; // T-D5 写时上下文守卫（配置化：warn/block）
// C4 先例相似度四分量评分（2026-09-03 T7/T8）：jaccard/category/graphDepth/vector 加权 + 归一强校验 + 向量降级
import { jaccardConditions, categoryMatch, graphDepthOf, normalizeWeights, similarityOf, loadPrecedentConf, cosine } from './precedentScoring.js';

// B4 2026-09-02：读场景行聚焦配置（required_dims/focus_rulers/rubric_pass_line/enabled_rulers）供评分线使用。
// 返回 null = 场景行不存在或读取失败 → 调用方保持 null 口径（设计 §6.3「无证据计 0 不假填充」的配置侧同构）。
export async function loadScenarioConfig(scenario_id) {
  if (!scenario_id) return null;
  try {
    const r = await query(
      `SELECT scenario_id, stage, stage_code, focus_elements, focus_rulers, required_dims,
              rubric_pass_line, retro_required, methodology_ids, enabled_rulers
       FROM crm.decision_scenario WHERE scenario_id=$1`,
      [scenario_id]
    );
    if (!r.rows[0]) return null;
    return r.rows[0];
  } catch (e) {
    emit('trace', 'scenario-config-load-failed', { scenario_id, error: String(e?.message || e) });
    recordFailure('scenario-config-load-failed', e);
    return null;
  }
}

const TIER_RANK = { LEAD: 1, NORMAL: 2, HIGH: 3 };
const TIER_FROM_RANK = { 1: 'LEAD', 2: 'NORMAL', 3: 'HIGH' };

// 业务分级：DEAL = 客户维 × 项目维；两维取高风险优先（HIGH>NORMAL>LEAD），引擎只读配置
export async function computeBusinessTier({ customer, project } = {}) {
  const rows = await query(
    `SELECT dimension, dimension_value, tier FROM business_tier_config
     WHERE (dimension=$1 AND dimension_value=$2) OR (dimension=$3 AND dimension_value=$4)`,
    ['customer', customer || null, 'project', project || null]
  );
  let rank = 0;
  for (const r of rows.rows) rank = Math.max(rank, TIER_RANK[r.tier] || 0);
  return rank ? TIER_FROM_RANK[rank] : null; // 无配置 → 返回 null，由调用方回退 scenario.default_tier
}

// 【方案 B 健壮性 · fail-open 决策点】维度错判定：pgvector 写真向量维度不符时抛
// "expected N dimensions, not M"。仅当本次确实带 embedding 值时才判维度错（hash 路径 embedding 为
// NULL，维度错永不命中），避免把其它 DB 错误误判为可降级。
export function isDimensionMismatchError(err, embeddingValue) {
  return embeddingValue != null && err != null && /dimensions/i.test(String(err?.message || err));
}

// 写决策 + 维度错降级重试（fail-open）：DB 列尚未迁移到 vector(1024)（用户先启用真 embedding、
// 后跑 db/migrate.js）时，写 1024 维真向量会因维度不符整条 INSERT 失败、决策丢失。捕获维度错 →
// 降级 embedding=NULL 重试（决策不丢，仅向量缺失，留痕待 db/migrate.js + 回填脚本补齐）。
// writer/emit2/rec 可注入便于无 DB 单测；生产默认走 queryWrite + 真实事件总线 + monitor 留痕。
export async function insertDecisionFailOpen(sql, params, embeddingIdx, writer = queryWrite, emit2 = emit, rec = recordFailure) {
  try {
    return await writer(sql, params);
  } catch (e) {
    if (isDimensionMismatchError(e, params[embeddingIdx])) {
      emit2('trace', 'decision-embedding-dim-mismatch', { error: String(e?.message || e) });
      rec('decision-embedding-dim-mismatch', e);
      const p2 = params.slice();
      p2[embeddingIdx] = null; // $embedding → NULL，降级重试
      return await writer(sql, p2);
    }
    throw e; // 非维度错：原样抛出（如 FK 违例、连接中断），不伪装降级
  }
}

// 【B2 2026-09-02】八要素草稿物化（fail-open，纯函数可单测）
// 调用方传入优先；intent 未传则从 rationale/trigger_context 生成弱草稿（让常规决策 intent 非空，满足验收）。
// 其余要素诚实留 null —— 评分时「无证据计 0」，不静默、不假填充（BG-04 反假绿）。
export function materializeEightElements(
  elements = {},
  opts = {}
) {
  const { rationale = '', trigger_context = {} } = opts || {};
  const els = elements || {};
  const out = {
    intent: els.intent ?? null,
    assumptions: els.assumptions ?? null,
    inference: els.inference ?? null,
    viewpoints: els.viewpoints ?? null,
    implications: els.implications ?? null,
    risk_register: els.risk_register ?? null,
    stop_loss: els.stop_loss ?? null,
    concept_refs: els.concept_refs ?? null,
  };
  if (!out.intent) {
    const q = (trigger_context && (trigger_context.query || trigger_context.summary)) || '';
    if (rationale || q) {
      out.intent = { purpose: rationale || '', question: q, sub_questions: [] };
    }
  }
  return out;
}

// 物化决策（7 点全字段 + 写时向量 + 先例边 + 记忆沉淀 + L2 事件）
export async function createDecision(input = {}) {
  const {
    scenario_id, trigger_context = {}, involved_entities = [], conditions_evaluated = [],
    effective_policy_version = null, disposition, decider_type = 'AUTONOMOUS_AGENT',
    decider_id = null, decider_role = null, rationale = '', referenced_precedents = [],
    business_tier = 'NORMAL', state = 'REQUIRED', outcome = null,
    outcome_verified = null, feedback = null, feedback_link = null, root_cause = null,
    human_disposition = null, engine_confidence = null,
    display_name = null, // 【C 方案 2026-09-03】决策可读名称（未传则由 deriveDisplayName 自动推导，单一事实源）
    // 【B2 2026-09-02】八要素物化入参（fail-open：未传则诚实留 null，由 Pre 草稿 / 评分计 0，不假填充 BG-04）
    intent = null, assumptions = null, inference = null, viewpoints = null,
    implications = null, risk_register = null, stop_loss = null, concept_refs = null,
    // 【P2 补齐】七类因果边中其余 4 类的写时触发入口（设计 §4.1：CAUSED/INFLUENCED/ESTABLISHES_FRAME/DERIVED_FROM_EXCEPTION）
    caused_by = null, influenced_by = null, establishes_frame_for = null, triggered_by_exception = null,
    tenantId = 'system', // T5 多租户：决策归属租户（默认 system=平台级问责层；用户态调用传入自身租户）
    // 【F4 单轨 2026-09-02】调用方（autonomyEngine）事前装配好的 7×7 上下文。
    //   传入 → createDecision 只冻结落库，不再重检索（快照 == 驱动决策的那份上下文）。
    pre_context = null,
  } = input;
  if (!scenario_id) throw new Error('decision 缺 scenario_id');
  if (!disposition) throw new Error('decision 缺 disposition');
  // 【T-D5】写时上下文守卫（配置化，非硬编码）：trigger_context/conditions_evaluated 缺失时，
  // block 模式拒写（抛 missing_context）；warn 模式仅 trace 留痕。默认 warn（详见 contextGuard.js）。
  await checkContextGuard({ scenario_id, trigger_context, conditions_evaluated });
  // 【T-D1/G5】置信度反算（单一事实源）：业务结果信号优先于即时人工判；无信号回退 0.6。
  const confidence = computeConfidence({
    outcomeVerified: outcome_verified, humanDisposition: human_disposition, engineConfidence: engine_confidence,
  });
  // 写时向量（方案 B，2026-09-03）：model 路径写真语义向量（与搜索/回填同源口径），hash 路径写 NULL。
  //   列已迁移 vector(1024)，hash 384 维写入报维度错误且 hash 路径搜索不计向量分量，故写 NULL 无害；
  //   降级（embedText 退回 hash）亦写 NULL，留待 searchPrecedents 即时重嵌或回填脚本补齐，避免维度冲突。
  let embedding = null;
  if (process.env.EMBEDDING_PROVIDER === 'model') {
    try {
      // P0-1（2026-09-06）：创建决策的向量化须带 metering（此前未传 → 不计量/不预检）
      const ev = await embedText(stableStringify({
        scenario_id, ctx: trigger_context || {}, cond: conditions_evaluated || [],
      }), { metering: { tenantId, actor: 'decision', action: 'decision-create-embed' } });
      if (ev.provider === EMBED_PROVIDER.MODEL) embedding = JSON.stringify(ev.vector);
    } catch (e) {
      emit('trace', 'decision-embedding-write-failed', { scenario_id, error: String(e?.message || e) });
      recordFailure('decision-embedding-write-failed', e);
    }
  }
  // 【稽核台】写时物化 attribution，复用 sevenDimensionsCheck（与 S20 拦截引擎同一份 ctx[dim] 空值判定，单一事实源）
  let attribution = null;
  try {
    const { computeAttribution } = await import('../monitor/attribution.js');
    attribution = await computeAttribution({ scenario_id, trigger_context, query });
  } catch (e) {
    emit('trace', 'attribution-materialize-failed', { scenario_id, error: String(e?.message || e) });
    recordFailure('attribution-materialize-failed', e);
  }
  // 【T3 拦截闭环】写入前调 sevenDimensionsCheck；纯函数 decideInterception 判定；
  // required_dims 含 on_missing='block' 维缺失 → 拒写（missing_context）；warn 缺失仅标红不阻断。
  const chk = await sevenDimensionsCheck(scenario_id, trigger_context, { query });
  const intercept = decideInterception(chk);
  if (intercept.blocked) {
    throw new Error(missingContextMessage(intercept));
  }

  // 【F4 单轨 2026-09-02：事后解释 → 事前驱动】7×7 上下文装配**前移到 INSERT 之前**。
  //   缺陷：装配原先在 INSERT 之后（旧 :107），且引擎自己另跑一套先例检索 → 落库快照
  //   与真正驱动决策的上下文不同源，可审计性失效（Q1/Q4 建立在「事后补的解释」上）。
  //   契约：
  //     ① 传入 pre_context（引擎事前装配）→ 此处仅冻结，不重跑任何 retriever；
  //     ② 未传（存量调用方零修改）→ 在 INSERT 之前自动补跑 assembleContextV2({phase:'pre',persist:false})，
  //        决策落库后再冻结（拿到真 decision_id 才落快照 + 写 PROV-O，不留孤儿快照）；
  //     ③ 事前装配失败 → 退回事后装配，但 phase 诚实标注 'post'（绝不冒充事前驱动）。
  //   失败一律 fail-open + emit trace + recordFailure（不静默，也不阻断决策本身）。
  const assemblyInput = {
    actor: decider_id || 'system',
    scenario_id,
    query: (trigger_context && (trigger_context.query || trigger_context.summary)) || rationale || '',
    entities: involved_entities,
    trigger_context,
    tenant_id: tenantId,
  };
  let preContext = pre_context || null;
  if (!preContext) {
    try {
      const { assembleContextV2 } = await import('../context/assembleContextV2.js');
      preContext = await assembleContextV2({ ...assemblyInput, phase: 'pre', persist: false });
    } catch (err) {
      emit('trace', 'context-assembly-failed', { scenario_id, phase: 'pre', error: String(err?.message || err) });
      recordFailure('context-assembly-failed', err);
      preContext = null;
    }
  }
  // 记录事前装配是否成功，供落库后选择「冻结」还是「诚实的事后退回」
  const preAssembled = !!preContext;

  // 【B2】八要素物化：调用方传入优先；intent 未传则生成弱草稿（fail-open）
  const eightElements = materializeEightElements(
    { intent, assumptions, inference, viewpoints, implications, risk_register, stop_loss, concept_refs },
    { rationale, trigger_context }
  );
  // 【P3 D1 双轨闭合】concept_refs 回查 methodology_dimension 补全 canonical weight/required/label，
  // 与 Pre 装配的概念清单同源（消除 N4/F2：此前 concept_refs 由调用方手抄、methodology_dimension 零消费）。
  if (Array.isArray(eightElements.concept_refs) && eightElements.concept_refs.length) {
    try {
      const { enrichConceptRefs } = await import('../knowledge/methodologyInjection.js');
      eightElements.concept_refs = await enrichConceptRefs(eightElements.concept_refs, null, pool, {
        // MISS 留痕：concept_refs 引用的维键在 methodology_dimension 镜像中缺失时，发出 trace
        // 而非静默无痕（消除 discount_redline/price_vs_floor 等缺失维键的盲区）。
        onMiss: (ref) => emit('trace', 'concept-refs-dim-miss', {
          scenario_id, methodology_id: ref.methodology_id, dimension_key: ref.dimension_key,
        }),
      });
    } catch (e) {
      emit('trace', 'concept-refs-enrich-failed', { scenario_id, error: String(e?.message || e) });
      recordFailure('concept-refs-enrich-failed', e);
    }
  }

  // 【方案 B 健壮性 · fail-open】维度错降级：DB 列未迁移到 vector(1024) 时写真向量维度不符抛错，
  // insertDecisionFailOpen 捕获后降级 embedding=NULL 重试（决策不丢，仅向量缺失，留痕待迁移+回填补齐）。
  // 【C 方案 2026-09-03】display_name 兜底：调用方未传则按场景+trigger_context 自动推导，保证「名称」列恒有值。
  const finalDisplayName = display_name || deriveDisplayName(scenario_id, trigger_context);
  const insertSql =
    `INSERT INTO decision
       (scenario_id, trigger_context, involved_entities, conditions_evaluated,
        effective_policy_version, disposition, decider_type, decider_id, decider_role,
        rationale, display_name, referenced_precedents, business_tier, state, outcome, embedding, attribution, decided_at,
        confidence, confidence_source, confidence_at, outcome_verified, feedback, feedback_link, root_cause, tenant_id,
        intent, assumptions, inference, viewpoints, implications, risk_register, stop_loss, concept_refs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(),
        $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
     RETURNING *`;
  const insertParams = [scenario_id, JSON.stringify(trigger_context), JSON.stringify(involved_entities),
     JSON.stringify(conditions_evaluated), effective_policy_version, disposition, decider_type,
     decider_id, decider_role, rationale, finalDisplayName, JSON.stringify(referenced_precedents), business_tier,
     state, outcome, embedding, attribution,
     confidence, 'computed', new Date(), outcome_verified, feedback, feedback_link,
     root_cause ? JSON.stringify(root_cause) : null, tenantId,
     JSON.stringify(eightElements.intent), JSON.stringify(eightElements.assumptions),
     JSON.stringify(eightElements.inference), JSON.stringify(eightElements.viewpoints),
     JSON.stringify(eightElements.implications), JSON.stringify(eightElements.risk_register),
     JSON.stringify(eightElements.stop_loss), JSON.stringify(eightElements.concept_refs)];
  const r = await insertDecisionFailOpen(insertSql, insertParams, 15); // $16 = embedding（display_name 插入后 embedding 顺移一位）
  const decision = r.rows[0];

  // 【镜像】决策 stop_loss → CRM_DEAL.payload.stop_loss（fail-open：镜像失败仅留痕，不阻断决策落库）
  // 决策为 stop_loss 唯一事实源；粒子级可观测供 crm-risk 扫描探测（设计 Task 2）。
  if (eightElements.stop_loss != null && Array.isArray(involved_entities) && involved_entities.length) {
    const dealEnt = involved_entities.find((e) => e && (e.type === 'CRM_DEAL' || e.type === 'DEAL'));
    if (dealEnt && dealEnt.id) {
      try {
        const { updateParticle } = await import('../particles/particleRepo.js');
        const sl = eightElements.stop_loss;
        const slPayload = {
          status: sl?.status ?? null,
          condition: sl?.condition ?? null,
          deadline: sl?.deadline ?? null,
          trigger: sl?.trigger ?? null,
          owner: sl?.owner ?? null,
        };
        await updateParticle(dealEnt.id, { patch: { stop_loss: slPayload }, requireDecisionId: decision.decision_id });
      } catch (e) {
        emit('trace', 'stop-loss-mirror-fail', { deal_id: dealEnt.id, decision_id: decision.decision_id, error: String(e?.message || e) });
        recordFailure('stop-loss-mirror-fail', e);
      }
    }
  }

  // 【B2+B3 联动】落库即九尺子评分（fail-open：设计 §3.3 内嵌决策生成；失败仅留痕不阻断主写）
  // B4 2026-09-02：评分线接入场景行真实配置（focus_rulers/required_dims/rubric_pass_line/enabled_rulers），
  //   pre_context 装配结果作 suppliedDims 传入「相关性」集合运算（preAssembled 为 null 时保持空数组口径）。
  if (decision?.decision_id) {
    try {
      const { scoreDecision, persistRubric } = await import('../decision/rubricScorer.js');
      const sc = await loadScenarioConfig(scenario_id);
      // pre_context.dim_coverage 可能是「对象 {dim:{supplied,ops}}」或「数组 [{dim,supplied}]」形态，双形态兼容
      const cov = preContext?.dim_coverage || {};
      const suppliedDims = Array.isArray(cov)
        ? cov.filter((d) => d && d.supplied).map((d) => d.dim)
        : Object.entries(cov).filter(([, v]) => v && v.supplied).map(([k]) => k);
      const rubric = await scoreDecision(
        { ...eightElements, scenario_id, trigger_context, conditions_evaluated },
        {
          requiredDims: sc?.required_dims != null && Array.isArray(sc.required_dims) ? sc.required_dims : null,
          focus: sc?.focus_rulers != null && Array.isArray(sc.focus_rulers) ? sc.focus_rulers : null,
          // 【B 2026-09-04】enabled_rulers 真子集：非空时只跑列出的尺子；NULL/空=跑全 9 尺子（向后兼容）。
          enabled: sc?.enabled_rulers != null && Array.isArray(sc.enabled_rulers) ? sc.enabled_rulers : null,
          suppliedDims,
          thresholds: sc?.rubric_pass_line != null ? { warn: Number(sc.rubric_pass_line) } : undefined,
        }
      );
      await persistRubric(pool, decision.decision_id, rubric);
    } catch (e) {
      emit('trace', 'rubric-score-failed', { decision_id: decision.decision_id, error: String(e?.message || e) });
      recordFailure('rubric-score-failed', e);
    }
  }

  // 【P0 接线修复 2026-09-01】决策落库后自动装配 7×7 记忆系统（assembleContextV2）：
  //   装配 S1-S7 供给 → 落 decision_context_snapshot → 回指 decision.context_snapshot_id → S7 操作级 PROV-O。
  //   此前 assembleContextV2 只挂在调试端点（routes.js:2089/2114），生产决策创建从不触发 → 7×7 永远空盒。
  //   修复：挂进 createDecision 主链路（决策一旦物化即装配），fail-open——装配失败仅留痕，不阻断决策本身。
  //   （与 attribution/置信度同级：try/catch + emit trace + recordFailure，不静默。）
  //   【F4 单轨 2026-09-02】落库阶段语义改为「冻结」：事前已装配好 → 直接落 pre_context，
  //   不再重跑 S1–S7（旧实现此处会二次检索 S2，与引擎那批先例不同源 → 双轨）。
  if (decision?.decision_id) {
    try {
      const { assembleContextV2 } = await import('../context/assembleContextV2.js');
      const freezeInput = {
        ...assemblyInput,
        decision_id: decision.decision_id,
        // 事前装配成功 → 冻结（phase 继承事前装配的声明，默认 'pre'）；
        // 失败 → 退回事后装配并诚实标注 phase='post'（绝不冒充事前驱动）
        ...(preAssembled ? { pre_context: preContext, phase: preContext.phase || 'pre' } : { phase: 'post' }),
      };
      await assembleContextV2(freezeInput).catch((err) => {
        emit('trace', 'context-assembly-failed', { decision_id: decision.decision_id, error: String(err?.message || err) });
        recordFailure('context-assembly-failed', err);
      });
    } catch (err) {
      emit('trace', 'context-assembly-failed', { decision_id: decision.decision_id, error: String(err?.message || err) });
      recordFailure('context-assembly-failed', err);
    }
  }

  // BG-03 方案 B：linkDecisions 双写 PG 权威 decision_relation + AGE 镜像（失败仅 trace+recordFailure）。
  //   DECIDED_ON / DERIVED_FROM_EXCEPTION 的 to_id 指向业务实体/异常（to_id 外键已放宽），现可落权威表。
  const { linkDecisions } = await import('./relation.js');

  // 【P1】写时镜像决策顶点进 AGE 图（设计 §4.1：决策顶点 + DECIDED_ON→业务粒子 + REFERENCED_PRECEDENT→先例）
  // 失败仅 trace + recordFailure（G3 不静默），主链路不阻断。AGE 不可用则整段跳过（仅影响镜像，不影响权威边）。
  if (isAvailable()) {
    try {
      await addDecision(decision);
      for (const ent of (Array.isArray(involved_entities) ? involved_entities : [])) {
        await addParticleVertex(ent.type, ent.id, ent.name || '').catch(() => {});
      }
    } catch (e) {
      emit('trace', 'decision-graph-sync-failed', { decision_id: decision.decision_id, error: String(e?.message || e) });
      recordFailure('decision-graph-sync-failed', e);
    }
  }
  // BG-03 方案 B：DECIDED_ON 权威边（PG）无条件写入——PG 为权威，不依赖 AGE 可用性（AGE 镜像由 linkDecisions 内部降级处理）。
  //   to_id=实体 UUID（外键已放宽）；失败留痕不阻断主写。覆盖 T5/T6「决策↔实体边写入点补齐」。
  for (const ent of (Array.isArray(involved_entities) ? involved_entities : [])) {
    await linkDecisions(String(decision.decision_id), String(ent.id), 'DECIDED_ON',
      { source: 'engine', props: { entity_type: ent.type, entity_name: ent.name || '' } })
      .catch((err) => {
        emit('trace', 'decision-relation-write-failed', { decision_id: decision.decision_id, to_id: ent.id, rel_type: 'DECIDED_ON', error: String(err?.message || err) });
        recordFailure('decision-relation-write-failed', err);
      });
  }

  // 【P3】写时溯源捕获（SHA-256 链；失败仅 trace+recordFailure，不阻断主写）
  await trackEntry({
    decision_id: decision.decision_id,
    entry_type: 'decision',
    payload: {
      scenario_id: decision.scenario_id, disposition: decision.disposition,
      decider_type: decision.decider_type, rationale: decision.rationale,
      involved_entities: decision.involved_entities, trigger_context: decision.trigger_context,
    },
    source: 'decision-made', activity_id: decision.decision_id,
  }).catch((err) => {
    emit('trace', 'provenance-capture-failed', { decision_id: decision.decision_id, error: String(err?.message || err) });
    recordFailure('provenance-capture-failed', err);
  });

  // L2 决策事件持久化（决策物化事件流：made；与引擎 required/autonomous/escalated 形成完整生命周期）
  await recordDecisionEvent('made', {
    decision_id: decision.decision_id, scenario_id, disposition,
    state: decision.state, business_tier, tenantId,
  });

  // 先例关系（PG 关系表；similarity 由 searchPrecedents 计算，落库时如携带则写入）
  const precs = Array.isArray(referenced_precedents) ? referenced_precedents : [];
  for (const p of precs) {
    const pid = typeof p === 'string' ? p : p.precedent_id;
    const sim = typeof p === 'object' ? (p.similarity ?? null) : null;
    if (pid) {
      await queryWrite(
        `INSERT INTO decision_precedent_rel (decision_id, precedent_id, similarity)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [decision.decision_id, pid, sim]
      ).catch((err) => {
        // G3 R1 可观测化：先例关系写失败不再静默（决策网络断链需有痕迹）
        emit('trace', 'precedent-link-failed', { decision_id: decision.decision_id, precedent_id: pid, error: String(err?.message || err) });
        recordFailure('precedent-link-failed', err);
      });
      // 【P2】写时因果边：本决策引用先例 → AGE REFERENCED_PRECEDENT 边（T2/BG-06：降级留痕，不阻断主写）
      await mirrorEdge('REFERENCED_PRECEDENT', String(decision.decision_id), String(pid), { similarity: sim },
        { decision_id: decision.decision_id, actor: decider_id || null });
      // 【T-D2】权威边表同步：decision_relation 为 7 类边的唯一事实源（AGE 仅为镜像，可降级）。
      // BG-03 方案 B：to_id 外键已放宽，DECIDED_ON（决策→粒子）与 DERIVED_FROM_EXCEPTION（决策→异常）
      //   现可落此表；involved_entities JSONB 仍为决策主记录，decision_relation 是其派生的图边。
      await queryWrite(
        `INSERT INTO decision_relation (from_id, to_id, rel_type, serves_dimension, props, source)
         VALUES ($1,$2,'REFERENCED_PRECEDENT','decision_history',$3,'engine')
         ON CONFLICT (from_id, to_id, rel_type) DO NOTHING`,
        [decision.decision_id, pid, JSON.stringify({ similarity: sim })]
      ).catch((err) => {
        emit('trace', 'decision-relation-write-failed', { decision_id: decision.decision_id, to_id: pid, error: String(err?.message || err) });
        recordFailure('decision-relation-write-failed', err);
      });
    }
  }

  // 【P2 补齐】决策因果链四类边写时接线（设计 §4.1 七类边补齐：CAUSED/INFLUENCED/ESTABLISHES_FRAME/DERIVED_FROM_EXCEPTION）
  // 经 relation.linkDecisions 双写 PG 权威 decision_relation + AGE 镜像（失败仅 trace+recordFailure，不阻断主写）
  const asArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  for (const causeId of asArr(caused_by)) {
    if (causeId) await linkDecisions(String(causeId), decision.decision_id, 'CAUSED', { source: 'engine' }).catch(() => {});
  }
  for (const infId of asArr(influenced_by)) {
    if (infId) await linkDecisions(String(infId), decision.decision_id, 'INFLUENCED', { source: 'engine' }).catch(() => {});
  }
  for (const frameId of asArr(establishes_frame_for)) {
    if (frameId) await linkDecisions(decision.decision_id, String(frameId), 'ESTABLISHES_FRAME', { source: 'engine' }).catch(() => {});
  }
  // DERIVED_FROM_EXCEPTION：决策→异常顶点（BG-03 方案 B：to_id 外键放宽，现可落权威表 decision_relation）
  if (triggered_by_exception) {
    const exId = typeof triggered_by_exception === 'string' ? triggered_by_exception : triggered_by_exception?.id;
    const exName = typeof triggered_by_exception === 'string' ? triggered_by_exception
      : (triggered_by_exception?.name || triggered_by_exception?.id || 'exception');
    if (exId) {
      await addParticleVertex('EXCEPTION', String(exId), String(exName)).catch(() => {});
      // BG-03 方案 B：DERIVED_FROM_EXCEPTION 改走 linkDecisions 落权威表（to_id=异常 id，外键已放宽）+ AGE 镜像
      await linkDecisions(String(decision.decision_id), String(exId), 'DERIVED_FROM_EXCEPTION',
        { source: 'engine', props: { exception_name: exName }, toLabel: 'EXCEPTION' })
        .catch((err) => {
          emit('trace', 'decision-relation-write-failed', { decision_id: decision.decision_id, to_id: exId, rel_type: 'DERIVED_FROM_EXCEPTION', error: String(err?.message || err) });
          recordFailure('decision-relation-write-failed', err);
        });
    }
  }

  // 记忆沉淀（append-only，topic=decision:<id>，L-Workspace 层，供跨会话引用）
  await appendMemoryLog(decision.decision_id, {
    scenario_id, disposition, rationale, business_tier, decider_type,
  }).catch((err) => {
    // G3 R1b 可观测化：决策记忆沉淀失败不再静默（跨会话记忆丢失需有痕迹）
    emit('trace', 'decision-memory-failed', { decision_id: decision.decision_id, error: String(err?.message || err) });
    recordFailure('decision-memory-failed', err);
  });

  emit('decision', 'made', {
    decision_id: decision.decision_id, scenario_id, disposition,
    state: decision.state, business_tier,
  });
  return decision;
}

export async function appendMemoryLog(decisionId, payload) {
  const res = await appendMemory({
    topic: `decision:${decisionId}`,
    kind: 'decision',
    payload,
    layer: 'L-Workspace',
    eventType: 'decision-made',
  });
  return res.ok ? res.row : null;
}

export async function getDecision(id) {
  const r = await query(`SELECT * FROM decision WHERE decision_id=$1`, [id]);
  return r.rows[0] || null;
}

export async function listDecisions({ scenario_id = null, state = null, limit = 50, tenantId = '*' } = {}) {
  const where = [];
  const params = [];
  if (scenario_id) { params.push(scenario_id); where.push(`scenario_id=$${params.length}`); }
  if (state) { params.push(state); where.push(`state=$${params.length}`); }
  // T13 租户隔离（2026-09-04）：缺省 '*'=全量（行为兼容现状）；显式传租户按回退范式（对齐 executor.js:25）
  if (tenantId && tenantId !== '*') {
    params.push(tenantId);
    where.push(`(tenant_id=$${params.length} OR tenant_id='system')`);
  }
  params.push(limit);
  const r = await query(
    `SELECT * FROM decision ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

// C4 两段式先例检索（2026-09-03 T8）：粗召回(scenario + 已确认态，按时间取候选池) → 四分量精算 → top-k。
//   不再用伪向量(pgvector <=>)排序：hashVector 相似度在语义相近样本上恒≈0.11(无区分度噪声)，用它召回=随机取。
//   改为结构分量主导，向量仅在 provider='model' 时计入（provider='hash' 默认路径丢弃向量分量，权重重分配）。
//   第二参 q：{ trigger_context, conditions_evaluated, business_tier, disposition }（查询上下文对象，非向量）。
export async function searchPrecedents(scenario_id, q = {}, opts = {}) {
  const { k = 5, minSimilarity = null, tenantId = 'system' } = opts || {};
  const conf = await loadPrecedentConf({ tenantId });
  const floor = minSimilarity == null ? conf.minSimilarity : Number(minSimilarity);
  const pool = Math.max(conf.candidatePool, k * 4);

  // ① 粗召回：撤回原 embedding <=> 排序，改按时间倒序取候选池（含 trigger_context 供 model 路径即时重嵌）
  // 租户化（T6，P1）：先例检索跨租户串数据——粗召回补租户条件；回退范式对齐 executor.js:25
  //   （tenant_id=$3 OR tenant_id='system'）：本租户行优先，system 基线兜底——过滤即隔离，排序保持时间倒序
  const cands = (await query(
    `SELECT decision_id, scenario_id, disposition, business_tier, rationale,
            conditions_evaluated, referenced_precedents, trigger_context, embedding, created_at
     FROM crm.decision
     WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')
       AND (tenant_id=$3 OR tenant_id='system')
     ORDER BY created_at DESC LIMIT $2`,
    [scenario_id, pool, tenantId]
  )).rows;
  if (!cands.length) return [];

  // ② 向量分量：provider='hash'(默认) 时丢弃(降级)，权重重分配到结构分量
  // P0-1（2026-09-06）：向量化须带 metering（此前未传 → 决策 embedding 完全不计量/不预检）
  const qvec = await embedText(stableStringify({
    scenario_id,
    ctx: q?.trigger_context || {},
    cond: q?.conditions_evaluated || [],
  }), { metering: { tenantId, actor: 'decision', action: 'precedent-query-embed' } });
  const dropVector = qvec.provider !== EMBED_PROVIDER.MODEL;
  const { weights, degraded } = normalizeWeights(conf.weights, { dropVector });
  if (degraded) emit('trace', 'precedent-vector-degraded', { scenario_id, provider: qvec.provider, weights });

  const scored = [];
  for (const c of cands) {
    // 向量分量激活（provider='model'）：查询时即时重嵌候选（与 qvec 同源、维度一致），
    //   避免存储模型向量带来的 schema 维度迁移；hash 路径 dropVector=true 直接跳过（存储列是 hash 基线，无区分度）。
    //   旧实现用 DB 存值(c.embedding=hashVector) 与模型查询比对 → 维度/语义皆错配 → 恒 null。现改为同源重嵌。
    let vector = null;
    if (!dropVector) {
      // 方案 B（2026-09-03）：优先读存储的真向量（1024 维），免 API 调用；
      //   半回填/未迁移行（embedding IS NULL 或维度不符）回退即时重嵌（同源，保证命中）。
      const stored = parsePgVector(c.embedding);
      if (stored && stored.length === qvec.vector.length) {
        vector = cosine(qvec.vector, stored);
      } else {
        const cEmbed = await embedText(stableStringify({
          scenario_id: c.scenario_id,
          ctx: c.trigger_context || {},
          cond: c.conditions_evaluated || [],
        }), { metering: { tenantId, actor: 'decision', action: 'precedent-candidate-embed' } });
        if (cEmbed.vector.length === qvec.vector.length) vector = cosine(qvec.vector, cEmbed.vector);
      }
    }
    const parts = {
      jaccard: jaccardConditions(q?.conditions_evaluated || [], c.conditions_evaluated || []),
      category: categoryMatch(
        { scenario_id, business_tier: q?.business_tier, disposition: q?.disposition },
        { scenario_id: c.scenario_id, business_tier: c.business_tier, disposition: c.disposition }
      ),
      graphDepth: await graphDepthOf(c.decision_id, { maxDepth: conf.graphMaxDepth }),
      vector,
    };
    const similarity = similarityOf(parts, weights);
    if (similarity >= floor) scored.push({ ...c, similarity: Number(similarity.toFixed(4)), components: parts });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// L2 决策事件持久化 + 广播（decision 事件域）
export async function recordDecisionEvent(event_type, { decision_id = null, scenario_id = null, tenantId = 'system', ...payload } = {}) {
  const r = await queryWrite(
    `INSERT INTO decision_event (event_type, decision_id, scenario_id, payload, tenant_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [event_type, decision_id, scenario_id, JSON.stringify(payload), tenantId]
  );
  emit('decision', event_type, { decision_id, scenario_id, tenantId, ...payload });

  // C2：决策生命周期事件写回审计链（此前 27 处调用点全部在链外——决策「发生过什么」不被哈希保护，
  //     任何人 UPDATE decision_event 都无痕迹）。范围与宽容策略：
  //   ① 仅 decision_id 非空者入链——'required' 等前决策事件尚无归属，入链即孤儿条目（FK 也会拒）。
  //   ② payload 刻意不含 tenantId：租户标识是行属性、联表可查；塞进哈希会让「租户改名/迁移」误报 TAMPERED。
  //   ③ entry_type 用 `event:` 前缀，与证据类条目（decision / context_supply / RETRO / NEGATIVE_PRECEDENT）
  //      区分——可审计性 Q2 的「溯源条目」口径只统计证据条目（auditability.js:78 已收窄）。
  //   ④ fail-open（I1）：审计写入失败不得阻断业务事件广播，仅留痕 + recordFailure。
  if (decision_id) {
    await trackEntry({
      decision_id,
      entry_type: `event:${event_type}`,
      payload: { event_type, scenario_id, ...payload },
      source: 'decision-event',
      activity_id: decision_id,
    }).catch((err) => {
      emit('trace', 'provenance-event-track-failed', { decision_id, event_type, error: String(err?.message || err) });
      recordFailure('provenance-event-track-failed', err);
    });
  }
  return r.rows[0];
}

// HITL 确认（升级→CONFIRMED；成为后续先例）
export async function confirmDecision(decision_id, { by_id = null, by_role = null } = {}) {
  const r = await queryWrite(
    `UPDATE decision SET state='CONFIRMED', decider_type=COALESCE($2, decider_type),
       decider_id=COALESCE($3, decider_id), decided_at=now(), updated_at=now()
     WHERE decision_id=$1 RETURNING *`,
    [decision_id, by_role, by_id]
  );
  const d = r.rows[0];
  if (d) {
    // 【P1】确认后同步 AGE 图顶点 state=CONFIRMED（MERGE 更新；失败不阻断主写）
    if (isAvailable()) {
      try { await addDecision(d); } catch (e) { emit('trace', 'decision-graph-sync-failed', { decision_id, error: String(e?.message || e) }); recordFailure('decision-graph-sync-failed', e); }
    }
    emit('decision', 'confirmed', { decision_id, by_role });
  }
  return d;
}

// 决策逆转（闭环喂反馈；outcome=REVERSED）
export async function reverseDecision(decision_id, reason) {
  const r = await queryWrite(
    `UPDATE decision SET state='REVERSED', outcome='REVERSED', updated_at=now()
     WHERE decision_id=$1 RETURNING *`,
    [decision_id]
  );
  const d = r.rows[0];
  if (d) {
    await appendMemoryLog(decision_id, { reversed: true, reason }).catch(() => {});
    emit('decision', 'reversed', { decision_id, reason });
    // 【P1】翻案后同步 AGE 图顶点 state=REVERSED（MERGE 更新；失败不阻断主写）
    if (isAvailable()) {
      try { await addDecision(d); } catch (e) { emit('trace', 'decision-graph-sync-failed', { decision_id, error: String(e?.message || e) }); recordFailure('decision-graph-sync-failed', e); }
    }
    // 【P2】因果边：本决策被翻案 → 其下游引用者 OVERRIDES 本决策（先例网因果可追溯）
    const succ = (await query(
      `SELECT decision_id FROM crm.decision_precedent_rel WHERE precedent_id=$1`,
      [decision_id]
    )).rows;
    // T3(BG-02)：OVERRIDES 改走 linkDecisions 落权威表 decision_relation（原仅 mirrorEdge 镜像 AGE，漏接权威表 → 看板永远缺 OVERRIDES 边）。
    //   经 relation.linkDecisions 双写 PG 权威 + AGE 镜像；权威写失败会抛错（真丢失，非降级），由 .catch 留痕不阻断主写。
    const { linkDecisions } = await import('./relation.js');
    for (const s of succ) {
      await linkDecisions(String(s.decision_id), String(decision_id), 'OVERRIDES', { source: 'engine', props: { reason, reversed: true } })
        .catch((e) => { emit('trace', 'decision-relation-write-failed', { rel_type: 'OVERRIDES', from_id: s.decision_id, to_id: decision_id, error: String(e?.message || e) }); recordFailure('decision-relation-write-failed', e); });
    }
  }
  return d;
}

// 30 天蒸馏：被推翻/低频先例降权（decision_precedent_rel.similarity 折扣，非删除）
export async function distillPrecedents({ olderThanDays = 30, factor = 0.5 } = {}) {
  const r = await queryWrite(
    `UPDATE decision_precedent_rel r
     SET similarity = similarity * $1
     FROM decision d
     WHERE r.precedent_id = d.decision_id
       AND (d.outcome='REVERSED' OR d.created_at < now() - ($2 || ' days')::interval)`,
    [factor, olderThanDays]
  );
  return r.rowCount || 0;
}

// ── 决策质量稽核台：滞后回写（不删历史，UPDATE 覆盖 attribution）──
const EMPTY_ATTRIBUTION = {
  required_fill: { provided: [], missing: [] },
  category: 'ok',
  accuracy_signal: 'pending',
  outcome_verified: null,
};

// 人工处置回写：复用 attribution 物化列，按 human_disposition 重判 category/accuracy_signal
export async function writebackHumanDisposition(decisionId, humanDisposition) {
  const r = await query(`SELECT attribution FROM crm.decision WHERE decision_id=$1`, [decisionId]);
  const cur = r.rows[0]?.attribution || EMPTY_ATTRIBUTION;
  const next = applyHumanDisposition(cur, humanDisposition);
  await queryWrite(
    `UPDATE crm.decision SET attribution=$2::jsonb, human_disposition=$3, human_decided_at=now() WHERE decision_id=$1`,
    [decisionId, JSON.stringify(next), humanDisposition]
  );
  return next;
}

// 业务结果回写：滞后校验「当初判得对不对」（outcome_verified）
export async function writebackOutcome(decisionId, outcome) {
  const r = await query(`SELECT attribution FROM crm.decision WHERE decision_id=$1`, [decisionId]);
  const cur = r.rows[0]?.attribution || EMPTY_ATTRIBUTION;
  const next = applyOutcome(cur, outcome);
  await queryWrite(`UPDATE crm.decision SET attribution=$2::jsonb, outcome=$3 WHERE decision_id=$1`,
    [decisionId, JSON.stringify(next), outcome]);
  return next;
}

// 回填决策关联实体的真实 id —— 根治 routes.js 第0闸「先 mint 决策、后建粒子」导致
// involved_entities.id 被写死 null 的坑（2026-09-03 Plan B）。
// 背景：写通道「写无决策不落库」→ 决策先于粒子落库；粒子 id 由 PG 在 INSERT 时生成，
//   决策 mint 时刻尚不存在，故 requireDecision 只能传 id:null。粒子落库后在此回填真实 id，
//   使未来决策可被 query 按 e->>'id' 直接命中（不再依赖 trigger_context 兜底 fallback）。
// 兼容形态：数组（写首个元素 id）/ null / []（重建为单元素数组）。
export async function backfillDecisionInvolvedEntity(decisionId, entityId, entityType) {
  if (!decisionId || !entityId) return null;
  await queryWrite(
    `UPDATE crm.decision
     SET involved_entities =
       CASE
         WHEN jsonb_typeof(involved_entities) = 'array'
              AND jsonb_array_length(involved_entities) > 0
           THEN jsonb_set(involved_entities, '{0,id}', to_jsonb($2::text))
         ELSE jsonb_build_array(jsonb_build_object('type', $3, 'id', $2))
       END
     WHERE decision_id = $1`,
    [decisionId, entityId, entityType]
  );
  return true;
}
