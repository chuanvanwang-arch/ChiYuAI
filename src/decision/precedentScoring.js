// src/decision/precedentScoring.js — C4 先例相似度：四分量加权 + 归一强校验 + 向量降级
// 设计：docs/2026-09-03-c2c3c4-decision-integrity-implementation.md T7
// 借鉴 Semantica find_precedents_hybrid 的「多分量加权 + 权重归一强校验」，
//   但**不照抄其向量 0.7 权重** —— 我们的向量是哈希签名（噪声），结构分量必须主导。
import { readConfig } from '../config/configStore.js';
import { emit } from '../events/bus.js';
// graphDepthOf 读 ctePrecedents —— 注意它读的是 **PG crm.decision_precedent_rel** 递归 CTE（ageGraph.js:233），
//   不依赖 AGE 图；故早期 `if (!isAvailable()) return null` 网关是错位的（AGE 关→恒 null，但 PG 数据在）。
//   2026-09-03 修复：移除 AGE 网关，直接读 PG 权威表；仅读异常才返回 null。
import { ctePrecedents } from './ageGraph.js';

export const DEFAULT_WEIGHTS = { jaccard: 0.4, category: 0.2, graphDepth: 0.2, vector: 0.2 };
export const DEFAULT_CONF = { minSimilarity: 0.45, candidatePool: 40, graphMaxDepth: 3 };
const COMPONENTS = ['jaccard', 'category', 'graphDepth', 'vector'];

function asArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

// 余弦相似度（向量分量用；provider='model' 时启用，默认 hash 退化为 null 不调用）
export function cosine(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

// ① 条件集合 Jaccard：conditions_evaluated = [{cond, met, weight, required}]
//    键含 met 三态（true/false/null），使「达标/未达标/未知」成为不同元素（禁假合并）
export function jaccardConditions(a = [], b = []) {
  const key = (c) => `${c?.cond}:${c?.met === true ? 1 : c?.met === false ? 0 : 'n'}`;
  const ka = new Set(asArray(a).map(key));
  const kb = new Set(asArray(b).map(key));
  if (!ka.size && !kb.size) return 0;
  let inter = 0;
  for (const k of ka) if (kb.has(k)) inter++;
  const uni = new Set([...ka, ...kb]).size;
  return uni ? inter / uni : 0;
}

// ② 类目匹配：scenario 一致（0.5）+ business_tier 一致（0.25）+ disposition 一致（0.25）
export function categoryMatch(cur = {}, cand = {}) {
  let s = 0;
  if (cur.scenario_id && cur.scenario_id === cand.scenario_id) s += 0.5;
  if (cur.business_tier && cur.business_tier === cand.business_tier) s += 0.25;
  if (cur.disposition && cur.disposition === cand.disposition) s += 0.25;
  return s;
}

// ③ 先例引用深度（替代 Semantica 的图中心性 —— ageGraph 无 centrality 接口）
//    语义：一个先例被后续决策引用得越多，它越是被反复验证过的权威先例。
//    读 PG crm.decision_precedent_rel（ctePrecedents，direction='downstream' = 有多少决策引用本先例）。
//    注意：返回 **0 表示「无后续引用」**（非 null）——null 仅保留给读异常；权重重分配只消化 null，
//      0 是「有图但深度为 0」的合法信号，应参与评分（区别于 AGE 不可用导致的恒 null 旧行为）。
export async function graphDepthOf(decision_id, { maxDepth = 3 } = {}) {
  try {
    const rows = await ctePrecedents(decision_id, { maxDepth, direction: 'downstream' });
    const n = Array.isArray(rows) ? rows.length : 0;
    return Math.min(n / Math.max(maxDepth, 1), 1);
  } catch (e) {
    emit('trace', 'precedent-graph-depth-failed', { decision_id, error: String(e?.message || e) });
    return null;
  }
}

// 权重归一强校验：不归一（含全 0 / 负值）→ 拒绝配置并回退出厂值 + 留痕
export function normalizeWeights(w = {}, { dropVector = false } = {}) {
  const base = { ...DEFAULT_WEIGHTS, ...(w || {}) };
  if (dropVector) base.vector = 0;
  const sum = COMPONENTS.reduce((s, k) => s + Math.max(0, Number(base[k] || 0)), 0);
  if (!(sum > 0)) {
    emit('trace', 'precedent-weights-invalid', { raw: w, dropVector, reason: '权重和非正' });
    return { weights: { jaccard: 0.5, category: 0.25, graphDepth: 0.25, vector: 0 }, degraded: true };
  }
  const out = {};
  for (const k of COMPONENTS) out[k] = Math.max(0, Number(base[k] || 0)) / sum;
  return { weights: out, degraded: dropVector };
}

// 合成：跳过不可用分量（null），按**实际使用权重**再归一，避免不可用分量稀释总分
export function similarityOf(parts = {}, weights = DEFAULT_WEIGHTS) {
  let total = 0, used = 0;
  for (const k of COMPONENTS) {
    const v = parts[k];
    if (v == null) continue;
    total += Number(v) * (weights[k] || 0);
    used += weights[k] || 0;
  }
  return used > 0 ? total / used : 0;
}

export async function loadPrecedentConf({ tenantId = 'system' } = {}) {
  const v = (await readConfig('precedent-conf', { tenantId }).catch(() => null))?.value || {};
  return {
    minSimilarity: Number(v.minSimilarity ?? DEFAULT_CONF.minSimilarity),
    candidatePool: Number(v.candidatePool ?? DEFAULT_CONF.candidatePool),
    graphMaxDepth: Number(v.graphMaxDepth ?? DEFAULT_CONF.graphMaxDepth),
    weights: v.weights || DEFAULT_WEIGHTS,
  };
}
