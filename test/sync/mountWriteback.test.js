// test/sync/mountWriteback.test.js — P0-1：handleObjectChanged 必须支持 callWriteback（L3 事件回写）
// 背景：engine.js:38 有回写分支，但 handleObjectChanged 形参不含 callWriteback 且生产两处装配均未传
//       → counts.writeback 恒 0 → L3 永远不可达。
import { describe, it, expect, vi } from 'vitest';
import { handleObjectChanged } from '../../src/sync/mount.js';
import { createSyncGate } from '../../src/sync/gate.js';

// P3：handleObjectChanged 的 L3 回写须先过 enable-writeback 评审闸。本测试套件聚焦 callWriteback 接线
// 行为（非 gate 判定），故默认注入「已批准」闸，使回写放行；gate 拦/放行由 gateWiring.test.js 专测。
const approvedGate = createSyncGate({ reviewGate: { hasApproval: async () => ({ approved: true }) } });

const mappings = {
  account: {
    particle_type: 'CRM_ACCOUNT',
    identity: { external_id_field: 'id' },
    fields: [{ ext: 'id', particle: 'external_id' }, { ext: 'name', particle: 'name' }],
  },
};
const rc = (v) => async () => ({ value: v });

function mkDeps(extra = {}) {
  return {
    mappings,
    readConfig: rc({ default_level: 'L3' }),
    pool: {},
    createResolver: () => ({ upsert: async () => ({ created: true, particle_id: 'p1' }) }),
    mintDecision: async () => ({ decisionId: 'd-1' }),
    emit: vi.fn(),
    syncGate: approvedGate, // P3：默认已批准，使 L3 回写可放行（测试聚焦 callWriteback 接线）
    ...extra,
  };
}

describe('handleObjectChanged · L3 回写接线（P0-1）', () => {
  it('L3 + 注入 callWriteback → 调用之并把结果计入返回', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true, written: ['ai_tier'] }));
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account',
      row: { id: 'E1', name: '客户A' }, deps: mkDeps({ callWriteback }),
    });
    expect(r.ok).toBe(true);
    expect(callWriteback).toHaveBeenCalledTimes(1);
    const arg = callWriteback.mock.calls[0][0];
    expect(arg.particleId).toBe('p1');
    expect(arg.externalId).toBe('E1');
    expect(arg.decisionId).toBe('d-1');
    expect(r.writeback).toBe(1);
    expect(r.writeback_error).toBeNull();
  });

  it('L3 但 callWriteback 拒绝 → writeback=0 且 writeback_error 留痕（不静默）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' },
      deps: mkDeps({ callWriteback: async () => ({ ok: false, error: 'approval_required' }) }),
    });
    expect(r.ok).toBe(true);
    expect(r.writeback).toBe(0);
    expect(r.writeback_error).toBe('approval_required');
  });

  it('L2（非 L3）不触发回写（信任分级不越权）', async () => {
    const callWriteback = vi.fn();
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' },
      deps: mkDeps({ callWriteback, readConfig: rc({ default_level: 'L2' }) }),
    });
    expect(callWriteback).not.toHaveBeenCalled();
    expect(r.writeback).toBeUndefined();
  });

  it('L3 未注入 callWriteback → 不越权、不崩（零回归）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' }, deps: mkDeps(),
    });
    expect(r.ok).toBe(true);
    expect(r.writeback).toBeUndefined();
  });

  it('callWriteback 抛错 → 捕获为 writeback_error（不阻断读入链路）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' },
      deps: mkDeps({ callWriteback: async () => { throw new Error('wb down'); } }),
    });
    expect(r.ok).toBe(true);
    expect(r.writeback).toBe(0);
    expect(String(r.writeback_error)).toContain('wb down');
  });
});
