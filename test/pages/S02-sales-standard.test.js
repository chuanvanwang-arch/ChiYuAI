// test/pages/S02-sales-standard.test.js — Task 6：S02 首页新增「标准达标」区（B 类展示）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §3.2
// 语义：My Behavior collapse 追加 4 个 progress-card（客户数下限/日均拜访/周拜访数/信息收集/周），
//   数据绑定 boardSummary 注入的 cov* 六键（走 sales-thresholds 出厂标准，非 id31 个人目标）
import { describe, it, expect } from 'vitest';
import { schema as s02 } from '../../src/pages/S02.schema.js';

const mb = s02.components.find((c) => c.title === '销售行为达标 · My Behavior');

describe('S02 标准达标区', () => {
  it('My Behavior collapse 含「标准」progress-card 组', () => {
    expect(mb).toBeTruthy();
    const pcs = mb.components.filter((c) => c.kind === 'progress-card' && c.title.includes('标准'));
    expect(pcs.length).toBeGreaterThanOrEqual(4);
  });

  it('区含 客户数下限/日均拜访/周拜访/信息收集 四项，均绑定 cov* 键', () => {
    const covKeys = ['covCustomerCountMin', 'covDailyVisitTarget', 'covWeeklyVisitTarget', 'covInfoCollectWeekly'];
    const salesPcs = mb.components.filter(
      (c) => c.kind === 'progress-card' && c.title.includes('标准')
    );
    expect(salesPcs.length).toBe(4);
    const boundKeys = salesPcs.map((c) => c.dataBinding.metrics[0].key);
    for (const k of covKeys) expect(boundKeys).toContain(k);
  });
});