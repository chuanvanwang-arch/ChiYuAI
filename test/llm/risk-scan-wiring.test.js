// test/llm/risk-scan-wiring.test.js — 风险扫描「配了 LLM 就要真消费」的接线契约
// 背景缺陷：scheduler/timers.js 曾硬编码 runRiskScan({llm:null}) → 后台配了 LLM，AI 属性仍永远走确定性兜底。
// 契约：①不传 llm 时自动解析配置；②显式传 llm（含 null）时不自动解析（历史调用方语义不变）；
//      ③批量适配器按粒子调用（每粒子 1 次）；④超出预算的粒子走兜底。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({ query: vi.fn(), queryWrite: vi.fn() }));
vi.mock('../../src/events/bus.js', () => ({ emit: vi.fn() }));
vi.mock('../../src/llm/aiAttributes.js', () => ({ resolveAiAttributeLlm: vi.fn() }));

import { runRiskScan } from '../../src/scheduler/riskScanner.js';
import { query } from '../../src/db.js';
import { emit } from '../../src/events/bus.js';
import { resolveAiAttributeLlm } from '../../src/llm/aiAttributes.js';

const rows = [
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'CRM_DEAL', payload: { expected_amount: 100, stage: 'lead' } },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', type: 'CRM_DEAL', payload: { expected_amount: 200, stage: 'lead' } },
];

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows });
});

describe('runRiskScan 的 LLM 接线', () => {
  it('不传 llm → 自动解析配置，并逐粒子调用批量适配器', async () => {
    const batch = vi.fn().mockResolvedValue({ revenue_forecast: { value: 111, rationale: 'LLM' } });
    resolveAiAttributeLlm.mockResolvedValue(batch);
    const r = await runRiskScan({ dryRun: true });
    expect(resolveAiAttributeLlm).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledTimes(2);
    expect(r.llm_enabled).toBe(true);
    expect(r.llm_calls).toBe(2);
    expect(emit).toHaveBeenCalledWith('trace', 'crm-risk-scan', expect.objectContaining({ llm_enabled: true }));
  });

  it('显式传 llm:null → 不解析配置（历史契约不变，整轮确定性兜底）', async () => {
    resolveAiAttributeLlm.mockResolvedValue(vi.fn());
    const r = await runRiskScan({ llm: null, dryRun: true });
    expect(resolveAiAttributeLlm).not.toHaveBeenCalled();
    expect(r.llm_enabled).toBe(false);
    expect(r.llm_calls).toBe(0);
    expect(r.degraded).toBe(2);
  });

  it('未配置 LLM → 自动解析返回 null → 整轮兜底且不发起任何调用', async () => {
    resolveAiAttributeLlm.mockResolvedValue(null);
    const r = await runRiskScan({ dryRun: true });
    expect(r.llm_enabled).toBe(false);
    expect(r.degraded).toBe(2);
    expect(emit).toHaveBeenCalledWith('trace', 'crm-risk-scan', expect.objectContaining({ llm_calls: 0 }));
  });

  it('超出调用预算的粒子走兜底（防额度击穿）', async () => {
    const full = {
      revenue_forecast: { value: 1, rationale: 'LLM' },
      win_probability_adjusted: { value: 50, rationale: 'LLM' },
      age_in_stage: { value: 3, rationale: 'LLM' },
      stuck_warning: { value: false, rationale: 'LLM' },
      engagement_trend: { value: '持平', rationale: 'LLM' },
      funnel_velocity: { value: 1, rationale: 'LLM' },
      bantcc_completeness: { value: 1, rationale: 'LLM' },
      bantcc_detail: { value: { B: 1, A: 1, N: 1, T: 1, C1: 1, C2: 1 }, rationale: 'LLM' },
      swas_completeness: { value: 1, rationale: 'LLM' },
      swas_staleness_days: { value: 0, rationale: 'LLM' },
    };
    const batch = vi.fn().mockResolvedValue(full);
    resolveAiAttributeLlm.mockResolvedValue(batch);
    const r = await runRiskScan({ dryRun: true, llmBudget: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(r.llm_calls).toBe(1);
    expect(r.degraded).toBe(1); // 第 1 条全命中不降级，第 2 条超预算走兜底
  });
});
