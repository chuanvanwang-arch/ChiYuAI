// src/particles/normalizeFacts.js — 6.6 SHACL-equivalent 写时校验
// 契约：C-DAI 决策问责闭环（测试计划 §5.7 + dev-plan Task 8）
// 职责：normalizeFacts(fact, metaAttrRows) 类型归一化 + required 缺失/类型不符抛 ValidationError；
//       particleRepo 写前调用，拦截脏事实（防误触发 G2 规则门）。
// 纪律：不静默修正——required 缺失/类型不符一律抛错；合法值才归一化返回。
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// attr_type 集合（对齐 schema.sql:329-331 meta_attr 枚举）
const NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'rating']);
const DATE_TYPES = new Set(['date', 'timestamp']);

function toNumber(v, attrSlug) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw new ValidationError(`属性 ${attrSlug} 类型不符：期望 number，得到 ${JSON.stringify(v)}`);
  return n;
}

function toDate(v, attrSlug) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    throw new ValidationError(`属性 ${attrSlug} 类型不符：期望 date，得到 ${JSON.stringify(v)}`);
  }
  return s.slice(0, 10);
}

function toStringValue(v) {
  if (v === null || v === undefined) return v;
  return typeof v === 'string' ? v : String(v);
}

function normalizeScalar(attrSlug, attrType, raw) {
  if (raw === null || raw === undefined) return raw;
  if (NUMERIC_TYPES.has(attrType)) return toNumber(raw, attrSlug);
  if (DATE_TYPES.has(attrType)) return toDate(raw, attrSlug);
  if (attrType === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1' || raw === 1) return true;
    if (raw === 'false' || raw === '0' || raw === 0) return false;
    throw new ValidationError(`属性 ${attrSlug} 类型不符：期望 boolean，得到 ${JSON.stringify(raw)}`);
  }
  return toStringValue(raw); // text/select/multi-select/url/email/phone/domain 等
}

// 数组值：逐元素归一并**保持数组**。
// 背景（2026-09-02 真实缺陷）：原实现直接走 toStringValue → String(['x.com','x.cn']) 变成
//   "x.com,x.cn" 字符串，把多值字段压成单值。后果：CRM_ACCOUNT.domains（业务天然多域名）写入后
//   payload 不再是 JSON 数组，而 ontology/hooks.js:70-80 的身份解析用 jsonb_array_elements_text
//   做元素级匹配（含"子域后缀"语义）→ 匹配全部落空 → CONTACT 建不出 auto_weak 边。
//   该缺陷此前被 test/meta-attr-schema.test.js 的 `TRUNCATE crm.meta_attr CASCADE` 掩盖：
//   全表清空后 domains 退化为自适应登记的 multi-select 且 enabled=false（跳过归一）→ 假绿。
function normalizeValue(attrSlug, attrType, raw) {
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) return raw.map((v) => normalizeScalar(attrSlug, attrType, v));
  return normalizeScalar(attrSlug, attrType, raw);
}

// 主入口：fact（待写 payload）与 meta_attr 行（particle_type 对应）比对
export function normalizeFacts(fact = {}, metaAttrRows = []) {
  const out = { ...fact };
  if (!Array.isArray(metaAttrRows) || metaAttrRows.length === 0) return out; // 无元模型约束则透传（兼容未登记粒子）
  for (const m of metaAttrRows) {
    const slug = m.attr_slug || m.attrSlug;
    const isRequired = m.required === true;
    const has = out[slug] !== undefined && out[slug] !== null && out[slug] !== '';
    if (isRequired && !has) {
      throw new ValidationError(`required 属性缺失: ${slug}`);
    }
    // 仅 enabled 且在 fact 中出现的属性做类型归一化/校验
    if (m.enabled !== false && has) {
      out[slug] = normalizeValue(slug, m.attr_type || m.attrType, out[slug]);
    }
  }
  return out;
}