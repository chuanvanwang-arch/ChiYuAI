// 签单风险/评审类场景事实采集（对话驱动决策建议 T5）
import { describe, it, expect } from 'vitest';
import { gatherReviewFacts, pickAdvisor } from '../../src/decision/scenarioAdvisors.js';

describe('pickAdvisor', () => {
  it('SIGN_RISK/REVIEW_GATE 分派给评审采集器', () => {
    for (const s of ['SIGN_RISK', 'REVIEW_GATE']) expect(pickAdvisor(s).name).toBe('gatherReviewFacts');
  });
});

describe('gatherReviewFacts', () => {
  it('阶段停留超阈值 → 产出卡点红线', async () => {
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    const r = await gatherReviewFacts({ payload: { stage_updated_at: old } }, { advisorConfig: { stuck_days: 30 } });
    expect(r.redlines.some((x) => x.cond === 'stage_stuck')).toBe(true);
  });
  it('未停留超期 → 无卡点红线', async () => {
    const recent = new Date(Date.now() - 5 * 86400000).toISOString();
    const r = await gatherReviewFacts({ payload: { stage_updated_at: recent } }, { advisorConfig: { stuck_days: 30 } });
    expect(r.redlines.some((x) => x.cond === 'stage_stuck')).toBe(false);
  });
  it('tier=HIGH 场景不产出自治处置（由 buildAdviceCard 收敛为 ESCALATE）', async () => {
    const r = await gatherReviewFacts({ payload: {} }, { advisorConfig: {} });
    expect(r.facts.autonomy_allowed).toBe(false);
  });
});
