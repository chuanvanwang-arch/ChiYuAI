// 跟进/丢单类场景事实采集（对话驱动决策建议 T4）
import { describe, it, expect } from 'vitest';
import { gatherFollowupFacts, pickAdvisor } from '../../src/decision/scenarioAdvisors.js';

describe('pickAdvisor', () => {
  it('CLIENT_STRATEGY/LOSS_REVIEW/DEAL_REOPEN 分派给跟进采集器', () => {
    for (const s of ['CLIENT_STRATEGY', 'LOSS_REVIEW', 'DEAL_REOPEN']) {
      expect(pickAdvisor(s).name).toBe('gatherFollowupFacts');
    }
  });
});

describe('gatherFollowupFacts', () => {
  it('超期未拜访 → 产出跟进缺口（required 项留空）', async () => {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const r = await gatherFollowupFacts({ payload: { last_visit_at: old, contact_count: 2 } }, { advisorConfig: {} });
    expect(r.facts.recent_visit).toBeNull();
    expect(r.redlines.some((x) => x.cond === 'followup_overdue')).toBe(true);
  });
  it('近 7 天内有拜访 → 无超期红线', async () => {
    const recent = new Date(Date.now() - 2 * 86400000).toISOString();
    const r = await gatherFollowupFacts({ payload: { last_visit_at: recent, contact_count: 3 } }, { advisorConfig: {} });
    expect(r.redlines.some((x) => x.cond === 'followup_overdue')).toBe(false);
  });
  it('无拜访记录字段 → 视为从未拜访并标注', async () => {
    const r = await gatherFollowupFacts({ payload: {} }, { advisorConfig: {} });
    expect(r.facts.recent_visit).toBeNull();
    expect(r.facts.visit_source).toBe('none');
  });
});
