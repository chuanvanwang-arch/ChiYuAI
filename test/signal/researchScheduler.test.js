// test/signal/researchScheduler.test.js — T17 L3 主动研究（agent-research-schedule 驱动）
import { describe, it, expect } from 'vitest';
import { createResearchScheduler } from '../../src/signal/researchScheduler.js';

describe('T17 L3 主动研究', () => {
  it('每轮对象数不超过 max_objects_per_run；建议卡 reasoning+evidence_refs 非空；零粒子写入（query 仅只读）', async () => {
    const objects = Array.from({ length: 10 }, (_, i) => ({ id: 'acc' + i, tenant_id: 't1', payload: {} }));
    // 只读护栏：若扫描器对任何非 SELECT 语句发起查询（即试图写粒子），立即失败
    const q = async (sql) => {
      if (!/^\s*SELECT/i.test(sql)) throw new Error(`researchScheduler 不应发起写查询: ${sql}`);
      return { rows: objects };
    };
    const signals = [];
    const signalStore = { create(o) { signals.push(o); return Promise.resolve({ ok: true }); } };
    const runSkill = async ({ object }) => ({ reasoning: `分析 ${object.id}`, evidence_refs: ['e1', 'e2'] });
    const readConfig = async () => ({ value: { enabled: true, max_objects_per_run: 3, daily_llm_budget: 100, select_rule: { type: 'CRM_ACCOUNT' } } });
    const sc = createResearchScheduler({ query: q, signalStore, runSkill, readConfig });
    const r = await sc.runOnce({ tenantId: 't1' });
    expect(r.researched).toBe(3);                       // 限额生效
    expect(r.cards).toBe(3);
    expect(signals.every((c) => c.source === 'agent-research' && c.suggestion.reasoning && c.suggestion.evidence_refs.length)).toBe(true);
    // T21 个人隔离：对象无 owner → 建议卡落无主（按 target_role 广播），不得臆造责任人
    expect(signals.every((c) => c.owner_id === null)).toBe(true);
  });

  // T21：对象有 owner → 建议卡归属该责任人（只有他能看到）
  it('owner_id 透传：对象 payload.owner_id 落到建议卡', async () => {
    const objects = [{ id: 'acc-own', tenant_id: 't1', payload: { owner_id: 'alice' } }];
    const q = async () => ({ rows: objects });
    const signals = [];
    const signalStore = { create(o) { signals.push(o); return Promise.resolve({ ok: true }); } };
    const readConfig = async () => ({ value: { enabled: true, max_objects_per_run: 5, daily_llm_budget: 50, select_rule: { type: 'CRM_ACCOUNT' } } });
    const sc = createResearchScheduler({ query: q, signalStore, readConfig });
    await sc.runOnce({ tenantId: 't1' });
    expect(signals[0].owner_id).toBe('alice');
  });
  it('超预算降级不抛错（daily_llm_budget 耗尽后停止）', async () => {
    const objects = Array.from({ length: 5 }, (_, i) => ({ id: 'acc' + i, tenant_id: 't1', payload: {} }));
    const q = async () => ({ rows: objects });
    const signals = [];
    const signalStore = { create(o) { signals.push(o); return Promise.resolve({ ok: true }); } };
    let calls = 0;
    const runSkill = async () => { calls += 1; return { reasoning: 'r', evidence_refs: ['e'] }; };
    const readConfig = async () => ({ value: { enabled: true, max_objects_per_run: 10, daily_llm_budget: 2, select_rule: { type: 'CRM_ACCOUNT' } } });
    const sc = createResearchScheduler({ query: q, signalStore, runSkill, readConfig });
    const r = await sc.runOnce({ tenantId: 't1' });
    expect(calls).toBeLessThanOrEqual(2);               // 预算红线
    expect(r.error).toBeUndefined();                   // 不抛错
  });
  it('缺证据 → 降级说明而非编造', async () => {
    const objects = [{ id: 'acc0', tenant_id: 't1', payload: {} }];
    const q = async () => ({ rows: objects });
    const signals = [];
    const signalStore = { create(o) { signals.push(o); return Promise.resolve({ ok: true }); } };
    const runSkill = async () => ({ reasoning: null, evidence_refs: [] }); // 无证据
    const readConfig = async () => ({ value: { enabled: true, max_objects_per_run: 1, daily_llm_budget: 5, select_rule: { type: 'CRM_ACCOUNT' } } });
    const sc = createResearchScheduler({ query: q, signalStore, runSkill, readConfig });
    await sc.runOnce({ tenantId: 't1' });
    expect(signals[0].suggestion.reasoning).toMatch(/证据不足|降级/);
  });
});
