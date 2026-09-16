// test/sync/writebackDispatcher.test.js — P0-1：L3 回写派发器（唯一生产实现）
// 契约：白名单空 → fail-closed 不派发；白名单有值 → 只派发 row 中命中的字段；
//       默认不传 approvalPassed（守 HITL 第 3 闸）；仅 writeback_auto_approved===true 才放行。
import { describe, it, expect, vi } from 'vitest';
import { createWritebackDispatcher } from '../../src/sync/writeback.js';

const rc = (value) => async () => ({ value });
const trustWith = (wl, auto = false) => rc({ default_level: 'L3', writeback_fields_whitelist: wl, writeback_auto_approved: auto });

describe('createWritebackDispatcher（P0-1）', () => {
  it('白名单空 → ok:false 且不调用 dispatch（fail-closed）', async () => {
    const dispatch = vi.fn();
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith([]) });
    const r = await wb({ tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1', row: { name: 'X' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('writeback_whitelist_empty');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('无白名单命中字段 → ok:false（writeback_no_fields）且不派发', async () => {
    const dispatch = vi.fn();
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier']) });
    const r = await wb({ tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1', row: { name: 'X' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('writeback_no_fields');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('命中白名单 → 以 particleId 为 account_id 派发，默认不带 approvalPassed（守第 3 闸）', async () => {
    const dispatch = vi.fn(async () => ({ ok: false, error: 'approval_required' }));
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier', 'next_action']) });
    const r = await wb({
      tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1',
      row: { name: 'X', ai_tier: 'HIGH', next_action: '回访', secret: 'nope' }, decisionId: 'd-1',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [name, params, ctx] = dispatch.mock.calls[0];
    expect(name).toBe('sync-writeback-fields');
    expect(params.account_id).toBe('p1');
    expect(params.fields).toEqual({ ai_tier: 'HIGH', next_action: '回访' }); // 非白名单字段被剔除
    expect(ctx.decision_id).toBe('d-1');
    expect(ctx.approvalPassed).toBeUndefined(); // 默认不放行 → executor 第 3 闸拦截
    expect(r.ok).toBe(false);
    expect(r.error).toBe('approval_required');
  });

  it('writeback_auto_approved=true（人工开启）→ 传 approvalPassed 放行；成功映射 written', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, written: ['ai_tier'], denied: [] }));
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier'], true) });
    const r = await wb({ tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1', row: { ai_tier: 'HIGH' } });
    expect(dispatch.mock.calls[0][2].approvalPassed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(['ai_tier']);
  });

  it('cas_expect 透传（字段级 CAS 在地基）', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier']) });
    await wb({
      tenantId: 't1', particleId: 'p1', row: { ai_tier: 'HIGH', __cas_expect: { path: 'ai_tier', value: 'LOW' } },
    });
    expect(dispatch.mock.calls[0][1].cas_expect).toEqual({ path: 'ai_tier', value: 'LOW' });
  });

  it('缺 particleId / 缺 dispatch → fail-closed', async () => {
    const wb = createWritebackDispatcher({ dispatch: vi.fn(), readConfig: trustWith(['a']) });
    expect((await wb({ tenantId: 't1', particleId: null, row: { a: 1 } })).error).toBe('particle_id_missing');
    const wb2 = createWritebackDispatcher({ readConfig: trustWith(['a']) });
    expect((await wb2({ tenantId: 't1', particleId: 'p1', row: { a: 1 } })).error).toBe('dispatch_missing');
  });

  it('dispatch 抛错 → ok:false 带原因（不吞错）', async () => {
    const wb = createWritebackDispatcher({
      dispatch: async () => { throw new Error('boom'); },
      readConfig: trustWith(['ai_tier']),
    });
    const r = await wb({ tenantId: 't1', particleId: 'p1', row: { ai_tier: 'HIGH' } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('boom');
  });

  it('readConfig 抛错 → 视同无白名单（fail-closed，不放行）', async () => {
    const dispatch = vi.fn();
    const wb = createWritebackDispatcher({ dispatch, readConfig: async () => { throw new Error('db down'); } });
    const r = await wb({ tenantId: 't1', particleId: 'p1', row: { ai_tier: 'HIGH' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('writeback_whitelist_empty');
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Q3-1：白名单内外的**混合**字段 → 越界字段被剔除、命中字段照常派发（既有用例只覆盖了
  //   "全空白名单"与"零命中"两个极端，缺"部分命中"这一最常见的真实形状）。
  it('部分字段越界 → 仅命中白名单的字段派发（越界字段被剔除，不报错）', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, written: ['industry'] }));
    const call = createWritebackDispatcher({
      dispatch,
      readConfig: rc({ writeback_fields_whitelist: ['industry'] }),
    });
    const r = await call({
      tenantId: 't1', object: 'AccountObj', externalId: 'x1', particleId: 'p1',
      row: { industry: '化工', secret: 'should-not-leave', Source: 'spoofed' }, level: 'L3',
    });
    expect(r.ok).toBe(true);
    const sent = dispatch.mock.calls[0][1];
    expect(sent.fields).toEqual({ industry: '化工' });   // 越界字段与伪造 Source 均未出站
    expect(sent.fields.secret).toBeUndefined();
    expect(sent.fields.Source).toBeUndefined();
  });
});
