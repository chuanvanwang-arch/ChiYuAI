// test/web/calibrationRender.test.js — 校准页签渲染纯函数（浏览器安全，无服务端 import）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7
import { test, expect, describe } from 'vitest';
import {
  renderMetricCards, renderAttribution, renderPatchCard, renderHistory, renderCalibration,
} from '../../src/portal/calibrationRender.js';

const metrics = {
  sample_size: 42, sufficient_sample: true, autonomy_rate: 0.3, escalate_rate: 0.7,
  autonomy_override_rate: 0.35, escalated_override_rate: 0.02,
  escalation_fatigue_rate: 0.1, human_latency_p50_ms: 7200000,
  reversal_rate: 0.05, precedent_coverage_avg: 0.6,
};

describe('renderMetricCards', () => {
  test('主指标 autonomy_override_rate 以百分比呈现', () => {
    const html = renderMetricCards(metrics);
    expect(html).toContain('35.0%');
    expect(html).toContain('42');
  });

  test('样本不足时给出提示', () => {
    const html = renderMetricCards({ ...metrics, sample_size: 3, sufficient_sample: false });
    expect(html).toContain('样本不足');
  });
});

describe('renderAttribution', () => {
  test('守卫命中 → 展示拒绝出方原因，不出处方卡', () => {
    const html = renderAttribution({ patches: [], guards: [{ id: 'R6', reason: '样本不足（3 < 20），不产生处方' }] });
    expect(html).toContain('R6');
    expect(html).toContain('样本不足');
    expect(html).not.toContain('cal-patch');
  });

  test('出方规则命中 → 展示命中规则', () => {
    const html = renderAttribution({ patches: [{ id: 'R1', label: '自主覆写率高 → 阈值上调 0.05' }], guards: [], reason: '命中规则 R1' });
    expect(html).toContain('R1');
    expect(html).toContain('阈值上调');
  });

  test('无命中 → 展示可接受区间提示', () => {
    const html = renderAttribution({ patches: [], guards: [], reason: '未命中出方规则，无需调整' });
    expect(html).toContain('未命中出方规则');
  });
});

describe('renderPatchCard', () => {
  const p = {
    patch_id: 'p1', scenario_id: 'QUOTE_PRICING', knob: 'threshold', target: null,
    from_value: { threshold: 0.8 }, to_value: { threshold: 0.85 }, risk: 'LOW', status: 'PENDING',
    evidence: { rule_id: 'R1', reason: '自主覆写率偏高' },
    expected_impact: { autonomy_before: 10, autonomy_after: 6, escalated_before: 20, escalated_after: 24, sample_size: 30 },
  };

  test('展示旋钮与 from→to', () => {
    const html = renderPatchCard(p);
    expect(html).toContain('自主阈值');
    expect(html).toContain('0.8');
    expect(html).toContain('0.85');
    expect(html).toContain('R1');
  });

  test('展示预期影响（自主数变化）', () => {
    const html = renderPatchCard(p);
    expect(html).toContain('10');
    expect(html).toContain('6');
  });

  test('weight 处方：展示 target', () => {
    const html = renderPatchCard({ ...p, knob: 'weight', target: 'method', from_value: { weights: { method: 0.2 } }, to_value: { weights: { method: 0.25 } } });
    expect(html).toContain('method');
    expect(html).toContain('0.25');
  });

  test('PENDING 才给批准/驳回按钮', () => {
    expect(renderPatchCard(p)).toContain('data-cal-approve="p1"');
    expect(renderPatchCard({ ...p, status: 'APPLIED' })).not.toContain('data-cal-approve');
    expect(renderPatchCard({ ...p, status: 'APPLIED' })).toContain('data-cal-rollback="p1"');
    expect(renderPatchCard({ ...p, status: 'REJECTED' })).not.toContain('data-cal-');
  });

  test('HTML 转义：证据文本含尖括号不破页', () => {
    const html = renderPatchCard({ ...p, evidence: { rule_id: '<script>x</script>', reason: 'a > b' } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderHistory', () => {
  test('空历史给出提示', () => {
    expect(renderHistory([])).toContain('尚无已应用');
  });

  test('APPLIED 历史含回滚按钮', () => {
    const html = renderHistory([{ ...metrics, patch_id: 'h1', knob: 'threshold', status: 'APPLIED', risk: 'LOW', from_value: { threshold: 0.85 }, to_value: { threshold: 0.8 } }]);
    expect(html).toContain('data-cal-rollback="h1"');
  });
});

describe('renderCalibration', () => {
  test('组合输出含指标与处方两段', () => {
    const html = renderCalibration(
      { metrics, attribution: { patches: [], guards: [] }, reason: 'no hit' },
      [],
    );
    expect(html).toContain('35.0%');
    expect(html).toContain('决策质量校准');
    expect(html).toContain('无待审处方');
  });
});