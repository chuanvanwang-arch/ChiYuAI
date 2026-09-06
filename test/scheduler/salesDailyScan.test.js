// test/scheduler/salesDailyScan.test.js — A 类巡检纯函数（TDD 红→绿）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.2
// 纯函数契约：输入 accounts/deals/thresholds/annualTarget/closedAmount → 命中告警清单（不落库、不写粒子）
import { describe, it, expect } from 'vitest';
import { salesDailyScan } from '../../src/scheduler/salesDailyScan.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const targetAccount = (id, lastVisit) => ({
  id, type: 'CRM_ACCOUNT',
  payload: { name: id, tier: '目标', visit_notes: lastVisit != null ? [{ at: daysAgo(lastVisit) }] : [] },
});
const potentialAccount = (id, lastVisit) => ({
  id, type: 'CRM_ACCOUNT',
  payload: { name: id, tier: '潜力', visit_notes: lastVisit != null ? [{ at: daysAgo(lastVisit) }] : [] },
});
const deal = (id, payload) => ({ id, type: 'CRM_DEAL', payload: { ...payload } });

describe('salesDailyScan 巡检纯函数', () => {
  it('目标客户超 30 天未拜访 -> coverage_gap(tier=目标)', () => {
    const hits = salesDailyScan({ accounts: [targetAccount('a1', 45)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'coverage_gap' && h.metric.tier === '目标')).toBe(true);
  });

  it('潜力客户超 90 天未拜访 -> coverage_gap(tier=潜力)', () => {
    const hits = salesDailyScan({ accounts: [potentialAccount('a2', 120)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'coverage_gap' && h.metric.tier === '潜力')).toBe(true);
  });

  it('>90 天无拜访 -> lost_contact（流失警戒）', () => {
    const hits = salesDailyScan({ accounts: [targetAccount('a3', 100)], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'lost_contact')).toBe(true);
  });

  it('销售潜力 0.6 -> funnel_unhealthy（漏斗不健康）', () => {
    const deals = [deal('d1', { expected_amount: 600, funnel: { forecast_class: '确保' } })];
    const hits = salesDailyScan({
      accounts: [], deals, thresholds: mergedThresholds({}),
      annualTarget: 1000, closedAmount: 0,
    });
    expect(hits.some(h => h.kind === 'funnel_unhealthy')).toBe(true);
  });

  it('承诺准确率 0.55 -> commit_red（承诺红带）', () => {
    const deals = [deal('d2', { committed: { amount: 1000 }, actual_amount: 550 })];
    const hits = salesDailyScan({
      accounts: [], deals, thresholds: mergedThresholds({}),
      annualTarget: 1000,
    });
    expect(hits.some(h => h.kind === 'commit_red')).toBe(true);
  });

  it('当日拜访 1 次 < 3 -> visit_shortfall', () => {
    const acct = {
      id: 'a4', type: 'CRM_ACCOUNT',
      payload: {
        name: 'a4', tier: '目标',
        visit_notes: [{ at: new Date().toISOString() }, { at: daysAgo(2) }],
      },
    };
    const hits = salesDailyScan({ accounts: [acct], deals: [], thresholds: mergedThresholds({}) });
    expect(hits.some(h => h.kind === 'visit_shortfall')).toBe(true);
  });

  it('周新增 2 < 5 -> info_collect_lag', () => {
    const acctNew = (id, createdDaysAgo) => ({
      id, type: 'CRM_ACCOUNT',
      created_at: daysAgo(createdDaysAgo),
      payload: { name: id, tier: '潜力', visit_notes: [] },
    });
    const hits = salesDailyScan({
      accounts: [acctNew('n1', 1), acctNew('n2', 1)], deals: [],
      thresholds: mergedThresholds({}),
    });
    expect(hits.some(h => h.kind === 'info_collect_lag')).toBe(true);
  });

  it('达标场景不告警', () => {
    // 真达标样本：今日 3 次拜访（非 call）+ 周内累计 15 + 周新增 5 个客户 + 潜在覆盖达标（<90天）
    const todayISO = new Date().toISOString();
    const weekISO = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const fullAcct = {
      id: 'a5', type: 'CRM_ACCOUNT',
      payload: {
        name: 'a5', tier: '目标', created_at: weekISO(1),
        visit_notes: [
          { at: todayISO }, { at: todayISO }, { at: todayISO },
          // 历史 12 条全部落在近 6 天（d1..d6 各 2 条，均在周窗口内）→ 12 + 今日 3 = 15 ≥ 达标 15
          ...[1, 2, 3, 4, 5, 6].flatMap((i) => [{ at: weekISO(i) }, { at: weekISO(i) }]),
        ],
      },
    };
    // 周新增达标：created_at 近 7 天账户共 5 个（a6 + n1-n4）
    const newAccts = ['a6', 'n1', 'n2', 'n3', 'n4'].map((id, i) => ({
      id, type: 'CRM_ACCOUNT', created_at: weekISO(i + 1),
      payload: { name: id, tier: '潜力', visit_notes: [{ at: weekISO(2 + i) }] }, // 2~5 天前访问（<90 达标，且在近 7 天窗口内补充周拜访量）
    }));
    const deals = [
      deal('d3', { expected_amount: 1200, funnel: { forecast_class: '确保' } }),
    ];
    const hits = salesDailyScan({
      accounts: [fullAcct, ...newAccts], deals,
      thresholds: mergedThresholds({}), annualTarget: 1000,
    });
    // 今日 3 次（≥3）、周 15+（3+12=15）、周新增 5（≥5）、潜力客户 5~8 天前访问（<90 达标）
    expect(hits.length).toBe(0);
  });

  it('阈值随配置变化：target_days 配 60 -> 45 天未拜访不告警', () => {
    const thresholds = mergedThresholds({ coverage: { target_month_days: 60 } });
    const hits = salesDailyScan({ accounts: [targetAccount('a6', 45)], deals: [], thresholds });
    expect(hits.some(h => h.kind === 'coverage_gap' && h.metric.tier === '目标')).toBe(false);
  });
});