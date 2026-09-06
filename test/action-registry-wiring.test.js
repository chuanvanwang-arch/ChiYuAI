// 2026-09-03 C 方案 T6：Action Registry 接线回归锁
// 断言：P1 业务 action 经 actionExecutor.dispatch 真实触达 handler（而非 unknown action 早返回）；
//       lifecycle 元数据正确标注（engine/reserved/active）。
import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../src/action/seed-actions.js';
import { actionExecutor } from '../src/action/executor.js';
import { listActions } from '../src/action/registry.js';

beforeAll(async () => { await seedActions(); });

const P1 = ['crm-deal-advance', 'crm-deal-reopen', 'crm-asset-attach', 'crm-review-gate-approve', 'crm-memory-upsert'];

describe('C 方案 P1 业务 action 接线', () => {
  it('P1 action 均在 registry 且 lifecycle=active', () => {
    for (const n of P1) {
      const a = listActions().find((x) => x.name === n);
      expect(a, `${n} 应已注册`).toBeTruthy();
      expect(a.lifecycle || 'active').toBe('active');
    }
  });

  it('P1 action 经 dispatch 触达 handler（非 unknown action 早返回）', async () => {
    for (const n of P1) {
      const r = await actionExecutor.dispatch(
        n,
        { id: '00000000-0000-0000-0000-000000000000', content: 'probe', type: 'note' },
        { actor: 't', role: 'admin', tenantId: 'system' },
      );
      expect(r.ok, `${n} 应触达 handler（返回 ok=false 帶业务/闸错误）`).toBe(false);
      expect(String(r.error || r.gate || '')).not.toMatch(/unknown action|未注册|no such action/i);
    }
  });
});

describe('C 方案 lifecycle 元数据标注', () => {
  it('引擎型 action 标 engine（审批流/校准/决策/agent）', () => {
    for (const n of ['crm-approval-start', 'crm_calibration_patch_approve', 'crm_decision_trace', 'agent-dispatch']) {
      const a = listActions().find((x) => x.name === n);
      expect(a?.lifecycle, `${n} 应标 engine`).toBe('engine');
    }
  });
  it('method 命名空间统一标 engine', () => {
    const methods = listActions().filter((a) => a.namespace === 'method');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m.lifecycle === 'engine')).toBe(true);
  });
  it('死表面业务 action 标 reserved（不物理删，遵守禁 DELETE 铁律）', () => {
    const r = listActions().find((a) => a.name === 'crm-customer-360');
    expect(r.lifecycle).toBe('reserved');
    // 降级标注不破坏敏感读通道语义：kind 仍 read_sensitive
    expect(r.kind).toBe('read_sensitive');
  });
  it('registry 无非法 lifecycle 值', () => {
    const valid = new Set(['engine', 'reserved', 'active', undefined]);
    const bad = listActions().filter((a) => !valid.has(a.lifecycle));
    expect(bad, '非法 lifecycle: ' + bad.map((b) => b.name).join(',')).toHaveLength(0);
  });
});
