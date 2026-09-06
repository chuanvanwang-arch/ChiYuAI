// src/http/particleDetailRouter.js — 粒子详情受控 Schema 组装（S13 面；蓝图 §3 S13）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 8 + 蓝图 §3 S13
// 契约：buildParticleDetailSchema(detail) → 受控 detail 型 schema
//   · detail = buildParticleDetail(particle, outEdges, related) 输出（既有端点已提供）
//   · 组件：attr-field×N（每属性带 data_origin 四查徽标）+ subtable（关联实体/出边）
//   · 四查：attr.data_origin 按 sourceClassify 语义取 ①/②/③/④（sourcedFrom 出边 → external）
//   · 渲染：复用 src/page/renderer.js（唯一渲染出口，schema 校验 + 四态的完整链路）
import { buildParticleDetail } from './particleDetail.js';
import { validatePageSchema } from '../page/validator.js';

// 粒子 payload 字段 → attr-field 组件（带来源徽标）
function toAttrFields(particle) {
  const payload = particle?.payload || {};
  const entries = Object.entries(payload)
    .filter(([slug]) => !['events', 'ai'].includes(slug) && !slug.startsWith('ai.'))
    .map(([slug, value]) => {
      const ext = (particle.outEdges || []).find((e) => e.edgeType === 'sourcedFrom');
      const attr = {
        slug,
        value,
        data_origin: ext ? 'external' : (value && typeof value === 'object' && value.confidence !== undefined ? 'ai' : (slug.includes('_at') || slug.includes('history') ? 'rule' : 'manual')),
      };
      if (ext) attr.sourcedFrom = ext.meta || {};
      if (slug.includes('_at') || slug.includes('history')) attr.rule = true;
      return { kind: 'attr-field', attrSlug: slug, attrType: inferType(value), label: slug, attr };
    });
  // 空 payload 占位：validator 要求 components 至少 1 个（语义「无属性可展示」）
  if (!entries.length) {
    return [{
      kind: 'metric-card', title: '无属性', dataBinding: { source: 'particle', particleType: particle?.type || 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '计数' }] },
    }];
  }
  return entries;
}

// 值 → ATTR_FIELD_TYPES 推断（19 类型集子集；页面只显示已知类型，未知 fallback text）
function inferType(v) {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return 'timestamp';
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(v)) return 'email-address';
    if (/^\+?\d{7,15}$/.test(v)) return 'phone-number';
  }
  return 'text';
}

// 出边 → subtable（关联链路展示）
function toSubtable(detail) {
  const outEdges = detail?.outEdges || [];
  if (!outEdges.length) return null;
  return {
    kind: 'subtable',
    title: '来源与关联',
    mainColumn: 'edgeType',
    subColumns: ['targetType', 'targetId'],
    subRows: 'edges',
    dataBinding: { source: 'particle', particleType: detail?.particle?.type || 'CRM_DEAL', filters: [], metrics: [] },
  };
}

// 主入口（纯函数，schema 生成后强校验）
export function buildParticleDetailSchema(detail) {
  const schema = {
    type: 'detail',
    title: `${detail?.particle?.type || '粒子'} 详情`,
    navigation: { to: '/particles/:id' },
    layout: { columns: 2, theme: 'light' },
    components: [
      ...toAttrFields(detail?.particle),
      ...(toSubtable(detail) ? [toSubtable(detail)] : []),
    ],
  };
  const v = validatePageSchema(schema);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, schema };
}

// 组装入口（供 routes.js 挂载：把详情端点输出 → schema 形态，前端直接 renderPage）
export function buildDetailResponse(detail) {
  const { ok, schema, errors } = buildParticleDetailSchema(detail);
  if (!ok) return { error: errors[0], detail };
  return { schema };
}