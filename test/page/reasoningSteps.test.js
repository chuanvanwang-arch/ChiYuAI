// test/page/reasoningSteps.test.js — T1 判定内核测试
// 覆盖 7 页 label→facts 判定：S02/S06/S07/S09/S14/S30/S35；未命中规则保持原 status；空 steps 返回空
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('buildReasoningSteps', () => {
  it('S02：任务队列驱动三状态', () => {
    const steps = [
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'pending', label: '切入建议' },
    ];
    const facts = { page: 'S02', hasTasks: true, tasksHasContext: true, hasActionableTask: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'idle', label: '切入建议' },
    ]);
  });

  it('S06：画像完整+七维覆盖+有任务 → 全 ok', () => {
    const steps = [
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ];
    const facts = { page: 'S06', profileFilled: true, sevenDimCovered: true, tasksNonEmpty: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ]);
  });

  it('S06：画像缺+七维未覆盖 → 画像 idle / 七维 warn', () => {
    const steps = [
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ];
    const facts = { page: 'S06', profileFilled: false, sevenDimCovered: false, tasksNonEmpty: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'idle', label: '画像装配' },
      { status: 'warn', label: '七维校验' },
      { status: 'idle', label: '洞察建议' },
    ]);
  });

  it('S07：MEDDICC+决策历史齐+有跟进 → 全 ok', () => {
    const steps = [
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'pending', label: '推进建议' },
    ];
    const facts = { page: 'S07', meddiccFilled: true, hasDecisionHistory: true, hasFollowupTask: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'ok', label: '推进建议' },
    ]);
  });

  it('S07：MEDDICC 缺 → warn', () => {
    const steps = [
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'pending', label: '推进建议' },
    ];
    const facts = { page: 'S07', meddiccFilled: false, hasDecisionHistory: true, hasFollowupTask: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'warn', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'idle', label: '推进建议' },
    ]);
  });

  it('S09：有条款+有逾期计划 → 条款 ok/回款 warn/修订 pending', () => {
    const steps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const facts = { page: 'S09', hasClause: true, hasOverduePlan: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ]);
  });

  it('S09：无逾期计划 → 回款 ok/修订 idle', () => {
    const steps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const facts = { page: 'S09', hasClause: true, hasOverduePlan: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'ok', label: '回款风险' },
      { status: 'idle', label: '修订建议' },
    ]);
  });

  it('S14：有决策+有边+有 trace → 全 ok', () => {
    const steps = [
      { status: 'ok', label: '决策加载' },
      { status: 'ok', label: '关联展开' },
      { status: 'ok', label: '因果链' },
    ];
    const facts = { page: 'S14', hasDecision: true, hasEdges: true, hasTrace: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '决策加载' },
      { status: 'ok', label: '关联展开' },
      { status: 'ok', label: '因果链' },
    ]);
  });

  it('S30：有决策+有先例+无例外 → 覆盖 ok/匹配 ok/偏差 idle', () => {
    const steps = [
      { status: 'ok', label: '覆盖度加载' },
      { status: 'ok', label: '先例匹配' },
      { status: 'pending', label: '偏差分析' },
    ];
    const facts = { page: 'S30', hasDecision: true, hasPrecedent: true, hasException: false };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '覆盖度加载' },
      { status: 'ok', label: '先例匹配' },
      { status: 'idle', label: '偏差分析' },
    ]);
  });

  it('S35：有时间线+角色有权限+有任务 → 全 ok', () => {
    const steps = [
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ];
    const facts = { page: 'S35', timelineNonEmpty: true, roleHasPerm: true, tasksNonEmpty: true };
    expect(buildReasoningSteps(steps, facts)).toEqual([
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ]);
  });

  it('未知 label → 保持原 status 不丢', () => {
    const steps = [{ status: 'ok', label: '自定义评估' }];
    const facts = { page: 'S02' };
    expect(buildReasoningSteps(steps, facts)).toEqual([{ status: 'ok', label: '自定义评估' }]);
  });

  it('steps 为空数组 → 返回空数组', () => {
    expect(buildReasoningSteps([], { page: 'S02' })).toEqual([]);
  });
});