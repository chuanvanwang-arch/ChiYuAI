// test/action/prospectingConfirm.test.js — confirm 批量入池 + 溯源弱边（T6）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §5 + 实施计划 T6
// ① 查重不重复入池（existing:true 跳过）；② 新企业入池 S0 + decision_id；
// ③ 事件 batch-pooled 携带 decision_id
import { describe, it, expect, beforeEach } from 'vitest';
import { getAction, resetRegistry } from '../../src/action/registry.js';
import { seedProspectingActions } from '../../src/action/prospectingActions.js';
import { createProspectingSession, updateSession } from '../../src/action/prospectingSession.js';

beforeEach(() => { resetRegistry(); seedProspectingActions(); });

describe('prospecting-confirm 批量入池 + 溯源（T6）', () => {
  it('① 查重不重复入池（existing:true 跳过）', async () => {
    // 注入 findAccount 替身：name 命中 → existing
    const conf = getAction('prospecting-confirm');
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c1', name: '已有企业', domain: 'old.com' }] });
    const out = await conf.handler({ session_id: sid, confirmed_ids: ['c1'] },
      { tenantId: 'acme', actor: 'alice', decision_id: 'dec-1' },
      { findAccount: async () => ({ id: 'win-1' }) });
    expect(out.results[0].existing).toBe(true);
    expect(out.results[0].deal_id).toBeNull();
    expect(out.results[0].decision_id).toBe('dec-1');
  });
  it('② 新企业入池：createParticle S0 + sourcedFrom 弱边 + decision_id', async () => {
    // 注入 createParticle/createEdge/findAccount 替身 → 零 DB
    const conf = getAction('prospecting-confirm');
    const created = [];
    const edges = [];
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c2', name: '新企业', domain: 'new.com', fit_score: 0.8, revenue: 5e8, industry: 'healthcare' }] });
    const out = await conf.handler({ session_id: sid, confirmed_ids: ['c2'] },
      { tenantId: 'acme', actor: 'alice', decision_id: 'dec-2' },
      {
        findAccount: async () => null,
        createParticle: async (type, payload, opts) => {
          created.push({ type, payload, opts });
          return { id: 'deal-2', ...payload };
        },
        createEdge: async (...args) => { edges.push(args); return {}; },
      });
    expect(out.results[0].existing).toBe(false);
    expect(out.results[0].deal_id).toBe('deal-2');
    expect(out.results[0].decision_id).toBe('dec-2');
    expect(created[0].type).toBe('CRM_DEAL');
    expect(created[0].payload.stage).toBe('S0');
    expect(created[0].payload.pool_type).toBe('new');
    expect(created[0].payload.source).toBe('prospecting');
    // sourcedFrom 弱边：CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE（修订 1 主语统一）
    expect(edges.length).toBe(1);
    expect(edges[0][0]).toBe('CRM_DEAL');
    expect(edges[0][2]).toBe('sourcedFrom');
    expect(edges[0][3]).toBe('CRM_KNOWLEDGE');
    expect(edges[0][5].provenance).toBe('prospecting-search');
    expect(edges[0][5].decision_id).toBe('dec-2');
  });
  it('③ emit batch-pooled 事件携带 decision_id', async () => {
    const emits = [];
    const conf = getAction('prospecting-confirm');
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c3', name: '事件企业', domain: 'ev.com' }] });
    await conf.handler({ session_id: sid, confirmed_ids: ['c3'] },
      { tenantId: 'acme', actor: 'alice', decision_id: 'dec-3' },
      {
        findAccount: async () => null,
        createParticle: async () => ({ id: 'deal-3' }),
        createEdge: async () => ({}),
        emit: async (...args) => { emits.push(args); },
      });
    expect(emits.length).toBe(1);
    expect(emits[0][0]).toBe('prospecting');
    expect(emits[0][1]).toBe('batch-pooled');
    expect(emits[0][2].decision_id).toBe('dec-3');
    expect(emits[0][2].total).toBe(1);
  });
});
