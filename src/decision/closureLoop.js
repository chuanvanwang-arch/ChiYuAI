// src/decision/closureLoop.js — P2 闭环回流（决策改写 K + M）
// 设计依据：docs/2026-09-02-cognitive-decision-unified-design.md §9（闭环回流）+ §11.4（P2 任务 C1–C5）。
// 铁律对齐：
//   ① 单决策复盘写 decision_provenance（entry_type='RETRO'，append-only，经 provenance.trackEntry 链式校验和）；
//      批量聚合写 decision_retro_report（由 retro.js 负责，本文件不重复）。
//   ② 三通道分流（§9.2）：C1 事实类自动直写 provenance（append-only，不可逆改）；
//      C2 falsified 假设 → 反面先例 decision_precedent_rel.negative_precedent=true（新增，不覆盖）；
//      C3 改配置 patch → calibration_patch PENDING（绝不自动 apply，须经第0闸 + HITL 批准，由 calibrationRouter 完成）；
//      C3′ 记忆影响 → memory_log append-only（原记忆 payload 不动）。
//   ③ 后见之明（§9.3）：原始记忆永不覆盖，reinforce/rewrite 仅追加 HINDSIGHT_* 新行。
//   ④ 证实性偏差校验（§9.4）：hindsight_delta + 窗口偏差率，超阈值生成 C3 处方（PENDING）。
//   ⑤ 复合效应（§9.5）：Q(Skill,T) 采样落 decision_skill_quality，90 天窗口复合判据；定时器注册即预热。
// 依赖：provenance.trackEntry / calibration.savePatches / configStore.readConfig / decisionRepo.getDecision。
import { query, queryWrite } from '../db.js';
import { trackEntry } from './provenance.js';
import { savePatches } from '../calibration/store.js';
import { readConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
import { createParticle } from '../particles/particleRepo.js';

// 偏差校验默认阈值（阈值配置化铁律：走 config_store['hindsight-deviation']，此处仅出厂建议值）。
const DEFAULT_HINDSIGHT_CFG = { threshold: 0.3, rate_alarm: 0.3 };
const Q_IMPROVE_EPSILON = 0.05; // 90 天窗口内提升不足此值即判"空转"

async function readHindsightCfg() {
  const r = await readConfig('hindsight-deviation').catch(() => null);
  const v = r?.value && typeof r.value === 'object' ? r.value : {};
  return {
    threshold: typeof v.threshold === 'number' ? v.threshold : DEFAULT_HINDSIGHT_CFG.threshold,
    rate_alarm: typeof v.rate_alarm === 'number' ? v.rate_alarm : DEFAULT_HINDSIGHT_CFG.rate_alarm,
  };
}

// 取决策主实体 id（用于 memory_log.entity_id 锚定，便于按客户/实体查询记忆影响）
async function decisionEntityId(decisionId) {
  const r = await query(`SELECT involved_entities FROM crm.decision WHERE decision_id=$1`, [decisionId]);
  const ents = r.rows[0]?.involved_entities;
  if (Array.isArray(ents) && ents.length) {
    const first = ents[0];
    return first && (first.id || first.entity_id || null);
  }
  return null;
}

// ───────────────────── §9.2 三通道分流（纯函数，可单测） ─────────────────────
// 输入：复盘 7 组（A–G）。输出四类落库意图。
export function routeRetroChannels(payload = {}) {
  const assumptionReview = Array.isArray(payload.assumption_review) ? payload.assumption_review : [];
  const negativePrecedents = assumptionReview
    .filter((a) => a && a.verdict === 'falsified')
    .map((a) => ({ assumption: a.assumption || a.statement || null, falsified_by: a.falsified_by || null }));

  const knowledgeUpdates = Array.isArray(payload.knowledge_update) ? payload.knowledge_update : [];
  const memoryImpacts = Array.isArray(payload.memory_impact) ? payload.memory_impact : [];
  // C4（P0-② 租户级 Knowledge）：复盘结构化知识产出 → KNOWLEDGE 粒子回写
  const knowledgeParticles = Array.isArray(payload.knowledge_particles) ? payload.knowledge_particles : [];

  // C1 事实类：A/B/C/D/G 全部进入 RETRO provenance（append-only），此处仅聚合统计。
  const facts = {
    has_outcome: Boolean(payload.outcome_type),
    assumption_review_count: assumptionReview.length,
    missing_information_count: Array.isArray(payload.missing_information) ? payload.missing_information.length : 0,
    has_root_cause: Boolean(payload.root_cause),
  };

  return {
    facts,
    negative_precedents: negativePrecedents, // → C2 反面先例
    knowledge_patches: knowledgeUpdates,     // → C3 处方（PENDING）
    knowledge_particles: knowledgeParticles, // → C4 知识粒子回写（P0-② 新增）
    memory_impacts: memoryImpacts,           // → C3′ 记忆影响（append-only）
  };
}

// 将 knowledge_update 映射为合法 calibration_patch（仅 KNOBS 可处方；focus_rulers 等越界 knob 返回 rejected）
const PRESCRIBABLE = new Set([
  'threshold', 'weight', 'required_dims', 'confidence', 'edge_binding',
  'outcome_threshold', 'strictness', 'meta_attr_map', 'particle_attr_add',
  'k_edge_add', 'source_refresh', 'dim_order', 'precedent_distill',
]);
export function mapKnowledgeUpdateToPatch(k, decisionId = null) {
  if (!k || typeof k !== 'object') return { rejected: true, reason: '非对象', src: k };
  const knob = k.type || k.knob;
  if (!PRESCRIBABLE.has(knob)) return { rejected: true, reason: `knob=${knob} 不在可处方清单（C3 仅处方配置类，focus_rulers 等需另走设计）`, src: k };
  if (k.to_value == null) return { rejected: true, reason: 'to_value 缺失', src: k };
  return {
    rejected: false,
    knob,
    target: k.target ?? null,
    from_value: k.from_value ?? null,
    to_value: k.to_value,
    evidence: k.evidence ?? { source: 'retro' },
    expected_impact: k.expected_impact ?? null,
    risk: ['LOW', 'MEDIUM', 'HIGH'].includes(k.risk) ? k.risk : 'MEDIUM',
    decision_id: decisionId,
  };
}

// ───────────────────── C1 + C2 + C3 + C3′：提交复盘 ─────────────────────
export async function submitRetro(decisionId, payload = {}, { created_by = null } = {}) {
  if (!decisionId) throw new Error('submitRetro 需要 decision_id');
  // confidence 供 C4 知识回写置信度；involved_entities 供 C4 租户反查（决策自身无 tenant_id 列）
  const exist = await query(`SELECT decision_id, scenario_id, confidence, involved_entities FROM crm.decision WHERE decision_id=$1`, [decisionId]);
  if (!exist.rows.length) throw new Error(`decision 不存在: ${decisionId}`);
  const scenarioId = exist.rows[0].scenario_id; // 处方按决策场景正确归属（C3 审批链 apply 到该场景配置）

  const routed = routeRetroChannels(payload);

  // C1：RETRO provenance（事实类全量 append-only 直写）
  const retroEntry = await trackEntry({
    decision_id: decisionId,
    entry_type: 'RETRO',
    payload: {
      outcome_type: payload.outcome_type ?? null,
      verified_at: payload.verified_at ?? null,
      verified_by: payload.verified_by ?? created_by ?? null,
      assumption_review: payload.assumption_review ?? [],
      missing_information: payload.missing_information ?? [],
      root_cause: payload.root_cause ?? null,
      meta: payload.meta ?? null,
    },
    source: 'retro',
    activity_id: 'retro-submit',
  });

  // C2：falsified 假设 → 反面先例（self-reference；FK 要求合法 decision UUID，故 precedent_id=decision_id）
  let negativePrecedentCount = 0;
  for (const np of routed.negative_precedents) {
    await queryWrite(
      `INSERT INTO crm.decision_precedent_rel (decision_id, precedent_id, similarity, negative_precedent)
       VALUES ($1,$1,0,true)
       ON CONFLICT (decision_id, precedent_id) DO UPDATE SET negative_precedent=true`,
      [decisionId]
    );
    negativePrecedentCount += 1;
    // 反面先例同时留痕到 provenance（与 RETRO 同链，便于审计）
    await trackEntry({
      decision_id: decisionId,
      entry_type: 'NEGATIVE_PRECEDENT',
      payload: { assumption: np.assumption, falsified_by: np.falsified_by, at: new Date().toISOString() },
      source: 'retro',
      activity_id: 'negative-precedent',
    });
  }

  // C3′：记忆影响 → memory_log append-only（原记忆 payload 不动）
  const entityId = await decisionEntityId(decisionId);
  let memoryImpactCount = 0;
  for (const m of routed.memory_impacts) {
    await queryWrite(
      `INSERT INTO crm.memory_log (topic, kind, payload, entity_id)
       VALUES ($1,'RETRO_MEMORY_IMPACT',$2::jsonb,$3)`,
      [`decision:${decisionId}`, JSON.stringify(m), entityId]
    );
    memoryImpactCount += 1;
  }

  // C3：知识产出 → calibration_patch PENDING（AI 不直接改生产配置；须经第0闸 + HITL 批准）
  let patches = { created: 0, skipped: 0 };
  const rejected = [];
  if (routed.knowledge_patches.length) {
    const mapped = [];
    for (const k of routed.knowledge_patches) {
      const p = mapKnowledgeUpdateToPatch(k, null);
      if (p.rejected) rejected.push(p);
      else mapped.push(p);
    }
    if (mapped.length) patches = await savePatches(scenarioId, mapped, { decision_id: null });
  }

  // C4（P0-② 租户级 Knowledge）：结构化知识产出 → KNOWLEDGE 粒子回写
  // 租户解析（实查：crm.decision 无 tenant_id 列，db/schema.sql:155-177）：
  //   involved_entities 首实体反查粒子 tenant_id；取不到 → skip + trace 留痕（不阻断复盘主提交）
  const kps = routed.knowledge_particles || [];
  let knowledgeCount = 0;
  if (kps.length) {
    const ents = Array.isArray(exist.rows[0]?.involved_entities) ? exist.rows[0].involved_entities : [];
    let knowledgeTenantId = null;
    if (ents[0]?.id) {
      const t = await query(`SELECT tenant_id FROM crm.particles WHERE id=$1`, [ents[0].id]);
      knowledgeTenantId = t.rows[0]?.tenant_id || null;
    }
    if (!knowledgeTenantId) {
      emit('trace', 'knowledge-c4-skip', { decision_id: decisionId, reason: 'no_tenant_from_entities' });
    } else {
      for (const kp of kps) {
        if (!kp || !kp.term || !kp.kind || !kp.content) continue;
        await createParticle('CRM_KNOWLEDGE', {
          term: kp.term, kind: kp.kind, content: kp.content,
          source: 'retro_' + (payload.outcome_type || 'win'),
          confidence: Number(exist.rows[0]?.confidence ?? 0.7),
          tags: Array.isArray(kp.tags) ? kp.tags : [],
        }, { tenantId: knowledgeTenantId, actor: 'decision-agent', requireDecisionId: decisionId })
          .then(() => { knowledgeCount += 1; })
          .catch((e) => { emit('trace', 'knowledge-c4-write-failed', { decision_id: decisionId, error: String(e?.message || e) }); });
      }
      emit('trace', 'knowledge-c4-write', { decision_id: decisionId, count: knowledgeCount });
    }
  }

  return {
    ok: true,
    decision_id: decisionId,
    retro_entry_id: retroEntry.id,
    negative_precedents: negativePrecedentCount,
    memory_impacts: memoryImpactCount,
    patches,
    rejected_patches: rejected,
    routed,
  };
}

// ───────────────────── C2 后见之明（§9.3，append-only） ─────────────────────
export async function reinforceMemory(decisionId, { memory_ref = null, note = null } = {}) {
  if (!decisionId) throw new Error('reinforceMemory 需要 decision_id');
  const entityId = await decisionEntityId(decisionId);
  const r = await queryWrite(
    `INSERT INTO crm.memory_log (topic, kind, payload, entity_id)
     VALUES ($1,'HINDSIGHT_REINFORCE',$2::jsonb,$3) RETURNING id`,
    [`decision:${decisionId}`, JSON.stringify({ original_ref: memory_ref, note, tag: 'verified' }), entityId]
  );
  return { ok: true, memory_id: r.rows[0]?.id };
}

export async function rewriteMemory(decisionId, { memory_ref = null, reinterpretation = null, reason = null } = {}) {
  if (!decisionId) throw new Error('rewriteMemory 需要 decision_id');
  const entityId = await decisionEntityId(decisionId);
  const r = await queryWrite(
    `INSERT INTO crm.memory_log (topic, kind, payload, entity_id)
     VALUES ($1,'HINDSIGHT_REWRITE',$2::jsonb,$3) RETURNING id`,
    [`decision:${decisionId}`, JSON.stringify({ original_ref: memory_ref, reinterpretation, reason, tag: 'rewritten:hindsight' }), entityId]
  );
  return { ok: true, memory_id: r.rows[0]?.id };
}

// ───────────────────── C3 证实性偏差校验（§9.4） ─────────────────────
export async function recordHindsightBaseline(decisionId, { belief, confidence }) {
  if (!decisionId) throw new Error('recordHindsightBaseline 需要 decision_id');
  const entry = await trackEntry({
    decision_id: decisionId,
    entry_type: 'HINDSIGHT_CHECK',
    payload: { phase: 'baseline', belief_at_decision: belief ?? null, confidence_at_decision: typeof confidence === 'number' ? confidence : null },
    source: 'hindsight',
    activity_id: 'hindsight-baseline',
  });
  return { ok: true, entry_id: entry.id };
}

async function latestHindsightBaseline(decisionId) {
  const r = await query(
    `SELECT payload FROM crm.decision_provenance
     WHERE decision_id=$1 AND entry_type='HINDSIGHT_CHECK' AND payload->>'phase'='baseline'
     ORDER BY id DESC LIMIT 1`,
    [decisionId]
  );
  return r.rows[0]?.payload || null;
}

// 窗口内偏差率：|delta| > threshold 占比
export async function deviationRate({ windowDays = 90 } = {}) {
  const cfg = await readHindsightCfg();
  const r = await query(
    `SELECT payload FROM crm.decision_provenance
     WHERE entry_type='HINDSIGHT_CHECK' AND payload->>'phase'='review'
       AND created_at >= now() - make_interval(days => $1)`,
    [windowDays]
  );
  let over = 0;
  for (const row of r.rows) {
    const d = Number(row.payload?.delta);
    if (Number.isFinite(d) && Math.abs(d) > cfg.threshold) over += 1;
  }
  const total = r.rows.length;
  return { total, over, rate: total ? over / total : 0, threshold: cfg.threshold };
}

export async function hindsightCheck(decisionId, { belief_now, confidence_now } = {}) {
  if (!decisionId) throw new Error('hindsightCheck 需要 decision_id');
  const base = await latestHindsightBaseline(decisionId);
  if (!base) return { ok: false, need_baseline: true };

  const delta = (typeof confidence_now === 'number' && typeof base.confidence_at_decision === 'number')
    ? confidence_now - base.confidence_at_decision
    : null;
  const beliefChanged = belief_now != null && belief_now !== base.belief_at_decision;

  await trackEntry({
    decision_id: decisionId,
    entry_type: 'HINDSIGHT_CHECK',
    payload: {
      phase: 'review',
      belief_at_decision: base.belief_at_decision,
      confidence_at_decision: base.confidence_at_decision,
      belief_now: belief_now ?? null,
      confidence_now: typeof confidence_now === 'number' ? confidence_now : null,
      delta,
      belief_changed: beliefChanged,
    },
    source: 'hindsight',
    activity_id: 'hindsight-review',
  });

  const cfg = await readHindsightCfg();
  const rate = await deviationRate();
  let prescription = null;
  // 单决策偏差超阈值 且 窗口偏差率超告警 → 生成 C3 处方（PENDING，strictness 收紧）
  if (delta != null && Math.abs(delta) > cfg.threshold && rate.rate > cfg.rate_alarm) {
    const pr = await savePatches(null, [{
      knob: 'strictness',
      target: 'hindsight',
      from_value: null,
      to_value: { action: 'tighten_hindsight_review', reason: '证实性偏差超阈值', deviation_rate: rate.rate },
      evidence: { delta, deviation_rate: rate.rate, window: 90 },
      expected_impact: '对高偏差决策强制复盘复核',
      risk: 'MEDIUM',
      decision_id: null,
    }], { decision_id: null });
    prescription = pr;
  }
  return { ok: true, delta, belief_changed: beliefChanged, deviation_rate: rate.rate, prescription };
}

// ───────────────────── C5 复合效应测量（§9.5） ─────────────────────
export async function sampleQSkillT(scenario_id, skill, qualityScore, { decision_id = null } = {}) {
  if (!scenario_id || !skill || typeof qualityScore !== 'number') throw new Error('sampleQSkillT 参数缺失');
  await queryWrite(
    `INSERT INTO crm.decision_skill_quality (scenario_id, skill, sampled_at, quality_score, decision_id)
     VALUES ($1,$2,now(),$3,$4)
     ON CONFLICT (scenario_id, skill, sampled_at) DO UPDATE SET quality_score=EXCLUDED.quality_score, decision_id=EXCLUDED.decision_id`,
    [scenario_id, skill, qualityScore, decision_id]
  );
  return { ok: true };
}

// 90 天窗口复合判据：每 (scenario, skill) 取窗口内 q0 vs qN；提升不足 epsilon ⇒ 空转
export async function qSkillComposite({ windowDays = 90 } = {}) {
  const r = await query(
    `SELECT scenario_id, skill,
            MIN(quality_score) AS q0, MAX(quality_score) AS qn, COUNT(*)::int AS n,
            MIN(sampled_at) AS t0, MAX(sampled_at) AS tn
     FROM crm.decision_skill_quality
     WHERE sampled_at >= now() - make_interval(days => $1)
     GROUP BY scenario_id, skill`,
    [windowDays]
  );
  return r.rows.map((x) => {
    const q0 = Number(x.q0), qN = Number(x.qn);
    const improved = qN > q0 + Q_IMPROVE_EPSILON;
    return {
      scenario_id: x.scenario_id,
      skill: x.skill,
      q0, qN,
      improved,
      stagnant: !improved, // 反假绿判据：90 天无显著改善 = 名义存在、实际空转
      samples: Number(x.n),
      t0: x.t0, tN: x.tn,
    };
  });
}

// Q 采样分组键（2026-09-05 P0，设计 §4 D2）
// 缺陷：此前 skill 直接取 scenario_id —— 恒等于场景的**自我代理**，无任何分组维度，
//   做不了「注入叙事 vs 不注入叙事」的对照（反推 tracks 的前置条件，设计 §1 缺口 B）。
// 修复：按**真实生效轨道**分组；无 routing 的存量决策保持旧键（不丢样本、旧行禁删）。
// 优先级：P1 实验臂（exp_track/exp_arm）> 配置轨道（narrative on/off）> 旧键回退。
export function deriveQGroup(scenario_id, routing) {
  if (!scenario_id) return null;
  if (routing && routing.exp_arm && routing.exp_track) return `track:${routing.exp_track}:${routing.exp_arm}`;
  if (routing && Array.isArray(routing.tracks)) {
    return `track:narrative:${routing.tracks.includes('narrative') ? 'on' : 'off'}`;
  }
  return scenario_id; // 存量/未装配决策：保持既有行为，避免样本凭空消失
}

// 定时器：注册即预热（§11.4 C5）。预热 = 用现有决策 rubric 加权总分播种 Q 序列（skill 以 scenario_id 作代理）。
// 返回 { stop } 句柄；注册失败仅留痕，不阻断启动。
let _qSamplerTimer = null;
export function registerQSkillSampler({ intervalMs = 6 * 3600 * 1000 } = {}) {
  async function pass() {
    try {
      // LATERAL 取该决策**最新**一份快照的 routing（一决策可能多快照，避免 JOIN 放大导致重复采样）
      const r = await query(
        `SELECT d.scenario_id, d.decision_id, (d.rubric->>'weighted_total')::numeric AS q, s.routing
         FROM crm.decision d
         LEFT JOIN LATERAL (
           SELECT routing FROM crm.decision_context_snapshot
           WHERE decision_id = d.decision_id ORDER BY created_at DESC LIMIT 1
         ) s ON true
         WHERE d.rubric IS NOT NULL AND d.rubric ? 'weighted_total'`
      );
      for (const row of r.rows) {
        const q = Number(row.q);
        if (!Number.isFinite(q)) continue;
        const skill = deriveQGroup(row.scenario_id, row.routing);
        if (!skill) continue;
        await sampleQSkillT(row.scenario_id, skill, q, { decision_id: row.decision_id });
      }
      return { sampled: r.rows.length };
    } catch (e) {
      recordFailureSafe('q-skill-sampler-pass', e);
      return { sampled: 0, error: String(e?.message || e) };
    }
  }
  // 注册即预热（一次性，不等首个 interval）
  pass().catch(() => {});
  if (_qSamplerTimer) clearInterval(_qSamplerTimer);
  _qSamplerTimer = setInterval(() => pass().catch(() => {}), intervalMs);
  return {
    stop() { if (_qSamplerTimer) { clearInterval(_qSamplerTimer); _qSamplerTimer = null; } },
  };
}

// fail-safe 留痕（避免裸 catch 吞错，对齐项目静默吞错铁律）
function recordFailureSafe(tag, e) {
  try {
    const { recordFailure } = require('../monitor/monitorStore.js');
    recordFailure(tag, e);
  } catch { /* 监控不可用不阻断 */ }
}
