// test/action/sales-executor-gate.test.js — 第 3.5 闸 阶段推进前置检查（S1-S6）
// 事实源：src/sales/stageTaxonomy.js（S_GATE_DEFS / S_ATTACHMENT_GATES）+ skills/method-stage-progression
import { describe, it, expect } from 'vitest';
import { salesStageGate } from '../../src/action/executor.js';

describe('第3.5闸 推进前置（salesStageGate 纯函数）', () => {
  it('S1→S2 无需求事实 → 硬闸拦截 gap', () => {
    const r = salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: { needs: {} } });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
    expect(r.gaps.join('')).toContain('需求事实');
  });

  it('S1→S2 需求事实齐全 → 放行', () => {
    const r = salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: { needs: { product: '印刷机', qty: 2, spec: 'A3' } } });
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('S2→S3 sales_visit_value=false → 硬闸拦截（且缺强制附件）', () => {
    const r = salesStageGate({ curStage: 'S2', toStage: 'S3', dealPayload: { ai: { sales_visit_value: { value: false } } } });
    expect(r.ok).toBe(false);
    expect(r.gaps.join('')).toContain('方案验证');
  });

  it('S2→S3 sales_visit_value=true + 强制附件 → 放行', () => {
    const r = salesStageGate({
      curStage: 'S2', toStage: 'S3',
      dealPayload: { ai: { sales_visit_value: { value: true } }, attachments: [{ tag: 'tech_review_proof', name: '技术评审通过', url: 'x' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('S2→S3 sales_visit_value=true 但缺强制附件 → 硬闸（阶段门禁）', () => {
    const r = salesStageGate({
      curStage: 'S2', toStage: 'S3',
      dealPayload: { ai: { sales_visit_value: { value: true } } },
    });
    expect(r.ok).toBe(false);
    expect(r.gaps.join('')).toContain('技术评审通过证明');
  });

  it('S3→S4 BANTCC<0.6 → 硬闸拦截', () => {
    const r = salesStageGate({ curStage: 'S3', toStage: 'S4', dealPayload: { ai: { bantcc_completeness: { value: 0.4 } } } });
    expect(r.ok).toBe(false);
    expect(r.gaps.join('')).toContain('BANTCC');
  });

  it('S3→S4 BANTCC≥0.6 但缺报价 → 硬闸拦截', () => {
    const r = salesStageGate({
      curStage: 'S3', toStage: 'S4',
      dealPayload: { ai: { bantcc_completeness: { value: 0.8 } } },
    });
    expect(r.ok).toBe(false);
    expect(r.gaps.join('')).toContain('报价');
  });

  it('S3→S4 BANTCC≥0.6 且报价已出 → 放行', () => {
    const r = salesStageGate({
      curStage: 'S3', toStage: 'S4',
      dealPayload: { ai: { bantcc_completeness: { value: 0.8 } }, quotation_refs: ['q-1'] },
    });
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('S4→S5 缺 review-gate + 合同事实 + 强制附件 → hard 拦截', () => {
    const r = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: {} });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
    expect(r.gaps.join('')).toContain('review-gate');
  });

  it('S4→S5 review-gate 通过 + 强制附件 → 放行且无 soft 提示', () => {
    const r = salesStageGate({
      curStage: 'S4', toStage: 'S5',
      dealPayload: { review_gate_decision: 'approved', attachments: [{ tag: 'customer_approval_screenshot', name: '客户审批截图', url: 'y' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('S4→S5 review-gate 通过但缺强制附件 → 硬闸（阶段门禁）', () => {
    const r = salesStageGate({
      curStage: 'S4', toStage: 'S5',
      dealPayload: { review_gate_decision: 'approved' },
    });
    expect(r.ok).toBe(false);
    expect(r.gaps.join('')).toContain('客户内部审批完成截图');
  });

  it('S5→S6 未验收未付款 → hard 拦截（2026-08-30 三分类 C 类升级）', () => {
    const r = salesStageGate({ curStage: 'S5', toStage: 'S6', dealPayload: {} });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
    expect(r.gaps.join('')).toContain('合同未签署');
  });

  it('S5→S6 已验收且已收款 → 放行', () => {
    const r = salesStageGate({
      curStage: 'S5', toStage: 'S6',
      dealPayload: { contract_no: 'C-001', signed_at: '2026-08-01', paid_at: '2026-08-10' },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('hard 缺口存在时 soft 缺口不触发硬拦（soft gap 分支）', () => {
    const r = salesStageGate({ curStage: 'S1', toStage: 'S2', dealPayload: { needs: { product: '印刷机', qty: 2, spec: 'A3' } } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

// ───────────────────────── SWAS 门控增强（S2→S3 soft / S4→S5 schedule） ─────────────────────────
describe('第3.5闸 SWAS 门控增强（S2→S3 soft + S4→S5 schedule）', () => {
  it('S2→S3 sales_visit_value=true + 附件 + swas_completeness=0 → 不硬拦，warnings 含「未做商机回顾」', () => {
    const r = salesStageGate({
      curStage: 'S2', toStage: 'S3',
      dealPayload: { ai: { sales_visit_value: { value: true }, swas_completeness: { value: 0 } }, attachments: [{ tag: 'tech_review_proof' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.gate).toBeUndefined();
    expect(r.warnings.join('')).toContain('未做商机回顾');
  });

  it('S2→S3 sales_visit_value=false → 硬闸照旧（gate=sales_prereq）', () => {
    const r = salesStageGate({
      curStage: 'S2', toStage: 'S3',
      dealPayload: { ai: { sales_visit_value: { value: false } } },
    });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
  });

  it('S4→S5 有 swas.schedule.order_date + 强制附件 → 放行（附加证据）', () => {
    const r = salesStageGate({
      curStage: 'S4', toStage: 'S5',
      dealPayload: { swas: { schedule: { order_date: '2026-12' } }, attachments: [{ tag: 'customer_approval_screenshot' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('S4→S5 无 order_date + 无 review-gate → hard 拦截（升级后 gap 含「缺预计下单时间」）', () => {
    const r = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: {} });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
    expect(r.gaps.join('')).toContain('缺预计下单时间');
  });
});
