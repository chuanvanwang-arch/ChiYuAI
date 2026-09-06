// test/account-insight-metrics.test.js — 数字化指标聚合纯函数 + 数据层权限抹除（无 DB）
// 设计：docs/2026-08-28-customer-insight-metrics-redesign.md §5（口径）§6（权限）§10（边界）
import { describe, it, expect } from 'vitest';
import { buildMetrics, maskMetricsByPerm } from '../src/account/insightService.js';

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const DAY = 86400000;

const P = (payload) => ({ id: 'x', type: 'T', payload });

describe('buildMetrics · 交易金额四联（§5.1）', () => {
  const related = {
    contracts: [P({ amount: 1000 }), P({ amount: 2000 })],
    payments: [P({ paid_amount: 300, status: 'received' }), P({ paid_amount: 100, status: 'pending' })],
  };
  it('合同总额 / 已回款 / 未回款 / 回款率', () => {
    const m = buildMetrics(related);
    expect(m.money.contractAmt).toBe(3000);
    expect(m.money.unpaidAmt).toBe(2700);
    expect(m.money.payRate).toBe(10);
  });
  it('已回款只统计 status=received（pending 不计入）', () => {
    const m = buildMetrics(related);
    expect(m.money.paidAmt).toBe(300);
  });
  it('无合同/无回款 → null（渲染为「—」，不返回误导性 0）', () => {
    const m = buildMetrics({ contracts: [], payments: [] });
    expect(m.money.contractAmt).toBeNull();
    expect(m.money.paidAmt).toBeNull();
    expect(m.money.unpaidAmt).toBeNull();
    expect(m.money.payRate).toBeNull();
  });
});

describe('buildMetrics · L2C 六段管道（§5.2）', () => {
  const related = {
    deals: [P({ stage: 'lead', expected_amount: 100 }), P({ stage: 'opportunity', expected_amount: 900 })],
    quotations: [P({ amount: 50 })],
    contracts: [P({ amount: 1000 }), P({ amount: 200 })],
    orders: [P({ amount: 300 })],
    payments: [P({ paid_amount: 100, status: 'received' })],
    invoices: [P({ amount: 300 })],
  };
  it('六段各输出 count + amount；线索只统计 stage=lead', () => {
    const m = buildMetrics(related);
    const byKey = Object.fromEntries(m.pipeline.stages.map(s => [s.key, s]));
    expect(byKey.lead.count).toBe(1);            // opportunity 的 900 不计入线索段
    expect(byKey.lead.amount).toBe(100);
    expect(byKey.contract.count).toBe(2);
    expect(byKey.contract.amount).toBe(1200);
    expect(m.pipeline.stages).toHaveLength(6);
  });
  it('段间转化率 = 后段 count / 前段 count', () => {
    const m = buildMetrics(related);
    // 线索1 报价1 合同2 订单1 回款1 发票1 → 100/200/50/100/100
    expect(m.pipeline.conversions).toEqual([100, 200, 50, 100, 100]);
  });
  it('前段为 0 → 转化率为 null（不做除零）', () => {
    const m = buildMetrics({ deals: [], quotations: [], contracts: [], orders: [], payments: [], invoices: [] });
    expect(m.pipeline.conversions).toEqual([null, null, null, null, null]);
  });
});

describe('buildMetrics · 过程活跃度（§5.3）', () => {
  const sources = [
    { type: 'event', ts: iso(3 * DAY) },
    { type: 'event', ts: iso(40 * DAY) },
    { type: 'task', ts: iso(DAY) },      // 非 event 不计入互动
  ];
  const tasks = [
    { task: 'a', due: iso(-2 * DAY) },   // 未来 → 不逾期
    { task: 'b', due: iso(5 * DAY) },    // 已过 → 逾期
    { task: 'c', due: '' },              // due 为空 → 不算逾期
  ];
  it('互动次数 / 30 天互动 / 任务数 / 逾期数 / 最近跟进天数', () => {
    const m = buildMetrics({}, sources, tasks, []);
    expect(m.activity.interactions).toBe(2);
    expect(m.activity.interactions30d).toBe(1);
    expect(m.activity.taskTotal).toBe(3);
    expect(m.activity.taskOverdue).toBe(1);
    expect(m.activity.lastFollowDays).toBe(3);
  });
  it('无任何 event → 最近跟进天数为 null（不显示 0 天误导）', () => {
    const m = buildMetrics({}, [], [], []);
    expect(m.activity.lastFollowDays).toBeNull();
    expect(m.activity.interactions).toBe(0);
  });
});

