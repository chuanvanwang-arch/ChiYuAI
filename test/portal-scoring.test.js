// test/portal-scoring.test.js — 今日优先打分算法单测
import { describe, it, expect } from 'vitest';
import { clamp, scoreDeal, suggestAction, buildTodayPriority, pipelineCounts } from '../src/portal/scoring.js';

describe('clamp', () => {
  it('约束 0-100 并取整', () => {
    expect(clamp(-5)).toBe(0); expect(clamp(150)).toBe(100); expect(clamp(42.6)).toBe(43);
  });
});
describe('scoreDeal', () => {
  it('idle 越久 TIMING 越低', () => {
    const fresh = scoreDeal({ updated_at: new Date().toISOString(), probability: 0.8 }, 3);
    const stale = scoreDeal({ updated_at: new Date(Date.now() - 40 * 864e5).toISOString(), probability: 0.8 }, 3);
    expect(stale.TIMING).toBeLessThan(fresh.TIMING);
    expect(fresh.FIT).toBe(80);
  });
  it('FIT 来自真实 probability（无则回退 0.5）', () => {
    expect(scoreDeal({ probability: 0.9 }).FIT).toBe(90);
    expect(scoreDeal({ probability: 0.4 }).FIT).toBe(40);
    expect(scoreDeal({}).FIT).toBe(50); // 回退 0.5
    expect(scoreDeal({ budget_fit: 0.8 }).FIT).toBe(50); // 旧字段不再参与
  });
});
describe('suggestAction', () => {
  it('idle>30 建议唤醒邮件', () => {
    expect(suggestAction({ idleDays: 35, CONN: 50 }, '报价')).toContain('唤醒邮件');
  });
  it('报价且 idle>3 建议推进合同', () => {
    expect(suggestAction({ idleDays: 5, CONN: 50 }, '报价')).toContain('合同');
  });
});
describe('buildTodayPriority', () => {
  it('按 total 降序取 Top3', () => {
    const deals = [
      { id: '1', updated_at: new Date().toISOString(), budget_fit: 0.9 },
      { id: '2', updated_at: new Date(Date.now() - 50 * 864e5).toISOString(), budget_fit: 0.2 },
      { id: '3', updated_at: new Date().toISOString(), budget_fit: 0.5 },
      { id: '4', updated_at: new Date().toISOString(), budget_fit: 0.7 },
    ];
    const r = buildTodayPriority(deals);
    expect(r).toHaveLength(3);
    expect(r[0].score.total).toBeGreaterThanOrEqual(r[1].score.total);
    expect(r[0].how).toBeTruthy();
  });
});
describe('l2cCounts（商机流六段，与管道页同源）', () => {
  // 2026-09-02 修复：六段键已改为 S 码（S1-S6），旧英文键经 dealStageOf 归一兼容。
  it('按 DEAL.stage 聚合六段（S1/S2/S3/S4/S5/S6）', () => {
    const board = { grouped: { CRM_DEAL: [
      { payload: { stage: 'S1' } },
      { payload: { stage: 'S1' } },
      { payload: { stage: 'S2' } },
      { payload: { stage: 'S3' } },
      { payload: { stage: 'S4' } },
      { payload: { stage: 'S5' } },
      { payload: { stage: 'S6' } },
    ] } };
    const r = pipelineCounts(board);
    expect(r.map(x => x.count)).toEqual([2, 1, 1, 1, 1, 1]);
    expect(r.map(x => x.stage)).toEqual(['线索发掘', '需求确认', '方案匹配', '报价谈判', '合同确认', '赢单移交']);
  });
  it('兼容归一：旧英文键仍可计数（lead→S1，lost→S7 不计入六段）', () => {
    const board = { grouped: { CRM_DEAL: [
      { payload: { stage: 'lead' } }, { payload: { stage: 'opportunity' } },
    ] } };
    const r = pipelineCounts(board);
    expect(r[0].count).toBe(1); // lead → S1
    expect(r[1].count).toBe(1); // opportunity → S2
    expect(r.slice(2).every(x => x.count === 0)).toBe(true);
  });
  it('stage 缺失回退 S1，lost/disqualified 不计入六段', () => {
    const board = { grouped: { CRM_DEAL: [
      {}, { payload: { stage: 'lost' } }, { payload: { stage: 'disqualified' } },
    ] } };
    const r = pipelineCounts(board);
    expect(r).toHaveLength(6);
    expect(r[0].count).toBe(1); // 缺省 → S1
    expect(r.slice(1).every(x => x.count === 0)).toBe(true);
  });
});
