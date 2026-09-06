// test/portal/scoring.test.js — Task 4: pipelineMetrics 派生指标（纯函数）
// 设计输入：docs/2026-08-29-insight-metrics-redesign-completion-plan.md Task 4 + §5.5 口径
// 口径：缺省 prob=0.5；inPipeline 排除 LOST_STAGES；停滞 >7 天；金额取 payload.expected_amount ?? payload.amount
import { describe, it, expect } from 'vitest';
import { pipelineMetrics } from '../../src/portal/scoring.js';

const DAY = 86400000;
const now = Date.now();
const ago = (days) => new Date(now - days * DAY).toISOString();

// DEAL 粒子 shape（与 pipeline.html 同源）
const deal = (stage, amount, prob, updatedDaysAgo) => ({
  id: Math.random().toString(36).slice(2),
  payload: { stage, expected_amount: amount, probability: prob },
  updated_at: ago(updatedDaysAgo),
});

describe('Task4 · pipelineMetrics 六段 count/amount + 段间转化率', () => {
  // 2026-09-02 修复后：六段键为 S 码（S1-S6），LOST 为 S7/S8；旧英文键经 dealStageOf 归一兼容。
  const deals = [
    deal('S1', 100, 0.3, 1),
    deal('S1', 200, 0.3, 1),
    deal('S2', 300, 0.5, 2),
    deal('S3', 400, 0.7, 3),
    deal('S4', 500, 0.9, 4),
    deal('S5', 550, 0.95, 4),
    deal('S6', 600, 1, 5),
    deal('S7', 999, 0, 9), // 输单：不计入六段
  ];
  const m = pipelineMetrics(deals);

  it('六段 count 正确（S 码键；S7 输单不计入六段）', () => {
    const byKey = Object.fromEntries(m.stages.map(s => [s.key, s]));
    expect(byKey.S1.count).toBe(2);
    expect(byKey.S2.count).toBe(1);
    expect(byKey.S3.count).toBe(1);
    expect(byKey.S4.count).toBe(1);
    expect(byKey.S6.count).toBe(1);
    expect(m.stages.find(s => s.key === 'S7' || s.key === 'S8')).toBeUndefined();
  });

  it('六段 amount 为各段金额求和', () => {
    const byKey = Object.fromEntries(m.stages.map(s => [s.key, s]));
    expect(byKey.S1.amount).toBe(300);
    expect(byKey.S6.amount).toBe(600);
  });

  it('段间转化率 = 后段 count / 前段 count（首段无转化率 → null）', () => {
    expect(m.conversions.length).toBe(5);
    expect(m.conversions[0]).toBe(50); // S2(1)/S1(2)=50%
    expect(m.conversions[1]).toBe(100); // S3(1)/S2(1)=100%
    expect(m.conversions[2]).toBe(100);
    expect(m.conversions[3]).toBe(100);
    expect(m.conversions[4]).toBe(100);
  });

  it('兼容归一：旧英文键（lead/opportunity/...）经 dealStageOf 归入 S 码段', () => {
    const legacy = pipelineMetrics([
      deal('lead', 100, 0.3, 1),
      deal('opportunity', 300, 0.5, 2),
      deal('lost', 999, 0, 9),
    ]);
    const byKey = Object.fromEntries(legacy.stages.map(s => [s.key, s]));
    expect(byKey.S1.count).toBe(1);   // lead → S1
    expect(byKey.S2.count).toBe(1);   // opportunity → S2
    expect(legacy.inPipelineCount).toBe(2); // lost(S7) 排除
  });
});

describe('Task4 · pipelineMetrics 总览四联', () => {
  const deals = [
    deal('S1', 100, 0.4, 1),
    deal('S2', 200, 0.6, 30), // 停滞 >7 天
    deal('S4', 400, 0.9, 2),
    deal('S7', 1000, 0, 9),          // 输单：排除在管道外
    deal('S8', 500, 0, 9),            // 丢单：排除在管道外
  ];
  const m = pipelineMetrics(deals);

  it('inPipelineCount 排除 LOST_STAGES（S7/S8；3 在管 + 2 流失）', () => {
    expect(m.inPipelineCount).toBe(3);
  });

  it('totalAmount 仅在管道内求和（100+200+400=700）', () => {
    expect(m.totalAmount).toBe(700);
  });

  it('weightedForecast 用概率加权（缺省 0.5 不适用此处均有 prob）', () => {
    // 100*.4 + 200*.6 + 400*.9 = 40+120+360 = 520
    expect(m.weightedForecast).toBeCloseTo(520, 5);
    expect(m.weightedWinRate).toBe(Math.round((520 / 700) * 100)); // 74%
  });

  it('缺省概率 prob=0.5（无 probability 字段时；含兼容归一 lead→S1）', () => {
    const noProb = pipelineMetrics([{ id: 'x', payload: { stage: 'lead', expected_amount: 100 }, updated_at: ago(1) }]);
    // 100 * 0.5
    expect(noProb.weightedForecast).toBeCloseTo(50, 5);
    expect(noProb.weightedWinRate).toBe(50);
    // 2026-09-02 兼容断言：旧键 lead 归一后落入 S1 段
    expect(noProb.stages[0].key).toBe('S1');
    expect(noProb.stages[0].count).toBe(1);
  });

  it('staleCount / staleAmountPct：仅统计管道内 >7 天停滞', () => {
    expect(m.staleCount).toBe(1); // 仅 opportunity(30天)
    // 停滞金额 200 / 管道总额 700 = 28.57% → 29
    expect(m.staleAmountPct).toBe(Math.round((200 / 700) * 100));
  });

  it('winRate = paid / (paid+lost)；avgDealAmount = 总额/在管数', () => {
    expect(m.winRate).toBe(0); // 无 paid，有 2 流失 → 0/(0+2)=0
    expect(m.avgDealAmount).toBeCloseTo(700 / 3, 5);
  });

  it('winRate 含 S6：S6/(S6+S7)', () => {
    const w = pipelineMetrics([
      deal('S6', 100, 1, 1),
      deal('S7', 50, 0, 1),
    ]);
    expect(w.winRate).toBe(50); // 1/(1+1)
    expect(w.inPipelineCount).toBe(1); // S7 排除
  });

  it('空数组安全返回零值', () => {
    const e = pipelineMetrics([]);
    expect(e.inPipelineCount).toBe(0);
    expect(e.totalAmount).toBe(0);
    expect(e.stages.length).toBe(6);
    expect(e.conversions.length).toBe(5);
    expect(e.winRate).toBe(0);
    expect(e.avgDealAmount).toBe(0);
  });
});
