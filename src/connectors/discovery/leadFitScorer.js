// src/connectors/discovery/leadFitScorer.js — lead-fit 双维评分器
//   （设计 docs/2026-09-10-lead-discovery-design.md §5 数据模型的落地实现）
//
// 立论：设计 §5 规定 CRM_ACCOUNT.payload.discovery 须含 icp_fit_score / intent_score
//   （各带 capability 轴 judge + rule_ref）。但截至 2026-09-16，生产写入的是**硬编码占位 0.5**
//   （discoveryOrchestrator.js:91「初值占位」）。本文件是该占位的真实实现。
//
// ⚠ 边界①（**最关键，勿混用**）：lead-fit 的 "ruler" = **线索判定规则**
//   （industry / hiring_icp_role / funding_round / tender_match …），权重表 = discovery-rules.signals。
//   而九尺子（src/decision/rubricScorer.js）的 ruler = **决策叙述质量**
//   （clarity/accuracy/precision/relevance/depth/breadth/logic/importance/fairness）。
//   二者**同名异物**：rubricScorer **不可**用于 lead-fit —— 会把「叙述写得好」当成「客户意向高」。
//
// ⚠ 边界②（第二关键）：discovery 域信号键为**全称**
//   （funding_round/hiring_icp_role/tender_match/leadership_change/tech_adopt/website_redesign/social_content），
//   prospecting 域为**简写**（hiring/funding/tender/social）。
//   ⇒ **不得**把 discovery signals 喂给 prospectingRules.computeFitScore —— 键不匹配会**全部未命中**
//      → 恒返回 0 的**静默错值**。本文件只复用其**纯函数**（signalFreshness），评分循环按 discovery 权重表自建。
//
// 铁律：
//   ① 纯函数、零 IO、零 DB、不新增粒子、禁 DELETE（本模块无写操作）
//   ② 权重/阈值 100% 来自 rules（config_store['discovery-rules']），禁硬编码
//   ③ 无证据不假填充：缺字段 → 该项计 0 + degraded 标记，绝不编造分值
//   ④ 不做时间衰减默认值兜底推理：无 ts / 空档 → 1.0（与 signalFreshness 向后兼容语义一致）
import { freshnessMultiplier, ageDaysOf } from '../../config/signalFreshness.js';

// 设计 §5 的 rule_ref 契约（禁改字符串：glass-box 与 UI 依赖它定位"为何此刻判定为目标客户"）
export const LEAD_FIT_FIT_RULE = 'scenario:lead-fit#ruler:industry';
export const LEAD_FIT_INTENT_RULE = 'scenario:lead-fit#ruler:hiring_icp_role';

// 取信号时间戳：优先信号自带 ts → 键名映射字段 → rules.signal_time_fields 配置
function tsOf(sig, key, rules) {
  if (sig && typeof sig === 'object') {
    if (sig.ts) return sig.ts;
    if (sig[`${key}_ts`]) return sig[`${key}_ts`];
    const map = (rules && rules.signal_time_fields) || {};
    if (map[key] && sig[map[key]]) return sig[map[key]];
  }
  return null;
}

// 权重归一：允许 {weight:n} 或直接 n 两种形状（出厂=对象，租户覆盖可能给数字）
function weightOf(cfg) {
  const w = typeof cfg === 'number' ? cfg : (cfg && cfg.weight);
  return typeof w === 'number' ? w : null;
}

/**
 * intent_score：Σ(命中信号 × 权重 × 时间衰减) / Σ权重
 *   - 命中判定 = signals[].type 出现在权重表中；未命中按 0 计（但**分母仍计入**，设计 §5 语义）
 *   - 同类型多次出现**不叠加**（首次命中为准）
 *   - 时间衰减：rules.signal_age_tiers（空档 → 1.0，向后兼容）
 * @returns {{value:number, numerator:number, denominator:number, breakdown:Array, degraded:boolean}}
 */
