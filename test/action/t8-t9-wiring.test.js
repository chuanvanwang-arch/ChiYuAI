// test/action/t8-t9-wiring.test.js — T8 红线溯源守卫 + T9 followup 需求采集接线验证
// 设计依据：docs/superpowers/plans/2026-09-09-quote-policy-and-requirement-grading.md
//   T8：crm-review-gate-approve 终审须携带与审批商机一致的红线依据（来自 crm-decision-advise 的 approval_prefill）
//   T9：crm-followup-requirement-collect 经 method-followup-engine step4 采集 SHOULD/NICE 维度证据
//
// 本测试为 DB-free 确定性单测：通过 vi.mock 隔离所有落库/查库依赖，仅验证「接线形态 + 守卫逻辑」。
// dispatch 显式携带 ctx.decision_id + tenantId:'system'，跳过第0闸决策依赖与 autoDecision mint（executor.js:64 !decisionId 为假），
// 使流量直达 handler，从而纯测 handler 自身行为（T8 守卫、T9 采集映射）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 隔离落库/查库依赖 ——
vi.mock('../../src/particles/particleRepo.js', () => ({
  getParticle: vi.fn(async (id) => ({ id, type: 'CRM_DEAL', payload: { account_id: 'ACC-1' } })),
  updateParticle: vi.fn(async (id, body) => ({ ...body, id })),
  createParticle: vi.fn(),
  queryParticles: vi.fn(async () => ({ rows: [] })),
  createEdge: vi.fn(),
  queryNeighbors: vi.fn(),
}));
vi.mock('../../src/events/bus.js', () => ({ emit: vi.fn() }));
vi.mock('../../src/decision/autonomyEngine.js', () => ({
  requireDecision: vi.fn(async () => ({ decision: { decision_id: 'dec-test' }, mode: 'auto' })),
}));
vi.mock('../../src/decision/requirementConditions.js', () => ({
  collectFollowupRequirement: vi.fn(async (subject_id, dims) =>
    dims.map((d) => ({ subject_id, dim_key: d.dim_key, met: d.met ?? false, evidence_ref: d.evidence_ref }))
  ),
}));
vi.mock('../../src/config/configStore.js', () => ({
  // 按 key 分支：requirement-dimensions 返回维度配置；billing-plans/settings 返回含全部权益的档位
  // （system 租户经 resolveEntitlements 豁免第1.7闸，但需 entitlements 数组非空，否则误判缺权益拦截）。
  readConfig: vi.fn(async (key) => {
    if (key === 'requirement-dimensions') {
      return {
        value: {
          dimensions: [
            { dim_key: 'budget', level: 'MUST' },
            { dim_key: 'trial_schedule', level: 'SHOULD' },
            { dim_key: 'decision_chain', level: 'NICE' },
          ],
        },
      };
    }
    return {
      value: [{ plan_id: 'sys', entitlements: ['event_automation', 'approval_flow', 'core_crm', 'decision_autonomy'] }],
    };
  }),
}));

import { actionExecutor } from '../../src/action/executor.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { resetRegistry, getAction } from '../../src/action/registry.js';
import { collectFollowupRequirement } from '../../src/decision/requirementConditions.js';
import { readConfig } from '../../src/config/configStore.js';
import { updateParticle } from '../../src/particles/particleRepo.js';

// 确定性 ctx：显式 decision_id + system 租户（绕过第1.7闸权益校验），直达 handler
const CTX = { tenantId: 'system', actor: 'followup-agent', decision_id: 'dec-test' };

beforeEach(() => {
  resetRegistry();
  seedActions();
  collectFollowupRequirement.mockClear();
  readConfig.mockClear();
  updateParticle.mockClear();
});

describe('T8 红线溯源守卫（crm-review-gate-approve）', () => {
  it('Action 已注册且声明 redline_basis 入参（设计 §88/§155 红线决策可溯源）', () => {
    const a = getAction('crm-review-gate-approve');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');
    expect(a.schema).toHaveProperty('redline_basis');
  });

  it('携带与审批商机一致的 redline_basis → 终审通过', async () => {
    const res = await actionExecutor.dispatch(
      'crm-review-gate-approve',
      { deal_id: 'DEAL-1', findings: { note: '红线已核实' }, redline_basis: [{ deal_id: 'DEAL-1', cond: 'margin_redline' }] },
      CTX
    );
    expect(res.ok).toBe(true);
    expect(res.data?.review_gate_decision).toBe('approved');
  });

  it('红线依据 deal_id 与审批商机不一致 → 拒绝终审（防溯源错挂）', async () => {
    const res = await actionExecutor.dispatch(
      'crm-review-gate-approve',
      { deal_id: 'DEAL-1', redline_basis: [{ deal_id: 'DEAL-OTHER', cond: 'margin_redline' }] },
      CTX
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('红线依据与审批商机不一致');
  });

  it('显式携带空 redline_basis → 拒绝（红线决策的审批结论须可溯源）', async () => {
    const res = await actionExecutor.dispatch(
      'crm-review-gate-approve',
      { deal_id: 'DEAL-1', redline_basis: [] },
      CTX
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('红线依据');
  });

  it('未携带 redline_basis（非红线终审）→ 仍放行，不强制', async () => {
    const res = await actionExecutor.dispatch('crm-review-gate-approve', { deal_id: 'DEAL-1' }, CTX);
    expect(res.ok).toBe(true);
    expect(res.data?.review_gate_decision).toBe('approved');
  });
});

describe('T9 followup 需求采集接线（crm-followup-requirement-collect）', () => {
  it('Action 已注册、挂 REQUIREMENT_COLLECT 场景、并入 followup-agent 能力闭包', () => {
    const a = getAction('crm-followup-requirement-collect');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);
    expect(a.decisionScenario).toBe('REQUIREMENT_COLLECT');
    // 装配闭包：action 必须同时位于 agentSpec followup-agent 的 actions + skillCalls
    // （断言在 agentSpec.test.js 统一覆盖，此处仅确认注册形态）
  });

  it('显式 dims → 透传 evidence_ref=followup://<deal_id> 并采集', async () => {
    const res = await actionExecutor.dispatch(
      'crm-followup-requirement-collect',
      { deal_id: 'DEAL-9', dims: [{ dim_key: 'trial_schedule', met: false }] },
      CTX
    );
    expect(res.ok).toBe(true);
    expect(collectFollowupRequirement).toHaveBeenCalledTimes(1);
    const [subjectId, dimsPassed] = collectFollowupRequirement.mock.calls[0];
    expect(subjectId).toBe('DEAL-9');
    expect(dimsPassed[0].evidence_ref).toBe('followup://DEAL-9');
    expect(dimsPassed[0].dim_key).toBe('trial_schedule');
    expect(res.data?.collected).toBe(1);
  });

  it('dims 省略 → 从 requirement-dimensions 配置自动取 SHOULD/NICE 维度（仅非 MUST）', async () => {
    const res = await actionExecutor.dispatch('crm-followup-requirement-collect', { deal_id: 'DEAL-9' }, CTX);
    expect(res.ok).toBe(true);
    expect(readConfig).toHaveBeenCalledWith('requirement-dimensions', expect.objectContaining({ tenantId: 'system' }));
    const dimsPassed = collectFollowupRequirement.mock.calls[0][1];
    const keys = dimsPassed.map((d) => d.dim_key);
    expect(keys).toContain('trial_schedule'); // SHOULD
    expect(keys).toContain('decision_chain'); // NICE
    expect(keys).not.toContain('budget'); // MUST 不采
  });
});
