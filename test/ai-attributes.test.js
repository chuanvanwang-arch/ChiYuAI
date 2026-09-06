// test/ai-attributes.test.js — AI 属性评估器纯逻辑（② AI 自动产生的落地）
// 设计输入：01 粒子设计 §2.3 AI 属性 2D 模型 + 12 文档 §7-1
import { describe, it, expect } from 'vitest';
import {
  AI_ATTR_DEFS,
  deterministicEval,
  evaluateAiAttributesFor,
  aiAttrFor,
} from '../src/aiAttributes/evaluator.js';

function fakeParticle(type, payload) {
  return { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type, payload, tenant_id: 'system', state: 'ACTIVE' };
}

describe('AI 属性评估器（② AI 自动产生）', () => {
  it('AI_ATTR_DEFS 含 DEAL 的 revenue_forecast（轴 F_Forecast、来源 AI生成、置信度 0.7）', () => {
    const d = AI_ATTR_DEFS.CRM_DEAL.revenue_forecast;
    expect(d.axis).toBe('F_Forecast');
    expect(d.source).toBe('AI生成');
    expect(d.confidence).toBeGreaterThan(0);
  });

  it('evaluateAiAttributesFor 将派生属性写 payload.ai（带轴/置信度/理由/时间戳）', () => {
    const p = fakeParticle('CRM_DEAL', { name: '扩产项目', expected_amount: 1200000, stage: 'opportunity' });
    const r = evaluateAiAttributesFor(p, { now: '2026-08-25T00:00:00Z' });
    expect(r.ai.revenue_forecast).toBeDefined();
    expect(r.ai.revenue_forecast.axis).toBe('F_Forecast');
    expect(r.ai.revenue_forecast.confidence).toBe(0.7);
    expect(r.ai.revenue_forecast.rationale).toBeTruthy();
    expect(r.ai.revenue_forecast.generated_at).toBe('2026-08-25T00:00:00Z');
  });

  it('幂等：内容不变不重算（同一 payload 第二次 eval 返回相同 ai 快照）', () => {
    const p = fakeParticle('CRM_DEAL', { name: 'X', expected_amount: 500000, stage: 'lead' });
    const r1 = evaluateAiAttributesFor(p, { now: '2026-08-25T00:00:00Z' });
    const r2 = evaluateAiAttributesFor(p, { now: '2026-08-25T00:00:00Z' });
    expect(r2.ai).toEqual(r1.ai);
  });

  it('确定性兜底（无 LLM）也可产生可复现 AI 属性（degraded 标记 + 可解释理由）', () => {
    const p = fakeParticle('CRM_DEAL', { name: 'Y', expected_amount: 800000, stage: 'quoted' });
    const a = evaluateAiAttributesFor(p, { llm: null });
    expect(a.degraded).toBe(true);
    expect(a.ai.revenue_forecast.rationale).toContain('确定性');
  });

  it('aiAttrFor 便捷读取（未生成回退 fallback）', () => {
    const p = fakeParticle('CRM_DEAL', { name: 'Z' });
    expect(aiAttrFor(p, 'revenue_forecast', 'none')).toBe('none');
    const withAi = { ...p, payload: { ...p.payload, ai: { revenue_forecast: { value: 1 } } } };
    expect(aiAttrFor(withAi, 'revenue_forecast', 'none').value).toBe(1);
  });

  it('ACCOUNT 含 customer_health_score（轴 J_Judge、来源 规则+AI确认）', () => {
    const d = AI_ATTR_DEFS.CRM_ACCOUNT.customer_health_score;
    expect(d.axis).toBe('J_Judge');
    expect(d.source).toBe('规则+AI确认');
  });
});