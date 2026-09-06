// src/metaAttr/metaAttrModel.js — 粒子属性元模型：类型推断/语义归类/seed 物化/自适应登记
// 设计输入：docs/2026-08-26-particle-attribute-model-ui-design.md §4/§7（19 类型纪律 + 写时自适应）
import { ATTRIBUTE_TYPE_SET, SEMANTIC_TAGS, semanticTagOf, PARTICLE_TYPES } from '../particles/particleModel.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;             // 中国大陆手机号（演示语义）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 值形态 → 19 类型推断（未命中返回 null，由调用方拒绝登记）
export function inferAttrType(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  // 数组：仅当元素全为标量（string/number/boolean/null）才可作 multi-select；嵌套数组/对象 → 未命中（拒绝登记）
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const scalar = value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
    return scalar ? 'multi-select' : null;
  }
  if (typeof value === 'object') return 'record-reference';
  const s = String(value);
  if (EMAIL_RE.test(s)) return 'email-address';
  if (PHONE_RE.test(s)) return 'phone-number';
  if (DATE_RE.test(s)) return 'date';
  if (/^\d+$/.test(s) && s.length <= 15) return 'number';   // 短数字字符串 → number
  return 'text';
}

// 语义桶归类：未命中 → legacy（particleModel.js:201-206 保守路线）
export function mapSemanticTag(attrSlug) {
  return semanticTagOf(attrSlug);
}

// seed 记录物化：coreAttributes（唯一事实源）→ meta_attr 行；类型不在 19 集抛错
export function recordFor(particleType, attrSlug, def) {
  const attrType = def.coreAttributes?.[attrSlug];
  if (!ATTRIBUTE_TYPE_SET.has(attrType)) {
    throw new Error(`粒子 ${particleType} 属性 ${attrSlug} 类型 ${attrType} 不在 19 类型集内`);
  }
  return {
    particle_type: particleType, attr_slug: attrSlug, title: attrSlug,
    attr_type: attrType, semantic_tag: mapSemanticTag(attrSlug),
    required: false, unique: false, description: null, options: null, source: 'manual',
    display: {}, validation: {}, permission: {}, enabled: true, version: 1, created_by: 'seed',
  };
}

// identity 兜底记录（种子完整性：所有定义 identity 的粒子注册主键属性为 baseline）
// enabled/required=true 使主键属性在运行时 modelFor 立即可见且必填；类型缺失时兜底 text
export function identityRecordFor(particleType, attrSlug) {
  const def = PARTICLE_TYPES[particleType] || {};
  const coreType = def.coreAttributes?.[attrSlug];
  const attrType = (coreType && ATTRIBUTE_TYPE_SET.has(coreType)) ? coreType : 'text';
  return {
    particle_type: particleType, attr_slug: attrSlug, title: attrSlug,
    attr_type: attrType, semantic_tag: mapSemanticTag(attrSlug),
    required: true, unique: false, description: null, options: null, source: 'manual',
    display: {}, validation: {}, permission: {}, enabled: true, version: 1, created_by: 'seed',
  };
}

// 自适应登记记录（写时钩子消费）：新键 → 推断类型 → 未命中 19 集返回 null（拒绝登记）
export function adaptiveRecordFor(particleType, attrSlug, value, actor) {
  const attrType = inferAttrType(value);
  if (!attrType || !ATTRIBUTE_TYPE_SET.has(attrType)) return null;
  return {
    particle_type: particleType, attr_slug: attrSlug, title: attrSlug,
    attr_type: attrType, semantic_tag: mapSemanticTag(attrSlug),
    required: false, unique: false, description: null, options: null, source: 'ai',
    display: {}, validation: {}, permission: {}, enabled: false, version: 1, created_by: actor || 'system',
  };
}

// 运行时模型视图：仅 enabled 属性（渲染器/查询只用启用集）
export function modelFor(particleType, rows) {
  return rows
    .filter((r) => r.enabled)
    .map(({ attr_slug, attr_type, semantic_tag }) => ({ attr_slug, attr_type, semantic_tag }));
}