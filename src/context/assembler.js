// src/context/assembler.js — L1知识底座 / L2历史决策 / L3执行协同 / L4治理决策 装配 + 降级链
// 任一检索层失效 → 标记 missing + degraded，下层继续；agent 永不因检索崩
import { query } from '../db.js';
import { hashVector } from '../ontology/embedding.js';
import { loadProfile } from './roleProfiles.js';
import { actorRole, scopePredicateFor } from './scope.js';
import { retrieveMemory } from '../memory/memoryLog.js';
import { SEMANTIC_TAGS } from '../particles/particleModel.js';
import { DECISION_TIME_BASIS, retrieveTimeline, buildTimelineRows } from './timelineSource.js';
import { readConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';

const L1_TIMEOUT = 200;

// P0-② 租户级 Knowledge 注入（docs/2026-09-03-tenant-knowledge-design.md §6）
// scenario → kind 映射：出厂默认；config_store['knowledge-injection-map']（tenant 可覆盖）优先（禁散点硬编码）
export const SCENARIO_KNOWLEDGE_MAP = {
  QUOTE_PRICING: ['competitors', 'objections'],
  REVIEW_GATE: ['objections'],
  ICP_MATCH: ['icp'],
  WIN_RETRO: ['buyer_language', 'objections'],
  LOSE_RETRO: ['buyer_language', 'objections'],
  OUTBOUND: ['buyer_language'],
};

// 解析注入 kind：配置覆盖优先（tenant 自有或 system 回退），缺省回退全量四大类
export function resolveKnowledgeKinds(scenario, override = null) {
  if (override && typeof override === 'object' && Array.isArray(override[scenario])) {
    return override[scenario];
  }
  return SCENARIO_KNOWLEDGE_MAP[scenario] || ['icp', 'competitors', 'objections', 'buyer_language'];
}

// 注入行格式收敛：只透传 {kind, term, content}（token 友好，不携带完整 payload）
export function buildKnowledgeRows(rows) {
  return (rows || []).map((row) => {
    const p = row.payload || {};
    return { kind: p.kind, term: p.term, content: p.content };
  });
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('L1 timeout')), ms)),
  ]);
}

async function safeActorRole(actor) {
  try { return await actorRole({ actor }); } catch { return null; }
}

// ATTIO 实体画像投影（12 §7.3/§8 智能体承接）：按 semanticTag 投影结构化属性注入 L1
export function retrieveEntityProfile(particle) {
  if (!particle) return null;
  const payload = particle.payload || {};
  const profile = { firmographic: [], relation: {}, interaction: [] };
  for (const [tag, attrs] of Object.entries(SEMANTIC_TAGS)) {
    if (!['firmographic', 'relation', 'interaction'].includes(tag)) continue;
    if (tag === 'firmographic') {
      for (const a of attrs) if (payload[a] !== undefined) profile.firmographic.push(a);
    } else if (tag === 'interaction') {
      for (const a of attrs) if (payload[a] !== undefined) profile.interaction.push(a);
    } else {
      for (const a of attrs) if (payload[a] !== undefined) profile.relation[a] = payload[a];
    }
  }
  return profile;
}

async function retrieveL1(actor, q, profile = null) {
  if (!q) return [];
  const qvec = hashVector(q);
  const vecLit = `[${qvec.join(',')}]`; // PG vector 文本字面量（vector_in 不接受 JS 数组字符串传参）
  // P0① 注入前置 data_scope 裁剪：复用 scopePredicateFor（与列表谓词同源），非 all 模型时 SQL 追加谓词
  const sc = await scopePredicateFor(profile, actor).catch(() => ({ clause: '', params: [] }));
  const r = await query(
    `SELECT id, type, title, payload FROM crm.particles WHERE embedding IS NOT NULL${sc.clause} ORDER BY embedding <=> $1::vector LIMIT 5`,
    sc.params.length ? [...sc.params, vecLit] : [vecLit]
  );
  const rows = [...r.rows];
  // L1 精确归位兜底：查询含实体名（title/name 精确匹配）时，把命中实体并入 TOP5（向量距离远也能定位当前上下文实体）
  // 语义：L1 是知识底座，当前对话上下文实体必须可被找到（ATTIO T10 验收：刚建 ACCOUNT 通过 name 检索须返回）
  const names = q.split(/[\s,，、]+/).filter((w) => w.length >= 2);
  if (names.length) {
    const exact = await query(
      `SELECT id, type, title, payload FROM crm.particles
       WHERE (payload->>'name' = ANY($1) OR title = ANY($1)) AND embedding IS NOT NULL${sc.clause} LIMIT 3`,
      sc.params.length ? [...sc.params, names] : [names]
    );
    for (const row of exact.rows) {
      if (!rows.some((x) => x.id === row.id)) rows.push(row);
    }
  }
  return rows.map((row) => ({
    entity_id: row.id, entity_type: row.type, title: row.title, payload: row.payload,
    profile: retrieveEntityProfile(row),
  }));
}