export function computeIntentScore(signals = [], rules = {}, now = Date.now()) {
  const weights = (rules && rules.signals) || {};
  const tiers = (rules && rules.signal_age_tiers) || [];
  const list = Array.isArray(signals) ? signals : [];

  // 首次命中为准
  const hit = new Map();
  for (const s of list) {
    const key = typeof s === 'string' ? s : (s && s.type);
    if (key && !hit.has(key)) hit.set(key, s);
  }

  let num = 0; let den = 0; const breakdown = [];
  for (const [key, cfg] of Object.entries(weights)) {
    const weight = weightOf(cfg);
    if (weight === null) continue;              // 非数值权重：跳过（不计入分母，避免污染归一）
    den += weight;
    if (!hit.has(key)) {
      breakdown.push({ key, weight, hit: false, mult: 0, contribution: 0 });
      continue;
    }
    const mult = tiers.length ? freshnessMultiplier(ageDaysOf(tsOf(hit.get(key), key, rules), now), tiers) : 1.0;
    const contribution = weight * mult;
    num += contribution;
    breakdown.push({ key, weight, hit: true, mult, contribution });
  }

  return {
    value: den > 0 ? Number((num / den).toFixed(4)) : 0,
    numerator: Number(num.toFixed(4)),
    denominator: Number(den.toFixed(4)),
    breakdown,
    degraded: den === 0,                        // 无权重表 ⇒ 无法评分（显式降级，不返 0.5）
  };
}

// 富化值解包：{value, provider, ts} → value；裸值原样返回
function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

/**
 * icp_fit_score：ICP 三维匹配（行业 / 规模 / 地域），命中率 = 命中维数 / **可判定**维数
 *   - 字段来源：payload.enrichment.* （优先）→ payload.* （兼容顶层裸字段）
 *   - 缺维不计入分母，但标 degraded（**不把"未知"当"未命中"** —— 二者语义不同）
 *   - ⚠ rules.icp.min_confidence **本批次不消费**：其语义在全仓无定义（docs/src 零命中），
 *     且富化值形状无 confidence 字段。登记待定义（见计划 §4），不猜测实现。
 * @returns {{value:number, checks:Array, degraded:boolean, unjudged:string[]}}
 */
export function computeIcpFit(account = {}, rules = {}) {
  const icp = (rules && rules.icp) || {};
  const payload = (account && account.payload) || account || {};
  const enrich = (payload && payload.enrichment) || {};
  const get = (k) => unwrap(payload[k] !== undefined ? payload[k] : enrich[k]);

  const checks = [];
  const industries = Array.isArray(icp.industries) ? icp.industries : [];
  if (industries.length) {
    const actual = get('industry');
    checks.push({
      dim: 'industry', expect: industries, actual: actual ?? null,
      ok: actual == null || actual === '' ? null : industries.includes(String(actual)),
    });
  }
  const minHc = Number(icp.min_headcount);
  if (Number.isFinite(minHc)) {
    const actual = get('headcount');
    checks.push({
      dim: 'headcount', expect: `>=${minHc}`, actual: actual ?? null,
      ok: actual == null ? null : Number(actual) >= minHc,
    });
  }
  const geo = Array.isArray(icp.geo) ? icp.geo : [];
  if (geo.length) {
    const actual = get('country') ?? get('region');
    checks.push({
      dim: 'geo', expect: geo, actual: actual ?? null,
      ok: actual == null || actual === '' ? null : geo.includes(String(actual)),
    });
  }

  const judged = checks.filter((c) => c.ok !== null);
  const hitCount = judged.filter((c) => c.ok).length;
  return {
    value: judged.length ? Number((hitCount / judged.length).toFixed(4)) : 0,
    checks,
    degraded: judged.length === 0 || judged.length < checks.length,
    unjudged: checks.filter((c) => c.ok === null).map((c) => c.dim),
  };
}

/**
 * 统一入口：一次算出双维（供 discoveryOrchestrator 与 monitorCtx 共用，保证两条路径**同源**）
 * @returns {{icp_fit:number, intent:number, ruleRefs:{fit:string,intent:string},
 *            breakdown:{icp:Array,intent:Array}, degraded:{icp:boolean,intent:boolean}}}
 */
export function scoreLeadFit({ account = {}, signals = [], rules = {}, now = Date.now() } = {}) {
  const intent = computeIntentScore(signals, rules, now);
  const icp = computeIcpFit(account, rules);
  return {
    icp_fit: icp.value,
    intent: intent.value,
    ruleRefs: { fit: LEAD_FIT_FIT_RULE, intent: LEAD_FIT_INTENT_RULE },
    breakdown: { icp: icp.checks, intent: intent.breakdown },
    degraded: { icp: icp.degraded, intent: intent.degraded },
  };
}
