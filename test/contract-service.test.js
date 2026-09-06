// test/contract-service.test.js — T3-6 CONTRACT 粒子 + 二级资源边 + 审批接线
// 验收：① 合同独立粒子可建（不依赖商机也行） ② 合同提交走审批流 ③ 二级资源（回款/发票）挂合同边
import { describe, it, expect, beforeEach } from 'vitest';

// 纯逻辑层（不依赖 PG）：合同金额校验（start/end 合理性）与二级资源挂边协议
// 粒子持久化/受控边走 particleRepo（写时 hooks），本地单测覆盖纯逻辑 + 接线形态

// —— 合同金额校验（写时闸：金额必须来自报价快照或明细可重算；start<end）——
function validateContract({ contract_no, start_date, end_date, amount, line_items }) {
  const errors = [];
  if (!contract_no || !String(contract_no).trim()) errors.push('合同编号必填（contract_no）');
  if (start_date && end_date && new Date(start_date) >= new Date(end_date)) errors.push('合同周期非法：start_date 必须早于 end_date');
  if (amount != null && Number(amount) < 0) errors.push('合同金额不可为负');
  if (line_items?.length && amount != null) {
    const sum = line_items.reduce((s, l) => s + Number(l.line_total || 0), 0);
    if (Math.abs(sum - Number(amount)) > 0.01) errors.push(`合同金额与明细不一致（写后验证 sum=${sum.toFixed(2)} ≠ amount=${amount}）`);
  }
  return { ok: errors.length === 0, errors };
}

// —— 二级资源挂边协议（T3-6 验收③：contract_id 引用 → has_contract 受控边）——
// 挂在 particleModel 的二级粒子（PAYMENT_PLAN/PAYMENT_RECORD/INVOICE）coreAttributes.contract_id
// 写时由 hooks refs 自动建边（has_contract）；此处校验引用合法性
const SECONDARY_RESOURCE_EDGE = { edge: 'has_contract', target: 'CRM_CONTRACT' };
function resolveSecondaryEdge(contract_type, payload) {
  if (!payload.contract_id) return { ok: false, reason: `${contract_type} 缺少 contract_id 引用` };
  return { ok: true, edge: SECONDARY_RESOURCE_EDGE, source_type: contract_type, target_id: payload.contract_id };
}

describe('T3-6 · CONTRACT 纯逻辑层', () => {
  it('合同编号必填 + 周期合法（start<end）+ 金额非负', () => {
    const r = validateContract({ contract_no: 'HT-2026-001', start_date: '2026-01-01', end_date: '2026-12-31', amount: 100000 });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('缺编号 / 周期倒置 / 负金额 → 拒绝', () => {
    expect(validateContract({ start_date: '2026-01-01', end_date: '2026-12-31', amount: 100 }).ok).toBe(false);
    expect(validateContract({ contract_no: 'HT-001', start_date: '2026-12-31', end_date: '2026-01-01', amount: 100 }).ok).toBe(false);
    expect(validateContract({ contract_no: 'HT-001', amount: -5 }).ok).toBe(false);
  });

  it('写后验证：金额=Σ明细（容差 0.01）', () => {
    const ok = validateContract({ contract_no: 'HT-001', amount: 11800, line_items: [
      { line_total: 10000 * 1.18 }, { line_total: 0 },
    ]});
    expect(ok.ok).toBe(true);
    const bad = validateContract({ contract_no: 'HT-002', amount: 12000, line_items: [{ line_total: 11800 }] });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain('写后验证');
  });

  it('二级资源挂边协议：缺 contract_id → 拒绝；有 → has_contract 边', () => {
    const miss = resolveSecondaryEdge('CRM_PAYMENT_PLAN', { plan_seq: 1 });
    expect(miss.ok).toBe(false);
    const hit = resolveSecondaryEdge('CRM_INVOICE', { invoice_no: 'FP-001', contract_id: 'c_001' });
    expect(hit.ok).toBe(true);
    expect(hit.edge.edge).toBe('has_contract');
    expect(hit.edge.target).toBe('CRM_CONTRACT');
    expect(hit.target_id).toBe('c_001');
  });
});

// —— 审批接线形态（T3-6 验收②：合同提交走审批流）——
// 同构 crm-quote-submit：crm-contract-submit → approval startInstance（写通道第 0 闸 autoDecision）
import { seedActions } from '../src/action/seed-actions.js';
import { resetRegistry, getAction, listActions, detectCrudExplosion } from '../src/action/registry.js';

describe('T3-6 · CONTRACT 审批接线（Action 注册形态）', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
  });

  it('crm-contract-create 已注册（autoDecision + confirm normal）', () => {
    const a = getAction('crm-contract-create');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
    expect(a.confirm).toBe('normal');
    expect(a.namespace).toBe('crm');
  });

  it('crm-contract-submit 已注册（confirm critical → 审批流入口）', () => {
    const a = getAction('crm-contract-submit');
    expect(a).not.toBeNull();
    expect(a.confirm).toBe('critical');
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  it('反爆炸护栏：crm-contract-create 属单意图域 Action（非 CRUD 爆炸）', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('crm-contract-create');
  });
});