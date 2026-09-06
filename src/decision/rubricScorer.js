// src/decision/rubricScorer.js
// 九尺子评分器（P1-B3）：8 项确定性 + 1 项 LLM（默认关）。
// 设计依据：docs/2026-09-02-cognitive-decision-unified-design.md §6（R3 裁定后 8+1）。
// 与 Lightfield C4 同构：8 项走代码判定，保证「同一决策重跑得分一致」，趋势与复合效应 Q(Skill,T) 才有意义。
//
// 评分尺度 0–4：0=缺失/无，1=弱，2=部分，3=良，4=充分。
// 降级纪律（§6.3）：无证据计 0 不假填充；LLM 不可用 degraded=true 不阻断、不静默；
//                 故事线空则广度/准确性 degraded，绝不假填充。
// 命名铁律（附录 B）：九尺子顺序固定为 1清晰 2准确 3精确 4相关性 5深度 6广度 7逻辑 8重要 9公平，禁用「关联性」。

const FUZZY_WORDS = ['大概', '可能', '也许', '或许', '应该', '估计', '约', '差不多', '基本上', '一般', '左右', '似乎'];
const OPP_STANCE = /(反|负面|反对|con|neg)/i;
// 「具体」判据：含数字 / 单位 / 时点之一
const SPECIFIC_RE = /[\d%￥$元个台套件天周月年季]/;

// 九尺子定义（顺序固定）。llm=true 表示该项允许 LLM 精评（仅 clarity）。
const RUBRICS = [
  { key: 'clarity', name: '清晰性', deps: ['intent', 'assumptions'], llm: true },
  { key: 'accuracy', name: '准确性', deps: ['assumptions'], llm: false },
  { key: 'precision', name: '精确性', deps: ['conditions_evaluated'], llm: false },
  { key: 'relevance', name: '相关性', deps: ['supply'], llm: false },
  { key: 'depth', name: '深度', deps: ['inference'], llm: false },
  { key: 'breadth', name: '广度', deps: ['viewpoints'], llm: false },
  { key: 'logic', name: '逻辑性', deps: ['inference'], llm: false },
  { key: 'importance', name: '重要性', deps: ['concept_refs'], llm: false },
  { key: 'fairness', name: '公平性', deps: ['viewpoints', 'assumptions'], llm: false },
];

const DEFAULT_CONFIG = {
  thresholds: { good: 0.75, warn: 0.5 },
  weights: {}, // per-key 覆盖，缺省 1.0
  focus: [], // 场景 focus 尺子键（× 1.5）
  llm: 'off', // 'off' | 'on'
};

function asArray(x) {
  return Array.isArray(x) ? x : [];
}
function hasFuzzy(text) {
  if (!text) return false;
  return FUZZY_WORDS.some((w) => String(text).includes(w));
}

// —— 各尺子确定性评分（返回 {score, degraded, evidence}） ——
async function scoreClarity(ctx, signals, cfg) {
  const q = (ctx?.intent?.question || '').trim();
  const aTexts = asArray(ctx?.assumptions).map((a) => (a?.text || '').trim());
  const hasQ = q.length > 0;
  const hasA = aTexts.some((t) => t.length > 0);
  if (!hasQ && !hasA) return { score: 0, degraded: false, evidence: { reason: '目的/问题/假设全空' } };
  const fuzzy = hasFuzzy(q) || aTexts.some((t) => hasFuzzy(t));
  if (fuzzy) {
    // 有模糊词：需 LLM 精评；llm 关则确定性代理 + degraded（不假填充）
    if (cfg.llm === 'on' && typeof signals.llmScorer === 'function') {
      const s = await signals.llmScorer('clarity', ctx);
      return { score: s, degraded: false, evidence: { fuzzy: true, scored_by: 'llm' } };
    }
    return { score: 2, degraded: true, evidence: { fuzzy: true, scored_by: 'proxy-llm-off' } };
  }
  return { score: 4, degraded: false, evidence: { question: hasQ, assumption: hasA } };
}

