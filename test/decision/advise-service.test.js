// 建议编排服务（对话驱动决策建议 T6）
import { describe, it, expect } from 'vitest';
import { advise, buildAdvisorConfig } from '../../src/decision/adviseService.js';

describe('buildAdvisorConfig', () => {
  it('缺配置时回退出厂默认（不抛错）', () => {
    const cfg = buildAdvisorConfig(null);
    expect(cfg.margin_floor_pct).toBe(20);
  });
  it('配置覆盖出厂默认', () => {
    expect(buildAdvisorConfig({ margin_floor_pct: 35 }).margin_floor_pct).toBe(35);
  });
});

describe('advise', () => {
  it('报价诉求 + 低于毛利下限 → B 档并指向审批流', async () => {
    const r = await advise({
      utterance: '客户要 8 折，能不能报',
      ctx: { tenantId: 'system' },
      scenario: { scenario_id: 'QUOTE_PRICING', eval_dimensions: [], default_tier: 'HIGH' },
      deal: { payload: { amount: 100000, cost: 88000 } },
      stage: 'S4',
    });
    expect(r.ok).toBe(true);
    expect(r.advice.tier).toBe('B');
    expect(r.advice.approval_flow).toBe('CRM_APPROVAL_FLOW');
  });
  it('无坐标可定位 → C 档且 ok=true（fail-open 不阻断）', async () => {
    const r = await advise({ utterance: '你好', ctx: { tenantId: 'system' }, scenario: null, deal: null, stage: null });
    expect(r.ok).toBe(true);
    expect(r.advice.tier).toBe('C');
    expect(r.advice.scenario_id).toBeNull();
  });
  it('未传 scenario 时按坐标自行定位（不依赖调用方）', async () => {
    const r = await advise({ utterance: '客户问能否寄样品', ctx: { tenantId: 'system' }, deal: { payload: {} }, stage: 'S3' });
    expect(r.advice.scenario_id).toBe('SOLUTION_VALUE');
  });
});
