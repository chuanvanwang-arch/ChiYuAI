// test/signal/activityDerivation.test.js — 内部可观测客户异动派生（设计 §3.1 / 契约 T-D1）
// 为什么需要：主张「可以筛选新客户，比如新战略、高层变动、人员招聘」此前只有**一条权重配置**
//   （discoveryRules.js:35），全仓无任何适配器产出这些字段——典型「配置承诺 ≠ 实现」。
//   本文件锁四条可证伪语义：① 真命中；② **反例不命中**（正常实体不得被派生）；
//   ③ 置信语义显式（source=derived + confidence_basis）；④ 幂等（同 dedup_key 不新增）。
import { describe, it, expect } from 'vitest';
import { createActivityDerivation } from '../../src/signal/activityDerivation.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');   // 与下面各行 updated_at 的相对关系即用例语义
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const CONFIG = {
  version: 1,
  enabled: true,
  rules: [
    { id: 'contact-ledger-change', kind: 'contact_change', entity_type: 'CRM_CONTACT', window_days: 14,
      severity: 'low', target_role: 'sales', enabled: true, bucket: 'day' },
    { id: 'relation-cooling', kind: 'relation_cooling', entity_type: 'CRM_ACCOUNT', threshold_days: 30,
      severity: 'medium', target_role: 'sales', enabled: true, bucket: 'week' },
  ],
};

function makeCtx({ entities = [], config = CONFIG } = {}) {
  const created = [];
  const queries = [];
  return {
    created, queries,
    q: async (sql, params) => {
      queries.push({ sql, params });
      // 按 type 过滤注入实体（模拟 crm.particles WHERE type=$1）
      const type = params?.[0];
      const rows = entities.filter((e) => {
        const typeOk = Array.isArray(type) ? type.includes(e.type) : e.type === type;
        return typeOk && (params?.[1] == null || e.tenant_id === params[1]);
      });
      return { rows };
    },
    store: { create: async (o) => { created.push(o); return { ok: true, deduped: false }; } },
    readConfig: async () => ({ value: config }),
  };
}

const derive = (ctx) => createActivityDerivation({ query: ctx.q, signalStore: ctx.store, readConfig: ctx.readConfig });

describe('contact_ledger_change（弱代理：客户侧联系人台账变动）', () => {
  it('窗口内 CRM_CONTACT 更新 → 命中，且带 source=derived + confidence_basis', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(3), owner_id: 'alice' } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].source).toBe('derived');
    expect(ctx.created[0].kind).toBe('contact_change');
    expect(ctx.created[0].owner_id).toBe('alice');
    expect(ctx.created[0].payload.confidence_basis).toBe('internal_inference');
    expect(ctx.created[0].dedup_key).toContain('derived:contact-ledger-change:c1:');
  });

  it('窗口外的联系人更新 → 不命中（反例）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c2', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(40) } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
    expect(ctx.created).toHaveLength(0);
  });

  it('缺 updated_at → 不命中（不把"未知时间"当"刚更新"）', async () => {
    const ctx = makeCtx({ entities: [{ id: 'c3', type: 'CRM_CONTACT', tenant_id: 't1', payload: {} }] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });
});

describe('relation_cooling（关系冷却）', () => {
  it('停滞超过阈值 → 命中 medium', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'a1', type: 'CRM_ACCOUNT', tenant_id: 't1', payload: { updated_at: daysAgo(45), owner_id: 'alice' } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].kind).toBe('relation_cooling');
    expect(ctx.created[0].severity).toBe('medium');
  });

  it('近期有更新（未超阈值）→ 不命中（反例：正常实体不得被派生）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'a2', type: 'CRM_ACCOUNT', tenant_id: 't1', payload: { updated_at: daysAgo(5) } },
    ] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });
});

describe('fail-closed 与幂等', () => {
  it('配置读不到 → 零产出且给出归因（不静默、不造假）', async () => {
    const ctx = makeCtx();
    ctx.readConfig = async () => null;
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
    expect(r.missing[0].reason).toBe('config_missing');
  });

  it('enabled:false → 零产出', async () => {
    const ctx = makeCtx({ config: { ...CONFIG, enabled: false }, entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(1) } },
    ] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });

  it('同实体重复派生 → dedup_key 完全一致（幂等由 store.create 吸收）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(3) } },
    ] });
    const d = derive(ctx);
    await d.deriveOnce({ tenantId: 't1', now: NOW });
    await d.deriveOnce({ tenantId: 't1', now: NOW + 3600000 });
    expect(ctx.created[0].dedup_key).toBe(ctx.created[1].dedup_key);
  });

  it('纯函数 bucketKey（day/week/month）', async () => {
    const ctx = makeCtx();
    const d = derive(ctx);
    expect(d.bucketKey(NOW, 'day')).toBe('2026-09-16');
    expect(d.bucketKey(NOW, 'month')).toBe('2026-09');
    expect(d.bucketKey(NOW, 'week')).toMatch(/^2026-W\d{2}$/);
  });
});
