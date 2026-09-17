import { describe, it, expect, vi } from 'vitest';
import { createMonitorCtx } from '../../../src/connectors/discovery/monitorCtx.js';

const RULES = { signals: { funding_round: { weight: 0.9 } }, icp: { industries: ['chemical'] } };

describe('createMonitorCtx（ctx 四件套装配）', () => {
  it('① 四件套齐备且可调用（生产装配判据的结构面）', () => {
    const ctx = createMonitorCtx({ tenantId: 'system', deps: {} });
    for (const k of ['getAccount', 'rescore', 'appendMemory', 'updateParticle']) {
      expect(typeof ctx[k], k).toBe('function');
    }
  });

  it('② getAccount 走注入的 getParticle（单参，与真实签名一致；不新建粒子）', async () => {
    const getParticle = vi.fn(async (id) => ({ id, payload: {} }));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { getParticle } });
    const a = await ctx.getAccount('acc1');
    expect(getParticle).toHaveBeenCalledWith('acc1');
    expect(a.id).toBe('acc1');
  });

  it('③ rescore 返回 {score, ruleRef} 且与 scoreLeadFit 同源', async () => {
    const getParticle = vi.fn(async () => ({ id: 'acc1', payload: { enrichment: { industry: { value: 'chemical' } } } }));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { getParticle, loadRules: async () => RULES } });
    const r = await ctx.rescore('acc1', { signals: [{ type: 'funding_round', ts: new Date().toISOString() }] });
    expect(r.score).toBeGreaterThan(0);
    expect(r.ruleRef).toBe('scenario:lead-fit#ruler:hiring_icp_role');
  });

  // ⚠ 第 0 闸：写操作 fail-closed
  it('④ 无 decisionId → updateParticle 拒绝写入（decision_required）', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { updateParticle, decisionId: null } });
    await expect(ctx.updateParticle('acc1', { patch: {} })).rejects.toThrow(/decision_required/);
    expect(updateParticle).not.toHaveBeenCalled();
  });

  it('⑤ 有 decisionId → 透传 requireDecisionId（写路径可溯源）', async () => {
    const updateParticle = vi.fn(async () => ({}));
    const ctx = createMonitorCtx({ tenantId: 'system', decisionId: 'd-42', deps: { updateParticle } });
    await ctx.updateParticle('acc1', { patch: { discovery: {} } });
    expect(updateParticle).toHaveBeenCalledWith('acc1', expect.objectContaining({
      tenantId: 'system', requireDecisionId: 'd-42',
    }));
  });

  it('⑥ appendMemory 走 memoryLog 对象式单参（append-only，无 delete 面）', async () => {
    const appendMemory = vi.fn(async () => ({ ok: true }));
    const ctx = createMonitorCtx({ tenantId: 'system', deps: { appendMemory } });
    await ctx.appendMemory('CRM_ACCOUNT', 'acc1', { kind: 'rescore' });
    expect(appendMemory).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'CRM_ACCOUNT', entityId: 'acc1', tenantId: 'system', kind: 'rescore',
    }));
    expect(ctx.deleteMemory).toBeUndefined();
  });
});
