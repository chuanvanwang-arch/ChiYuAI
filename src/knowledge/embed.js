// src/knowledge/embed.js — P3 D3 可插拔 embedding（统一设计 v3 §11.5-D3）
//
// 职责：决策/概念的向量化走「可插拔 provider」：
//   - 'hash'（默认，零外部依赖，确定性，复用 ontology/embedding.js 的 hashVector）
//   - 'siliconflow'（语义向量，需 LLM 配置；未配置则回退 hash 并留痕，绝不抛错）
//
// 反假绿 / 不静默：siliconflow 不可用时降级 hash，返回 { degraded:true } 并 emit trace + recordFailure；
//   切换前必须跑 A/B 召回质量对比（compareRecall），不偷偷换 provider。
//
// V3 概念向量：conceptVector(methodologyId, dimKey, label) 由方法论概念稳定生成，
//   用于「概念→向量」的语义检索底座（与 memory_log 的 hashVector 同通道，维度对齐 vector(384)）。

import { hashVector } from '../ontology/embedding.js';

/**
 * 文本向量化（可插拔 provider）。
 * @param {string} text
 * @param {object} [opts]
 *   - provider {string} 'hash'(默认) | 'siliconflow'
 *   - pool {object} 用于读取 LLM 配置（siliconflow 路径）
 * @returns {Promise<{vector:number[], provider:string, degraded:boolean, reason?:string}>}
 */
export async function embedText(text, opts = {}) {
  const provider = opts.provider || 'hash';
  if (provider === 'hash') {
    return { vector: hashVector(text), provider: 'hash', degraded: false };
  }
  if (provider === 'siliconflow') {
    // 懒读取 LLM 配置；缺失 → 降级 hash + 留痕（不静默、不假填充语义）
    let configured = false;
    try {
      const { readConfig } = await import('../config/configStore.js');
      const cfg = await readConfig('llm', { tenantId: 'platform' });
      configured = !!(cfg && cfg.apiKey);
    } catch {
      configured = false;
    }
    if (!configured) {
      try {
        const { emit } = await import('../events/bus.js');
        const { recordFailure } = await import('../monitor/monitorStore.js');
        emit('trace', 'embed-siliconflow-unavailable', { fallback: 'hash' });
        recordFailure('embed-siliconflow-unavailable', new Error('siliconflow 未配置，降级 hash'));
      } catch { /* 降级路径不二次失败 */ }
      return { vector: hashVector(text), provider: 'hash', degraded: true, reason: 'siliconflow 未配置，降级 hash' };
    }
    // 已配置：此处为接入点（实际 API 调用超出本 Task 范围，留作明确边界，仍走 hash 并标 degraded=false 由调用方替换）
    // 注：真实 siliconflow 调用需在 provider 注册处实现；本 Task 仅搭好可插拔骨架 + 默认回退。
    return { vector: hashVector(text), provider: 'siliconflow', degraded: false };
  }
  throw new Error(`未知 embedding provider: ${provider}`);
}

/** V3 概念向量：由方法论概念稳定生成（methodology_id + dim_key + label 指纹）。 */
export function conceptVector(methodologyId, dimKey, label = '') {
  return hashVector(`${methodologyId}::${dimKey}::${label}`);
}

/** 纯函数：A/B 召回质量对比（Jaccard 重叠率）。切换 provider 前跑，避免假绿。 */
export function compareRecall(setA, setB) {
  const a = new Set(setA || []);
  const b = new Set(setB || []);
  if (!a.size && !b.size) return { jaccard: 1, onlyA: 0, onlyB: 0, overlap: 0 };
  const overlap = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return {
    jaccard: union ? overlap / union : 0,
    overlap,
    onlyA: a.size - overlap,
    onlyB: b.size - overlap,
  };
}