// U1（2026-09-10）：新增第三参 tenantId。原实现 retrieveMemory 不传租户 → 恒读 system，
//   业务租户写的记忆（C1 修复后落本租户）在装配层一条都读不到 —— 写侧修完读侧仍空。
//   缺省 'system' 保持既有调用方（含 2 参 stub）行为不变。
async function retrieveL2(actor, intent, tenantId = 'system') {
  const scenario = intent?.scenario || null;
  // BG-08：决策时间基准统一为 COALESCE(decided_at, created_at)，与叙事时间线同源，杜绝排序漂移
  const r = await query(
    `SELECT decision_id, scenario_id, disposition, rationale FROM crm.decision
     WHERE ($1::text IS NULL OR scenario_id=$1) ORDER BY ${DECISION_TIME_BASIS} DESC LIMIT 5`,
    [scenario]
  );
  const m = await retrieveMemory({ topicLike: 'decision:%', limit: 5, tenantId }).catch(() => ({ rows: [] }));
  return { decisions: r.rows, memories: m.rows };
}

async function retrieveL3(actor) {
  const r = await query(
    `SELECT id, title, state FROM crm.tasks WHERE state IN ('ready','running') ORDER BY created_at DESC LIMIT 10`
  );
  const h = await query(`SELECT agent, health FROM crm.agent_health ORDER BY agent`);
  return { tasks: r.rows, agents: h.rows };
}

// ── L3 routing_brief（2026-09-05 P0，设计 §9）────────────────────────────────
// 目的：一线/智能体在执行协同层能回答「为什么这次没给我看历史时间线」——答案来自
//   routing_brief（可解释），而不是黑盒。只注 brief（约 6 字段），不注全量 scene_matrix，防 prompt 膨胀。
// 铁律：① 阈值配置化（trend_n 走 config_store['routing-explore']，出厂兜底 20）；
//       ② 禁裸 catch —— q_trend 查询失败留痕 emit('trace')，退化 null，绝不阻断装配。
const DEFAULT_TREND_N = 20;

