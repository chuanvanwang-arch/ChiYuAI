import { describe, it, expect, vi, beforeAll } from 'vitest';
import { actionExecutor } from '../../src/action/executor.js';
import { registerAction } from '../../src/action/registry.js';
import * as autonomy from '../../src/decision/autonomyEngine.js';

// T1 单元：拦截 requireDecision（不真建 decision 行），验证 executor 统一 mint 触发条件
vi.mock('../../src/decision/autonomyEngine.js', () => ({
  requireDecision: vi.fn(async (sid) => ({ decision: { decision_id: 'test-dec-' + sid }, mode: 'auto' })),
}));

const TMP_MINT = 'tmp-mint-action-xyz';
const TMP_NOSCEN = 'tmp-noscen-action-xyz';
const TMP_BADSCEN = 'tmp-badscen-action-xyz';

beforeAll(() => {
  const base = { kind: 'write', permission: 'auth', namespace: 'crm', agentTool: false, confirm: 'normal', version: '1.0.0', owner: 'test', handler: async () => ({ ok: true }) };
  registerAction({ ...base, name: TMP_MINT, autoDecision: true, decisionScenario: 'OPP_QUALIFY' });
  registerAction({ ...base, name: TMP_NOSCEN, autoDecision: true });
  registerAction({ ...base, name: TMP_BADSCEN, autoDecision: true, decisionScenario: 'NON_EXIST_SCEN' });
});

describe('executor 统一 mint decision (T1)', () => {
  it('声明 decisionScenario 且已注册 → executor 自动 mint 并注入 ctx', async () => {
    autonomy.requireDecision.mockClear();
    const res = await actionExecutor.dispatch(TMP_MINT, { deal_id: 'd1' }, { tenantId: 'system', actor: 'test' });
    expect(res.ok).toBe(true);
    expect(autonomy.requireDecision).toHaveBeenCalledTimes(1);
    expect(autonomy.requireDecision.mock.calls[0][0]).toBe('OPP_QUALIFY');
  });

  it('未声明 decisionScenario → 不 mint（防双 mint，已合规 action 走 handler 内 mint）', async () => {
    autonomy.requireDecision.mockClear();
    await actionExecutor.dispatch(TMP_NOSCEN, { deal_id: 'd2' }, { tenantId: 'system', actor: 'test' });
    expect(autonomy.requireDecision).not.toHaveBeenCalled();
  });

  it('已声明但 scenario 未注册 → 不抛、不 mint（保持原行为，假绿风险 trace 可见）', async () => {
    autonomy.requireDecision.mockClear();
    const res = await actionExecutor.dispatch(TMP_BADSCEN, { deal_id: 'd3' }, { tenantId: 'system', actor: 'test' });
    expect(res.ok).toBe(true);
    expect(autonomy.requireDecision).not.toHaveBeenCalled();
  });
});
