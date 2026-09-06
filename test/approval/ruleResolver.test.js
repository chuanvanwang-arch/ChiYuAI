// test/approval/ruleResolver.test.js — R1-R4 + 分级审批 T1/T2/T3 解析单测（纯函数，无 PG）
import { describe, it, expect } from 'vitest';
import {
  RULES, DEFAULT_TIER_THRESHOLDS, resolveTier, resolveApprovalChain, listRules,
} from '../../src/approval/ruleResolver.js';

describe('【T5】分业务审批规则 R1-R4（设计 §3.1）', () => {
  it('RULES 含 R1-R4 且绑定 S 阶段触发边', () => {
    expect(Object.keys(RULES).sort()).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(RULES.R1).toMatchObject({ business: 'deal',     fromStage: 'S2', toStage: 'S3' });
    expect(RULES.R2).toMatchObject({ business: 'quote',     fromStage: 'S3', toStage: 'S4' });
    expect(RULES.R3).toMatchObject({ business: 'contract',  fromStage: 'S4', toStage: 'S5' });
    expect(RULES.R4).toMatchObject({ business: 'invoice',   fromStage: 'S5', toStage: 'S6' });
  });

  it('listRules() 返回 4 条', () => {
    expect(listRules()).toHaveLength(4);
  });

  it('未知规则抛错', () => {
    expect(() => resolveApprovalChain('R9', { amount: 0 })).toThrow(/R1-R4/);
  });
});

describe('【T5】分级审批档位 resolveTier（设计 §3.3）', () => {
  it('≤ ¥100万 → T1', () => {
    expect(resolveTier(0)).toBe('T1');
    expect(resolveTier(999_999)).toBe('T1');
    expect(resolveTier(1_000_000)).toBe('T1'); // 边界：恰好下限仍 T1
  });

  it('¥100万–500万 → T2', () => {
    expect(resolveTier(1_000_001)).toBe('T2');
    expect(resolveTier(5_000_000)).toBe('T2'); // 边界：恰好 T3 下限仍 T2
  });

  it('> ¥500万 → T3', () => {
    expect(resolveTier(5_000_001)).toBe('T3');
    expect(resolveTier(99_000_000)).toBe('T3');
  });

  it('标记重大项目 → 直接 T3', () => {
    expect(resolveTier(0, { majorProject: true })).toBe('T3');
    expect(resolveTier(10_000, { majorProject: true })).toBe('T3');
  });

  it('阈值可被 overrides 覆盖（配置化）', () => {
    const thr = { t2: 500_000, t3: 2_000_000 };
    expect(resolveTier(600_000, { thresholds: thr })).toBe('T2');
    expect(resolveTier(2_500_000, { thresholds: thr })).toBe('T3');
  });
});

describe('【T5】审批链 resolveApprovalChain（设计 §3.3/§3.4）', () => {
  it('R1 商机推进：任意档位均为销售经理单签', () => {
    for (const amt of [0, 2_000_000, 9_000_000]) {
      const c = resolveApprovalChain('R1', { amount: amt });
      expect(c.business).toBe('deal');
      expect(c.fromStage).toBe('S2');
      expect(c.toStage).toBe('S3');
      expect(c.approverChain).toEqual(['manager']);
    }
  });

  it('R2 报价：T1 经理 / T2 经理+总监 / T3 经理+总监+总裁', () => {
    expect(resolveApprovalChain('R2', { amount: 10_000 }).approverChain).toEqual(['manager']);
    expect(resolveApprovalChain('R2', { amount: 2_000_000 }).approverChain).toEqual(['manager', 'director']);
    expect(resolveApprovalChain('R2', { amount: 9_000_000 }).approverChain).toEqual(['manager', 'director', 'president']);
  });

  it('R3 合同：T1 法务 / T2 法务+VP / T3 法务+VP+总裁', () => {
    expect(resolveApprovalChain('R3', { amount: 10_000 }).approverChain).toEqual(['legal']);
    expect(resolveApprovalChain('R3', { amount: 2_000_000 }).approverChain).toEqual(['legal', 'vp']);
    expect(resolveApprovalChain('R3', { amount: 9_000_000 }).approverChain).toEqual(['legal', 'vp', 'president']);
  });

  it('R4 发票：固定财务VP（超信用→财务VP）', () => {
    for (const amt of [0, 2_000_000, 9_000_000]) {
      expect(resolveApprovalChain('R4', { amount: amt }).approverChain).toEqual(['finance_vp']);
    }
  });

  it('拓扑含 START → CONDITION(AI) → APPROVER* → END', () => {
    const c = resolveApprovalChain('R2', { amount: 9_000_000 }); // T3 = 3 审批人
    const types = c.topology.map(n => n.node_type);
    expect(types[0]).toBe('START');
    expect(types[1]).toBe('CONDITION');
    expect(types.slice(2, 5)).toEqual(['APPROVER', 'APPROVER', 'APPROVER']);
    expect(types[5]).toBe('END');
    // CONDITION 节点携带 AI 判定升级条件
    const cond = c.topology.find(n => n.node_type === 'CONDITION');
    expect(cond.condition).toEqual({ field: 'amount', operator: 'GT', value: DEFAULT_TIER_THRESHOLDS.t3 });
  });

  it('CONDITION 升级阈值随档位变化（T2→t2, T3→t3）', () => {
    const t2 = resolveApprovalChain('R2', { amount: 2_000_000 }); // T2
    const t3 = resolveApprovalChain('R2', { amount: 9_000_000 }); // T3
    const cond2 = t2.topology.find(n => n.node_type === 'CONDITION').condition;
    const cond3 = t3.topology.find(n => n.node_type === 'CONDITION').condition;
    expect(cond2.value).toBe(DEFAULT_TIER_THRESHOLDS.t2);
    expect(cond3.value).toBe(DEFAULT_TIER_THRESHOLDS.t3);
  });

  it('pos 字段连续且 START 为 0', () => {
    const c = resolveApprovalChain('R3', { amount: 2_000_000 });
    c.topology.forEach((n, i) => expect(n.pos).toBe(i));
  });
});
