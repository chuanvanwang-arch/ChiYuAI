// test/aiAttributes/sales-evaluator.test.js — 行为属性确定性兜底
// 设计：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §5/§8 P0
import { describe, it, expect } from 'vitest';
import { deterministicEval, AI_ATTR_DEFS } from '../../src/aiAttributes/evaluator.js';

describe('属性确定性兜底（CRM_ACCOUNT）', () => {
  const acct = {
    type: 'CRM_ACCOUNT',
    payload: {
      visit_notes: [
        { at: new Date(Date.now() - 2 * 86400000).toISOString(), t_objective: '确认印刷需求', t_next: '报价' },
        { at: new Date(Date.now() - 10 * 86400000).toISOString(), t_objective: '首访', t_next: '约下次' },
      ],
      account_segment: 'target',
    },
  };

  it('AI_ATTR_DEFS.CRM_ACCOUNT 已注册 sales 三属性', () => {
    const defs = AI_ATTR_DEFS.CRM_ACCOUNT || {};
    expect(defs.sales_visit_frequency_adherence).toBeTruthy();
    expect(defs.sales_visit_value).toBeTruthy();
    expect(defs.sales_visit_gaps).toBeTruthy();
  });

  it('visit_frequency_adherence：近30天有拜访→true', () => {
    const r = deterministicEval('CRM_ACCOUNT', acct.payload, { key: 'sales_visit_frequency_adherence' });
    expect(r.value).toBe(true);
    expect(r.rationale).toContain('近30天');
  });

  it('visit_frequency_adherence：近30天无拜访→false', () => {
    const old = { visit_notes: [{ at: new Date(Date.now() - 60 * 86400000).toISOString() }], account_segment: 'target' };
    const r = deterministicEval('CRM_ACCOUNT', old, { key: 'sales_visit_frequency_adherence' });
    expect(r.value).toBe(false);
  });

  it('visit_value：TAORAN 六字段齐全→true', () => {
    // customer_type = TAORAN-T 客户类型；type = 拜访方式（visit/call），二者不可混用
    const full = { visit_notes: [{ t_customer_type: 'target', t_appointment: true, t_type: 'visit', t_objective: '确认需求', t_result: '客户原话：色差问题', t_achieved: '达到', t_next: '报价' }] };
    const r = deterministicEval('CRM_ACCOUNT', full, { key: 'sales_visit_value' });
    expect(r.value).toBe(true);
  });

  it('visit_value：缺 O/R/N → false 且 gaps 列出缺项', () => {
    const partial = { visit_notes: [{ t_type: 'target', t_appointment: true }] };
    const r = deterministicEval('CRM_ACCOUNT', partial, { key: 'sales_visit_value' });
    expect(r.value).toBe(false);
    const g = deterministicEval('CRM_ACCOUNT', partial, { key: 'sales_visit_gaps' });
    expect(Array.isArray(g.value)).toBe(true);
    expect(g.value.join('')).toContain('缺');
  });
});