function scoreAccuracy(ctx, signals) {
  const assumptions = asArray(ctx?.assumptions);
  if (assumptions.length === 0) return { score: 0, degraded: false, evidence: { reason: '无假设' } };
  const totalRefs = assumptions.reduce((n, a) => n + asArray(a.evidence_ref).length, 0);
  if (totalRefs === 0) return { score: 0, degraded: false, evidence: { reason: '假设无 evidence_ref' } };
  if (!signals.storyAvailable) {
    return { score: 2, degraded: true, evidence: { story_empty: true, proxy: '有引用但故事线空' } };
  }
  const rate = signals.evidenceHits / totalRefs;
  return { score: rate >= 0.75 ? 4 : rate >= 0.5 ? 2 : 0, degraded: false, evidence: { hitRate: Number(rate.toFixed(2)) } };
}

function scorePrecision(ctx) {
  const conds = asArray(ctx?.conditions_evaluated);
  if (conds.length === 0) return { score: 0, degraded: false, evidence: { reason: '无 conditions_evaluated' } };
  const fuzzy = conds.some((c) => hasFuzzy(c?.value));
  if (fuzzy) return { score: 2, degraded: false, evidence: { fuzzy: true } };
  const specific = conds.every((c) => SPECIFIC_RE.test(String(c?.value ?? '')));
  return { score: specific ? 4 : 3, degraded: false, evidence: { specific } };
}

function scoreRelevance(ctx, signals) {
  // 【B4 归一 2026-09-02】：requiredDims 同支持「对象数组 [{dim,on_missing}]」形态（决策场景行实测形态）
  const req = new Set(asArray(signals.requiredDims).map((x) => (typeof x === 'string' ? x : x ? x.dim || x.key : null)).filter(Boolean));
  if (req.size === 0) return { score: 4, degraded: false, evidence: { no_required: true } };
  const sup = new Set(asArray(signals.suppliedDims).map((x) => (typeof x === 'string' ? x : x ? x.dim || x.key || null : null)).filter(Boolean));
  let hit = 0;
  req.forEach((d) => { if (sup.has(d)) hit += 1; });
  const rate = sup.size > 0 ? hit / req.size : 0;
  return { score: rate >= 1 ? 4 : rate >= 0.5 ? 2 : 0, degraded: false, evidence: { hit, required: req.size, supplied: sup.size, rate: Number(rate.toFixed(2)) } };
}

function scoreDepth(ctx) {
  const chain = asArray(ctx?.inference?.chain);
  const hasConclusion = !!ctx?.inference?.conclusion;
  if (chain.length >= 2 && hasConclusion) return { score: 4, degraded: false, evidence: { layers: chain.length } };
  if (chain.length === 1) return { score: 2, degraded: false, evidence: { layers: 1 } };
  return { score: 0, degraded: false, evidence: { reason: '无推论链' } };
}

function scoreBreadth(ctx, signals) {
  const vps = asArray(ctx?.viewpoints);
  const hasOpp = vps.some((v) => OPP_STANCE.test(v?.stance || ''));
  if (vps.length >= 3 && hasOpp) return { score: 4, degraded: false, evidence: { count: vps.length, hasOpp: true } };
  if (vps.length >= 2) {
    const deg = !signals.storyAvailable;
    return { score: 2, degraded: deg, evidence: { count: vps.length, hasOpp: false, degReason: deg ? 'story_empty' : null } };
  }
  return { score: 0, degraded: false, evidence: { count: vps.length } };
}

function scoreLogic(ctx, signals) {
  const chain = asArray(ctx?.inference?.chain);
  if (chain.length === 0) return { score: 0, degraded: false, evidence: { reason: '无推论链' } };
  const allLinked = chain.every((s) => s?.evidence != null && s?.via_assumption != null);
  const acyclic = signals.acyclic !== false;
  if (allLinked && acyclic) return { score: 4, degraded: false, evidence: {} };
  if (allLinked || acyclic) return { score: 2, degraded: false, evidence: { allLinked, acyclic } };
  return { score: 0, degraded: false, evidence: { allLinked, acyclic } };
}

function scoreImportance(ctx) {
  const refs = asArray(ctx?.concept_refs);
  if (refs.length === 0) return { score: 0, degraded: false, evidence: { reason: '无 concept_refs（34 行 methodology_dimension 未接）' } };
  let wSum = 0;
  let wHit = 0;
  refs.forEach((r) => {
    const w = Number(r?.weight || 1);
    wSum += w;
    if (r?.hit) wHit += w;
  });
  const rate = wSum > 0 ? wHit / wSum : 0;
  return { score: rate >= 1 ? 4 : rate >= 0.5 ? 2 : 0, degraded: false, evidence: { rate: Number(rate.toFixed(2)) } };
}

