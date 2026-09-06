// test/http/dead-info-reasoning-trace.test.js
// 死信息活体化：7 页 reasoning-trace 由 buildReasoningSteps 按真实 facts 算状态（方案 B）
// 纯逻辑测试（不连库）：仅校验判定映射与 handler 注入的 facts 契约一致。
import { describe, it, expect } from 'vitest';
import { buildReasoningSteps } from '../../src/page/reasoningSteps.js';

describe('死信息活体化 · 7 页 reasoning-trace 真状态', () => {
  it('S02 作战室：任务队列驱动', () => {
    const steps = [
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'pending', label: '切入建议' },
    ];
    const f = { page: 'S02', hasTasks: true, tasksHasContext: true, hasActionableTask: false };
    expect(buildReasoningSteps(steps, f)).toEqual([
      { status: 'ok', label: '意图解析' },
      { status: 'ok', label: '上下文装配' },
      { status: 'idle', label: '切入建议' },
    ]);
    const f0 = { page: 'S02', hasTasks: false, tasksHasContext: false, hasActionableTask: false };
    expect(buildReasoningSteps(steps, f0)).toEqual([
      { status: 'idle', label: '意图解析' },
      { status: 'idle', label: '上下文装配' },
      { status: 'idle', label: '切入建议' },
    ]);
  });

  it('S06 客户360：画像/七维/洞察', () => {
    const steps = [
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ];
    const fOk = { page: 'S06', profileFilled: true, sevenDimCovered: true, tasksNonEmpty: true };
    expect(buildReasoningSteps(steps, fOk)).toEqual([
      { status: 'ok', label: '画像装配' },
      { status: 'ok', label: '七维校验' },
      { status: 'ok', label: '洞察建议' },
    ]);
    const fBad = { page: 'S06', profileFilled: false, sevenDimCovered: false, tasksNonEmpty: false };
    expect(buildReasoningSteps(steps, fBad)).toEqual([
      { status: 'idle', label: '画像装配' },
      { status: 'warn', label: '七维校验' },
      { status: 'idle', label: '洞察建议' },
    ]);
  });

  it('S07 商机：MEDDICC/决策历史/推进', () => {
    const steps = [
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'pending', label: '推进建议' },
    ];
    const fOk = { page: 'S07', meddiccFilled: true, hasDecisionHistory: true, hasFollowupTask: true };
    expect(buildReasoningSteps(steps, fOk)).toEqual([
      { status: 'ok', label: 'MEDDICC 评估' },
      { status: 'ok', label: '决策历史' },
      { status: 'ok', label: '推进建议' },
    ]);
    const fBad = { page: 'S07', meddiccFilled: false, hasDecisionHistory: false, hasFollowupTask: false };
    expect(buildReasoningSteps(steps, fBad)).toEqual([
      { status: 'warn', label: 'MEDDICC 评估' },
      { status: 'warn', label: '决策历史' },
      { status: 'idle', label: '推进建议' },
    ]);
  });

  it('S09 合同：条款/回款风险/修订', () => {
    const steps = [
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ];
    const fOverdue = { page: 'S09', hasClause: true, hasOverduePlan: true };
    expect(buildReasoningSteps(steps, fOverdue)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'warn', label: '回款风险' },
      { status: 'pending', label: '修订建议' },
    ]);
    const fPaid = { page: 'S09', hasClause: true, hasOverduePlan: false };
    expect(buildReasoningSteps(steps, fPaid)).toEqual([
      { status: 'ok', label: '条款解析' },
      { status: 'ok', label: '回款风险' },
      { status: 'idle', label: '修订建议' },
    ]);
  });

  it('S14 决策图：决策/关联/因果', () => {
    const steps = [
      { status: 'ok', label: '决策加载' },
      { status: 'ok', label: '关联展开' },
      { status: 'ok', label: '因果链' },
    ];
    const f = { page: 'S14', hasDecision: true, hasEdges: true, hasTrace: true };
    expect(buildReasoningSteps(steps, f)).toEqual([
      { status: 'ok', label: '决策加载' },
      { status: 'ok', label: '关联展开' },
      { status: 'ok', label: '因果链' },
    ]);
  });

  it('S30 决策市场：覆盖/先例/偏差', () => {
    const steps = [
      { status: 'ok', label: '覆盖度加载' },
      { status: 'ok', label: '先例匹配' },
      { status: 'pending', label: '偏差分析' },
    ];
    const f = { page: 'S30', hasDecision: true, hasPrecedent: true, hasException: false };
    expect(buildReasoningSteps(steps, f)).toEqual([
      { status: 'ok', label: '覆盖度加载' },
      { status: 'ok', label: '先例匹配' },
      { status: 'idle', label: '偏差分析' },
    ]);
  });

  it('S35 客户洞察：聚合/裁剪/建议', () => {
    const steps = [
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ];
    const f = { page: 'S35', timelineNonEmpty: true, roleHasPerm: true, tasksNonEmpty: true };
    expect(buildReasoningSteps(steps, f)).toEqual([
      { status: 'ok', label: '聚合四源数据' },
      { status: 'ok', label: '权限裁剪' },
      { status: 'ok', label: '生成下一步建议' },
    ]);
    const f0 = { page: 'S35', timelineNonEmpty: false, roleHasPerm: false, tasksNonEmpty: false };
    expect(buildReasoningSteps(steps, f0)).toEqual([
      { status: 'idle', label: '聚合四源数据' },
      { status: 'idle', label: '权限裁剪' },
      { status: 'idle', label: '生成下一步建议' },
    ]);
  });

  it('未知 label → 保持原 status 不丢', () => {
    expect(buildReasoningSteps([{ status: 'ok', label: '自定义评估' }], { page: 'S02' }))
      .toEqual([{ status: 'ok', label: '自定义评估' }]);
  });

  it('steps 为空 → 空数组', () => {
    expect(buildReasoningSteps([], { page: 'S02' })).toEqual([]);
  });
});