describe('bantcc_completeness 属性（CRM_DEAL 商机资质）', () => {
  it('AI_ATTR_DEFS.CRM_DEAL 已注册 bantcc_completeness', () => {
    const defs = AI_ATTR_DEFS.CRM_DEAL || {};
    expect(defs.bantcc_completeness).toBeTruthy();
    expect(defs.bantcc_completeness.axis).toBe('J_Judge');
  });

  it('六维齐全 → completeness=1.0（C1 竞争 + C2 公司支持拆开后各自计分）', () => {
    const deal = {
      expected_amount: 100000, authority: 'CTO', needs: { product: 'x', qty: 10 },
      expected_close_date: '2026-10-01', coach: '采购总监', competition: '竞品A',
    };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'bantcc_completeness' });
    expect(r.value).toBe(1);
    expect(r.rationale).toContain('6/6');
  });

  it('四维齐全 → 4/6≈0.667（过 P3→P4 阈值 0.6）', () => {
    const deal = {
      expected_amount: 50000, needs: { product: 'y' }, expected_close_date: '2026-11-01', coach: '采购总监',
    };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'bantcc_completeness' });
    expect(r.value).toBeCloseTo(4 / 6, 5);
    expect(r.value).toBeGreaterThan(0.6);
  });

  it('三维齐全 → 3/6=0.5（六维口径下不过闸）', () => {
    const deal = { expected_amount: 50000, needs: { product: 'y' }, expected_close_date: '2026-11-01' };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'bantcc_completeness' });
    expect(r.value).toBeCloseTo(3 / 6, 5);
  });

  it('零维齐全 → completeness=0（硬拦 P3→P4）', () => {
    const r = deterministicEval('CRM_DEAL', {}, { key: 'bantcc_completeness' });
    expect(r.value).toBe(0);
  });

  it('payload 直取 bantcc_completeness', () => {
    const r = deterministicEval('CRM_DEAL', { bantcc_completeness: 0.75 }, { key: 'bantcc_completeness' });
    expect(r.value).toBeCloseTo(0.75, 5);
  });

  it('显式评分对象（bantcc）：旧版单一 c 评分迁移回退后 C1/C2 各继承其值', () => {
    // 旧版落 bantcc.c=1，六维下 c1/c2 无显式评分亦无字段信号 → 各继承 1，等效分母不变
    const deal = { bantcc: { b: 1, a: 0.7, n: 1, t: 0.5, c: 1 } };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'bantcc_completeness' });
    expect(r.value).toBeCloseTo((1 + 0.7 + 1 + 0.5 + 1 + 1) / 6, 5);
  });

  it('显式六维评分（含 c1/c2）不再走迁移回退', () => {
    const deal = { bantcc: { b: 1, a: 1, n: 1, t: 1, c1: 0.5, c2: 0 } };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'bantcc_completeness' });
    expect(r.value).toBeCloseTo((1 + 1 + 1 + 1 + 0.5 + 0) / 6, 5);
  });
});

// ───────────────────────── T5 · SWAS 商机回顾（P1-A） ─────────────────────────
// 设计：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §4
describe('T5 · SWAS 商机回顾属性（CRM_DEAL swas_completeness / swas_staleness_days）', () => {
  it('【T5-C1】SWAS 四项齐全 → swas_completeness=1', () => {
    const deal = {
      swas: {
        status: 'P2', win_strategy: '总成本拥有优势+财务总监内线',
        action: [{ what: '约技术交流', who: '我方售前', when: '本周五' }],
        schedule: { order_date: '2026-12' },
      },
    };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'swas_completeness' });
    expect(r.value).toBe(1);
  });

  it('【T5-C2】缺 W（制胜策略）→ swas_completeness=0.75', () => {
    const deal = {
      swas: {
        status: 'P2',
        action: [{ what: '约技术交流', who: '我方售前', when: '本周五' }],
        schedule: { order_date: '2026-12' },
      },
    };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'swas_completeness' });
    expect(r.value).toBe(0.75);
  });

  it('【T5-C3】缺两项（W + schedule）→ swas_completeness=0.5', () => {
    const deal = {
      swas: {
        status: 'P2',
        action: [{ what: '约技术交流', who: '我方售前', when: '本周五' }],
      },
    };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'swas_completeness' });
    expect(r.value).toBe(0.5);
  });

  it('【T5-C4】swas 为空 → swas_completeness=0', () => {
    const r = deterministicEval('CRM_DEAL', {}, { key: 'swas_completeness' });
    expect(r.value).toBe(0);
  });

  it('【T5-C5】回顾新鲜度 → swas_staleness_days=10', () => {
    const deal = { swas: { reviewed_at: new Date(Date.now() - 10 * 86400000).toISOString() } };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'swas_staleness_days' });
    expect(r.value).toBe(10);
  });

  it('【T5-C6】回顾过期(40天) → staleness_days=40 且 stuck_warning=true（联动）', () => {
    const deal = { swas: { reviewed_at: new Date(Date.now() - 40 * 86400000).toISOString() } };
    const r = deterministicEval('CRM_DEAL', deal, { key: 'swas_staleness_days' });
    expect(r.value).toBe(40);
    const w = deterministicEval('CRM_DEAL', deal, { key: 'stuck_warning' });
    expect(w.value).toBe(true);
  });
});