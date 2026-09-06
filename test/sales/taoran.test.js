// test/sales/taoran.test.js — P0-A TAORAN 六要素补全（T2）红灯用例
// 配套计划：docs/2026-08-30-sales-p0-p1-test-plan.md §2
// 事实源：skills/method-behavior-standard（TAORAN 六要素）+ to-b-sales-management 场景七标准 16
// 六要素：T 客户类型 / A 是否预约 / O 目的 / R 结果 / A 是否达标（三档）/ N 下一步
import { describe, it, expect } from 'vitest';
import { deterministicEval } from '../../src/aiAttributes/evaluator.js';
import { evaluateBehaviorChecklist } from '../../src/sales/behaviorChecklist.js';
import { classifyTaoranAchieved } from '../../src/sales/visitNote.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

const AT = new Date().toISOString();

// 六要素齐全的拜访记录（T/A/O/R/A/N 全有）
const FULL = {
  at: AT,
  type: 'visit',
  customer_type: 'target',
  appointment: true,
  objective: '确认方案范围与预算额度',
  result: '客户原话：预算 120 万已批，按 A3 方案推进',
  achieved: '达到',
  next: '下周三提交正式报价',
  prepare: '已看客户年报与招标文件',
  review: '已复盘：技术分是短板',
};

const evalVisitValue = (payload) =>
  deterministicEval('CRM_ACCOUNT', payload, { key: 'sales_visit_value' });
const evalVisitGaps = (payload) =>
  deterministicEval('CRM_ACCOUNT', payload, { key: 'sales_visit_gaps' });

describe('【T2】TAORAN 六要素：T（客户类型）与 A（预约/达标）', () => {
  it('T2-C1 六要素齐全 → sales_visit_value 为 true', () => {
    const r = evalVisitValue({ visit_notes: [FULL] });
    expect(r.value).toBe(true);
    expect(r.rationale).toMatch(/六要素齐全/);
  });

  it('T2-C2 缺 T（customer_type）→ false 且缺口含「缺客户类型(T)」', () => {
    const { customer_type, ...noT } = FULL; // eslint-disable-line no-unused-vars
    const r = evalVisitValue({ visit_notes: [noT] });
    expect(r.value).toBe(false);
    const g = evalVisitGaps({ visit_notes: [noT] });
    expect(g.value).toContain('缺客户类型(T)');
  });

  it('T2-C3 缺 N（next）→ false（回归：O/R/N 判定不变）', () => {
    const { next, ...noN } = FULL; // eslint-disable-line no-unused-vars
    const r = evalVisitValue({ visit_notes: [noN] });
    expect(r.value).toBe(false);
  });

  it('T2-C4 缺 A（appointment）不判 false —— A 缺失仅告警', () => {
    const { appointment, ...noAppt } = FULL; // eslint-disable-line no-unused-vars
    const r = evalVisitValue({ visit_notes: [noAppt] });
    expect(r.value).toBe(true);
  });

  it('T2-C5 商机客户无预约 → sales_visit_gaps 含「商机客户无预约」', () => {
    const { appointment, ...noAppt } = FULL; // eslint-disable-line no-unused-vars
    const g = evalVisitGaps({
      account_segment: 'opportunity',
      visit_notes: [{ ...noAppt, customer_type: 'opportunity' }],
    });
    expect(g.value).toContain('商机客户无预约');
  });

  it('T2-C6 目标客户无预约 → 不产生该告警', () => {
    const { appointment, ...noAppt } = FULL; // eslint-disable-line no-unused-vars
    const g = evalVisitGaps({
      account_segment: 'target',
      visit_notes: [{ ...noAppt, customer_type: 'target' }],
    });
    expect(g.value).not.toContain('商机客户无预约');
  });

  it('T2-C7 achieved=达到 → 03-03 通过，无「本次未达目标」缺口', () => {
    const r = evaluateBehaviorChecklist({ visit_notes: [{ ...FULL, achieved: '达到' }] }, [], []);
    expect(r.items['03-03']).toBe(true);
    expect(r.gaps).not.toContain('BH-03 不做无效拜访');
  });

  it('T2-C8 achieved=部分达到 → 03-03 通过（有后续动作）', () => {
    const r = evaluateBehaviorChecklist({ visit_notes: [{ ...FULL, achieved: '部分达到' }] }, [], []);
    expect(r.items['03-03']).toBe(true);
  });

  it('T2-C9 achieved=未达到 且无 next → 03-03 不通过（无效拜访）', () => {
    const { next, ...noNext } = FULL; // eslint-disable-line no-unused-vars
    const r = evaluateBehaviorChecklist({ visit_notes: [{ ...noNext, achieved: '未达到' }] }, [], []);
    expect(r.items['03-03']).toBe(false);
    expect(r.gaps).toContain('BH-03 不做无效拜访');
  });

  it('T2-C10 achieved=未达到 但有 next → 03-03 通过', () => {
    const r = evaluateBehaviorChecklist({ visit_notes: [{ ...FULL, achieved: '未达到' }] }, [], []);
    expect(r.items['03-03']).toBe(true);
  });

  it('T2-C11 旧写法 t_achieved 与 achieved 判定一致', () => {
    const a = evaluateBehaviorChecklist({ visit_notes: [{ ...FULL, t_achieved: '未达到', t_next: undefined }] }, [], []);
    const b = evaluateBehaviorChecklist({ visit_notes: [{ ...FULL, achieved: '未达到' }] }, [], []);
    expect(a.items['03-03']).toBe(b.items['03-03']);
  });

  it('T2-C12 六要素齐全账户 21 条通过数 ≥ 12', () => {
    const payload = {
      account_segment: 'target',
      needs: { pain: '人工排版效率低', product: 'A3 彩盒产线' },
      visit_notes: [FULL],
    };
    const deals = [{
      payload: {
        stage: 'S3',
        ai: { bantcc_completeness: { value: 0.9 } },
        win_strategy: '总拥有成本优势',
        team: ['alice', 'bob'],
      },
    }];
    const contacts = [
      { payload: { business_title: '采购经理' } },
      { payload: { business_title: '技术主管' } },
    ];
    const r = evaluateBehaviorChecklist(payload, deals, contacts);
    expect(r.pass).toBeGreaterThanOrEqual(12);
  });
});

describe('【D】TAORAN 达分数档 + coverage 流失警戒（id32 接线）', () => {
  it('D-C1 达成比例 90% → 达到（默认 achieved_ratio=80）', () => {
    expect(classifyTaoranAchieved(90)).toBe('达到');
  });
  it('D-C2 达成比例 10% → 未达到（默认 unachieved_ratio=20）', () => {
    expect(classifyTaoranAchieved(10)).toBe('未达到');
  });
  it('D-C3 达成比例 50% → 部分达到', () => {
    expect(classifyTaoranAchieved(50)).toBe('部分达到');
  });
  it('D-C4 分档随配置变化（achieved=70/unachieved=30 → 65 部分达到、25 未达到、75 达到）', () => {
    const cfg = mergedThresholds({ taoran: { achieved_ratio: 70, unachieved_ratio: 30 } });
    expect(classifyTaoranAchieved(75, cfg)).toBe('达到');
    expect(classifyTaoranAchieved(65, cfg)).toBe('部分达到');
    expect(classifyTaoranAchieved(25, cfg)).toBe('未达到');
  });
  it('D-C5 边界：恰好 80 → 达到；恰好 20 → 部分达到（<20 才未达到）', () => {
    expect(classifyTaoranAchieved(80)).toBe('达到');
    expect(classifyTaoranAchieved(20)).toBe('部分达到');
  });
});
