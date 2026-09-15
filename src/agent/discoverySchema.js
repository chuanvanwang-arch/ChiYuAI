// src/agent/discoverySchema.js — 线索发现 payload 组装（P0#1：AI 属性 2D + glass-box why_narrative）
// 设计：docs/2026-09-10-lead-discovery-design.md §5（数据模型 2D）+ §4（C2 glass-box 推理链）
// 铁律：纯函数、零副作用、不触 DB、不新增粒子；无行业/租户字面量。
// 复用点：Task 7 orchestrator（import './discoverySchema.js'）、Task 15 glassBox、Task 16 monitorAccount。
import { buildGlassBox } from './glassBox.js';

// 知识资产分层（与 src/agent/agents.js:19 KG_LAYER_ORDER 同口径）
export const LAYERS = ['L1', 'L2', 'L3', 'L4'];

// 「本体同步」来源的 provider：其数据由 src/ontology/hooks.js:39 ontologySync 写时入图，
//   故 source 轴记 'ontologySync'（非 'provider_adapter'）。attio 为例（设计 §5 示例逐字）。
export const ONTOLOGY_SYNC_PROVIDERS = ['attio', 'ontologySync', 'native'];

const sourceOf = (v) => v.source || (ONTOLOGY_SYNC_PROVIDERS.includes(v.provider) ? 'ontologySync' : 'provider_adapter');

// 富集字段 2D：来源轴（provider / confidence / ts）+ 能力轴（layer / source）
export function buildEnrichmentPayload(fields, { ts } = {}) {
  const now = ts || new Date().toISOString();
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const layer = v.layer || 'L2';
    // 非法 layer 显式抛错：layer 决定 L1–L4 检索语义，静默改写 = 假绿
    if (!LAYERS.includes(layer)) throw new TypeError(`invalid layer: ${layer} (expected ${LAYERS.join('/')})`);
    out[k] = { ...v, ts: v.ts || now, layer, source: sourceOf(v) };
  }
  return out;
}

// 发现评分 2D：value（来源轴）+ judge（能力轴 axis/rule_ref/j_score）+ trace（glass-box 推理链）。
// ruleRef 可覆盖（scenario/ruler 由 decision_scenario 侧配置驱动，C1）。
export function buildDiscoveryPayload(fit, intent, signals, decisionId, { ruleRef = {} } = {}) {
  const refFit = ruleRef.fit || 'scenario:lead-fit#ruler:industry';
  const refIntent = ruleRef.intent || 'scenario:lead-fit#ruler:hiring_icp_role'; // 与信号类型名 / claygent RULE_REF 对齐
  const list = Array.isArray(signals) ? signals : [];
  const fitGb = buildGlassBox({ score: fit, ruleRef: refFit, signals: list });
  const intentGb = buildGlassBox({ score: intent, ruleRef: refIntent, signals: list });
  return {
    icp_fit_score: { value: fit, judge: fitGb.judge, trace: fitGb.trace },
    intent_score: { value: intent, judge: intentGb.judge, trace: intentGb.trace },
    signals: list,
    why_narrative: `${fitGb.why_narrative}；decision_id=${decisionId}`,
  };
}

// 上下文注入体积闸（契约来源：ai-context-layering KNOWLEDGE_CONTEXT_BYTE_LIMIT=64KB；
//   超限标 truncated 并计入 degradedLayers 供监控消费；发现结论走 L2 通道 → 降级层为 L2）
export const KNOWLEDGE_CONTEXT_BYTE_LIMIT = 64 * 1024;

// 纯函数：超限则按「字符串字段长度降序」裁剪，直到 ≤ limitBytes。
//   硬约束：summary 必须保留非空（否则 injector.memoryText 读不出 → 写读双向落空）；
//           account_id 原样保留（C2 锚点依赖）；不超限则原样返回且 truncated:false（零副作用）。
export function enforceContextByteLimit(payload, { limitBytes = KNOWLEDGE_CONTEXT_BYTE_LIMIT } = {}) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const size = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
  if (size(src) <= limitBytes) return { ...src, truncated: false };
  const out = { ...src };
  const PROTECTED = new Set(['summary', 'account_id', 'tenant_id', 'deal_id']);
  // ① 字符串字段按长度降序裁剪（最大冗余源）
  const order = Object.keys(out)
    .filter((k) => !PROTECTED.has(k) && typeof out[k] === 'string')
    .sort((a, b) => out[b].length - out[a].length);
  for (const k of order) {
    if (size(out) <= limitBytes) break;
    const over = size(out) - limitBytes;
    const keep = Math.max(0, out[k].length - over - 64); // 每次多留 64 字节余量
    out[k] = out[k].slice(0, keep);
  }
  // ② 兜底：仍有数组/对象级大字段（如 evidence 富集块）→ 按体积降序置空（JSON 序列化自动略过）
  //   不置空则「标了 truncated 却仍超限」= 假闸；置空是内存对象裁剪，非 DB 删除。
  if (size(out) > limitBytes) {
    const bigs = Object.keys(out)
      .filter((k) => !PROTECTED.has(k))
      .map((k) => [k, size(out[k] ?? null)])
      .sort((a, b) => b[1] - a[1]);
    for (const [k] of bigs) {
      if (size(out) <= limitBytes) break;
      out[k] = undefined;
    }
  }
  // ③ 极端兜底：summary 自身超限 → 剪到刚好能过闸的最小值（仍非空）
  if (size(out) > limitBytes) {
    const overhead = size({ ...out, summary: '' });
    out.summary = String(out.summary || '').slice(0, Math.max(1, limitBytes - overhead - 32));
  }
  if (!out.summary) out.summary = '（线索发现结论：内容超限已裁剪）';
  const result = { ...out, truncated: true, degradedLayers: ['L2'] };
  // ④ 最终硬保证：尾字段 truncated/degradedLayers 也要计入预算（否则标了闸却仍超限 = 假绿）
  if (size(result) > limitBytes) {
    const overflow = size(result) - limitBytes;
    result.summary = String(result.summary).slice(0, Math.max(1, result.summary.length - overflow - 16));
  }
  return result;
}