export async function buildRoutingBrief(routing, scenarioId, { tenantId = 'system' } = {}) {
  if (!routing || !scenarioId) return null;
  const tracks = Array.isArray(routing.tracks) ? routing.tracks : null;
  // tracks 为 null = 路由解析失败回退全轨 → 与「含 narrative」同效（诚实标注）
  const narrativeInjected = tracks ? tracks.includes('narrative') : true;
  const group = narrativeInjected ? 'track:narrative:on' : 'track:narrative:off';

  let trendN = DEFAULT_TREND_N;
  try {
    const cfg = await readConfig('routing-explore', { tenantId });
    const n = Number(cfg?.value?.trend_n);
    if (Number.isFinite(n) && n > 0) trendN = Math.min(Math.trunc(n), 200); // 上限防误配拖垮装配
  } catch { /* 配置不可读 → 出厂兜底 DEFAULT_TREND_N */ }

  let q_trend = null;
  try {
    const r = await query(
      `SELECT quality_score FROM crm.decision_skill_quality
        WHERE scenario_id=$1 AND skill=$2 ORDER BY sampled_at DESC LIMIT $3`,
      [scenarioId, group, trendN]
    );
    const rows = r.rows || [];
    if (rows.length >= 1) {
      const qn = Number(rows[0].quality_score);                    // 窗口内最新
      const q0 = Number(rows[rows.length - 1].quality_score);      // 窗口内最早
      // 与 qSkillComposite（closureLoop.js:348）同口径：动态 import 避免 context↔decision 静态环
      const { Q_IMPROVE_EPSILON = 0.05 } = await import('../decision/closureLoop.js').catch(() => ({}));
      const ok = Number.isFinite(q0) && Number.isFinite(qn);
      q_trend = { q0: ok ? q0 : null, qn: ok ? qn : null, n: rows.length, improved: ok ? qn > q0 + Q_IMPROVE_EPSILON : false };
    }
  } catch (e) {
    emit('trace', 'routing-brief-trend-failed', { scenario_id: scenarioId, group, error: String(e?.message || e) });
    q_trend = null;
  }

  return {
    scene: routing.scene ?? scenarioId,
    mode: routing.mode ?? 'UNKNOWN',
    score: routing.score ?? 0,
    tracks,
    narrative_injected: narrativeInjected,
    // 实验期可解释：一线能回答「为什么这段时间轨道和平时不一样」
    experiment: routing.exp_arm ? {
      experiment_id: routing.exp_id ?? null,
      track: routing.exp_track ?? null,
      arm: routing.exp_arm,
      window_end: routing.exp_window_end ?? null,
    } : null,
    q_trend,
  };
}

