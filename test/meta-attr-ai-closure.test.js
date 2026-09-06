// test/meta-attr-ai-closure.test.js — AI 属性自适应闭环：ai.* 轴永不进元模型 + AI_ATTR_AXIS_SOURCE 导出（DB 集成）
// 设计输入：docs/2026-08-26-particle-attribute-model-ui-design.md §7（AI 闭环）+ 计划 Task 7
// 环境限制：需 PG@5433（沙箱无 PG 时标注环境限制，非回归；代码先落，待本机 PG 启动后验证）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { seedMetaAttr, listMetaAttr, getMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { AI_ATTR_AXIS_SOURCE, AI_ATTR_DEFS, aiAttrFor } from '../src/aiAttributes/evaluator.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
  await seedMetaAttr('system');
});

describe('AI 属性闭环：evaluator 产生的 payload.ai.* 不触发元模型登记（系统保留轴）', () => {
  it('写粒子后 ai 轴属性不进 meta_attr（ai.* 是 AI 属性承载，非人工字段）', async () => {
    await createParticle('CRM_DEAL', { name: '闭环商机', expected_amount: 100000 });
    const rows = await listMetaAttr({ particleType: 'CRM_DEAL' });
    // ai.* / ai 保留键永不登记（Task 3/7 排除清单）
    expect(rows.some((r) => r.attr_slug.startsWith('ai.'))).toBe(false);
    expect(rows.some((r) => r.attr_slug === 'ai')).toBe(false);
    // 常规字段 name 已登记
    expect(rows.some((r) => r.attr_slug === 'name')).toBe(true);
  });

  it('evaluator 求值后可读既有 aiAttrFor（revenue_forecast 确定性兜底）', async () => {
    const p = await createParticle('CRM_DEAL', { name: '求值商机', expected_amount: 200000 });
    expect(aiAttrFor(p, 'revenue_forecast')?.value).toBe(200000);
    expect(aiAttrFor(p, 'revenue_forecast')?.axis).toBe('F_Forecast');
  });
});

describe('attio enrichment 登记（source=enrich 语义挂点）：普通新键登记 source=ai 待确认', () => {
  it('连接器补全字段（enrichment_verified）登记 source=ai、enabled=false（设计 §10-③）', async () => {
    await createParticle('CRM_ACCOUNT', { name: '补全客户', enrichment_verified: true });
    const rec = await getMetaAttr('CRM_ACCOUNT', 'enrichment_verified');
    expect(rec).not.toBeNull();
    expect(rec.source).toBe('ai');
    expect(rec.enabled).toBe(false);
  });
});

describe('AI_ATTR_AXIS_SOURCE 导出（元模型 source 轴对照表）', () => {
  it('包含 粒子.属性键 → { axis, source, confidence } 三元组', () => {
    expect(AI_ATTR_AXIS_SOURCE['CRM_DEAL.revenue_forecast']).toEqual({
      axis: 'F_Forecast', source: 'AI生成', confidence: 0.7,
    });
    expect(AI_ATTR_AXIS_SOURCE['CRM_ACCOUNT.churn_risk']?.axis).toBe('A_Alert');
  });
  it('源表与 AI_ATTR_DEFS 同源（CR 数量 = 3 类粒子 × 各键）', () => {
    // CRM_DEAL 10（bantcc_completeness/bantcc_detail + SWAS 双属性）+ CRM_ACCOUNT 8（拜访四属性 + sales_behavior_checklist BH 合格线）+ CRM_CONTACT 2 = 20 项（2026-08-30 SWAS/拜访精细度补强后）
    expect(Object.keys(AI_ATTR_AXIS_SOURCE)).toHaveLength(20);
    // 与 AI_ATTR_DEFS 逐键一致（同源不漂移）
    expect(Object.keys(AI_ATTR_AXIS_SOURCE).length)
      .toBe(Object.values(AI_ATTR_DEFS).reduce((n, d) => n + Object.keys(d).length, 0));
  });
});