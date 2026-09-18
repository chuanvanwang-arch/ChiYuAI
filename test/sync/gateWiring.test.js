// test/sync/gateWiring.test.js — P3 评审闸接线（消除零消费点）守卫
// 设计：docs/2026-09-18-unified-integration-design-v2.md §0-1/§5/§11(P3)
// 核心判据：enable-writeback 评审闸**真实接入生产回写路径**（非零消费点），未批准 → 回写被拦（fail-closed）。
import { describe, it, expect, vi } from 'vitest';
import { runTenantSyncOnce, handleObjectChanged } from '../../src/sync/mount.js';
import { allowWritebackForLevel, createTrustManager } from '../../src/sync/trust.js';
import { createChannelReviewGate } from '../../src/channels/reviewGate.js';
import { createSyncGate } from '../../src/sync/gate.js';

// —— P3：trust 单一事实源（engine.js:18 / mount.js 内联 ==='L3' 收敛到此）——
describe('P3 trust 单一事实源', () => {
  it('allowWritebackForLevel：仅 L3 true，非法档一律 false', () => {
    expect(allowWritebackForLevel('L3')).toBe(true);
    expect(allowWritebackForLevel('L2')).toBe(false);
    expect(allowWritebackForLevel('L1')).toBe(false);
    expect(allowWritebackForLevel('X9')).toBe(false);
  });
  it('createTrustManager.allowWritebackForLevel 委托纯函数', async () => {
    const tm = createTrustManager({ readConfig: async () => null });
    expect(await tm.allowWritebackForLevel('L3')).toBe(true);
    expect(await tm.allowWritebackForLevel('L2')).toBe(false);
  });
});

// —— P3：reviewGate 四类动作映射到不同 business_type（纸面闸门根因修复）——
describe('P3 reviewGate 四类动作 → 不同 business_type', () => {
  it('first-connect 查 channel / 其余三类在未建各自实例时一律 null', async () => {
    const rg = createChannelReviewGate({
      queryParticles: async () => [{ id: 'i1', payload: { business_type: 'channel', business_id: 'c1', status: 'APPROVED' } }],
    });
    expect(await rg.hasApproval({ action: 'first-connect', tenantId: 't', ctx: { id: 'c1' } })).not.toBeNull();
    expect(await rg.hasApproval({ action: 'mapping-change', tenantId: 't', ctx: { id: 'c1' } })).toBeNull();
    expect(await rg.hasApproval({ action: 'trust-elevate', tenantId: 't', ctx: { id: 'c1' } })).toBeNull();
    expect(await rg.hasApproval({ action: 'enable-writeback', tenantId: 't', ctx: { id: 'c1' } })).toBeNull();
  });
  it('enable-writeback 查 writeback business_type 批准实例；未知动作 → null', async () => {
    const rg = createChannelReviewGate({
      queryParticles: async () => [{ id: 'i2', payload: { business_type: 'writeback', business_id: 'c1', status: 'APPROVED' } }],
    });
    expect(await rg.hasApproval({ action: 'enable-writeback', tenantId: 't', ctx: { id: 'c1' } })).not.toBeNull();
    expect(await rg.hasApproval({ action: 'bogus-action', tenantId: 't', ctx: { id: 'c1' } })).toBeNull();
  });
  it('无 business_id → 未批准（不定位到实例即不放行）', async () => {
    const rg = createChannelReviewGate({
      queryParticles: async () => [{ id: 'i3', payload: { business_type: 'writeback', business_id: 'c1', status: 'APPROVED' } }],
    });
    expect(await rg.hasApproval({ action: 'enable-writeback', tenantId: 't', ctx: {} })).toBeNull();
  });
});

// —— P3：gate 真实接入生产**外部(crm)回写**路径（消除零消费点）；internal 回写直通不受此外部闸约束 ——
const mockProvider = () => ({
  kind: 'mock',
  verifyAuth: async () => ({ ok: true }),
  readIncremental: async () => ({ ok: true, rows: [{ id: 'a1', name: 'A' }], cursor: null }),
});

const l3Target = (over = {}) => ({
  id: 'c1', kind: 'mock', provider: mockProvider(), objects: [{ name: 'O', direction: 'in' }], trustLevel: 'L3', ...over,
});

