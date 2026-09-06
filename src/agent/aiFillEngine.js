// src/agent/aiFillEngine.js — AI Fill 引擎（P5/T14，G2+V5）
// 治理铁律：本引擎只产出「建议草稿」（source='ai', enabled=false），绝不直写。
// 应用侧须经决策第0闸 mint decision_id → HITL 确认 → setMetaAttr 落库（零信任写闸，绝对禁 DELETE）。
import { resolvePrototype } from '../particles/particleModel.js';

// 确定性兜底抽取：无 LLM 时按已知字段名从原始上下文提取候选属性
function deterministicExtract(text) {
  const map = { 预算: 'budget', 目标: 'goal', 人数: 'headcount' };
  return Object.entries(map)
    .filter(([k]) => text.includes(k))
    .map(([k, slug]) => ({ slug, title: k, type: 'text' }));
}

/**
 * 提议 AI 填充草稿。
 * @param {object} arg
 * @param {string} arg.prototype 原型类型（如 TRAINING_CLIENT）
 * @param {string} arg.rawContext 原始上下文文本
 * @param {string} [arg.tenantId='system']
 * @param {object|null} [arg.llm] 可选 LLM 提取器（含 extractFields(rawContext, prototype)）
 * @returns {Promise<{draft:true, proposal:Array}>}
 */
export async function proposeAiFill({ prototype, rawContext, tenantId = 'system', llm = null }) {
  // 校验原型存在（代码基线或租户配置），不存在直接返回空草稿
  const def = await resolvePrototype(prototype, tenantId);
  if (!def) return { draft: true, proposal: [] };

  // 1) 解析原始上下文 → 候选属性（有 LLM 走 LLM，无则确定性兜底）
  const candidates = llm
    ? await llm.extractFields(rawContext, prototype)
    : deterministicExtract(rawContext || '');

  // 2) 对候选构造 meta_attr 草稿（source='ai', enabled=false），由决策第0闸+HITL 后落库
  const proposal = candidates.map((c) => ({
    particle_type: prototype,
    attr_slug: c.slug,
    title: c.title,
    attr_type: c.type || 'text',
    semantic_tag: 'ai-filled',
    source: 'ai',
    enabled: false,
    tenant_id: tenantId,
  }));

  return { draft: true, proposal };
}
