// src/ontology/vocabulary.js — 枚举型/业务专有名词写时登记（进 L1 图种子）
// 12 设计 §7.2：按 semanticTag 自动覆盖（不再硬编码老 6 字段）
import { createParticle } from '../particles/particleRepo.js';
import { SEMANTIC_TAGS } from '../particles/particleModel.js';

// 量纲枚举字段（大小关系可参与条件比较：employee_range/estimated_arr_usd）
export const ORDERED_ENUM_HINTS = ['employee_range', 'estimated_arr_usd'];

// firmographic 组中的 select/枚举字段 → 应自动登记词汇（categories/employee_range/estimated_arr_usd 在此覆盖）
export function enumHintFields() {
  const firmographicSelects = SEMANTIC_TAGS.firmographic.filter((f) => f !== 'domains'); // domains 走身份解析不走词汇
  return [...new Set(['industry', 'region', 'stage', 'source', 'category', 'type', ...firmographicSelects])];
}

// 量纲枚举：登记为有序枚举（保留大小关系，供语义比较如 "ARR > 阈值"）
export function orderedEnumHintFields() {
  return ORDERED_ENUM_HINTS;
}

// 写时登记：粒子 payload 中的枚举/业务名词 → CRM_KNOWLEDGE（fail-open，登记失败不阻断业务写）
export async function registerVocabulary(entity, tenantId = 'system') {
  const payload = entity.payload || {};
  for (const f of enumHintFields()) {
    const val = payload[f];
    if (!val || typeof val !== 'string') continue;
    const exists = await findKnowledge(val);
    if (exists) continue;
    const kind = orderedEnumHintFields().includes(f) ? 'ordered-enum' : '业务术语';
    await createParticle('CRM_KNOWLEDGE', { term: val, type: kind, layer: 'L1' }, { tenantId })
      .catch(() => null);
  }
}

async function findKnowledge(term) {
  const { query } = await import('../db.js');
  const r = await query(
    `SELECT id FROM particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'=$1 LIMIT 1`,
    [term]
  );
  return r.rows[0] || null;
}