function scoreFairness(ctx, signals) {
  if (signals.negativePrecedentConsumed) return { score: 4, degraded: false, evidence: { consumed: true } };
  if (signals.negativePrecedentRetrieved) return { score: 2, degraded: false, evidence: { retrieved_not_consumed: true } };
  return {
    score: 0,
    degraded: !signals.storyAvailable,
    evidence: { reason: signals.storyAvailable ? '无反面先例' : 'story_empty_undetermined' },
  };
}

const SCORERS = {
  clarity: scoreClarity,
  accuracy: scoreAccuracy,
  precision: scorePrecision,
  relevance: scoreRelevance,
  depth: scoreDepth,
  breadth: scoreBreadth,
  logic: scoreLogic,
  importance: scoreImportance,
  fairness: scoreFairness,
};

/**
 * 对单条决策上下文做九尺子评分（确定性 + 可选 LLM）。
 * @param {object} ctx 决策八要素物化对象（intent/assumptions/conditions_evaluated/inference/viewpoints/concept_refs…）
 * @param {object} [opts]
 *   - thresholds {good,warn}  加权及格线
 *   - weights {key:number}    每尺子权重（缺省 1）
 *   - focus   [key]           场景聚焦尺子（×1.5）
 *   - enabled [key]           真子集白名单（非空时只跑列出的尺子，其余标记 skipped 不计入总分）；
 *                            缺省/空 = 跑全 9 尺子（向后兼容，测试默认路径不变）。形态同 focus，支持 [{key}]/字符串数组。
 *   - llm     'off'|'on'      清晰度是否走 LLM 精评
 *   - storyAvailable bool    故事线（memory/edges）是否有数据——准确性/广度/公平性降级判据
 *   - evidenceHits number     assumption.evidence_ref 命中故事线条数
 *   - requiredDims [] / suppliedDims []  相关性集合运算
 *   - negativePrecedentRetrieved / negativePrecedentConsumed bool  公平性
 *   - acyclic bool            推论依赖图无环（缺省 true）
 *   - llmScorer async(key,ctx)->number  仅 llm='on' 时用于 clarity
 * @returns {Promise<{scores,weighted_total,max_total,ratio,level,degraded,scored_at,llm_used}>}
 */
