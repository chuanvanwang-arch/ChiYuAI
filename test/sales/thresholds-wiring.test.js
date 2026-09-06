// test/sales/thresholds-wiring.test.js — 阈值接线到消费方（T12）红灯用例
// 配套设计：docs/2026-08-30-sales-thresholds-config-design.md §5（T11-C6 ~ C11）
// 核心验证：改一处配置，所有消费方同步生效（杜绝"BANTCC 0.6 三处各写一遍"的隐患）。
import { describe, it, expect } from 'vitest';
import { evaluateBehaviorChecklist } from '../../src/sales/behaviorChecklist.js';
import { salesStageGate } from '../../src/action/executor.js';
import { DEFAULT_THRESHOLDS, mergedThresholds } from '../../src/sales/salesThresholds.js';

const AT = new Date().toISOString();
const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString();

describe('【T12】阈值接线：配置变化驱动判定变化', () => {
  it('T11-C6 21 条 03-01 随 bantcc.pass 配置变化', () => {
    const deal = { payload: { ai: { bantcc_completeness: { value: 0.7 } } } };
    // 默认 0.6：0.7 达标
    expect(evaluateBehaviorChecklist({}, [deal], []).items['03-01']).toBe(true);
    // 配置收紧到 0.8：0.7 不再达标
    const strict = mergedThresholds({ bantcc: { pass: 0.8 } });
    expect(evaluateBehaviorChecklist({}, [deal], [], strict).items['03-01']).toBe(false);
  });

  it('T11-C7 S3→S4 门控与 21 条同源：改一处两边同时生效', () => {
    const payload = {
      ai: { bantcc_completeness: { value: 0.7 } },
      quotation_refs: ['Q-1'],
    };
    // 默认 0.6 → 放行
    expect(salesStageGate({ curStage: 'S3', toStage: 'S4', dealPayload: payload }).ok).toBe(true);
    // 配置收紧到 0.8 → 拦截，且文案反映新阈值
    const strict = mergedThresholds({ bantcc: { pass: 0.8 } });
    const v = salesStageGate({ curStage: 'S3', toStage: 'S4', dealPayload: payload, thresholds: strict });
    expect(v.ok).toBe(false);
    expect(v.gaps.join(';')).toContain('0.8');
  });

  it('T11-C8 04-02 随 min_contacts 配置变化', () => {
    const contacts = [{ payload: {} }, { payload: {} }];
    expect(evaluateBehaviorChecklist({}, [], contacts).items['04-02']).toBe(true); // 默认 ≥2
    const strict = mergedThresholds({ behavior: { min_contacts: 3 } });
    expect(evaluateBehaviorChecklist({}, [], contacts, strict).items['04-02']).toBe(false);
  });

  it('T11-C9 01-01 随 recent_visit_days 配置变化', () => {
    const p = { visit_notes: [{ at: daysAgoIso(10) }] };
    expect(evaluateBehaviorChecklist(p, [], []).items['01-01']).toBe(false); // 默认 7 天
    const loose = mergedThresholds({ behavior: { recent_visit_days: 15 } });
    expect(evaluateBehaviorChecklist(p, [], [], loose).items['01-01']).toBe(true);
  });

  it('T11-C10 05-02/05-03 随派生天数变化（从 id30 window_days 派生）', () => {
    const p = {
      account_segment: 'potential',
      visit_notes: [{ at: daysAgoIso(70) }], // 70 天前
    };
    // 默认潜力 90 天 → 达标
    expect(evaluateBehaviorChecklist(p, [], []).items['05-02']).toBe(true);
    // 派生：id30 配 quarter=60 → 70 天前不再达标
    const arr = { window_days: { quarter: 60, month: 30 } };
    expect(evaluateBehaviorChecklist(p, [], [], DEFAULT_THRESHOLDS, arr).items['05-02']).toBe(false);
  });

  it('T11-C10b 05-02/05-03 coverage 键优先于 id30 window_days（A 接线）', () => {
    const p = {
      account_segment: 'target',
      visit_notes: [{ at: daysAgoIso(50) }], // 50 天前
    };
    // 默认月覆盖 30 天 → 不达标
    expect(evaluateBehaviorChecklist(p, [], []).items['05-03']).toBe(false);
    // coverage.target_month_days=60 → 50 天前达标（coverage 优先，不依赖 id30）
    const cov = mergedThresholds({ coverage: { target_month_days: 60 } });
    expect(evaluateBehaviorChecklist(p, [], [], cov).items['05-03']).toBe(true);
    // id30 配 month=15 但 coverage 未配 → 仍可派生（id30 回退链保留）
    const arr = { window_days: { quarter: 90, month: 15 } };
    expect(evaluateBehaviorChecklist(p, [], [], DEFAULT_THRESHOLDS, arr).items['05-03']).toBe(false);
    // 潜在客户同理：coverage.potential_quarter_days 生效
    // p2 须落在「默认窗口内、收紧窗口外」的中间带（70 天前）：默认 90 达标、收紧 30 不达标——真测出 coverage 改变判定
    const p2 = { account_segment: 'potential', visit_notes: [{ at: daysAgoIso(70) }] };
    expect(evaluateBehaviorChecklist(p2, [], []).items['05-02']).toBe(true); // 默认 90 天 → 70<90 达标
    // coverage 显式收紧到 30 天 → 70 天前不达标（显式覆盖优先于 id30 派生）
    const covQ = mergedThresholds({ coverage: { potential_quarter_days: 30 } });
    expect(evaluateBehaviorChecklist(p2, [], [], covQ).items['05-02']).toBe(false);
  });

  it('T11-C11 未传配置时行为与改造前一致（向后兼容回归）', () => {
    const p = { visit_notes: [{ at: AT, objective: '确认需求范围', result: '客户认可', next: '报价' }] };
    const a = evaluateBehaviorChecklist(p, [], []);
    const b = evaluateBehaviorChecklist(p, [], [], DEFAULT_THRESHOLDS);
    expect(a.items).toEqual(b.items);
    expect(a.pass).toBe(b.pass);
  });

  it('T11-C11b 门控未传配置时行为与改造前一致', () => {
    const payload = { ai: { bantcc_completeness: { value: 0.7 } }, quotation_refs: ['Q-1'] };
    const a = salesStageGate({ curStage: 'S3', toStage: 'S4', dealPayload: payload });
    const b = salesStageGate({ curStage: 'S3', toStage: 'S4', dealPayload: payload, thresholds: DEFAULT_THRESHOLDS });
    expect(a.ok).toBe(b.ok);
  });

  it('T11-C11c S1→S2 需求事实项数随 gate.s1_s2_min_need_facts 变化', () => {
    const payload = { needs: { product: 'A3 产线' } }; // 仅 1 项
    expect(salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: payload }).ok).toBe(false);
    const loose = mergedThresholds({ gate: { s1_s2_min_need_facts: 1 } });
    expect(salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: payload, thresholds: loose }).ok).toBe(true);
  });
});
