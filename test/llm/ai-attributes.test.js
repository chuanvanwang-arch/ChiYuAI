// test/llm/ai-attributes.test.js — AI 属性批量 LLM 适配器（B 方案：一次调用算完全部属性）
// 契约：未配置/调用失败/输出不可解析/类型不符 → 返回 null 或缺失该 key → evaluator 回退确定性兜底并标 degraded
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/events/bus.js', () => ({ emit: vi.fn() }));

import { resolveAiAttributeLlm } from '../../src/llm/aiAttributes.js';
import { emit } from '../../src/events/bus.js';
import { resetLlmCache } from '../../src/llm/client.js';
import { evaluateAiAttributesForAsync } from '../../src/aiAttributes/evaluator.js';

beforeEach(() => resetLlmCache());
afterEach(() => vi.unstubAllGlobals());

const CFG = { provider: 'siliconflow', model: 'deepseek-v4', temp: 0.2 };

function stubLlm(content) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
}

const deal = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'CRM_DEAL',
  payload: { name: '扩产项目', expected_amount: 1200000, stage: 'opportunity', probability: 40 },
};

describe('resolveAiAttributeLlm（批量适配器）', () => {
  it('未配置 → 返回 null（扫描器整体走确定性兜底）', async () => {
    expect(await resolveAiAttributeLlm({ readConfig: async () => null })).toBeNull();
  });

  it('配置存在 → 一次调用返回全部属性，类型不符的属性被剔除', async () => {
    const fetchMock = stubLlm('{"revenue_forecast":{"value":1500000,"rationale":"阶段与金额匹配"},"stuck_warning":{"value":"yes","rationale":"类型不符应丢弃"}}');
    vi.stubGlobal('fetch', fetchMock);
    const batch = await resolveAiAttributeLlm({ readConfig: async () => CFG });
    expect(typeof batch).toBe('function');
    const out = await batch(JSON.stringify({ type: 'CRM_DEAL', payload: deal.payload }), { type: 'CRM_DEAL', keys: ['revenue_forecast', 'stuck_warning'] });
    expect(fetchMock).toHaveBeenCalledOnce();                       // 批量：2 个属性也只 1 次请求
    expect(out.revenue_forecast.value).toBe(1500000);
    expect(out.stuck_warning).toBeUndefined();                      // 非 boolean → 丢弃，交兜底
  });

  it('输出不可解析 → 返回 null（调用方整条兜底）', async () => {
    vi.stubGlobal('fetch', stubLlm('抱歉，我无法评估'));
    const batch = await resolveAiAttributeLlm({ readConfig: async () => CFG });
    expect(await batch('{}', { type: 'CRM_DEAL', keys: ['revenue_forecast'] })).toBeNull();
  });

  it('HTTP 失败 → 返回 null（不抛，扫描不中断）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const batch = await resolveAiAttributeLlm({ readConfig: async () => CFG });
    expect(await batch('{}', { type: 'CRM_DEAL', keys: ['revenue_forecast'] })).toBeNull();
  });

  it('全部属性类型不符 → 返回 null（宁可兜底，也不写脏值）', async () => {
    vi.stubGlobal('fetch', stubLlm('{"revenue_forecast":{"value":"很多钱"}}'));
    const batch = await resolveAiAttributeLlm({ readConfig: async () => CFG });
    expect(await batch('{}', { type: 'CRM_DEAL', keys: ['revenue_forecast'] })).toBeNull();
  });

  it('首次失败 → 重试 1 次后成功（应对瞬时限流）', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"revenue_forecast":{"value":1,"rationale":"ok"}}' } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const batch = await resolveAiAttributeLlm({ readConfig: async () => CFG });
    const out = await batch('{}', { type: 'CRM_DEAL', keys: ['revenue_forecast'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.revenue_forecast.value).toBe(1);
  });

  it('重试仍失败 → 返回 null 并 emit ai-attr-llm-failed（降级不留哑巴）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    vi.useFakeTimers();
    const batch = await resolveAiAttributeLlm({ readConfig: async () => CFG });
    const p = batch('{}', { type: 'CRM_DEAL', keys: ['revenue_forecast'] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBeNull();
    expect(emit).toHaveBeenCalledWith('trace', 'ai-attr-llm-failed', expect.objectContaining({ type: 'CRM_DEAL' }));
    vi.useRealTimers();
  });
});

describe('evaluateAiAttributesForAsync（批量优先 + 逐属性 + 兜底三级）', () => {
  it('批量命中全部属性 → degraded=false，理由来自 LLM', async () => {
    const llmBatch = async () => ({
      revenue_forecast: { value: 990000, rationale: 'LLM：折扣后金额' },
      win_probability_adjusted: { value: 55, rationale: 'LLM：决策链已触达' },
      age_in_stage: { value: 12, rationale: 'LLM' },
      stuck_warning: { value: false, rationale: 'LLM' },
      engagement_trend: { value: '上升', rationale: 'LLM' },
      funnel_velocity: { value: 1.5, rationale: 'LLM' },
      bantcc_completeness: { value: 1, rationale: 'LLM' },
      bantcc_detail: { value: { B: 1, A: 1, N: 1, T: 1, C1: 1, C2: 1 }, rationale: 'LLM' },
      swas_completeness: { value: 1, rationale: 'LLM' },
      swas_staleness_days: { value: 0, rationale: 'LLM' },
    });
    const r = await evaluateAiAttributesForAsync(deal, { llmBatch, now: '2026-08-28T00:00:00Z' });
    expect(r.degraded).toBe(false);
    expect(r.ai.revenue_forecast.value).toBe(990000);
    expect(r.ai.revenue_forecast.rationale).toContain('LLM');
    expect(r.ai.revenue_forecast.degraded).toBe(false);
  });

  it('批量只命中部分 → 缺失属性回退确定性兜底，整体 degraded=true', async () => {
    const llmBatch = async () => ({ revenue_forecast: { value: 880000, rationale: 'LLM' } });
    const r = await evaluateAiAttributesForAsync(deal, { llmBatch, now: '2026-08-28T00:00:00Z' });
    expect(r.degraded).toBe(true);
    expect(r.ai.revenue_forecast.value).toBe(880000);
    expect(r.ai.revenue_forecast.degraded).toBe(false);
    expect(r.ai.stuck_warning.rationale).toContain('确定性');   // 未命中 → 兜底
    expect(r.ai.stuck_warning.degraded).toBe(true);
  });

  it('无批量无 LLM → 全量确定性兜底（与同步版一致，可复现）', async () => {
    const r = await evaluateAiAttributesForAsync(deal, { now: '2026-08-28T00:00:00Z' });
    expect(r.degraded).toBe(true);
    expect(r.ai.revenue_forecast.value).toBe(1200000);
    expect(r.ai.revenue_forecast.rationale).toContain('确定性');
  });
});