export async function scoreDecision(ctx, opts) {
  // 【B4 形态归一 2026-09-02】：decision_scenario 实测 required_dims=[{dim,on_missing}]、focus_rulers=[{key,weight}]
  //   均为「对象数组」形态，而评分器此前只认「字符串数组」→ 相关性恒 0 分、聚焦加权恒失效（见 E2E 实证）。
  //   此处统一归一为 key 集合，调用方（decisionRepo 等）零改动。thresholds 深合并，避免只传 {warn} 顶掉出厂 {good}。
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(opts || {}),
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(opts?.thresholds || {}) },
  };
  const toKey = (x) => (typeof x === 'string' ? x : x ? x.key || x.dim || null : null);
  const focusKeys = new Set((cfg.focus || []).map(toKey).filter(Boolean));
  // 【B 2026-09-04】真子集白名单：非空时只跑列出的尺子，其余标记 skipped 不计入 max_total/weighted_total。
  const enabledKeys = new Set((cfg.enabled || []).map(toKey).filter(Boolean));
  const signals = {
    storyAvailable: !!(opts && opts.storyAvailable),
    evidenceHits: (opts && opts.evidenceHits) || 0,
    negativePrecedentRetrieved: !!(opts && opts.negativePrecedentRetrieved),
    negativePrecedentConsumed: !!(opts && opts.negativePrecedentConsumed),
    requiredDims: (opts && opts.requiredDims) || [],
    suppliedDims: (opts && opts.suppliedDims) || [],
    acyclic: opts ? opts.acyclic !== false : true,
    llmScorer: opts && opts.llmScorer,
    focusKeys,
  };
  const scores = {};
  const degraded = [];
  for (const r of RUBRICS) {
    // 【B 2026-09-04】真子集白名单：不在 enabled 内的尺子标记 skipped 并跳过计分（不计入总分）。
    if (enabledKeys.size && !enabledKeys.has(r.key)) {
      scores[r.key] = { score: 0, name: r.name, max: 4, skipped: true, llm: r.llm };
      continue;
    }
    const res = await SCORERS[r.key](ctx, signals, cfg);
    scores[r.key] = { ...res, name: r.name, max: 4, llm: r.llm };
    if (res.degraded) degraded.push(r.key);
  }
  let wt = 0;
  let mt = 0;
  for (const r of RUBRICS) {
    if (scores[r.key].skipped) continue; // 真子集外尺子不计入总分（口径与计分循环一致）
    const w = Number(cfg.weights[r.key] || 1);
    // 【B4 归一 2026-09-02】聚焦加权改用归一后的 focusKeys 集合（支持 [{key,weight}] 对象数组形态）
    const mult = signals.focusKeys.has(r.key) ? 1.5 : 1.0; // §6.2 焦点加权 ≠ 豁免
    wt += scores[r.key].score * w * mult;
    mt += 4 * w * mult;
  }
  const ratio = mt > 0 ? wt / mt : 0;
  const level = ratio >= cfg.thresholds.good ? 'good' : ratio >= cfg.thresholds.warn ? 'warn' : 'poor';
  return {
    scores,
    weighted_total: Number(wt.toFixed(3)),
    max_total: mt,
    ratio: Number(ratio.toFixed(3)),
    level,
    degraded,
    // 【B7 补充】pass_line 落进 rubric 物化：selfcheck Q6（自检卡）判定「加权总分 ≥ 及格线」的同一事实源。
    //   默认与 loadRubricConfig 出厂一致；传入 thresholds.warn 时（decisionRepo 场景行 rubric_pass_line）以场景为准。
    pass_line: Number(cfg.thresholds.warn ?? 0.5),
    scored_at: new Date().toISOString(),
    llm_used: cfg.llm === 'on',
  };
}

/**
 * 持久化评分（P1-B3）：逐尺子 append 到 crm.decision_rubric_score，并更新 crm.decision.rubric jsonb。
 * 依赖 B1 迁移已应用（decision 9 列 + decision_rubric_score 表）。
 */
export async function persistRubric(pool, decisionId, rubric) {
  if (!pool || !decisionId) throw new Error('persistRubric: pool + decisionId required');
  const entries = Object.entries(rubric.scores);
  for (const [key, s] of entries) {
    await pool.query(
      `INSERT INTO crm.decision_rubric_score
        (decision_id, rubric_key, score, max_score, level, weight, evidence, scorer, degraded, scored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        decisionId, key, s.score, s.max || 4, rubric.level, 1.0,
        s.evidence ? JSON.stringify(s.evidence) : null,
        s.llm && rubric.llm_used ? 'llm' : 'rule',
        !!s.degraded, rubric.scored_at,
      ],
    );
  }
  await pool.query('UPDATE crm.decision SET rubric=$1 WHERE decision_id=$2', [JSON.stringify(rubric), decisionId]);
  return entries.length;
}

/**
 * 从 config_store 读取阈值/权重/LLM 开关（阈值配置化铁律，禁硬编码）。
 * 键：rubric-thresholds / rubric-weights / rubric-llm。缺键或解析失败回退出厂默认。
 */
export async function loadRubricConfig(pool) {
  const out = { ...DEFAULT_CONFIG };
  if (!pool) return out;
  const { rows } = await pool.query(
    "SELECT key, value FROM crm.config_store WHERE key = ANY($1)",
    [['rubric-thresholds', 'rubric-weights', 'rubric-llm']],
  );
  for (const r of rows) {
    try {
      const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      if (r.key === 'rubric-thresholds') out.thresholds = v;
      else if (r.key === 'rubric-weights') out.weights = v || {};
      else if (r.key === 'rubric-llm') out.llm = v === 'on' ? 'on' : 'off';
    } catch {
      /* 解析失败保留默认 */
    }
  }
  return out;
}

export { RUBRICS, FUZZY_WORDS, DEFAULT_CONFIG };
