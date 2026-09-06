// test/s35-schema.test.js — S35 客户洞察 schema 结构校验 + 字段级权限剔除（无 DB）
// 设计/计划：docs/2026-08-28-customer-360-insight-design.md；plans/2026-08-28-customer-360-insight-plan.md Task C
import { describe, it, expect } from 'vitest';
import { schema as S35 } from '../src/pages/S35.schema.js';
import { validatePageSchema } from '../src/page/validator.js';
import { applyFieldPerms } from '../src/account/insightService.js';

describe('S35 schema', () => {
  it('通过结构校验（CANONICAL_NAV 含 /accounts/:id/insight）', () => {
    const v = validatePageSchema(S35);
    expect(v.ok).toBe(true);
  });
  // 数字化指标重设计 §6：三类聚合组件的字段级权限（schema 层打标记，数据层由 maskMetricsByPerm 抹除）
  it('kpi-strip 交易金额四联：sales 隐藏回款类指标、finance 全可见', () => {
    const sSales = applyFieldPerms(structuredClone(S35), 'sales');
    const kpiSales = sSales.components.find(c => c.kind === 'kpi-strip' && c.title === '交易金额四联');
    // payment_amount 对 sales=hidden → paidAmt/unpaidAmt/payRate 隐藏；contract_amount 对 sales=readonly → 不隐藏
    expect(kpiSales.permHiddenKeys).toEqual(['paidAmt', 'unpaidAmt', 'payRate']);

    const sFin = applyFieldPerms(structuredClone(S35), 'finance');
    const kpiFin = sFin.components.find(c => c.kind === 'kpi-strip' && c.title === '交易金额四联');
    expect(kpiFin.permHiddenKeys).toBeUndefined();
  });
  it('pipeline：sales 隐藏回款段金额（合同段 readonly 不隐藏）', () => {
    const sSales = applyFieldPerms(structuredClone(S35), 'sales');
    const pipe = sSales.components.find(c => c.kind === 'pipeline');
    expect(pipe.permStagesHiddenKeys).toEqual(['payment']);

    const sFin = applyFieldPerms(structuredClone(S35), 'finance');
    expect(sFin.components.find(c => c.kind === 'pipeline').permStagesHiddenKeys).toBeUndefined();
  });
  it('progress-card 回款进度：sales 整卡隐藏、finance 可见', () => {
    const sSales = applyFieldPerms(structuredClone(S35), 'sales');
    const pc = sSales.components.find(c => c.kind === 'progress-card' && c.title === '回款进度');
    expect(pc.permHidden).toBe(true);

    const sFin = applyFieldPerms(structuredClone(S35), 'finance');
    expect(sFin.components.find(c => c.kind === 'progress-card' && c.title === '回款进度').permHidden).toBeUndefined();
    // 客户健康度为派生评分，未挂 permKey，全角色可见
    expect(sSales.components.find(c => c.kind === 'progress-card' && c.title === '客户健康度').permHidden).toBeUndefined();
  });
  it('聚合组件 dataBinding 走 aggregate 契约（sources[] + metrics[]）', () => {
    for (const c of S35.components) {
      if (!['kpi-strip', 'pipeline', 'progress-card'].includes(c.kind)) continue;
      expect(c.dataBinding.source).toBe('aggregate');
      expect(Array.isArray(c.dataBinding.sources)).toBe(true);
      expect(c.dataBinding.sources.length).toBeGreaterThan(0);
      expect(Array.isArray(c.dataBinding.metrics)).toBe(true);
      expect(c.dataBinding.metrics.every(m => typeof m.key === 'string' && m.key)).toBe(true);
    }
  });
  it('attr-field biz_info 对 sales 只读、finance 可见', () => {
    const sSales = applyFieldPerms(structuredClone(S35), 'sales');
    const af = sSales.components.find(c => c.kind === 'attr-field');
    expect(af.readonly).toBe(true);
    const sFinance = applyFieldPerms(structuredClone(S35), 'finance');
    const afF = sFinance.components.find(c => c.kind === 'attr-field');
    expect(afF.readonly).toBeUndefined();
  });
  // 决策2（2026-08-29 completion plan Task 2）：明细三组折叠
  it('明细三组包进 collapse（默认收起，各含一张 table）', () => {
    const collapses = S35.components.filter(c => c.kind === 'collapse');
    const titles = collapses.map(c => c.title);
    expect(titles).toEqual(['客户时间线', '决策执行足迹', '决策链与先例']);
    for (const c of collapses) {
      expect(c.open).toBe(false);
      expect(Array.isArray(c.components) && c.components.length === 1).toBe(true);
      expect(c.components[0].kind).toBe('table');
    }
  });
  it('collapse 嵌套明细仍通过结构校验', () => {
    const v = validatePageSchema(S35);
    expect(v.ok).toBe(true);
  });
});
