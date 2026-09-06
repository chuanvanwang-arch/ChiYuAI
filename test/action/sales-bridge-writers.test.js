// test/action/sales-bridge-writers.test.js — P4→P5 / P5→P6 证据桥写入点收口验证
// 纯逻辑（无 PG）：① 两个写入 Action 已注册且非 CRUD 爆炸 ② 闸在 writer 产出形态下通过
import { describe, it, expect, beforeEach } from 'vitest';
import { seedActions } from '../../src/action/seed-actions.js';
import { resetRegistry, getAction, detectCrudExplosion } from '../../src/action/registry.js';
import { salesStageGate } from '../../src/action/executor.js';

describe('S4→S5 / S5→S6 证据桥写入点（Action 注册形态）', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
  });

  it('crm-review-gate-approve 已注册（闭合 S4→S5 第3.5闸：写 review_gate_decision）', () => {
    const a = getAction('crm-review-gate-approve');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  it('crm-contract-create 仍注册（闭合 S5→S6：建 CRM_CONTRACT 粒子 + 回写 DEAL 签署事实）', () => {
    const a = getAction('crm-contract-create');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
  });

  it('反爆炸护栏：两个桥 Action 均属单意图域（非 CRUD 爆炸）', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('crm-review-gate-approve');
    expect(r.offenders).not.toContain('crm-contract-create');
  });
});

describe('第3.5闸 在 writer 产出形态下通过', () => {
  // S4→S5：crm-review-gate-approve 写 review_gate_decision='approved'
  it('S4→S5：review_gate_decision=approved + 强制附件 → 无缺口（双闸门证据落地）', () => {
    const r = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: { review_gate_decision: 'approved', attachments: [{ tag: 'customer_approval_screenshot', name: '客户审批截图', url: 'y' }] } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('S4→S5：无 review_gate_decision → hard 拦截（2026-08-30 升级）', () => {
    const r = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: {} });
    expect(r.ok).toBe(false); // hard 闸
    expect(r.gaps.join('；')).toContain('review-gate');
  });

  // S5→S6：crm-contract-create 写 contract_no+signed_at（has_contract=true）
  it('S5→S6：contract_no+signed_at 已落但未收款 → hard 拦截（缺全款事实）', () => {
    const r = salesStageGate({ curStage: 'S5', toStage: 'S6', dealPayload: { contract_no: 'HT-001', signed_at: '2026-08-01' } });
    expect(r.ok).toBe(false); // hard 闸：合同+全款缺一不可
    expect(r.gaps.join('、')).toContain('未收到全款');
  });

  it('S5→S6：contract_no+signed_at+paid_at 全齐 → 零 warnings（合同签署事实 + 回款齐备）', () => {
    const r = salesStageGate({
      curStage: 'S5', toStage: 'S6',
      dealPayload: { contract_no: 'HT-001', signed_at: '2026-08-01', paid_at: '2026-08-10' },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });
});
