import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../../src/action/seed-actions.js'; // registerAction 包裹在 seedActions() 内，需显式调用
import { getAction } from '../../src/action/registry.js';

beforeAll(() => { seedActions(); });

describe('autoDecision action decisionScenario 映射 (T2)', () => {
  const cases = [
    ['crm-quote-submit', 'QUOTE_PRICING'],
    ['crm-quote-activate', 'QUOTE_PRICING'],
    ['crm-contract-create', 'POST_CONTRACT'],
    ['crm-contract-submit', 'POST_CONTRACT'],
    ['crm-payment-plan-create', 'POST_CONTRACT'],
    ['crm-payment-record-create', 'POST_CONTRACT'],
    ['crm_calibration_patch_generate', 'CALIBRATION_CHANGE'],
    ['crm_calibration_patch_approve', 'CALIBRATION_CHANGE'],
    ['crm_calibration_patch_reject', 'CALIBRATION_CHANGE'],
    ['crm_calibration_patch_rollback', 'CALIBRATION_CHANGE'],
    ['crm-invoice-submit', 'INVOICE_APPROVE'],
    ['crm-invoice-create', 'INVOICE_APPROVE'],
    ['crm-invoice-reconcile', 'INVOICE_APPROVE'],
    ['crm-order-submit', 'ORDER_APPROVE'],
    ['crm-order-create', 'ORDER_APPROVE'],
    ['crm-order-advance', 'ORDER_APPROVE'],
    ['crm-review-gate-approve', 'REVIEW_GATE'],
    ['crm-import-batch', 'IMPORT_BATCH'],
  ];
  for (const [name, scen] of cases) {
    it(`${name} → decisionScenario=${scen}`, () => {
      const def = getAction(name);
      expect(def).toBeTruthy();
      expect(def.autoDecision).toBe(true);
      expect(def.decisionScenario).toBe(scen);
    });
  }
  // 已合规 6 个不声明 decisionScenario（handler 内 mint，executor 跳过 → 防双 mint）；
  // 注：crm-import-batch 已于 T5 注册 IMPORT_BATCH 场景并补 decisionScenario，移出此列表（见上方 cases）。
  const noScenario = ['crm-deal-advance', 'crm-deal-reopen', 'crm-lead-pick', 'crm-lead-recycle', 'crm-proposal-write', 'crm-deal-rollback'];
  for (const name of noScenario) {
    it(`${name} 不声明 decisionScenario（handler 内 mint，防双 mint）`, () => {
      const def = getAction(name);
      expect(def).toBeTruthy();
      expect(def.decisionScenario).toBeUndefined();
    });
  }
});

// T5.1 加固：决策结果/反馈写 action 消费「既有决策」的 decision_id（必需入参），
// 不得声明 autoDecision（否则缺 decision_id 时第0闸被绕过 → 写入 decision_id=null 假绿）。
describe('决策结果写 action 必须非 autoDecision（消费既有 decision_id，T5.1）', () => {
  const consumeActions = ['crm_decision_outcome_write', 'crm_decision_outcome_set'];
  for (const name of consumeActions) {
    it(`${name} autoDecision=false 且 decision_id 为必需入参`, () => {
      const def = getAction(name);
      expect(def).toBeTruthy();
      expect(def.autoDecision).toBe(false);
      expect(def.decisionScenario).toBeUndefined();
      const req = def.parameters?.required || [];
      expect(req).toContain('decision_id');
    });
  }
});