const baseDeps = (over = {}) => ({
  mappings: { O: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }], identity: { external_id_field: 'id' } } },
  createResolver: () => ({ upsert: async () => ({ created: true, particle_id: 'p1' }) }),
  createCursor: () => ({ get: async () => null, set: async () => {} }),
  mintDecision: async () => ({ decisionId: 'dec-1' }),
  emit: () => {}, recordFailure: () => {},
  ...over,
});

const deniedGate = () => createSyncGate({ reviewGate: { hasApproval: async () => null } }); // 永远未批准
const approvedGate = () => createSyncGate({ reviewGate: { hasApproval: async () => ({ approved: true }) } });

describe('P3 gate 接线到生产回写路径（零消费点消除证据）', () => {
  it('gate.check 在 L3 回写路径真被调用（非纸面/非零消费点）', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const gate = deniedGate();
    const spy = vi.spyOn(gate, 'check');
    await runTenantSyncOnce({ tenantId: 't', targets: [l3Target({ target: 'crm' })], deps: baseDeps({ callWriteback, syncGate: gate }) });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'enable-writeback', ctx: { id: 'c1' } }));
  });

  it('未批准 enable-writeback → 回写被拦（callWriteback 不被调用，writeback_blocked 计数）', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const out = await runTenantSyncOnce({ tenantId: 't', targets: [l3Target({ target: 'crm' })], deps: baseDeps({ callWriteback, syncGate: deniedGate() }) });
    expect(callWriteback).not.toHaveBeenCalled();
    expect(out.writeback).toBe(0);
    expect(out.writeback_blocked).toBe(1);
  });

  it('已批准 enable-writeback → 回写放行（callWriteback 被调用）', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const out = await runTenantSyncOnce({ tenantId: 't', targets: [l3Target({ target: 'crm' })], deps: baseDeps({ callWriteback, syncGate: approvedGate() }) });
    expect(callWriteback).toHaveBeenCalledTimes(1);
    expect(out.writeback).toBe(1);
    expect(out.writeback_blocked).toBe(0);
  });

  it('未注入 syncGate → 默认闸仍拦（fail-closed，零消费点消除：任何路径都过闸）', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const out = await runTenantSyncOnce({ tenantId: 't', targets: [l3Target({ target: 'crm' })], deps: baseDeps({ callWriteback }) });
    expect(callWriteback).not.toHaveBeenCalled();
    expect(out.writeback_blocked).toBe(1);
  });

  it('handleObjectChanged（外部 target=crm）未批准 → 回写被拦（gate_blocked 透传）', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const r = await handleObjectChanged({
      tenantId: 't', provider: 'c1', object: 'AccountObj', row: { id: 'a1', name: 'A' }, target: 'crm',
      deps: {
        mappings: { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'name' }] } },
        createResolver: () => ({ upsert: async () => ({ created: true, particle_id: 'p1' }) }),
        mintDecision: async () => ({ decisionId: 'dec-a5' }),
        readConfig: async () => ({ value: { default_level: 'L3' } }),
        callWriteback, syncGate: deniedGate(),
      },
    });
    expect(callWriteback).not.toHaveBeenCalled();
    expect(r.writeback_blocked).toBe(1);
  });

  it('internal 回写（无 target）直通：不受外部 enable-writeback 闸约束，callWriteback 被调用', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const out = await runTenantSyncOnce({ tenantId: 't', targets: [l3Target()], deps: baseDeps({ callWriteback, syncGate: deniedGate() }) });
    expect(callWriteback).toHaveBeenCalledTimes(1);
    expect(out.writeback).toBe(1);
    expect(out.writeback_blocked).toBe(0);
  });

  it('L1/L2 不触发回写路径（gate 不被调用，零回写开销）', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const gate = deniedGate();
    const spy = vi.spyOn(gate, 'check');
    await runTenantSyncOnce({ tenantId: 't', targets: [l3Target({ trustLevel: 'L1' })], deps: baseDeps({ callWriteback, syncGate: gate }) });
    expect(spy).not.toHaveBeenCalled();
    expect(callWriteback).not.toHaveBeenCalled();
  });
});
