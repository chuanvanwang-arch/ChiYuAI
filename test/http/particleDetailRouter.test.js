// test/http/particleDetailRouter.test.js — Task 8: 粒子详情受控 Schema 组装（S13 面）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 8 + 蓝图 §3 S13
// 纯函数：buildParticleDetailSchema(detail) 不依赖 DB；detail 用 buildParticleDetail 既有输出形态
import { describe, it, expect } from 'vitest';
import { buildParticleDetailSchema } from '../../src/http/particleDetailRouter.js';

const dealDetail = {
  particle: {
    id: 'p-deal-1', type: 'CRM_DEAL',
    payload: {
      name: '华东大区 2026 扩容', stage: 'opportunity', amount: 1200000,
      stage_changed_at: '2026-08-01T10:00:00Z', ai: { score: { confidence: 0.4 } },
    },
    outEdges: [{ edgeType: 'sourcedFrom', targetType: 'CRM_ACCOUNT', targetId: 'acct-1', meta: { relation_confidence: 0.8 } }],
  },
  outEdges: [{ edgeType: 'sourcedFrom', targetType: 'CRM_ACCOUNT', targetId: 'acct-1', meta: { relation_confidence: 0.8 } }],
  related: { 'acct-1': '华东大区', 'p-prod-1': '扩容包' },
};

describe('buildParticleDetailSchema（S13 粒子详情受控 Schema）', () => {
  it('合法 detail → ok:true + schema type=detail + navigation /particles/:id', () => {
    const r = buildParticleDetailSchema(dealDetail);
    expect(r.ok).toBe(true);
    expect(r.schema.type).toBe('detail');
    expect(r.schema.navigation.to).toBe('/particles/:id');
    expect(r.schema.components.length).toBeGreaterThan(0);
  });

  it('每 payload 字段 → attr-field，外部来源带数据_origin', () => {
    const r = buildParticleDetailSchema(dealDetail);
    const attrs = r.schema.components.filter((c) => c.kind === 'attr-field');
    // name/stage/amount/stage_changed_at/ai.score 排除 ai 嵌套
    expect(attrs.length).toBeGreaterThanOrEqual(4);
    // sourcedFrom 出边 → name 字段 external
    const nameAttr = attrs.find((c) => c.attrSlug === 'name');
    expect(nameAttr.attr.data_origin).toBe('external');
  });

  it('AI 属性（payload.ai.*）→ 不进 attr-field（系统域保留）', () => {
    const r = buildParticleDetailSchema(dealDetail);
    const attrs = r.schema.components.filter((c) => c.kind === 'attr-field');
    expect(attrs.some((c) => c.attrSlug === 'ai')).toBe(false);
    expect(attrs.some((c) => c.attrSlug === 'events')).toBe(false);
  });

  it('有出边 → 附带 subtable（来源与关联）', () => {
    const r = buildParticleDetailSchema(dealDetail);
    expect(r.schema.components.some((c) => c.kind === 'subtable')).toBe(true);
  });

  it('空 payload → 仍合法（attr-field 空，subtable 由 outEdges 决定）', () => {
    const r = buildParticleDetailSchema({ particle: { id: 'p-x', type: 'CRM_DEAL', payload: {}, outEdges: [] }, outEdges: [] });
    expect(r.ok).toBe(true);
  });
});