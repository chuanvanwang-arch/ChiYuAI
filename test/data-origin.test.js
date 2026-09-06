// test/data-origin.test.js — 数据来源展示链路（前端 ①/②/③/④ 徽标的数据侧契约）
// 设计输入：docs/specs/2026-08-25-12-data-origin-full-plan.md §7-2（阶段3前台必做）
//           + docs/specs/2026-08-25-ai-native-crm-overall-design.md §8.7（字段采集四查）
// 分层：A. 纯函数判定（无 PG，本地全绿）  B. 详情 API 契约（需 PG@5433，共享真库）
import { describe, it, expect } from 'vitest';

// ───────────────────────── B · 详情 API 契约（routes → 详情/出边/关联） ─────────────────────────
// 注：B 层经 GET /api/particles/:id 的组装函数 buildParticleDetail（route 层抽纯组装，
//     PG 依赖集中在外层 repository 调用；此处对组装函数做实断言，使契约不依赖共享库可见性）
import { classifyAttrSource, SOURCE_ORDER, AXIS_LABELS } from '../src/web/sourceClassify.js';

describe('A · 属性来源分类（①人工/②AI/③规则/④外部 四查纯函数）', () => {
  it('四类徽标常量齐备且顺序固定', () => {
    expect(SOURCE_ORDER).toEqual(['manual', 'ai', 'rule', 'external']);
  });

  it('已在 payload.ai.* 的属性 → ② AI（带轴/置信度透传）', () => {
    const r = classifyAttrSource('revenue_forecast', {
      revenue_forecast: 120000,
      ai: { revenue_forecast: { axis: 'F_Forecast', source: 'AI生成', confidence: 0.7, rationale: '确定性兜底' } },
    });
    expect(r.kind).toBe('ai');
    expect(r.ai).toBeDefined();
    expect(r.ai.confidence).toBe(0.7);
    expect(r.ai.axis).toBe('F_Forecast');
  });

  it('规则维护字段（interaction_index 等）→ ③ 规则', () => {
    const r = classifyAttrSource('interaction_index', {
      interaction_index: { first: { channel: 'email' }, last: { channel: 'meeting' }, next: null },
    });
    expect(r.kind).toBe('rule');
    expect(r.sourceLabel).toContain('③');
  });

  it('AI_ATTR_DEFS 声明但未落 ai.*（待生成）→ ② AI 未生成，needsReview 语义', () => {
    const r = classifyAttrSource('churn_risk', { account_segment: '大客户' });
    expect(r.kind).toBe('ai');
    expect(r.pending).toBe(true);
  });

  it('其余事实字段 → ① 人工（前端填写/连接器写回，默认人工可编辑）', () => {
    const r = classifyAttrSource('expected_amount', { expected_amount: 50000 });
    expect(r.kind).toBe('manual');
    expect(r.sourceLabel).toContain('①');
  });

  it('sourcedFrom 出边命中（外部来源语义）→ ④ 外部', () => {
    const r = classifyAttrSource('domains', { domains: ['example.com'] },
      { edges: [{ edgeType: 'sourcedFrom', targetType: 'CRM_KNOWLEDGE', meta: { relation_confidence: 0.5 } }] });
    expect(r.kind).toBe('external');
    expect(r.extConfidence).toBe(0.5);
  });

  it('五轴标签映射（F_Forecast→预测等）', () => {
    expect(AXIS_LABELS.F_Forecast).toBe('预测');
    expect(AXIS_LABELS.A_Alert).toBe('预警');
  });
});

// ───────────────────────── B · 详情 API 契约 ─────────────────────────
import { buildParticleDetail } from '../src/http/particleDetail.js';

describe('B · 粒子详情组装（buildParticleDetail 纯组装契约）', () => {
  it('返回 particle + 出边（edgeType/meta 透传）+ 关联实体名', () => {
    const d = buildParticleDetail(
      { id: 'p1', type: 'CRM_ACCOUNT', payload: { name: '神州科技', domains: ['shenzhou.cn'] } },
      [
        { edgeType: 'sourcedFrom', target_type: 'CRM_KNOWLEDGE', target_id: 'k9', meta: { relation_confidence: 0.5 } },
        { edgeType: 'auto_weak', target_type: 'CRM_CONTACT', target_id: 'c1', meta: { confirmed: false } },
      ],
      [{ id: 'k9', type: 'CRM_KNOWLEDGE', payload: { title: '企查查快照 2026-08' } }],
    );
    expect(d.particle.id).toBe('p1');
    expect(d.outEdges).toHaveLength(2);
    expect(d.outEdges[0].edgeType).toBe('sourcedFrom');
    expect(d.outEdges[0].meta.relation_confidence).toBe(0.5);
    expect(d.related.k9).toBe('企查查快照 2026-08');
  });

  it('无出边/无关联 → 空数组/空对象（前端可直接渲染）', () => {
    const d = buildParticleDetail({ id: 'p2', type: 'CRM_DEAL', payload: { name: '单' } }, [], []);
    expect(d.outEdges).toEqual([]);
    expect(d.related).toEqual({});
  });

  it('payload 不含 ai 时原样透传（前端 classifyAttrSource 判 pending）', () => {
    const d = buildParticleDetail({ id: 'p3', type: 'CRM_DEAL', payload: { name: 'N', expected_amount: 100 } }, [], []);
    expect(d.particle.payload.ai).toBeUndefined();
  });
});