// test/agent-loop-context.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

const captured = [];
vi.mock('../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWrite: vi.fn(async (sql, params) => { captured.push({ sql, params }); return { rows: [{}] }; }),
}));
vi.mock('../src/context/assembler.js', () => ({
  assembleContext: vi.fn(async () => ({
    layers: { L1: [{ id: 'a' }], L2: [{ id: 'b' }] },
    missing: { L2: true },
    degraded: true,
  })),
}));
vi.mock('../src/skills/registry.js', () => ({
  getSkill: () => ({ slug: 'data-particle-read', steps: [] }),
  executeSkill: vi.fn(async () => ({ ok: true })),
}));

const { runWithSkill } = await import('../src/agent/agentLoop.js');

describe('agentLoop 埋点', () => {
  beforeEach(() => captured.length = 0);
  it('context-injected episode 含 knowledge_layers_read 与 contract_task_id', async () => {
    await runWithSkill(
      { id: 't1', skill_slug: 'data-particle-read', payload: {} },
      { ctx: { actor: 'deal-coach', contractTask: 'T-DEMO' } }
    );
    // 注意：agentLoop 依序插入 intent-parsed → context-injected → loop-started → loop-done 四个 episode，
    // 首条 INSERT 是 intent-parsed（无 knowledge_layers_read），须按 phase=context-injected 定位目标 episode
    const ctxEp = captured
      .filter((c) => String(c.sql).includes('INSERT INTO crm.monitor_event'))
      .map((c) => ({ ...c, facts: JSON.parse(c.params[2]) }))
      .find((c) => c.facts.intent === undefined && Array.isArray(c.facts.knowledge_layers_read));
    expect(ctxEp).toBeTruthy();
    const ctxFacts = ctxEp.facts;
    expect(ctxFacts.knowledge_layers_read).toEqual(['L1']); // L2 missing 被排除
    expect(ctxFacts.contract_task_id).toBe('T-DEMO');
  });
  it('loop-started episode 含 contract_task_id', async () => {
    await runWithSkill(
      { id: 't1', skill_slug: 'data-particle-read', payload: {} },
      { ctx: { actor: 'deal-coach', contractTask: 'T-DEMO' } }
    );
    const startEp = captured.filter((c) => String(c.sql).includes('INSERT INTO crm.monitor_event'))
      .map((c) => JSON.parse(c.params[2]))
      .find((f) => f.skill === 'data-particle-read');
    expect(startEp.contract_task_id).toBe('T-DEMO');
  });
});
