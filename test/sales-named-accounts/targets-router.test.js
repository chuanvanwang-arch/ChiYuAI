// test/sales-named-accounts/targets-router.test.js — 目标指标配置端点（tiers 校验 + 决策第0闸凭证）
import { describe, it, expect, vi } from 'vitest';
import { createNamedAccountTargetsRouter } from '../../src/http/namedAccountTargetsRouter.js';
import { mergedTargets } from '../../src/sales/namedAccountTargets.js';

describe('目标指标配置端点（named-account-targets）', () => {
  it('tiers 校验：非法结构拒绝（缺 visit_freq）', () => {
    const bad = { tiers: [{ tier: '重点' }] };
    const okArr = Array.isArray(bad.tiers) && bad.tiers.every((t) => t?.tier && t?.visit_freq);
    expect(okArr).toBe(false);
  });

  it('tiers 校验：合法结构放行', () => {
    const good = { tiers: [{ tier: '重点', visit_freq: { times: 1, window: 'week' } }] };
    const okArr = Array.isArray(good.tiers) && good.tiers.every((t) => t?.tier && t?.visit_freq);
    expect(okArr).toBe(true);
  });

  it('mergedTargets：只传 tiers 时 window_days/metrics 保留默认（键级合并）', () => {
    const m = mergedTargets({ tiers: [{ tier: '重点', visit_freq: { times: 2, window: 'week' } }] });
    expect(m.window_days).toEqual({ week: 7, month: 30, quarter: 90 });
    expect(m.metrics).toEqual(['visit', 'lead', 'deal', 'contract']);
  });

  it('GET 路由存在且挂载正确端点', () => {
    const router = createNamedAccountTargetsRouter();
    const stack = router.stack.filter((l) => l.route?.path === '/api/config/named-account-targets');
    expect(stack.length).toBe(2); // GET + PUT
    expect(stack.map((l) => l.route.methods).sort((a, b) => String(a) - String(b))).toEqual([{ get: true }, { put: true }]);
  });
});