// 2026-09-09 修复：按 tenant 隔离读取 business_tier_config（此前无 tenant 过滤 → 把全部租户的
//   tier 矩阵注入每个决策的 L4 上下文 = 跨租户上下文泄漏）。tenant 缺省 'system'。
async function retrieveL4(actor, tenant = 'system') {
  const role = await safeActorRole(actor);
  const cfgProfile = role ? await loadProfile(role.role_tag) : null;
  // A4（2026-09-16）：与判定面同一组过滤条件（撤回 / 到期的规则不参与）。
  // ⚠ 为什么这里**必须**过滤：L4 注入的是"模型据以判断的分级依据"。若撤回行仍注入，
  //   模型会看到"该项目=LEAD（低风险、可自主）"，而 computeBusinessTier 已按"无此规则"
  //   回退到 scenario.default_tier（可能 HIGH）→ 上下文依据与实际判定依据分裂：
  //   模型基于作废依据给理由，系统按新依据拦截，事后谁也无法解释这次决策。
  // ⚠ 本谓词与 decisionRepo.js 的 ACTIVE_TIER_WHERE 必须保持一致（分属 context / decision 两层，
  //   且一个在 SQL、一个在常量，无法共享实现）——由 test/tier-predicate-parity.test.js 静态锁死，
  //   改一处漏一处会立刻变红。
  const t = await query(
    `SELECT dimension, dimension_value, tier FROM crm.business_tier_config
      WHERE tenant_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [tenant]
  );
  return { profile: cfgProfile?.seven_elements || null, data_scope: cfgProfile?.data_scope || null, tiers: t.rows };
}

// P0-② 租户级 Knowledge 层（L-Knowledge）：按 intent.scenario → kind 过滤（按需注入，不全量）
// config_store['knowledge-injection-map'] 租户可覆盖映射；查询带 tenant_id 隔离；失败降级不阻断装配
// P0① 追加 scopePredicate：CRM_KNOWLEDGE 与 K 层同源，非 all 模型时按 owner/type 裁剪
async function retrieveL_Knowledge(actor, intent, profile = null) {
  const scenario = intent?.scenario || null;
  const cfg = await readConfig('knowledge-injection-map', { tenantId: intent?.tenantId || 'system' }).catch(() => null);
  const kinds = resolveKnowledgeKinds(scenario, cfg?.value || null);
  if (!kinds.length) return [];
  const sc = await scopePredicateFor(profile, actor).catch(() => ({ clause: '', params: [] }));
  const r = await query(
    `SELECT id, payload FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND tenant_id=$1 AND state='registered'
       AND payload->>'kind' = ANY($2::text[])${sc.clause}
     ORDER BY (payload->>'confidence')::float DESC NULLS LAST LIMIT 20`,
    sc.params.length ? [intent?.tenantId || 'system', kinds, ...sc.params] : [intent?.tenantId || 'system', kinds]
  );
  return buildKnowledgeRows(r.rows);
}

// J7 决策七轴之 WHEN 轴：叙事时间线（派生视图，只读四源聚合，非存储资产）
// 无实体作用域（intent 无 accountId/dealIds）时返回空而非降级——叙事是可选增强，不是必需层
// P0① 越界判定：非 all 模型且带实体作用域时，先判 target 是否在 data_scope 内，越界返回空（不标记 degraded，reason=scope-excluded）
async function retrieveNarrative(actor, intent = {}, profile = null) {
  const accountId = intent.accountId || intent.account_id || null;
  const dealIds = intent.dealIds || intent.deal_ids || [];
  const m = profile?.data_scope?.model || 'all';
  const hasScope = Array.isArray(dealIds) && dealIds.length > 0 || !!accountId;
  if (m !== 'all' && hasScope) {
    const scopeOk = await scopePredicateFor(profile, actor).catch(() => ({ ok: true }));
    if (scopeOk.ok === false) return [];
    // 目标粒子主人判定：accountId/dealIds 指向实体不在 actor 的 data_scope → 越界
    if (m === 'self' && accountId) {
      const r = await query(
        `SELECT payload->>'owner_id' AS owner_id FROM crm.particles WHERE (id::text=$1 OR slug=$1) LIMIT 1`,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const owner = r.rows[0]?.owner_id;
      if (owner && owner !== actor) return []; // 越界：owner != actor
    }
  }
  const sources = await retrieveTimeline({ accountId, dealIds });
  return buildTimelineRows(sources);
}

// 装配 L1→L4 + 叙事时间线（WHEN）+ 场景路由（故事线/图谱/结构化分轨）
// 任一层抛错降级不崩；叙事被路由排除 ≠ 缺失，不标记 degraded（可审计原因留痕）
// P0① 注入前置：profile 缺省 null（=all，保持现状）；显式传入时 L1/LK/NAR 按 data_scope 裁剪
export async function assembleContext({ actor, intent, query: q, tenantId = 'system', profile = null }, retrievers = {}) {
  // 租户化（T4，P1）：显式传租户（调用方从 ctx.tenantId 传入，缺省 system 保持既有行为）；
  //   兜底行：actor 若为对象形态取自身租户（字符串形态回退入参）。必须在 L4 调用前定义。
  const actorTenant = (actor && (actor.tenantId || actor.tenant_id)) || tenantId || 'system';
  const L1 = retrievers.L1 || ((a, qq) => retrieveL1(a, qq, profile));
  const L2 = retrievers.L2 || retrieveL2;
  const L3 = retrievers.L3 || retrieveL3;
  const L4 = retrievers.L4 || retrieveL4;
  const LK = retrievers.LK || ((a, intent2) => retrieveL_Knowledge(a, intent2, profile));
  const NAR = retrievers.narrative === false ? null : (retrievers.narrative || ((a, intent2) => retrieveNarrative(a, intent2, profile)));
  // 注入签名统一：retriever 若声明 3 参（actor, q, profile），则透传 profile；2 参兼容 stub
  const callL1 = async (a, qq) => (L1.length >= 3 ? L1(a, qq, profile) : L1(a, qq));
  const callLK = async (a, intent2) => (LK.length >= 3 ? LK(a, intent2, profile) : LK(a, intent2));
  const missing = {};
  const layers = {};
  try { layers.L1 = await withTimeout(callL1(actor, q), L1_TIMEOUT); } catch { missing.L1 = true; }
  try { layers.L2 = await L2(actor, intent, actorTenant); } catch { missing.L2 = true; }
  try { layers.L3 = await L3(actor); } catch { missing.L3 = true; }
  try { layers.L4 = await L4(actor, actorTenant); } catch { missing.L4 = true; }
  try { layers.LK = await callLK(actor, intent); } catch { missing.LK = true; }

  // 场景路由（融合设计 §2.5）：按 intent.scenario 选轨（读 config_store['context-routing']，缺省全轨）
  // tracks 决定叙事是否注入；L 轨道保留（层级检索始终执行）。路由信息回带 bundle.routing 供可观测。
  const scenarioId = intent?.scenario || null;
  let routing = { scene: scenarioId, tracks: null, L: null, mode: 'UNKNOWN', score: 0 };
  try {
    const { resolveTracks } = await import('./routing.js');
    routing = await resolveTracks(scenarioId, { tenantId: actorTenant });
  } catch { /* 路由加载失败 → 回退全轨（安全默认），不中断装配 */ }

  // P1 实验臂覆盖（2026-09-05）：只改内存 tracks，**绝不写 config_store**（红线 §0）。
  //   与 V2 主路径同口径接入，否则重演「两条装配路径行为分裂」的旧坑。
  let experiment = null;
  try {
    const { resolveActiveArm, applyExperimentArm } = await import('./routingExperiment.js');
    experiment = await resolveActiveArm(scenarioId, { tenantId: actorTenant });
    if (experiment && Array.isArray(routing.tracks)) {
      routing = {
        ...routing,
        tracks: applyExperimentArm(routing.tracks, experiment),
        exp_id: experiment.experiment_id, exp_arm: experiment.arm, exp_track: experiment.track,
        exp_window_end: experiment.window_end ?? null,
      };
    }
  } catch (e) {
    emit('trace', 'routing-experiment-arm-failed', { scenario_id: scenarioId, error: String(e?.message || e) });
    experiment = null; // fail-open：按配置原样继续
  }

  // 叙事时间线（WHEN 轴）：路由排除 / 失败 / 无作用域均不标记 degraded，但要留痕原因（可审计，非静默）
  const wantNarrative = !routing.tracks || routing.tracks.includes('narrative');
  let narrative = { rows: [], available: false, unavailable_reason: 'no-scope', source: 'events/tasks/decision/memory_log' };
  if (!wantNarrative) {
    narrative = { rows: [], available: false, unavailable_reason: 'routing-excluded', source: 'events/tasks/decision/memory_log' };
  } else if (NAR) {
    try {
      const rows = await NAR(actor, intent || {});
      // P0① 越界判定（非 all 模型 + 空返回）：target 不在 data_scope → scope-excluded（非 degraded）
      const m = profile?.data_scope?.model || 'all';
      const hasEntityScope = (intent?.accountId || intent?.account_id) || (Array.isArray(intent?.dealIds) && intent.dealIds.length > 0);
      narrative = {
        rows: Array.isArray(rows) ? rows : [],
        available: Array.isArray(rows) && rows.length > 0,
        unavailable_reason: ((Array.isArray(rows) && rows.length) || m === 'all' || !hasEntityScope) ? ((Array.isArray(rows) && rows.length) ? null : 'empty') : 'scope-excluded',
        source: 'events/tasks/decision/memory_log',
      };
    } catch (e) {
      narrative = { rows: [], available: false, unavailable_reason: 'error', error: String(e?.message || e), source: 'events/tasks/decision/memory_log' };
    }
  }

  // L3 扩展：routing_brief（可解释性）。挂在外层而非 retrieveL3 内部——复用已解析的 routing，
  // 避免重复读 config_store 且保证与叙事闸门**同口径**（两条路径分叉是 2026-09-05 修过的坑）。
  // fail-safe：brief 构建失败不影响其它层（禁裸 catch，留痕后继续）。
  try {
    if (layers.L3 && typeof layers.L3 === 'object') {
      layers.L3.routing_brief = await buildRoutingBrief(routing, scenarioId, { tenantId });
    }
  } catch (e) {
    emit('trace', 'routing-brief-failed', { scenario_id: scenarioId, error: String(e?.message || e) });
  }

  // P0①：profile 入参优先（调用方显式传入的上下文权限），否则回退角色画像（现状）
  const profileForScope = profile || (await safeActorRole(actor).then(async (role) => (role ? loadProfile(role.role_tag) : null)).catch(() => null));
  return {
    layers,
    narrative,
    routing,
    degraded: Object.keys(missing).length > 0,
    missing,
    scopeModel: profileForScope?.data_scope?.model || 'all',
  };
}