describe('buildMetrics · 决策与风险（§5.4）', () => {
  it('决策总数 / 例外数 / 例外率', () => {
    const decs = [{ disposition: 'APPROVE' }, { disposition: 'EXCEPTION' }, { disposition: 'APPROVE' }, { disposition: 'EXCEPTION' }];
    const m = buildMetrics({}, [], [], decs);
    expect(m.decision.decTotal).toBe(4);
    expect(m.decision.decExc).toBe(2);
    expect(m.decision.excRate).toBe(50);
  });
  it('决策总数为 0 → 例外率 null，健康度按剔除决策维度重新归一', () => {
    const related = { contracts: [P({ amount: 1000 })], payments: [P({ paid_amount: 1000, status: 'received' })] };
    const m = buildMetrics(related, [], [], []);
    expect(m.decision.excRate).toBeNull();
    // 无 tasks（无 due 覆盖）→ 逾期维度已剔除并按剩余权重归一：0.45×回款率分(100)+0.45×活跃度分(0) → 45/0.9=50 → warn
    expect(m.decision.healthScore).toBe(50);
    expect(m.decision.healthState).toBe('warn');
  });
  it('健康度分档：≥70 good / 40–69 warn / <40 bad', () => {
    const related = { contracts: [P({ amount: 1000 })], payments: [P({ paid_amount: 100, status: 'received' })] };
    const decs = [{ disposition: 'EXCEPTION' }, { disposition: 'APPROVE' }];
    const m = buildMetrics(related, [], [], decs);
    // 无 tasks（无 due 覆盖）→ 逾期维度剔除并按剩余权重归一：
    // rateScore=10, actScore=0, excRate=50 → (0.3×10+0.3×0+0.2×50)/0.8 = 13/0.8 = 16 → bad
    expect(m.decision.healthScore).toBe(16);
    expect(m.decision.healthState).toBe('bad');
  });
  // 2026-09-03 死区修复回归：数据源为决策事件（无 due 字段）时，taskOverdue 须为 null，
  // 且健康度不得被「无数据却恒 100」的伪无逾期维虚高。
  it('决策事件源（无 due）→ taskOverdue 为 null，不污染健康度', () => {
    const related = { contracts: [P({ amount: 1000 })], payments: [P({ paid_amount: 1000, status: 'received' })] };
    // decisionTrace 行无 due 字段（只有 id / scene / disposition 等）
    const decisionTrace = [{ id: 'd1' }, { id: 'd2' }];
    const m = buildMetrics(related, [], decisionTrace, [{ disposition: 'APPROVE' }]);
    expect(m.activity.taskOverdue).toBeNull();        // 非 0（0 会误导为「无逾期」）
    expect(m.activity.taskTotal).toBe(2);
    // 无逾期维度参与：0.3×回款率分(100)+0.3×活跃度分(0)+0.2×(100-0) → (30+0+20)/0.8=62.5 → 63
    expect(m.decision.healthScore).toBe(63);
  });
  it('含 due 的任务源：逾期按 due 判定（非空覆盖不归 null）', () => {
    const tasks = [
      { id: 'a', due: iso(-2 * DAY) },  // 已逾期
      { id: 'b', due: iso(5 * DAY) },   // 未逾期
    ];
    const m = buildMetrics({}, [], tasks, []);
    expect(m.activity.taskOverdue).toBe(1);           // 有 due 覆盖 → 正常计数
    expect(m.activity.taskTotal).toBe(2);
  });
  it('全空数据 → 健康度为 null', () => {
    const m = buildMetrics({}, [], [], []);
    expect(m.decision.healthScore).toBeNull();
    expect(m.decision.healthState).toBe('neutral');
  });
});

describe('maskMetricsByPerm · 数据层权限抹除（§6）', () => {
  const mkSchema = (comps) => ({ components: comps });

  it('kpi-strip 命中项替换为 state=hidden（保留 label，值清空）', () => {
    const schema = mkSchema([{
      kind: 'kpi-strip', title: '交易金额四联', permHiddenKeys: ['paidAmt', 'payRate'],
    }]);
    const data = { components: { 'kpi-strip': { '交易金额四联': { items: [
      { key: 'contractAmt', label: '合同总额', value: 3000 },
      { key: 'paidAmt', label: '已回款', value: 300 },
      { key: 'payRate', label: '回款率', value: 10 },
    ] } } } };
    const out = maskMetricsByPerm(schema, data);
    const items = out.components['kpi-strip']['交易金额四联'].items;
    expect(items[0].value).toBe(3000);
    expect(items[1].state).toBe('hidden');
    expect(items[1].value).toBeNull();
    expect(items[1].label).toBe('已回款');   // 标签保留，仅值被抹除
    expect(items[2].state).toBe('hidden');
    // 不污染入参
    expect(data.components['kpi-strip']['交易金额四联'].items[1].value).toBe(300);
  });

  it('pipeline 命中段 amount 置 null（count 仍可见）', () => {
    const schema = mkSchema([{ kind: 'pipeline', title: 'L2C 六段管道', permStagesHiddenKeys: ['payment'] }]);
    const data = { components: { pipeline: { 'L2C 六段管道': { stages: [
      { key: 'contract', name: '合同', count: 2, amount: 1200 },
      { key: 'payment', name: '回款', count: 1, amount: 300 },
    ] } } } };
    const out = maskMetricsByPerm(schema, data);
    const stages = out.components.pipeline['L2C 六段管道'].stages;
    expect(stages[0].amount).toBe(1200);
    expect(stages[1].amount).toBeNull();
    expect(stages[1].count).toBe(1);
  });

  it('progress-card 整卡替换为 hidden', () => {
    const schema = mkSchema([{ kind: 'progress-card', title: '回款进度', permHidden: true }]);
    const data = { components: { 'progress-card': { '回款进度': { percent: 10, label: '回款进度' } } } };
    const out = maskMetricsByPerm(schema, data);
    expect(out.components['progress-card']['回款进度']).toEqual({ label: '回款进度', percent: null, state: 'hidden' });
  });
});
