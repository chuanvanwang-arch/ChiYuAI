// test/decision-chain-validator.test.js — P0-2 决策链角色漂移校验（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-2）
// 案例依据 F2：ready-to-send 质量闸「无角色漂移」（180 条 0 漂移）。
// 纯函数、零 DB；映射词表配置化（fail-open）。
import { describe, it, expect } from 'vitest';
import { validateDecisionChain, DEFAULT_ROLE_TEMPLATE, DEFAULT_ROLE_MAP } from '../src/sales/decisionChainValidator.js';

describe('validateDecisionChain', () => {
  it('模板角色全部覆盖 → 完整性 1.0，无缺失/漂移', () => {
    const contacts = [
      { title: '采购总监', department: '采购', decision_power: 'veto' },
      { title: '研发经理', department: '研发', decision_power: 'recommend' },
      { title: 'CFO', department: '财务', decision_power: 'budget' },
      { title: '总经理', department: '管理层', decision_power: 'approve' },
    ];
    const res = validateDecisionChain(contacts, {}, { template: DEFAULT_ROLE_TEMPLATE, roleMap: DEFAULT_ROLE_MAP });
    expect(res.completeness).toBe(1.0);
    expect(res.missingRoles).toEqual([]);
    expect(res.driftContacts).toEqual([]);
  });

  it('缺 budget 角色 → 完整性 <1 且 missingRoles 含 budget', () => {
    const contacts = [
      { title: '采购总监', department: '采购', decision_power: 'veto' },
      { title: '研发经理', department: '研发', decision_power: 'recommend' },
      { title: '总经理', department: '管理层', decision_power: 'approve' },
    ];
    const res = validateDecisionChain(contacts, {}, { template: { required: ['veto', 'budget', 'approve'] }, roleMap: DEFAULT_ROLE_MAP });
    expect(res.missingRoles).toContain('budget');
    expect(res.completeness).toBe(2 / 3);
  });

  it('工程师挂 veto（角色漂移）→ driftContacts 判定', () => {
    const contacts = [
      { title: '高级工程师', department: '研发', decision_power: 'veto' }, // 声明 veto 但 title 是研发
    ];
    const res = validateDecisionChain(contacts, {}, { template: { required: ['veto'] }, roleMap: DEFAULT_ROLE_MAP });
    expect(res.driftContacts).toHaveLength(1);
    expect(res.driftContacts[0].declared).toBe('veto');
    expect(res.driftContacts[0].inferred).toBe('recommend');
  });

  it('无 decision_power 的联系人按 title 推断角色', () => {
    const contacts = [{ title: '采购专员', department: '采购' }];
    const res = validateDecisionChain(contacts, {}, { template: { required: ['veto'] }, roleMap: DEFAULT_ROLE_MAP });
    expect(res.assigned[0].role).toBe('veto'); // 按关键词推断
  });

  it('空联系人 → 完整性 0、全部缺失（fail-closed 不误报绿）', () => {
    const res = validateDecisionChain([], {}, { template: { required: ['veto', 'budget'] }, roleMap: DEFAULT_ROLE_MAP });
    expect(res.completeness).toBe(0);
    expect(res.missingRoles).toEqual(['veto', 'budget']);
  });
});
